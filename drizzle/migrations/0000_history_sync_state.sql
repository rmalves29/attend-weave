-- lovable-cron-fallback-reviewed: bounded backfill queue; job is armed on enqueue and unscheduled by the route once the queue drains
CREATE TABLE public.history_sync_state (
  conversation_id uuid PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  chat_jid text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  has_more boolean NOT NULL DEFAULT true,
  next_request jsonb,
  oldest_message_at timestamptz,
  fetched_count integer NOT NULL DEFAULT 0,
  last_error text,
  attempts integer NOT NULL DEFAULT 0,
  request_id text,
  last_activity_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX history_sync_state_queue_idx ON public.history_sync_state (status, has_more, last_activity_at DESC NULLS LAST);
CREATE INDEX history_sync_state_request_idx ON public.history_sync_state (request_id);
GRANT SELECT ON public.history_sync_state TO authenticated;
GRANT ALL ON public.history_sync_state TO service_role;
ALTER TABLE public.history_sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "history sync read auth" ON public.history_sync_state FOR SELECT TO authenticated USING (true);
CREATE TRIGGER update_history_sync_state_updated_at BEFORE UPDATE ON public.history_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE SCHEMA IF NOT EXISTS app_private;
CREATE TABLE IF NOT EXISTS app_private.backfill_secret (
  id integer PRIMARY KEY DEFAULT 1,
  secret text NOT NULL DEFAULT encode(extensions.gen_random_bytes(32), 'hex')
);
INSERT INTO app_private.backfill_secret (id) VALUES (1) ON CONFLICT DO NOTHING;
REVOKE ALL ON app_private.backfill_secret FROM PUBLIC, anon, authenticated;

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.check_backfill_secret(_secret text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app_private AS $$
  SELECT EXISTS (SELECT 1 FROM app_private.backfill_secret WHERE id = 1 AND secret = _secret)
$$;
REVOKE ALL ON FUNCTION public.check_backfill_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_backfill_secret(text) TO service_role;

CREATE OR REPLACE FUNCTION public.arm_history_backfill()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'history-backfill') THEN RETURN; END IF;
  PERFORM cron.schedule('history-backfill', '* * * * *', $cron$
    SELECT net.http_post(
      url := 'https://project--c56d84cf-72f4-4f06-9087-bd03bba2712f.lovable.app/api/public/history-backfill',
      headers := jsonb_build_object('Content-Type','application/json','x-backfill-secret',(SELECT secret FROM app_private.backfill_secret WHERE id = 1)),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000)
  $cron$);
END $$;

CREATE OR REPLACE FUNCTION public.disarm_history_backfill()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'history-backfill') THEN
    PERFORM cron.unschedule('history-backfill');
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.arm_history_backfill() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.disarm_history_backfill() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arm_history_backfill() TO service_role;
GRANT EXECUTE ON FUNCTION public.disarm_history_backfill() TO service_role;