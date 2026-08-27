#!/bin/bash
set -Eeuo pipefail

PROJECT_REF="${W3_T3_3_PROJECT_REF:-}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
APP_URL="${W3_T3_3_APP_URL:-https://console-chat-hub.lovable.app}"
FUNCTIONS="https://${EXPECTED_REF}.supabase.co/functions/v1"
CONFIRMED="${W2_T2_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED:-}"

stop(){ echo "STOP: $1" >&2; exit 2; }
fail(){ echo "FAIL: $1" >&2; exit 1; }
pass(){ echo "PASS $1"; }

[ "$PROJECT_REF" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ "$CONFIRMED" = "YES" ] || stop "Lovable-native Supabase Edge deployment not confirmed"
command -v curl >/dev/null 2>&1 || stop "curl missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

# Product-ready architecture intentionally does not require a user Supabase
# Management PAT. Deployment is Lovable-native; runtime proof is by real
# endpoint behavior and the preceding W1/W2 runtime gates.
[ -z "${SUPABASE_ACCESS_TOKEN:-}" ] || \
  echo "INFO SUPABASE_ACCESS_TOKEN is ignored by whole-product smoke"

# Critical source inventory must exist in the authoritative repo. This protects
# against accidental package/source loss without pretending source presence is
# a runtime deployment proof.
REQUIRED_SOURCE=(
  get-public-widget-config create-visitor-session receive-widget-message widget-poll-messages
  generate-reply health-check submit-feedback-response deliver-feedback-request agent-send-reply
  assign-conversation take-over-conversation transfer-conversation return-to-ai resolve-conversation
  mark-unresolved recall-message kb-search-proxy visitor-analytics agent-assist agent-management
  conversation-evaluate customer360-local customer360-adapter customer360-coach-sync
  training-outbox-worker training-result-receiver training-kb-sync training-kb-finalize widget-live-ai-test
)
for fn in "${REQUIRED_SOURCE[@]}"; do
  test -s "supabase/functions/$fn/index.ts" || fail "required Edge source missing/empty: $fn"
done
pass "complete required Edge source inventory"

# Runtime reachability: health-check must execute successfully in the linked
# Lovable-managed Supabase project.
BODY="$(curl --fail --silent --show-error --max-time 20 "$FUNCTIONS/health-check")" \
  || fail "health-check unreachable"
printf '%s' "$BODY" | python3 -c \
  'import json,sys;d=json.load(sys.stdin);assert d.get("ok") is True and d.get("source")=="health-check"' \
  || fail "health-check contract mismatch"
pass "production health-check"

# Critical runtime function presence without a Management PAT.
# We intentionally send an unauthenticated request and require a non-404 HTTP
# response. 401/403/405 proves the deployed function exists while preserving its
# own auth/method guard. 2xx is also accepted where OPTIONS/GET is public.
probe_function(){
  local fn="$1"
  local tmp code
  tmp="$(mktemp)"
  code="$(curl --silent --show-error --max-time 20 -o "$tmp" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' --data '{}' "$FUNCTIONS/$fn" || true)"
  rm -f "$tmp"
  case "$code" in
    200|201|202|204|400|401|403|405|409|422) pass "runtime function reachable: $fn" ;;
    404|000|"") fail "runtime function missing/unreachable: $fn (HTTP ${code:-000})" ;;
    *) fail "runtime function unexpected HTTP $code: $fn" ;;
  esac
}

for fn in \
  generate-reply \
  conversation-evaluate \
  training-outbox-worker \
  training-result-receiver \
  training-kb-sync \
  training-kb-finalize \
  widget-live-ai-test
do
  probe_function "$fn"
done

# App shell runtime.
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
HTTP="$(curl --silent --show-error --max-time 20 -L -o "$TMP" -w '%{http_code}' "$APP_URL/")"
[ "$HTTP" = 200 ] || fail "production app HTTP $HTTP"
grep -Eqi '<html|id="root"|id='"'"'root'"'"'' "$TMP" || fail "production app shell invalid"
pass "production app shell"

# Product surface and product-ready source guards remain mandatory.
bash scripts/w3-task3-1-product-surface-final-gate.sh "$(pwd)"
python3 tests/edge/w1-task1-2-product-ready-runtime-closure-contract.py "$(pwd)"
python3 tests/edge/w1-task1-3-runtime-source-contract.py "$(pwd)"
python3 tests/edge/w2-task2-3-source-contract.py "$(pwd)"
python3 tests/edge/product-ready-t2-3-write-proof-chain-contract.py "$(pwd)"
python3 tests/edge/w3-task3-3-consolidated-closure-contract.py "$(pwd)"
pass "product-ready source/runtime contracts remain locked"

echo "W3 TASK 3.3 WHOLE-PRODUCT SMOKE STATUS: PASS"
