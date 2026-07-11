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
      MIN(created_at) FILTER (WHERE direction = 'inbound')  AS first_in,
      MIN(created_at) FILTER (WHERE direction = 'outbound') AS first_out
    FROM msgs
    GROUP BY conversation_id
  ),
  fr AS (
    SELECT EXTRACT(EPOCH FROM (first_out - first_in)) AS secs
    FROM first_pair
    WHERE first_in IS NOT NULL AND first_out IS NOT NULL AND first_out > first_in
  ),
  res AS (
    SELECT EXTRACT(EPOCH FROM (c.resolved_at - c.created_at)) AS secs
    FROM conversations c
    WHERE c.resolved_at >= _since AND c.resolved_at < _until
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
    (SELECT EXTRACT(EPOCH FROM (now() - MIN(c.last_message_at)))
       FROM conversations c
       WHERE c.status IN ('open','pending')
         AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))),
    (SELECT count(*) FROM contacts ct
       WHERE ct.created_at >= _since AND ct.created_at < _until),
    (SELECT avg(secs) FROM fr),
    (SELECT avg(secs) FROM res),
    (SELECT percentile_cont(0.5)  WITHIN GROUP (ORDER BY secs) FROM fr),
    (SELECT percentile_cont(0.9)  WITHIN GROUP (ORDER BY secs) FROM fr),
    (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY secs) FROM fr),
    (SELECT percentile_cont(0.5)  WITHIN GROUP (ORDER BY secs) FROM res),
    (SELECT percentile_cont(0.9)  WITHIN GROUP (ORDER BY secs) FROM res),
    (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY secs) FROM res),
    (SELECT count(*) FROM fr WHERE secs <= 300),
    (SELECT count(*) FROM fr WHERE secs <= 900),
    (SELECT count(*) FROM fr WHERE secs <= 3600),
    (SELECT count(*) FROM fr)
$$;

REVOKE ALL ON FUNCTION public.report_overview_v2(timestamptz, timestamptz, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_overview_v2(timestamptz, timestamptz, uuid[]) TO service_role;
