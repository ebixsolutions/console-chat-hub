#!/usr/bin/env bash
set -Eeuo pipefail

PROD="https://console-chat-hub.lovable.app"
TARGET_REF="nrfxhqabwblzxoushgnm"
TARGET="https://${TARGET_REF}.supabase.co"
FUNCTIONS="${TARGET}/functions/v1"
CHANNEL="b0000000-0000-0000-0000-000000000001"
ORIGIN="$PROD"

fail(){ echo "FAIL: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }

PUB="$(sed -n 's/^VITE_SUPABASE_PUBLISHABLE_KEY="\(.*\)"/\1/p' .env)"
[[ -n "$PUB" ]] || fail "missing publishable key"

for path in / /login /feedback; do
  code="$(curl -L -sS -o /tmp/page -w '%{http_code}' --max-time 20 "${PROD}${path}")"
  [[ "$code" =~ ^(200|302|307|308)$ ]] || fail "production route ${path} HTTP ${code}"
done
pass "production root/login/feedback reachable"

html="$(curl -L -sS --max-time 20 "$PROD/")"
[[ "$html" != *"hvmtoqiwdqvgnjepxwrc"* ]] || fail "legacy Supabase ref leaked in production HTML"
pass "production HTML legacy-ref scan"

health="$(curl -sS -o /tmp/auth-health -w '%{http_code}' --max-time 15 -H "apikey: ${PUB}" "${TARGET}/auth/v1/health")"
[[ "$health" == "200" ]] || fail "target auth health HTTP ${health}"
pass "target auth health"

create_payload="$(printf '{"channel_id":"%s","visitor_fingerprint":"task3-3-prod-smoke","visitor_metadata":{"task33_production_smoke":true,"exclude_training":true}}' "$CHANNEL")"
create="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "$create_payload" "${FUNCTIONS}/create-visitor-session")"
node -e 'const x=JSON.parse(process.argv[1]); if(!x.success||!x.data?.session_token||!x.data?.conversation_id)process.exit(1)' "$create" || fail "create visitor session response invalid"
session="$(node -e 'console.log(JSON.parse(process.argv[1]).data.session_token)' "$create")"
conversation="$(node -e 'console.log(JSON.parse(process.argv[1]).data.conversation_id)' "$create")"
echo "TASK33_SMOKE_CONVERSATION_ID=${conversation}"
pass "production-origin widget session creation"

msgid="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
noise="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${conversation}\",\"session_token\":\"${session}\",\"content\":\"...\",\"client_message_id\":\"${msgid}\"}" "${FUNCTIONS}/receive-widget-message")"
node -e 'const x=JSON.parse(process.argv[1]); if(!x.success||x.data?.ai_reply_pending!==false||x.data?.response_route!=="conversational_clarification")process.exit(1)' "$noise" || fail "deterministic clarification route failed"
pass "Widget receive-message + deterministic AI clarification"

poll="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${conversation}\",\"session_token\":\"${session}\"}" "${FUNCTIONS}/widget-poll-messages")"
node -e 'const x=JSON.parse(process.argv[1]); const m=x.data?.messages||[]; if(!x.success||!m.some(v=>v.role==="visitor")||!m.some(v=>v.role==="assistant"))process.exit(1)' "$poll" || fail "widget poll did not return visitor+assistant"
pass "Widget poll/messages"

msgid2="$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)"
normal="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${conversation}\",\"session_token\":\"${session}\",\"content\":\"What is your return policy?\",\"client_message_id\":\"${msgid2}\"}" "${FUNCTIONS}/receive-widget-message")"
node -e 'const x=JSON.parse(process.argv[1]); if(!x.success||!x.data?.message_id)process.exit(1)' "$normal" || fail "normal widget message rejected"
pass "normal Widget message accepted"

llm_ok=0
for i in $(seq 1 12); do
  sleep 5
  p="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${conversation}\",\"session_token\":\"${session}\"}" "${FUNCTIONS}/widget-poll-messages")"
  if node -e 'const x=JSON.parse(process.argv[1]); const m=x.data?.messages||[]; const assistants=m.filter(v=>v.role==="assistant"); if(assistants.length<2||x.data?.ai_generating)process.exit(1)' "$p"; then llm_ok=1; break; fi
done
[[ "$llm_ok" == "1" ]] || fail "credential-dependent KB/LLM reply did not complete"
pass "Singapore KB + governed LLM runtime response"

echo "TASK 3.3 PRODUCTION CUTOVER FINAL GATE: PASS"