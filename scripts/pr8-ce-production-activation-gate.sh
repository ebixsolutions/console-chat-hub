#!/bin/bash
set -Eeuo pipefail
DB_URL="${SUPABASE_DB_URL:-}"
stop(){ echo "STOP: $1"; exit 2; }
pass(){ echo "PASS $1"; }

[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

# Required source inventory.
for f in \
  supabase/functions/conversation-evaluate/index.ts \
  supabase/functions/training-outbox-worker/index.ts \
  supabase/functions/training-result-receiver/index.ts \
  supabase/functions/training-kb-sync/index.ts \
  supabase/functions/training-kb-finalize/index.ts \
  sql/pr6/pr6_canonical_evaluation_outbox.sql \
  sql/pr6/pr6_canonical_evaluation_outbox.rollback.sql \
  sql/pr7/pr7_ce_lineage_closure.sql \
  sql/pr7/pr7_ce_lineage_closure.rollback.sql
do
  [ -s "$f" ] || stop "CE production source missing: $f"
done
pass "CE production source inventory"

grep -Fq 'AI_CHATBOT_CE_HANDOFF_V1' supabase/functions/training-outbox-worker/index.ts \
  || stop "canonical CE handoff contract missing"
grep -Fq 'Idempotency-Key' supabase/functions/training-outbox-worker/index.ts \
  || stop "training outbox idempotency header missing"
grep -Fq 'company_identity_mismatch' supabase/functions/training-outbox-worker/index.ts \
  || stop "training handoff tenant mismatch guard missing"
grep -Fq 'snapshot_not_redacted' supabase/functions/training-outbox-worker/index.ts \
  || stop "training handoff redaction guard missing"

ROW="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -AtF '|' <<'SQL'
SELECT
  to_regclass('public.conversation_evaluation') IS NOT NULL,
  to_regclass('public.conversation_evaluation_attempt') IS NOT NULL,
  to_regclass('public.ce_bundle_snapshot') IS NOT NULL,
  to_regclass('public.evaluation_training_outbox') IS NOT NULL,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='conversation_evaluation' AND column_name='company_id'
  ),
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='evaluation_training_outbox' AND column_name='company_id'
  );
SQL
)"
IFS='|' read -r EVAL ATTEMPT SNAPSHOT OUTBOX EVAL_COMPANY OUTBOX_COMPANY <<<"$ROW"
[ "$EVAL" = "t" ] || stop "conversation_evaluation table missing"
[ "$ATTEMPT" = "t" ] || stop "conversation_evaluation_attempt table missing"
[ "$SNAPSHOT" = "t" ] || stop "ce_bundle_snapshot table missing"
[ "$OUTBOX" = "t" ] || stop "evaluation_training_outbox table missing"
[ "$EVAL_COMPANY" = "t" ] || stop "conversation_evaluation.company_id missing"
[ "$OUTBOX_COMPANY" = "t" ] || stop "evaluation_training_outbox.company_id missing"

pass "CE canonical tables present"
pass "CE canonical tenant columns present"

echo "TASK 8.1 CE PRODUCTION ACTIVATION STATUS: PASS"
