#!/usr/bin/env bash
set -euo pipefail
TARGET_REF="nrfxhqabwblzxoushgnm"
MIGRATION="supabase/migrations/20260829144752_task2_2_canonical_ce_integrity_closure.sql"
EDGE="supabase/functions/conversation-evaluate/index.ts"
AUTO="supabase/functions/_shared/ce-automation-engine.ts"
SERVER_CLIENT="src/integrations/supabase/client.server.ts"
BROWSER_CLIENT="src/integrations/supabase/client.ts"
fail(){ echo "FAIL: $*" >&2; exit 1; }
pass(){ echo "PASS: $*"; }
for f in .env "$MIGRATION" "$EDGE" "$AUTO" "$SERVER_CLIENT" "$BROWSER_CLIENT"; do [[ -f "$f" ]] || fail "missing $f"; done
grep -q "SUPABASE_PROJECT_ID=\"${TARGET_REF}\"" .env || fail "wrong target project"
if grep -q 'SUPABASE_SECRET_KEY' .env; then fail "secret tracked in .env"; fi
if grep -q 'SUPABASE_SECRET_KEY' "$BROWSER_CLIENT"; then fail "browser references secret"; fi
grep -q 'process.env.SUPABASE_SECRET_KEY' "$SERVER_CLIENT" || fail "server secret integration missing"
pass "target and server-only secret integration"
grep -q 'admin.rpc("complete_evaluation_v2"' "$EDGE" || fail "interactive CE not on v2 completion"
grep -q 'admin.rpc("complete_evaluation_v2"' "$AUTO" || fail "automation CE not on v2 completion"
if grep -q 'admin.rpc("complete_evaluation"' "$EDGE"; then fail "interactive CE calls legacy completion"; fi
pass "canonical CE callers use v2"
for needle in task22_fill_hallucination_quality_v1 ce_evaluation_attempt_lineage_fkey ce_outbox_evaluation_company_fkey ce_state_conversation_company_fkey ce_job_conversation_company_fkey 'ALTER COLUMN company_id SET NOT NULL' 'REVOKE EXECUTE ON FUNCTION public.complete_evaluation(uuid,jsonb)'; do grep -q "$needle" "$MIGRATION" || fail "migration contract missing: $needle"; done
pass "canonical CE migration contract"
[[ "${TASK22_LIVE_MIGRATION_SHA256:-}" == "45ae707e7e90124792c0c9b0d3d3ab659c3fd76b5e6444635f8adb43b949292a" ]] || fail "live migration hash marker mismatch"
SOURCE_SHA="$(python - "$MIGRATION" <<'PY'
import hashlib,pathlib,sys
print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes().rstrip()).hexdigest())
PY
)"
[[ "$SOURCE_SHA" == "$TASK22_LIVE_MIGRATION_SHA256" ]] || fail "source/live migration hash mismatch"
[[ "${TASK22_DB_ASSERTIONS:-}" == "evals=8;attempts=8;outboxes=8;null_company=0;detail_bad=0;outbox_bad=0;quality_bad=0;lineage_bad=0" ]] || fail "DB assertions marker mismatch"
[[ "${TASK22_RUNTIME_PROOF:-}" == "PASS" ]] || fail "canonical atomic runtime proof missing"
[[ "${TASK22_AUTH_RLS_NEGATIVE:-}" == "PASS" ]] || fail "authenticated cross-tenant proof missing"
[[ "${TASK22_ROLLBACK_PROOF:-}" == "notnull=1;evalfk=1;outboxfk=1;trigger=1" ]] || fail "rollback proof marker mismatch"
pass "live canonical/tenant/rollback assertions"
npm run build
pass "production build"
echo "TASK 2.2 FINAL GATE: PASS"
