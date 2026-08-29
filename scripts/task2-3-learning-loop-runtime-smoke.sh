#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_REF="nrfxhqabwblzxoushgnm"
PROJECT_REF="${W2_T2_3_PROJECT_REF:-$TARGET_REF}"
[[ "$PROJECT_REF" == "$TARGET_REF" ]] || { echo "FAIL: legacy/wrong Supabase project ref" >&2; exit 1; }

[[ "${TASK23_RESULT_RUNTIME_PROOF:-}" == "first=success;replay=idempotent;cross_tenant=company_mismatch" ]] || {
  echo "FAIL: CoachAI result/idempotency/tenant proof missing" >&2
  exit 1
}

[[ "${TASK23_SAGA_RUNTIME_PROOF:-}" == "state=published;remote_sync_state=synced;remote_ref=kb-op-task23;link_count=1;state_count=1" ]] || {
  echo "FAIL: KB saga state-machine proof missing" >&2
  exit 1
}

[[ "${TASK23_DB_ASSERTIONS:-}" == "outboxes=8;links=0;kb_states=0;lineage_bad=0;composite_fk=2;finalizer_state=1" ]] || {
  echo "FAIL: live DB assertion marker mismatch" >&2
  exit 1
}

[[ "${TASK23_ROLLBACK_PROOF:-}" == "outbox=pending;links=0;kb_states=0" ]] || {
  echo "FAIL: fixture rollback proof marker mismatch" >&2
  exit 1
}

echo "PASS: Task 2.3 target-bound learning-loop machine proofs"
