-- FASE 1 do roadmap de atendimento:
-- respostas rápidas (/atalho) + notas internas nas conversas.

-- ============ RESPOSTAS RÁPIDAS ============
CREATE TABLE IF NOT EXISTS public.quick_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shortcut TEXT NOT NULL UNIQUE,      -- ex: "frete" (usado como /frete)
  content TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quick_replies TO authenticated;
GRANT ALL ON public.quick_replies TO service_role;
ALTER TABLE public.quick_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view quick replies" ON public.quick_replies
  FOR SELECT TO authenticated
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Agents manage quick replies" ON public.quick_replies
  FOR ALL TO authenticated
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TRIGGER update_quick_replies_updated_at
  BEFORE UPDATE ON public.quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ NOTAS INTERNAS ============
-- Mensagem visível só pela equipe (nunca enviada ao WhatsApp).
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.messages.is_internal IS 'Nota interna da equipe — não enviada ao cliente';
