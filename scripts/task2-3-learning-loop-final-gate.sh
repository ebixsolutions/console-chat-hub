#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_REF="nrfxhqabwblzxoushgnm"
M1="supabase/migrations/20260829150254_task2_3_learning_loop_tenant_atomicity_closure.sql"
M2="supabase/migrations/20260829150353_task2_3_kb_finalize_state_machine_fix.sql"
SMOKE="scripts/task2-3-learning-loop-runtime-smoke.sh"
LEGACY_ENTRY="scripts/w2-task2-3-learning-loop-runtime-smoke.sh"
OUTBOX="supabase/functions/training-outbox-worker/index.ts"
RESULT="supabase/functions/training-result-receiver/index.ts"
SYNC="supabase/functions/training-kb-sync/index.ts"
FINALIZE="supabase/functions/training-kb-finalize/index.ts"

fail(){ echo "FAIL: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }

for f in .env "$M1" "$M2" "$SMOKE" "$LEGACY_ENTRY" "$OUTBOX" "$RESULT" "$SYNC" "$FINALIZE"; do
  [[ -s "$f" ]] || fail "missing/empty $f"
done

grep -q "SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail "wrong Supabase target"
if grep -Eqs 'hvmtoqiwdqvgnjepxwrc' "$SMOKE" "$LEGACY_ENTRY" "$OUTBOX" "$RESULT" "$SYNC" "$FINALIZE"; then
  fail "legacy Supabase ref remains in Task 2.3 active scope"
fi
pass "target binding and legacy retirement"

for needle in \
  ce_training_link_evaluation_company_fkey \
  ce_kb_publish_state_evaluation_company_fkey \
  record_coachai_training_result_tx \
  claim_pr6b_kb_sync_tx \
  finish_pr6b_kb_sync_tx \
  claim_pr6b_kb_finalize_tx \
  finish_pr6b_kb_finalize_tx; do
  grep -q "$needle" "$M1" || fail "migration contract missing $needle"
done
grep -q "in_progress" "$M2" || fail "finalizer state-machine repair missing"
pass "tenant/atomicity/state-machine source contract"

for f in "$OUTBOX" "$RESULT" "$SYNC" "$FINALIZE"; do
  grep -q 'Deno.serve' "$f" || fail "Edge entrypoint missing: $f"
done
grep -q 'AI_CHATBOT_CE_HANDOFF_V1' "$OUTBOX" || fail "AI->CoachAI contract missing"
grep -q 'SU_COACHAI_TRAINING_RESULT_V1' "$RESULT" || fail "CoachAI result contract missing"
grep -q 'su_coachai_verified_correction' "$SYNC" || fail "verified correction gate missing"
grep -q 'rag_new_content_verified' "$FINALIZE" || fail "RAG new-content proof missing"
pass "end-to-end learning-loop source surfaces"

sha_norm(){ python3 - "$1" <<'PY'
import hashlib,pathlib,sys
b=pathlib.Path(sys.argv[1]).read_bytes().rstrip()
print(hashlib.sha256(b).hexdigest())
PY
}
[[ "$(sha_norm "$M1")" == "${TASK23_LIVE_M1_SHA256:-}" ]] || fail "migration 1 source/live hash mismatch"
[[ "$(sha_norm "$M2")" == "${TASK23_LIVE_M2_SHA256:-}" ]] || fail "migration 2 source/live hash mismatch"
pass "live migration source hashes"

bash "$SMOKE"
pass "internal runtime/tenant/idempotency/rollback proof"

[[ "${TASK23_EDGE_ASSERTIONS:-}" == "outbox=ACTIVE;result=ACTIVE;sync=ACTIVE;finalize=ACTIVE" ]] || fail "target Edge deployment assertions missing"
[[ "${TASK23_DDL_ROLLBACK_PROOF:-}" == "link_fk=1;kb_fk=1;state_check=1" ]] || fail "DDL rollback proof mismatch"
pass "target Edge and DDL rollback assertions"

npm run build
pass "production client/SSR/Nitro build"

echo "TASK 2.3 FINAL GATE: PASS"
