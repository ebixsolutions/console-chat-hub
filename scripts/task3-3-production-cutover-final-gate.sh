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
uuid(){ python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
}
create_session(){
  local fp="$1"
  local payload response
  payload="$(printf '{"channel_id":"%s","visitor_fingerprint":"%s","visitor_metadata":{"task33_production_smoke":true,"exclude_training":true}}' "$CHANNEL" "$fp")"
  response="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "$payload" "${FUNCTIONS}/create-visitor-session")"
  node -e 'const x=JSON.parse(process.argv[1]); if(!x.success||!x.data?.session_token||!x.data?.conversation_id)process.exit(1)' "$response" || fail "create visitor session response invalid"
  SESSION="$(node -e 'console.log(JSON.parse(process.argv[1]).data.session_token)' "$response")"
  CONVERSATION="$(node -e 'console.log(JSON.parse(process.argv[1]).data.conversation_id)' "$response")"
  echo "TASK33_SMOKE_CONVERSATION_ID=${CONVERSATION}"
}

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

# Flow A: production-origin Widget, deterministic clarification, attachment, explicit handoff.
create_session "task3-3-control-smoke"
session="$SESSION"; conversation="$CONVERSATION"
pass "production-origin widget session creation"

noise="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${conversation}\",\"session_token\":\"${session}\",\"content\":\"...\",\"client_message_id\":\"$(uuid)\"}" "${FUNCTIONS}/receive-widget-message")"
node -e 'const x=JSON.parse(process.argv[1]); if(!x.success||x.data?.ai_reply_pending!==false||x.data?.response_route!=="conversational_clarification")process.exit(1)' "$noise" || fail "deterministic clarification route failed"
pass "Widget receive-message + deterministic AI clarification"

poll="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${conversation}\",\"session_token\":\"${session}\"}" "${FUNCTIONS}/widget-poll-messages")"
node -e 'const x=JSON.parse(process.argv[1]); const m=x.data?.messages||[]; if(!x.success||!m.some(v=>v.role==="visitor")||!m.some(v=>v.role==="assistant"))process.exit(1)' "$poll" || fail "widget poll did not return visitor+assistant"
pass "Widget poll/messages"

printf 'Task 3.3 production attachment smoke\n' >/tmp/task33-attachment.txt
attachment="$(curl -sS --fail-with-body --max-time 25 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -F "conversation_id=${conversation}" -F "session_token=${session}" -F "client_message_id=$(uuid)" -F 'file=@/tmp/task33-attachment.txt;type=text/plain' "${FUNCTIONS}/receive-widget-message")"
node -e 'const x=JSON.parse(process.argv[1]); if(!x.success||x.data?.content_type!=="file"||!x.data?.message_id||x.data?.ai_reply_pending!==false)process.exit(1)' "$attachment" || fail "Widget attachment path failed"
pass "Widget attachment upload + private metadata transaction"

handoff="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${conversation}\",\"session_token\":\"${session}\",\"content\":\"I want a human agent now\",\"client_message_id\":\"$(uuid)\"}" "${FUNCTIONS}/receive-widget-message")"
node -e 'const x=JSON.parse(process.argv[1]); if(!x.success||!x.data?.message_id)process.exit(1)' "$handoff" || fail "explicit handoff request rejected"
handoff_ok=0
for i in $(seq 1 8); do
  sleep 2
  p="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${conversation}\",\"session_token\":\"${session}\"}" "${FUNCTIONS}/widget-poll-messages")"
  if node -e 'const x=JSON.parse(process.argv[1]); const m=x.data?.messages||[]; const handoff=m.some(v=>v.role==="assistant" && /human agent|support agent|真人|客服/i.test(String(v.content||""))); const state=["pending","transferred","human_needed","human_control"].includes(String(x.data?.conversation_status||"")); if(!x.success||!handoff||!state)process.exit(1)' "$p"; then handoff_ok=1; break; fi
done
[[ "$handoff_ok" == "1" ]] || fail "explicit R1 handoff did not persist"
pass "explicit AI-to-human handoff persistence + poll state"

# Flow B: separate session exercising a known published-KB semantic path.
# This checks the observed answer, not merely the existence of any assistant turn.
create_session "task3-3-kb-semantic-smoke"
session="$SESSION"; conversation="$CONVERSATION"
normal="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${conversation}\",\"session_token\":\"${session}\",\"content\":\"什么是四電一腦？\",\"client_message_id\":\"$(uuid)\"}" "${FUNCTIONS}/receive-widget-message")"
node -e 'const x=JSON.parse(process.argv[1]); if(!x.success||!x.data?.message_id)process.exit(1)' "$normal" || fail "published-KB semantic widget message rejected"
pass "published-KB semantic Widget message accepted"

kb_ok=0
for i in $(seq 1 12); do
  sleep 5
  p="$(curl -sS --fail-with-body --max-time 20 -H "apikey: ${PUB}" -H "Origin: ${ORIGIN}" -H 'Content-Type: application/json' --data "{\"conversation_id\":\"${conversation}\",\"session_token\":\"${session}\"}" "${FUNCTIONS}/widget-poll-messages")"
  if node -e 'const x=JSON.parse(process.argv[1]); const m=x.data?.messages||[]; const a=[...m].reverse().find(v=>v.role==="assistant"); const c=String(a?.content||""); const semantic=/(空調|冷氣|洗衣|雪櫃|冰箱|電視|電腦|打印機|印表機|掃描器|顯示器)/i.test(c); const generic=/(please add the most important detail|could you tell me what you.d like|clarify one detail)/i.test(c); if(!x.success||!a||x.data?.ai_generating||!semantic||generic)process.exit(1)' "$p"; then kb_ok=1; break; fi
done
[[ "$kb_ok" == "1" ]] || fail "published-KB semantic answer did not complete"
pass "published-KB semantic runtime answer"

echo "TASK 3.3 PRODUCTION CUTOVER FINAL GATE: PASS"
