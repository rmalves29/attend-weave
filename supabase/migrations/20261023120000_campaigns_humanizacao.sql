-- Regras de humanização/anti-bloqueio do disparo em massa (campanhas).
-- Aplicadas SÓ às campanhas — o atendimento normal não é afetado.
--   next_send_at    : horário do próximo envio permitido (cria o intervalo
--                     ALEATÓRIO entre mensagens, em vez de ritmo fixo)
--   started_at      : quando a campanha começou (base do aquecimento)
--   warmup_enabled  : nos primeiros dias envia menos e vai subindo (chip novo)
--   typing_enabled  : mostra "digitando..." (delay nativo) antes de cada envio
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS next_send_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS warmup_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS typing_enabled BOOLEAN NOT NULL DEFAULT true,
  -- Agendamento de início: a campanha começa sozinha (status 'scheduled' →
  -- 'running') quando chega este horário. NULL = inicia manualmente.
  ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ;
