#!/bin/bash
set -Eeuo pipefail
DB="${SUPABASE_DB_URL:-}"
CID="${PR7_CANONICAL_COMPANY_UUID:-}"
PID="${PR7_CANONICAL_PLATFORM_COMPANY_ID:-}"
UID="${PR11_PRIMARY_ACCEPTANCE_USER_UUID:-}"
stop(){ echo "STOP: $1"; exit 2; }
pass(){ echo "PASS $1"; }

[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
[[ "$CID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "canonical company UUID missing/invalid"
[[ "$PID" =~ ^[0-9]+$ ]] || stop "canonical platform company id missing/invalid"
[[ "$UID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "primary acceptance user UUID missing/invalid"
command -v psql >/dev/null 2>&1 || stop "psql missing"

ROW="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' -v cid="$CID" -v pid="$PID" -v uid="$UID" <<'SQL'
SELECT
 EXISTS(SELECT 1 FROM public.company WHERE id=:'cid'::uuid AND platform_company_id=:'pid'::bigint AND is_active),
 (SELECT count(*) FROM public.company_membership WHERE company_id=:'cid'::uuid AND user_id=:'uid'::uuid AND is_active),
 coalesce((SELECT role::text FROM public.company_membership
           WHERE company_id=:'cid'::uuid AND user_id=:'uid'::uuid AND is_active
           ORDER BY CASE role::text WHEN 'admin' THEN 1 WHEN 'supervisor' THEN 2 WHEN 'agent' THEN 3 WHEN 'qa' THEN 4 ELSE 99 END LIMIT 1),''),
 EXISTS(SELECT 1 FROM public.company_membership WHERE company_id=:'cid'::uuid AND role='admin'::public.app_role AND is_active);
SQL
)"
IFS='|' read -r COMPANY_OK MEMBERSHIP_COUNT ROLE ACTIVE_ADMIN <<<"$ROW"
[ "$COMPANY_OK" = "t" ] || stop "canonical UUID/integer company binding not active"
[ "$MEMBERSHIP_COUNT" = "1" ] || stop "primary acceptance user must have exactly one active canonical membership"
[ -n "$ROLE" ] || stop "primary acceptance user canonical role unresolved"
[ "$ACTIVE_ADMIN" = "t" ] || stop "canonical company has no active admin"

pass "canonical SU Platform UUID/integer identity active"
pass "primary frontend acceptance user has exactly one canonical membership"
pass "canonical role resolves without Preview fallback"
pass "canonical company has active admin"
echo "PR11 CANONICAL ROLE ACCEPTANCE STATUS: PASS"
