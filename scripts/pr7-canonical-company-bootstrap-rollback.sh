#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
RUN_ID="${PR7_BOOTSTRAP_RUN_ID:-}"
COMPANY_ID="${PR7_CANONICAL_COMPANY_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$RUN_ID" ] || stop "PR7_BOOTSTRAP_RUN_ID missing"
[ -n "$COMPANY_ID" ] || stop "PR7_CANONICAL_COMPANY_ID missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

psql "$DB_URL" -v ON_ERROR_STOP=1 -v run_id="$RUN_ID" -v company_id="$COMPANY_ID" <<'SQL'
\set QUIET 1
BEGIN;
SELECT set_config('pr7.run_id', :'run_id', false);
SELECT set_config('pr7.company_id', :'company_id', false);

DO $$
DECLARE rid uuid:=current_setting('pr7.run_id')::uuid;
        cid uuid:=current_setting('pr7.company_id')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.pr7_canonical_bootstrap_run
    WHERE run_id=rid AND company_id=cid AND completed_at IS NOT NULL AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'bootstrap rollback provenance missing/already rolled back';
  END IF;
END $$;

UPDATE public.channel_config t SET company_id=p.previous_company_id
FROM public.pr7_canonical_bootstrap_row p
WHERE p.run_id=current_setting('pr7.run_id')::uuid
  AND p.table_name='channel_config' AND t.id=p.row_id;

UPDATE public.conversations t SET company_id=p.previous_company_id
FROM public.pr7_canonical_bootstrap_row p
WHERE p.run_id=current_setting('pr7.run_id')::uuid
  AND p.table_name='conversations' AND t.id=p.row_id;

UPDATE public.upstream_call_log t SET company_id=p.previous_company_id
FROM public.pr7_canonical_bootstrap_row p
WHERE p.run_id=current_setting('pr7.run_id')::uuid
  AND p.table_name='upstream_call_log' AND t.id=p.row_id;

UPDATE public.conversation_evaluation t SET company_id=p.previous_company_id
FROM public.pr7_canonical_bootstrap_row p
WHERE p.run_id=current_setting('pr7.run_id')::uuid
  AND p.table_name='conversation_evaluation' AND t.id=p.row_id;

UPDATE public.conversation_evaluation_attempt t SET company_id=p.previous_company_id
FROM public.pr7_canonical_bootstrap_row p
WHERE p.run_id=current_setting('pr7.run_id')::uuid
  AND p.table_name='conversation_evaluation_attempt' AND t.id=p.row_id;

UPDATE public.ce_bundle_snapshot t SET company_id=p.previous_company_id
FROM public.pr7_canonical_bootstrap_row p
WHERE p.run_id=current_setting('pr7.run_id')::uuid
  AND p.table_name='ce_bundle_snapshot' AND t.id=p.row_id;

UPDATE public.evaluation_training_outbox t SET company_id=p.previous_company_id
FROM public.pr7_canonical_bootstrap_row p
WHERE p.run_id=current_setting('pr7.run_id')::uuid
  AND p.table_name='evaluation_training_outbox' AND t.id=p.row_id;

DELETE FROM public.company_membership cm
USING public.pr7_canonical_bootstrap_membership p
WHERE p.run_id=current_setting('pr7.run_id')::uuid
  AND cm.id=p.membership_id;

-- Delete company only if this run created it. FK constraints intentionally make
-- rollback fail rather than delete unrelated/new data.
DELETE FROM public.company c
USING public.pr7_canonical_bootstrap_company p
WHERE p.run_id=current_setting('pr7.run_id')::uuid
  AND c.id=p.company_id
  AND c.id=current_setting('pr7.company_id')::uuid;

-- Exact rollback requires removing bootstrap-only governance artifacts too.
-- Delete this run's provenance first, then drop the four bootstrap tables only
-- when no other run exists. In the supported deployment flow there is exactly
-- one run; if another run is present, fail closed rather than destroy evidence.
DELETE FROM public.pr7_canonical_bootstrap_membership
WHERE run_id=current_setting('pr7.run_id')::uuid;
DELETE FROM public.pr7_canonical_bootstrap_row
WHERE run_id=current_setting('pr7.run_id')::uuid;
DELETE FROM public.pr7_canonical_bootstrap_company
WHERE run_id=current_setting('pr7.run_id')::uuid;
DELETE FROM public.pr7_canonical_bootstrap_run
WHERE run_id=current_setting('pr7.run_id')::uuid;

DO $$
DECLARE v_remaining int;
BEGIN
  SELECT count(*) INTO v_remaining FROM public.pr7_canonical_bootstrap_run;
  IF v_remaining<>0 THEN
    RAISE EXCEPTION 'exact rollback refused: % other bootstrap runs remain',v_remaining;
  END IF;
END $$;

DROP TABLE public.pr7_canonical_bootstrap_membership;
DROP TABLE public.pr7_canonical_bootstrap_row;
DROP TABLE public.pr7_canonical_bootstrap_company;
DROP TABLE public.pr7_canonical_bootstrap_run;

COMMIT;
SQL

echo "PASS: canonical bootstrap exact rollback complete"
