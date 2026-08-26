#!/bin/bash
set -Eeuo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$ROOT"
python3 tests/edge/w2-task2-3-source-contract.py "$ROOT"
for f in   supabase/functions/training-outbox-worker/index.ts   supabase/functions/training-result-receiver/index.ts   supabase/functions/training-kb-sync/index.ts   supabase/functions/training-kb-finalize/index.ts   sql/pr6b/pr6b_training_result_ingest.sql   sql/pr6b/pr6b_singapore_kb_sync_state.sql   sql/pr6b/pr6b_singapore_kb_finalize.sql
do test -s "$f"; done
grep -q 'AI_CHATBOT_CE_HANDOFF_V1' supabase/functions/training-outbox-worker/index.ts
grep -q 'SU_COACHAI_TRAINING_RESULT_V1' supabase/functions/training-result-receiver/index.ts
grep -q 'resolveSingaporeCredential' supabase/functions/training-kb-sync/index.ts
grep -q 'parseAggregationResponse' supabase/functions/training-kb-finalize/index.ts
if [ "${W2_T2_3_RUN_PRODUCTION:-false}" != "true" ]; then
  echo "STOP: Task 2.3 implementation complete; production activation/runtime requires explicit authorization" >&2
  exit 2
fi
bash scripts/w2-task2-3-learning-loop-activate.sh
bash scripts/w2-task2-3-learning-loop-runtime-smoke.sh
echo "W2 TASK 2.3 FINAL STATUS: READY"
