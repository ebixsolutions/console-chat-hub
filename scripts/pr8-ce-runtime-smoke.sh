#!/bin/bash
set -Eeuo pipefail

PROJECT_REF="${PR7_PROJECT_REF:-}"
EXPECTED_PROJECT_REF="hvmtoqiwdqvgnjepxwrc"
DB_URL="${SUPABASE_DB_URL:-}"
CONVERSATION_ID="${PR8_CE_SMOKE_CONVERSATION_ID:-}"
BEARER="${PR8_CE_SMOKE_BEARER_TOKEN:-}"
APPROVED="${PR8_CE_SMOKE_FIXTURE_APPROVED:-}"

stop(){ echo "STOP: $1"; exit 2; }
pass(){ echo "PASS $1"; }

[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "project ref mismatch"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ "$APPROVED" = "YES" ] || stop "CE smoke fixture approval missing"
[[ "$CONVERSATION_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "CE smoke conversation id invalid"
[ ${#BEARER} -ge 20 ] || stop "CE smoke bearer token missing/too short"
command -v psql >/dev/null 2>&1 || stop "psql missing"
command -v curl >/dev/null 2>&1 || stop "curl missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

# Fixture must already be canonically tenant-bound. Never create fake production identity/data here.
FIXTURE="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -AtF '|' -v cid="$CONVERSATION_ID" <<'SQL'
SELECT
  c.id::text,
  coalesce(c.company_id::text,''),
  coalesce(ch.company_id::text,''),
  coalesce((SELECT count(*) FROM public.messages m WHERE m.conversation_id=c.id),0),
  coalesce((SELECT count(*) FROM public.conversation_evaluation e WHERE e.conversation_id=c.id),0)
FROM public.conversations c
LEFT JOIN public.channel_config ch ON ch.id=c.channel_config_id
WHERE c.id=:'cid'::uuid;
SQL
)"
[ -n "$FIXTURE" ] || stop "CE smoke conversation not found"
IFS='|' read -r CID CONV_COMPANY CHANNEL_COMPANY MSG_COUNT BEFORE_EVAL_COUNT <<<"$FIXTURE"
[ -n "$CONV_COMPANY" ] || stop "CE smoke conversation company unresolved"
if [ -n "$CHANNEL_COMPANY" ] && [ "$CHANNEL_COMPANY" != "$CONV_COMPANY" ]; then
  stop "CE smoke conversation/channel tenant mismatch"
fi
[ "$MSG_COUNT" -gt 0 ] || stop "CE smoke conversation has no messages"
[ "$BEFORE_EVAL_COUNT" -le 1 ] || stop "CE smoke fixture already has multiple evaluations"
pass "approved CE fixture canonically tenant-bound"

ENDPOINT="https://${PROJECT_REF}.supabase.co/functions/v1/conversation-evaluate"
TMP1="$(mktemp)"; TMP2="$(mktemp)"
trap 'rm -f "$TMP1" "$TMP2"' EXIT

call_eval(){
  local out="$1"
  curl --silent --show-error --fail-with-body \
    --max-time 120 \
    -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $BEARER" \
    -H "Content-Type: application/json" \
    --data "{\"action\":\"evaluate\",\"conversation_id\":\"$CONVERSATION_ID\"}" \
    >"$out"
}

call_eval "$TMP1" || stop "first CE runtime call failed"
FIRST="$(python3 - "$TMP1" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: raise SystemExit(2)
status=d.get('status')
e=(d.get('evaluation') or {})
id=e.get('id')
if status not in ('completed','already_evaluated') or not isinstance(id,str): raise SystemExit(2)
print(status+'|'+id)
PY
)" || stop "first CE response invalid"
IFS='|' read -r FIRST_STATUS EVAL_ID <<<"$FIRST"
pass "first CE runtime call returned canonical evaluation"

# Verify one canonical evaluation artifact with full lineage and outbox integrity.
ROW="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVAL_ID" -v cid="$CONVERSATION_ID" <<'SQL'
SELECT
  e.id::text,
  e.conversation_id::text,
  e.company_id::text,
  a.company_id::text,
  s.company_id::text,
  s.redaction_applied::text,
  (SELECT count(*) FROM public.conversation_evaluation_detail d WHERE d.evaluation_id=e.id),
  (SELECT count(DISTINCT d.evaluator_type) FROM public.conversation_evaluation_detail d WHERE d.evaluation_id=e.id),
  (SELECT count(*) FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id),
  coalesce((SELECT o.company_id::text FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id LIMIT 1),''),
  coalesce((SELECT o.delivery_idempotency_key FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id LIMIT 1),'')
FROM public.conversation_evaluation e
JOIN public.conversation_evaluation_attempt a ON a.id=e.attempt_id
JOIN public.ce_bundle_snapshot s ON s.attempt_id=e.attempt_id
WHERE e.id=:'eid'::uuid AND e.conversation_id=:'cid'::uuid;
SQL
)"
[ -n "$ROW" ] || stop "canonical CE artifact read-back missing"
IFS='|' read -r RID RCID ECOMP ACOMP SCOMP REDACT DETAIL_COUNT DIM_COUNT OUTBOX_COUNT OCOMP IDEM <<<"$ROW"
[ "$RID" = "$EVAL_ID" ] || stop "evaluation id read-back mismatch"
[ "$RCID" = "$CONVERSATION_ID" ] || stop "evaluation conversation mismatch"
[ "$ECOMP" = "$CONV_COMPANY" ] || stop "evaluation company mismatch"
[ "$ACOMP" = "$CONV_COMPANY" ] || stop "attempt company mismatch"
[ "$SCOMP" = "$CONV_COMPANY" ] || stop "snapshot company mismatch"
[ "$REDACT" = "true" ] || stop "snapshot redaction flag not true"
[ "$DETAIL_COUNT" = "6" ] || stop "expected exactly 6 evaluator details"
[ "$DIM_COUNT" = "6" ] || stop "expected exactly 6 evaluator dimensions"
[ "$OUTBOX_COUNT" = "1" ] || stop "expected exactly one outbox row"
[ "$OCOMP" = "$CONV_COMPANY" ] || stop "outbox company mismatch"
[ "$IDEM" = "$EVAL_ID" ] || stop "outbox idempotency key must equal evaluation id"
pass "CE evaluation/attempt/snapshot/outbox tenant lineage"
pass "CE six evaluator details"
pass "CE snapshot redaction"
pass "CE exactly-one outbox + deterministic idempotency key"

# Replay the exact same conversation. No duplicate evaluation/outbox may be created.
call_eval "$TMP2" || stop "second CE replay call failed"
SECOND="$(python3 - "$TMP2" <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: raise SystemExit(2)
status=d.get('status'); e=(d.get('evaluation') or {}); i=e.get('id')
if status!='already_evaluated' or not isinstance(i,str): raise SystemExit(2)
print(status+'|'+i)
PY
)" || stop "second CE replay response invalid"
IFS='|' read -r SECOND_STATUS SECOND_EVAL_ID <<<"$SECOND"
[ "$SECOND_EVAL_ID" = "$EVAL_ID" ] || stop "CE replay returned different evaluation id"

AFTER="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -AtF '|' -v cid="$CONVERSATION_ID" -v eid="$EVAL_ID" <<'SQL'
SELECT
  (SELECT count(*) FROM public.conversation_evaluation e WHERE e.conversation_id=:'cid'::uuid),
  (SELECT count(*) FROM public.evaluation_training_outbox o WHERE o.evaluation_id=:'eid'::uuid);
SQL
)"
IFS='|' read -r AFTER_EVAL_COUNT AFTER_OUTBOX_COUNT <<<"$AFTER"
[ "$AFTER_EVAL_COUNT" = "1" ] || stop "CE replay created duplicate evaluation"
[ "$AFTER_OUTBOX_COUNT" = "1" ] || stop "CE replay created duplicate outbox"
pass "CE replay is idempotent"

# Do not invoke training worker here: transport acceptance is a separate external
# handoff runtime and must not consume the smoke artifact during CE creation proof.
echo "TASK 8.2 CE RUNTIME SMOKE STATUS: PASS"
