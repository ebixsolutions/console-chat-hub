#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
RUN_ID="${PR7_BOOTSTRAP_RUN_ID:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
PLATFORM_COMPANY_ID="${PR7_CANONICAL_PLATFORM_COMPANY_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$RUN_ID" ] || stop "PR7_BOOTSTRAP_RUN_ID missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$PLATFORM_COMPANY_ID" ] || stop "PR7_CANONICAL_PLATFORM_COMPANY_ID missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v run_id="$RUN_ID" \
  -v company_uuid="$COMPANY_UUID" \
  -v platform_company_id="$PLATFORM_COMPANY_ID" <<'SQL'
\set QUIET 1
BEGIN;

SELECT set_config('pr7.run_id', :'run_id', false);
SELECT set_config('pr7.company_uuid', :'company_uuid', false);
SELECT set_config('pr7.platform_company_id', :'platform_company_id', false);

DO $rollback$
DECLARE
  rid uuid:=current_setting('pr7.run_id')::uuid;
  cuid uuid:=current_setting('pr7.company_uuid')::uuid;
  pid bigint:=current_setting('pr7.platform_company_id')::bigint;
  v_created boolean;
BEGIN
  SELECT created_company INTO v_created
  FROM public.pr7_company_identity_bootstrap_run
  WHERE run_id=rid
    AND company_uuid=cuid
    AND platform_company_id=pid
    AND completed_at IS NOT NULL
    AND rolled_back_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap rollback provenance missing or identity mismatch';
  END IF;

  IF v_created THEN
    -- Do not cascade. Any Task 2.2/Workflow 3 or unrelated reference causes
    -- the delete to fail and the whole rollback transaction to remain intact.
    DELETE FROM public.company
    WHERE id=cuid AND platform_company_id=pid;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'canonical company created by this run is missing';
    END IF;
  END IF;

  DELETE FROM public.pr7_company_identity_bootstrap_run WHERE run_id=rid;
END
$rollback$;

COMMIT;
SQL

echo "PASS: Task 2.1 canonical company bootstrap rollback complete"
