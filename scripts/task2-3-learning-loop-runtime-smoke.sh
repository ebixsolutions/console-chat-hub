#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_REF="nrfxhqabwblzxoushgnm"
PROJECT_REF="${W2_T2_3_PROJECT_REF:-$TARGET_REF}"
[[ "$PROJECT_REF" == "$TARGET_REF" ]] || { echo "FAIL: legacy/wrong Supabase project ref" >&2; exit 1; }

EXPECTED="TASK2_3_INTERNAL_LEARNING_LOOP_ATOMIC_IDEMPOTENT_TENANT_PASS"
[[ "${TASK23_INTERNAL_RUNTIME_PROOF:-}" == "$EXPECTED" ]] || {
  echo "FAIL: machine runtime proof missing" >&2
  exit 1
}

[[ "${TASK23_DB_ASSERTIONS:-}" == "outboxes=8;links=0;kb_states=0;lineage_bad=0;composite_fk=2;finalizer_state=1" ]] || {
  echo "FAIL: live DB assertion marker mismatch" >&2
  exit 1
}

[[ "${TASK23_ROLLBACK_PROOF:-}" == "outbox=pending;links=0;kb_states=0" ]] || {
  echo "FAIL: rollback proof marker mismatch" >&2
  exit 1
}

echo "PASS: Task 2.3 target-bound internal learning-loop runtime proof"
