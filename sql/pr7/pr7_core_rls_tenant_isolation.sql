-- PR-7 core authenticated-table tenant isolation.
-- SOURCE ONLY. Do not deploy without explicit Director authorization.
--
-- REQUIRED DEPLOY ORDER:
--   1) sql/pr7/pr7_feedback_config_tenant_scope.sql
--   2) sql/pr7/pr7_core_rls_tenant_isolation.sql
--
-- This migration replaces legacy global staff/read-all policies with
-- company-scoped policies. NULL/unscoped rows fail closed for authenticated users.

BEGIN;

-- ---------------------------------------------------------------------
-- Dependency assertions
-- ---------------------------------------------------------------------
DO $deps$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'feedback_automation_config'
      AND column_name = 'company_id'
  ) THEN
    RAISE EXCEPTION
      'PR7_DEPENDENCY_MISSING: deploy pr7_feedback_config_tenant_scope.sql first';
  END IF;

  IF to_regprocedure('public.is_company_member(uuid,uuid)') IS NULL
     OR to_regprocedure('public.has_company_role(uuid,uuid,public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'PR7_DEPENDENCY_MISSING: company membership helpers';
  END IF;
END
$deps$;

-- ---------------------------------------------------------------------
-- Provenance: exact pre-change policy snapshot for scoped tables
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pr7_core_rls_policy_prov (
  tablename text NOT NULL,
  policyname text NOT NULL,
  permissive text NOT NULL,
  roles text[] NOT NULL,
  cmd text NOT NULL,
  qual text,
  with_check text,
  PRIMARY KEY (tablename, policyname)
);

TRUNCATE public.pr7_core_rls_policy_prov;

INSERT INTO public.pr7_core_rls_policy_prov(
  tablename, policyname, permissive, roles, cmd, qual, with_check
)
SELECT
  tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'agent_profile',
    'channel_config',
    'widget_config',
    'conversations',
    'messages',
    'conversation_assignment',
    'conversation_status_log',
    'handoff_event',
    'feedback_request'
  );

-- ---------------------------------------------------------------------
-- Helper: target agent/profile is in one of caller's active companies.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pr7_same_active_company_user(
  p_target_user_id uuid,
  p_actor_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.company_membership actor_cm
    JOIN public.company_membership target_cm
      ON target_cm.company_id = actor_cm.company_id
     AND target_cm.user_id = p_target_user_id
     AND target_cm.is_active = true
    JOIN public.company c
      ON c.id = actor_cm.company_id
     AND c.is_active = true
    WHERE actor_cm.user_id = p_actor_user_id
      AND actor_cm.is_active = true
  );
$function$;

ALTER FUNCTION public.pr7_same_active_company_user(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.pr7_same_active_company_user(uuid,uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pr7_same_active_company_user(uuid,uuid)
  TO authenticated, service_role;

-- ---------------------------------------------------------------------
-- Drop current policies only on the scoped tables.
-- ---------------------------------------------------------------------
DO $drop$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN (
        'agent_profile',
        'channel_config',
        'widget_config',
        'conversations',
        'messages',
        'conversation_assignment',
        'conversation_status_log',
        'handoff_event',
        'feedback_request'
      )
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.%I',
      p.policyname,
      p.tablename
    );
  END LOOP;
END
$drop$;

ALTER TABLE public.agent_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_status_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoff_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_request ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- agent_profile
-- Own profile is visible/editable for safe fields under existing column rules;
-- company colleagues are visible only within shared active company scope.
-- ---------------------------------------------------------------------
CREATE POLICY agent_profile_company_select
ON public.agent_profile
FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR (
    user_id IS NOT NULL
    AND public.pr7_same_active_company_user(user_id, auth.uid())
  )
);

CREATE POLICY agent_profile_self_update
ON public.agent_profile
FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (
  user_id = auth.uid()
  AND role = (
    SELECT ap.role
    FROM public.agent_profile ap
    WHERE ap.id = agent_profile.id
  )
  AND status = (
    SELECT ap.status
    FROM public.agent_profile ap
    WHERE ap.id = agent_profile.id
  )
);

-- ---------------------------------------------------------------------
-- channel_config
-- ---------------------------------------------------------------------
CREATE POLICY channel_config_company_select
ON public.channel_config
FOR SELECT TO authenticated
USING (
  company_id IS NOT NULL
  AND public.is_company_member(company_id, auth.uid())
);

CREATE POLICY channel_config_company_write
ON public.channel_config
FOR ALL TO authenticated
USING (
  company_id IS NOT NULL
  AND (
    public.has_company_role(company_id, auth.uid(), 'admin'::public.app_role)
    OR public.has_company_role(company_id, auth.uid(), 'supervisor'::public.app_role)
  )
)
WITH CHECK (
  company_id IS NOT NULL
  AND (
    public.has_company_role(company_id, auth.uid(), 'admin'::public.app_role)
    OR public.has_company_role(company_id, auth.uid(), 'supervisor'::public.app_role)
  )
);

-- ---------------------------------------------------------------------
-- widget_config
-- Widget has no direct company_id. Scope is resolved through channel_config.
-- Ambiguous/shared widgets remain readable to members of any linked company,
-- but writes require every linked non-null channel to belong to one company
-- for which caller is admin/supervisor.
-- ---------------------------------------------------------------------
CREATE POLICY widget_config_company_select
ON public.widget_config
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.channel_config cc
    WHERE cc.widget_config_id = widget_config.id
      AND cc.company_id IS NOT NULL
      AND public.is_company_member(cc.company_id, auth.uid())
  )
);

CREATE POLICY widget_config_company_update
ON public.widget_config
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.channel_config cc
    WHERE cc.widget_config_id = widget_config.id
      AND cc.company_id IS NOT NULL
      AND (
        public.has_company_role(cc.company_id, auth.uid(), 'admin'::public.app_role)
        OR public.has_company_role(cc.company_id, auth.uid(), 'supervisor'::public.app_role)
      )
  )
  AND 1 = (
    SELECT count(DISTINCT cc.company_id)
    FROM public.channel_config cc
    WHERE cc.widget_config_id = widget_config.id
      AND cc.company_id IS NOT NULL
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.channel_config cc
    WHERE cc.widget_config_id = widget_config.id
      AND cc.company_id IS NOT NULL
      AND (
        public.has_company_role(cc.company_id, auth.uid(), 'admin'::public.app_role)
        OR public.has_company_role(cc.company_id, auth.uid(), 'supervisor'::public.app_role)
      )
  )
  AND 1 = (
    SELECT count(DISTINCT cc.company_id)
    FROM public.channel_config cc
    WHERE cc.widget_config_id = widget_config.id
      AND cc.company_id IS NOT NULL
  )
);

-- ---------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------
CREATE POLICY conversations_company_select
ON public.conversations
FOR SELECT TO authenticated
USING (
  company_id IS NOT NULL
  AND public.is_company_member(company_id, auth.uid())
);

CREATE POLICY conversations_company_update
ON public.conversations
FOR UPDATE TO authenticated
USING (
  company_id IS NOT NULL
  AND (
    public.has_company_role(company_id, auth.uid(), 'admin'::public.app_role)
    OR public.has_company_role(company_id, auth.uid(), 'supervisor'::public.app_role)
    OR EXISTS (
      SELECT 1
      FROM public.agent_profile ap
      WHERE ap.id = conversations.assigned_agent_id
        AND ap.user_id = auth.uid()
        AND ap.status = 'active'
    )
  )
)
WITH CHECK (
  company_id IS NOT NULL
  AND public.is_company_member(company_id, auth.uid())
);

-- ---------------------------------------------------------------------
-- messages (read only for authenticated; writes are Edge/service-role paths)
-- ---------------------------------------------------------------------
CREATE POLICY messages_company_select
ON public.messages
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND c.company_id IS NOT NULL
      AND public.is_company_member(c.company_id, auth.uid())
  )
);

-- ---------------------------------------------------------------------
-- conversation_assignment
-- ---------------------------------------------------------------------
CREATE POLICY conversation_assignment_company_select
ON public.conversation_assignment
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = conversation_assignment.conversation_id
      AND c.company_id IS NOT NULL
      AND public.is_company_member(c.company_id, auth.uid())
  )
);

CREATE POLICY conversation_assignment_company_write
ON public.conversation_assignment
FOR ALL TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = conversation_assignment.conversation_id
      AND c.company_id IS NOT NULL
      AND (
        public.has_company_role(c.company_id, auth.uid(), 'admin'::public.app_role)
        OR public.has_company_role(c.company_id, auth.uid(), 'supervisor'::public.app_role)
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = conversation_assignment.conversation_id
      AND c.company_id IS NOT NULL
      AND (
        public.has_company_role(c.company_id, auth.uid(), 'admin'::public.app_role)
        OR public.has_company_role(c.company_id, auth.uid(), 'supervisor'::public.app_role)
      )
  )
);

-- ---------------------------------------------------------------------
-- conversation_status_log / handoff_event: authenticated read only
-- ---------------------------------------------------------------------
CREATE POLICY conversation_status_log_company_select
ON public.conversation_status_log
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = conversation_status_log.conversation_id
      AND c.company_id IS NOT NULL
      AND public.is_company_member(c.company_id, auth.uid())
  )
);

CREATE POLICY handoff_event_company_select
ON public.handoff_event
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = handoff_event.conversation_id
      AND c.company_id IS NOT NULL
      AND public.is_company_member(c.company_id, auth.uid())
  )
);

-- ---------------------------------------------------------------------
-- feedback_request
-- Admin/supervisor see company rows; assigned agent sees its conversations.
-- Insert follows same company/assignment rules. Direct update/delete only
-- company admin/supervisor. Public response uses service-role Edge/RPC path.
-- ---------------------------------------------------------------------
CREATE POLICY feedback_request_company_select
ON public.feedback_request
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = feedback_request.conversation_id
      AND c.company_id IS NOT NULL
      AND (
        public.has_company_role(c.company_id, auth.uid(), 'admin'::public.app_role)
        OR public.has_company_role(c.company_id, auth.uid(), 'supervisor'::public.app_role)
        OR EXISTS (
          SELECT 1
          FROM public.agent_profile ap
          WHERE ap.id = c.assigned_agent_id
            AND ap.user_id = auth.uid()
            AND ap.status = 'active'
        )
      )
  )
);

CREATE POLICY feedback_request_company_insert
ON public.feedback_request
FOR INSERT TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = feedback_request.conversation_id
      AND c.company_id IS NOT NULL
      AND (
        public.has_company_role(c.company_id, auth.uid(), 'admin'::public.app_role)
        OR public.has_company_role(c.company_id, auth.uid(), 'supervisor'::public.app_role)
        OR EXISTS (
          SELECT 1
          FROM public.agent_profile ap
          WHERE ap.id = c.assigned_agent_id
            AND ap.user_id = auth.uid()
            AND ap.status = 'active'
        )
      )
  )
);

CREATE POLICY feedback_request_company_update
ON public.feedback_request
FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = feedback_request.conversation_id
      AND c.company_id IS NOT NULL
      AND (
        public.has_company_role(c.company_id, auth.uid(), 'admin'::public.app_role)
        OR public.has_company_role(c.company_id, auth.uid(), 'supervisor'::public.app_role)
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = feedback_request.conversation_id
      AND c.company_id IS NOT NULL
      AND (
        public.has_company_role(c.company_id, auth.uid(), 'admin'::public.app_role)
        OR public.has_company_role(c.company_id, auth.uid(), 'supervisor'::public.app_role)
      )
  )
);

CREATE POLICY feedback_request_company_delete
ON public.feedback_request
FOR DELETE TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.id = feedback_request.conversation_id
      AND c.company_id IS NOT NULL
      AND public.has_company_role(c.company_id, auth.uid(), 'admin'::public.app_role)
  )
);

-- ---------------------------------------------------------------------
-- Table grants: preserve authenticated application access behind RLS.
-- anon gets no direct access on these internal tables.
-- ---------------------------------------------------------------------
REVOKE ALL ON
  public.agent_profile,
  public.channel_config,
  public.widget_config,
  public.conversations,
  public.messages,
  public.conversation_assignment,
  public.conversation_status_log,
  public.handoff_event,
  public.feedback_request
FROM anon;

GRANT SELECT, UPDATE ON public.agent_profile TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_config TO authenticated;
GRANT SELECT, UPDATE ON public.widget_config TO authenticated;
GRANT SELECT, UPDATE ON public.conversations TO authenticated;
GRANT SELECT ON public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_assignment TO authenticated;
GRANT SELECT ON public.conversation_status_log TO authenticated;
GRANT SELECT ON public.handoff_event TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feedback_request TO authenticated;

GRANT ALL ON
  public.agent_profile,
  public.channel_config,
  public.widget_config,
  public.conversations,
  public.messages,
  public.conversation_assignment,
  public.conversation_status_log,
  public.handoff_event,
  public.feedback_request
TO service_role;

-- ---------------------------------------------------------------------
-- Machine assertions
-- ---------------------------------------------------------------------
DO $assert$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*)
    INTO v_bad
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN (
      'channel_config',
      'widget_config',
      'conversation_assignment',
      'conversation_status_log',
      'handoff_event'
    )
    AND qual = 'true';

  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'ASSERT: read-all tenant policies remain: %', v_bad;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN ('conversations','messages','agent_profile')
      AND (
        coalesce(qual,'') ILIKE '%is_staff(auth.uid())%'
        OR coalesce(with_check,'') ILIKE '%is_staff(auth.uid())%'
      )
  ) THEN
    RAISE EXCEPTION 'ASSERT: global is_staff policy remains on tenant data';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_policies
    WHERE schemaname='public'
      AND policyname IN (
        'agent_profile_company_select',
        'channel_config_company_select',
        'widget_config_company_select',
        'conversations_company_select',
        'messages_company_select',
        'conversation_assignment_company_select',
        'conversation_status_log_company_select',
        'handoff_event_company_select',
        'feedback_request_company_select'
      )
  ) <> 9 THEN
    RAISE EXCEPTION 'ASSERT: missing one or more company-scoped SELECT policies';
  END IF;
END
$assert$;

COMMIT;
