#!/bin/bash
set -Eeuo pipefail

DB_URL="${SUPABASE_DB_URL:-}"
ADMIN_EMAIL="${PR7_RUNTIME_ADMIN_EMAIL:-}"

stop(){ echo "STOP: $1"; exit 2; }
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$ADMIN_EMAIL" ] || stop "PR7_RUNTIME_ADMIN_EMAIL missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

# Source chain must remain canonical company_membership authority.
for f in src/lib/api/config.service.ts src/hooks/useCurrentRole.ts src/routes/_authenticated/console.tsx; do
  [ -s "$f" ] || stop "required Console role source missing: $f"
done

grep -Fq '.from("company_membership")' src/lib/api/config.service.ts \
  || stop "authService no longer resolves role from company_membership"
grep -Fq 'authService.getCurrentUserRole()' src/hooks/useCurrentRole.ts \
  || stop "useCurrentRole no longer uses canonical authService"
grep -Fq 'const sidebarRole: string | null = import.meta.env.DEV ? demoRole : (role ?? null);' src/routes/_authenticated/console.tsx \
  || stop "production Console role is not canonical role"
grep -Fq 'No Assigned Role' src/routes/_authenticated/console.tsx \
  || stop "truthful unresolved-role UI marker missing"

# Admin-only features that previously disappeared when canonical membership was absent.
for marker in \
  'path: "/console/kb-gaps"' \
  'path: "/console/customer360"' \
  'path: "/console/visitor-analytics"' \
  'path: "/console/settings/llm-runtime"'
do
  grep -Fq "$marker" src/routes/_authenticated/console.tsx \
    || stop "required admin navigation marker missing: $marker"
done

# Never restore role authority from agent_profile.role.
if grep -Eq 'agent_profile[^
]*role|select\([^)]*role[^)]*\).*agent_profile' src/lib/api/config.service.ts; then
  stop "legacy agent_profile.role authority detected"
fi

ROW="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -AtF '|' -v admin_email="$ADMIN_EMAIL" <<'SQL'
WITH target AS (
  SELECT u.id AS user_id
  FROM auth.users u
  WHERE lower(u.email)=lower(:'admin_email')
),
active_membership AS (
  SELECT cm.user_id,cm.company_id,cm.role,cm.is_active
  FROM public.company_membership cm
  JOIN target t ON t.user_id=cm.user_id
  WHERE cm.is_active=true
),
active_company AS (
  SELECT c.id,c.is_active
  FROM public.company c
)
SELECT
  (SELECT count(*) FROM target),
  (SELECT count(*) FROM active_membership),
  coalesce((SELECT role FROM active_membership LIMIT 1),''),
  coalesce((SELECT company_id::text FROM active_membership LIMIT 1),''),
  coalesce((
    SELECT c.is_active::text
    FROM active_membership m
    JOIN active_company c ON c.id=m.company_id
    LIMIT 1
  ),'false');
SQL
)"

IFS='|' read -r USER_COUNT MEMBERSHIP_COUNT ROLE COMPANY_ID COMPANY_ACTIVE <<<"$ROW"

[ "$USER_COUNT" = "1" ] || stop "runtime admin auth fixture unresolved/ambiguous"
[ "$MEMBERSHIP_COUNT" = "1" ] || stop "runtime admin must have exactly one active company membership"
[ "$ROLE" = "admin" ] || stop "runtime admin canonical role is not admin"
[ -n "$COMPANY_ID" ] || stop "runtime admin company unresolved"
[ "$COMPANY_ACTIVE" = "true" ] || stop "runtime admin company inactive"

echo "PASS runtime admin auth user resolved"
echo "PASS exactly one active company membership"
echo "PASS canonical role = admin"
echo "PASS canonical company active"
echo "PASS Console role chain uses company_membership authority"
echo "PASS admin navigation source markers present"
echo "PASS legacy agent_profile.role authority absent"
# Never print email, user id or company id.
