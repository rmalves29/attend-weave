
-- 1. CHANNELS: hide credentials column from non-admins
REVOKE SELECT (credentials) ON public.channels FROM authenticated;
GRANT SELECT (id, name, type, identifier, status, qr_code, last_connected_at, created_at, updated_at) ON public.channels TO authenticated;

-- 2. CONTACTS: restrict to agents/admins (not all authenticated users — though current signup grants agent, this enforces role explicitly and prevents unscoped access)
DROP POLICY IF EXISTS "Authenticated manage contacts" ON public.contacts;
CREATE POLICY "Agents view contacts" ON public.contacts FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'agent') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Agents insert contacts" ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'agent') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Agents update contacts" ON public.contacts FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'agent') OR public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'agent') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins delete contacts" ON public.contacts FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 3. CONVERSATIONS: assigned agent or admin; agents can view/claim unassigned
DROP POLICY IF EXISTS "Authenticated manage conversations" ON public.conversations;
CREATE POLICY "View own or unassigned conversations" ON public.conversations FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR assigned_agent_id = auth.uid()
    OR (assigned_agent_id IS NULL AND public.has_role(auth.uid(), 'agent'))
  );
CREATE POLICY "Agents insert conversations" ON public.conversations FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'agent') OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Update own or claim unassigned" ON public.conversations FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR assigned_agent_id = auth.uid()
    OR (assigned_agent_id IS NULL AND public.has_role(auth.uid(), 'agent'))
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR assigned_agent_id = auth.uid()
  );
CREATE POLICY "Admins delete conversations" ON public.conversations FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 4. MESSAGES: only via conversations the user has access to
DROP POLICY IF EXISTS "Authenticated manage messages" ON public.messages;
CREATE POLICY "View messages of accessible conversations" ON public.messages FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND (c.assigned_agent_id = auth.uid()
             OR (c.assigned_agent_id IS NULL AND public.has_role(auth.uid(), 'agent')))
    )
  );
CREATE POLICY "Insert messages on accessible conversations" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND (c.assigned_agent_id = auth.uid()
             OR (c.assigned_agent_id IS NULL AND public.has_role(auth.uid(), 'agent')))
    )
  );
CREATE POLICY "Update own messages" ON public.messages FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR sender_agent_id = auth.uid())
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR sender_agent_id = auth.uid());
CREATE POLICY "Admins delete messages" ON public.messages FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- 5. REALTIME: restrict topic subscriptions to conversations the user can access
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated read realtime for accessible conversations"
ON realtime.messages FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id::text = (realtime.topic())
      AND (c.assigned_agent_id = auth.uid()
           OR (c.assigned_agent_id IS NULL AND public.has_role(auth.uid(), 'agent')))
  )
  OR realtime.topic() IN ('messages', 'conversations') -- allow generic postgres_changes channels for now; filtered by table RLS
);

-- 6. SECURITY DEFINER linter: has_role must remain executable by authenticated (used in RLS).
-- Functions handle_new_user (trigger) and update_updated_at_column (trigger) should not be callable directly.
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated;
-- has_role: keep executable by authenticated (required for RLS policy evaluation by users)
