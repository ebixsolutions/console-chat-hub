#!/bin/bash
set -Eeuo pipefail
DB_URL="${SUPABASE_DB_URL:-}"
COMPANY_UUID="${W2_T2_1_CANONICAL_COMPANY_UUID:-}"
PLATFORM_COMPANY_ID="${W2_T2_1_CANONICAL_PLATFORM_COMPANY_ID:-}"
RUN_ID="${W2_T2_1_RUN_ID:-}"
stop(){ echo "STOP: $1" >&2; exit 2; }
fail(){ echo "FAIL: $1" >&2; exit 1; }
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$COMPANY_UUID" ] || stop "company UUID missing"
[ -n "$PLATFORM_COMPANY_ID" ] || stop "platform company id missing"
[ -n "$RUN_ID" ] || stop "run id missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

OUT="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -Atq \
  -v company_uuid="$COMPANY_UUID" -v platform_company_id="$PLATFORM_COMPANY_ID" -v run_id="$RUN_ID" <<'SQL'
SELECT 'column|' || CASE WHEN EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema='public' AND table_name='company' AND column_name='platform_company_id'
    AND udt_name='int8' AND is_nullable='NO') THEN 'pass' ELSE 'fail' END;
SELECT 'unique|' || CASE WHEN EXISTS(
  SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='uq_company_platform_company_id'
    AND indexdef ILIKE '%UNIQUE%') THEN 'pass' ELSE 'fail' END;
SELECT 'company_count|' || CASE WHEN (SELECT count(*) FROM public.company)=1 THEN 'pass' ELSE 'fail' END;
SELECT 'identity|' || CASE WHEN EXISTS(
  SELECT 1 FROM public.company WHERE id=:'company_uuid'::uuid
    AND platform_company_id=:'platform_company_id'::bigint AND is_active=true)
  THEN 'pass' ELSE 'fail' END;
SELECT 'bootstrap|' || CASE WHEN EXISTS(
  SELECT 1 FROM public.pr7_company_identity_bootstrap_run
  WHERE run_id=:'run_id'::uuid AND company_uuid=:'company_uuid'::uuid
    AND platform_company_id=:'platform_company_id'::bigint
    AND completed_at IS NOT NULL AND rolled_back_at IS NULL)
  THEN 'pass' ELSE 'fail' END;
SELECT 'membership_scope|' || CASE WHEN (SELECT count(*) FROM public.company_membership)=0 THEN 'pass' ELSE 'fail' END;
SQL
)"
printf '%s\n' "$OUT"
for k in column unique company_count identity bootstrap membership_scope; do
  grep -q "^${k}|pass$" <<<"$OUT" || fail "$k"
done

echo "W2 TASK 2.1 RUNTIME STATUS: PASS"
