
-- 1) Column-level protection: hide credentials from agents
REVOKE SELECT ON public.channels FROM authenticated;
GRANT SELECT (id, name, type, identifier, status, qr_code, last_connected_at, created_at, updated_at)
  ON public.channels TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.channels TO authenticated;
GRANT ALL ON public.channels TO service_role;

-- 2) Dedup messages by external_id (partial unique index — NULLs allowed)
CREATE UNIQUE INDEX IF NOT EXISTS messages_external_id_unique
  ON public.messages(external_id)
  WHERE external_id IS NOT NULL;
