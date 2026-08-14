#!/bin/bash
set -Eeuo pipefail
fail=0
pass(){ echo "PASS $1"; }
bad(){ echo "FAIL $1"; fail=1; }
must_have(){ grep -Fq "$2" "$1" && pass "$3" || bad "$3"; }

RUNTIME="scripts/pr7-production-runtime-config-gate.sh"
SMOKE="scripts/pr8-ce-runtime-smoke.sh"
FINAL="scripts/pr7-production-final-gate.sh"
for f in "$RUNTIME" "$SMOKE" "$FINAL"; do [ -s "$f" ] || { echo "FAIL missing $f"; exit 1; }; done

must_have "$RUNTIME" 'CE_CONTRACT_VERSION' "CE contract version runtime required"
must_have "$RUNTIME" 'CE_SOURCE_DEPLOYMENT' "CE source deployment runtime required"
must_have "$RUNTIME" 'LLM_MODEL_EVALUATION' "CE evaluation model runtime required"
must_have "$SMOKE" 'PR8_CE_SMOKE_FIXTURE_APPROVED' "smoke requires explicit fixture approval"
must_have "$SMOKE" 'redaction_applied' "smoke verifies redacted snapshot"
must_have "$SMOKE" 'DETAIL_COUNT' "smoke verifies six evaluator details"
must_have "$SMOKE" 'delivery_idempotency_key' "smoke verifies outbox idempotency key"
must_have "$SMOKE" 'status!='"'"'already_evaluated'"'"'' "smoke requires replay already_evaluated"
must_have "$FINAL" 'bash scripts/pr8-ce-runtime-smoke.sh' "production final gate runs CE smoke"

if [ "$fail" -ne 0 ]; then
  echo "TASK 8.2 CE RUNTIME SMOKE SOURCE STATUS: FAIL"
  exit 1
fi
echo "TASK 8.2 CE RUNTIME SMOKE SOURCE STATUS: PASS"
