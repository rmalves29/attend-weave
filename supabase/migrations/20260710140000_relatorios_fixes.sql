-- ============================================================================
-- Correções de precisão dos relatórios (auditoria 2026-07-09)
-- 1) Resolução via tag não gravava resolved_at → "Resolvidas: 0" apesar de
--    conversas com tag "finalizado". Backfill + o código passa a gravar.
-- 2) Tempo de resolução/AHT media resolved_at - created_at → conversa antiga
--    reaberta e resolvida marcava "resolução: 3 meses". Agora por episódio,
--    via nova coluna last_opened_at (marcada em toda reabertura).
-- 3) FCR contava inbound da vida inteira da conversa → recorrente nunca contava.
--    Agora conta inbound desde a última reabertura.
-- 4) Top tags filtrava por conversa CRIADA no período → tag aplicada hoje em
--    conversa antiga sumia. Nova tabela tag_events registra a aplicação.
-- 5) oldest_open considerava qualquer conversa aberta (mesmo já respondida).
--    Agora só conta as que aguardam resposta (última mensagem é inbound).
-- ============================================================================

-- ---- Episódio de atendimento: quando a conversa foi (re)aberta ----
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ;

-- Backfill: sem histórico de reaberturas, a melhor âncora é a criação.
UPDATE public.conversations
SET last_opened_at = created_at
WHERE last_opened_at IS NULL;

-- ---- Bug 1: resolvidas via tag sem resolved_at ----
UPDATE public.conversations
SET resolved_at = COALESCE(resolved_at, updated_at),
    resolved_by = COALESCE(resolved_by, assigned_agent_id)
WHERE status IN ('resolved', 'closed')
  AND resolved_at IS NULL;

-- ---- Bug 4: eventos de aplicação de tag ----
CREATE TABLE IF NOT EXISTS public.tag_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  channel_id UUID REFERENCES public.channels(id) ON DELETE SET NULL,
  tag_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tag_events_created ON public.tag_events(created_at);
CREATE INDEX IF NOT EXISTS idx_tag_events_conv_tag ON public.tag_events(conversation_id, tag_name);

GRANT SELECT, INSERT ON public.tag_events TO authenticated;
GRANT ALL ON public.tag_events TO service_role;
ALTER TABLE public.tag_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view tag events" ON public.tag_events
  FOR SELECT TO authenticated
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

-- Backfill: um evento por tag atual, ancorado no updated_at da conversa
-- (melhor aproximação de "quando a tag foi aplicada"). Idempotente via NOT EXISTS.
INSERT INTO public.tag_events (conversation_id, channel_id, tag_name, created_at)
SELECT c.id, c.channel_id, lower(t), c.updated_at
FROM public.conversations c, unnest(c.tags) AS t
WHERE c.tags IS NOT NULL AND array_length(c.tags, 1) > 0
  AND NOT EXISTS (
    SELECT 1 FROM public.tag_events te
    WHERE te.conversation_id = c.id AND te.tag_name = lower(t)
  );

-- ============================================================================
-- RPCs corrigidas (CREATE OR REPLACE — mesma assinatura das v2)
-- ============================================================================

-- ---- Overview: resolução por episódio + fila "aguardando" real ----
CREATE OR REPLACE FUNCTION public.report_overview_v2(
  _since timestamptz,
  _until timestamptz,
  _channel_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  inbound_count bigint,
  outbound_count bigint,
  conversations_active bigint,
  conversations_new bigint,
  conversations_resolved bigint,
  conversations_open_now bigint,
  oldest_open_secs double precision,
  contacts_new bigint,
  avg_first_response_secs double precision,
  avg_resolution_secs double precision,
  p50_first_response_secs double precision,
  p90_first_response_secs double precision,
  p95_first_response_secs double precision,
  p50_resolution_secs double precision,
  p90_resolution_secs double precision,
  p95_resolution_secs double precision,
  sla_5m_count bigint,
  sla_15m_count bigint,
  sla_1h_count bigint,
  sla_total_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH msgs AS (
    SELECT m.conversation_id, m.direction, m.created_at, m.sender_agent_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.is_internal = false
      AND m.created_at >= _since AND m.created_at < _until
      AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
  ),
  first_pair AS (
    SELECT
      conversation_id,
      MIN(created_at) FILTER (WHERE direction = 'inbound') AS first_in,
      MIN(created_at) FILTER (WHERE direction = 'outbound' AND sender_agent_id IS NOT NULL) AS first_out
    FROM msgs
    GROUP BY conversation_id
  ),
  fr AS (
    SELECT EXTRACT(EPOCH FROM (first_out - first_in)) AS secs
    FROM first_pair
    WHERE first_in IS NOT NULL AND first_out IS NOT NULL AND first_out > first_in
  ),
  res AS (
    -- Duração do episódio: da última (re)abertura até a resolução, nunca da
    -- criação da conversa (que no modelo 1-conversa-por-contato é eterna).
    SELECT EXTRACT(EPOCH FROM (c.resolved_at - COALESCE(c.last_opened_at, c.created_at))) AS secs
    FROM conversations c
    WHERE c.resolved_at >= _since AND c.resolved_at < _until
      AND c.resolved_at > COALESCE(c.last_opened_at, c.created_at)
      AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
  ),
  -- Fila aguardando: conversas abertas cuja última mensagem é do cliente.
  waiting AS (
    SELECT c.id, c.last_message_at,
           (SELECT m2.direction FROM messages m2
            WHERE m2.conversation_id = c.id AND m2.is_internal = false
            ORDER BY m2.created_at DESC LIMIT 1) AS last_dir
    FROM conversations c
    WHERE c.status IN ('open','pending')
      AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
  )
  SELECT
    (SELECT count(*) FROM msgs WHERE direction = 'inbound'),
    (SELECT count(*) FROM msgs WHERE direction = 'outbound'),
    (SELECT count(DISTINCT conversation_id) FROM msgs),
    (SELECT count(*) FROM conversations c
       WHERE c.created_at >= _since AND c.created_at < _until
         AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))),
    (SELECT count(*) FROM conversations c
       WHERE c.resolved_at >= _since AND c.resolved_at < _until
         AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))),
    (SELECT count(*) FROM conversations c
       WHERE c.status IN ('open','pending')
         AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))),
    (SELECT EXTRACT(EPOCH FROM (now() - MIN(last_message_at)))
       FROM waiting WHERE last_dir = 'inbound'),
    (SELECT count(*) FROM contacts ct
       WHERE ct.created_at >= _since AND ct.created_at < _until
         AND (_channel_ids IS NULL OR ct.source_channel_id = ANY(_channel_ids))),
    (SELECT avg(secs) FROM fr),
    (SELECT avg(secs) FROM res),
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FROM fr),
    (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) FROM fr),
    (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY secs) FROM fr),
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FROM res),
    (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) FROM res),
    (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY secs) FROM res),
    (SELECT count(*) FROM fr WHERE secs <= 300),
    (SELECT count(*) FROM fr WHERE secs <= 900),
    (SELECT count(*) FROM fr WHERE secs <= 3600),
    (SELECT count(*) FROM fr)
$$;

-- ---- Agent performance: AHT por episódio + FCR desde a última reabertura ----
CREATE OR REPLACE FUNCTION public.report_agent_performance_v2(
  _since timestamptz,
  _until timestamptz,
  _channel_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  agent_id uuid,
  agent_name text,
  messages_sent bigint,
  conversations_attended bigint,
  resolved_count bigint,
  avg_first_response_secs double precision,
  aht_secs double precision,
  first_contact_resolution_count bigint,
  concurrent_avg double precision,
  concurrent_peak bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH msgs AS (
    SELECT m.conversation_id, m.direction, m.created_at, m.sender_agent_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.is_internal = false
      AND m.created_at >= _since AND m.created_at < _until
      AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
  ),
  grouped AS (
    SELECT conversation_id, direction, created_at, sender_agent_id,
           sum(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END)
             OVER (PARTITION BY conversation_id ORDER BY created_at
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
           - CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END AS grp
    FROM msgs
  ),
  pairs AS (
    SELECT
      min(created_at) FILTER (WHERE direction = 'inbound')  AS first_in,
      min(created_at) FILTER (WHERE direction = 'outbound') AS first_out,
      (array_agg(sender_agent_id ORDER BY created_at)
         FILTER (WHERE direction = 'outbound'))[1] AS responder
    FROM grouped GROUP BY conversation_id, grp
    HAVING min(created_at) FILTER (WHERE direction = 'inbound') IS NOT NULL
       AND min(created_at) FILTER (WHERE direction = 'outbound') IS NOT NULL
  ),
  sent AS (
    SELECT sender_agent_id AS agent_id,
           count(*) AS messages_sent,
           count(DISTINCT conversation_id) AS conversations_attended
    FROM msgs WHERE direction = 'outbound' AND sender_agent_id IS NOT NULL
    GROUP BY 1
  ),
  resolved AS (
    SELECT c.resolved_by AS agent_id,
           count(*) AS resolved_count,
           avg(EXTRACT(EPOCH FROM (c.resolved_at - COALESCE(c.last_opened_at, c.created_at)))) AS aht_secs
    FROM conversations c
    WHERE c.resolved_at >= _since AND c.resolved_at < _until
      AND c.resolved_by IS NOT NULL
      AND c.resolved_at > COALESCE(c.last_opened_at, c.created_at)
      AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
    GROUP BY 1
  ),
  response AS (
    SELECT responder AS agent_id,
           avg(EXTRACT(EPOCH FROM (first_out - first_in))) AS avg_first_response_secs
    FROM pairs WHERE responder IS NOT NULL GROUP BY 1
  ),
  fcr AS (
    -- Resolvida com exatamente 1 inbound DESDE a última reabertura (episódio).
    SELECT c.resolved_by AS agent_id, count(*) AS first_contact_resolution_count
    FROM conversations c
    WHERE c.resolved_at >= _since AND c.resolved_at < _until
      AND c.resolved_by IS NOT NULL
      AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
      AND (SELECT count(*) FROM messages mm
             WHERE mm.conversation_id = c.id
               AND mm.is_internal = false
               AND mm.direction = 'inbound'
               AND mm.created_at >= COALESCE(c.last_opened_at, c.created_at)) = 1
    GROUP BY 1
  ),
  hourly AS (
    SELECT sender_agent_id AS agent_id,
           date_trunc('hour', created_at) AS h,
           count(DISTINCT conversation_id) AS load
    FROM msgs WHERE direction = 'outbound' AND sender_agent_id IS NOT NULL
    GROUP BY 1, 2
  ),
  concur AS (
    SELECT agent_id, avg(load)::double precision AS concurrent_avg, max(load) AS concurrent_peak
    FROM hourly GROUP BY agent_id
  )
  SELECT p.id, p.name,
    coalesce(s.messages_sent, 0),
    coalesce(s.conversations_attended, 0),
    coalesce(r.resolved_count, 0),
    resp.avg_first_response_secs,
    r.aht_secs,
    coalesce(f.first_contact_resolution_count, 0),
    coalesce(cc.concurrent_avg, 0),
    coalesce(cc.concurrent_peak, 0)
  FROM profiles p
  LEFT JOIN sent s ON s.agent_id = p.id
  LEFT JOIN resolved r ON r.agent_id = p.id
  LEFT JOIN response resp ON resp.agent_id = p.id
  LEFT JOIN fcr f ON f.agent_id = p.id
  LEFT JOIN concur cc ON cc.agent_id = p.id
  WHERE coalesce(s.messages_sent, 0) > 0 OR coalesce(r.resolved_count, 0) > 0
  ORDER BY coalesce(s.messages_sent, 0) DESC
$$;

-- ---- Top tags: por evento de aplicação no período, não por criação da conversa ----
CREATE OR REPLACE FUNCTION public.report_top_tags(
  _since timestamptz,
  _until timestamptz,
  _limit int DEFAULT 10,
  _channel_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (tag_name text, conversations_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT te.tag_name, count(DISTINCT te.conversation_id) AS conversations_count
  FROM tag_events te
  WHERE te.created_at >= _since AND te.created_at < _until
    AND (_channel_ids IS NULL OR te.channel_id = ANY(_channel_ids))
  GROUP BY te.tag_name
  ORDER BY 2 DESC
  LIMIT _limit
$$;
