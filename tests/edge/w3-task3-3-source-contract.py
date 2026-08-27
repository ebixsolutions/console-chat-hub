#!/usr/bin/env python3
from pathlib import Path
import sys

r=Path(sys.argv[1] if len(sys.argv)>1 else '.')
a=(r/'scripts/w3-task3-3-production-activate.sh').read_text()
s=(r/'scripts/w3-task3-3-whole-product-smoke.sh').read_text()
f=(r/'scripts/w3-task3-3-final-gate.sh').read_text()
w12=(r/'scripts/w1-task1-2-kb-contract-final-gate.sh').read_text()
t23=(r/'scripts/w2-task2-3-learning-loop-runtime-smoke.sh').read_text()

for marker in [
    'w2-task2-1-final-gate.sh',
    'w2-task2-2-final-gate.sh',
    'w2-task2-3-final-gate.sh',
    'w1-task1-2-kb-contract-final-gate.sh',
    'w1-task1-3-final-gate.sh',
    'w3-task3-2-security-final-gate.sh',
]:
    assert marker in a

assert 'W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED' in a
assert 'source scripts/w3-task3-3-runtime-inputs-load.sh' in a
assert 'explicit final production activation authorization missing' in a

assert 'PR7_CANONICAL_COMPANY_UUID="${W2_T2_1_CANONICAL_COMPANY_UUID}"' in a
assert 'PR9_KB_SMOKE_QUERY="${PR10_KB_TENANT_A_QUERY}"' in a
assert 'SUPABASE_URL="${SUPABASE_URL:-https://${W3_T3_3_PROJECT_REF}.supabase.co}"' in a
assert 'W1_SMOKE_USER_JWT="${PR10_TENANT_A_BEARER_TOKEN}"' in a
assert 'W1_SMOKE_AGENT_PROFILE_ID="${PR10_TENANT_A_AGENT_PROFILE_UUID}"' in a

t21=a.index('bash scripts/w2-task2-1-final-gate.sh')
t22=a.index('bash scripts/w2-task2-2-final-gate.sh')
tb=a.index('bash scripts/w3-task3-2-dev-tenant-b-fixture-bootstrap.sh')
tco=a.index('bash scripts/w2-task2-1-two-tenant-identity-runtime-gate.sh')
t23i=a.index('bash scripts/w2-task2-3-final-gate.sh')
proof=a.index('export W1_T1_2_WRITE_PROOF_CONFIRMED=YES')
t12=a.index('bash scripts/w1-task1-2-kb-contract-final-gate.sh')
t13=a.index('bash scripts/w1-task1-3-final-gate.sh')
t32=a.index('bash scripts/w3-task3-2-security-final-gate.sh')
assert t21 < t22 < tb < tco < t23i < proof < t12 < t13 < t32

assert 'export W2_T2_3_REQUIRE_KB_WRITE=YES' in a
assert 'W2_T2_3_REQUIRE_KB_WRITE' in t23
assert 'decision=trained; governed KB write path was not proven' in t23
assert 'decision=trained did not include kb_update' in t23
assert 'rag_new_content_verified' in t23
assert 'W1_T1_2_WRITE_PROOF_CONFIRMED' in w12
assert 'bash scripts/w2-task2-3-learning-loop-runtime-smoke.sh' not in w12

assert 'accepted) REVIEW_ACTION="resume"' in t23
assert 'if [ "$DSTATUS" != "delivered" ]; then' in t23
assert 'rejected|reopened) stop' in t23

assert 'source "$ROOT/config/w3-task3-3-dev-identity.env"' in f
assert 'source "$ROOT/scripts/w3-task3-3-runtime-inputs-load.sh"' in f
load=f.index('source "$ROOT/scripts/w3-task3-3-runtime-inputs-load.sh"')
activate=f.index('bash scripts/w3-task3-3-production-activate.sh')
smoke=f.index('bash scripts/w3-task3-3-whole-product-smoke.sh')
ready=f.index('echo "W3 TASK 3.3 FINAL STATUS: READY"')
assert load < activate < smoke < ready

assert 'npx supabase functions list' not in s
assert 'SUPABASE_ACCESS_TOKEN missing' not in s
assert 'SUPABASE_ACCESS_TOKEN is ignored' in s
assert 'SUPABASE_SERVICE_ROLE_KEY' not in a

assert 'health-check' in s
for fn in [
    'generate-reply','conversation-evaluate','training-outbox-worker',
    'training-result-receiver','training-kb-sync','training-kb-finalize',
    'widget-live-ai-test'
]:
    assert fn in s
assert 'product-ready-t2-3-write-proof-chain-contract.py' in s
assert 'w3-task3-3-consolidated-closure-contract.py' in s

print('PASS W3 Task3.3 comprehensive Product-ready source contract')
