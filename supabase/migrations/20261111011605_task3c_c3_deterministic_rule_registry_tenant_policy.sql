-- AI-ABC-C3 / same Task3C / PR #12 / director exact-authorized five-table tenant RLS P0
-- Scope ONLY public.c3_deterministic_rule_registry RLS Policies; no functions/grants/tables/business DML.
-- Original immutable live preimage: project-memory operations/Task3C_TENANT_RLS_ORIGINAL_PREIMAGE_2026-11-11.json
-- Each forward file is one independent transaction. ANY failed assertion aborts/rolls back this table.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='90s';
DO $pre$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.c3_deterministic_rule_registry'::regclass AND relrowsecurity IS TRUE) THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_RLS_DRIFT'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='c3_deterministic_rule_registry')<>3 THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_COUNT_DRIFT'; END IF;
 IF EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='c3_deterministic_rule_registry' AND policyname='task3c_same_company_guard') THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_ALREADY_GUARDED'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='c3_deterministic_rule_registry' AND policyname='c3_rule_staff_read' AND cmd='SELECT' AND permissive='PERMISSIVE') THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_SOURCE_POLICY_DRIFT'; END IF;
 IF (SELECT count(*) FROM public.c3_deterministic_rule_registry) <> 0 THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_ROWS_NOT_ZERO_STOP_NO_FIXTURE_ALLOWED'; END IF;
END $pre$;
CREATE POLICY task3c_same_company_guard ON public.c3_deterministic_rule_registry AS RESTRICTIVE
 FOR ALL TO authenticated USING (company_id IS NOT NULL AND public.is_company_member(company_id,(SELECT auth.uid()))
 AND EXISTS(SELECT 1 FROM public.company co WHERE co.id=company_id AND co.is_active)) WITH CHECK (company_id IS NOT NULL AND public.is_company_member(company_id,(SELECT auth.uid()))
 AND EXISTS(SELECT 1 FROM public.company co WHERE co.id=company_id AND co.is_active));
SELECT set_config('task3c_rls.uid',(SELECT cm.user_id::text FROM public.company_membership cm
 JOIN public.company co ON co.id=cm.company_id AND co.is_active
 JOIN public.user_roles ur ON ur.user_id=cm.user_id AND ur.role='admin'
 WHERE cm.is_active AND cm.role='admin' AND EXISTS(SELECT 1 FROM public.company other_co WHERE other_co.id<>cm.company_id AND other_co.is_active AND NOT EXISTS (SELECT 1 FROM public.company_membership other_cm WHERE other_cm.user_id=cm.user_id AND other_cm.company_id=other_co.id AND other_cm.is_active))
 ORDER BY cm.user_id LIMIT 1),true);
SELECT set_config('request.jwt.claim.sub',current_setting('task3c_rls.uid'),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);

SELECT set_config('task3c_rls.own_company',(SELECT cm.company_id::text FROM public.company_membership cm WHERE cm.user_id=current_setting('task3c_rls.uid')::uuid AND cm.is_active ORDER BY cm.company_id LIMIT 1),true);
SELECT set_config('task3c_rls.other_company',(SELECT co.id::text FROM public.company co WHERE co.is_active AND NOT EXISTS(SELECT 1 FROM public.company_membership cm WHERE cm.company_id=co.id AND cm.user_id=current_setting('task3c_rls.uid')::uuid AND cm.is_active) ORDER BY co.id LIMIT 1),true);
SET LOCAL ROLE authenticated;
DO $check$ BEGIN
 IF auth.uid() IS NULL OR auth.role()<>'authenticated' THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_ROLE_INVALID'; END IF;
 IF NOT (public.is_company_member(current_setting('task3c_rls.own_company')::uuid,auth.uid()) AND EXISTS(SELECT 1 FROM public.company co WHERE co.id=current_setting('task3c_rls.own_company')::uuid AND co.is_active)) THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_PREDICATE_POSITIVE_FAIL'; END IF;
 IF public.is_company_member(current_setting('task3c_rls.other_company')::uuid,auth.uid()) THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_PREDICATE_NEGATIVE_FAIL'; END IF;
 IF EXISTS(SELECT 1 FROM public.c3_deterministic_rule_registry) THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_ROWLESS_PREIMAGE_CHANGED'; END IF;
END $check$;
RESET ROLE;
DO $post$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='c3_deterministic_rule_registry' AND policyname='task3c_same_company_guard' AND permissive='RESTRICTIVE' AND cmd='ALL' AND roles=ARRAY['authenticated']::name[] AND qual LIKE '%is_company_member%' AND with_check LIKE '%is_company_member%') THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_GUARD_WRITER_OR_READER_MISSING'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='c3_deterministic_rule_registry')<>4 THEN RAISE EXCEPTION 'TASK3C_c3_deterministic_rule_registry_POST_COUNT'; END IF;
END $post$;
COMMIT;
