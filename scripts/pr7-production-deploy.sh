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

[ -d "$REPO/.git" ] || stop "repo not found"
cd "$REPO" || stop "cannot enter repo"
[ "$(git branch --show-current)" = "main" ] || stop "branch must be main"
git diff --quiet || stop "repo has unstaged changes"
git diff --cached --quiet || stop "repo has staged changes"
git cat-file -e "$ROLLBACK_COMMIT^{commit}" 2>/dev/null || stop "rollback commit invalid"

command -v psql >/dev/null 2>&1 || stop "psql missing"
command -v npx >/dev/null 2>&1 || stop "npx missing"

# Source gate must be PASS but PRODUCTION STOP (exit 2).
set +e
bash scripts/pr7-final-gate.sh
SOURCE_RC=$?
set -e
[ "$SOURCE_RC" -eq 2 ] || fail "source final-gate must exit 2 (SOURCE PASS / PRODUCTION STOP), got $SOURCE_RC"

SQL_FORWARD=(
  "sql/pr7/pr7_feedback_config_tenant_scope.sql"
  "sql/pr7/pr7_agent_management_tenant_isolation.sql"
  "sql/pr7/pr7_ai_reply_source_message_atomic_guard.sql"
  "sql/pr7/pr7_config_rpc_tenant_guard.sql"
  "sql/pr7/pr7_conversation_resolution_atomic_tx.sql"
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
  "sql/pr7/pr7_feedback_widget_delivery_atomic.rollback.sql"
  "sql/pr7/pr7_recall_message_atomic_tx.rollback.sql"
  "sql/pr7/pr7_core_rls_tenant_isolation.rollback.sql"
  "sql/pr7/pr7_secondary_rls_tenant_isolation.rollback.sql"
  "sql/pr7/pr7_security_definer_acl_hardening.rollback.sql"
)

for f in "${SQL_FORWARD[@]}" "${SQL_ROLLBACK[@]}"; do
  [ -s "$f" ] || stop "required SQL missing/empty: $f"
done

FUNCTIONS=(
  "widget-poll-messages"
  "receive-widget-message"
  "generate-reply"
  "agent-send-reply"
  "assign-conversation"
  "take-over-conversation"
  "transfer-conversation"
  "return-to-ai"
  "resolve-conversation"
  "mark-unresolved"
  "recall-message"
  "deliver-feedback-request"
  "agent-management"
  "agent-assist"
)

# Gateway mode must match frozen config.
VERIFY_JWT_TRUE=(
  "generate-reply"
  "deliver-feedback-request"
  "agent-management"
  "agent-assist"
)
VERIFY_JWT_FALSE=(
  "widget-poll-messages"
  "receive-widget-message"
  "agent-send-reply"
  "assign-conversation"
  "take-over-conversation"
  "transfer-conversation"
  "return-to-ai"
  "resolve-conversation"
  "mark-unresolved"
  "recall-message"
)

sql_applied=()
functions_deployed=()

rollback_sql() {
  echo "ROLLBACK: SQL in reverse order"
  local i
  for ((i=${#sql_applied[@]}-1; i>=0; i--)); do
    local idx="${sql_applied[$i]}"
    local rb="${SQL_ROLLBACK[$idx]}"
    echo "ROLLBACK SQL: $rb"
    psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$rb" || echo "ROLLBACK WARNING: $rb failed"
  done
}

rollback_functions() {
  echo "ROLLBACK: redeploy functions from $ROLLBACK_COMMIT"
  local WT
  WT="$(mktemp -d "${TMPDIR:-/tmp}/pr7-rollback.XXXXXX")" || return 1
  git worktree add --detach "$WT" "$ROLLBACK_COMMIT" >/dev/null 2>&1 || { rm -rf "$WT"; return 1; }
  (
    cd "$WT" || exit 1
    export SUPABASE_ACCESS_TOKEN="$ACCESS_TOKEN"
    for fn in "${functions_deployed[@]}"; do
      echo "ROLLBACK FUNCTION: $fn"
      # Restore the old gateway semantics from rollback commit's config when possible.
      if python3 - "$fn" <<'PY'
import sys, pathlib, re
fn=sys.argv[1]
t=pathlib.Path("supabase/config.toml").read_text()
m=re.search(rf'\[functions\.{re.escape(fn)}\]\s*\nverify_jwt\s*=\s*(true|false)', t)
sys.exit(0 if m and m.group(1)=="false" else 1)
PY
      then
        npx supabase functions deploy "$fn" --project-ref "$PROJECT_REF" --no-verify-jwt || exit 1
      else
        npx supabase functions deploy "$fn" --project-ref "$PROJECT_REF" || exit 1
      fi
    done
  )
  local rc=$?
  git worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$WT" 2>/dev/null || true
  return "$rc"
}

rollback_all() {
  set +e
  rollback_functions
  rollback_sql
  set -e
}

echo "== APPLY PR7 SQL =="
for i in "${!SQL_FORWARD[@]}"; do
  f="${SQL_FORWARD[$i]}"
  echo "APPLY SQL: $f"
  if psql "$DB_URL" -v ON_ERROR_STOP=1 -f "$f"; then
    sql_applied+=("$i")
  else
    rollback_sql
    fail "SQL deployment failed: $f"
  fi
done

echo "== DEPLOY PR7 EDGE FUNCTIONS =="
export SUPABASE_ACCESS_TOKEN="$ACCESS_TOKEN"

is_in() {
  local needle="$1"; shift
  local x
  for x in "$@"; do [ "$x" = "$needle" ] && return 0; done
  return 1
}

for fn in "${FUNCTIONS[@]}"; do
  echo "DEPLOY FUNCTION: $fn"
  if is_in "$fn" "${VERIFY_JWT_FALSE[@]}"; then
    if ! npx supabase functions deploy "$fn" --project-ref "$PROJECT_REF" --no-verify-jwt; then
      rollback_all
      fail "Edge deploy failed: $fn"
    fi
  else
    if ! npx supabase functions deploy "$fn" --project-ref "$PROJECT_REF"; then
      rollback_all
      fail "Edge deploy failed: $fn"
    fi
  fi
  functions_deployed+=("$fn")
done

echo "== PRODUCTION FINAL GATE =="
if ! bash scripts/pr7-production-final-gate.sh; then
  rollback_all
  fail "production final-gate failed; rollback attempted"
fi

echo "FINAL STATUS: READY"
exit 0
