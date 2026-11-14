-- AI-ABC-C3 / same Task3C / PR #12 / director exact-authorized five-table tenant RLS P0
-- Scope ONLY public.audit_log RLS Policies; no functions/grants/tables/business DML.
-- Original immutable live preimage: project-memory operations/Task3C_TENANT_RLS_ORIGINAL_PREIMAGE_2026-11-11.json
-- Each forward file is one independent transaction. ANY failed assertion aborts/rolls back this table.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='90s';
-- CAUTION: original global admin policy would expose other-company audit resources. Use only separately security-authorized rollback.
DO $pre$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='audit_log' AND policyname='audit_log_admin_read' AND qual LIKE '%actual_resource_tenant.company_id%') THEN RAISE EXCEPTION 'TASK3C_AUDIT_ROLLBACK_DRIFT'; END IF;
END $pre$;
ALTER POLICY audit_log_admin_read ON public.audit_log TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
COMMIT;
