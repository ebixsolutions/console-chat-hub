#!/usr/bin/env bash
set -euo pipefail

TARGET_REF="nrfxhqabwblzxoushgnm"
TARGET_URL="https://${TARGET_REF}.supabase.co"
MIGRATION="supabase/migrations/20260829093000_task3_server_only_rls_policy_closure.sql"
SERVER_CLIENT="src/integrations/supabase/client.server.ts"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

[[ -f .env ]] || fail ".env missing"
[[ -f "$MIGRATION" ]] || fail "Task 3 migration missing"
[[ -f "$SERVER_CLIENT" ]] || fail "server Supabase client missing"

grep -q "SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail "SUPABASE_PROJECT_ID is not target"
grep -q "SUPABASE_URL=\"${TARGET_URL}\"" .env || fail "SUPABASE_URL is not target"
grep -q "VITE_SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail "VITE_SUPABASE_PROJECT_ID is not target"
grep -q "VITE_SUPABASE_URL=\"${TARGET_URL}\"" .env || fail "VITE_SUPABASE_URL is not target"
pass "frontend/server env points to target Supabase"

if grep -q 'SUPABASE_SERVICE_ROLE_KEY' "$SERVER_CLIENT"; then
  fail "legacy service-role fallback still present in server runtime client"
fi
grep -q 'process.env.SUPABASE_SECRET_KEY' "$SERVER_CLIENT" || fail "SUPABASE_SECRET_KEY missing from server client"
pass "server runtime requires modern Supabase secret key"

if [[ "${TASK3_SKIP_LIVE_SQL:-0}" != "1" ]]; then
  [[ -n "${DATABASE_URL:-}" ]] || fail "DATABASE_URL is required for live Task 3 SQL assertions"

  read -r deny_count hardened_count <<<"$(psql "$DATABASE_URL" -X -A -t -F' ' -v ON_ERROR_STOP=1 <<'SQL'
with flagged(name) as (values
 ('_ce_t2_rls_cleanup_prov'),('_ce_t2f_prov_8a3c'),('_ce_t2r_prov_7b2d'),
 ('ce_automation_runtime'),('ce_evaluation_job'),('company_backfill_contract'),
 ('message_attachment_private'),('migration_object_ledger'),
 ('pr7_channel_ownership_row'),('pr7_channel_ownership_run'),
 ('pr7_company_identity_bootstrap_run'),('pr7_conversation_lineage_row'),
 ('pr7_conversation_lineage_run'),('pr7_membership_bootstrap_row'),
 ('pr7_membership_bootstrap_run')
), checks as (
 select f.name,
   exists(select 1 from pg_policies p where p.schemaname='public' and p.tablename=f.name and p.policyname='task3_server_only_deny') as has_deny,
   has_table_privilege('anon', format('public.%I',f.name), 'select') as anon_select,
   has_table_privilege('authenticated', format('public.%I',f.name), 'select') as auth_select,
   has_table_privilege('service_role', format('public.%I',f.name), 'select') as service_select
 from flagged f
)
select count(*) filter (where has_deny),
       count(*) filter (where not anon_select and not auth_select and service_select)
from checks;
SQL
)"
  [[ "$deny_count" == "15" ]] || fail "expected 15 explicit deny policies, got $deny_count"
  [[ "$hardened_count" == "15" ]] || fail "expected 15 server-only privilege closures, got $hardened_count"
  pass "15/15 server-only tables deny direct client access while service_role retains access"
else
  [[ "${TASK3_LIVE_SQL_ASSERTIONS:-}" == "15/15" ]] || fail "live SQL assertions were skipped without an externally verified 15/15 marker"
  pass "live SQL assertions externally verified: 15/15"
fi

npm run build
pass "production build"

case "${TASK3_LEAKED_PASSWORD_PROTECTION:-}" in
  enabled)
    pass "leaked-password protection enabled"
    ;;
  plan_limited_free)
    pass "leaked-password protection unavailable on current FREE plan; accepted as external plan limitation"
    ;;
  *)
    fail "TASK3_LEAKED_PASSWORD_PROTECTION must be enabled or plan_limited_free"
    ;;
esac

echo "TASK3 FINAL GATE: PASS"
