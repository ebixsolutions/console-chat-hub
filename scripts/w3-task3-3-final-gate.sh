#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

# Task 3.3 owns its current source contracts. Previously frozen W1/W2 gates are
# not reopened here; regressions that affect the current product are asserted by
# the consolidated Task 3.3 contracts below.
python3 tests/edge/w3-task3-3-source-contract.py "$ROOT"
python3 tests/edge/w3-task3-3-consolidated-closure-contract.py "$ROOT"
python3 tests/edge/task3-3-consolidated-product-ready-contract.py "$ROOT"
python3 tests/edge/task3-3-round1-conversational-closure-contract.py "$ROOT"
deno test supabase/functions/_shared/task3-3-round1-closure_test.ts

for f in \
  scripts/w3-task3-3-runtime-inputs-load.sh \
  scripts/w3-task3-3-production-activate.sh \
  scripts/w3-task3-3-whole-product-smoke.sh \
  sql/pr30/pr30_agent_attachment.sql \
  sql/pr30/pr30_agent_attachment.rollback.sql \
  config/w3-task3-3-dev-identity.env
do
  test -s "$f" || { echo "FAIL missing/empty Task 3.3 dependency: $f" >&2; exit 1; }
done

npm run build

if [ "${W3_T3_3_RUN_PRODUCTION:-false}" != true ]; then
  echo "STOP: W3 Task 3.3 source/build complete; explicit final production authorization required" >&2
  exit 2
fi

source "$ROOT/config/w3-task3-3-dev-identity.env"
source "$ROOT/scripts/w3-task3-3-runtime-inputs-load.sh"

[ "${W3_T3_3_PROJECT_REF:-}" = "hvmtoqiwdqvgnjepxwrc" ] || {
  echo "STOP: final-gate project ref mismatch" >&2
  exit 2
}
[ "${W3_T3_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED:-}" = "YES" ] || {
  echo "STOP: final-gate Lovable-native deployment confirmation missing" >&2
  exit 2
}

bash scripts/w3-task3-3-production-activate.sh
bash scripts/w3-task3-3-whole-product-smoke.sh

echo "W3 TASK 3.3 FINAL STATUS: READY"
