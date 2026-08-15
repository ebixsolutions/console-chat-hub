#!/bin/bash
set -Eeuo pipefail

bash scripts/pr22-ce-runtime-source-gate.sh

if [ "${PR22_REQUIRE_RUNTIME:-NO}" != "YES" ]; then
  echo "NOT RUN: real deployed CE runtime smoke"
  echo "FINAL STATUS: STOP"
  exit 2
fi

bash scripts/pr22-ce-runtime-smoke.sh
echo "FINAL STATUS: READY"
