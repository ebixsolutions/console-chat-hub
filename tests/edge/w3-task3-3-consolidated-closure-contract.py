#!/usr/bin/env python3
"""Task 3.3 current Product-ready closure contract.

This contract deliberately excludes Workflow 2 / Task 2.3 SU CoachAI downstream
training/learning, which is deferred to the next project and cannot block the
current AI Chatbot Product-ready closure.
"""
from pathlib import Path
import sys

r = Path(sys.argv[1] if len(sys.argv) > 1 else '.')


def read(path: str) -> str:
    p = r / path
    assert p.is_file() and p.stat().st_size > 0, f"missing/empty {path}"
    return p.read_text()

activation = read('scripts/w3-task3-3-production-activate.sh')
final_gate = read('scripts/w3-task3-3-final-gate.sh')
smoke = read('scripts/w3-task3-3-whole-product-smoke.sh')
runtime_inputs = read('scripts/w3-task3-3-runtime-inputs-load.sh')
attachment_sql = read('sql/pr30/pr30_agent_attachment.sql')
attachment_rollback = read('sql/pr30/pr30_agent_attachment.rollback.sql')

# Exact deployment identity, current repo and explicit authorization are required.
for marker in [
    'W3_T3_3_PRODUCTION_AUTHORIZED',
    'W3_T3_3_DEPLOYED_COMMIT_SHA',
    'git rev-parse HEAD',
    'branch --show-current',
    'working tree must be clean',
    'psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f sql/pr30/pr30_agent_attachment.sql',
]:
    assert marker in activation, f"activation missing: {marker}"

# Failed post-migration activation has both an ERR fallback and an explicit
# assertion-failure rollback path. This must not depend on OR-list semantics.
for marker in [
    'rollback_pr30',
    'pr30_agent_attachment.rollback.sql',
    "trap 'rollback_pr30 $?' ERR",
    'rollback_pr30 1',
    'PR30 post-apply assertions failed',
    'ROLLBACK FAILURE: PR30 rollback command failed',
]:
    assert marker in activation, f"rollback path missing: {marker}"
assert '|| fail "PR30 post-apply assertions failed"' not in activation

# Deferred Task 2.3 training is not executed or runtime-probed by Task 3.3.
for src_name, src in [('activation', activation), ('final_gate', final_gate), ('smoke', smoke)]:
    for forbidden in [
        'w2-task2-3-final-gate.sh',
        'training-outbox-worker',
        'training-result-receiver',
        'training-kb-sync',
        'training-kb-finalize',
        'product-ready-t2-3-write-proof-chain-contract.py',
        'w2-task2-3-source-contract.py',
        'W2_T2_3_REQUIRE_KB_WRITE',
        'W2_T2_3_FIXTURE_APPROVED',
    ]:
        assert forbidden not in src, f"{src_name} still blocks on deferred Task 2.3: {forbidden}"

for deferred_secret in [
    'TRAINING_OUTBOX_INTERNAL_TOKEN',
    'SU_COACHAI_EVALUATION_ENDPOINT',
    'SU_COACHAI_AUTH_HEADER',
    'SU_COACHAI_AUTH_VALUE',
    'SU_COACHAI_RESULT_TOKEN',
    'TRAINING_KB_SYNC_INTERNAL_TOKEN',
]:
    assert deferred_secret not in runtime_inputs, f"runtime bridge still requires deferred secret: {deferred_secret}"

assert 'W3_T3_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED' in runtime_inputs
assert 'W3_T3_3_DEPLOYED_COMMIT_SHA' in runtime_inputs

# Private attachment locator is atomic, service-role only and reversible.
for marker in [
    'CREATE TABLE IF NOT EXISTS public.message_attachment_private',
    'ALTER TABLE public.message_attachment_private ENABLE ROW LEVEL SECURITY',
    'REVOKE ALL ON TABLE public.message_attachment_private FROM PUBLIC, anon, authenticated',
    'INSERT INTO public.message_attachment_private',
    'FOR UPDATE',
    "GRANT EXECUTE ON FUNCTION public.agent_send_attachment_tx",
]:
    assert marker in attachment_sql, f"attachment SQL missing: {marker}"
assert 'DROP FUNCTION IF EXISTS public.agent_send_attachment_tx' in attachment_rollback
assert 'DROP TABLE IF EXISTS public.message_attachment_private' in attachment_rollback

# Final status is reachable only after activation and whole-product smoke.
assert final_gate.index('bash scripts/w3-task3-3-production-activate.sh') < \
       final_gate.index('bash scripts/w3-task3-3-whole-product-smoke.sh') < \
       final_gate.index('W3 TASK 3.3 FINAL STATUS: READY')
assert 'production health-check' in smoke
assert 'runtime function reachable' in smoke
assert 'attachment private-locator and tenant boundary' in smoke
assert 'w3-task3-3-consolidated-closure-contract.py' in smoke

print('PASS Task 3.3 current-scope consolidated closure contract')
