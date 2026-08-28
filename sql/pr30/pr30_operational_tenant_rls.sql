-- Task 3.3 — operational tenant RLS closure.
-- Replaces staff-wide/global authenticated access on conversation-adjacent
-- operational surfaces with active-company membership boundaries.
BEGIN;

-- Conversations: direct tenant boundary on SELECT/UPDATE.
DROP POLICY IF EXISTS conversations_select_staff ON public.conversations;
CREATE POLICY conversations_select_staff ON public.conversations
FOR SELECT TO authenticated
USING (company_id IS NOT NULL AND public.is_company_member(company_id, auth.uid()));

DROP POLICY IF EXISTS conversations_update_staff ON public.conversations;
CREATE POLICY conversations_update_staff ON public.conversations
FOR UPDATE TO authenticated
USING (company_id IS NOT NULL AND public.is_company_member(company_id, auth.uid()))
WITH CHECK (company_id IS NOT NULL AND public.is_company_member(company_id, auth.uid()));

-- Messages and conversation-derived rows inherit the parent conversation tenant.
DROP POLICY IF EXISTS messages_select_staff ON public.messages;
CREATE POLICY messages_select_staff ON public.messages
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.id = messages.conversation_id
    AND c.company_id IS NOT NULL
    AND public.is_company_member(c.company_id, auth.uid())
));

DROP POLICY IF EXISTS conversation_assignment_read ON public.conversation_assignment;
CREATE POLICY conversation_assignment_read ON public.conversation_assignment
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.id = conversation_assignment.conversation_id
    AND c.company_id IS NOT NULL
    AND public.is_company_member(c.company_id, auth.uid())
));

DROP POLICY IF EXISTS conversation_status_log_read ON public.conversation_status_log;
CREATE POLICY conversation_status_log_read ON public.conversation_status_log
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.id = conversation_status_log.conversation_id
    AND c.company_id IS NOT NULL
    AND public.is_company_member(c.company_id, auth.uid())
));

-- Visitor/session/event visibility is derived through channel_config.company_id.
DROP POLICY IF EXISTS visitor_session_select_staff ON public.visitor_session;
CREATE POLICY visitor_session_select_staff ON public.visitor_session
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.channel_config cc
  WHERE cc.id = visitor_session.channel_config_id
    AND cc.company_id IS NOT NULL
    AND public.is_company_member(cc.company_id, auth.uid())
));

DROP POLICY IF EXISTS widget_session_event_select_staff ON public.widget_session_event;
CREATE POLICY widget_session_event_select_staff ON public.widget_session_event
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1
  FROM public.visitor_session vs
  JOIN public.channel_config cc ON cc.id = vs.channel_config_id
  WHERE vs.id = widget_session_event.visitor_session_id
    AND cc.company_id IS NOT NULL
    AND public.is_company_member(cc.company_id, auth.uid())
));

-- Channel config must never be globally readable/writable.
DROP POLICY IF EXISTS channel_config_read ON public.channel_config;
CREATE POLICY channel_config_read ON public.channel_config
FOR SELECT TO authenticated
USING (company_id IS NOT NULL AND public.is_company_member(company_id, auth.uid()));

DROP POLICY IF EXISTS channel_config_write_admin ON public.channel_config;
CREATE POLICY channel_config_write_admin ON public.channel_config
FOR ALL TO authenticated
USING (EXISTS (
  SELECT 1
  FROM public.company_membership cm
  JOIN public.company co ON co.id = cm.company_id AND co.is_active = true
  WHERE cm.company_id = channel_config.company_id
    AND cm.user_id = auth.uid()
    AND cm.is_active = true
    AND cm.role::text = 'admin'
))
WITH CHECK (EXISTS (
  SELECT 1
  FROM public.company_membership cm
  JOIN public.company co ON co.id = cm.company_id AND co.is_active = true
  WHERE cm.company_id = channel_config.company_id
    AND cm.user_id = auth.uid()
    AND cm.is_active = true
    AND cm.role::text = 'admin'
));

-- widget_config has no company_id: derive tenant through referencing channels.
DROP POLICY IF EXISTS widget_config_read ON public.widget_config;
CREATE POLICY widget_config_read ON public.widget_config
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.channel_config cc
  WHERE cc.widget_config_id = widget_config.id
    AND cc.company_id IS NOT NULL
    AND public.is_company_member(cc.company_id, auth.uid())
));

-- Agent directory is limited to agents sharing at least one active tenant.
DROP POLICY IF EXISTS agent_profile_select ON public.agent_profile;
CREATE POLICY agent_profile_select ON public.agent_profile
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1
  FROM public.company_membership target_cm
  JOIN public.company_membership caller_cm
    ON caller_cm.company_id = target_cm.company_id
   AND caller_cm.user_id = auth.uid()
   AND caller_cm.is_active = true
  JOIN public.company co
    ON co.id = target_cm.company_id
   AND co.is_active = true
  WHERE target_cm.user_id = agent_profile.user_id
    AND target_cm.is_active = true
));

-- Feedback request rows are conversation-owned; remove global app-role reads/writes.
DROP POLICY IF EXISTS feedback_request_read_admin ON public.feedback_request;
DROP POLICY IF EXISTS feedback_request_read_supervisor ON public.feedback_request;
DROP POLICY IF EXISTS feedback_request_read_agent_scoped ON public.feedback_request;
CREATE POLICY feedback_request_read_tenant ON public.feedback_request
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.conversations c
  WHERE c.id = feedback_request.conversation_id
    AND c.company_id IS NOT NULL
    AND public.is_company_member(c.company_id, auth.uid())
));

DROP POLICY IF EXISTS feedback_request_write_admin ON public.feedback_request;
CREATE POLICY feedback_request_write_admin ON public.feedback_request
FOR ALL TO authenticated
USING (EXISTS (
  SELECT 1
  FROM public.conversations c
  JOIN public.company_membership cm
    ON cm.company_id = c.company_id
   AND cm.user_id = auth.uid()
   AND cm.is_active = true
  JOIN public.company co ON co.id = cm.company_id AND co.is_active = true
  WHERE c.id = feedback_request.conversation_id
    AND cm.role::text = 'admin'
))
WITH CHECK (EXISTS (
  SELECT 1
  FROM public.conversations c
  JOIN public.company_membership cm
    ON cm.company_id = c.company_id
   AND cm.user_id = auth.uid()
   AND cm.is_active = true
  JOIN public.company co ON co.id = cm.company_id AND co.is_active = true
  WHERE c.id = feedback_request.conversation_id
    AND cm.role::text = 'admin'
));

-- Prompt/RAG traces are tenant-admin only, derived from conversation ownership.
DROP POLICY IF EXISTS final_prompt_trace_admin_read ON public.final_prompt_trace;
CREATE POLICY final_prompt_trace_admin_read ON public.final_prompt_trace
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1
  FROM public.conversations c
  JOIN public.company_membership cm
    ON cm.company_id = c.company_id
   AND cm.user_id = auth.uid()
   AND cm.is_active = true
  JOIN public.company co ON co.id = cm.company_id AND co.is_active = true
  WHERE c.id = final_prompt_trace.conversation_id
    AND cm.role::text = 'admin'
));

DROP POLICY IF EXISTS rag_trace_read_admin ON public.rag_trace;
CREATE POLICY rag_trace_read_admin ON public.rag_trace
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1
  FROM public.conversations c
  JOIN public.company_membership cm
    ON cm.company_id = c.company_id
   AND cm.user_id = auth.uid()
   AND cm.is_active = true
  JOIN public.company co ON co.id = cm.company_id AND co.is_active = true
  WHERE c.id = rag_trace.conversation_id
    AND cm.role::text = 'admin'
));

DO $assert$
DECLARE
  bad_count integer;
BEGIN
  SELECT count(*) INTO bad_count
  FROM pg_policies
  WHERE schemaname='public'
    AND tablename IN (
      'conversations','messages','conversation_assignment','conversation_status_log',
      'visitor_session','widget_session_event','channel_config','widget_config',
      'agent_profile','feedback_request','final_prompt_trace','rag_trace'
    )
    AND cmd IN ('SELECT','UPDATE','ALL')
    AND (
      qual = 'true'
      OR qual = 'is_staff(auth.uid())'
      OR with_check = 'is_staff(auth.uid())'
    );
  IF bad_count <> 0 THEN
    RAISE EXCEPTION 'ASSERT: unscoped operational RLS policies remain: %', bad_count;
  END IF;
END
$assert$;

COMMIT;
