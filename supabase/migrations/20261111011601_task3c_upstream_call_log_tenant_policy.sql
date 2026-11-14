-- AI-ABC-C3 / same Task3C / PR #12 / director exact-authorized five-table tenant RLS P0
-- Scope ONLY public.upstream_call_log RLS Policies; no functions/grants/tables/business DML.
-- Original immutable live preimage: project-memory operations/Task3C_TENANT_RLS_ORIGINAL_PREIMAGE_2026-11-11.json
-- Each forward file is one independent transaction. ANY failed assertion aborts/rolls back this table.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='90s';
DO $pre$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.upstream_call_log'::regclass AND relrowsecurity IS TRUE) THEN RAISE EXCEPTION 'TASK3C_upstream_call_log_RLS_DRIFT'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='upstream_call_log') <> 6 THEN RAISE EXCEPTION 'TASK3C_upstream_call_log_POLICY_COUNT_DRIFT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='upstream_call_log' AND policyname='upstream_call_log_admin_read' AND cmd='SELECT' AND permissive='PERMISSIVE' AND qual='has_role(auth.uid(), ''admin''::app_role)') THEN RAISE EXCEPTION 'TASK3C_upstream_call_log_POLICY_PREIMAGE_DRIFT'; END IF;
END $pre$;
DO $pre2$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='upstream_call_log' AND policyname='ucl_sel' AND permissive='PERMISSIVE' AND cmd='SELECT' AND qual='ce_company_elevated(company_id)') THEN RAISE EXCEPTION 'TASK3C_UPSTREAM_TENANT_POLICY_MISSING'; END IF;
END $pre2$;
DROP POLICY upstream_call_log_admin_read ON public.upstream_call_log;
SELECT set_config('task3c_rls.uid',(SELECT cm.user_id::text FROM public.company_membership cm
 JOIN public.company co ON co.id=cm.company_id AND co.is_active
 JOIN public.user_roles ur ON ur.user_id=cm.user_id AND ur.role='admin'
 WHERE cm.is_active AND cm.role='admin' AND EXISTS(SELECT 1 FROM public.upstream_call_log u WHERE u.company_id=cm.company_id)
 ORDER BY cm.user_id LIMIT 1),true);
SELECT set_config('request.jwt.claim.sub',current_setting('task3c_rls.uid'),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
DO $check$ BEGIN
 IF auth.uid() IS NULL OR auth.role()<>'authenticated' THEN RAISE EXCEPTION 'TASK3C_UPSTREAM_ROLE_INVALID'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.upstream_call_log u WHERE public.ce_company_elevated(u.company_id)) THEN RAISE EXCEPTION 'TASK3C_UPSTREAM_SAME_TENANT_POSITIVE_MISSING'; END IF;
 IF EXISTS(SELECT 1 FROM public.upstream_call_log u WHERE u.company_id IS NULL OR NOT public.ce_company_elevated(u.company_id)) THEN RAISE EXCEPTION 'TASK3C_UPSTREAM_CROSS_TENANT_LEAK'; END IF;
END $check$;
RESET ROLE;
DO $post$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='upstream_call_log' AND policyname='upstream_call_log_admin_read') THEN RAISE EXCEPTION 'TASK3C_UPSTREAM_OLD_GLOBAL_POLICY_REMAINS'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='upstream_call_log' AND policyname='ucl_sel' AND qual='ce_company_elevated(company_id)') THEN RAISE EXCEPTION 'TASK3C_UPSTREAM_SCOPED_POLICY_CHANGED'; END IF;
END $post$;
COMMIT;
