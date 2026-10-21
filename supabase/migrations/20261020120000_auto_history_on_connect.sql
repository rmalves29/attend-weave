-- Histórico automático ao conectar o número.
-- Quando um canal WhatsApp conecta, ele é marcado para "descoberta": listar
-- TODAS as conversas e grupos e enfileirar cada uma no backfill de histórico
-- (history_sync_state), que já puxa o histórico ilimitado de cada chat seguindo
-- next_request até o começo da conversa. O cron history-backfill processa a
-- descoberta em lotes (resumível por cursor) e só desarma quando a descoberta
-- E a fila de backfill terminam.
--
-- phase: 'pending' (recém-conectado, aguardando 1º lote)
--      | 'running' (descoberta em andamento, veja cursor)
--      | 'done'    (todas as conversas já enfileiradas)
ALTER TABLE public.channels
  ADD COLUMN IF NOT EXISTS history_discovery jsonb;

COMMENT ON COLUMN public.channels.history_discovery IS
  'Descoberta automática de conversas ao conectar: { phase: pending|running|done, cursor, started_at, enqueued }';
