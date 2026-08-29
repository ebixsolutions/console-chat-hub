#!/usr/bin/env bash
set -euo pipefail

TARGET_REF="nrfxhqabwblzxoushgnm"
TARGET_URL="https://${TARGET_REF}.supabase.co"
MIGRATION="supabase/migrations/20260829142515_task1_3_final_source_closure.sql"
ADMIN_KEY_HELPER="supabase/functions/_shared/supabase-admin-key.ts"
CORS="supabase/functions/_shared/cors.ts"
CREATE_SESSION="supabase/functions/create-visitor-session/index.ts"
RECEIVE="supabase/functions/receive-widget-message/index.ts"
POLL="supabase/functions/widget-poll-messages/index.ts"
PUBLIC_CONFIG="supabase/functions/get-public-widget-config/index.ts"
SERVER_CLIENT="src/integrations/supabase/client.server.ts"
BROWSER_CLIENT="src/integrations/supabase/client.ts"

fail(){ echo "FAIL: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }

for f in .env "$MIGRATION" "$ADMIN_KEY_HELPER" "$CORS" "$CREATE_SESSION" "$RECEIVE" "$POLL" "$PUBLIC_CONFIG" "$SERVER_CLIENT" "$BROWSER_CLIENT"; do
  [[ -f "$f" ]] || fail "missing $f"
done

grep -q "SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail "server project id is not target"
grep -q "SUPABASE_URL=\"${TARGET_URL}\"" .env || fail "server URL is not target"
grep -q "VITE_SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail "browser project id is not target"
grep -q "VITE_SUPABASE_URL=\"${TARGET_URL}\"" .env || fail "browser URL is not target"
pass "target Supabase URLs"

if grep -q 'SUPABASE_SECRET_KEY' .env; then fail "secret must not be tracked in .env"; fi
if grep -q 'SUPABASE_SECRET_KEY' "$BROWSER_CLIENT"; then fail "browser client references secret"; fi
grep -q 'process.env.SUPABASE_SECRET_KEY' "$SERVER_CLIENT" || fail "server client singular secret integration missing"
grep -q 'Deno.env.get("SUPABASE_SECRET_KEY")' "$ADMIN_KEY_HELPER" || fail "Edge singular secret integration missing"
grep -q 'SUPABASE_SERVICE_ROLE_KEY' "$ADMIN_KEY_HELPER" || fail "Supabase Edge built-in service fallback missing"
pass "SUPABASE_SECRET_KEY remains server-only"

grep -q 'idempotency-key' "$CORS" || fail "idempotency-key CORS missing"
grep -q 'p_client_message_id' "$RECEIVE" || fail "receive caller client idempotency missing"
grep -q 'idempotent' "$RECEIVE" || fail "receive idempotent result handling missing"
grep -q 'p_page_url: originCheck.origin' "$CREATE_SESSION" || fail "atomic origin handoff missing"
for f in "$CREATE_SESSION" "$RECEIVE" "$POLL" "$PUBLIC_CONFIG"; do
  grep -q 'getSupabaseAdminKey' "$f" || fail "admin key helper missing in $f"
done
pass "widget Edge source call chain"

grep -q "messages_widget_client_message_id_uq" "$MIGRATION" || fail "idempotency index missing"
grep -q "'video'::text" "$MIGRATION" || fail "video message contract missing"
grep -q "origin_not_allowed" "$MIGRATION" || fail "atomic origin guard missing"
grep -q "NULL::text" "$MIGRATION" || fail "legacy receive wrapper missing"
grep -q "'delivered',false" "$MIGRATION" || fail "attachment delivered status contract missing"
grep -q "REVOKE ALL ON FUNCTION public.receive_widget_message_tx(uuid,text,text,text) FROM PUBLIC,anon,authenticated" "$MIGRATION" || fail "4-arg inbound RPC revoke missing"
pass "final migration security/runtime contract"

[[ -n "${TASK13_LIVE_MIGRATION_SHA256:-}" ]] || fail "live migration hash marker missing"
SOURCE_SHA="$(python - "$MIGRATION" <<'PY'
import hashlib, pathlib, sys
b=pathlib.Path(sys.argv[1]).read_bytes().rstrip()
print(hashlib.sha256(b).hexdigest())
PY
)"
[[ "$SOURCE_SHA" == "$TASK13_LIVE_MIGRATION_SHA256" ]] || fail "GitHub migration hash differs from live ledger"
pass "GitHub migration hash matches live ledger"

[[ "${TASK13_DB_ASSERTIONS:-}" == "fn=4;hardened=4;idem=1;video=1;wrapper=1;company_mismatch=0;channel_mismatch=0" ]] || fail "live DB assertion marker mismatch"
[[ "${TASK13_RUNTIME_MATRIX:-}" == "PASS" ]] || fail "rollback-safe runtime matrix marker missing"
[[ "${TASK13_EDGE_ASSERTIONS:-}" == "create=v7;config=v7;poll=v7;receive=v7;all_active=1;all_public_custom_auth=1" ]] || fail "deployed Edge assertion marker mismatch"
[[ "${TASK13_PUBLIC_EDGE_SMOKE:-}" == "PASS" ]] || fail "public Edge smoke marker missing"
pass "live DB/runtime/Edge assertions"

npm run build
pass "production build"

echo "TASK 1.3 FINAL GATE: PASS"
