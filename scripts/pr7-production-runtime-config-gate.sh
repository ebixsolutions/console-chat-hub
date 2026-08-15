#!/bin/bash
set -Eeuo pipefail

PROJECT_REF="${PR7_PROJECT_REF:-}"
EXPECTED_PROJECT_REF="hvmtoqiwdqvgnjepxwrc"
ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"

stop(){ echo "STOP: $1"; exit 2; }
pass(){ echo "PASS $1"; }

[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "project ref mismatch"
[ -n "$ACCESS_TOKEN" ] || stop "SUPABASE_ACCESS_TOKEN missing"
command -v npx >/dev/null 2>&1 || stop "npx missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

require_nonempty(){
  local n="$1" v="${!1:-}"
  [ -n "$v" ] || stop "$n missing"
  pass "$n configured"
}

require_minlen(){
  local n="$1" min="$2" v="${!1:-}"
  [ "${#v}" -ge "$min" ] || stop "$n too short"
  pass "$n length contract"
}

require_true(){
  local n="$1" v="${!1:-}"
  [ "$v" = "true" ] || stop "$n must be true for Product-ready activation"
  pass "$n=true"
}

require_https(){
  local n="$1" v="${!1:-}"
  python3 - "$n" "$v" <<'PY' || exit 2
import sys, urllib.parse
name,value=sys.argv[1],sys.argv[2]
try: u=urllib.parse.urlparse(value)
except Exception: raise SystemExit(1)
if u.scheme!="https" or not u.netloc:
    print(f"STOP: {name} must be absolute https URL")
    raise SystemExit(2)
print(f"PASS {name} https URL")
PY
}

# Required Product-ready feature activation.
require_true ENABLE_KB_ADAPTER
require_true ENABLE_CUSTOMER360_ADAPTER
require_true ENABLE_COACH_PROMPT_ADAPTER

# Core AI runtime.
require_nonempty ANTHROPIC_API_KEY
require_minlen ANTHROPIC_API_KEY 20

# Singapore KB.
require_nonempty KB_SINGAPORE_TENANT_MAP_JSON
require_nonempty KB_SINGAPORE_JWT_SECRET
require_minlen KB_SINGAPORE_JWT_SECRET 32
python3 - <<'PY' || exit 2
import os,json
raw=os.environ["KB_SINGAPORE_TENANT_MAP_JSON"]
try: obj=json.loads(raw)
except Exception:
    print("STOP: KB_SINGAPORE_TENANT_MAP_JSON invalid JSON"); raise SystemExit(2)
if not isinstance(obj,dict) or len(obj)!=1:
    print("STOP: KB_SINGAPORE_TENANT_MAP_JSON must contain exactly one current production mapping"); raise SystemExit(2)
k,v=next(iter(obj.items()))
if not isinstance(k,str) or not k.strip() or not isinstance(v,str) or not v.strip() or k.strip()==v.strip():
    print("STOP: Singapore KB mapping invalid"); raise SystemExit(2)
print("PASS Singapore KB production mapping shape")
ttl=os.environ.get("KB_SINGAPORE_JWT_TTL_SEC","300").strip()
try: n=int(ttl)
except Exception:
    print("STOP: KB_SINGAPORE_JWT_TTL_SEC invalid"); raise SystemExit(2)
if n<60 or n>900:
    print("STOP: KB_SINGAPORE_JWT_TTL_SEC must be 60..900"); raise SystemExit(2)
print("PASS Singapore KB JWT TTL")
PY

# Customer360.
require_nonempty CUSTOMER360_INTERNAL_TOKEN
require_minlen CUSTOMER360_INTERNAL_TOKEN 24
require_nonempty CUSTOMER360_API_URL
require_https CUSTOMER360_API_URL
require_nonempty CUSTOMER360_API_TOKEN
require_minlen CUSTOMER360_API_TOKEN 16

# SU CoachAI prompt adapter.
require_nonempty COACH_PROMPT_ENDPOINT
require_https COACH_PROMPT_ENDPOINT
require_nonempty COACH_PROMPT_INTERNAL_TOKEN
require_minlen COACH_PROMPT_INTERNAL_TOKEN 24

# Customer360 ↔ Coach sync.
require_nonempty C360_COACH_SYNC_INTERNAL_TOKEN
require_minlen C360_COACH_SYNC_INTERNAL_TOKEN 24
require_nonempty COACH_C360_SYNC_API_URL
require_https COACH_C360_SYNC_API_URL
require_nonempty COACH_C360_SYNC_API_TOKEN
require_minlen COACH_C360_SYNC_API_TOKEN 16
require_nonempty C360_COACH_SYNC_CONTRACT_VERSION

# Canonical Conversation Evaluation runtime.
require_nonempty CE_CONTRACT_VERSION
require_nonempty CE_SOURCE_DEPLOYMENT
require_nonempty LLM_MODEL_EVALUATION

# CE -> SU CoachAI training handoff runtime.
require_nonempty SU_COACHAI_EVALUATION_ENDPOINT
require_https SU_COACHAI_EVALUATION_ENDPOINT
require_nonempty SU_COACHAI_AUTH_HEADER
require_nonempty SU_COACHAI_AUTH_VALUE
require_minlen SU_COACHAI_AUTH_VALUE 16
require_nonempty TRAINING_OUTBOX_INTERNAL_TOKEN
require_minlen TRAINING_OUTBOX_INTERNAL_TOKEN 24
require_nonempty SU_COACHAI_RESULT_TOKEN
require_minlen SU_COACHAI_RESULT_TOKEN 24

# Production project must already contain every required Edge runtime variable
# before SQL/data mutation starts. This is read-only; values are never printed.
export SUPABASE_ACCESS_TOKEN="$ACCESS_TOKEN"
SECRET_LIST="$(npx supabase secrets list --project-ref "$PROJECT_REF" 2>/dev/null)" \
  || stop "unable to read production Edge secret inventory"

required_remote=(
  ANTHROPIC_API_KEY
  ENABLE_KB_ADAPTER
  ENABLE_CUSTOMER360_ADAPTER
  ENABLE_COACH_PROMPT_ADAPTER
  KB_SINGAPORE_TENANT_MAP_JSON
  KB_SINGAPORE_JWT_SECRET
  CUSTOMER360_INTERNAL_TOKEN
  CUSTOMER360_API_URL
  CUSTOMER360_API_TOKEN
  COACH_PROMPT_ENDPOINT
  COACH_PROMPT_INTERNAL_TOKEN
  C360_COACH_SYNC_INTERNAL_TOKEN
  COACH_C360_SYNC_API_URL
  COACH_C360_SYNC_API_TOKEN
  C360_COACH_SYNC_CONTRACT_VERSION
  CE_CONTRACT_VERSION
  CE_SOURCE_DEPLOYMENT
  LLM_MODEL_EVALUATION
  SU_COACHAI_EVALUATION_ENDPOINT
  SU_COACHAI_AUTH_HEADER
  SU_COACHAI_AUTH_VALUE
  TRAINING_OUTBOX_INTERNAL_TOKEN
  SU_COACHAI_RESULT_TOKEN
)

for n in "${required_remote[@]}"; do
  if printf '%s\n' "$SECRET_LIST" | awk '{print $1}' | grep -Fxq "$n"; then
    pass "production Edge runtime name present: $n"
  else
    stop "production Edge runtime name missing: $n"
  fi
done

# Optional remote TTL: if present locally as an override, require remote presence.
if [ -n "${KB_SINGAPORE_JWT_TTL_SEC:-}" ]; then
  printf '%s\n' "$SECRET_LIST" | awk '{print $1}' | grep -Fxq "KB_SINGAPORE_JWT_TTL_SEC" \
    || stop "production Edge runtime name missing: KB_SINGAPORE_JWT_TTL_SEC"
  pass "production Edge runtime name present: KB_SINGAPORE_JWT_TTL_SEC"
fi

echo "TASK 7.2 PRODUCTION RUNTIME CONFIG STATUS: PASS"
