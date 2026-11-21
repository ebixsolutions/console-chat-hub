-- AI-ABC-C3 / same Task3C / PR #12 / director exact-authorized five-table tenant RLS P0
-- Scope ONLY public.audit_log RLS Policies; no functions/grants/tables/business DML.
-- Original immutable live preimage: project-memory operations/Task3C_TENANT_RLS_ORIGINAL_PREIMAGE_2026-11-11.json
-- Each forward file is one independent transaction. ANY failed assertion aborts/rolls back this table.
BEGIN;
SET LOCAL lock_timeout='8s';
SET LOCAL statement_timeout='90s';
DO $pre$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.audit_log'::regclass AND relrowsecurity IS TRUE) THEN RAISE EXCEPTION 'TASK3C_audit_log_RLS_DRIFT'; END IF;
 IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='audit_log') <> 1 THEN RAISE EXCEPTION 'TASK3C_audit_log_POLICY_COUNT_DRIFT'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='audit_log' AND policyname='audit_log_admin_read' AND cmd='SELECT' AND permissive='PERMISSIVE' AND qual='has_role(auth.uid(), ''admin''::app_role)') THEN RAISE EXCEPTION 'TASK3C_audit_log_POLICY_PREIMAGE_DRIFT'; END IF;
END $pre$;
ALTER POLICY audit_log_admin_read ON public.audit_log TO authenticated USING (has_role(auth.uid(),'admin'::public.app_role) AND audit_log.resource_id IS NOT NULL AND EXISTS (
 SELECT 1 FROM (SELECT c.company_id FROM public.conversations c WHERE audit_log.resource_type='conversations' AND c.id=audit_log.resource_id
 UNION ALL
 SELECT c.company_id FROM public.messages msg JOIN public.conversations c ON c.id=msg.conversation_id WHERE audit_log.resource_type IN ('message','messages') AND msg.id=audit_log.resource_id
 UNION ALL
 SELECT c.company_id FROM public.handoff_event h JOIN public.conversations c ON c.id=h.conversation_id WHERE audit_log.resource_type='handoff_event' AND h.id=audit_log.resource_id
 UNION ALL
 SELECT c.company_id FROM public.conversation_assignment ca JOIN public.conversations c ON c.id=ca.conversation_id WHERE audit_log.resource_type='conversation_assignment' AND ca.id=audit_log.resource_id
 UNION ALL
 SELECT cm.company_id FROM public.agent_profile ap JOIN public.company_membership cm ON cm.user_id=ap.user_id AND cm.is_active WHERE audit_log.resource_type='agent_profile' AND ap.id=audit_log.resource_id) AS actual_resource_tenant
 JOIN public.company co ON co.id=actual_resource_tenant.company_id AND co.is_active
 WHERE actual_resource_tenant.company_id IS NOT NULL
   AND public.has_company_role(actual_resource_tenant.company_id,(SELECT auth.uid()),'admin'::public.app_role)
));
SELECT set_config('task3c_rls.uid',(SELECT cm.user_id::text FROM public.company_membership cm JOIN public.user_roles ur ON ur.user_id=cm.user_id AND ur.role='admin' JOIN public.company co ON co.id=cm.company_id AND co.is_active WHERE cm.is_active AND cm.role='admin'
 AND EXISTS (SELECT 1 FROM public.audit_log a JOIN public.messages msg ON msg.id=a.resource_id JOIN public.conversations c ON c.id=msg.conversation_id WHERE a.resource_type='message' AND a.actor_id IS NULL AND c.company_id=cm.company_id)
 AND EXISTS (SELECT 1 FROM public.audit_log a JOIN public.conversations c ON c.id=a.resource_id WHERE a.resource_type='conversations' AND c.company_id<>cm.company_id)
 ORDER BY cm.user_id LIMIT 1),true);
SELECT set_config('task3c_rls.own_null_actor',(SELECT a.id::text FROM public.audit_log a JOIN public.messages msg ON msg.id=a.resource_id JOIN public.conversations c ON c.id=msg.conversation_id JOIN public.company_membership m ON m.company_id=c.company_id AND m.user_id=current_setting('task3c_rls.uid')::uuid AND m.is_active WHERE a.resource_type='message' AND a.actor_id IS NULL ORDER BY a.created_at LIMIT 1),true);
SELECT set_config('task3c_rls.foreign_audit',(SELECT a.id::text FROM public.audit_log a JOIN public.conversations c ON c.id=a.resource_id WHERE a.resource_type='conversations' AND NOT EXISTS(SELECT 1 FROM public.company_membership m WHERE m.company_id=c.company_id AND m.user_id=current_setting('task3c_rls.uid')::uuid AND m.is_active) ORDER BY a.created_at LIMIT 1),true);
SELECT set_config('task3c_rls.orphan_audit',(SELECT a.id::text FROM public.audit_log a WHERE a.resource_type='message' AND a.actor_id IS NULL AND NOT EXISTS(SELECT 1 FROM public.messages msg WHERE msg.id=a.resource_id) ORDER BY a.created_at LIMIT 1),true);
SELECT set_config('request.jwt.claim.sub',current_setting('task3c_rls.uid'),true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SET LOCAL ROLE authenticated;
DO $check$ BEGIN
 IF auth.uid() IS NULL OR auth.role()<>'authenticated' THEN RAISE EXCEPTION 'TASK3C_AUDIT_ROLE_INVALID'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_log WHERE id=current_setting('task3c_rls.own_null_actor')::uuid AND actor_id IS NULL) THEN RAISE EXCEPTION 'TASK3C_AUDIT_SAME_TENANT_NULL_ACTOR_POSITIVE_MISSING'; END IF;
 IF EXISTS(SELECT 1 FROM public.audit_log WHERE id=current_setting('task3c_rls.foreign_audit')::uuid) THEN RAISE EXCEPTION 'TASK3C_AUDIT_CROSS_TENANT_LEAK'; END IF;
 IF EXISTS(SELECT 1 FROM public.audit_log WHERE id=current_setting('task3c_rls.orphan_audit')::uuid) THEN RAISE EXCEPTION 'TASK3C_AUDIT_ORPHAN_RESOURCE_LEAK'; END IF;
END $check$;
RESET ROLE;
DO $post$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='audit_log' AND policyname='audit_log_admin_read' AND qual LIKE '%actual_resource_tenant.company_id%' AND qual LIKE '%has_company_role%') THEN RAISE EXCEPTION 'TASK3C_AUDIT_LINEAGE_POLICY_MISSING'; END IF;
END $post$;
COMMIT;
