-- Campanhas de disparo em lista (outbound). Envia uma mensagem para uma lista
-- de telefones, com ritmo controlado: N por dia, 1 a cada X minutos, dentro de
-- uma janela de horário. O envio é feito pelo cron de minuto já existente
-- (dispatch-scheduled-messages), que respeita o ritmo e para no limite diário.
--
-- ⚠️ Use um CHIP SEPARADO (não o número principal de atendimento) — disparo
-- em massa aumenta o risco de ban do WhatsApp (UazAPI é não-oficial).

CREATE TABLE IF NOT EXISTS public.campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  channel_id UUID NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
  message_template TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',          -- draft | running | paused | done | canceled
  daily_cap INT NOT NULL DEFAULT 50 CHECK (daily_cap BETWEEN 1 AND 1000),
  interval_minutes INT NOT NULL DEFAULT 5 CHECK (interval_minutes BETWEEN 1 AND 240),
  window_start INT NOT NULL DEFAULT 8 CHECK (window_start BETWEEN 0 AND 23),   -- hora BRT
  window_end INT NOT NULL DEFAULT 20 CHECK (window_end BETWEEN 1 AND 24),      -- hora BRT (exclusiva)
  total INT NOT NULL DEFAULT 0,
  sent_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  consecutive_failures INT NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  position INT NOT NULL,
  phone TEXT NOT NULL,                 -- só dígitos, com DDI 55
  name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | sending | sent | failed
  sent_at TIMESTAMPTZ,
  error TEXT,
  conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_campaign_recipients_next
  ON public.campaign_recipients(campaign_id, status, position);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_sent
  ON public.campaign_recipients(campaign_id, sent_at) WHERE status = 'sent';
CREATE INDEX IF NOT EXISTS idx_campaigns_running
  ON public.campaigns(status) WHERE status = 'running';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campaign_recipients TO authenticated;
GRANT ALL ON public.campaigns TO service_role;
GRANT ALL ON public.campaign_recipients TO service_role;

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_recipients ENABLE ROW LEVEL SECURITY;

-- Agentes e admins gerenciam campanhas.
CREATE POLICY "Agents manage campaigns" ON public.campaigns
  FOR ALL TO authenticated
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Agents manage campaign recipients" ON public.campaign_recipients
  FOR ALL TO authenticated
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

CREATE TRIGGER update_campaigns_updated_at
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
