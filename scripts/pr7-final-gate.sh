#!/bin/bash
set -u

REPO="${1:-$HOME/Documents/GitHub/console-chat-hub}"
cd "$REPO" || { echo "FAIL: repo unavailable"; exit 1; }

fail=0
check_file() {
  local f="$1"
  if [ ! -s "$f" ]; then echo "FAIL missing/empty: $f"; fail=1; else echo "PASS file: $f"; fi
}
must_have() {
  local f="$1" marker="$2" label="$3"
  if grep -Fq "$marker" "$f"; then echo "PASS $label"; else echo "FAIL $label"; fail=1; fi
}
must_not_have() {
  local f="$1" marker="$2" label="$3"
  if grep -Fq "$marker" "$f"; then echo "FAIL $label"; fail=1; else echo "PASS $label"; fi
}

echo "== PR7 SOURCE FINAL GATE =="

# Frozen + post-freeze authoritative source files.
for f in \
  supabase/config.toml \
  supabase/functions/_shared/agent.ts \
  supabase/functions/agent-assist/index.ts \
  supabase/functions/agent-management/index.ts \
  supabase/functions/generate-reply/index.ts \
  supabase/functions/receive-widget-message/index.ts \
  supabase/functions/widget-poll-messages/index.ts \
  supabase/functions/kb-search-proxy/index.ts \
  supabase/functions/health-check/index.ts \
  supabase/functions/visitor-analytics/index.ts \
  supabase/functions/conversation-evaluate/index.ts \
  supabase/functions/customer360-local/index.ts \
  public/widget/chat.js \
  src/routes/_authenticated/console.tsx \
  src/lib/api/config.service.ts \
  sql/pr7/pr7_agent_management_tenant_isolation.sql \
  sql/pr7/pr7_agent_management_tenant_isolation.rollback.sql \
  sql/pr7/pr7_ai_reply_source_message_atomic_guard.sql \
  sql/pr7/pr7_ai_reply_source_message_atomic_guard.rollback.sql \
  sql/pr7/pr7_config_rpc_tenant_guard.sql \
  sql/pr7/pr7_config_rpc_tenant_guard.rollback.sql \
  sql/pr7/pr7_conversation_resolution_atomic_tx.sql \
  sql/pr7/pr7_conversation_resolution_atomic_tx.rollback.sql \
  sql/pr7/pr7_core_rls_tenant_isolation.sql \
  sql/pr7/pr7_core_rls_tenant_isolation.rollback.sql \
  sql/pr7/pr7_feedback_config_tenant_scope.sql \
  sql/pr7/pr7_feedback_config_tenant_scope.rollback.sql \
  sql/pr7/pr7_feedback_widget_delivery_atomic.sql \
  sql/pr7/pr7_feedback_widget_delivery_atomic.rollback.sql \
  sql/pr7/pr7_recall_message_atomic_tx.sql \
  sql/pr7/pr7_recall_message_atomic_tx.rollback.sql \
  sql/pr7/pr7_secondary_rls_tenant_isolation.sql \
  sql/pr7/pr7_secondary_rls_tenant_isolation.rollback.sql \
  sql/pr7/pr7_security_definer_acl_hardening.sql \
  sql/pr7/pr7_security_definer_acl_hardening.rollback.sql
do check_file "$f"; done

# Gateway contract.
must_have supabase/config.toml $'[functions.generate-reply]\nverify_jwt = true' "generate-reply gateway JWT"
must_have supabase/config.toml $'[functions.kb-search-proxy]\nverify_jwt = true' "KB proxy gateway JWT"
must_have supabase/config.toml $'[functions.visitor-analytics]\nverify_jwt = true' "visitor analytics gateway JWT"
must_have supabase/config.toml $'[functions.conversation-evaluate]\nverify_jwt = true' "conversation evaluate gateway JWT"
for fn in training-outbox-worker training-result-receiver training-kb-sync training-kb-finalize; do
  must_have supabase/config.toml "[functions.$fn]" "$fn config block"
done

# Frozen PR7 markers.
must_have supabase/functions/agent-assist/index.ts "resolveAgentCompanyScope" "Agent Assist company resolver"
must_have supabase/functions/agent-assist/index.ts 'conv.company_id !== scope.companyId' "Agent Assist cross-tenant guard"
must_not_have supabase/functions/agent-assist/index.ts '.from("user_roles")' "Agent Assist global-role bypass removed"
must_have supabase/functions/agent-management/index.ts "tenant_safe_add_agent" "Agent Management tenant add RPC"
must_have supabase/functions/agent-management/index.ts "tenant_safe_change_role" "Agent Management tenant role RPC"
must_have supabase/functions/agent-management/index.ts "tenant_safe_deactivate_agent" "Agent Management tenant deactivate RPC"
must_have supabase/functions/agent-management/index.ts "tenant_safe_reactivate_agent" "Agent Management tenant reactivate RPC"
must_have supabase/functions/widget-poll-messages/index.ts '.order("created_at", { ascending: true })' "widget poll created_at order"
must_have supabase/functions/widget-poll-messages/index.ts '.order("id", { ascending: true })' "widget poll id tie-breaker"
must_not_have public/widget/chat.js 'Your message was received. Our team will reply shortly.' "fabricated widget fallback removed"
must_have public/widget/chat.js 's.indexOf("err-") === 0' "widget err-* local-only guard"
must_have supabase/functions/receive-widget-message/index.ts "EdgeRuntime.waitUntil(generateReplyTask)" "durable background generate-reply invocation"
must_have supabase/functions/receive-widget-message/index.ts "source_message_id: messageId" "exact source message handoff"
must_have supabase/functions/generate-reply/index.ts '.order("created_at", { ascending: false })' "latest-first source history"
must_have supabase/functions/generate-reply/index.ts 'const messages = [...newestMessages].reverse();' "chronological LLM replay"
must_have sql/pr7/pr7_core_rls_tenant_isolation.sql "conversations_company_select" "core conversation tenant RLS"
must_have sql/pr7/pr7_secondary_rls_tenant_isolation.sql "visitor_session_company_select" "secondary visitor tenant RLS"
must_have sql/pr7/pr7_security_definer_acl_hardening.sql "ce_purge_expired_snapshots" "security-definer ACL hardening"

# Post-freeze integration markers.
must_have supabase/functions/kb-search-proxy/index.ts '.from("company_membership")' "KB company membership authority"
must_have supabase/functions/kb-search-proxy/index.ts "company_membership_ambiguous" "KB standalone ambiguity fail-closed"
must_have supabase/functions/kb-search-proxy/index.ts "KB_SINGAPORE_TENANT_MAP_JSON" "KB frozen tenant map"
must_not_have supabase/functions/kb-search-proxy/index.ts '.from("user_roles")' "KB global role removed"
must_have src/routes/_authenticated/console.tsx 'supabase.functions.invoke("health-check"' "Console live health check"
must_not_have src/routes/_authenticated/console.tsx "System Operational" "fabricated system health removed"
must_have src/lib/api/config.service.ts "async function getCurrentCompanyRoles()" "Console company role authority"
must_have src/lib/api/config.service.ts '.from("company_membership")' "Console membership source"
must_not_have src/lib/api/config.service.ts '.from("user_roles")' "Console global role source removed"

# Build must pass in full authoritative repo.
echo "== BUILD =="
if npm run build; then echo "PASS npm run build"; else echo "FAIL npm run build"; fail=1; fi

if [ "$fail" -ne 0 ]; then echo "FINAL STATUS: FAIL"; exit 1; fi

echo "SOURCE STATUS: PASS"
echo "PRODUCTION STATUS: STOP"
echo "Reason: production SQL/Edge deployment/runtime smoke not executed by source gate."
exit 2
