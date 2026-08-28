#!/bin/bash
set -Eeuo pipefail
REPO="${W3_T3_3_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
AUTH="${W3_T3_3_PRODUCTION_AUTHORIZED:-}"
EXPECTED_REF="hvmtoqiwdqvgnjepxwrc"
CFG="$REPO/config/w3-task3-3-dev-identity.env"
stop(){ echo "STOP: $1" >&2; exit 2; }
fail(){ echo "FAIL: $1" >&2; exit 1; }

[ -s "$CFG" ] || stop "Director DEV identity config missing"
source "$CFG"
[ "${W3_T3_3_DEV_CONFIG:-}" = YES ] || stop "Director DEV configuration not active"
[ "$AUTH" = YES ] || stop "explicit final production activation authorization missing"
[ "${W3_T3_3_PROJECT_REF:-}" = "$EXPECTED_REF" ] || stop "project ref mismatch"
[ "$(git -C "$REPO" branch --show-current)" = main ] || stop "branch must be main"
[ -z "$(git -C "$REPO" status --porcelain)" ] || stop "working tree must be clean"
command -v psql >/dev/null 2>&1 || stop "psql missing"

cd "$REPO"
source scripts/w3-task3-3-runtime-inputs-load.sh

[ "${W3_T3_3_LOVABLE_NATIVE_DEPLOY_CONFIRMED:-}" = "YES" ] \
  || stop "Lovable-native deployment not confirmed before activation"
CURRENT_COMMIT="$(git rev-parse HEAD)"
[ "$W3_T3_3_DEPLOYED_COMMIT_SHA" = "$CURRENT_COMMIT" ] \
  || stop "deployed commit mismatch: runtime=$W3_T3_3_DEPLOYED_COMMIT_SHA repo=$CURRENT_COMMIT"

# Product-ready runtime aliases derive only from the frozen current-project DEV
# config. No deferred SU CoachAI training-loop inputs are loaded here.
export PR7_CANONICAL_COMPANY_UUID="${W2_T2_1_CANONICAL_COMPANY_UUID}"
export PR9_KB_SMOKE_QUERY="${PR10_KB_TENANT_A_QUERY}"
export SUPABASE_URL="${SUPABASE_URL:-https://${W3_T3_3_PROJECT_REF}.supabase.co}"
export W1_SMOKE_USER_JWT="${PR10_TENANT_A_BEARER_TOKEN}"
export W1_KB_SMOKE_QUERY="${PR10_KB_TENANT_A_QUERY}"
export W1_SMOKE_AGENT_PROFILE_ID="${PR10_TENANT_A_AGENT_PROFILE_UUID}"

python3 tests/edge/w3-task3-3-source-contract.py "$REPO"
python3 tests/edge/w3-task3-3-consolidated-closure-contract.py "$REPO"
python3 tests/edge/task3-3-consolidated-product-ready-contract.py "$REPO"
npm run build

PR30_APPLIED=false
SECURITY_HARDENING_APPLIED=false
rollback_pr30(){
  local rc="${1:-1}"
  if [ "$PR30_APPLIED" = true ]; then
    echo "ROLLBACK: Task 3.3 activation failed; reverting PR30 attachment schema" >&2
    if ! psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f sql/pr30/pr30_agent_attachment.rollback.sql; then
      echo "ROLLBACK FAILURE: PR30 rollback command failed; manual owner intervention required" >&2
      exit 3
    fi
    PR30_APPLIED=false
  fi
  if [ "$SECURITY_HARDENING_APPLIED" = true ]; then
    echo "SAFE ROLLBACK NOTE: Task 3.3 RLS hardening remains active; insecure access is not automatically restored" >&2
  fi
  exit "$rc"
}
trap 'rollback_pr30 $?' ERR

# Attachment persistence boundary.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f sql/pr30/pr30_agent_attachment.sql
PR30_APPLIED=true

# Same-task security findings discovered during activation. Transactional and
# idempotent; a failure rolls itself back and the ERR trap then reverts PR30.
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f sql/pr30/pr30_task3_3_security_hardening.sql
SECURITY_HARDENING_APPLIED=true

if ! psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -Atc "
SELECT CASE WHEN to_regclass('public.message_attachment_private') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END;
SELECT CASE WHEN to_regprocedure('public.agent_send_attachment_tx(uuid,uuid,text,text,text,text,bigint,text)') IS NOT NULL THEN 'PASS' ELSE 'FAIL' END;
SELECT CASE WHEN NOT has_table_privilege('authenticated','public.message_attachment_private','SELECT') THEN 'PASS' ELSE 'FAIL' END;
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname='public' AND tablename='ai_reply_draft' AND policyname='ai_reply_draft_read' AND qual='true'
) THEN 'PASS' ELSE 'FAIL' END;
SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname='public' AND tablename='handoff_event' AND policyname='handoff_event_read' AND qual='true'
) THEN 'PASS' ELSE 'FAIL' END;
SELECT CASE WHEN NOT EXISTS (
  SELECT 1
  FROM information_schema.role_table_grants g
  JOIN pg_namespace n ON n.nspname=g.table_schema
  JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=g.table_name
  WHERE g.table_schema='public'
    AND g.grantee IN ('anon','authenticated')
    AND c.relkind='r'
    AND c.relrowsecurity=false
) THEN 'PASS' ELSE 'FAIL' END;
" | awk 'BEGIN{ok=1;n=0} {n++; if($0!="PASS")ok=0} END{exit (ok && n==6)?0:1}'; then
  echo "FAIL: Task 3.3 post-apply security assertions failed" >&2
  rollback_pr30 1
fi

trap - ERR

echo "W3 TASK 3.3 ACTIVATION SEQUENCE: PASS"
