#!/usr/bin/env python3
from pathlib import Path
import sys
r=Path(sys.argv[1] if len(sys.argv)>1 else ".")
a=(r/"scripts/w3-task3-3-production-activate.sh").read_text()
l=(r/"scripts/w3-task3-3-runtime-inputs-load.sh").read_text()
s=(r/"scripts/w3-task3-3-runtime-inputs-setup.command").read_text()
assert "source scripts/w3-task3-3-runtime-inputs-load.sh" in a
assert a.index("source scripts/w3-task3-3-runtime-inputs-load.sh") < a.index("bash scripts/w2-task2-1-final-gate.sh")
for n in ["SUPABASE_DB_URL","SUPABASE_ACCESS_TOKEN","PR10_TENANT_A_BEARER_TOKEN","PR10_TENANT_B_BEARER_TOKEN","KB_SINGAPORE_TENANT_MAP_JSON","KB_SINGAPORE_TENANT_API_KEYS_JSON","TRAINING_OUTBOX_INTERNAL_TOKEN","SU_COACHAI_EVALUATION_ENDPOINT","SU_COACHAI_AUTH_HEADER","SU_COACHAI_AUTH_VALUE","SU_COACHAI_RESULT_TOKEN","TRAINING_KB_SYNC_INTERNAL_TOKEN"]:
    assert n in l and n in s
assert "permissions must be 600 or 400" in l
assert "os.chmod(p,0o600)" in s
print("PASS W3 Task 3.3 runtime input bridge source contract")
