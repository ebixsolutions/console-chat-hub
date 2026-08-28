#!/usr/bin/env python3
"""Task 3.3 P0 closure: semantic repeat routing + operational tenant RLS."""
from pathlib import Path
import sys

r = Path(sys.argv[1] if len(sys.argv) > 1 else '.')

def read(path: str) -> str:
    p = r / path
    assert p.is_file() and p.stat().st_size > 0, f'missing/empty {path}'
    return p.read_text()

gen = read('supabase/functions/generate-reply/index.ts')
rls = read('sql/pr30/pr30_operational_tenant_rls.sql')
rollback = read('sql/pr30/pr30_operational_tenant_rls.rollback.sql')
completion = read('sql/pr30/pr30_operational_tenant_rls_completion.sql')
completion_rollback = read('sql/pr30/pr30_operational_tenant_rls_completion.rollback.sql')

# Repeat-intent matcher must be deterministic/local and wired only into history signals.
for marker in [
    '.normalize("NFKC")',
    'SAME_INTENT_STOP_WORDS',
    'function isSameIntentRepeat(',
    'sharedCount(tokensA, tokensB) >= 3',
    'containment(tokensA, tokensB) >= 0.7',
    'sharedCount(gramsA, gramsB) >= 6',
    'containment(gramsA, gramsB) >= 0.6',
    'if (isSameIntentRepeat(last, previous)) exactSameIntentRepeated = true',
]:
    assert marker in gen, f'generate-reply repeat matcher missing: {marker}'
assert 'last.length > 0 && last === previous' not in gen

# Do not alter the product policy: one clarification, then repeated unresolved intent can handoff.
rules = read('supabase/functions/_shared/escalation-rules.ts')
for marker in [
    'export const MAX_CLARIFICATIONS = 1',
    'clarification_required_before_r2',
    'clarification_new_intent_no_kb_match',
    'repeated_after_clarification',
]:
    assert marker in rules, f'R2 policy drift: {marker}'

# All operational browser-visible conversation surfaces in this closure must be tenant-bound.
for table in [
    'conversations','messages','conversation_assignment','conversation_status_log',
    'visitor_session','widget_session_event','channel_config','widget_config',
    'agent_profile','feedback_request','final_prompt_trace','rag_trace',
]:
    assert table in rls, f'RLS closure missing table: {table}'

for marker in [
    'public.is_company_member(company_id, auth.uid())',
    'c.id = messages.conversation_id',
    'c.id = conversation_assignment.conversation_id',
    'c.id = conversation_status_log.conversation_id',
    'cc.id = visitor_session.channel_config_id',
    'vs.id = widget_session_event.visitor_session_id',
    'cc.widget_config_id = widget_config.id',
    'target_cm.user_id = agent_profile.user_id',
    'c.id = feedback_request.conversation_id',
    'c.id = final_prompt_trace.conversation_id',
    'c.id = rag_trace.conversation_id',
    "cm.role::text = 'admin'",
    "qual = 'true'",
    "qual = 'is_staff(auth.uid())'",
    'COMMIT;',
]:
    assert marker in rls, f'RLS closure missing: {marker}'

for marker in [
    'CREATE POLICY conversations_select_staff',
    'CREATE POLICY conversations_update_staff',
    'CREATE POLICY messages_select_staff',
    'CREATE POLICY conversation_assignment_read',
    'CREATE POLICY conversation_status_log_read',
    'CREATE POLICY visitor_session_select_staff',
    'CREATE POLICY widget_session_event_select_staff',
    'CREATE POLICY channel_config_read',
    'CREATE POLICY channel_config_write_admin',
    'CREATE POLICY widget_config_read',
    'CREATE POLICY agent_profile_select',
    'CREATE POLICY feedback_request_read_tenant',
    'CREATE POLICY feedback_request_write_admin',
    'CREATE POLICY final_prompt_trace_admin_read',
    'CREATE POLICY rag_trace_read_admin',
]:
    assert marker in rls, f'RLS policy missing: {marker}'

# Residual direct-write policies must also be tenant-scoped.
for marker in [
    'DROP POLICY IF EXISTS widget_config_write_admin',
    'FOR UPDATE TO authenticated',
    'cc.widget_config_id = widget_config.id',
    'NOT EXISTS (',
    'other_cc.widget_config_id = widget_config.id',
    "cm.role::text = 'admin'",
    'DROP POLICY IF EXISTS feedback_request_insert_supervisor',
    'CREATE POLICY feedback_request_insert_supervisor',
    'c.id = feedback_request.conversation_id',
    "cm.role::text = 'supervisor'",
    'widget_config global admin write remains',
    'feedback_request global supervisor insert remains',
]:
    assert marker in completion, f'RLS completion missing: {marker}'

# Emergency rollback is explicit and complete for every policy family changed above.
for marker in [
    'public.is_staff(auth.uid())',
    'USING (true)',
    "public.has_role(auth.uid(), 'admin'::public.app_role)",
    'feedback_request_read_admin',
    'feedback_request_read_supervisor',
    'feedback_request_read_agent_scoped',
    'COMMIT;',
]:
    assert marker in rollback, f'RLS rollback missing: {marker}'
for marker in [
    'widget_config_write_admin',
    "public.has_role(auth.uid(), 'admin'::public.app_role)",
    'feedback_request_insert_supervisor',
    "public.has_role(auth.uid(), 'supervisor'::public.app_role)",
    'COMMIT;',
]:
    assert marker in completion_rollback, f'RLS completion rollback missing: {marker}'

print('PASS Task 3.3 P0 closure contract')
