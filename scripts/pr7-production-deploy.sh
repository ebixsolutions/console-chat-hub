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
[ -n "${PR7_CANONICAL_COMPANY_ID:-}" ] || stop "canonical company id missing"

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

echo "== CANONICAL COMPANY BOOTSTRAP =="
bash scripts/pr7-canonical-company-bootstrap.sh || fail "canonical company bootstrap failed"

SQL_FORWARD=(
  "sql/pr7/pr7_feedback_config_tenant_scope.sql"
  "sql/pr7/pr7_agent_management_tenant_isolation.sql"
  "sql/pr7/pr7_ai_reply_source_message_atomic_guard.sql"
  "sql/pr7/pr7_config_rpc_tenant_guard.sql"
  "sql/pr7/pr7_conversation_resolution_atomic_tx.sql"
  "sql/pr7/pr7_ce_tenant_resolution_hardening.sql"
  "sql/pr7/pr7_feedback_widget_delivery_atomic.sql"
  "sql/pr7/pr7_recall_message_atomic_tx.sql"
  "sql/pr7/pr7_core_rls_tenant_isolation.sql"
  "sql/pr7/pr7_secondary_rls_tenant_isolation.sql"
  "sql/pr7/pr7_security_definer_acl_hardening.sql"
)
SQL_ROLLBACK=(
  "sql/pr7/pr7_feedback_config_tenant_scope.rollback.sql"
  "sql/pr7/pr7_agent_management_tenant_isolation.rollback.sql"
  "sql/pr7/pr7_ai_reply_source_message_atomic_guard.rollback.sql"
  "sql/pr7/pr7_config_rpc_tenant_guard.rollback.sql"
  "sql/pr7/pr7_conversation_resolution_atomic_tx.rollback.sql"
  "sql/pr7/pr7_ce_tenant_resolution_hardening.rollback.sql"
  "sql/pr7/pr7_feedback_widget_delivery_atomic.rollback.sql"
  "sql/pr7/pr7_recall_message_atomic_tx.rollback.sql"
  "sql/pr7/pr7_core_rls_tenant_isolation.rollback.sql"
  "sql/pr7/pr7_secondary_rls_tenant_isolation.rollback.sql"
  "sql/pr7/pr7_security_definer_acl_hardening.rollback.sql"
)
for f in "${SQL_FORWARD[@]}" "${SQL_ROLLBACK[@]}"; do [ -s "$f" ] || stop "required SQL missing/empty: $f"; done

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

sql_applied=()
functions_deployed=()

rollback_sql(){
  set +e
  for ((i=${#sql_applied[@]}-1; i>=0; i--)); do
    idx="${sql_applied[$i]}"
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f "${SQL_ROLLBACK[$idx]}" || true
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
    for fn in "${functions_deployed[@]}"; do
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
rollback_bootstrap(){ bash scripts/pr7-canonical-company-bootstrap-rollback.sh; }
rollback_all(){ set +e; rollback_functions; rollback_sql; rollback_bootstrap; set -e; }

echo "== APPLY PR7 SQL =="
for i in "${!SQL_FORWARD[@]}"; do
  f="${SQL_FORWARD[$i]}"
  if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"; then
    sql_applied+=("$i")
  else
    rollback_sql
    rollback_bootstrap || true
    fail "SQL deployment failed: $f"
  fi
done

echo "== BIND LEGACY FEEDBACK CONFIG =="
psql "$DB_URL" -v ON_ERROR_STOP=1 -v company_id="${PR7_CANONICAL_COMPANY_ID}" <<'SQL' || { rollback_all; fail "feedback config binding failed"; }
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
