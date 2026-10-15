CREATE OR REPLACE FUNCTION public.report_is_group(_meta jsonb, _phone text, _ext text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT coalesce(_meta->'whatsapp'->>'is_group','') = 'true'
      OR coalesce(_meta->'whatsapp'->>'remote_jid','') LIKE '%@g.us'
      OR coalesce(_phone,'') LIKE '%@g.us'
      OR coalesce(_ext,'') LIKE '%@g.us'
$$;

CREATE OR REPLACE FUNCTION public.report_is_automated(_meta jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT coalesce(_meta ? 'welcome_bot' OR _meta ? 'auto_followup' OR (_meta->>'automated') = 'true', false)
$$;

CREATE OR REPLACE FUNCTION public.report_scope_v3(_channel_ids uuid[], _include_groups boolean)
RETURNS TABLE(conversation_id uuid, channel_id uuid, contact_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.channel_id, c.contact_id
  FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
  WHERE (_channel_ids IS NULL OR c.channel_id = ANY(_channel_ids))
    AND (_include_groups OR NOT public.report_is_group(ct.metadata, ct.phone, ct.external_id))
$$;

-- Turnos: inbound cuja mensagem anterior (não interna, não automática) é outbound ou inexistente.
CREATE OR REPLACE FUNCTION public.report_turns_v3(_since timestamptz, _until timestamptz, _channel_ids uuid[], _include_groups boolean)
RETURNS TABLE(conversation_id uuid, channel_id uuid, started_at timestamptz, responded_at timestamptz, responder_agent_id uuid, responded boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH sc AS (SELECT * FROM public.report_scope_v3(_channel_ids, _include_groups)),
  base AS (
    SELECT m.conversation_id, sc.channel_id, m.direction, m.created_at,
      lag(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS prev_dir
    FROM messages m JOIN sc ON sc.conversation_id = m.conversation_id
    WHERE m.is_internal = false AND NOT public.report_is_automated(m.metadata)
      AND m.created_at >= _since - interval '30 days' AND m.created_at < _until
  )
  SELECT b.conversation_id, b.channel_id, b.created_at, r.created_at, r.sender_agent_id, r.created_at IS NOT NULL
  FROM base b
  LEFT JOIN LATERAL (
    SELECT m2.created_at, m2.sender_agent_id FROM messages m2
    WHERE m2.conversation_id = b.conversation_id AND m2.direction = 'outbound'
      AND m2.is_internal = false AND NOT public.report_is_automated(m2.metadata)
      AND m2.created_at > b.created_at
    ORDER BY m2.created_at LIMIT 1
  ) r ON true
  WHERE b.direction = 'inbound' AND (b.prev_dir IS NULL OR b.prev_dir = 'outbound')
    AND b.created_at >= _since
$$;

CREATE OR REPLACE FUNCTION public.report_overview_v3(_since timestamptz, _until timestamptz, _channel_ids uuid[] DEFAULT NULL, _include_groups boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH sc AS (SELECT * FROM public.report_scope_v3(_channel_ids, _include_groups)),
  msgs AS (
    SELECT m.conversation_id, m.direction FROM messages m JOIN sc ON sc.conversation_id = m.conversation_id
    WHERE m.is_internal = false AND m.created_at >= _since AND m.created_at < _until
  ),
  firsts AS (
    SELECT m.conversation_id, min(m.created_at) AS first_at FROM messages m JOIN sc ON sc.conversation_id = m.conversation_id
    WHERE m.is_internal = false GROUP BY 1
  ),
  cfirst AS (SELECT sc.contact_id, min(f.first_at) AS first_at FROM firsts f JOIN sc ON sc.conversation_id = f.conversation_id GROUP BY 1),
  t AS (SELECT responded, extract(epoch FROM responded_at - started_at)::float8 AS secs FROM public.report_turns_v3(_since, _until, _channel_ids, _include_groups)),
  res AS (
    SELECT c.id, c.resolved_at, c.resolved_by FROM conversations c JOIN sc ON sc.conversation_id = c.id
    WHERE c.resolved_at >= _since AND c.resolved_at < _until AND c.status IN ('resolved','closed')
  ),
  rt AS (
    SELECT extract(epoch FROM r.resolved_at - cs.start_at)::float8 AS secs
    FROM res r CROSS JOIN LATERAL (
      SELECT min(x.created_at) AS start_at FROM messages x
      WHERE x.conversation_id = r.id AND x.direction = 'inbound' AND x.is_internal = false AND x.created_at <= r.resolved_at
        AND x.created_at >= coalesce((
          SELECT max(g.created_at) FROM (
            SELECT y.created_at, y.created_at - lag(y.created_at) OVER (ORDER BY y.created_at) AS gap
            FROM messages y WHERE y.conversation_id = r.id AND y.is_internal = false AND y.created_at <= r.resolved_at
          ) g WHERE g.gap >= interval '24 hours'), '-infinity'::timestamptz)
    ) cs
    WHERE r.resolved_by IS NOT NULL AND cs.start_at IS NOT NULL
  ),
  openq AS (
    SELECT l.direction, l.created_at FROM conversations c JOIN sc ON sc.conversation_id = c.id
    CROSS JOIN LATERAL (
      SELECT x.direction, x.created_at FROM messages x
      WHERE x.conversation_id = c.id AND x.is_internal = false AND NOT public.report_is_automated(x.metadata)
      ORDER BY x.created_at DESC LIMIT 1) l
    WHERE c.status IN ('open','pending')
  )
  SELECT jsonb_build_object(
    'inbound_count', (SELECT count(*) FROM msgs WHERE direction = 'inbound'),
    'outbound_count', (SELECT count(*) FROM msgs WHERE direction = 'outbound'),
    'conversations_active', (SELECT count(DISTINCT conversation_id) FROM msgs),
    'conversations_new', (SELECT count(*) FROM firsts WHERE first_at >= _since AND first_at < _until),
    'contacts_new', (SELECT count(*) FROM cfirst WHERE first_at >= _since AND first_at < _until),
    'turns_total', (SELECT count(*) FROM t),
    'turns_answered', (SELECT count(*) FROM t WHERE responded),
    'turns_unanswered', (SELECT count(*) FROM t WHERE NOT responded),
    'p50_first_response_secs', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FROM t WHERE responded),
    'p90_first_response_secs', (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) FROM t WHERE responded),
    'avg_first_response_secs', (SELECT avg(secs) FROM t WHERE responded),
    'sla_5m_count', (SELECT count(*) FROM t WHERE responded AND secs <= 300),
    'sla_15m_count', (SELECT count(*) FROM t WHERE responded AND secs <= 900),
    'sla_1h_count', (SELECT count(*) FROM t WHERE responded AND secs <= 3600),
    'resolved_by_agent', (SELECT count(*) FROM res WHERE resolved_by IS NOT NULL),
    'auto_finalized', (SELECT count(*) FROM res WHERE resolved_by IS NULL),
    'p50_resolution_secs', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FROM rt),
    'p90_resolution_secs', (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY secs) FROM rt),
    'avg_resolution_secs', (SELECT avg(secs) FROM rt),
    'open_now_count', (SELECT count(*) FROM openq WHERE direction = 'inbound'),
    'oldest_open_secs', (SELECT extract(epoch FROM now() - min(created_at))::float8 FROM openq WHERE direction = 'inbound')
  )
$$;

CREATE OR REPLACE FUNCTION public.report_daily_flow_v3(_since timestamptz, _until timestamptz, _channel_ids uuid[] DEFAULT NULL, _include_groups boolean DEFAULT false)
RETURNS TABLE(day date, inbound bigint, outbound bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT (m.created_at AT TIME ZONE 'America/Sao_Paulo')::date,
    count(*) FILTER (WHERE m.direction = 'inbound'), count(*) FILTER (WHERE m.direction = 'outbound')
  FROM messages m JOIN public.report_scope_v3(_channel_ids, _include_groups) sc ON sc.conversation_id = m.conversation_id
  WHERE m.is_internal = false AND m.created_at >= _since AND m.created_at < _until
  GROUP BY 1 ORDER BY 1
$$;

CREATE OR REPLACE FUNCTION public.report_hourly_heatmap_v3(_since timestamptz, _until timestamptz, _channel_ids uuid[] DEFAULT NULL, _include_groups boolean DEFAULT false)
RETURNS TABLE(dow int, hour int, inbound bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXTRACT(DOW FROM (m.created_at AT TIME ZONE 'America/Sao_Paulo'))::int,
    EXTRACT(HOUR FROM (m.created_at AT TIME ZONE 'America/Sao_Paulo'))::int, count(*)
  FROM messages m JOIN public.report_scope_v3(_channel_ids, _include_groups) sc ON sc.conversation_id = m.conversation_id
  WHERE m.is_internal = false AND m.direction = 'inbound' AND m.created_at >= _since AND m.created_at < _until
  GROUP BY 1, 2
$$;

CREATE OR REPLACE FUNCTION public.report_agent_performance_v3(_since timestamptz, _until timestamptz, _channel_ids uuid[] DEFAULT NULL, _include_groups boolean DEFAULT false)
RETURNS TABLE(agent_id uuid, agent_name text, messages_sent bigint, conversations_attended bigint, turns_answered bigint,
  p50_first_response_secs float8, avg_first_response_secs float8, resolved_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH sc AS (SELECT * FROM public.report_scope_v3(_channel_ids, _include_groups)),
  o AS (
    SELECT m.sender_agent_id AS aid, count(*) AS n, count(DISTINCT m.conversation_id) AS convs
    FROM messages m JOIN sc ON sc.conversation_id = m.conversation_id
    WHERE m.is_internal = false AND m.direction = 'outbound' AND NOT public.report_is_automated(m.metadata)
      AND m.created_at >= _since AND m.created_at < _until
    GROUP BY 1
  ),
  t AS (
    SELECT responder_agent_id AS aid, count(*) AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM responded_at - started_at)) AS p50,
      avg(extract(epoch FROM responded_at - started_at))::float8 AS av
    FROM public.report_turns_v3(_since, _until, _channel_ids, _include_groups) WHERE responded GROUP BY 1
  ),
  r AS (
    SELECT c.resolved_by AS aid, count(*) AS n FROM conversations c JOIN sc ON sc.conversation_id = c.id
    WHERE c.resolved_by IS NOT NULL AND c.resolved_at >= _since AND c.resolved_at < _until GROUP BY 1
  ),
  ids AS (SELECT aid FROM o UNION SELECT aid FROM t UNION SELECT aid FROM r)
  SELECT ids.aid,
    CASE WHEN ids.aid IS NULL THEN 'Celular / WhatsApp (sem atendente)' ELSE coalesce(p.name, p.email, 'Atendente') END,
    coalesce(o.n, 0), coalesce(o.convs, 0), coalesce(t.n, 0), t.p50, t.av, coalesce(r.n, 0)
  FROM ids
  LEFT JOIN profiles p ON p.id = ids.aid
  LEFT JOIN o ON o.aid IS NOT DISTINCT FROM ids.aid
  LEFT JOIN t ON t.aid IS NOT DISTINCT FROM ids.aid
  LEFT JOIN r ON r.aid IS NOT DISTINCT FROM ids.aid
  ORDER BY coalesce(o.n, 0) DESC
$$;

CREATE OR REPLACE FUNCTION public.report_channel_breakdown_v3(_since timestamptz, _until timestamptz, _channel_ids uuid[] DEFAULT NULL, _include_groups boolean DEFAULT false)
RETURNS TABLE(channel_id uuid, channel_name text, channel_type text, inbound_count bigint, outbound_count bigint,
  conversations_count bigint, turns_total bigint, turns_unanswered bigint, p50_first_response_secs float8)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH sc AS (SELECT * FROM public.report_scope_v3(_channel_ids, _include_groups)),
  mm AS (
    SELECT sc.channel_id, count(*) FILTER (WHERE m.direction = 'inbound') AS i,
      count(*) FILTER (WHERE m.direction = 'outbound') AS o, count(DISTINCT m.conversation_id) AS cv
    FROM messages m JOIN sc ON sc.conversation_id = m.conversation_id
    WHERE m.is_internal = false AND m.created_at >= _since AND m.created_at < _until GROUP BY 1
  ),
  t AS (
    SELECT channel_id, count(*) AS n, count(*) FILTER (WHERE NOT responded) AS un,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM responded_at - started_at)) FILTER (WHERE responded) AS p50
    FROM public.report_turns_v3(_since, _until, _channel_ids, _include_groups) GROUP BY 1
  )
  SELECT ch.id, ch.name, ch.type::text, coalesce(mm.i, 0), coalesce(mm.o, 0), coalesce(mm.cv, 0),
    coalesce(t.n, 0), coalesce(t.un, 0), t.p50
  FROM channels ch LEFT JOIN mm ON mm.channel_id = ch.id LEFT JOIN t ON t.channel_id = ch.id
  WHERE (_channel_ids IS NULL OR ch.id = ANY(_channel_ids))
  ORDER BY coalesce(mm.i, 0) + coalesce(mm.o, 0) DESC
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.report_scope_v3(uuid[], boolean)',
    'public.report_turns_v3(timestamptz, timestamptz, uuid[], boolean)',
    'public.report_overview_v3(timestamptz, timestamptz, uuid[], boolean)',
    'public.report_daily_flow_v3(timestamptz, timestamptz, uuid[], boolean)',
    'public.report_hourly_heatmap_v3(timestamptz, timestamptz, uuid[], boolean)',
    'public.report_agent_performance_v3(timestamptz, timestamptz, uuid[], boolean)',
    'public.report_channel_breakdown_v3(timestamptz, timestamptz, uuid[], boolean)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;