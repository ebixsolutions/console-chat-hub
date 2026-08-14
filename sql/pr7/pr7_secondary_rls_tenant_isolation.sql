-- PR-7 secondary authenticated-table tenant isolation.
-- SOURCE ONLY. Do not deploy without explicit Director authorization.
--
-- Complements pr7_core_rls_tenant_isolation.sql and does not reopen its tables.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pr7_secondary_rls_policy_prov (
  tablename text NOT NULL,
  policyname text NOT NULL,
  permissive text NOT NULL,
  roles text[] NOT NULL,
  cmd text NOT NULL,
  qual text,
  with_check text,
  PRIMARY KEY (tablename, policyname)
);

TRUNCATE public.pr7_secondary_rls_policy_prov;

INSERT INTO public.pr7_secondary_rls_policy_prov(
  tablename, policyname, permissive, roles, cmd, qual, with_check
)
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname='public'
  AND tablename IN (
    'ai_reply_draft',
    'audit_log',
    'final_prompt_trace',
    'rag_trace',
    'upstream_call_log',
    'user_roles',
    'visitor_session',
    'widget_session_event'
  );

DO $drop$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN (
        'ai_reply_draft',
        'audit_log',
        'final_prompt_trace',
        'rag_trace',
        'upstream_call_log',
        'user_roles',
        'visitor_session',
        'widget_session_event'
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END
$drop$;

ALTER TABLE public.ai_reply_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.final_prompt_trace ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_trace ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.upstream_call_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visitor_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.widget_session_event ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_reply_draft_company_select
ON public.ai_reply_draft
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = ai_reply_draft.conversation_id
      AND c.company_id IS NOT NULL
      AND public.is_company_member(c.company_id, auth.uid())
  )
);

CREATE POLICY final_prompt_trace_company_select
ON public.final_prompt_trace
FOR SELECT TO authenticated
USING (
  conversation_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = final_prompt_trace.conversation_id
      AND c.company_id IS NOT NULL
      AND public.has_company_role(c.company_id, auth.uid(), 'admin'::public.app_role)
  )
);

CREATE POLICY rag_trace_company_select
ON public.rag_trace
FOR SELECT TO authenticated
USING (
  conversation_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = rag_trace.conversation_id
      AND c.company_id IS NOT NULL
      AND public.has_company_role(c.company_id, auth.uid(), 'admin'::public.app_role)
  )
);

CREATE POLICY upstream_call_log_company_select
ON public.upstream_call_log
FOR SELECT TO authenticated
USING (
  company_id IS NOT NULL
  AND (
    public.has_company_role(company_id, auth.uid(), 'admin'::public.app_role)
    OR public.has_company_role(company_id, auth.uid(), 'supervisor'::public.app_role)
  )
);

CREATE POLICY upstream_call_log_no_authenticated_write
ON public.upstream_call_log
FOR ALL TO authenticated
USING (false)
WITH CHECK (false);

CREATE POLICY user_roles_own_select
ON public.user_roles
FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE POLICY user_roles_same_company_management_select
ON public.user_roles
FOR SELECT TO authenticated
USING (
  public.pr7_same_active_company_user(user_id, auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.company_membership cm
    WHERE cm.user_id = auth.uid()
      AND cm.is_active = true
      AND cm.role IN ('admin'::public.app_role, 'supervisor'::public.app_role)
  )
);

CREATE POLICY visitor_session_company_select
ON public.visitor_session
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.conversations c
    WHERE c.visitor_session_id = visitor_session.id
      AND c.company_id IS NOT NULL
      AND public.is_company_member(c.company_id, auth.uid())
  )
  OR EXISTS (
    SELECT 1
    FROM public.channel_config cc
    WHERE cc.id = visitor_session.channel_config_id
      AND cc.company_id IS NOT NULL
      AND public.is_company_member(cc.company_id, auth.uid())
  )
);

CREATE POLICY widget_session_event_company_select
ON public.widget_session_event
FOR SELECT TO authenticated
USING (
  visitor_session_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM public.visitor_session vs
    WHERE vs.id = widget_session_event.visitor_session_id
      AND (
        EXISTS (
          SELECT 1
          FROM public.conversations c
          WHERE c.visitor_session_id = vs.id
            AND c.company_id IS NOT NULL
            AND public.is_company_member(c.company_id, auth.uid())
        )
        OR EXISTS (
          SELECT 1
          FROM public.channel_config cc
          WHERE cc.id = vs.channel_config_id
            AND cc.company_id IS NOT NULL
            AND public.is_company_member(cc.company_id, auth.uid())
        )
      )
  )
);

CREATE POLICY audit_log_company_admin_select
ON public.audit_log
FOR SELECT TO authenticated
USING (
  (
    diff ? 'company_id'
    AND NULLIF(diff->>'company_id','') IS NOT NULL
    AND public.has_company_role(
      (diff->>'company_id')::uuid,
      auth.uid(),
      'admin'::public.app_role
    )
  )
  OR (
    resource_type IN ('conversations','conversation_assignment')
    AND resource_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.conversations c
      WHERE c.id = audit_log.resource_id
        AND c.company_id IS NOT NULL
        AND public.has_company_role(c.company_id, auth.uid(), 'admin'::public.app_role)
    )
  )
  OR (
    actor_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.agent_profile ap
      JOIN public.company_membership target_cm
        ON target_cm.user_id = ap.user_id
       AND target_cm.is_active = true
      WHERE ap.id = audit_log.actor_id
        AND public.has_company_role(
          target_cm.company_id,
          auth.uid(),
          'admin'::public.app_role
        )
    )
  )
);

REVOKE ALL ON
  public.ai_reply_draft,
  public.audit_log,
  public.final_prompt_trace,
  public.rag_trace,
  public.upstream_call_log,
  public.user_roles,
  public.visitor_session,
  public.widget_session_event
FROM anon;

GRANT SELECT ON
  public.ai_reply_draft,
  public.audit_log,
  public.final_prompt_trace,
  public.rag_trace,
  public.upstream_call_log,
  public.user_roles,
  public.visitor_session,
  public.widget_session_event
TO authenticated;

GRANT ALL ON
  public.ai_reply_draft,
  public.audit_log,
  public.final_prompt_trace,
  public.rag_trace,
  public.upstream_call_log,
  public.user_roles,
  public.visitor_session,
  public.widget_session_event
TO service_role;

DO $assert$
DECLARE v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
  FROM pg_policies
  WHERE schemaname='public'
    AND tablename IN (
      'ai_reply_draft',
      'visitor_session',
      'widget_session_event'
    )
    AND (
      qual = 'true'
      OR coalesce(qual,'') ILIKE '%is_staff(auth.uid())%'
    );

  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'ASSERT: legacy broad secondary RLS remains: %', v_bad;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname='public'
      AND tablename IN (
        'audit_log',
        'final_prompt_trace',
        'rag_trace',
        'upstream_call_log',
        'user_roles'
      )
      AND (
        coalesce(qual,'') ILIKE '%has_role(auth.uid(),%'
        OR coalesce(with_check,'') ILIKE '%has_role(auth.uid(),%'
      )
  ) THEN
    RAISE EXCEPTION 'ASSERT: global has_role policy remains on secondary tenant data';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_policies
    WHERE schemaname='public'
      AND policyname IN (
        'ai_reply_draft_company_select',
        'audit_log_company_admin_select',
        'final_prompt_trace_company_select',
        'rag_trace_company_select',
        'upstream_call_log_company_select',
        'user_roles_same_company_management_select',
        'visitor_session_company_select',
        'widget_session_event_company_select'
      )
  ) <> 8 THEN
    RAISE EXCEPTION 'ASSERT: missing secondary tenant policies';
  END IF;
END
$assert$;

COMMIT;
