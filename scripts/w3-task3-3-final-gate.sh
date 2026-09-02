#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"

# Canonical Task 3.3 final gate. Task 3.1/3.2 and Workflow 2 gates remain frozen;
# this gate validates only current Task 3.3 contracts, build, and live cutover.
python3 tests/edge/w3-task3-3-source-contract.py "$ROOT"
python3 tests/edge/w3-task3-3-consolidated-closure-contract.py "$ROOT"
python3 tests/edge/task3-3-consolidated-product-ready-contract.py "$ROOT"
python3 tests/edge/task3-3-round1-conversational-closure-contract.py "$ROOT"
python3 tests/edge/w3-task3-3-resolution-contract.py "$ROOT"
python3 tests/edge/w3-task3-3-p0-closure-contract.py "$ROOT"
python3 tests/edge/w3-task3-3-login-feedback-contract.py "$ROOT"

npm run build

if [ "${W3_T3_3_RUN_PRODUCTION:-false}" != true ]; then
  echo "STOP: W3 Task 3.3 source/build complete; explicit production-run flag required" >&2
  exit 2
fi

bash scripts/task3-3-production-cutover-final-gate.sh

echo "W3 TASK 3.3 FINAL STATUS: READY"
