#!/bin/bash
set -Eeuo pipefail

bash scripts/pr5-task3-atomic-handoff-return-source-gate.sh

if [ "${PR5_TASK3_REQUIRE_RUNTIME:-NO}" = "YES" ]; then
  bash scripts/pr5-task3-atomic-handoff-return-runtime-gate.sh
else
  echo "NOT RUN runtime gate: set PR5_TASK3_REQUIRE_RUNTIME=YES with SUPABASE_DB_URL after deployment"
  echo "FINAL STATUS: STOP"
  exit 2
fi

echo "FINAL STATUS: READY"
