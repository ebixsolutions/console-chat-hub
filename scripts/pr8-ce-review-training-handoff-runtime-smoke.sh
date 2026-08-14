#!/bin/bash
set -Eeuo pipefail

PROJECT_REF="${PR7_PROJECT_REF:-}"
EXPECTED_PROJECT_REF="hvmtoqiwdqvgnjepxwrc"
DB_URL="${SUPABASE_DB_URL:-}"
EVALUATION_ID="${PR8_CE_HANDOFF_EVALUATION_ID:-}"
CONVERSATION_ID="${PR8_CE_HANDOFF_CONVERSATION_ID:-}"
BEARER="${PR8_CE_HANDOFF_BEARER_TOKEN:-}"
APPROVED="${PR8_CE_HANDOFF_FIXTURE_APPROVED:-}"
WORKER_TOKEN="${TRAINING_OUTBOX_INTERNAL_TOKEN:-}"
POLL_SECONDS="${PR8_CE_HANDOFF_RESULT_WAIT_SECONDS:-120}"

stop(){ echo "STOP: $1"; exit 2; }
pass(){ echo "PASS $1"; }

[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "project ref mismatch"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ "$APPROVED" = "YES" ] || stop "CE training handoff fixture approval missing"
[[ "$EVALUATION_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "evaluation id invalid"
[[ "$CONVERSATION_ID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "conversation id invalid"
[ ${#BEARER} -ge 20 ] || stop "authenticated review bearer missing"
[ ${#WORKER_TOKEN} -ge 24 ] || stop "training outbox worker token missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"
command -v curl >/dev/null 2>&1 || stop "curl missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

PRE="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVALUATION_ID" -v cid="$CONVERSATION_ID" <<'SQL'
SELECT
  e.id::text,
  e.conversation_id::text,
  e.company_id::text,
  e.training_eligible::text,
  e.review_status::text,
  (SELECT count(*) FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id),
  coalesce((SELECT o.status FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id LIMIT 1),''),
  coalesce((SELECT o.delivery_idempotency_key FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id LIMIT 1),'')
FROM public.conversation_evaluation e
WHERE e.id=:'eid'::uuid AND e.conversation_id=:'cid'::uuid;
SQL
)"
[ -n "$PRE" ] || stop "approved CE handoff fixture not found"
IFS='|' read -r RID RCID COMPANY ELIGIBLE REVIEW OUTBOX_COUNT OUTBOX_STATUS IDEM <<<"$PRE"
[ "$ELIGIBLE" = "true" ] || stop "approved evaluation is not training_eligible"
[ "$OUTBOX_COUNT" = "1" ] || stop "expected exactly one canonical outbox before review"
[ "$IDEM" = "$EVALUATION_ID" ] || stop "outbox deterministic idempotency mismatch"
pass "approved training-eligible CE fixture"

ENDPOINT="https://${PROJECT_REF}.supabase.co/functions/v1/conversation-evaluate"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl --silent --show-error --fail-with-body \
  --max-time 60 \
  -X POST "$ENDPOINT" \
  -H "Authorization: Bearer $BEARER" \
  -H "Content-Type: application/json" \
  --data "{\"action\":\"review\",\"evaluation_id\":\"$EVALUATION_ID\",\"conversation_id\":\"$CONVERSATION_ID\",\"decision\":\"accept\"}" \
  >"$TMP" || stop "CE accept review call failed"

python3 - "$TMP" <<'PY' || exit 2
import json,sys
d=json.load(open(sys.argv[1]))
if d.get("status")!="reviewed" or d.get("to")!="accepted":
    print("STOP: review response not accepted")
    raise SystemExit(2)
print("PASS authenticated CE review accepted")
PY

POST_REVIEW="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVALUATION_ID" <<'SQL'
SELECT
  e.review_status::text,
  e.training_eligible::text,
  (SELECT count(*) FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id),
  coalesce((SELECT o.status FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id LIMIT 1),''),
  coalesce((SELECT o.company_id::text FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id LIMIT 1),'')
FROM public.conversation_evaluation e
WHERE e.id=:'eid'::uuid;
SQL
)"
IFS='|' read -r REVIEW2 ELIGIBLE2 OUTBOX2 STATUS2 OUTBOX_COMPANY <<<"$POST_REVIEW"
[ "$REVIEW2" = "accepted" ] || stop "evaluation review_status not accepted"
[ "$ELIGIBLE2" = "true" ] || stop "accepted evaluation lost training eligibility"
[ "$OUTBOX2" = "1" ] || stop "review created duplicate/missing outbox"
[ "$OUTBOX_COMPANY" = "$COMPANY" ] || stop "outbox company lineage mismatch"
pass "review acceptance preserves exactly-one outbox and tenant lineage"

WORKER_URL="https://${PROJECT_REF}.supabase.co/functions/v1/training-outbox-worker"
curl --silent --show-error --fail-with-body \
  --max-time 120 \
  -X POST "$WORKER_URL" \
  -H "X-Training-Outbox-Token: $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{}' >/dev/null || stop "training outbox worker runtime call failed"

DELIVERY="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVALUATION_ID" <<'SQL'
SELECT status, delivery_attempts, coalesce(delivery_idempotency_key,'')
FROM public.evaluation_training_outbox
WHERE evaluation_id=:'eid'::uuid;
SQL
)"
IFS='|' read -r DSTATUS ATTEMPTS DIDEM <<<"$DELIVERY"
[ "$DSTATUS" = "delivered" ] || stop "SU CoachAI transport was not marked delivered"
[ "$ATTEMPTS" -ge 1 ] || stop "delivery attempt count not incremented"
[ "$DIDEM" = "$EVALUATION_ID" ] || stop "delivery idempotency key drift"
pass "SU CoachAI transport delivered with deterministic idempotency key"

deadline=$(( $(date +%s) + POLL_SECONDS ))
while [ "$(date +%s)" -le "$deadline" ]; do
  LINK="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVALUATION_ID" <<'SQL'
SELECT
  count(*),
  coalesce(max(company_id::text),''),
  coalesce(max(local_state),''),
  coalesce(max(improved_state),''),
  coalesce(max(remote_sync_state),'')
FROM public.ce_training_link
WHERE evaluation_id=:'eid'::uuid
  AND link_kind='training_candidate';
SQL
)"
  IFS='|' read -r LINK_COUNT LINK_COMPANY LOCAL_STATE IMPROVED_STATE REMOTE_STATE <<<"$LINK"
  if [ "$LINK_COUNT" = "1" ] && [ "$IMPROVED_STATE" = "received" ]; then
    [ "$LINK_COMPANY" = "$COMPANY" ] || stop "training result company mismatch"
    [ "$LOCAL_STATE" = "delivered" ] || stop "training link local state mismatch"
    [ "$REMOTE_STATE" = "synced" ] || stop "training link remote state mismatch"
    pass "real SU CoachAI training result received exactly once"
    echo "TASK 8.3 CE REVIEW/TRAINING HANDOFF STATUS: PASS"
    exit 0
  fi
  sleep 5
done

stop "SU CoachAI result callback not observed within approved wait window"
