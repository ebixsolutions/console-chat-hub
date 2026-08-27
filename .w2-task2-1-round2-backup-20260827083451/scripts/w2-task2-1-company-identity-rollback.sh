#!/bin/bash
set -Eeuo pipefail
DB_URL="${SUPABASE_DB_URL:-}"
AUTH="${W2_T2_1_PRODUCTION_AUTHORIZED:-}"
RUN_ID="${W2_T2_1_RUN_ID:-}"
COMPANY_UUID="${W2_T2_1_CANONICAL_COMPANY_UUID:-}"
PLATFORM_COMPANY_ID="${W2_T2_1_CANONICAL_PLATFORM_COMPANY_ID:-}"

stop(){ echo "STOP: $1" >&2; exit 2; }
[ "$AUTH" = "YES" ] || stop "explicit production authorization missing"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$RUN_ID" ] || stop "run id missing"
[ -n "$COMPANY_UUID" ] || stop "company UUID missing"
[ -n "$PLATFORM_COMPANY_ID" ] || stop "platform company id missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

STATE="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -Atq \
  -v run_id="$RUN_ID" -v company_uuid="$COMPANY_UUID" -v platform_company_id="$PLATFORM_COMPANY_ID" <<'SQL'
SELECT CASE
 WHEN EXISTS(SELECT 1 FROM public.pr7_company_identity_bootstrap_run
   WHERE run_id=:'run_id'::uuid AND company_uuid=:'company_uuid'::uuid
     AND platform_company_id=:'platform_company_id'::bigint
     AND completed_at IS NOT NULL AND rolled_back_at IS NOT NULL) THEN 'rolled'
 WHEN EXISTS(SELECT 1 FROM public.pr7_company_identity_bootstrap_run
   WHERE run_id=:'run_id'::uuid AND company_uuid=:'company_uuid'::uuid
     AND platform_company_id=:'platform_company_id'::bigint
     AND completed_at IS NOT NULL AND rolled_back_at IS NULL) THEN 'active'
 ELSE 'missing' END;
SQL
)"
if [ "$STATE" = "rolled" ]; then echo "PASS bootstrap rollback already complete (idempotent no-op)"; exit 0; fi
[ "$STATE" = "active" ] || stop "active bootstrap provenance not found"

psql "$DB_URL" -v ON_ERROR_STOP=1 \
  -v run_id="$RUN_ID" -v company_uuid="$COMPANY_UUID" -v platform_company_id="$PLATFORM_COMPANY_ID" <<'SQL'
BEGIN;
SET LOCAL lock_timeout='10s';
DO $rb$
DECLARE
  rid uuid:=:'run_id'::uuid;
  cuid uuid:=:'company_uuid'::uuid;
  pid bigint:=:'platform_company_id'::bigint;
  created boolean;
BEGIN
  SELECT created_company INTO created
  FROM public.pr7_company_identity_bootstrap_run
  WHERE run_id=rid AND company_uuid=cuid AND platform_company_id=pid
    AND completed_at IS NOT NULL AND rolled_back_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'rollback provenance missing'; END IF;

  IF created THEN
    -- No CASCADE. Any downstream Task 2.2/2.3 or unrelated FK reference blocks rollback.
    DELETE FROM public.company WHERE id=cuid AND platform_company_id=pid;
    IF NOT FOUND THEN RAISE EXCEPTION 'canonical company row missing'; END IF;
  END IF;

  UPDATE public.pr7_company_identity_bootstrap_run SET rolled_back_at=now() WHERE run_id=rid;
END
$rb$;
COMMIT;
SQL

echo "PASS canonical company bootstrap rollback complete"
