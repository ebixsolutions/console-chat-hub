#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
a=(r/"scripts/w2-task2-3-learning-loop-activate.sh").read_text()
f=(r/"scripts/w2-task2-3-final-gate.sh").read_text()
g=(r/"scripts/w2-task2-3-lovable-native-deploy-gate.sh").read_text()
for marker in ["training-outbox-worker","training-result-receiver","training-kb-sync","training-kb-finalize"]: assert marker in a
assert "Task 2.2 canonical CE activation is not complete" in a
assert "SUPABASE_ACCESS_TOKEN" not in a
assert "npx supabase" not in a
assert "LOVABLE_NATIVE_DEPLOY_REQUIRED" in a
assert "W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED" in g
x=f.index("bash scripts/w2-task2-3-learning-loop-activate.sh")
y=f.index("bash scripts/w2-task2-3-lovable-native-deploy-gate.sh")
z=f.index("bash scripts/w2-task2-3-learning-loop-runtime-smoke.sh")
assert x < y < z
print("PASS W2 Task 2.3 Lovable-native Supabase source contract")
