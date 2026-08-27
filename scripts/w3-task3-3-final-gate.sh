#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"
python3 tests/edge/w3-task3-3-source-contract.py "$ROOT"
for f in scripts/w2-task2-1-final-gate.sh scripts/w2-task2-2-final-gate.sh scripts/w2-task2-3-final-gate.sh scripts/w1-task1-3-final-gate.sh scripts/w3-task3-1-product-surface-final-gate.sh scripts/w3-task3-2-security-final-gate.sh; do test -s "$f"; done
npm run build
if [ "${W3_T3_3_RUN_PRODUCTION:-false}" != true ]; then
  echo "STOP: W3 Task 3.3 source/build complete; explicit final production authorization required" >&2
  exit 2
fi
bash scripts/w3-task3-3-production-activate.sh
bash scripts/w3-task3-3-whole-product-smoke.sh
echo "W3 TASK 3.3 FINAL STATUS: READY"
