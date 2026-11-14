import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const migration=readFileSync('supabase/migrations/20261027110810_task1_feedback_config_staff_select_rls_20261027.sql','utf8');
const rollback=readFileSync('supabase/migrations/rollback/20261027110810_task1_feedback_config_staff_select_rls_20261027.rollback.sql','utf8');
const feedback=readFileSync('src/lib/api/feedback.service.ts','utf8');
test('Task1 security source: authenticated nonmembers and anon cannot read global feedback configuration',()=>{
 assert.match(migration,/ALTER POLICY feedback_automation_config_read ON public\.feedback_automation_config/);
 assert.match(migration,/CREATE POLICY task1_feedback_active_staff_select[\s\S]*AS RESTRICTIVE[\s\S]*FOR SELECT TO authenticated/);
 assert.match(migration,/REVOKE SELECT ON public\.feedback_automation_config FROM anon/);
 assert.equal((migration.match(/SELECT 1 FROM public\.company_membership cm/g)||[]).length,2);
 assert.equal((migration.match(/cm\.user_id = \(SELECT auth\.uid\(\)\)/g)||[]).length,2);
 assert.equal((migration.match(/cm\.is_active IS TRUE/g)||[]).length,2);
 for(const role of ['admin','supervisor','agent','qa'])assert.equal((migration.match(new RegExp("'"+role+"'::public.app_role",'g'))||[]).length,2,'role preserved '+role);
 assert.match(migration,/TASK1_PREIMAGE_ADMIN_WRITE_POLICY_DRIFT/);
 assert.match(migration,/TASK1_ASSERT_RESTRICTIVE_MEMBERSHIP_MISSING/);
 assert.doesNotMatch(migration,/(?:INSERT INTO|DELETE FROM|UPDATE public\.feedback_automation_config|TRUNCATE|DROP TABLE)/i);
 assert.doesNotMatch(migration,/\bce_feature_flags\b/);
});
test('Task1 security rollback preserves exact prior read/grants; no data deletion',()=>{
 assert.match(rollback,/DROP POLICY task1_feedback_active_staff_select ON public\.feedback_automation_config/);
 assert.match(rollback,/ALTER POLICY feedback_automation_config_read ON public\.feedback_automation_config[\s\S]*TO authenticated USING \(true\)/);
 assert.match(rollback,/GRANT SELECT ON public\.feedback_automation_config TO anon/);
 assert.match(rollback,/TASK1_ROLLBACK_RESTRICTIVE_PREIMAGE_DRIFT/);
 assert.doesNotMatch(rollback,/(?:INSERT INTO|DELETE FROM|UPDATE public\.feedback_automation_config|TRUNCATE|DROP TABLE)/i);
});
test('Task1 feedback legitimate scheduling: all role classes retain global read after authorization',()=>{
 assert.match(feedback,/company-unbound \(no company_id column\)/);
 assert.match(feedback,/PRE_ACTIVATION_SCHEDULE_ROLES = new Set\(\["admin", "supervisor", "agent", "qa"\]\)/);
 assert.match(feedback,/if \(!permitted\) \{/);
 assert(feedback.indexOf('if (!permitted)')<feedback.indexOf('const cfg = await readFeedbackConfig(context.supabase)'));
 assert.match(feedback,/\.from\("feedback_automation_config"\)/);
});
