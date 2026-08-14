#!/bin/bash
set -u
REPO="${1:-$HOME/Documents/GitHub/console-chat-hub}"
cd "$REPO" || { echo "FAIL: repo unavailable"; exit 1; }
fail=0
check_file(){ [ -s "$1" ] && echo "PASS file: $1" || { echo "FAIL missing/empty: $1"; fail=1; }; }
must_have(){ grep -Fq "$2" "$1" && echo "PASS $3" || { echo "FAIL $3"; fail=1; }; }
must_not_have(){ grep -Fq "$2" "$1" && { echo "FAIL $3"; fail=1; } || echo "PASS $3"; }

echo "== PR7 SOURCE FINAL GATE =="
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
  src/lib/authz/consoleCapabilities.ts \
  src/routes/_authenticated/console.training-candidates.tsx \
  src/routes/_authenticated/console.settings.llm-runtime.tsx \
  src/routes/_authenticated/console.widget-preview.tsx \
  src/routes/_authenticated/console.feedback-responses.tsx \
  src/routes/_authenticated/console.settings.feedback-test.tsx \
  src/lib/api/feedback.service.ts \
  src/services/aiChatbotSettingsService.ts \
  sql/pr7/pr7_agent_management_tenant_isolation.sql \
  sql/pr7/pr7_ai_reply_source_message_atomic_guard.sql \
  sql/pr7/pr7_config_rpc_tenant_guard.sql \
  sql/pr7/pr7_conversation_resolution_atomic_tx.sql \
  sql/pr7/pr7_core_rls_tenant_isolation.sql \
  sql/pr7/pr7_feedback_config_tenant_scope.sql \
  sql/pr7/pr7_feedback_widget_delivery_atomic.sql \
  sql/pr7/pr7_recall_message_atomic_tx.sql \
  sql/pr7/pr7_secondary_rls_tenant_isolation.sql \
  sql/pr7/pr7_security_definer_acl_hardening.sql
do check_file "$f"; done

must_have supabase/config.toml $'[functions.generate-reply]\nverify_jwt = true' "generate-reply gateway JWT"
must_have supabase/config.toml $'[functions.kb-search-proxy]\nverify_jwt = true' "KB proxy gateway JWT"
must_have supabase/functions/agent-assist/index.ts "resolveAgentCompanyScope" "Agent Assist company resolver"
must_not_have supabase/functions/agent-assist/index.ts '.from("user_roles")' "Agent Assist global-role bypass removed"
must_have supabase/functions/widget-poll-messages/index.ts '.order("id", { ascending: true })' "widget poll deterministic tie-breaker"
must_not_have public/widget/chat.js 'Your message was received. Our team will reply shortly.' "fabricated widget fallback removed"
must_have supabase/functions/receive-widget-message/index.ts "EdgeRuntime.waitUntil(generateReplyTask)" "durable reply invocation"
must_have supabase/functions/generate-reply/index.ts 'const messages = [...newestMessages].reverse();' "chronological LLM replay"
must_have sql/pr7/pr7_core_rls_tenant_isolation.sql "conversations_company_select" "core tenant RLS"
must_have sql/pr7/pr7_secondary_rls_tenant_isolation.sql "visitor_session_company_select" "secondary tenant RLS"

must_have supabase/functions/kb-search-proxy/index.ts '.from("company_membership")' "KB membership authority"
must_not_have supabase/functions/kb-search-proxy/index.ts '.from("user_roles")' "KB global role removed"
must_have src/routes/_authenticated/console.tsx 'supabase.functions.invoke("health-check"' "Console live health check"
must_not_have src/routes/_authenticated/console.tsx "System Operational" "fabricated system health removed"
must_have src/lib/api/config.service.ts "async function getCurrentCompanyRoles()" "Console company role authority"
must_not_have src/lib/api/config.service.ts '.from("user_roles")' "Console global role source removed"

must_not_have src/lib/authz/consoleCapabilities.ts "ce.training.dispatch" "AI Chatbot training capability removed"
must_have src/routes/_authenticated/console.training-candidates.tsx 'redirect({ to: "/console/conversation-evaluation" })' "legacy training route redirects"
must_have src/routes/_authenticated/console.settings.llm-runtime.tsx '.from("upstream_call_log")' "LLM runtime live telemetry"
must_have src/routes/_authenticated/console.settings.llm-runtime.tsx '.eq("company_id", scope.companyId)' "LLM telemetry tenant scope"
must_not_have src/routes/_authenticated/console.settings.llm-runtime.tsx "Claude Haiku" "hard-coded LLM claim removed"

# Settings tenant closure.
must_have src/lib/api/config.service.ts '.eq("company_id", scope.data.companyId)' "channel operations explicit tenant scope"
must_have src/lib/api/config.service.ts "updateChannelConfigFn" "channel update implemented"
must_have src/lib/api/config.service.ts "getWidgetConfigFn" "widget read implemented"
must_have src/lib/api/config.service.ts "updateWidgetConfigFn" "widget update implemented"
must_have src/lib/api/config.service.ts "widget_shared_or_unbound" "widget ownership fail-closed"
must_have src/lib/api/config.service.ts "updateAgentProfileFn" "self profile update implemented"
must_not_have src/routes/_authenticated/console.widget-preview.tsx '.from("channel_config")' "Widget Preview direct global DB read removed"
must_have src/routes/_authenticated/console.widget-preview.tsx "configService.listChannelConfigs()" "Widget Preview uses tenant-scoped service"


# Feedback production boundary.
must_have src/lib/api/config.service.ts '["admin", "supervisor"]' "feedback config write role enforcement"
must_have src/lib/api/feedback.service.ts "listFeedbackResponsesFn" "tenant-scoped feedback response server function"
must_have src/lib/api/feedback.service.ts 'conversations!inner(company_id)' "feedback response company join"
must_have src/lib/api/feedback.service.ts '.eq("conversations.company_id", companyId)' "feedback response explicit company scope"
must_not_have src/lib/api/feedback.service.ts "generateFeedbackTokenFn" "test-only token generator removed"
must_not_have src/lib/api/feedback.service.ts "recordFeedbackResponseFn" "internal authenticated feedback mutation removed"
must_not_have src/lib/api/feedback.service.ts "console-chat-hub.lovable.app" "test-only feedback base URL removed"
must_have src/routes/_authenticated/console.settings.feedback-test.tsx 'redirect({ to: "/console/feedback-responses" })' "internal feedback test route disabled"
must_not_have src/routes/_authenticated/console.feedback-responses.tsx '.from("feedback_request")' "Feedback Responses direct DB read removed"
must_have src/routes/_authenticated/console.feedback-responses.tsx "feedbackService.listFeedbackResponses" "Feedback Responses uses scoped server API"
must_have src/services/aiChatbotSettingsService.ts "feedbackService.listFeedbackResponses" "Feedback settings recent requests use scoped server API"

echo "== BUILD =="
if npm run build; then echo "PASS npm run build"; else echo "FAIL npm run build"; fail=1; fi
if [ "$fail" -ne 0 ]; then echo "FINAL STATUS: FAIL"; exit 1; fi
echo "SOURCE STATUS: PASS"
echo "PRODUCTION STATUS: STOP"
echo "Reason: production SQL/Edge deployment/runtime smoke not executed by source gate."
exit 2
