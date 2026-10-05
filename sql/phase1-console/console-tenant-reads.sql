-- Nonproduction Console acceptance: retain existing policies and add tenant restrictions.
-- Never apply to production without separate exact-scope authorization.
BEGIN;
CREATE POLICY phase1_conversations_tenant ON public.conversations AS RESTRICTIVE FOR ALL TO authenticated
 USING (public.is_company_member(company_id,auth.uid())) WITH CHECK (public.is_company_member(company_id,auth.uid()));
CREATE POLICY phase1_messages_tenant ON public.messages AS RESTRICTIVE FOR ALL TO authenticated
 USING (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.is_company_member(c.company_id,auth.uid())))
 WITH CHECK (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.is_company_member(c.company_id,auth.uid())));
CREATE POLICY phase1_handoff_tenant ON public.handoff_event AS RESTRICTIVE FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.is_company_member(c.company_id,auth.uid())));
CREATE POLICY phase1_queue_tenant ON public.human_support_queue AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.is_company_member(company_id,auth.uid()));
CREATE POLICY phase1_assignment_tenant ON public.conversation_assignment AS RESTRICTIVE FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.is_company_member(c.company_id,auth.uid())));
CREATE POLICY phase1_status_tenant ON public.conversation_status_log AS RESTRICTIVE FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.conversations c WHERE c.id=conversation_id AND public.is_company_member(c.company_id,auth.uid())));
CREATE POLICY phase1_agents_tenant ON public.agent_profile AS RESTRICTIVE FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.company_membership cm WHERE cm.user_id=agent_profile.user_id AND cm.is_active AND public.is_company_member(cm.company_id,auth.uid())));
CREATE POLICY phase1_channels_tenant ON public.channel_config AS RESTRICTIVE FOR SELECT TO authenticated
 USING (public.is_company_member(company_id,auth.uid()));
CREATE POLICY phase1_visitors_tenant ON public.visitor_session AS RESTRICTIVE FOR SELECT TO authenticated
 USING (EXISTS(SELECT 1 FROM public.channel_config cc WHERE cc.id=channel_config_id AND public.is_company_member(cc.company_id,auth.uid())));
COMMIT;
