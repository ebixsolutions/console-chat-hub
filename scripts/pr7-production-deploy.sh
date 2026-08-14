#!/bin/bash
set -u
set -o pipefail

REPO="${PR7_REPO:-$HOME/Documents/GitHub/console-chat-hub}"
EXPECTED_PROJECT_REF="hvmtoqiwdqvgnjepxwrc"
AUTH="${PR7_PRODUCTION_DEPLOY_AUTHORIZED:-}"
PROJECT_REF="${PR7_PROJECT_REF:-}"
DB_URL="${SUPABASE_DB_URL:-}"
ROLLBACK_COMMIT="${PR7_ROLLBACK_COMMIT:-}"
ACCESS_TOKEN="${SUPABASE_ACCESS_TOKEN:-}"

stop(){ echo "STOP: $1"; exit 2; }
fail(){ echo "FAIL: $1"; exit 1; }

[ "$AUTH" = "YES" ] || stop "production deployment authorization missing"
[ "$PROJECT_REF" = "$EXPECTED_PROJECT_REF" ] || stop "project ref mismatch"
[ -n "$DB_URL" ] || stop "SUPABASE_DB_URL missing"
[ -n "$ACCESS_TOKEN" ] || stop "SUPABASE_ACCESS_TOKEN missing"
[ -n "$ROLLBACK_COMMIT" ] || stop "PR7_ROLLBACK_COMMIT missing"
[ "${PR7_LEGACY_DATA_IS_SINGLE_COMPANY:-}" = "YES" ] || stop "legacy single-company confirmation missing"
[ -n "${PR7_CANONICAL_COMPANY_UUID:-}" ] || stop "canonical company UUID missing"
[ -n "${PR7_CANONICAL_PLATFORM_COMPANY_ID:-}" ] || stop "canonical platform integer company id missing"
[ -n "${KB_SINGAPORE_TENANT_MAP_JSON:-}" ] || stop "Singapore KB tenant mapping missing"
[ -n "${PR7_MEMBERSHIP_BOOTSTRAP_RUN_ID:-}" ] || stop "membership bootstrap run id missing"
[ -n "${PR7_CHANNEL_OWNERSHIP_RUN_ID:-}" ] || stop "channel ownership run id missing"
[ -n "${PR7_CONVERSATION_LINEAGE_RUN_ID:-}" ] || stop "conversation lineage run id missing"
[ "${PR7_LEGACY_ORPHAN_CONVERSATIONS_BELONG_TO_CANONICAL_COMPANY:-}" = "YES" ] || stop "orphan conversation ownership confirmation missing"

[ -d "$REPO/.git" ] || stop "repo not found"
cd "$REPO" || stop "cannot enter repo"
[ "$(git branch --show-current)" = "main" ] || stop "branch must be main"
git diff --quiet || stop "repo has unstaged changes"
git diff --cached --quiet || stop "repo has staged changes"
git cat-file -e "$ROLLBACK_COMMIT^{commit}" 2>/dev/null || stop "rollback commit invalid"
command -v psql >/dev/null 2>&1 || stop "psql missing"
command -v npx >/dev/null 2>&1 || stop "npx missing"
command -v python3 >/dev/null 2>&1 || stop "python3 missing"

[ -s scripts/pr7-canonical-company-bootstrap.sh ] || stop "bootstrap missing"
[ -s scripts/pr7-canonical-company-bootstrap-rollback.sh ] || stop "bootstrap rollback missing"

echo "== PRODUCTION ATOMIC ROLLBACK CONTRACT =="
bash scripts/pr7-production-atomic-rollback-source-gate.sh || stop "production rollback source contract failed"

echo "== CE PRODUCTION ACTIVATION SOURCE CONTRACT =="
bash scripts/pr8-ce-production-activation-source-gate.sh || stop "CE production activation source contract failed"

echo "== PRODUCTION RUNTIME CONFIG CONTRACT =="
bash scripts/pr7-production-runtime-config-gate.sh || stop "production runtime configuration incomplete"

export PR7_BOOTSTRAP_RUN_ID="${PR7_BOOTSTRAP_RUN_ID:-$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)}"

set +e
bash scripts/pr7-final-gate.sh
SOURCE_RC=$?
set -e
[ "$SOURCE_RC" -eq 2 ] || fail "source final-gate must exit 2, got $SOURCE_RC"

IDENTITY_FORWARD="sql/pr7/pr7_company_dual_identity.sql"
IDENTITY_ROLLBACK="sql/pr7/pr7_company_dual_identity.rollback.sql"
[ -s "$IDENTITY_FORWARD" ] || stop "company identity SQL missing"
[ -s "$IDENTITY_ROLLBACK" ] || stop "company identity rollback SQL missing"

identity_applied=0
rollback_identity(){ psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$IDENTITY_ROLLBACK"; }
rollback_bootstrap(){ bash scripts/pr7-canonical-company-bootstrap-rollback.sh; }

echo "== SINGAPORE KB TENANT MAPPING PREFLIGHT =="
bash scripts/pr7-singapore-kb-mapping-source-gate.sh || stop "Singapore KB mapping source contract failed"
bash scripts/pr7-singapore-kb-tenant-mapping-gate.sh || stop "Singapore KB tenant mapping invalid"

echo "== SINGAPORE KB BACKEND JWT AUTH PREFLIGHT =="
bash scripts/pr7-singapore-kb-auth-source-gate.sh || stop "Singapore KB auth source contract failed"
bash scripts/pr7-singapore-kb-auth-env-gate.sh || stop "Singapore KB production auth env invalid"
bash scripts/pr7-singapore-kb-jwt-contract-test.sh || stop "Singapore KB JWT contract test failed"

echo "== SINGAPORE KB FULL CALL-CHAIN PREFLIGHT =="
bash scripts/pr7-singapore-kb-callchain-gate.sh || stop "Singapore KB full call-chain contract failed"

echo "== CUSTOMER360 UPSTREAM ADAPTER PREFLIGHT =="
bash scripts/pr7-customer360-adapter-source-gate.sh || stop "Customer360 upstream adapter source contract failed"

echo "== CUSTOMER360 CALLER PREFLIGHT =="
bash scripts/pr7-customer360-caller-source-gate.sh || stop "Customer360 caller source contract failed"

echo "== CUSTOMER360 ↔ COACH SYNC PREFLIGHT =="
bash scripts/pr7-customer360-coach-sync-source-gate.sh || stop "Customer360 ↔ Coach sync source contract failed"

echo "== WIDGET THEME CONTRACT PREFLIGHT =="
bash scripts/pr7-widget-theme-contract-source-gate.sh || stop "widget theme contract source failed"

echo "== WIDGET MODERN ASSISTANT RUNTIME PREFLIGHT =="
bash scripts/pr7-widget-modern-runtime-source-gate.sh || stop "widget modern runtime source failed"

echo "== WIDGET THEME SELECTOR DIRECTOR PREFLIGHT =="
bash scripts/pr7-widget-theme-selector-director-gate.sh || stop "widget theme selector Director gate failed"

echo "== PRODUCTION ACTIVATION SOURCE GATE =="
bash scripts/pr7-production-activation-source-gate.sh || stop "production activation source contract failed"

echo "== COMPANY FOUNDATION LIFECYCLE SOURCE GATE =="
bash scripts/pr7-company-foundation-lifecycle-gate.sh || stop "company foundation lifecycle gate failed"

echo "== APPLY CANONICAL COMPANY IDENTITY SCHEMA =="
if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$IDENTITY_FORWARD"; then
  identity_applied=1
else
  fail "canonical company identity schema failed"
fi

echo "== CANONICAL COMPANY BOOTSTRAP =="
if ! bash scripts/pr7-canonical-company-bootstrap.sh; then
  [ "$identity_applied" -eq 1 ] && rollback_identity || true
  fail "canonical company bootstrap failed"
fi

MEMBERSHIP_FORWARD="sql/pr7/pr7_company_membership_foundation.sql"
MEMBERSHIP_ROLLBACK="sql/pr7/pr7_company_membership_foundation.rollback.sql"
[ -s "$MEMBERSHIP_FORWARD" ] || stop "membership foundation SQL missing"
[ -s "$MEMBERSHIP_ROLLBACK" ] || stop "membership foundation rollback SQL missing"
membership_applied=0
rollback_membership_schema(){ psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$MEMBERSHIP_ROLLBACK"; }
rollback_membership_bootstrap(){ bash scripts/pr7-company-membership-bootstrap-rollback.sh; }

echo "== APPLY CANONICAL MEMBERSHIP FOUNDATION =="
if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$MEMBERSHIP_FORWARD"; then
  membership_applied=1
else
  bash scripts/pr7-canonical-company-bootstrap-rollback.sh || true
  [ "$identity_applied" -eq 1 ] && rollback_identity || true
  fail "membership foundation schema failed"
fi

echo "== CANONICAL MEMBERSHIP BOOTSTRAP =="
if ! bash scripts/pr7-company-membership-bootstrap.sh; then
  [ "$membership_applied" -eq 1 ] && rollback_membership_schema || true
  bash scripts/pr7-canonical-company-bootstrap-rollback.sh || true
  [ "$identity_applied" -eq 1 ] && rollback_identity || true
  fail "membership bootstrap failed"
fi

CHANNEL_FORWARD="sql/pr7/pr7_channel_ownership_foundation.sql"
CHANNEL_ROLLBACK="sql/pr7/pr7_channel_ownership_foundation.rollback.sql"
[ -s "$CHANNEL_FORWARD" ] || stop "channel ownership foundation SQL missing"
[ -s "$CHANNEL_ROLLBACK" ] || stop "channel ownership foundation rollback SQL missing"
channel_applied=0
rollback_channel_schema(){ psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$CHANNEL_ROLLBACK"; }
rollback_channel_bootstrap(){ bash scripts/pr7-channel-ownership-bootstrap-rollback.sh; }

echo "== APPLY CHANNEL OWNERSHIP FOUNDATION =="
if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$CHANNEL_FORWARD"; then
  channel_applied=1
else
  rollback_membership_bootstrap || true
  [ "$membership_applied" -eq 1 ] && rollback_membership_schema || true
  rollback_bootstrap || true
  [ "$identity_applied" -eq 1 ] && rollback_identity || true
  fail "channel ownership foundation failed"
fi

echo "== CANONICAL CHANNEL OWNERSHIP BOOTSTRAP =="
if ! bash scripts/pr7-channel-ownership-bootstrap.sh; then
  [ "$channel_applied" -eq 1 ] && rollback_channel_schema || true
  rollback_membership_bootstrap || true
  [ "$membership_applied" -eq 1 ] && rollback_membership_schema || true
  rollback_bootstrap || true
  [ "$identity_applied" -eq 1 ] && rollback_identity || true
  fail "channel ownership bootstrap failed"
fi

CONVERSATION_FORWARD="sql/pr7/pr7_conversation_lineage_foundation.sql"
CONVERSATION_ROLLBACK="sql/pr7/pr7_conversation_lineage_foundation.rollback.sql"
[ -s "$CONVERSATION_FORWARD" ] || stop "conversation lineage foundation SQL missing"
[ -s "$CONVERSATION_ROLLBACK" ] || stop "conversation lineage foundation rollback SQL missing"
conversation_applied=0
rollback_conversation_schema(){ psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$CONVERSATION_ROLLBACK"; }
rollback_conversation_bootstrap(){ bash scripts/pr7-conversation-lineage-bootstrap-rollback.sh; }

echo "== APPLY CONVERSATION LINEAGE FOUNDATION =="
if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$CONVERSATION_FORWARD"; then
  conversation_applied=1
else
  rollback_channel_bootstrap || true
  [ "$channel_applied" -eq 1 ] && rollback_channel_schema || true
  rollback_membership_bootstrap || true
  [ "$membership_applied" -eq 1 ] && rollback_membership_schema || true
  rollback_bootstrap || true
  [ "$identity_applied" -eq 1 ] && rollback_identity || true
  fail "conversation lineage foundation failed"
fi

echo "== CANONICAL CONVERSATION/DIRECT LINEAGE BACKFILL =="
if ! bash scripts/pr7-conversation-lineage-bootstrap.sh; then
  [ "$conversation_applied" -eq 1 ] && rollback_conversation_schema || true
  rollback_channel_bootstrap || true
  [ "$channel_applied" -eq 1 ] && rollback_channel_schema || true
  rollback_membership_bootstrap || true
  [ "$membership_applied" -eq 1 ] && rollback_membership_schema || true
  rollback_bootstrap || true
  [ "$identity_applied" -eq 1 ] && rollback_identity || true
  fail "conversation lineage bootstrap failed"
fi

SQL_FORWARD=(
  "sql/pr7/pr7_tenant_ownership_consistency.sql"
  "sql/pr7/pr7_widget_theme_contract.sql"
  "sql/pr7/pr7_widget_theme_default_modern.sql"
  "sql/pr7/pr7_customer360_coach_sync_state.sql"
  "sql/pr7/pr7_feedback_config_tenant_scope.sql"
  "sql/pr7/pr7_agent_management_tenant_isolation.sql"
  "sql/pr7/pr7_ai_reply_source_message_atomic_guard.sql"
  "sql/pr7/pr7_config_rpc_tenant_guard.sql"
  "sql/pr7/pr7_conversation_resolution_atomic_tx.sql"
  "sql/pr7/pr7_ce_tenant_resolution_hardening.sql"
  "sql/pr6/pr6_canonical_evaluation_outbox.sql"
  "sql/pr7/pr7_ce_lineage_closure.sql"
  "sql/pr7/pr7_feedback_widget_delivery_atomic.sql"
  "sql/pr7/pr7_recall_message_atomic_tx.sql"
  "sql/pr7/pr7_core_rls_tenant_isolation.sql"
  "sql/pr7/pr7_secondary_rls_tenant_isolation.sql"
  "sql/pr7/pr7_security_definer_acl_hardening.sql"
)
SQL_ROLLBACK_FOR_FORWARD=(
  "sql/pr7/pr7_tenant_ownership_consistency.rollback.sql"
  "sql/pr7/pr7_widget_theme_contract.rollback.sql"
  "sql/pr7/pr7_widget_theme_default_modern.rollback.sql"
  "sql/pr7/pr7_customer360_coach_sync_state.rollback.sql"
  "sql/pr7/pr7_feedback_config_tenant_scope.rollback.sql"
  "sql/pr7/pr7_agent_management_tenant_isolation.rollback.sql"
  "sql/pr7/pr7_ai_reply_source_message_atomic_guard.rollback.sql"
  "sql/pr7/pr7_config_rpc_tenant_guard.rollback.sql"
  "sql/pr7/pr7_conversation_resolution_atomic_tx.rollback.sql"
  "sql/pr7/pr7_ce_tenant_resolution_hardening.rollback.sql"
  "sql/pr6/pr6_canonical_evaluation_outbox.rollback.sql"
  "sql/pr7/pr7_ce_lineage_closure.rollback.sql"
  "sql/pr7/pr7_feedback_widget_delivery_atomic.rollback.sql"
  "sql/pr7/pr7_recall_message_atomic_tx.rollback.sql"
  "sql/pr7/pr7_core_rls_tenant_isolation.rollback.sql"
  "sql/pr7/pr7_secondary_rls_tenant_isolation.rollback.sql"
  "sql/pr7/pr7_security_definer_acl_hardening.rollback.sql"
)
for f in "${SQL_FORWARD[@]}" "${SQL_ROLLBACK_FOR_FORWARD[@]}"; do [ -s "$f" ] || stop "required SQL missing/empty: $f"; done

# Complete Product-ready Edge inventory. Every source below is physically
# required before any SQL/data mutation begins.
FUNCTIONS=(
  "get-public-widget-config"
  "create-visitor-session"
  "receive-widget-message"
  "widget-poll-messages"
  "generate-reply"
  "health-check"
  "submit-feedback-response"
  "deliver-feedback-request"
  "agent-send-reply"
  "assign-conversation"
  "take-over-conversation"
  "transfer-conversation"
  "return-to-ai"
  "resolve-conversation"
  "mark-unresolved"
  "recall-message"
  "kb-search-proxy"
  "visitor-analytics"
  "agent-assist"
  "agent-management"
  "conversation-evaluate"
  "customer360-local"
  "customer360-adapter"
  "customer360-coach-sync"
  "training-outbox-worker"
  "training-result-receiver"
  "training-kb-sync"
  "training-kb-finalize"
)

# Explicit gateway modes. Functions absent from config.toml retain their frozen
# custom in-function auth model only when explicitly listed here.
VERIFY_JWT_FALSE=(
  "get-public-widget-config"
  "create-visitor-session"
  "receive-widget-message"
  "widget-poll-messages"
  "health-check"
  "customer360-adapter"
  "customer360-coach-sync"
  "submit-feedback-response"
  "agent-send-reply"
  "assign-conversation"
  "take-over-conversation"
  "transfer-conversation"
  "return-to-ai"
  "resolve-conversation"
  "mark-unresolved"
  "recall-message"
  "training-outbox-worker"
  "training-result-receiver"
  "training-kb-sync"
  "training-kb-finalize"
)

for fn in "${FUNCTIONS[@]}"; do
  [ -s "supabase/functions/$fn/index.ts" ] || stop "required Edge source missing/empty: $fn"
done

sql_rollback_stack=()
functions_deployed=()

rollback_sql(){
  set +e
  local i rb
  for ((i=${#sql_rollback_stack[@]}-1; i>=0; i--)); do
    rb="${sql_rollback_stack[$i]}"
    [ -s "$rb" ] || { echo "ROLLBACK ERROR missing SQL rollback: $rb"; continue; }
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$rb" || true
  done
  set -e
}

is_false(){ local n="$1"; shift; local x; for x in "$@"; do [ "$x" = "$n" ] && return 0; done; return 1; }

rollback_functions(){
  local WT
  WT="$(mktemp -d "${TMPDIR:-/tmp}/pr7-rollback.XXXXXX")" || return 1
  git worktree add --detach "$WT" "$ROLLBACK_COMMIT" >/dev/null 2>&1 || { rm -rf "$WT"; return 1; }
  (
    cd "$WT" || exit 1
    export SUPABASE_ACCESS_TOKEN="$ACCESS_TOKEN"
    local_i=0
    for ((local_i=${#functions_deployed[@]}-1; local_i>=0; local_i--)); do
      fn="${functions_deployed[$local_i]}"
      [ -s "supabase/functions/$fn/index.ts" ] || exit 1
      if is_false "$fn" "${VERIFY_JWT_FALSE[@]}"; then
        npx supabase functions deploy "$fn" --project-ref "$PROJECT_REF" --no-verify-jwt || exit 1
      else
        npx supabase functions deploy "$fn" --project-ref "$PROJECT_REF" || exit 1
      fi
    done
  )
  rc=$?
  git worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$WT" 2>/dev/null || true
  return "$rc"
}
rollback_all(){ set +e; rollback_functions; rollback_sql; rollback_conversation_bootstrap; [ "$conversation_applied" -eq 1 ] && rollback_conversation_schema; rollback_channel_bootstrap; [ "$channel_applied" -eq 1 ] && rollback_channel_schema; rollback_membership_bootstrap; [ "$membership_applied" -eq 1 ] && rollback_membership_schema; rollback_bootstrap; [ "$identity_applied" -eq 1 ] && rollback_identity; set -e; }

echo "== APPLY PR7 SQL =="
[ "${#SQL_FORWARD[@]}" -eq "${#SQL_ROLLBACK_FOR_FORWARD[@]}" ] || fail "SQL forward/rollback inventory length mismatch"
for i in "${!SQL_FORWARD[@]}"; do
  f="${SQL_FORWARD[$i]}"
  rb="${SQL_ROLLBACK_FOR_FORWARD[$i]}"
  if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"; then
    sql_rollback_stack+=("$rb")
  else
    rollback_sql
    rollback_conversation_bootstrap || true
    [ "$conversation_applied" -eq 1 ] && rollback_conversation_schema || true
    rollback_channel_bootstrap || true
    [ "$channel_applied" -eq 1 ] && rollback_channel_schema || true
    rollback_membership_bootstrap || true
    [ "$membership_applied" -eq 1 ] && rollback_membership_schema || true
    rollback_bootstrap || true
    [ "$identity_applied" -eq 1 ] && rollback_identity || true
    fail "SQL deployment failed: $f"
  fi
done

echo "== BIND LEGACY FEEDBACK CONFIG =="
psql "$DB_URL" -v ON_ERROR_STOP=1 -v company_id="${PR7_CANONICAL_COMPANY_UUID}" <<'SQL' || { rollback_all; fail "feedback config binding failed"; }
BEGIN;
SELECT set_config('pr7.company_id', :'company_id', false);
DO $$
DECLARE v_rows int;
BEGIN
  SELECT count(*) INTO v_rows FROM public.feedback_automation_config;
  IF v_rows > 1 THEN RAISE EXCEPTION 'legacy feedback config binding refused: more than one row'; END IF;
END $$;
UPDATE public.feedback_automation_config
SET company_id=current_setting('pr7.company_id')::uuid
WHERE company_id IS NULL;
COMMIT;
SQL

echo "== DEPLOY COMPLETE PRODUCT-READY EDGE INVENTORY =="
export SUPABASE_ACCESS_TOKEN="$ACCESS_TOKEN"
for fn in "${FUNCTIONS[@]}"; do
  if is_false "$fn" "${VERIFY_JWT_FALSE[@]}"; then
    npx supabase functions deploy "$fn" --project-ref "$PROJECT_REF" --no-verify-jwt || { rollback_all; fail "Edge deploy failed: $fn"; }
  else
    npx supabase functions deploy "$fn" --project-ref "$PROJECT_REF" || { rollback_all; fail "Edge deploy failed: $fn"; }
  fi
  functions_deployed+=("$fn")
done

echo "== PRODUCTION FINAL GATE =="
bash scripts/pr7-production-final-gate.sh || { rollback_all; fail "production final-gate failed; rollback attempted"; }

echo "FINAL STATUS: READY"
