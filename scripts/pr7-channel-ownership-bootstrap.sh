#!/bin/bash
set -u
set -o pipefail

DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
SINGLE="${PR7_LEGACY_DATA_IS_SINGLE_COMPANY:-}"
RUN_ID="${PR7_CHANNEL_OWNERSHIP_RUN_ID:-}"
COMPANY_UUID="${PR7_CANONICAL_COMPANY_UUID:-}"
PLATFORM_COMPANY_ID="${PR7_CANONICAL_PLATFORM_COMPANY_ID:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ "$SINGLE" = "YES" ] || stop "legacy single-company ownership not explicitly confirmed"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$RUN_ID" ] || stop "PR7_CHANNEL_OWNERSHIP_RUN_ID missing"
[ -n "$COMPANY_UUID" ] || stop "PR7_CANONICAL_COMPANY_UUID missing"
[ -n "$PLATFORM_COMPANY_ID" ] || stop "PR7_CANONICAL_PLATFORM_COMPANY_ID missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

RUN_STATE="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -Atq \
  -v run_id="$RUN_ID" -v company_uuid="$COMPANY_UUID" <<'SQL'
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM public.pr7_channel_ownership_run
    WHERE run_id=:'run_id'::uuid
      AND company_id=:'company_uuid'::uuid
      AND completed_at IS NOT NULL
      AND rolled_back_at IS NULL
  ) THEN 'exact'
  WHEN EXISTS (
    SELECT 1 FROM public.pr7_channel_ownership_run
    WHERE run_id=:'run_id'::uuid
  ) THEN 'conflict'
  ELSE 'missing'
END;
SQL
)"
if [ "$RUN_STATE" = "exact" ]; then
  echo "PASS: channel ownership already bound (idempotent no-op)"
  exit 0
fi
[ "$RUN_STATE" != "conflict" ] || stop "channel ownership run_id conflict or already rolled back"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v run_id="$RUN_ID" \
  -v company_uuid="$COMPANY_UUID" \
  -v platform_company_id="$PLATFORM_COMPANY_ID" <<'SQL'
\set QUIET 1
BEGIN;

SELECT set_config('pr7.channel_run_id', :'run_id', false);
SELECT set_config('pr7.company_uuid', :'company_uuid', false);
SELECT set_config('pr7.platform_company_id', :'platform_company_id', false);

DO $precheck$
DECLARE
  cid uuid:=current_setting('pr7.company_uuid')::uuid;
  pid bigint:=current_setting('pr7.platform_company_id')::bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.company
    WHERE id=cid AND platform_company_id=pid AND is_active=true
  ) THEN
    RAISE EXCEPTION 'channel ownership refused: canonical company identity missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.company_membership
    WHERE company_id=cid
      AND role='admin'::public.app_role
      AND is_active=true
  ) THEN
    RAISE EXCEPTION 'channel ownership refused: canonical company has no active admin';
  END IF;

  -- Any channel already bound elsewhere invalidates the single-company premise.
  IF EXISTS (
    SELECT 1 FROM public.channel_config
    WHERE company_id IS NOT NULL AND company_id<>cid
  ) THEN
    RAISE EXCEPTION 'channel ownership refused: foreign company channel exists';
  END IF;

  -- Task 3.1 must run before conversation backfill. Existing non-null
  -- conversation ownership would make channel-only rollback ambiguous.
  IF EXISTS (
    SELECT 1 FROM public.conversations
    WHERE company_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'channel ownership refused: conversation ownership already started; Task 3.1 ordering violated';
  END IF;
END
$precheck$;

INSERT INTO public.pr7_channel_ownership_run(run_id,company_id)
VALUES(
  current_setting('pr7.channel_run_id')::uuid,
  current_setting('pr7.company_uuid')::uuid
);

INSERT INTO public.pr7_channel_ownership_row(
  run_id,channel_id,previous_company_id,assigned_company_id
)
SELECT
  current_setting('pr7.channel_run_id')::uuid,
  cc.id,
  cc.company_id,
  current_setting('pr7.company_uuid')::uuid
FROM public.channel_config cc;

UPDATE public.channel_config
SET company_id=current_setting('pr7.company_uuid')::uuid
WHERE company_id IS NULL;

DO $assert$
DECLARE
  cid uuid:=current_setting('pr7.company_uuid')::uuid;
  recorded int;
  actual int;
BEGIN
  SELECT count(*) INTO recorded
  FROM public.pr7_channel_ownership_row
  WHERE run_id=current_setting('pr7.channel_run_id')::uuid;

  SELECT count(*) INTO actual FROM public.channel_config;

  IF recorded<>actual THEN
    RAISE EXCEPTION
      'channel ownership assertion: provenance rows % <> channel rows %',
      recorded,actual;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.channel_config
    WHERE company_id IS NULL OR company_id<>cid
  ) THEN
    RAISE EXCEPTION 'channel ownership assertion: not all channels are canonical';
  END IF;

  -- Explicit Task 3.1 scope check.
  IF EXISTS (
    SELECT 1 FROM public.conversations
    WHERE company_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'channel ownership scope violation: conversation.company_id changed';
  END IF;
END
$assert$;

UPDATE public.pr7_channel_ownership_run
SET completed_at=now()
WHERE run_id=current_setting('pr7.channel_run_id')::uuid;

COMMIT;
SQL

echo "PASS: legacy channel ownership bound to canonical company"
echo "No conversation.company_id was modified."
