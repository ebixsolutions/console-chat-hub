#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
RUN_ID="${PR7_CHANNEL_OWNERSHIP_RUN_ID:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$RUN_ID" ] || stop "PR7_CHANNEL_OWNERSHIP_RUN_ID missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

ROLLBACK_STATE="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -Atq \
  -v run_id="$RUN_ID" -v company_uuid="$COMPANY_UUID" <<'SQL'
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM public.pr7_channel_ownership_run
    WHERE run_id=:'run_id'::uuid
      AND company_id=:'company_uuid'::uuid
      AND completed_at IS NOT NULL
      AND rolled_back_at IS NOT NULL
  ) THEN 'rolled'
  WHEN EXISTS (
    SELECT 1 FROM public.pr7_channel_ownership_run
    WHERE run_id=:'run_id'::uuid
      AND company_id=:'company_uuid'::uuid
      AND completed_at IS NOT NULL
      AND rolled_back_at IS NULL
  ) THEN 'active'
  WHEN EXISTS (
    SELECT 1 FROM public.pr7_channel_ownership_run
    WHERE run_id=:'run_id'::uuid
  ) THEN 'conflict'
  ELSE 'missing'
END;
SQL
)"
if [ "$ROLLBACK_STATE" = "rolled" ]; then
  echo "PASS: channel ownership already rolled back (idempotent no-op)"
  exit 0
fi
[ "$ROLLBACK_STATE" = "active" ] || stop "channel rollback provenance missing or identity mismatch"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v run_id="$RUN_ID" \
  -v company_uuid="$COMPANY_UUID" <<'SQL'
\set QUIET 1
BEGIN;

SELECT set_config('pr7.channel_run_id', :'run_id', false);
SELECT set_config('pr7.company_uuid', :'company_uuid', false);

DO $guard$
DECLARE
  rid uuid:=current_setting('pr7.channel_run_id')::uuid;
  cid uuid:=current_setting('pr7.company_uuid')::uuid;
BEGIN
  -- If Task 3.2 has begun, restoring channel ownership to NULL would break
  -- canonical lineage. Fail closed rather than roll back through later work.
  IF EXISTS (
    SELECT 1 FROM public.conversations
    WHERE company_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'channel rollback blocked: downstream conversation ownership exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.pr7_channel_ownership_row p
    LEFT JOIN public.channel_config cc ON cc.id=p.channel_id
    WHERE p.run_id=rid
      AND (
        cc.id IS NULL
        OR cc.company_id IS DISTINCT FROM p.assigned_company_id
      )
  ) THEN
    RAISE EXCEPTION
      'channel rollback blocked: channel ownership changed after bootstrap';
  END IF;
END
$guard$;

UPDATE public.channel_config cc
SET company_id=p.previous_company_id
FROM public.pr7_channel_ownership_row p
WHERE p.run_id=current_setting('pr7.channel_run_id')::uuid
  AND cc.id=p.channel_id;

UPDATE public.pr7_channel_ownership_run
SET rolled_back_at=now()
WHERE run_id=current_setting('pr7.channel_run_id')::uuid;

COMMIT;
SQL

echo "PASS: channel ownership exact rollback complete"
