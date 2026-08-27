#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"
python3 tests/edge/w2-task2-3-source-contract.py "$ROOT"

for f in \
  supabase/functions/training-outbox-worker/index.ts \
  supabase/functions/training-result-receiver/index.ts \
  supabase/functions/training-kb-sync/index.ts \
  supabase/functions/training-kb-finalize/index.ts \
  sql/pr6b/pr6b_training_result_ingest.sql \
  sql/pr6b/pr6b_singapore_kb_sync_state.sql \
  sql/pr6b/pr6b_singapore_kb_finalize.sql \
  scripts/w2-task2-3-lovable-native-deploy-gate.sh
do test -s "$f"; done

if [ "${W2_T2_3_RUN_PRODUCTION:-false}" != "true" ]; then
  echo "STOP: Task 2.3 implementation complete; activation/runtime requires explicit authorization" >&2
  exit 2
fi

bash scripts/w2-task2-3-learning-loop-activate.sh
bash scripts/w2-task2-3-lovable-native-deploy-gate.sh
bash scripts/w2-task2-3-learning-loop-runtime-smoke.sh
echo "W2 TASK 2.3 FINAL STATUS: READY"
