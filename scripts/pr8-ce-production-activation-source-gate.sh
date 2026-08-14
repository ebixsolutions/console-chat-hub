#!/bin/bash
set -Eeuo pipefail
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }

RUNTIME="scripts/pr7-production-runtime-config-gate.sh"
DEP="scripts/pr7-production-deploy.sh"
FINAL="scripts/pr7-production-final-gate.sh"

must_have "$RUNTIME" 'SU_COACHAI_EVALUATION_ENDPOINT' "Coach evaluation endpoint production-blocking"
must_have "$RUNTIME" 'TRAINING_OUTBOX_INTERNAL_TOKEN' "training worker token production-blocking"
must_have "$DEP" '"conversation-evaluate"' "conversation-evaluate deploy inventory"
must_have "$DEP" '"training-outbox-worker"' "training worker deploy inventory"
must_have "$DEP" '"training-result-receiver"' "training result receiver deploy inventory"
must_have "$DEP" '"training-kb-sync"' "training KB sync deploy inventory"
must_have "$DEP" '"training-kb-finalize"' "training KB finalize deploy inventory"
must_have "$FINAL" 'pr8-ce-production-activation-gate.sh' "production final gate executes CE activation gate"

if [ "$fail" -ne 0 ]; then
  echo "TASK 8.1 CE ACTIVATION SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 8.1 CE ACTIVATION SOURCE STATUS: PASS"
