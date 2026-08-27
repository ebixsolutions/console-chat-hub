#!/bin/bash
set -Eeuo pipefail
DB="${SUPABASE_DB_URL:-}"
PROJECT_REF="${W2_T2_3_PROJECT_REF:-}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
EVAL="${W2_T2_3_EVALUATION_ID:-}"
CONV="${W2_T2_3_CONVERSATION_ID:-}"
BEARER="${W2_T2_3_REVIEW_BEARER_TOKEN:-}"
WORKER_TOKEN="${TRAINING_OUTBOX_INTERNAL_TOKEN:-}"
SYNC_TOKEN="${TRAINING_KB_SYNC_INTERNAL_TOKEN:-}"
WAIT="${W2_T2_3_WAIT_SECONDS:-180}"
APPROVED="${W2_T2_3_FIXTURE_APPROVED:-}"
REQUIRE_KB_WRITE="${W2_T2_3_REQUIRE_KB_WRITE:-NO}"
stop(){ echo "STOP: $1" >&2; exit 2; }
fail(){ echo "FAIL: $1" >&2; exit 1; }
pass(){ echo "PASS $1"; }

[ "$PROJECT_REF" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ "$APPROVED" = "YES" ] || stop "approved canonical training fixture required"
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
[[ "$CONV" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "conversation id invalid"
if [ -n "$EVAL" ]; then
  [[ "$EVAL" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "evaluation id invalid"
else
  DISCOVERED="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v cid="$CONV" <<'SQL'
SELECT count(*),coalesce(min(id)::text,'')
FROM public.conversation_evaluation
WHERE conversation_id=:'cid'::uuid;
SQL
)"
  IFS='|' read -r EVAL_COUNT EVAL <<<"$DISCOVERED"
  [ "$EVAL_COUNT" = "1" ] || stop "expected exactly one canonical evaluation for runtime fixture conversation; got $EVAL_COUNT"
  [[ "$EVAL" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "discovered evaluation id invalid"
  pass "canonical evaluation id auto-discovered from runtime fixture conversation"
fi
[ ${#BEARER} -ge 20 ] || stop "review bearer missing"
[ ${#WORKER_TOKEN} -ge 24 ] || stop "training outbox token missing"
[ ${#SYNC_TOKEN} -ge 24 ] || stop "training KB sync token missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"
command -v curl >/dev/null 2>&1 || stop "curl missing"

PRE="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVAL" -v cid="$CONV" <<'SQL'
SELECT e.id::text,e.conversation_id::text,e.company_id::text,e.training_eligible::text,e.review_status::text,
       (SELECT count(*) FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id),
       coalesce((SELECT delivery_idempotency_key FROM public.evaluation_training_outbox o WHERE o.evaluation_id=e.id LIMIT 1),'')
FROM public.conversation_evaluation e
WHERE e.id=:'eid'::uuid AND e.conversation_id=:'cid'::uuid;
SQL
)"
[ -n "$PRE" ] || stop "approved canonical evaluation fixture missing"
IFS='|' read -r RID RCID COMPANY ELIGIBLE REVIEW OUTBOX IDEM <<<"$PRE"
[ "$ELIGIBLE" = "true" ] || stop "fixture not training_eligible"
[ "$OUTBOX" = "1" ] || stop "expected exactly one canonical outbox"
[ "$IDEM" = "$EVAL" ] || stop "delivery idempotency key mismatch"
case "$REVIEW" in
  pending|needs_review|review_pending|"") REVIEW_ACTION="accept" ;;
  accepted) REVIEW_ACTION="resume" ;;
  rejected|reopened) stop "runtime fixture is not in an acceptable review state: $REVIEW" ;;
  *) stop "unexpected runtime fixture review_status: $REVIEW" ;;
esac

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if [ "$REVIEW_ACTION" = "accept" ]; then
  curl --silent --show-error --fail-with-body --max-time 60 \
    -X POST "https://${PROJECT_REF}.supabase.co/functions/v1/conversation-evaluate" \
    -H "Authorization: Bearer $BEARER" \
    -H "Content-Type: application/json" \
    --data "{\"action\":\"review\",\"evaluation_id\":\"$EVAL\",\"conversation_id\":\"$CONV\",\"decision\":\"accept\"}" >"$TMP" \
    || stop "canonical CE accept review failed"

  python3 - "$TMP" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
if d.get("status")!="reviewed" or d.get("to")!="accepted":
    raise SystemExit("FAIL: review response not accepted")
print("PASS canonical CE review accepted")
PY
else
  pass "canonical CE review already accepted; resuming idempotently"
fi

DELIVERY="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVAL" <<'SQL'
SELECT status,delivery_attempts,delivery_idempotency_key
FROM public.evaluation_training_outbox WHERE evaluation_id=:'eid'::uuid;
SQL
)"
IFS='|' read -r DSTATUS ATTEMPTS DIDEM <<<"$DELIVERY"
[ "$DIDEM" = "$EVAL" ] || stop "delivery idempotency drift"

if [ "$DSTATUS" != "delivered" ]; then
  curl --silent --show-error --fail-with-body --max-time 120 \
    -X POST "https://${PROJECT_REF}.supabase.co/functions/v1/training-outbox-worker" \
    -H "X-Training-Outbox-Token: $WORKER_TOKEN" \
    -H "Content-Type: application/json" --data '{}' >/dev/null \
    || stop "AI Chatbot -> SU CoachAI outbox worker failed"

  DELIVERY="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVAL" <<'SQL'
SELECT status,delivery_attempts,delivery_idempotency_key
FROM public.evaluation_training_outbox WHERE evaluation_id=:'eid'::uuid;
SQL
)"
  IFS='|' read -r DSTATUS ATTEMPTS DIDEM <<<"$DELIVERY"
fi

[ "$DSTATUS" = "delivered" ] || stop "SU CoachAI transport not delivered"
[ "$ATTEMPTS" -ge 1 ] || stop "delivery attempts not incremented"
[ "$DIDEM" = "$EVAL" ] || stop "delivery idempotency drift"
pass "AI Chatbot -> SU CoachAI transport delivered/resumed idempotently"

deadline=$(( $(date +%s) + WAIT ))
while [ "$(date +%s)" -le "$deadline" ]; do
  LINK="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVAL" <<'SQL'
SELECT count(*),coalesce(max(company_id::text),''),coalesce(max(local_state),''),
       coalesce(max(improved_state),''),coalesce(max(remote_sync_state),''),
       coalesce(max(payload->>'decision'),'')
FROM public.ce_training_link
WHERE evaluation_id=:'eid'::uuid AND link_kind='training_candidate';
SQL
)"
  IFS='|' read -r LC LCOMP LOCAL IMPROVED REMOTE DECISION <<<"$LINK"
  if [ "$LC" = "1" ] && [ "$IMPROVED" = "received" ]; then
    [ "$LCOMP" = "$COMPANY" ] || stop "SU CoachAI callback company mismatch"
    [ "$LOCAL" = "delivered" ] || stop "training link local state mismatch"
    [ "$REMOTE" = "synced" ] || stop "training link remote state mismatch"
    pass "SU CoachAI -> AI Chatbot result received exactly once"
    break
  fi
  sleep 5
done

LINK_FINAL="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVAL" <<'SQL'
SELECT count(*),coalesce(max(improved_state),''),coalesce(max(payload->>'decision'),'')
FROM public.ce_training_link
WHERE evaluation_id=:'eid'::uuid AND link_kind='training_candidate';
SQL
)"
IFS='|' read -r LC IMPROVED DECISION <<<"$LINK_FINAL"
[ "$LC" = "1" ] && [ "$IMPROVED" = "received" ] || stop "SU CoachAI result callback not observed"

if [ "$REQUIRE_KB_WRITE" = "YES" ] && [ "$DECISION" != "trained" ]; then
  fail "Product-ready learning fixture did not produce decision=trained; governed KB write path was not proven"
fi

if [ "$DECISION" = "trained" ]; then
  KB_CONTRACT="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVAL" <<'SQL'
SELECT
  CASE WHEN jsonb_typeof(improved_result->'kb_update')='object' THEN 'yes' ELSE 'no' END,
  coalesce(improved_result->'kb_update'->'approval'->>'status',''),
  coalesce(improved_result->'kb_update'->'approval'->>'source',''),
  CASE WHEN nullif(trim(coalesce(improved_result->'kb_update'->'approval'->>'approved_by','')),'') IS NOT NULL THEN 'yes' ELSE 'no' END,
  CASE WHEN nullif(trim(coalesce(improved_result->'kb_update'->'approval'->>'approved_at','')),'') IS NOT NULL THEN 'yes' ELSE 'no' END
FROM public.ce_training_link
WHERE evaluation_id=:'eid'::uuid AND link_kind='training_candidate';
SQL
)"
  IFS='|' read -r HAS_KB AP_STATUS AP_SOURCE AP_BY AP_AT <<<"$KB_CONTRACT"

  if [ "$REQUIRE_KB_WRITE" = "YES" ] && [ "$HAS_KB" != "yes" ]; then
    fail "decision=trained did not include kb_update; governed KB write path was not proven"
  fi

  if [ "$HAS_KB" = "yes" ]; then
    [ "$AP_STATUS" = "approved" ] || stop "trained KB update lacks verified approval status"
    [ "$AP_SOURCE" = "su_coachai_verified_correction" ] || stop "trained KB update approval source invalid"
    [ "$AP_BY" = "yes" ] || stop "trained KB update approved_by missing"
    [ "$AP_AT" = "yes" ] || stop "trained KB update approved_at missing"
    pass "verified-correction approval contract"

    for i in $(seq 1 18); do
      SYNC_BODY="$(mktemp)"
      FINAL_BODY="$(mktemp)"
      curl --silent --show-error --fail-with-body --max-time 120 \
        -X POST "https://${PROJECT_REF}.supabase.co/functions/v1/training-kb-sync" \
        -H "X-Training-KB-Sync-Token: $SYNC_TOKEN" \
        -H "Content-Type: application/json" --data '{}' >"$SYNC_BODY" \
        || { rm -f "$SYNC_BODY" "$FINAL_BODY"; stop "training-kb-sync failed"; }

      curl --silent --show-error --fail-with-body --max-time 120 \
        -X POST "https://${PROJECT_REF}.supabase.co/functions/v1/training-kb-finalize" \
        -H "X-Training-KB-Sync-Token: $SYNC_TOKEN" \
        -H "Content-Type: application/json" --data '{}' >"$FINAL_BODY" \
        || { rm -f "$SYNC_BODY" "$FINAL_BODY"; stop "training-kb-finalize failed"; }

      FINAL_JSON="$(python3 - "$FINAL_BODY" <<'PY'
import json,sys
try:
    d=json.load(open(sys.argv[1]))
except Exception:
    print("invalid|||")
    raise SystemExit
print("|".join([
    str(d.get("state","")),
    str(d.get("reason","")),
    "yes" if d.get("rag_new_content_verified") is True else "no",
]))
PY
)"
      rm -f "$SYNC_BODY" "$FINAL_BODY"
      IFS='|' read -r FSTATE FREASON FRAG <<<"$FINAL_JSON"

      STATE="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v eid="$EVAL" <<'SQL'
SELECT count(*),coalesce(max(state),''),coalesce(max(remote_sync_state),'')
FROM public.ce_kb_publish_state WHERE evaluation_id=:'eid'::uuid AND action='publish';
SQL
)"
      IFS='|' read -r PC PST PRS <<<"$STATE"

      if [ "$PC" = "1" ] && [ "$PST" = "published" ] && [ "$PRS" = "synced" ]; then
        [ "$FSTATE" = "published" ] || fail "DB published but finalizer response did not prove published state"
        [ "$FRAG" = "yes" ] || fail "DB published without rag_new_content_verified=true"
        pass "SU CoachAI improved result -> Singapore KB new-content RAG read-back"
        echo "W2 TASK 2.3 LEARNING LOOP RUNTIME STATUS: PASS"
        exit 0
      fi

      if [ "$PST" = "failed" ]; then
        fail "Singapore KB publish state failed"
      fi

      if [ "$FREASON" = "kb_rag_new_content_not_visible" ]; then
        pass "new vector not visible yet; retrying safely"
      fi
      sleep 5
    done

    stop "Singapore KB new-content publish/read-back did not complete within retry window"
  fi
fi

if [ "$REQUIRE_KB_WRITE" = "YES" ]; then
  fail "governed KB write/publish/new-content RAG proof did not complete"
fi
pass "training decision requires no KB publish continuation"
echo "W2 TASK 2.3 LEARNING LOOP RUNTIME STATUS: PASS"
