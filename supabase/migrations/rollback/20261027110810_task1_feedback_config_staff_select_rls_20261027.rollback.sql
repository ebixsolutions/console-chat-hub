-- AI-ABC-C3 / PR #12 / SAME TASK1 / exact preimage rollback.
-- Reintroduces original broad read only on explicit Director rollback; no data mutation.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='35s';
DO $pre$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
 AND tablename='feedback_automation_config'
 AND policyname='task1_feedback_active_staff_select'
 AND cmd='SELECT' AND permissive='RESTRICTIVE'
 AND qual LIKE '%company_membership%') THEN
  RAISE EXCEPTION 'TASK1_ROLLBACK_RESTRICTIVE_PREIMAGE_DRIFT';
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
 AND tablename='feedback_automation_config'
 AND policyname='feedback_automation_config_read' AND cmd='SELECT'
 AND permissive='PERMISSIVE' AND qual LIKE '%company_membership%') THEN
  RAISE EXCEPTION 'TASK1_ROLLBACK_READ_PREIMAGE_DRIFT';
 END IF;
 IF has_table_privilege('anon','public.feedback_automation_config','SELECT') THEN
  RAISE EXCEPTION 'TASK1_ROLLBACK_ANON_GRANT_DRIFT';
 END IF;
END $pre$;
DROP POLICY task1_feedback_active_staff_select ON public.feedback_automation_config;
ALTER POLICY feedback_automation_config_read ON public.feedback_automation_config
 TO authenticated USING (true);
GRANT SELECT ON public.feedback_automation_config TO anon;
DO $assert$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
 AND tablename='feedback_automation_config'
 AND policyname='feedback_automation_config_read' AND cmd='SELECT'
 AND permissive='PERMISSIVE' AND roles=ARRAY['authenticated']::name[]
 AND qual='true') THEN RAISE EXCEPTION 'TASK1_ROLLBACK_READ_NOT_RESTORED'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public'
 AND tablename='feedback_automation_config'
 AND policyname='task1_feedback_active_staff_select') THEN
  RAISE EXCEPTION 'TASK1_ROLLBACK_GUARD_NOT_REMOVED';
 END IF;
 IF NOT has_table_privilege('anon','public.feedback_automation_config','SELECT') THEN
  RAISE EXCEPTION 'TASK1_ROLLBACK_ANON_NOT_RESTORED';
 END IF;
END $assert$;
COMMIT;
