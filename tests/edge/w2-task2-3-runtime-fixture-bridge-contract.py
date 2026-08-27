#!/usr/bin/env python3
from pathlib import Path
import sys

r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
s=(r/"scripts/w2-task2-3-learning-loop-runtime-smoke.sh").read_text()
a=(r/"scripts/w3-task3-3-production-activate.sh").read_text()

# Runtime fixture can be deterministically discovered from the exact canonical
# Tenant A conversation produced/validated immediately beforehand by Task 2.2.
assert 'expected exactly one canonical evaluation for runtime fixture conversation' in s
assert 'canonical evaluation id auto-discovered from runtime fixture conversation' in s
assert 'unset W2_T2_3_EVALUATION_ID' in a
assert 'W2_T2_3_CONVERSATION_ID="${PR10_TENANT_A_CONVERSATION_UUID}"' in a
assert 'W2_T2_3_REVIEW_BEARER_TOKEN="${PR10_TENANT_A_BEARER_TOKEN}"' in a
assert 'W2_T2_3_FIXTURE_APPROVED=YES' in a

# Never silently reuse an already-reviewed artifact.
assert 'runtime fixture already accepted; use a fresh canonical evaluation' in s
assert 'fresh canonical CE training fixture' in s

# The full governed learning chain must still be required.
for marker in [
    'conversation-evaluate',
    'training-outbox-worker',
    'training-kb-sync',
    'training-kb-finalize',
    'su_coachai_verified_correction',
    'rag_new_content_verified',
]:
    assert marker in s

# Ordering: Task2.2 real CE runtime before Task2.3 reuse of its exact conversation.
ce=a.index('bash scripts/w2-task2-2-final-gate.sh')
learn=a.index('bash scripts/w2-task2-3-final-gate.sh')
assert ce < learn

print("PASS W2 Task2.3 runtime fixture bridge source contract")
