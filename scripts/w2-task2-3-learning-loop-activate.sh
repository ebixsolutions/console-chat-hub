#!/bin/bash
set -Eeuo pipefail
REPO="${W2_T2_3_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
DB="${SUPABASE_DB_URL:-}"
AUTH="${W2_T2_3_PRODUCTION_AUTHORIZED:-}"
PROJECT_REF="${W2_T2_3_PROJECT_REF:-}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
stop(){ echo "STOP: $1" >&2; exit 2; }

[ "$AUTH" = "YES" ] || stop "explicit production authorization missing"
[ "$PROJECT_REF" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
[ -d "$REPO/.git" ] || stop "repo missing"
[ "$(git -C "$REPO" branch --show-current)" = "main" ] || stop "branch must be main"
[ -z "$(git -C "$REPO" status --porcelain)" ] || stop "working tree must be clean"
command -v psql >/dev/null 2>&1 || stop "psql missing"
cd "$REPO"

psql "$DB" -v ON_ERROR_STOP=1 -At <<'SQL' | grep -Fxq 'task22_pass' || stop "Task 2.2 canonical CE activation is not complete"
SELECT CASE WHEN
  EXISTS(SELECT 1 FROM public.company)
  AND EXISTS(SELECT 1 FROM public.company_membership WHERE is_active)
  AND EXISTS(SELECT 1 FROM public.conversation_evaluation)
  AND EXISTS(SELECT 1 FROM public.evaluation_training_outbox)
THEN 'task22_pass' ELSE 'task22_fail' END;
SQL

for f in \
  sql/pr6b/pr6b_training_result_ingest.sql \
  sql/pr6b/pr6b_singapore_kb_sync_state.sql \
  sql/pr6b/pr6b_singapore_kb_finalize.sql \
  supabase/functions/training-outbox-worker/index.ts \
  supabase/functions/training-result-receiver/index.ts \
  supabase/functions/training-kb-sync/index.ts \
  supabase/functions/training-kb-finalize/index.ts \
  supabase/functions/_shared/kb-auth.ts \
  supabase/functions/_shared/kb-client.ts \
  supabase/functions/_shared/kb-aggregation-response.ts
do
  [ -s "$f" ] || stop "learning-loop dependency missing/empty: $f"
done

grep -q 'AI_CHATBOT_CE_HANDOFF_V1' supabase/functions/training-outbox-worker/index.ts || stop "AI Chatbot -> SU CoachAI worker contract missing"
grep -q 'SU_COACHAI_TRAINING_RESULT_V1' supabase/functions/training-result-receiver/index.ts || stop "SU CoachAI -> AI Chatbot result contract missing"
grep -q 'resolveSingaporeCredential' supabase/functions/training-kb-sync/index.ts || stop "training KB sync shared auth baseline missing"
grep -q 'parseAggregationResponse' supabase/functions/training-kb-finalize/index.ts || stop "training KB finalize current RAG contract baseline missing"

psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr6b/pr6b_training_result_ingest.sql
psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr6b/pr6b_singapore_kb_sync_state.sql
psql "$DB" -v ON_ERROR_STOP=1 -f sql/pr6b/pr6b_singapore_kb_finalize.sql

echo "PASS W2 Task 2.3 learning-loop DB activation"
echo "LOVABLE_NATIVE_DEPLOY_REQUIRED: training-outbox-worker training-result-receiver training-kb-sync training-kb-finalize"
