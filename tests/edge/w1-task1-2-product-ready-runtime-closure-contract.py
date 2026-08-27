#!/usr/bin/env python3
from pathlib import Path
import sys

root=Path(sys.argv[1] if len(sys.argv)>1 else ".")
g=(root/"scripts/w1-task1-2-kb-contract-final-gate.sh").read_text()

assert "product-ready-learning-approval-guard-contract.py" in g
assert "product-ready-learning-rag-readback-integrity-contract.py" in g
assert "W1_T1_2_RUN_PRODUCTION" in g
assert "pr9-singapore-kb-authenticated-runtime-smoke.sh" in g
assert "W1_T1_2_WRITE_PROOF_CONFIRMED" in g
assert "kb_update_not_verified_approved" in g
assert "rag_new_content_verified: true" in g
assert "W1 TASK 1.2 FINAL STATUS: READY" in g

# W1 1.2 proves authenticated READ itself and consumes the immediately preceding
# machine-gated Task2.3 WRITE proof. It must not replay the same learning artifact.
r=g.index("bash scripts/pr9-singapore-kb-authenticated-runtime-smoke.sh")
proof=g.index('W1_T1_2_WRITE_PROOF_CONFIRMED')
ready=g.index('echo "W1 TASK 1.2 FINAL STATUS: READY"')
assert r < proof < ready
assert "bash scripts/w2-task2-3-learning-loop-runtime-smoke.sh" not in g

# Source-only execution is not READY.
stop=g.index("authenticated read + real write/read-back runtime proof still required")
assert stop < r

print("PASS W1 Task1.2 Product-ready runtime closure source contract")
