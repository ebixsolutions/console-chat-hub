-- AI-ABC-C3 / same Task3C / PR #12 / director exact-authorized five-table tenant RLS P0
-- Scope ONLY public.upstream_call_log RLS Policies; no functions/grants/tables/business DML.
-- Original immutable live preimage: project-memory operations/Task3C_TENANT_RLS_ORIGINAL_PREIMAGE_2026-11-11.json
-- Each forward file is one independent transaction. ANY failed assertion aborts/rolls back this table.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='90s';
-- CAUTION: restores original overbroad global-read policy. Security rollback requires separate Director decision.
DO $pre$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='upstream_call_log' AND policyname='upstream_call_log_admin_read') THEN RAISE EXCEPTION 'TASK3C_UPSTREAM_ROLLBACK_POLICY_ALREADY_EXISTS'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='upstream_call_log' AND policyname='ucl_sel' AND qual='ce_company_elevated(company_id)') THEN RAISE EXCEPTION 'TASK3C_UPSTREAM_ROLLBACK_BASE_DRIFT'; END IF;
END $pre$;
CREATE POLICY upstream_call_log_admin_read ON public.upstream_call_log AS PERMISSIVE FOR SELECT TO authenticated USING (has_role(auth.uid(), 'admin'::app_role));
COMMIT;
