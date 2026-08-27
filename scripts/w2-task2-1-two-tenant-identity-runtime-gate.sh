#!/bin/bash
set -Eeuo pipefail

DB="${SUPABASE_DB_URL:-}"
REPO="${W3_T3_3_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
CFG="$REPO/config/w3-task3-3-dev-identity.env"

stop(){ echo "STOP: $1" >&2; exit 2; }
fail(){ echo "FAIL: $1" >&2; exit 1; }
pass(){ echo "PASS $1"; }

[ -n "$DB" ] || stop "SUPABASE_DB_URL missing"
[ -s "$CFG" ] || stop "Director DEV identity config missing"
command -v psql >/dev/null 2>&1 || stop "psql missing"

source "$CFG"

A_UUID="${W2_T2_1_CANONICAL_COMPANY_UUID:-}"
A_PID="${W2_T2_1_CANONICAL_PLATFORM_COMPANY_ID:-}"
B_UUID="${PR10_TENANT_B_COMPANY_UUID:-}"
B_PID="${PR10_TENANT_B_PLATFORM_COMPANY_ID:-}"
A_ADMIN="${PR10_TENANT_A_USER_UUID:-}"
B_ADMIN="${PR10_TENANT_B_USER_UUID:-}"
B_CONV="${PR10_TENANT_B_CONVERSATION_UUID:-}"

[[ "$A_UUID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "Tenant A company UUID invalid"
[[ "$B_UUID" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "Tenant B company UUID invalid"
[[ "$A_PID" =~ ^[1-9][0-9]*$ ]] || stop "Tenant A platform company id invalid"
[[ "$B_PID" =~ ^[1-9][0-9]*$ ]] || stop "Tenant B platform company id invalid"
[[ "$A_ADMIN" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "Tenant A admin UUID invalid"
[[ "$B_ADMIN" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "Tenant B admin UUID invalid"
[[ "$B_CONV" =~ ^[0-9a-fA-F-]{36}$ ]] || stop "Tenant B conversation UUID invalid"

[ "$A_UUID" != "$B_UUID" ] || fail "Tenant A/B company UUID collision"
[ "$A_PID" != "$B_PID" ] || fail "Tenant A/B platform company id collision"

OUT="$(psql "$DB" -v ON_ERROR_STOP=1 -AtF '|' \
  -v au="$A_UUID" -v ap="$A_PID" \
  -v bu="$B_UUID" -v bp="$B_PID" \
  -v aa="$A_ADMIN" -v ba="$B_ADMIN" -v bc="$B_CONV" <<'SQL'
SELECT
  'companies',
  count(*) FILTER (WHERE id=:'au'::uuid AND platform_company_id=:'ap'::bigint AND is_active),
  count(*) FILTER (WHERE id=:'bu'::uuid AND platform_company_id=:'bp'::bigint AND is_active)
FROM public.company
WHERE id IN (:'au'::uuid,:'bu'::uuid);

SELECT
  'identity_collision',
  count(*)
FROM public.company
WHERE
  (id=:'au'::uuid AND platform_company_id<>:'ap'::bigint)
  OR
  (id=:'bu'::uuid AND platform_company_id<>:'bp'::bigint)
  OR
  (platform_company_id=:'ap'::bigint AND id<>:'au'::uuid)
  OR
  (platform_company_id=:'bp'::bigint AND id<>:'bu'::uuid);

SELECT
  'memberships',
  count(*) FILTER (
    WHERE company_id=:'au'::uuid AND user_id=:'aa'::uuid AND is_active
  ),
  count(*) FILTER (
    WHERE company_id=:'bu'::uuid AND user_id=:'ba'::uuid AND is_active
  )
FROM public.company_membership
WHERE company_id IN (:'au'::uuid,:'bu'::uuid);

SELECT
  'cross_membership',
  count(*)
FROM public.company_membership
WHERE
  (company_id=:'au'::uuid AND user_id=:'ba'::uuid)
  OR
  (company_id=:'bu'::uuid AND user_id=:'aa'::uuid);

SELECT
  'tenant_b_conversation',
  count(*)
FROM public.conversations
WHERE id=:'bc'::uuid AND company_id=:'bu'::uuid;

SELECT
  'unique_index',
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND indexname='uq_company_platform_company_id'
      AND indexdef ILIKE '%UNIQUE%'
  ) THEN 1 ELSE 0 END;
SQL
)"

printf '%s\n' "$OUT"

COMPANIES="$(awk -F'|' '$1=="companies"{print $2"|"$3}' <<<"$OUT")"
[ "$COMPANIES" = "1|1" ] || fail "configured Tenant A/B companies do not both resolve exactly once"

COLLISIONS="$(awk -F'|' '$1=="identity_collision"{print $2}' <<<"$OUT")"
[ "$COLLISIONS" = "0" ] || fail "company/platform identity collision detected"

MEMBERS="$(awk -F'|' '$1=="memberships"{print $2"|"$3}' <<<"$OUT")"
[ "$MEMBERS" = "1|1" ] || fail "configured Tenant A/B admin membership missing/duplicated"

CROSS="$(awk -F'|' '$1=="cross_membership"{print $2}' <<<"$OUT")"
[ "$CROSS" = "0" ] || fail "configured admins have cross-tenant membership"

BCONV="$(awk -F'|' '$1=="tenant_b_conversation"{print $2}' <<<"$OUT")"
[ "$BCONV" = "1" ] || fail "Tenant B fixture conversation is not tenant-bound"

UNIQUE="$(awk -F'|' '$1=="unique_index"{print $2}' <<<"$OUT")"
[ "$UNIQUE" = "1" ] || fail "platform company id unique index missing"

pass "fixed Tenant A/B company identities coexist"
pass "platform company ids are collision-free"
pass "configured admin memberships are tenant-separated"
pass "Tenant B fixture conversation is correctly tenant-bound"
echo "W2 TASK 2.1 TWO-TENANT IDENTITY STATUS: PASS"
