
-- bot_settings (singleton)
CREATE TABLE public.bot_settings (
  id int PRIMARY KEY DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  welcome_text text NOT NULL DEFAULT 'Olá! 👋 Como podemos ajudar? Responda com o número da opção desejada:',
  finalize_after_days int NOT NULL DEFAULT 5,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_settings_singleton CHECK (id = 1)
);
GRANT SELECT ON public.bot_settings TO authenticated;
GRANT ALL ON public.bot_settings TO service_role;
ALTER TABLE public.bot_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bot_settings read auth" ON public.bot_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "bot_settings write admin" ON public.bot_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
INSERT INTO public.bot_settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- bot_menu_options
CREATE TABLE public.bot_menu_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  position int NOT NULL DEFAULT 0,
  keyword text NOT NULL,
  label text NOT NULL,
  action_type text NOT NULL DEFAULT 'text' CHECK (action_type IN ('text','handoff','none')),
  response_text text,
  assign_agent_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.bot_menu_options TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.bot_menu_options TO authenticated;
GRANT ALL ON public.bot_menu_options TO service_role;
ALTER TABLE public.bot_menu_options ENABLE ROW LEVEL SECURITY;
CREATE POLICY "menu read auth" ON public.bot_menu_options FOR SELECT TO authenticated USING (true);
CREATE POLICY "menu write admin" ON public.bot_menu_options FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER tr_bot_menu_options_updated BEFORE UPDATE ON public.bot_menu_options
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Flag no conversations
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS bot_active boolean NOT NULL DEFAULT false;

-- pg_cron: finaliza conversas abertas há muito tempo
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
DECLARE existing int;
BEGIN
  SELECT count(*) INTO existing FROM cron.job WHERE jobname = 'finalize-stale-conversations';
  IF existing > 0 THEN
    PERFORM cron.unschedule('finalize-stale-conversations');
  END IF;
END $$;

SELECT cron.schedule(
  'finalize-stale-conversations',
  '17 * * * *',
  $$
  UPDATE public.conversations c
     SET status = 'resolved',
         bot_active = false,
         resolved_at = now(),
         unread_count = 0
   WHERE c.status IN ('open','pending')
     AND c.last_message_at < now() - make_interval(days => (SELECT finalize_after_days FROM public.bot_settings WHERE id = 1))
  $$
);
