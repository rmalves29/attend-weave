GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_menu_options TO authenticated;
GRANT ALL ON public.bot_menu_options TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_settings TO authenticated;
GRANT ALL ON public.bot_settings TO service_role;

ALTER TABLE public.bot_menu_options
  ADD COLUMN IF NOT EXISTS assign_tag_id uuid REFERENCES public.tags(id) ON DELETE SET NULL;