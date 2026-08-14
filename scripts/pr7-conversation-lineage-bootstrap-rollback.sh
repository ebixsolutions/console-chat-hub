#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
RUN_ID="${PR7_CONVERSATION_LINEAGE_RUN_ID:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$RUN_ID" ] || stop "PR7_CONVERSATION_LINEAGE_RUN_ID missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

STATE="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -Atq -v run_id="$RUN_ID" -v company_uuid="$COMPANY_UUID" <<'SQL'
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM public.pr7_conversation_lineage_run
    WHERE run_id=:'run_id'::uuid AND company_id=:'company_uuid'::uuid
      AND completed_at IS NOT NULL AND rolled_back_at IS NOT NULL
  ) THEN 'rolled'
  WHEN EXISTS (
    SELECT 1 FROM public.pr7_conversation_lineage_run
    WHERE run_id=:'run_id'::uuid AND company_id=:'company_uuid'::uuid
      AND completed_at IS NOT NULL AND rolled_back_at IS NULL
  ) THEN 'active'
  WHEN EXISTS (SELECT 1 FROM public.pr7_conversation_lineage_run WHERE run_id=:'run_id'::uuid)
    THEN 'conflict'
  ELSE 'missing'
END;
SQL
)"
if [ "$STATE" = "rolled" ]; then
  echo "PASS: conversation lineage already rolled back (idempotent no-op)"
  exit 0
fi
[ "$STATE" = "active" ] || stop "conversation lineage rollback provenance missing or conflict"

psql "$DB_URL" -v ON_ERROR_STOP=1 -v run_id="$RUN_ID" -v company_uuid="$COMPANY_UUID" <<'SQL'
\set QUIET 1
BEGIN;
SELECT set_config('pr7.conversation_run_id', :'run_id', false);
SELECT set_config('pr7.company_uuid', :'company_uuid', false);

DO $guard$
DECLARE rid uuid:=current_setting('pr7.conversation_run_id')::uuid;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.pr7_conversation_lineage_row p
    LEFT JOIN public.conversations c
      ON p.table_name='conversations' AND c.id=p.row_id
    WHERE p.run_id=rid
      AND p.table_name='conversations'
      AND (c.id IS NULL OR c.company_id IS DISTINCT FROM p.assigned_company_id)
  ) THEN
    RAISE EXCEPTION 'conversation rollback blocked: conversation ownership drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.pr7_conversation_lineage_row p
    LEFT JOIN public.upstream_call_log u
      ON p.table_name='upstream_call_log' AND u.id=p.row_id
    WHERE p.run_id=rid
      AND p.table_name='upstream_call_log'
      AND (u.id IS NULL OR u.company_id IS DISTINCT FROM p.assigned_company_id)
  ) THEN
    RAISE EXCEPTION 'conversation rollback blocked: upstream ownership drifted';
  END IF;

  -- Later CE/runtime data must not be orphaned by restoring conversations to NULL.
  IF EXISTS (SELECT 1 FROM public.conversation_evaluation)
     OR EXISTS (SELECT 1 FROM public.conversation_evaluation_attempt)
     OR EXISTS (SELECT 1 FROM public.ce_bundle_snapshot)
     OR EXISTS (SELECT 1 FROM public.evaluation_training_outbox) THEN
    RAISE EXCEPTION 'conversation rollback blocked: downstream CE lineage exists';
  END IF;
END
$guard$;

UPDATE public.upstream_call_log u
SET company_id=p.previous_company_id
FROM public.pr7_conversation_lineage_row p
WHERE p.run_id=current_setting('pr7.conversation_run_id')::uuid
  AND p.table_name='upstream_call_log'
  AND u.id=p.row_id;

UPDATE public.conversations c
SET company_id=p.previous_company_id
FROM public.pr7_conversation_lineage_row p
WHERE p.run_id=current_setting('pr7.conversation_run_id')::uuid
  AND p.table_name='conversations'
  AND c.id=p.row_id;

UPDATE public.pr7_conversation_lineage_run
SET rolled_back_at=now()
WHERE run_id=current_setting('pr7.conversation_run_id')::uuid;
COMMIT;
SQL

echo "PASS: conversation lineage exact rollback complete"
