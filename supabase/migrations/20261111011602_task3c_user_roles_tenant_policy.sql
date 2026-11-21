-- AI-ABC-C3 / same Task3C / PR #12 / director exact-authorized five-table tenant RLS P0
-- Scope ONLY public.user_roles RLS Policies; no functions/grants/tables/business DML.
-- Original immutable live preimage: project-memory operations/Task3C_TENANT_RLS_ORIGINAL_PREIMAGE_2026-11-11.json
-- Each forward file is one independent transaction. ANY failed assertion aborts/rolls back this table.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='90s';
DO $pre$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.user_roles'::regclass AND relrowsecurity IS TRUE) THEN RAISE EXCEPTION 'TASK3C_user_roles_RLS_DRIFT'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='user_roles') <> 2 THEN RAISE EXCEPTION 'TASK3C_user_roles_POLICY_COUNT_DRIFT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_roles' AND policyname='management_read_all_roles' AND cmd='SELECT' AND permissive='PERMISSIVE' AND qual='(has_role(auth.uid(), ''admin''::app_role) OR has_role(auth.uid(), ''supervisor''::app_role))') THEN RAISE EXCEPTION 'TASK3C_user_roles_POLICY_PREIMAGE_DRIFT'; END IF;
END $pre$;
DO $guard$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_roles' AND policyname='users read own roles' AND cmd='SELECT' AND qual='(user_id = auth.uid())') THEN RAISE EXCEPTION 'TASK3C_USER_ROLES_OWN_POLICY_DRIFT'; END IF;
END $guard$;
ALTER POLICY management_read_all_roles ON public.user_roles TO authenticated USING ((has_role(auth.uid(), 'admin'::app_role) OR has_role(auth.uid(), 'supervisor'::app_role)) AND EXISTS (
 SELECT 1 FROM public.company_membership viewer_cm
 JOIN public.company_membership target_cm ON target_cm.company_id=viewer_cm.company_id AND target_cm.user_id=user_roles.user_id AND target_cm.is_active
 JOIN public.company co ON co.id=viewer_cm.company_id AND co.is_active
 WHERE viewer_cm.user_id=(SELECT auth.uid()) AND viewer_cm.is_active
 AND viewer_cm.role IN ('admin'::public.app_role,'supervisor'::public.app_role)
));
SELECT set_config('task3c_rls.uid',(SELECT viewer.user_id::text FROM public.company_membership viewer
 JOIN public.user_roles own_role ON own_role.user_id=viewer.user_id AND own_role.role IN ('admin','supervisor')
 JOIN public.company co ON co.id=viewer.company_id AND co.is_active
 WHERE viewer.is_active AND viewer.role IN ('admin','supervisor')
 AND EXISTS(SELECT 1 FROM public.company_membership linked JOIN public.user_roles r ON r.user_id=linked.user_id WHERE linked.company_id=viewer.company_id AND linked.is_active AND linked.user_id<>viewer.user_id)
 AND EXISTS(SELECT 1 FROM public.user_roles unrelated WHERE NOT EXISTS(SELECT 1 FROM public.company_membership t WHERE t.user_id=unrelated.user_id AND t.company_id=viewer.company_id AND t.is_active))
 ORDER BY viewer.user_id LIMIT 1),true);
SELECT set_config('task3c_rls.own_role',(SELECT ur.user_id::text FROM public.user_roles ur JOIN public.company_membership t ON t.user_id=ur.user_id JOIN public.company_membership v ON v.company_id=t.company_id AND v.user_id=current_setting('task3c_rls.uid')::uuid AND v.is_active
 WHERE ur.user_id<>v.user_id AND t.is_active ORDER BY ur.user_id LIMIT 1),true);
SELECT set_config('task3c_rls.other_role',(SELECT ur.user_id::text FROM public.user_roles ur WHERE NOT EXISTS(SELECT 1 FROM public.company_membership t JOIN public.company_membership v ON t.company_id=v.company_id WHERE t.user_id=ur.user_id AND v.user_id=current_setting('task3c_rls.uid')::uuid AND t.is_active AND v.is_active) ORDER BY ur.user_id LIMIT 1),true);
SELECT set_config('request.jwt.claim.sub',current_setting('task3c_rls.uid'),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
DO $check$ BEGIN
 IF auth.uid() IS NULL OR auth.role()<>'authenticated' THEN RAISE EXCEPTION 'TASK3C_USER_ROLES_ROLE_INVALID'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=auth.uid()) THEN RAISE EXCEPTION 'TASK3C_USER_ROLES_OWN_POSITIVE_MISSING'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=current_setting('task3c_rls.own_role')::uuid) THEN RAISE EXCEPTION 'TASK3C_USER_ROLES_SAME_TENANT_POSITIVE_MISSING'; END IF;
 IF EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=current_setting('task3c_rls.other_role')::uuid) THEN RAISE EXCEPTION 'TASK3C_USER_ROLES_CROSS_TENANT_LEAK'; END IF;
END $check$;
RESET ROLE;
DO $post$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='user_roles' AND policyname='management_read_all_roles' AND qual LIKE '%target_cm.company_id%' AND qual LIKE '%viewer_cm.user_id%') THEN RAISE EXCEPTION 'TASK3C_USER_ROLES_TENANT_POLICY_MISSING'; END IF;
END $post$;
COMMIT;
