
CREATE TABLE public.tag_followups (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  send_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tag_followups_pending ON public.tag_followups (send_at) WHERE status = 'pending';
CREATE INDEX idx_tag_followups_conversation ON public.tag_followups (conversation_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tag_followups TO authenticated;
GRANT ALL ON public.tag_followups TO service_role;

ALTER TABLE public.tag_followups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can view tag followups"
  ON public.tag_followups FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated can insert tag followups"
  ON public.tag_followups FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "Authenticated can update tag followups"
  ON public.tag_followups FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated can delete tag followups"
  ON public.tag_followups FOR DELETE TO authenticated USING (true);

CREATE TRIGGER update_tag_followups_updated_at
  BEFORE UPDATE ON public.tag_followups
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
