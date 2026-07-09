-- FASE 2 do roadmap de atendimento: mensagens agendadas / follow-up.
-- Atendente escreve e agenda envio de texto para uma data/hora futura.
-- Um dispatcher (rota pública autenticada por CRON_SECRET, chamada pelo
-- pg_cron via pg_net a cada minuto) processa os itens vencidos.

CREATE TYPE public.scheduled_message_status AS ENUM ('pending', 'sent', 'failed', 'canceled');

CREATE TABLE public.scheduled_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  send_at TIMESTAMPTZ NOT NULL,
  status public.scheduled_message_status NOT NULL DEFAULT 'pending',
  error TEXT,
  sent_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.scheduled_messages TO authenticated;
GRANT ALL ON public.scheduled_messages TO service_role;
ALTER TABLE public.scheduled_messages ENABLE ROW LEVEL SECURITY;

-- Mesma regra de acesso de conversations/messages: admin vê tudo; agente vê
-- conversas atribuídas a ele ou ainda sem dono.
CREATE POLICY "View scheduled messages of accessible conversations" ON public.scheduled_messages
  FOR SELECT TO authenticated
  USING (
    app_private.has_role(auth.uid(), 'admin'::public.app_role) OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = scheduled_messages.conversation_id
        AND (c.assigned_agent_id = auth.uid() OR (c.assigned_agent_id IS NULL AND app_private.has_role(auth.uid(), 'agent'::public.app_role)))
    )
  );

CREATE POLICY "Insert scheduled messages on accessible conversations" ON public.scheduled_messages
  FOR INSERT TO authenticated
  WITH CHECK (
    app_private.has_role(auth.uid(), 'admin'::public.app_role) OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = scheduled_messages.conversation_id
        AND (c.assigned_agent_id = auth.uid() OR (c.assigned_agent_id IS NULL AND app_private.has_role(auth.uid(), 'agent'::public.app_role)))
    )
  );

-- Update/delete só quem criou (cancelar) ou admin — evita um agente mexer
-- no agendamento de outro.
CREATE POLICY "Update own scheduled messages" ON public.scheduled_messages
  FOR UPDATE TO authenticated
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role) OR created_by = auth.uid())
  WITH CHECK (app_private.has_role(auth.uid(), 'admin'::public.app_role) OR created_by = auth.uid());

CREATE POLICY "Delete own scheduled messages" ON public.scheduled_messages
  FOR DELETE TO authenticated
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role) OR created_by = auth.uid());

CREATE TRIGGER update_scheduled_messages_updated_at
  BEFORE UPDATE ON public.scheduled_messages
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Índice pro dispatcher: busca por vencidos ainda pendentes.
CREATE INDEX idx_scheduled_messages_due
  ON public.scheduled_messages(send_at)
  WHERE status = 'pending';

CREATE INDEX idx_scheduled_messages_conversation
  ON public.scheduled_messages(conversation_id, send_at);

ALTER TABLE public.scheduled_messages REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.scheduled_messages;

-- ============ PG_CRON: dispara o dispatcher a cada minuto ============
-- Requer extensões pg_cron e pg_net habilitadas no projeto (Database > Extensions).
-- A URL aponta pro deploy público do app; ajuste se PUBLIC_APP_URL for diferente.
-- O secret enviado no header deve bater com a env var CRON_SECRET da aplicação.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

DO $$
BEGIN
  PERFORM cron.unschedule('dispatch-scheduled-messages');
EXCEPTION WHEN OTHERS THEN
  NULL; -- job ainda não existia
END $$;

SELECT cron.schedule(
  'dispatch-scheduled-messages',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://attend-weave.lovable.app/api/public/dispatch-scheduled-messages',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', current_setting('app.settings.cron_secret', true)
    ),
    body := '{}'::jsonb
  );
  $$
);

COMMENT ON TABLE public.scheduled_messages IS
  'Mensagens de texto agendadas para envio futuro (Fase 2 do roadmap). Ver docs/ROADMAP.md.';
