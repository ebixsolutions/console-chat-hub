#!/bin/bash
set -Eeuo pipefail
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }
must_not_have(){ grep -Fq "$2" "$1" && { bad "$3"; } || pass "$3"; }

RUNTIME="scripts/pr7-production-runtime-config-gate.sh"
EVAL="supabase/functions/conversation-evaluate/index.ts"
WORKER="supabase/functions/training-outbox-worker/index.ts"
RECEIVER="supabase/functions/training-result-receiver/index.ts"
INGEST="sql/pr6b/pr6b_training_result_ingest.sql"
UI="src/routes/_authenticated/console.conversation-evaluation.index.tsx"
SMOKE="scripts/pr8-ce-review-training-handoff-runtime-smoke.sh"
FINAL="scripts/pr7-production-final-gate.sh"

for f in "$RUNTIME" "$EVAL" "$WORKER" "$RECEIVER" "$INGEST" "$UI" "$SMOKE" "$FINAL"; do
  [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }
done

must_have "$RUNTIME" 'SU_COACHAI_RESULT_TOKEN' "Coach result receiver token production-blocking"
must_have "$EVAL" '["accept", "reject", "reopen"].includes(decision)' "review transition surface frozen"
must_have "$EVAL" 'review_evaluation' "review uses canonical RPC"
must_have "$WORKER" '"Idempotency-Key": row.delivery_idempotency_key' "worker sends deterministic idempotency key"
must_have "$WORKER" 'company_identity_mismatch' "worker tenant mismatch fail-closed"
must_have "$RECEIVER" 'SU_COACHAI_TRAINING_RESULT_V1' "result receiver contract frozen"
must_have "$RECEIVER" 'X-SU-CoachAI-Result-Token' "result receiver server authentication frozen"
must_have "$INGEST" "v_outbox.status IS DISTINCT FROM 'delivered'" "result rejected before delivered outbox"
must_have "$INGEST" "RETURN jsonb_build_object('result','idempotent'" "result replay idempotency frozen"
must_have "$INGEST" "RETURN jsonb_build_object('result','idempotency_mismatch'" "different result cannot overwrite training truth"
must_have "$SMOKE" 'PR8_CE_HANDOFF_FIXTURE_APPROVED' "runtime smoke requires approved real fixture"

python3 - "$SMOKE" <<'PY' || { bad "runtime smoke authenticated accept-review semantics"; }
import json, re, sys

path = sys.argv[1]
text = open(path, encoding="utf-8").read()

# Parse the curl --data payload used for the conversation-evaluate call.
matches = re.findall(r'--data\s+"((?:\\.|[^"])*)"', text)
found = False
for raw in matches:
    # Shell source stores JSON quotes as \". Convert only those escaped quotes
    # back to JSON quotes; do not execute/eval shell content.
    candidate = raw.replace(r'\"', '"')
    try:
        body = json.loads(candidate)
    except Exception:
        continue
    if (
        isinstance(body, dict)
        and body.get("action") == "review"
        and body.get("decision") == "accept"
        and body.get("evaluation_id") == "$EVALUATION_ID"
        and body.get("conversation_id") == "$CONVERSATION_ID"
    ):
        found = True
        break

if not found:
    raise SystemExit(1)
print("PASS runtime smoke performs authenticated review action")
print("PASS runtime smoke performs accept decision")
PY

must_have "$SMOKE" 'training-outbox-worker' "runtime smoke invokes real handoff worker"
must_have "$SMOKE" 'SU CoachAI result callback not observed' "runtime smoke waits for real Coach callback"
must_have "$FINAL" 'pr8-ce-review-training-handoff-runtime-smoke.sh' "production final gate runs handoff smoke"

must_not_have "$UI" 'Training Ready' "AI Chatbot CE UI has no Training Ready control"
must_not_have "$UI" '>Trained<' "AI Chatbot CE UI has no Trained control"
must_not_have "$UI" 'training_ready' "AI Chatbot CE UI has no training-ready workflow"

if [ "$fail" -ne 0 ]; then
  echo "TASK 8.3 CE REVIEW/TRAINING SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 8.3 CE REVIEW/TRAINING SOURCE STATUS: PASS"
