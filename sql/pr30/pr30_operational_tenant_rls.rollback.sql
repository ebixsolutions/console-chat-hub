-- Task 3.3 emergency rollback — restore the immediately preceding operational
-- authenticated policies. WARNING: these policies are intentionally broader and
-- reintroduce the cross-tenant exposure this migration closes; use only for
-- emergency rollback under production-owner control.
BEGIN;

DROP POLICY IF EXISTS conversations_select_staff ON public.conversations;
CREATE POLICY conversations_select_staff ON public.conversations
FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));
DROP POLICY IF EXISTS conversations_update_staff ON public.conversations;
CREATE POLICY conversations_update_staff ON public.conversations
FOR UPDATE TO authenticated USING (public.is_staff(auth.uid())) WITH CHECK (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS messages_select_staff ON public.messages;
CREATE POLICY messages_select_staff ON public.messages
FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS conversation_assignment_read ON public.conversation_assignment;
CREATE POLICY conversation_assignment_read ON public.conversation_assignment
FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS conversation_status_log_read ON public.conversation_status_log;
CREATE POLICY conversation_status_log_read ON public.conversation_status_log
FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS visitor_session_select_staff ON public.visitor_session;
CREATE POLICY visitor_session_select_staff ON public.visitor_session
FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS widget_session_event_select_staff ON public.widget_session_event;
CREATE POLICY widget_session_event_select_staff ON public.widget_session_event
FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS channel_config_read ON public.channel_config;
CREATE POLICY channel_config_read ON public.channel_config
FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS channel_config_write_admin ON public.channel_config;
CREATE POLICY channel_config_write_admin ON public.channel_config
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS widget_config_read ON public.widget_config;
CREATE POLICY widget_config_read ON public.widget_config
FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS agent_profile_select ON public.agent_profile;
CREATE POLICY agent_profile_select ON public.agent_profile
FOR SELECT TO authenticated USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS feedback_request_read_tenant ON public.feedback_request;
CREATE POLICY feedback_request_read_admin ON public.feedback_request
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));
CREATE POLICY feedback_request_read_supervisor ON public.feedback_request
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'supervisor'::public.app_role));
CREATE POLICY feedback_request_read_agent_scoped ON public.feedback_request
FOR SELECT TO authenticated USING (conversation_id IN (
  SELECT c.id FROM public.conversations c
  JOIN public.agent_profile ap ON c.assigned_agent_id = ap.id
  WHERE ap.user_id = auth.uid()
));
DROP POLICY IF EXISTS feedback_request_write_admin ON public.feedback_request;
CREATE POLICY feedback_request_write_admin ON public.feedback_request
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS final_prompt_trace_admin_read ON public.final_prompt_trace;
CREATE POLICY final_prompt_trace_admin_read ON public.final_prompt_trace
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS rag_trace_read_admin ON public.rag_trace;
CREATE POLICY rag_trace_read_admin ON public.rag_trace
FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));

COMMIT;
