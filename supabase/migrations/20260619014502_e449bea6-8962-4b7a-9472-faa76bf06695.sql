
-- Staff helper (SECURITY DEFINER to avoid RLS recursion on user_roles)
CREATE OR REPLACE FUNCTION public.is_staff(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND role IN ('admin'::app_role, 'supervisor'::app_role, 'agent'::app_role)
  )
$$;

-- agent_profile: restrict SELECT to staff (hides emails from random authenticated users)
DROP POLICY IF EXISTS agent_profile_select ON public.agent_profile;
CREATE POLICY agent_profile_select ON public.agent_profile
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

-- agent_profile: restrict self-update to authenticated role and prevent role/status escalation
DROP POLICY IF EXISTS agent_profile_update_self_no_role ON public.agent_profile;
CREATE POLICY agent_profile_update_self_no_role ON public.agent_profile
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND role = (SELECT ap.role FROM public.agent_profile ap WHERE ap.id = agent_profile.id)
    AND status = (SELECT ap.status FROM public.agent_profile ap WHERE ap.id = agent_profile.id)
  );

-- conversations: staff-only read
DROP POLICY IF EXISTS auth_read_all_conversations ON public.conversations;
CREATE POLICY conversations_select_staff ON public.conversations
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

-- conversations: tighten update to staff explicitly
DROP POLICY IF EXISTS conversations_update_staff ON public.conversations;
CREATE POLICY conversations_update_staff ON public.conversations
  FOR UPDATE TO authenticated
  USING (public.is_staff(auth.uid()))
  WITH CHECK (public.is_staff(auth.uid()));

-- messages: staff-only read
DROP POLICY IF EXISTS auth_read_all_messages ON public.messages;
CREATE POLICY messages_select_staff ON public.messages
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

-- visitor_session: staff-only read (server-side service role bypasses RLS for widget paths)
CREATE POLICY visitor_session_select_staff ON public.visitor_session
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));

-- widget_session_event: staff-only read
CREATE POLICY widget_session_event_select_staff ON public.widget_session_event
  FOR SELECT TO authenticated
  USING (public.is_staff(auth.uid()));
