-- AI-ABC-C3 / same Task3C / PR #12 / director exact-authorized five-table tenant RLS P0
-- Scope ONLY public.c3_deterministic_response_template RLS Policies; no functions/grants/tables/business DML.
-- Original immutable live preimage: project-memory operations/Task3C_TENANT_RLS_ORIGINAL_PREIMAGE_2026-11-11.json
-- Each forward file is one independent transaction. ANY failed assertion aborts/rolls back this table.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='90s';
-- CAUTION: reopens unscoped tenant writes. Require separate safe rollback decision.
DO $pre$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='c3_deterministic_response_template' AND policyname='task3c_same_company_guard' AND permissive='RESTRICTIVE' AND cmd='ALL') THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_response_template_ROLLBACK_DRIFT'; END IF;
END $pre$;
DROP POLICY task3c_same_company_guard ON public.c3_deterministic_response_template;
COMMIT;
