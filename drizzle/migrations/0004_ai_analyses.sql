-- lovable-cron-fallback-reviewed: worker cron is armed when an analysis is created and unscheduled by the route when no analysis is pending
CREATE TABLE public.ai_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid,
  since timestamptz NOT NULL,
  until timestamptz NOT NULL,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  store_context text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','summarizing','done','error')),
  total_conversations integer NOT NULL DEFAULT 0,
  processed_conversations integer NOT NULL DEFAULT 0,
  failed_conversations integer NOT NULL DEFAULT 0,
  sampled boolean NOT NULL DEFAULT false,
  result_markdown text,
  result_json jsonb,
  error text,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ai_analyses_status_idx ON public.ai_analyses (status, created_at);
GRANT SELECT ON public.ai_analyses TO authenticated;
GRANT ALL ON public.ai_analyses TO service_role;
ALTER TABLE public.ai_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai analyses read by staff" ON public.ai_analyses FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = auth.uid()));

CREATE TABLE public.ai_analysis_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES public.ai_analyses(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (analysis_id, conversation_id)
);
CREATE INDEX ai_analysis_items_queue_idx ON public.ai_analysis_items (analysis_id, status);
GRANT SELECT ON public.ai_analysis_items TO authenticated;
GRANT ALL ON public.ai_analysis_items TO service_role;
ALTER TABLE public.ai_analysis_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai items read by staff" ON public.ai_analysis_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = auth.uid()));

CREATE TABLE public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings read by staff" ON public.app_settings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = auth.uid()));

CREATE TABLE IF NOT EXISTS app_private.ai_worker_secret (
  id integer PRIMARY KEY DEFAULT 1,
  secret text NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex')
);
INSERT INTO app_private.ai_worker_secret (id) VALUES (1) ON CONFLICT DO NOTHING;
REVOKE ALL ON app_private.ai_worker_secret FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.check_ai_worker_secret(_secret text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app_private AS $$
  SELECT EXISTS (SELECT 1 FROM app_private.ai_worker_secret WHERE id = 1 AND secret = _secret)
$$;

CREATE OR REPLACE FUNCTION public.arm_ai_analysis_worker()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-analysis-worker') THEN RETURN; END IF;
  PERFORM cron.schedule('ai-analysis-worker', '* * * * *', $cron$
    SELECT net.http_post(
      url := 'https://project--c56d84cf-72f4-4f06-9087-bd03bba2712f.lovable.app/api/public/ai-analysis-worker',
      headers := jsonb_build_object('Content-Type','application/json','x-worker-secret',(SELECT secret FROM app_private.ai_worker_secret WHERE id = 1)),
      body := '{}'::jsonb,
      timeout_milliseconds := 180000)
  $cron$);
END $$;

CREATE OR REPLACE FUNCTION public.disarm_ai_analysis_worker()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ai-analysis-worker') THEN
    PERFORM cron.unschedule('ai-analysis-worker');
  END IF;
END $$;

-- Lease de execução única: devolve a análise pendente mais antiga e a trava por _secs.
CREATE OR REPLACE FUNCTION public.claim_ai_analysis(_secs integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _id uuid;
BEGIN
  UPDATE ai_analyses SET lease_until = now() + make_interval(secs => _secs)
  WHERE id = (
    SELECT id FROM ai_analyses
    WHERE status IN ('queued','running','summarizing') AND (lease_until IS NULL OR lease_until < now())
    ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
  RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE OR REPLACE FUNCTION public.ai_analysis_candidates(_since timestamptz, _until timestamptz, _channel_ids uuid[], _include_groups boolean, _min_messages integer)
RETURNS TABLE(conversation_id uuid, msg_count bigint, chars bigint, last_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.conversation_id, count(*), sum(coalesce(length(m.content), 10)), max(m.created_at)
  FROM messages m JOIN public.report_scope_v3(_channel_ids, _include_groups) sc ON sc.conversation_id = m.conversation_id
  WHERE m.is_internal = false AND m.created_at >= _since AND m.created_at < _until
  GROUP BY 1 HAVING count(*) >= _min_messages
  ORDER BY max(m.created_at) DESC
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.check_ai_worker_secret(text)', 'public.arm_ai_analysis_worker()', 'public.disarm_ai_analysis_worker()',
    'public.claim_ai_analysis(integer)',
    'public.ai_analysis_candidates(timestamptz, timestamptz, uuid[], boolean, integer)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;