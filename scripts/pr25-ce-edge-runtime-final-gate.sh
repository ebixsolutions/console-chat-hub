#!/bin/bash
set -Eeuo pipefail
bash scripts/pr25-ce-edge-runtime-compile-gate.sh
if [ "${PR25_REQUIRE_RUNTIME:-NO}" != "YES" ]; then
  echo "NOT RUN real authenticated CE scoring smoke"
  echo "FINAL STATUS: STOP"
  exit 2
fi
bash scripts/pr22-ce-runtime-smoke.sh
echo "FINAL STATUS: READY"
