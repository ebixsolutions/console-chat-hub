#!/bin/bash
set -Eeuo pipefail
PROJECT_REF="${W3_T3_3_PROJECT_REF:-}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
ACCESS="${SUPABASE_ACCESS_TOKEN:-}"
APP_URL="${W3_T3_3_APP_URL:-https://console-chat-hub.lovable.app}"
FUNCTIONS="https://${EXPECTED_REF}.supabase.co/functions/v1"
stop(){ echo "STOP: $1" >&2; exit 2; }
fail(){ echo "FAIL: $1" >&2; exit 1; }
pass(){ echo "PASS $1"; }
[ "$PROJECT_REF" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ -n "$ACCESS" ] || stop "SUPABASE_ACCESS_TOKEN missing"
command -v curl >/dev/null 2>&1 || stop "curl missing"
command -v npx >/dev/null 2>&1 || stop "npx missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

export SUPABASE_ACCESS_TOKEN="$ACCESS"
REQUIRED=(
 get-public-widget-config create-visitor-session receive-widget-message widget-poll-messages
 generate-reply health-check submit-feedback-response deliver-feedback-request agent-send-reply
 assign-conversation take-over-conversation transfer-conversation return-to-ai resolve-conversation
 mark-unresolved recall-message kb-search-proxy visitor-analytics agent-assist agent-management
 conversation-evaluate customer360-local customer360-adapter customer360-coach-sync
 training-outbox-worker training-result-receiver training-kb-sync training-kb-finalize widget-live-ai-test
)
LIST="$(npx supabase functions list --project-ref "$PROJECT_REF" 2>&1)" || fail "function inventory query failed"
for fn in "${REQUIRED[@]}"; do printf '%s
' "$LIST" | grep -Fq "$fn" || fail "deployed function missing: $fn"; done
pass "complete production Edge inventory"

BODY="$(curl --fail --silent --show-error --max-time 20 "$FUNCTIONS/health-check")" || fail "health-check unreachable"
printf '%s' "$BODY" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d.get("ok") is True and d.get("source")=="health-check"' || fail "health-check contract mismatch"
pass "production health-check"

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
HTTP="$(curl --silent --show-error --max-time 20 -L -o "$TMP" -w '%{http_code}' "$APP_URL/")"
[ "$HTTP" = 200 ] || fail "production app HTTP $HTTP"
grep -Eqi '<html|id="root"|id='"'"'root'"'"'' "$TMP" || fail "production app shell invalid"
pass "production app shell"

bash scripts/w3-task3-1-product-surface-final-gate.sh "$(pwd)"
pass "product surface remains mock-free"

echo "W3 TASK 3.3 WHOLE-PRODUCT SMOKE STATUS: PASS"
