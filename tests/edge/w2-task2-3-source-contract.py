#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
def rd(p): return (r/p).read_text(encoding="utf-8")
a=rd("scripts/w2-task2-3-learning-loop-activate.sh")
s=rd("scripts/w2-task2-3-learning-loop-runtime-smoke.sh")
for marker in ["training-outbox-worker","training-result-receiver","training-kb-sync","training-kb-finalize"]:
    assert marker in a
assert "Task 2.2 canonical CE activation is not complete" in a
assert "SU_COACHAI_EVALUATION_ENDPOINT" in a
assert "SU_COACHAI_RESULT_TOKEN" in a
assert "KB_SINGAPORE_TENANT_API_KEYS_JSON" in a
assert "pr6b_training_result_ingest.sql" in a
assert "pr6b_singapore_kb_sync_state.sql" in a
assert "pr6b_singapore_kb_finalize.sql" in a
assert 'decision\\":\\\"accept' in s
assert "delivery idempotency key mismatch" in s
assert "SU CoachAI -> AI Chatbot result received exactly once" in s
assert "training-kb-sync" in s and "training-kb-finalize" in s
assert "published" in s and "synced" in s
print("PASS W2 Task 2.3 source contract")
