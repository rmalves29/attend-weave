-- Aplicar funções de relatório (migration 20260710120000 não havia sido executada no banco)

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

UPDATE public.conversations
SET resolved_at = updated_at,
    resolved_by = assigned_agent_id
WHERE status IN ('resolved', 'closed')
  AND resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_resolved
  ON public.conversations(resolved_by, resolved_at)
  WHERE resolved_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_created_direction
  ON public.messages(created_at, direction)
  WHERE is_internal = false;

CREATE OR REPLACE FUNCTION public.report_overview(_since TIMESTAMPTZ)
RETURNS TABLE (
  inbound_count BIGINT, outbound_count BIGINT,
  conversations_active BIGINT, conversations_new BIGINT,
  conversations_resolved BIGINT, conversations_open_now BIGINT,
  contacts_new BIGINT,
  avg_first_response_secs DOUBLE PRECISION,
  avg_resolution_secs DOUBLE PRECISION
) LANGUAGE sql STABLE SET search_path = public AS $$
  WITH msgs AS (
    SELECT conversation_id, direction, created_at
    FROM messages WHERE is_internal = false AND created_at >= _since
  ),
  grouped AS (
    SELECT conversation_id, direction, created_at,
           sum(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END)
             OVER (PARTITION BY conversation_id ORDER BY created_at
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
           - CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END AS grp
    FROM msgs
  ),
  pairs AS (
    SELECT
      min(created_at) FILTER (WHERE direction = 'inbound')  AS first_in,
      min(created_at) FILTER (WHERE direction = 'outbound') AS first_out
    FROM grouped GROUP BY conversation_id, grp
    HAVING min(created_at) FILTER (WHERE direction = 'inbound') IS NOT NULL
       AND min(created_at) FILTER (WHERE direction = 'outbound') IS NOT NULL
  )
  SELECT
    (SELECT count(*) FROM msgs WHERE direction = 'inbound'),
    (SELECT count(*) FROM msgs WHERE direction = 'outbound'),
    (SELECT count(DISTINCT conversation_id) FROM msgs),
    (SELECT count(*) FROM conversations WHERE created_at >= _since),
    (SELECT count(*) FROM conversations WHERE resolved_at >= _since),
    (SELECT count(*) FROM conversations WHERE status IN ('open', 'pending')),
    (SELECT count(*) FROM contacts WHERE created_at >= _since),
    (SELECT avg(extract(epoch FROM first_out - first_in)) FROM pairs),
    (SELECT avg(extract(epoch FROM resolved_at - created_at))
       FROM conversations WHERE resolved_at >= _since AND created_at >= _since)
$$;

CREATE OR REPLACE FUNCTION public.report_daily_flow(_since TIMESTAMPTZ)
RETURNS TABLE (day DATE, inbound BIGINT, outbound BIGINT)
LANGUAGE sql STABLE SET search_path = public AS $$
  WITH days AS (
    SELECT generate_series(
      (_since AT TIME ZONE 'America/Sao_Paulo')::date,
      (now() AT TIME ZONE 'America/Sao_Paulo')::date,
      interval '1 day'
    )::date AS day
  ),
  counts AS (
    SELECT (created_at AT TIME ZONE 'America/Sao_Paulo')::date AS day,
           count(*) FILTER (WHERE direction = 'inbound')  AS inbound,
           count(*) FILTER (WHERE direction = 'outbound') AS outbound
    FROM messages WHERE is_internal = false AND created_at >= _since
    GROUP BY 1
  )
  SELECT d.day, coalesce(c.inbound, 0), coalesce(c.outbound, 0)
  FROM days d LEFT JOIN counts c USING (day) ORDER BY d.day
$$;

CREATE OR REPLACE FUNCTION public.report_agent_performance(_since TIMESTAMPTZ)
RETURNS TABLE (
  agent_id UUID, agent_name TEXT,
  messages_sent BIGINT, conversations_attended BIGINT,
  resolved_count BIGINT, avg_first_response_secs DOUBLE PRECISION
) LANGUAGE sql STABLE SET search_path = public AS $$
  WITH msgs AS (
    SELECT conversation_id, direction, created_at, sender_agent_id
    FROM messages WHERE is_internal = false AND created_at >= _since
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
    SELECT resolved_by AS agent_id, count(*) AS resolved_count
    FROM conversations WHERE resolved_at >= _since AND resolved_by IS NOT NULL
    GROUP BY 1
  ),
  response AS (
    SELECT responder AS agent_id,
           avg(extract(epoch FROM first_out - first_in)) AS avg_first_response_secs
    FROM pairs WHERE responder IS NOT NULL GROUP BY 1
  )
  SELECT p.id, p.name,
    coalesce(s.messages_sent, 0),
    coalesce(s.conversations_attended, 0),
    coalesce(r.resolved_count, 0),
    resp.avg_first_response_secs
  FROM profiles p
  LEFT JOIN sent s ON s.agent_id = p.id
  LEFT JOIN resolved r ON r.agent_id = p.id
  LEFT JOIN response resp ON resp.agent_id = p.id
  WHERE coalesce(s.messages_sent, 0) > 0 OR coalesce(r.resolved_count, 0) > 0
  ORDER BY coalesce(s.messages_sent, 0) DESC
$$;

REVOKE ALL ON FUNCTION public.report_overview(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_daily_flow(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.report_agent_performance(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_overview(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_daily_flow(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_agent_performance(TIMESTAMPTZ) TO service_role;