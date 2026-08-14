#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
RUN_ID="${PR7_MEMBERSHIP_BOOTSTRAP_RUN_ID:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$RUN_ID" ] || stop "PR7_MEMBERSHIP_BOOTSTRAP_RUN_ID missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v run_id="$RUN_ID" \
  -v company_uuid="$COMPANY_UUID" <<'SQL'
\set QUIET 1
BEGIN;

SELECT set_config('pr7.membership_run_id', :'run_id', false);
SELECT set_config('pr7.company_uuid', :'company_uuid', false);

DO $guard$
DECLARE
  rid uuid:=current_setting('pr7.membership_run_id')::uuid;
  cid uuid:=current_setting('pr7.company_uuid')::uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.pr7_membership_bootstrap_run
    WHERE run_id=rid AND company_id=cid
      AND completed_at IS NOT NULL AND rolled_back_at IS NULL
  ) THEN
    RAISE EXCEPTION 'membership rollback provenance missing/already rolled back';
  END IF;

  -- Every row touched by the run must still equal the recorded state. If an
  -- admin changed a role/active state after bootstrap, fail closed rather than
  -- deleting or overwriting legitimate later work.
  IF EXISTS (
    SELECT 1
    FROM public.pr7_membership_bootstrap_row p
    LEFT JOIN public.company_membership cm ON cm.id=p.membership_id
    WHERE p.run_id=rid
      AND (
        cm.id IS NULL
        OR cm.company_id IS DISTINCT FROM p.company_id
        OR cm.user_id IS DISTINCT FROM p.user_id
        OR cm.role IS DISTINCT FROM p.role
        OR cm.is_active IS DISTINCT FROM p.is_active
      )
  ) THEN
    RAISE EXCEPTION 'membership rollback blocked: membership state changed after bootstrap';
  END IF;
END
$guard$;

DELETE FROM public.company_membership cm
USING public.pr7_membership_bootstrap_row p
WHERE p.run_id=current_setting('pr7.membership_run_id')::uuid
  AND p.created_by_run=true
  AND cm.id=p.membership_id;

DELETE FROM public.pr7_membership_bootstrap_row
WHERE run_id=current_setting('pr7.membership_run_id')::uuid;
DELETE FROM public.pr7_membership_bootstrap_run
WHERE run_id=current_setting('pr7.membership_run_id')::uuid;

COMMIT;
SQL

echo "PASS: canonical membership bootstrap exact rollback complete"
