CREATE TABLE public.quick_replies (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  shortcut text NOT NULL UNIQUE,
  content text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.quick_replies TO authenticated;
GRANT ALL ON public.quick_replies TO service_role;

ALTER TABLE public.quick_replies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view quick replies"
  ON public.quick_replies FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated users can insert quick replies"
  ON public.quick_replies FOR INSERT TO authenticated WITH CHECK (auth.uid() = created_by OR created_by IS NULL);
CREATE POLICY "Authenticated users can update quick replies"
  ON public.quick_replies FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated users can delete quick replies"
  ON public.quick_replies FOR DELETE TO authenticated USING (true);

CREATE TRIGGER update_quick_replies_updated_at
  BEFORE UPDATE ON public.quick_replies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';