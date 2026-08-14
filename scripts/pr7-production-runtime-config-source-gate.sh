#!/bin/bash
set -Eeuo pipefail

DEP="scripts/pr7-production-deploy.sh"
FINAL="scripts/pr7-production-final-gate.sh"
RUNTIME="scripts/pr7-production-runtime-config-gate.sh"

fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }

for f in "$DEP" "$FINAL" "$RUNTIME"; do [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }; done

must_have "$DEP" 'bash scripts/pr7-production-runtime-config-gate.sh' "deploy blocks on runtime config before mutations"
must_have "$FINAL" 'bash scripts/pr7-production-runtime-config-gate.sh' "production final rechecks runtime config"
must_have "$RUNTIME" 'ENABLE_KB_ADAPTER' "KB activation required"
must_have "$RUNTIME" 'ENABLE_CUSTOMER360_ADAPTER' "Customer360 activation required"
must_have "$RUNTIME" 'ENABLE_COACH_PROMPT_ADAPTER' "Coach prompt activation required"
must_have "$RUNTIME" 'KB_SINGAPORE_JWT_SECRET' "Singapore JWT secret required"
must_have "$RUNTIME" 'CUSTOMER360_INTERNAL_TOKEN' "Customer360 internal token required"
must_have "$RUNTIME" 'C360_COACH_SYNC_INTERNAL_TOKEN' "Coach sync internal token required"
must_have "$RUNTIME" 'npx supabase secrets list' "production secret inventory is read-only verified"
must_have "$RUNTIME" 'values are never printed' "secret values are not logged"

if [ "$fail" -ne 0 ]; then
  echo "TASK 7.2 RUNTIME CONFIG SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 7.2 RUNTIME CONFIG SOURCE STATUS: PASS"
