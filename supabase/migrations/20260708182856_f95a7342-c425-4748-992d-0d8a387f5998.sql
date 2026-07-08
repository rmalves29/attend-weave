ALTER POLICY "Admins manage channels" ON public.channels
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (app_private.has_role(auth.uid(), 'admin'::public.app_role));

ALTER POLICY "Admins view all roles" ON public.user_roles
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role));

ALTER POLICY "Admins manage roles" ON public.user_roles
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (app_private.has_role(auth.uid(), 'admin'::public.app_role));