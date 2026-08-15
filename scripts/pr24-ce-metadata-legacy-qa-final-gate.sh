#!/bin/bash
set -Eeuo pipefail
bash scripts/pr24-ce-metadata-legacy-qa-source-gate.sh
if [ "${PR24_REQUIRE_RUNTIME:-NO}" != "YES" ]; then
  echo "NOT RUN: deployed PR24 schema runtime gate"
  echo "FINAL STATUS: STOP"
  exit 2
fi
bash scripts/pr24-ce-metadata-legacy-qa-runtime-gate.sh
echo "FINAL STATUS: READY"
