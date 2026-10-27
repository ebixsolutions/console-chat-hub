-- AI-ABC-C3 / PR #12 / SAME TASK1 / DIRECTOR EXACT-SCOPE SECURITY REPAIR
-- Company-unbound global Feedback default. Select only for active company staff.
-- Existing administrator ALL writer policy stays unchanged. RESTRICTIVE SELECT
-- guard prevents its permissive SELECT branch from bypassing company membership.
-- No DML, new tables, new Functions, settings changes, or unrelated DDL.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='35s';
DO $pre$
DECLARE r record; c boolean;
BEGIN
 SELECT relrowsecurity INTO c FROM pg_class
 WHERE oid='public.feedback_automation_config'::regclass AND relkind='r';
 IF NOT FOUND OR c IS DISTINCT FROM true THEN RAISE EXCEPTION 'TASK1_PREIMAGE_RLS_DRIFT'; END IF;
 SELECT * INTO r FROM pg_policies
 WHERE schemaname='public' AND tablename='feedback_automation_config'
 AND policyname='feedback_automation_config_read';
 IF NOT FOUND OR r.permissive<>'PERMISSIVE' OR r.cmd<>'SELECT'
 OR r.roles<>ARRAY['authenticated']::name[] OR r.qual<>'true' THEN
  RAISE EXCEPTION 'TASK1_PREIMAGE_READ_POLICY_DRIFT';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies
  WHERE schemaname='public' AND tablename='feedback_automation_config'
  AND policyname='feedback_automation_config_write_admin'
  AND cmd='ALL' AND permissive='PERMISSIVE'
  AND qual='has_role(auth.uid(), ''admin''::app_role)') THEN
  RAISE EXCEPTION 'TASK1_PREIMAGE_ADMIN_WRITE_POLICY_DRIFT';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
  AND tablename='feedback_automation_config'
  AND policyname='task1_feedback_active_staff_select') THEN
  RAISE EXCEPTION 'TASK1_PREIMAGE_ALREADY_APPLIED';
 END IF;
 IF NOT has_table_privilege('anon','public.feedback_automation_config','SELECT')
 OR NOT has_table_privilege('authenticated','public.feedback_automation_config','SELECT') THEN
  RAISE EXCEPTION 'TASK1_PREIMAGE_SELECT_GRANTS_DRIFT';
 END IF;
 IF EXISTS(SELECT 1 FROM information_schema.columns
 WHERE table_schema='public' AND table_name='feedback_automation_config'
 AND column_name='company_id') THEN RAISE EXCEPTION 'TASK1_PREIMAGE_GLOBAL_CONFIG_SCHEMA_DRIFT'; END IF;
END $pre$;
ALTER POLICY feedback_automation_config_read ON public.feedback_automation_config
 TO authenticated USING (
 (SELECT auth.uid()) IS NOT NULL
 AND EXISTS (
  SELECT 1 FROM public.company_membership cm
  WHERE cm.user_id = (SELECT auth.uid())
    AND cm.is_active IS TRUE
    AND cm.role IN (
      'admin'::public.app_role,'supervisor'::public.app_role,
      'agent'::public.app_role,'qa'::public.app_role
    )
 )
);
CREATE POLICY task1_feedback_active_staff_select
 ON public.feedback_automation_config AS RESTRICTIVE
 FOR SELECT TO authenticated USING (
 (SELECT auth.uid()) IS NOT NULL
 AND EXISTS (
  SELECT 1 FROM public.company_membership cm
  WHERE cm.user_id = (SELECT auth.uid())
    AND cm.is_active IS TRUE
    AND cm.role IN (
      'admin'::public.app_role,'supervisor'::public.app_role,
      'agent'::public.app_role,'qa'::public.app_role
    )
 )
);
REVOKE SELECT ON public.feedback_automation_config FROM anon;
DO $assert$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
 AND tablename='feedback_automation_config' AND cmd IN ('SELECT','ALL')
 AND permissive='PERMISSIVE' AND qual='true') THEN
  RAISE EXCEPTION 'TASK1_ASSERT_UNRESTRICTED_SELECT_REMAINS';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
 AND tablename='feedback_automation_config'
 AND policyname='task1_feedback_active_staff_select'
 AND cmd='SELECT' AND permissive='RESTRICTIVE'
 AND qual LIKE '%company_membership%') THEN
  RAISE EXCEPTION 'TASK1_ASSERT_RESTRICTIVE_MEMBERSHIP_MISSING';
 END IF;
 IF has_table_privilege('anon','public.feedback_automation_config','SELECT') OR
 NOT has_table_privilege('authenticated','public.feedback_automation_config','SELECT') THEN
  RAISE EXCEPTION 'TASK1_ASSERT_SELECT_GRANT_DRIFT';
 END IF;
END $assert$;
COMMIT;
