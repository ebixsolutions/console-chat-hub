#!/bin/bash
set -Eeuo pipefail

DB_URL="${SUPABASE_DB_URL:-}"
stop(){ echo "STOP: $1"; exit 2; }

[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "${CUSTOMER360_API_URL:-}" ] || stop "Customer360 upstream URL missing"
[ -n "${CUSTOMER360_API_TOKEN:-}" ] || stop "Customer360 upstream token missing"
[ -n "${CUSTOMER360_INTERNAL_TOKEN:-}" ] || stop "Customer360 internal token missing"
[ "${ENABLE_CUSTOMER360_ADAPTER:-false}" = "true" ] || stop "Customer360 adapter feature flag not enabled"
command -v psql >/dev/null 2>&1 || stop "psql missing"

COUNT="$(psql "$DB_URL" -v ON_ERROR_STOP=1 -Atq <<'SQL'
SELECT count(*)
FROM public.conversations c
JOIN public.visitor_session vs ON vs.id=c.visitor_session_id
WHERE c.company_id IS NOT NULL
  AND coalesce(vs.visitor_metadata->>'customer_ref','') <> ''
  AND (
    (vs.visitor_metadata->>'customer_ref') ~ '^cus_[A-Za-z0-9_-]{16,64}$'
    OR
    (vs.visitor_metadata->>'customer_ref') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
SQL
)"
[ "${COUNT:-0}" -ge 1 ] || stop "no canonical conversation has an approved opaque customer_ref fixture"

echo "PASS Customer360 upstream configuration present"
echo "PASS at least one canonical opaque customer_ref fixture exists"
echo "READY for Task 5.2 caller/runtime integration smoke"
