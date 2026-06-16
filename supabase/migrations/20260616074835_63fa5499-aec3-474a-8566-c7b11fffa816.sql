
-- Roles infrastructure
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('admin', 'supervisor', 'agent');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users read own roles" ON public.user_roles;
CREATE POLICY "users read own roles" ON public.user_roles
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

DROP POLICY IF EXISTS "admins manage roles" ON public.user_roles;
CREATE POLICY "admins manage roles" ON public.user_roles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- agent_profile
DROP POLICY IF EXISTS auth_all_agent_profile ON public.agent_profile;
CREATE POLICY "agent_profile_select" ON public.agent_profile
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "agent_profile_insert_admin" ON public.agent_profile
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "agent_profile_update_self_no_role" ON public.agent_profile
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND role = (SELECT role FROM public.agent_profile WHERE id = agent_profile.id)
    AND status = (SELECT status FROM public.agent_profile WHERE id = agent_profile.id)
  );
CREATE POLICY "agent_profile_update_admin" ON public.agent_profile
  FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "agent_profile_delete_admin" ON public.agent_profile
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- audit_log: admin only
DROP POLICY IF EXISTS auth_read_audit_log ON public.audit_log;
CREATE POLICY "audit_log_admin_read" ON public.audit_log
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- channel_config: read all, write admin
DROP POLICY IF EXISTS auth_read_channel_config ON public.channel_config;
CREATE POLICY "channel_config_read" ON public.channel_config
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "channel_config_write_admin" ON public.channel_config
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- conversation_assignment: read all, write admin/supervisor
DROP POLICY IF EXISTS auth_all_assignment ON public.conversation_assignment;
CREATE POLICY "conversation_assignment_read" ON public.conversation_assignment
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "conversation_assignment_write_priv" ON public.conversation_assignment
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'supervisor'))
  WITH CHECK (public.has_role(auth.uid(), 'admin') OR public.has_role(auth.uid(), 'supervisor'));

-- conversation_status_log: read all, no writes from authenticated (service role only)
DROP POLICY IF EXISTS auth_read_status_log ON public.conversation_status_log;
CREATE POLICY "conversation_status_log_read" ON public.conversation_status_log
  FOR SELECT TO authenticated USING (true);

-- ai_reply_draft: read all (service role writes via edge functions)
DROP POLICY IF EXISTS auth_read_drafts ON public.ai_reply_draft;
CREATE POLICY "ai_reply_draft_read" ON public.ai_reply_draft
  FOR SELECT TO authenticated USING (true);

-- handoff_event: read all
DROP POLICY IF EXISTS auth_read_handoff ON public.handoff_event;
CREATE POLICY "handoff_event_read" ON public.handoff_event
  FOR SELECT TO authenticated USING (true);

-- feedback_automation_config: read all, write admin
DROP POLICY IF EXISTS auth_all_feedback_auto_config ON public.feedback_automation_config;
CREATE POLICY "feedback_automation_config_read" ON public.feedback_automation_config
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "feedback_automation_config_write_admin" ON public.feedback_automation_config
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- feedback_request: read all, write admin only (visitor writes use service role)
DROP POLICY IF EXISTS auth_read_feedback ON public.feedback_request;
CREATE POLICY "feedback_request_read" ON public.feedback_request
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "feedback_request_write_admin" ON public.feedback_request
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- final_prompt_trace: admin only
DROP POLICY IF EXISTS auth_read_prompt_trace ON public.final_prompt_trace;
CREATE POLICY "final_prompt_trace_admin_read" ON public.final_prompt_trace
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- upstream_call_log: admin only
DROP POLICY IF EXISTS auth_read_upstream_log ON public.upstream_call_log;
CREATE POLICY "upstream_call_log_admin_read" ON public.upstream_call_log
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));

-- widget_config: read all, write admin
DROP POLICY IF EXISTS auth_read_widget_config ON public.widget_config;
CREATE POLICY "widget_config_read" ON public.widget_config
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "widget_config_write_admin" ON public.widget_config
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));
