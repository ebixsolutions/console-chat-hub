#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

python3 tests/edge/w1-task1-3-runtime-source-contract.py "$ROOT"

for f in \
  scripts/pr7-singapore-kb-runtime-smoke.sh \
  scripts/pr9-singapore-kb-authenticated-runtime-smoke.sh \
  scripts/w1-task1-3-widget-runtime-smoke.sh \
  tests/edge/w1-task1-3-runtime-source-contract.py
do
  test -s "$f"
done

if [ "${W1_RUN_PRODUCTION_SMOKE:-false}" = "true" ]; then
  bash scripts/pr7-singapore-kb-runtime-smoke.sh
  bash scripts/pr9-singapore-kb-authenticated-runtime-smoke.sh
  bash scripts/w1-task1-3-widget-runtime-smoke.sh
  echo "W1 TASK 1.3 FINAL STATUS: PASS"
else
  echo "STOP: source/build package is complete; production runtime smoke requires W1_RUN_PRODUCTION_SMOKE=true and runtime credentials" >&2
  exit 2
fi
