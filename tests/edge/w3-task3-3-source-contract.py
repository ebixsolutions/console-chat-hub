#!/usr/bin/env python3
"""Task 3.3 comprehensive Product-ready source contract.

Workflow 2 / Task 2.3 SU CoachAI downstream training is deferred. This contract
validates only the current AI Chatbot-owned Task 3.3 closure path and must never
re-open frozen W1/W2 gates to manufacture a Product-ready PASS.
"""
from pathlib import Path
import sys

r = Path(sys.argv[1] if len(sys.argv) > 1 else '.')


def read(path: str) -> str:
    p = r / path
    assert p.is_file() and p.stat().st_size > 0, f"missing/empty {path}"
    return p.read_text()


a = read('scripts/w3-task3-3-production-activate.sh')
s = read('scripts/w3-task3-3-whole-product-smoke.sh')
f = read('scripts/w3-task3-3-final-gate.sh')
loader = read('scripts/w3-task3-3-runtime-inputs-load.sh')
pr30 = read('sql/pr30/pr30_agent_attachment.sql')
rollback = read('sql/pr30/pr30_agent_attachment.rollback.sql')
sec = read('sql/pr30/pr30_task3_3_security_hardening.sql')
sec_rollback = read('sql/pr30/pr30_task3_3_security_hardening.rollback.sql')

for marker in [
    'W3_T3_3_PRODUCTION_AUTHORIZED',
    'explicit final production activation authorization missing',
    'source scripts/w3-task3-3-runtime-inputs-load.sh',
    'W3_T3_3_DEPLOYED_COMMIT_SHA',
    'git rev-parse HEAD',
    'npm run build',
    'pr30_agent_attachment.sql',
    'pr30_task3_3_security_hardening.sql',
]:
    assert marker in a, f"activation missing current marker: {marker}"

for marker in [
    "trap 'rollback_pr30 $?' ERR",
    'rollback_pr30 1',
    'if ! psql "$SUPABASE_DB_URL"',
    'Task 3.3 post-apply security assertions failed',
    'ROLLBACK FAILURE: PR30 rollback command failed',
    'SAFE ROLLBACK NOTE: Task 3.3 RLS hardening remains active',
]:
    assert marker in a, f"activation rollback safety missing: {marker}"
assert '|| fail "PR30 post-apply assertions failed"' not in a
assert a.index('PR30_APPLIED=true') < a.index('rollback_pr30 1')

for marker in [
    'source "$ROOT/config/w3-task3-3-dev-identity.env"',
    'source "$ROOT/scripts/w3-task3-3-runtime-inputs-load.sh"',
    'bash scripts/w3-task3-3-production-activate.sh',
    'bash scripts/w3-task3-3-whole-product-smoke.sh',
    'W3 TASK 3.3 FINAL STATUS: READY',
]:
    assert marker in f, f"final-gate missing: {marker}"
assert f.index('bash scripts/w3-task3-3-production-activate.sh') < \
       f.index('bash scripts/w3-task3-3-whole-product-smoke.sh') < \
       f.index('W3 TASK 3.3 FINAL STATUS: READY')

for src_name, src in [('activation', a), ('smoke', s), ('final-gate', f)]:
    for forbidden in [
        'w2-task2-1-final-gate.sh',
        'w2-task2-2-final-gate.sh',
        'w2-task2-3-final-gate.sh',
        'w1-task1-2-kb-contract-final-gate.sh',
        'w1-task1-3-final-gate.sh',
        'w3-task3-2-security-final-gate.sh',
        'training-outbox-worker',
        'training-result-receiver',
        'training-kb-sync',
        'training-kb-finalize',
        'product-ready-t2-3-write-proof-chain-contract.py',
        'W2_T2_3_REQUIRE_KB_WRITE',
        'W2_T2_3_FIXTURE_APPROVED',
    ]:
        assert forbidden not in src, f"{src_name} re-opens deferred/frozen scope: {forbidden}"

for marker in [
    'SUPABASE_DB_URL',
    'PR10_TENANT_A_BEARER_TOKEN',
    'PR10_TENANT_B_BEARER_TOKEN',
    'KB_SINGAPORE_TENANT_MAP_JSON',
    'KB_SINGAPORE_TENANT_API_KEYS_JSON',
    'W3_T3_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED',
    'W3_T3_3_DEPLOYED_COMMIT_SHA',
]:
    assert marker in loader, f"runtime bridge missing: {marker}"
for forbidden in [
    'TRAINING_OUTBOX_INTERNAL_TOKEN',
    'SU_COACHAI_EVALUATION_ENDPOINT',
    'SU_COACHAI_AUTH_HEADER',
    'SU_COACHAI_AUTH_VALUE',
    'SU_COACHAI_RESULT_TOKEN',
    'TRAINING_KB_SYNC_INTERNAL_TOKEN',
]:
    assert forbidden not in loader, f"runtime bridge requires deferred secret: {forbidden}"

for fn in [
    'generate-reply',
    'conversation-evaluate',
    'kb-search-proxy',
    'agent-assist',
    'widget-live-ai-test',
]:
    assert fn in s, f"whole-product smoke missing current function: {fn}"
for marker in [
    'health-check',
    'production app shell',
    'message_attachment_private',
    "tablename='ai_reply_draft'",
    "tablename='handoff_event'",
    "c.relkind='r'",
    'metadata ? \'storage_path\'',
    'metadata ? \'storage_bucket\'',
    'w3-task3-3-consolidated-closure-contract.py',
    'task3-3-consolidated-product-ready-contract.py',
]:
    assert marker in s, f"whole-product smoke missing: {marker}"

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
    "c.relkind='r'",
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

print('PASS W3 Task3.3 comprehensive current-scope Product-ready source contract')
