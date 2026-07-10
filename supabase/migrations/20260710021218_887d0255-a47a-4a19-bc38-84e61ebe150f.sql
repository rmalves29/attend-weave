
-- ============================================================================
-- Relatórios gerenciais v2
-- Padrão: STABLE SECURITY DEFINER, executadas pelo service_role via server fn.
-- Janela _since / _until permite reaproveitar as mesmas funções para comparar
-- períodos consecutivos.
-- ============================================================================

-- ------------------------------------------------------------
-- Overview v2 — KPIs + percentis + SLA buckets + fila em aberto
-- ------------------------------------------------------------
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
    -- Primeiro par inbound→outbound de cada conversa (tempo até 1ª resposta clássico)
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

-- ------------------------------------------------------------
-- Daily flow com filtro de canal
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_daily_flow_v2(
  _since timestamptz,
  _until timestamptz,
  _channel_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (day date, inbound bigint, outbound bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH days AS (
    SELECT generate_series(
      (_since AT TIME ZONE 'America/Sao_Paulo')::date,
      ((_until - interval '1 second') AT TIME ZONE 'America/Sao_Paulo')::date,
      interval '1 day'
    )::date AS day
  ),
  counts AS (
    SELECT (m.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS day,
           count(*) FILTER (WHERE m.direction = 'inbound')  AS inbound,
           count(*) FILTER (WHERE m.direction = 'outbound') AS outbound
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.is_internal = false
      AND m.created_at >= _since AND m.created_at < _until
      AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
    GROUP BY 1
  )
  SELECT d.day, coalesce(c.inbound, 0), coalesce(c.outbound, 0)
  FROM days d LEFT JOIN counts c USING (day) ORDER BY d.day
$$;

-- ------------------------------------------------------------
-- Agent performance v2 — AHT, resolução no 1º contato, carga simultânea
-- ------------------------------------------------------------
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
           avg(EXTRACT(EPOCH FROM (c.resolved_at - c.created_at))) AS aht_secs
    FROM conversations c
    WHERE c.resolved_at >= _since AND c.resolved_at < _until
      AND c.resolved_by IS NOT NULL
      AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
    GROUP BY 1
  ),
  response AS (
    SELECT responder AS agent_id,
           avg(EXTRACT(EPOCH FROM (first_out - first_in))) AS avg_first_response_secs
    FROM pairs WHERE responder IS NOT NULL GROUP BY 1
  ),
  fcr AS (
    -- Resolução no 1º contato: conversa resolvida com exatamente 1 par inbound→outbound
    SELECT c.resolved_by AS agent_id, count(*) AS first_contact_resolution_count
    FROM conversations c
    WHERE c.resolved_at >= _since AND c.resolved_at < _until
      AND c.resolved_by IS NOT NULL
      AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
      AND (SELECT count(*) FROM messages mm
             WHERE mm.conversation_id = c.id
               AND mm.is_internal = false
               AND mm.direction = 'inbound') <= 1
    GROUP BY 1
  ),
  hourly AS (
    -- Carga simultânea aproximada: conversas distintas atendidas pelo agente por hora
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

-- ------------------------------------------------------------
-- Heatmap dia-da-semana × hora (mensagens recebidas)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_hourly_heatmap(
  _since timestamptz,
  _until timestamptz,
  _channel_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (dow int, hour int, inbound bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    EXTRACT(DOW FROM (m.created_at AT TIME ZONE 'America/Sao_Paulo'))::int AS dow,
    EXTRACT(HOUR FROM (m.created_at AT TIME ZONE 'America/Sao_Paulo'))::int AS hour,
    count(*) AS inbound
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
  WHERE m.is_internal = false
    AND m.direction = 'inbound'
    AND m.created_at >= _since AND m.created_at < _until
    AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
  GROUP BY 1, 2
$$;

-- ------------------------------------------------------------
-- Top tags — conversations.tags é text[] com nomes de tags
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_top_tags(
  _since timestamptz,
  _until timestamptz,
  _limit int DEFAULT 10,
  _channel_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (tag_name text, conversations_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT lower(t)::text AS tag_name, count(DISTINCT c.id) AS conversations_count
  FROM conversations c, unnest(c.tags) AS t
  WHERE c.created_at >= _since AND c.created_at < _until
    AND c.tags IS NOT NULL AND array_length(c.tags, 1) > 0
    AND (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
  GROUP BY 1
  ORDER BY 2 DESC
  LIMIT _limit
$$;

-- ------------------------------------------------------------
-- Quebra por canal
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_channel_breakdown(
  _since timestamptz,
  _until timestamptz
)
RETURNS TABLE (
  channel_id uuid,
  channel_name text,
  channel_type text,
  inbound_count bigint,
  outbound_count bigint,
  conversations_count bigint,
  avg_first_response_secs double precision
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH msgs AS (
    SELECT m.conversation_id, m.direction, m.created_at, m.sender_agent_id, c.channel_id
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.is_internal = false
      AND m.created_at >= _since AND m.created_at < _until
  ),
  first_pair AS (
    SELECT
      conversation_id,
      channel_id,
      MIN(created_at) FILTER (WHERE direction = 'inbound') AS first_in,
      MIN(created_at) FILTER (WHERE direction = 'outbound' AND sender_agent_id IS NOT NULL) AS first_out
    FROM msgs
    GROUP BY conversation_id, channel_id
  ),
  fr AS (
    SELECT channel_id, EXTRACT(EPOCH FROM (first_out - first_in)) AS secs
    FROM first_pair
    WHERE first_in IS NOT NULL AND first_out IS NOT NULL AND first_out > first_in
  ),
  agg AS (
    SELECT channel_id,
           count(*) FILTER (WHERE direction = 'inbound') AS inbound_count,
           count(*) FILTER (WHERE direction = 'outbound') AS outbound_count,
           count(DISTINCT conversation_id) AS conversations_count
    FROM msgs GROUP BY 1
  )
  SELECT ch.id, ch.name, ch.type::text,
    coalesce(a.inbound_count, 0),
    coalesce(a.outbound_count, 0),
    coalesce(a.conversations_count, 0),
    (SELECT avg(secs) FROM fr WHERE fr.channel_id = ch.id)
  FROM channels ch
  LEFT JOIN agg a ON a.channel_id = ch.id
  WHERE coalesce(a.inbound_count, 0) + coalesce(a.outbound_count, 0) > 0
  ORDER BY (coalesce(a.inbound_count, 0) + coalesce(a.outbound_count, 0)) DESC
$$;

-- ------------------------------------------------------------
-- Follow-ups: contagens + próximos pendentes
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_followups_summary(
  _since timestamptz,
  _until timestamptz
)
RETURNS TABLE (
  scheduled_count bigint,
  sent_count bigint,
  cancelled_count bigint,
  failed_count bigint,
  upcoming jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM tag_followups f
       WHERE f.created_at >= _since AND f.created_at < _until),
    (SELECT count(*) FROM tag_followups f
       WHERE f.sent_at >= _since AND f.sent_at < _until AND f.status = 'sent'),
    (SELECT count(*) FROM tag_followups f
       WHERE f.updated_at >= _since AND f.updated_at < _until AND f.status = 'cancelled'),
    (SELECT count(*) FROM tag_followups f
       WHERE f.updated_at >= _since AND f.updated_at < _until AND f.status = 'failed'),
    (SELECT coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) FROM (
       SELECT f.id, f.send_at, t.name AS tag_name, ct.name AS contact_name
       FROM tag_followups f
       LEFT JOIN tags t ON t.id = f.tag_id
       LEFT JOIN conversations c ON c.id = f.conversation_id
       LEFT JOIN contacts ct ON ct.id = c.contact_id
       WHERE f.status = 'pending' AND f.send_at >= now()
       ORDER BY f.send_at ASC
       LIMIT 10
     ) x)
$$;

-- ============================================================================
-- Permissões: apenas service_role executa (server functions com admin client)
-- ============================================================================
DO $$
DECLARE fn text;
BEGIN
  FOR fn IN SELECT unnest(ARRAY[
    'report_overview_v2(timestamptz,timestamptz,uuid[])',
    'report_daily_flow_v2(timestamptz,timestamptz,uuid[])',
    'report_agent_performance_v2(timestamptz,timestamptz,uuid[])',
    'report_hourly_heatmap(timestamptz,timestamptz,uuid[])',
    'report_top_tags(timestamptz,timestamptz,int,uuid[])',
    'report_channel_breakdown(timestamptz,timestamptz)',
    'report_followups_summary(timestamptz,timestamptz)'
  ])
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', fn);
  END LOOP;
END $$;
