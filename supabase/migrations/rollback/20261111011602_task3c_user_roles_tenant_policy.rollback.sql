-- AI-ABC-C3 / same Task3C / PR #12 / director exact-authorized five-table tenant RLS P0
-- Scope ONLY public.user_roles RLS Policies; no functions/grants/tables/business DML.
-- Original immutable live preimage: project-memory operations/Task3C_TENANT_RLS_ORIGINAL_PREIMAGE_2026-11-11.json
-- Each forward file is one independent transaction. ANY failed assertion aborts/rolls back this table.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='90s';
-- CAUTION: restores original global manager read scope, security-impacting rollback.
DO $pre$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_roles' AND policyname='management_read_all_roles' AND qual LIKE '%target_cm.company_id%') THEN RAISE EXCEPTION 'TASK3C_USER_ROLES_ROLLBACK_DRIFT'; END IF;
END $pre$;
ALTER POLICY management_read_all_roles ON public.user_roles TO authenticated USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'supervisor'::app_role)));
COMMIT;
