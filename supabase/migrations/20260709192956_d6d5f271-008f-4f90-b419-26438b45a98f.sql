CREATE TABLE public.tags (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sets_status TEXT,
  auto_message_enabled BOOLEAN NOT NULL DEFAULT false,
  auto_message_hours INTEGER NOT NULL DEFAULT 24,
  auto_message_content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tags TO authenticated;
GRANT ALL ON public.tags TO service_role;

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view tags" ON public.tags FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert tags" ON public.tags FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Authenticated can update tags" ON public.tags FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated can delete tags" ON public.tags FOR DELETE TO authenticated USING (true);

CREATE TRIGGER update_tags_updated_at BEFORE UPDATE ON public.tags
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();