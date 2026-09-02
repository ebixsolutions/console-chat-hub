#!/usr/bin/env python3
"""Task 3.3 current Product-ready closure contract.

This contract deliberately excludes frozen/deferred Workflow 2 work. It binds
Task 3.3 to one canonical final gate and the current Singapore Supabase target.
"""
from pathlib import Path
import sys

r = Path(sys.argv[1] if len(sys.argv) > 1 else '.')


def read(path: str) -> str:
    p = r / path
    assert p.is_file() and p.stat().st_size > 0, f"missing/empty {path}"
    return p.read_text()

final_gate = read('scripts/w3-task3-3-final-gate.sh')
cutover = read('scripts/task3-3-production-cutover-final-gate.sh')
workflow = read('.github/workflows/task3-3-production-cutover.yml')
attachment_sql = read('sql/pr30/pr30_agent_attachment.sql')
attachment_rollback = read('sql/pr30/pr30_agent_attachment.rollback.sql')
security_sql = read('sql/pr30/pr30_task3_3_security_hardening.sql')
security_rollback = read('sql/pr30/pr30_task3_3_security_hardening.rollback.sql')

for marker in [
    'python3 tests/edge/w3-task3-3-source-contract.py',
    'python3 tests/edge/w3-task3-3-consolidated-closure-contract.py',
    'python3 tests/edge/task3-3-consolidated-product-ready-contract.py',
    'python3 tests/edge/w3-task3-3-resolution-contract.py',
    'python3 tests/edge/w3-task3-3-p0-closure-contract.py',
    'python3 tests/edge/w3-task3-3-login-feedback-contract.py',
    'npm run build',
    'W3_T3_3_RUN_PRODUCTION',
    'bash scripts/task3-3-production-cutover-final-gate.sh',
    'W3 TASK 3.3 FINAL STATUS: READY',
]:
    assert marker in final_gate, f"final-gate missing: {marker}"
assert final_gate.index('npm run build') < final_gate.index('bash scripts/task3-3-production-cutover-final-gate.sh') < final_gate.index('W3 TASK 3.3 FINAL STATUS: READY')
assert 'hvmtoqiwdqvgnjepxwrc' not in final_gate
assert 'w3-task3-3-production-activate.sh' not in final_gate
assert 'w3-task3-3-whole-product-smoke.sh' not in final_gate

for marker in [
    'TARGET_REF="nrfxhqabwblzxoushgnm"',
    'PROD="https://console-chat-hub.lovable.app"',
    'production root/login/feedback reachable',
    'production HTML legacy-ref scan',
    'target auth health',
    'production-origin widget session creation',
    'Widget attachment upload + private metadata transaction',
    'explicit AI-to-human handoff persistence + poll state',
    'published-KB semantic runtime answer',
]:
    assert marker in cutover, f"cutover missing: {marker}"
assert 'task33_production_smoke' in cutover and 'exclude_training' in cutover

assert 'W3_T3_3_RUN_PRODUCTION=true' in workflow
assert 'bash scripts/w3-task3-3-final-gate.sh' in workflow
assert 'bash scripts/task3-3-production-cutover-final-gate.sh' not in workflow

for src_name, src in [('final_gate', final_gate), ('cutover', cutover)]:
    for forbidden in [
        'w2-task2-3-final-gate.sh',
        'training-outbox-worker', 'training-result-receiver', 'training-kb-sync', 'training-kb-finalize',
        'product-ready-t2-3-write-proof-chain-contract.py', 'w2-task2-3-source-contract.py',
        'W2_T2_3_REQUIRE_KB_WRITE', 'W2_T2_3_FIXTURE_APPROVED',
    ]:
        assert forbidden not in src, f"{src_name} blocks on deferred/frozen work: {forbidden}"

for marker in [
    'CREATE TABLE IF NOT EXISTS public.message_attachment_private',
    'ALTER TABLE public.message_attachment_private ENABLE ROW LEVEL SECURITY',
    'REVOKE ALL ON TABLE public.message_attachment_private FROM PUBLIC, anon, authenticated',
    'INSERT INTO public.message_attachment_private',
    'FOR UPDATE',
    'GRANT EXECUTE ON FUNCTION public.agent_send_attachment_tx',
]:
    assert marker in attachment_sql, f"attachment SQL missing: {marker}"
assert 'DROP FUNCTION IF EXISTS public.agent_send_attachment_tx' in attachment_rollback
assert 'DROP TABLE IF EXISTS public.message_attachment_private' in attachment_rollback

for marker in [
    'CREATE POLICY ai_reply_draft_read',
    'CREATE POLICY handoff_event_read',
    'JOIN public.company_membership cm',
    'cm.user_id = auth.uid()',
    'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
    'REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated',
]:
    assert marker in security_sql, f"security hardening missing: {marker}"
assert 'USING (true)' in security_rollback

print('PASS Task 3.3 current Singapore-target consolidated closure contract')
