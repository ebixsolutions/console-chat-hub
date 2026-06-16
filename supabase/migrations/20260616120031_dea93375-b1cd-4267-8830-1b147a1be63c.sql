DROP POLICY IF EXISTS agent_profile_update_self_no_role ON public.agent_profile;
CREATE POLICY agent_profile_update_self_no_role ON public.agent_profile
FOR UPDATE
USING (user_id = auth.uid())
WITH CHECK (
  user_id = auth.uid()
  AND role = (SELECT ap.role FROM public.agent_profile ap WHERE ap.id = agent_profile.id)
  AND status = (SELECT ap.status FROM public.agent_profile ap WHERE ap.id = agent_profile.id)
);