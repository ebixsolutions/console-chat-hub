#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"
python3 tests/edge/w2-task2-1-source-contract.py "$ROOT"

if [ "${W2_T2_1_RUN_PRODUCTION:-false}" = "true" ]; then
  bash scripts/w2-task2-1-company-identity-activate.sh
  bash scripts/w2-task2-1-runtime-gate.sh
  echo "W2 TASK 2.1 FINAL STATUS: PASS"
else
  echo "STOP: implementation/source gate complete; production activation requires explicit authorization" >&2
  exit 2
fi
