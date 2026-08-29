#!/usr/bin/env bash
set -euo pipefail
TARGET_REF="nrfxhqabwblzxoushgnm"
MIGRATION="supabase/migrations/20260829143602_task2_1_company_identity_activation.sql"
SERVER_CLIENT="src/integrations/supabase/client.server.ts"
BROWSER_CLIENT="src/integrations/supabase/client.ts"
fail(){ echo "FAIL: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }
for f in .env "$MIGRATION" "$SERVER_CLIENT" "$BROWSER_CLIENT"; do [[ -f "$f" ]] || fail "missing $f"; done
grep -q "SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail "wrong target project"
if grep -q 'SUPABASE_SECRET_KEY' .env; then fail "secret tracked in .env"; fi
if grep -q 'SUPABASE_SECRET_KEY' "$BROWSER_CLIENT"; then fail "browser references secret"; fi
grep -q 'process.env.SUPABASE_SECRET_KEY' "$SERVER_CLIENT" || fail "server secret integration missing"
pass "target and server-only secret integration"
grep -q 'company_membership_user_id_fkey' "$MIGRATION" || fail "membership auth FK missing"
grep -q 'company_platform_company_id_uq' "$MIGRATION" || fail "platform identity unique index missing"
grep -q 'company_platform_company_id_positive_check' "$MIGRATION" || fail "platform identity positive check missing"
grep -q 'TASK2_1_CROSS_MEMBERSHIPS' "$MIGRATION" || fail "cross-membership assertion missing"
grep -q 'TASK2_1_TENANT2_CONVERSATION_COUNT' "$MIGRATION" || fail "tenant2 binding assertion missing"
pass "company identity migration contract"
[[ "${TASK21_LIVE_MIGRATION_SHA256:-}" == "1b826af38b5f2bd84e8a3968b2f1cbf45210f02af770539b7237945f59993150" ]] || fail "live migration hash marker mismatch"
SOURCE_SHA="$(python - "$MIGRATION" <<'PY'
import hashlib,pathlib,sys
print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes().rstrip()).hexdigest())
PY
)"
[[ "$SOURCE_SHA" == "$TASK21_LIVE_MIGRATION_SHA256" ]] || fail "source/live migration hash mismatch"
[[ "${TASK21_DB_ASSERTIONS:-}" == "companies=2;orphans=0;cross=0;legacy=0;company_channel=0;session_channel=0;tenant2=1;fk=1;platform_uq=1;platform_check=1" ]] || fail "DB assertions marker mismatch"
[[ "${TASK21_AUTH_TENANT_NEGATIVE:-}" == "PASS" ]] || fail "authenticated tenant negative proof missing"
[[ "${TASK21_ROLLBACK_PROOF:-}" == "fk=1;index=1;check=1" ]] || fail "rollback proof marker mismatch"
pass "live identity/tenant/rollback assertions"
npm run build
pass "production build"
echo "TASK 2.1 FINAL GATE: PASS"
