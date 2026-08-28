#!/bin/bash
set -Eeuo pipefail

PROJECT_REF="${W3_T3_3_PROJECT_REF:-}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
APP_URL="${W3_T3_3_APP_URL:-https://console-chat-hub.lovable.app}"
FUNCTIONS="https://${EXPECTED_REF}.supabase.co/functions/v1"
CONFIRMED="${W3_T3_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED:-}"
DEPLOYED_COMMIT="${W3_T3_3_DEPLOYED_COMMIT_SHA:-}"

stop(){ echo "STOP: $1" >&2; exit 2; }
fail(){ echo "FAIL: $1" >&2; exit 1; }
pass(){ echo "PASS $1"; }

[ "$PROJECT_REF" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ "$CONFIRMED" = "YES" ] || stop "Lovable-native Supabase Edge deployment not confirmed"
[[ "$DEPLOYED_COMMIT" =~ ^[0-9a-f]{40}$ ]] || stop "deployed commit SHA missing/invalid"
[ "$DEPLOYED_COMMIT" = "$(git rev-parse HEAD)" ] || stop "runtime deployment is not the current repo commit"
command -v curl >/dev/null 2>&1 || stop "curl missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"
[ -n "${SUPABASE_DB_URL:-}" ] || stop "SUPABASE_DB_URL missing"

# Critical AI Chatbot source inventory. SU CoachAI downstream training/learning
# is explicitly deferred and therefore is not a Task 3.3 Product-ready blocker.
REQUIRED_SOURCE=(
  get-public-widget-config create-visitor-session receive-widget-message widget-poll-messages
  generate-reply health-check submit-feedback-response deliver-feedback-request agent-send-reply
  assign-conversation take-over-conversation transfer-conversation return-to-ai resolve-conversation
  mark-unresolved recall-message kb-search-proxy visitor-analytics agent-assist agent-management
  conversation-evaluate customer360-local customer360-adapter customer360-coach-sync
  widget-live-ai-test
)
for fn in "${REQUIRED_SOURCE[@]}"; do
  test -s "supabase/functions/$fn/index.ts" || fail "required Edge source missing/empty: $fn"
done
pass "complete current AI Chatbot Edge source inventory"

BODY="$(curl --fail --silent --show-error --max-time 20 "$FUNCTIONS/health-check")" \
  || fail "health-check unreachable"
printf '%s' "$BODY" | python3 -c \
  'import json,sys;d=json.load(sys.stdin);assert d.get("ok") is True and d.get("source")=="health-check"' \
  || fail "health-check contract mismatch"
pass "production health-check"

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
  kb-search-proxy \
  agent-assist \
  widget-live-ai-test
do
  probe_function "$fn"
done

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
HTTP="$(curl --silent --show-error --max-time 20 -L -o "$TMP" -w '%{http_code}' "$APP_URL/")"
[ "$HTTP" = 200 ] || fail "production app HTTP $HTTP"
grep -Eqi '<html|id="root"|id='"'"'root'"'"'' "$TMP" || fail "production app shell invalid"
pass "production app shell"

# New attachment boundary: schema exists, browser roles cannot query private
# locators, message metadata contains no private path, and locator tenant binding
# cannot disagree with the owning conversation.
ATTACH_ASSERT="$(psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -Atc "
SELECT CASE WHEN to_regclass('public.message_attachment_private') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END;
SELECT CASE WHEN NOT has_table_privilege('authenticated','public.message_attachment_private','SELECT') THEN 'PASS' ELSE 'FAIL' END;
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM public.messages
  WHERE content_type IN ('image','video','file')
    AND (metadata ? 'storage_path' OR metadata ? 'storage_bucket')
) THEN 'PASS' ELSE 'FAIL' END;
SELECT CASE WHEN NOT EXISTS (
  SELECT 1
  FROM public.message_attachment_private l
  JOIN public.conversations c ON c.id=l.conversation_id
  WHERE c.company_id IS DISTINCT FROM l.company_id
) THEN 'PASS' ELSE 'FAIL' END;
")" || fail "attachment DB assertions could not execute"
printf '%s\n' "$ATTACH_ASSERT" | awk 'BEGIN{ok=1;n=0} {n++; if($0!="PASS")ok=0} END{exit (ok && n==4)?0:1}' \
  || fail "attachment privacy/tenant assertions failed"
pass "attachment private-locator and tenant boundary"

python3 tests/edge/w3-task3-3-consolidated-closure-contract.py "$(pwd)"
python3 tests/edge/task3-3-consolidated-product-ready-contract.py "$(pwd)"
pass "Task 3.3 current-scope contracts remain locked"

echo "W3 TASK 3.3 WHOLE-PRODUCT SMOKE STATUS: PASS"
