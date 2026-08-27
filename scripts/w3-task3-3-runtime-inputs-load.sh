#!/bin/bash
set -Eeuo pipefail
RUNTIME_FILE="${W3_T3_3_RUNTIME_INPUT_FILE:-$HOME/.config/ebixpro/ai-chatbot/w3-task3-3-runtime.env}"
stop(){ echo "STOP: $1" >&2; exit 2; }
[ -s "$RUNTIME_FILE" ] || stop "runtime input file missing: $RUNTIME_FILE"
MODE="$(stat -f '%Lp' "$RUNTIME_FILE" 2>/dev/null || stat -c '%a' "$RUNTIME_FILE" 2>/dev/null || true)"
case "$MODE" in 600|400) ;; *) stop "runtime input file permissions must be 600 or 400 (actual: $MODE)";; esac
source "$RUNTIME_FILE"
required=(SUPABASE_DB_URL PR10_TENANT_A_BEARER_TOKEN PR10_TENANT_B_BEARER_TOKEN PR10_KB_TENANT_A_QUERY PR10_KB_TENANT_B_QUERY PR10_KB_TENANT_A_EXPECTED_DOCUMENT_ID PR10_KB_TENANT_B_EXPECTED_DOCUMENT_ID KB_SINGAPORE_TENANT_MAP_JSON KB_SINGAPORE_TENANT_API_KEYS_JSON TRAINING_OUTBOX_INTERNAL_TOKEN SU_COACHAI_EVALUATION_ENDPOINT SU_COACHAI_AUTH_HEADER SU_COACHAI_AUTH_VALUE SU_COACHAI_RESULT_TOKEN TRAINING_KB_SYNC_INTERNAL_TOKEN)
for name in "${required[@]}"; do [ -n "${!name:-}" ] || stop "runtime input missing: $name"; done
python3 - <<'PY'
import json,os
m=json.loads(os.environ["KB_SINGAPORE_TENANT_MAP_JSON"]); k=json.loads(os.environ["KB_SINGAPORE_TENANT_API_KEYS_JSON"])
assert isinstance(m,dict) and isinstance(k,dict)
for c in (os.environ["PR10_TENANT_A_COMPANY_UUID"],os.environ["PR10_TENANT_B_COMPANY_UUID"]):
    v=str(m[c]); assert v.isdigit() and int(v)>0; assert len(k[v].strip())>=16
print("PASS Singapore mapping/API-key structure")
PY
echo "PASS W3 Task 3.3 runtime input bridge"
