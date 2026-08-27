#!/usr/bin/env python3
from pathlib import Path
import sys

r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
a=(r/"scripts/w2-task2-3-learning-loop-activate.sh").read_text()
f=(r/"scripts/w2-task2-3-final-gate.sh").read_text()
g=(r/"scripts/w2-task2-3-lovable-native-deploy-gate.sh").read_text()
smoke=(r/"scripts/w2-task2-3-learning-loop-runtime-smoke.sh").read_text()

for marker in [
    "training-outbox-worker",
    "training-result-receiver",
    "training-kb-sync",
    "training-kb-finalize",
]:
    assert marker in a

assert "Task 2.2 canonical CE activation is not complete" in a
assert "SUPABASE_ACCESS_TOKEN" not in a
assert "npx supabase" not in a
assert "LOVABLE_NATIVE_DEPLOY_REQUIRED" in a
assert "W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED" in g

# Final gate must enforce all Product-ready learning safety contracts before runtime.
assert "product-ready-learning-approval-guard-contract.py" in f
assert "product-ready-learning-rag-readback-integrity-contract.py" in f

x=f.index("bash scripts/w2-task2-3-learning-loop-activate.sh")
y=f.index("bash scripts/w2-task2-3-lovable-native-deploy-gate.sh")
z=f.index("bash scripts/w2-task2-3-learning-loop-runtime-smoke.sh")
assert x < y < z

# Runtime smoke must prove verified approval + newly trained RAG content.
assert "su_coachai_verified_correction" in smoke
assert "approved_by" in smoke
assert "approved_at" in smoke
assert "rag_new_content_verified" in smoke
assert "kb_rag_new_content_not_visible" in smoke
assert "DB published without rag_new_content_verified=true" in smoke

print("PASS W2 Task 2.3 Product-ready final-gate source contract")
