#!/usr/bin/env python3
"""Task 3.3 current Product-ready source contract.

Task 3.1/3.2 and Workflow 2 gates remain frozen. The authoritative Task 3.3
runtime target is the current Singapore Supabase project, not the retired ref.
"""
from pathlib import Path
import re
import sys

r = Path(sys.argv[1] if len(sys.argv) > 1 else '.')


def read(path: str) -> str:
    p = r / path
    assert p.is_file() and p.stat().st_size > 0, f"missing/empty {path}"
    return p.read_text()

final_gate = read('scripts/w3-task3-3-final-gate.sh')
cutover = read('scripts/task3-3-production-cutover-final-gate.sh')
workflow = read('.github/workflows/task3-3-production-cutover.yml')
pr30 = read('sql/pr30/pr30_agent_attachment.sql')
rollback = read('sql/pr30/pr30_agent_attachment.rollback.sql')
sec = read('sql/pr30/pr30_task3_3_security_hardening.sql')
sec_rollback = read('sql/pr30/pr30_task3_3_security_hardening.rollback.sql')

for marker in [
    'w3-task3-3-source-contract.py',
    'w3-task3-3-consolidated-closure-contract.py',
    'task3-3-consolidated-product-ready-contract.py',
    'w3-task3-3-resolution-contract.py',
    'w3-task3-3-p0-closure-contract.py',
    'w3-task3-3-login-feedback-contract.py',
    'npm run build',
    'W3_T3_3_RUN_PRODUCTION',
    'bash scripts/task3-3-production-cutover-final-gate.sh',
    'W3 TASK 3.3 FINAL STATUS: READY',
]:
    assert marker in final_gate, f"canonical final gate missing: {marker}"
assert 'hvmtoqiwdqvgnjepxwrc' not in final_gate, 'canonical final gate still targets retired Supabase ref'
assert 'w3-task3-3-production-activate.sh' not in final_gate, 'legacy activation path must not remain canonical'

for marker in [
    'PROD="https://console-chat-hub.lovable.app"',
    'TARGET_REF="nrfxhqabwblzxoushgnm"',
    'create-visitor-session',
    'receive-widget-message',
    'widget-poll-messages',
    'task33_production_smoke',
    'exclude_training',
    'published-KB semantic runtime answer',
    'explicit AI-to-human handoff persistence + poll state',
    'production HTML legacy-ref scan',
    'target auth health',
]:
    assert marker in cutover, f"current production cutover missing: {marker}"
assert cutover.count('hvmtoqiwdqvgnjepxwrc') == 1, 'retired ref may appear only as a negative leak scan'
assert 'What is your return policy?' not in cutover, 'false-pass generic Flow B fixture still present'
assert '什么是四電一腦？' in cutover, 'known published-KB semantic fixture missing'
assert re.search(r'空調\|冷氣\|洗衣', cutover), 'KB smoke must assert observed semantic categories'

assert 'W3_T3_3_RUN_PRODUCTION=true' in workflow, 'workflow must invoke canonical final gate in production mode'
assert 'bash scripts/w3-task3-3-final-gate.sh' in workflow, 'workflow must use the single canonical Task 3.3 final gate'
# The cutover script may legitimately appear in workflow path filters; only a direct run bypass is forbidden.
assert not re.search(r'^\s*run:\s*(?:W3_T3_3_RUN_PRODUCTION=true\s+)?bash\s+scripts/task3-3-production-cutover-final-gate\.sh\s*$', workflow, re.M), \
    'workflow must not bypass canonical final gate'

for marker in [
    'BEGIN;',
    'CREATE TABLE IF NOT EXISTS public.message_attachment_private',
    'ENABLE ROW LEVEL SECURITY',
    'REVOKE ALL ON TABLE public.message_attachment_private FROM PUBLIC, anon, authenticated',
    'FOR UPDATE',
    'INSERT INTO public.messages',
    'INSERT INTO public.message_attachment_private',
    'GRANT EXECUTE ON FUNCTION public.agent_send_attachment_tx',
    'COMMIT;',
]:
    assert marker in pr30, f"PR30 missing: {marker}"
assert 'DROP FUNCTION IF EXISTS public.agent_send_attachment_tx' in rollback
assert 'DROP TABLE IF EXISTS public.message_attachment_private' in rollback

for marker in [
    'DROP POLICY IF EXISTS ai_reply_draft_read',
    'CREATE POLICY ai_reply_draft_read',
    'DROP POLICY IF EXISTS handoff_event_read',
    'CREATE POLICY handoff_event_read',
    'JOIN public.company_membership cm',
    'cm.user_id = auth.uid()',
    'cm.is_active = true',
    'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
    'REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',
    'COMMIT;',
]:
    assert marker in sec, f"security hardening missing: {marker}"
for marker in [
    'DROP POLICY IF EXISTS ai_reply_draft_read',
    'DROP POLICY IF EXISTS handoff_event_read',
    'ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY',
    'GRANT ALL ON TABLE public.%I TO anon, authenticated',
]:
    assert marker in sec_rollback, f"security rollback missing: {marker}"

for src_name, src in [('final-gate', final_gate), ('cutover', cutover)]:
    for forbidden in [
        'w2-task2-1-final-gate.sh', 'w2-task2-2-final-gate.sh', 'w2-task2-3-final-gate.sh',
        'w1-task1-2-kb-contract-final-gate.sh', 'w1-task1-3-final-gate.sh',
        'training-outbox-worker', 'training-result-receiver', 'training-kb-sync', 'training-kb-finalize',
        'W2_T2_3_REQUIRE_KB_WRITE', 'W2_T2_3_FIXTURE_APPROVED',
    ]:
        assert forbidden not in src, f"{src_name} re-opens frozen/deferred scope: {forbidden}"

print('PASS W3 Task3.3 current Singapore-target Product-ready source contract')
