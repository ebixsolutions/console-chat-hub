#!/usr/bin/env python3
from pathlib import Path
import sys

r=Path(sys.argv[1] if len(sys.argv)>1 else '.')
a=(r/'scripts/w3-task3-3-production-activate.sh').read_text()
f=(r/'scripts/w3-task3-3-final-gate.sh').read_text()
s=(r/'scripts/w3-task3-3-whole-product-smoke.sh').read_text()
t23=(r/'scripts/w2-task2-3-learning-loop-runtime-smoke.sh').read_text()
w12=(r/'scripts/w1-task1-2-kb-contract-final-gate.sh').read_text()
w12c=(r/'tests/edge/w1-task1-2-product-ready-runtime-closure-contract.py').read_text()
chain=(r/'tests/edge/product-ready-t2-3-write-proof-chain-contract.py').read_text()

required_in_activation=[
    'W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED',
    'SUPABASE_URL="${SUPABASE_URL:-https://${W3_T3_3_PROJECT_REF}.supabase.co}"',
    'PR8_CE_SMOKE_CONVERSATION_ID="${PR10_TENANT_A_CONVERSATION_UUID}"',
    'w2-task2-1-two-tenant-identity-runtime-gate.sh',
    'W2_T2_3_FIXTURE_APPROVED=YES',
    'W2_T2_3_REQUIRE_KB_WRITE=YES',
    'W2_T2_3_CONVERSATION_ID="${PR10_TENANT_A_CONVERSATION_UUID}"',
    'unset W2_T2_3_EVALUATION_ID',
    'W1_T1_2_WRITE_PROOF_CONFIRMED=YES',
    'W1_T1_2_RUN_PRODUCTION=true',
    'W1_RUN_PRODUCTION_SMOKE=true',
]
for marker in required_in_activation:
    assert marker in a, marker

for marker in [
    'accepted) REVIEW_ACTION="resume"',
    'if [ "$DSTATUS" != "delivered" ]; then',
    'W2_T2_3_REQUIRE_KB_WRITE',
    'decision=trained did not include kb_update',
    'su_coachai_verified_correction',
    'rag_new_content_verified',
]:
    assert marker in t23, marker

assert 'W1_T1_2_WRITE_PROOF_CONFIRMED' in w12
assert 'bash scripts/w2-task2-3-learning-loop-runtime-smoke.sh' not in w12
assert 'W1_T1_2_WRITE_PROOF_CONFIRMED' in w12c
assert 'W2_T2_3_REQUIRE_KB_WRITE' in chain

assert f.index('bash scripts/w3-task3-3-production-activate.sh') < f.index('bash scripts/w3-task3-3-whole-product-smoke.sh') < f.index('W3 TASK 3.3 FINAL STATUS: READY')
assert 'production health-check' in s
assert 'runtime function reachable' in s
assert 'w3-task3-3-consolidated-closure-contract.py' in s

print('PASS Task3.3 consolidated no-regression closure contract')
