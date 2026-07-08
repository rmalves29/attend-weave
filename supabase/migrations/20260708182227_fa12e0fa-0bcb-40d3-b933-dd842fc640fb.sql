CREATE SCHEMA IF NOT EXISTS app_private;

CREATE OR REPLACE FUNCTION app_private.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;

REVOKE ALL ON FUNCTION app_private.has_role(uuid, public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE ALL ON FUNCTION public.has_role(uuid, public.app_role) FROM authenticated;

ALTER POLICY "Admins delete contacts" ON public.contacts
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role));

ALTER POLICY "Agents insert contacts" ON public.contacts
  WITH CHECK (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

ALTER POLICY "Agents update contacts" ON public.contacts
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

ALTER POLICY "Agents view contacts" ON public.contacts
  USING (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

ALTER POLICY "Admins delete conversations" ON public.conversations
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role));

ALTER POLICY "Agents insert conversations" ON public.conversations
  WITH CHECK (app_private.has_role(auth.uid(), 'agent'::public.app_role) OR app_private.has_role(auth.uid(), 'admin'::public.app_role));

ALTER POLICY "Update own or claim unassigned" ON public.conversations
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role) OR (assigned_agent_id = auth.uid()) OR ((assigned_agent_id IS NULL) AND app_private.has_role(auth.uid(), 'agent'::public.app_role)))
  WITH CHECK (app_private.has_role(auth.uid(), 'admin'::public.app_role) OR (assigned_agent_id = auth.uid()));

ALTER POLICY "View own or unassigned conversations" ON public.conversations
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role) OR (assigned_agent_id = auth.uid()) OR ((assigned_agent_id IS NULL) AND app_private.has_role(auth.uid(), 'agent'::public.app_role)));

ALTER POLICY "Admins delete messages" ON public.messages
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role));

ALTER POLICY "Insert messages on accessible conversations" ON public.messages
  WITH CHECK (app_private.has_role(auth.uid(), 'admin'::public.app_role) OR EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND (c.assigned_agent_id = auth.uid() OR (c.assigned_agent_id IS NULL AND app_private.has_role(auth.uid(), 'agent'::public.app_role)))
  ));

ALTER POLICY "Update own messages" ON public.messages
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role) OR (sender_agent_id = auth.uid()))
  WITH CHECK (app_private.has_role(auth.uid(), 'admin'::public.app_role) OR (sender_agent_id = auth.uid()));

ALTER POLICY "View messages of accessible conversations" ON public.messages
  USING (app_private.has_role(auth.uid(), 'admin'::public.app_role) OR EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND (c.assigned_agent_id = auth.uid() OR (c.assigned_agent_id IS NULL AND app_private.has_role(auth.uid(), 'agent'::public.app_role)))
  ));