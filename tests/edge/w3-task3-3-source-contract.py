#!/usr/bin/env python3
"""Task 3.3 comprehensive Product-ready source contract.

Workflow 2 / Task 2.3 SU CoachAI downstream training is deferred. This contract
therefore validates only the current AI Chatbot-owned Task 3.3 closure path and
must never re-open frozen W1/W2 gates to manufacture a Product-ready PASS.
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

# Current final-gate ordering and explicit authorization boundary.
for marker in [
    'W3_T3_3_PRODUCTION_AUTHORIZED',
    'explicit final production activation authorization missing',
    'source scripts/w3-task3-3-runtime-inputs-load.sh',
    'W3_T3_3_DEPLOYED_COMMIT_SHA',
    'git rev-parse HEAD',
    'npm run build',
]:
    assert marker in a, f"activation missing current marker: {marker}"

# Rollback safety is explicit after PR30 apply; do not depend on ERR trap behavior
# through an OR-list or conditional pipeline.
for marker in [
    "trap 'rollback_pr30 $?' ERR",
    'rollback_pr30 1',
    'if ! psql "$SUPABASE_DB_URL"',
    'PR30 post-apply assertions failed',
    'ROLLBACK FAILURE: PR30 rollback command failed',
]:
    assert marker in a, f"activation rollback safety missing: {marker}"
assert '|| fail "PR30 post-apply assertions failed"' not in a, \
    "activation must not rely on OR-list ERR semantics for post-apply rollback"
assert a.index('PR30_APPLIED=true') < a.index('rollback_pr30 1'), \
    "explicit rollback must occur only after PR30 is marked applied"

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

# No deferred learning-loop or frozen final-gate dependency is allowed in the
# current Task 3.3 execution chain.
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

# Runtime bridge is current-project only and commit-bound.
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

# Current production smoke covers the live AI Chatbot critical source/runtime
# surface; authenticated behavior assertions are handled by Task 3.3 runtime
# fixtures only after deployment authorization.
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
    'metadata ? \'storage_path\'',
    'metadata ? \'storage_bucket\'',
    'w3-task3-3-consolidated-closure-contract.py',
    'task3-3-consolidated-product-ready-contract.py',
]:
    assert marker in s, f"whole-product smoke missing: {marker}"

# Attachment privacy migration is transactional, service-role-only, atomic and
# has a source rollback path.
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

print('PASS W3 Task3.3 comprehensive current-scope Product-ready source contract')
