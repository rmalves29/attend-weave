-- Tags pré-definidas com automação:
-- cada tag pode mudar o status da conversa ao ser aplicada e, opcionalmente,
-- agendar uma mensagem automática pro cliente após N horas (follow-up).

CREATE TABLE IF NOT EXISTS public.tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  sets_status public.conversation_status,        -- NULL = não muda status
  auto_message_enabled BOOLEAN NOT NULL DEFAULT false,
  auto_message_hours INTEGER NOT NULL DEFAULT 24 CHECK (auto_message_hours BETWEEN 1 AND 720),
  auto_message_content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tags TO authenticated;
GRANT ALL ON public.tags TO service_role;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view tags" ON public.tags
  FOR SELECT TO authenticated
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Agents manage tags" ON public.tags
  FOR ALL TO authenticated
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TRIGGER update_tags_updated_at
  BEFORE UPDATE ON public.tags
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Follow-ups agendados pelas tags (ex: "aguardando" manda mensagem em 24h)
CREATE TABLE IF NOT EXISTS public.tag_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | sending | sent | cancelled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.tag_followups TO authenticated;
GRANT ALL ON public.tag_followups TO service_role;
ALTER TABLE public.tag_followups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view followups" ON public.tag_followups
  FOR SELECT TO authenticated
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

CREATE INDEX IF NOT EXISTS tag_followups_due
  ON public.tag_followups (send_at) WHERE status = 'pending';

-- Tags iniciais do fluxo pedido
INSERT INTO public.tags (name, sets_status, auto_message_enabled, auto_message_hours, auto_message_content)
VALUES
  ('finalizado', 'resolved', false, 24, NULL),
  ('aguardando', 'pending', true, 24,
   'Oi! Passando para saber se você ainda precisa de ajuda. Se já resolveu, pode ignorar esta mensagem. Qualquer coisa é só chamar! 😊')
ON CONFLICT (name) DO NOTHING;
