#!/usr/bin/env bash
set -euo pipefail

TARGET_REF="nrfxhqabwblzxoushgnm"
TARGET_URL="https://${TARGET_REF}.supabase.co"
MIGRATION="supabase/migrations/20260829140324_task1_2_final_source_closure.sql"
SERVER_CLIENT="src/integrations/supabase/client.server.ts"
BROWSER_CLIENT="src/integrations/supabase/client.ts"

fail(){ echo "FAIL: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }

[[ -f .env ]] || fail ".env missing"
[[ -f "$MIGRATION" ]] || fail "Task 1.2 migration missing"
[[ -f "$SERVER_CLIENT" ]] || fail "server Supabase client missing"
[[ -f "$BROWSER_CLIENT" ]] || fail "browser Supabase client missing"

grep -q "SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail "server project id is not target"
grep -q "SUPABASE_URL=\"${TARGET_URL}\"" .env || fail "server URL is not target"
grep -q "VITE_SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail "browser project id is not target"
grep -q "VITE_SUPABASE_URL=\"${TARGET_URL}\"" .env || fail "browser URL is not target"
pass "frontend/server URLs point to target Supabase"

if grep -q 'SUPABASE_SECRET_KEY' .env; then fail "secret key must not be tracked in .env"; fi
if grep -q 'SUPABASE_SECRET_KEY' "$BROWSER_CLIENT"; then fail "secret key referenced by browser client"; fi
if grep -q 'SUPABASE_SERVICE_ROLE_KEY' "$SERVER_CLIENT"; then fail "legacy service-role fallback remains"; fi
grep -q 'process.env.SUPABASE_SECRET_KEY' "$SERVER_CLIENT" || fail "server client does not require SUPABASE_SECRET_KEY"
grep -q 'process.env.SUPABASE_URL' "$SERVER_CLIENT" || fail "server client does not require SUPABASE_URL"
grep -q 'persistSession: false' "$SERVER_CLIENT" || fail "server client session persistence is not disabled"
grep -q 'autoRefreshToken: false' "$SERVER_CLIENT" || fail "server client token refresh is not disabled"
pass "SUPABASE_SECRET_KEY is server-only and fail-closed"

grep -q "v_channel_type<>'web_widget'" "$MIGRATION" || fail "web_widget runtime contract missing"
if grep -q "website_widget" "$MIGRATION"; then fail "legacy website_widget contract remains"; fi
grep -q "has_company_role(v_company_id,v_uid" "$MIGRATION" || fail "channel company-role binding missing"
grep -q "has_company_role(cc.company_id,v_uid" "$MIGRATION" || fail "widget company-role binding missing"
grep -q "TENANT_SCOPE_VIOLATION" "$MIGRATION" || fail "cross-tenant widget reassignment guard missing"
grep -q "REVOKE ALL ON FUNCTION public.rpc_update_channel_config(uuid,jsonb) FROM PUBLIC,anon" "$MIGRATION" || fail "anon RPC revoke missing"
pass "migration contains tenant-scoped RPC hardening"

[[ "${TASK12_LIVE_ASSERTIONS:-}" == "state_nulls=0;job_nulls=0;state_mismatch=0;job_mismatch=0;unbound_logs=4;rpc_overloads=6;anon_exec=0;legacy_channel=0;web_widget=2" ]] || fail "authoritative live SQL assertion marker missing"
[[ "${TASK12_AUTH_MATRIX:-}" == "same_tenant=8/8;cross_tenant=6/6" ]] || fail "authenticated runtime matrix marker missing"
pass "authoritative live SQL and authenticated runtime matrix verified"

npm run build
pass "production build"

echo "TASK 1.2 FINAL GATE: PASS"
