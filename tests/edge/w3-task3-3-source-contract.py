#!/usr/bin/env python3
from pathlib import Path
import sys

r=Path(sys.argv[1] if len(sys.argv)>1 else '.')
a=(r/'scripts/w3-task3-3-production-activate.sh').read_text()
s=(r/'scripts/w3-task3-3-whole-product-smoke.sh').read_text()
f=(r/'scripts/w3-task3-3-final-gate.sh').read_text()

for marker in [
    'w2-task2-1-final-gate.sh',
    'w2-task2-2-final-gate.sh',
    'w2-task2-3-final-gate.sh',
    'w1-task1-2-kb-contract-final-gate.sh',
    'w1-task1-3-final-gate.sh',
    'w3-task3-2-security-final-gate.sh',
]:
    assert marker in a

assert 'explicit final production activation authorization missing' in a
assert 'npm run build' in a
assert 'W3_T3_2_RUN_PRODUCTION=true' in a

assert 'PR7_CANONICAL_COMPANY_UUID="${W2_T2_1_CANONICAL_COMPANY_UUID}"' in a
assert 'PR9_KB_SMOKE_QUERY="${PR10_KB_TENANT_A_QUERY}"' in a
assert 'W1_SMOKE_USER_JWT="${PR10_TENANT_A_BEARER_TOKEN}"' in a
assert 'W1_KB_SMOKE_QUERY="${PR10_KB_TENANT_A_QUERY}"' in a
assert 'W1_SMOKE_AGENT_PROFILE_ID="${PR10_TENANT_A_AGENT_PROFILE_UUID}"' in a
assert 'W1_NO_CONTEXT_QUERY=' in a
assert 'W1_NO_CONTEXT_QUERY_ALT=' in a

t21=a.index('bash scripts/w2-task2-1-final-gate.sh')
t22=a.index('bash scripts/w2-task2-2-final-gate.sh')
tb=a.index('bash scripts/w3-task3-2-dev-tenant-b-fixture-bootstrap.sh')
t23=a.index('bash scripts/w2-task2-3-final-gate.sh')
t12=a.index('bash scripts/w1-task1-2-kb-contract-final-gate.sh')
t13=a.index('bash scripts/w1-task1-3-final-gate.sh')
assert t21 < t22 < tb < t23 < t12 < t13

assert 'w1-task1-2-kb-contract-final-gate.sh' in f
assert 'w1-task1-3-final-gate.sh' in f

assert 'npx supabase functions list' not in s
assert 'SUPABASE_ACCESS_TOKEN missing' not in s
assert 'SUPABASE_ACCESS_TOKEN is ignored' in s
assert 'W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED' in s

assert 'health-check' in s
for fn in [
    'generate-reply',
    'conversation-evaluate',
    'training-outbox-worker',
    'training-result-receiver',
    'training-kb-sync',
    'training-kb-finalize',
    'widget-live-ai-test',
]:
    assert fn in s
assert 'runtime function reachable' in s
assert '404|000' in s

assert 'w3-task3-1-product-surface-final-gate.sh' in s
assert 'w1-task1-2-product-ready-runtime-closure-contract.py' in s
assert 'w1-task1-3-runtime-source-contract.py' in s
assert 'w2-task2-3-source-contract.py' in s

# Critical parent-shell environment bridge. Without this, production-activate
# can PASS in a child shell and whole-product-smoke immediately STOP because
# W3_T3_3_PROJECT_REF / deployment confirmation do not propagate back.
assert 'source "$ROOT/config/w3-task3-3-dev-identity.env"' in f
assert 'source "$ROOT/scripts/w3-task3-3-runtime-inputs-load.sh"' in f
assert 'final-gate project ref mismatch' in f
assert 'final-gate Lovable-native deployment confirmation missing' in f

load=f.index('source "$ROOT/scripts/w3-task3-3-runtime-inputs-load.sh"')
activate=f.index('bash scripts/w3-task3-3-production-activate.sh')
smoke=f.index('bash scripts/w3-task3-3-whole-product-smoke.sh')
ready=f.index('echo "W3 TASK 3.3 FINAL STATUS: READY"')
assert load < activate < smoke < ready

print('PASS W3 Task 3.3 final-gate parent-shell environment bridge contract')
