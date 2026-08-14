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
  supabase/functions/_shared/ce-contract.ts \
  supabase/functions/_shared/ce-grounding.ts \
  scripts/pr7-singapore-kb-tenant-mapping-gate.sh \
  scripts/pr7-singapore-kb-mapping-source-gate.sh \
  scripts/pr7-singapore-kb-auth-env-gate.sh \
  scripts/pr7-singapore-kb-auth-source-gate.sh \
  scripts/pr7-singapore-kb-jwt-contract-test.sh \
  scripts/pr7-singapore-kb-callchain-gate.sh \
  scripts/pr7-singapore-kb-runtime-smoke.sh \
  tests/edge/ce-canonical-bundle-regression.mjs \
  supabase/functions/customer360-local/index.ts \
  public/widget/chat.js \
  src/routes/_authenticated/console.tsx \
  src/lib/api/config.service.ts \
  src/lib/authz/consoleCapabilities.ts \
  src/routes/_authenticated/console.training-candidates.tsx \
  src/routes/_authenticated/console.settings.llm-runtime.tsx \
  src/routes/_authenticated/console.widget-preview.tsx \
  src/routes/_authenticated/console.feedback-responses.tsx \
  src/routes/_authenticated/console.agent-settings.tsx \
  src/routes/_authenticated/console.analytics.tsx \
  src/routes/_authenticated/console.settings.feedback-test.tsx \
  src/lib/api/feedback.service.ts \
  src/services/aiChatbotSettingsService.ts \
  sql/pr7/pr7_agent_management_tenant_isolation.sql \
  sql/pr7/pr7_ai_reply_source_message_atomic_guard.sql \
  sql/pr7/pr7_config_rpc_tenant_guard.sql \
  sql/pr7/pr7_conversation_resolution_atomic_tx.sql \
  sql/pr7/pr7_ce_tenant_resolution_hardening.sql \
  sql/pr7/pr7_ce_tenant_resolution_hardening.rollback.sql \
  sql/pr6/pr6_canonical_evaluation_outbox.sql \
  sql/pr6/pr6_canonical_evaluation_outbox.rollback.sql \
  sql/pr7/pr7_ce_lineage_closure.sql \
  sql/pr7/pr7_ce_lineage_closure.rollback.sql \
  sql/pr7/pr7_company_dual_identity.sql \
  sql/pr7/pr7_company_dual_identity.rollback.sql \
  scripts/pr7-canonical-company-bootstrap.sh \
  scripts/pr7-canonical-company-bootstrap-rollback.sh \
  sql/pr7/pr7_company_membership_foundation.sql \
  sql/pr7/pr7_company_membership_foundation.rollback.sql \
  scripts/pr7-company-membership-bootstrap.sh \
  scripts/pr7-company-membership-bootstrap-rollback.sh \
  scripts/pr7-company-foundation-lifecycle-gate.sh \
  sql/pr7/pr7_channel_ownership_foundation.sql \
  sql/pr7/pr7_channel_ownership_foundation.rollback.sql \
  scripts/pr7-channel-ownership-bootstrap.sh \
  scripts/pr7-channel-ownership-bootstrap-rollback.sh \
  sql/pr7/pr7_conversation_lineage_foundation.sql \
  sql/pr7/pr7_conversation_lineage_foundation.rollback.sql \
  scripts/pr7-conversation-lineage-bootstrap.sh \
  scripts/pr7-conversation-lineage-bootstrap-rollback.sh \
  sql/pr7/pr7_tenant_ownership_consistency.sql \
  sql/pr7/pr7_tenant_ownership_consistency.rollback.sql \
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


# Final source closure: no dead runtime stubs / transitional write placeholders.
must_not_have src/lib/api/config.service.ts "DEFERRED_RESPONSE" "transitional deferred config stub removed"
must_not_have src/lib/api/config.service.ts "agentService" "dead agentService stub removed"
must_not_have src/lib/api/config.service.ts "analyticsService" "dead analyticsService stub removed"
must_have src/routes/_authenticated/console.agent-settings.tsx 'functions/v1/agent-management' "Agent Settings uses live agent-management Edge Function"
must_have src/routes/_authenticated/console.analytics.tsx 'supabase.functions.invoke(' "Analytics uses live Edge invocation"
must_have src/routes/_authenticated/console.analytics.tsx '"visitor-analytics"' "Analytics uses visitor-analytics Edge Function"


# Workflow 1 / Task 1.1 — CE canonical tenant resolution hardening.
must_have supabase/functions/conversation-evaluate/index.ts '.eq("company_id", resolvedCompanyId)' "CE membership uses canonical resolved company"
must_not_have supabase/functions/conversation-evaluate/index.ts '.eq("company_id", conv.company_id)' "CE nullable legacy company membership lookup removed"
must_have supabase/functions/conversation-evaluate/index.ts 'tenant_identity_conflict' "CE Edge handles conversation/channel identity conflict"
must_have sql/pr7/pr7_ce_tenant_resolution_hardening.sql 'LEFT JOIN public.channel_config ch ON ch.id = c.channel_config_id' "CE RPC resolves channel ownership"
must_have sql/pr7/pr7_ce_tenant_resolution_hardening.sql 'v_resolved_company_id := COALESCE(' "CE RPC canonical company resolution"
must_have sql/pr7/pr7_ce_tenant_resolution_hardening.sql "tenant_identity_conflict" "CE RPC fails closed on ownership conflict"
must_have sql/pr7/pr7_ce_tenant_resolution_hardening.sql 'p_grounding_manifest,v_resolved_company_id' "CE attempt persists resolved company"
must_have sql/pr7/pr7_ce_tenant_resolution_hardening.rollback.sql 'SELECT id, company_id INTO v_conv FROM public.conversations' "CE rollback restores prior tenant behavior"


# CE full call-chain regression: Singapore identity + deterministic human correction ordering.
must_have supabase/functions/_shared/ce-contract.ts 'singapore_tenant_id=${grounding.manifest.singapore_tenant_id}' "CE bundle uses Singapore tenant identity"
must_not_have supabase/functions/_shared/ce-contract.ts 'workspace_id=${grounding.manifest.workspace_id}' "retired CE workspace identity removed"
must_not_have supabase/functions/_shared/ce-contract.ts 'tenant_id=${grounding.manifest.tenant_id}' "retired CE tenant identity removed"
must_have supabase/functions/_shared/ce-contract.ts "BUNDLE_GROUNDING_COMPANY_MISMATCH" "CE bundle rejects KB company mismatch"
must_have supabase/functions/_shared/ce-contract.ts "isStrictlyAfterMessage(e, evaluatedAi)" "verified human uses deterministic message ordering"
must_have supabase/functions/_shared/ce-contract.ts 'human_agent: "human_agent"' "canonical human_agent role preserved"
must_have supabase/functions/_shared/ce-grounding.ts "aiCompanyId: tenant.scope.aiCompanyId" "CE grounding carries resolved AI company"
must_have supabase/functions/_shared/ce-grounding.ts 'detail: "ce_kb_company_mismatch"' "CE grounding rejects independent resolver mismatch"
must_have supabase/functions/_shared/ce-grounding.ts 'detail: "kb_resolution_changed_within_request"' "CE grounding rejects policy retrieval scope drift"

echo "== CE CANONICAL BUNDLE RUNTIME REGRESSION =="
if node tests/edge/ce-canonical-bundle-regression.mjs; then
  echo "PASS CE canonical bundle runtime regression"
else
  echo "FAIL CE canonical bundle runtime regression"
  fail=1
fi


# Workflow 1 / Task 1.3 — CE persisted lineage + downstream outbox closure.
must_have sql/pr6/pr6_canonical_evaluation_outbox.sql "CREATE CONSTRAINT TRIGGER trg_pr6_enqueue_canonical_evaluation" "PR6 canonical outbox uses constraint trigger"
must_have sql/pr6/pr6_canonical_evaluation_outbox.sql "DEFERRABLE INITIALLY DEFERRED" "PR6 outbox waits for snapshot in same transaction"
must_have sql/pr6/pr6_canonical_evaluation_outbox.sql "PR6_CANONICAL_SNAPSHOT_MISSING" "PR6 outbox requires canonical snapshot"
must_have sql/pr7/pr7_ce_lineage_closure.sql "CE_LINEAGE_TENANT_IDENTITY_CONFLICT" "CE lineage fails closed on conversation/channel conflict"
must_have sql/pr7/pr7_ce_lineage_closure.sql "CE_LINEAGE_ATTEMPT_EVALUATION_MISMATCH" "CE attempt/evaluation lineage enforced"
must_have sql/pr7/pr7_ce_lineage_closure.sql "CE_LINEAGE_SNAPSHOT_MISMATCH" "CE snapshot lineage enforced"
must_have sql/pr7/pr7_ce_lineage_closure.sql "CE_LINEAGE_OUTBOX_MISMATCH" "CE training outbox lineage enforced"
must_have sql/pr7/pr7_ce_lineage_closure.sql "trg_pr7_ce_evaluation_lineage" "CE evaluation lineage trigger exists"
must_have sql/pr7/pr7_ce_lineage_closure.sql "trg_pr7_ce_snapshot_lineage" "CE snapshot lineage trigger exists"
must_have sql/pr7/pr7_ce_lineage_closure.sql "trg_pr7_ce_outbox_lineage" "CE outbox lineage trigger exists"


# Workflow 2 / Task 2.1 — canonical SU Platform dual company identity.
must_have sql/pr7/pr7_company_dual_identity.sql "platform_company_id bigint" "canonical platform integer company id column"
must_have sql/pr7/pr7_company_dual_identity.sql "company.id must remain UUID" "canonical UUID company id preserved"
must_have sql/pr7/pr7_company_dual_identity.sql "uq_company_platform_company_id" "platform integer company id unique"
must_have scripts/pr7-canonical-company-bootstrap.sh "PR7_CANONICAL_COMPANY_UUID" "bootstrap requires canonical SU Platform UUID"
must_have scripts/pr7-canonical-company-bootstrap.sh "PR7_CANONICAL_PLATFORM_COMPANY_ID" "bootstrap requires canonical SU Platform integer id"
must_not_have scripts/pr7-canonical-company-bootstrap.sh "INSERT INTO public.company_membership" "Task 2.1 does not create membership"
must_not_have scripts/pr7-canonical-company-bootstrap.sh "UPDATE public.conversations" "Task 2.1 does not backfill conversations"
must_not_have scripts/pr7-canonical-company-bootstrap.sh "UPDATE public.channel_config" "Task 2.1 does not backfill channels"


# Workflow 2 / Task 2.2 — canonical company membership bootstrap.
must_have sql/pr7/pr7_company_membership_foundation.sql "uq_company_membership_company_user" "one canonical membership row per company/user"
must_have scripts/pr7-company-membership-bootstrap.sh "profile_role IS DISTINCT FROM legacy_role" "legacy role mirrors must reconcile"
must_have scripts/pr7-company-membership-bootstrap.sh "at least one active canonical admin is required" "membership bootstrap requires admin"
must_have scripts/pr7-company-membership-bootstrap.sh "active cross-company membership conflict" "cross-company membership fail closed"
must_have scripts/pr7-company-membership-bootstrap.sh "created_by_run" "membership rollback provenance"
must_not_have scripts/pr7-company-membership-bootstrap.sh "UPDATE public.conversations" "Task 2.2 does not backfill conversations"
must_not_have scripts/pr7-company-membership-bootstrap.sh "UPDATE public.channel_config" "Task 2.2 does not backfill channels"


echo "== WORKFLOW 2 FOUNDATION LIFECYCLE GATE =="
if bash scripts/pr7-company-foundation-lifecycle-gate.sh; then
  echo "PASS Workflow 2 company foundation lifecycle"
else
  echo "FAIL Workflow 2 company foundation lifecycle"
  fail=1
fi


# Workflow 3 / Task 3.1 — channel-only canonical ownership.
must_have scripts/pr7-channel-ownership-bootstrap.sh "foreign company channel exists" "channel backfill fails closed on foreign company"
must_have scripts/pr7-channel-ownership-bootstrap.sh "conversation ownership already started" "channel backfill ordering guard"
must_have scripts/pr7-channel-ownership-bootstrap.sh "No conversation.company_id was modified." "Task 3.1 channel-only scope"
must_not_have scripts/pr7-channel-ownership-bootstrap.sh "UPDATE public.conversations" "Task 3.1 does not backfill conversations"
must_have scripts/pr7-channel-ownership-bootstrap-rollback.sh "downstream conversation ownership exists" "channel rollback protects Task 3.2 lineage"
must_have scripts/pr7-channel-ownership-bootstrap-rollback.sh "channel ownership changed after bootstrap" "channel ownership drift blocks rollback"
must_have scripts/pr7-channel-ownership-bootstrap.sh "idempotent no-op" "channel bootstrap same-run no-op"
must_have scripts/pr7-channel-ownership-bootstrap-rollback.sh "already rolled back (idempotent no-op)" "channel rollback repeat no-op"


# Workflow 3 / Task 3.2 — conversation/direct-lineage backfill.
must_have scripts/pr7-conversation-lineage-bootstrap.sh "Task 3.1 channel ownership incomplete/conflicting" "conversation lineage requires canonical channels"
must_have scripts/pr7-conversation-lineage-bootstrap.sh "PR7_LEGACY_ORPHAN_CONVERSATIONS_BELONG_TO_CANONICAL_COMPANY" "orphan conversation ownership requires explicit confirmation"
must_have scripts/pr7-conversation-lineage-bootstrap.sh "explicit_orphan_confirmation" "orphan provenance is explicit"
must_have scripts/pr7-conversation-lineage-bootstrap.sh "UPDATE public.upstream_call_log" "upstream logs derive from conversation lineage"
must_have scripts/pr7-conversation-lineage-bootstrap.sh "unexpected noncanonical CE lineage" "CE lineage fail-closed assertion"
must_have scripts/pr7-conversation-lineage-bootstrap.sh "idempotent no-op" "conversation lineage same-run no-op"
must_have scripts/pr7-conversation-lineage-bootstrap-rollback.sh "downstream CE lineage exists" "conversation rollback protects CE lineage"
must_have scripts/pr7-conversation-lineage-bootstrap-rollback.sh "already rolled back (idempotent no-op)" "conversation rollback repeat no-op"


# Workflow 3 / Task 3.3 — runtime tenant ownership consistency guards.
must_have sql/pr7/pr7_tenant_ownership_consistency.sql "TENANT_LINEAGE_CONVERSATION_CHANNEL_MISMATCH" "conversation/channel mismatch rejected"
must_have sql/pr7/pr7_tenant_ownership_consistency.sql "TENANT_LINEAGE_CONVERSATION_VISITOR_CHANNEL_MISMATCH" "conversation/visitor channel mismatch rejected"
must_have sql/pr7/pr7_tenant_ownership_consistency.sql "TENANT_LINEAGE_FEEDBACK_VISITOR_MISMATCH" "feedback visitor mismatch rejected"
must_have sql/pr7/pr7_tenant_ownership_consistency.sql "trg_pr7_conversation_tenant_lineage" "conversation tenant lineage trigger"
must_have sql/pr7/pr7_tenant_ownership_consistency.sql "trg_pr7_feedback_tenant_lineage" "feedback tenant lineage trigger"

# Workflow 4 / Task 4.1 — Singapore KB explicit tenant mapping.
echo "== SINGAPORE KB MAPPING SOURCE GATE =="
if bash scripts/pr7-singapore-kb-mapping-source-gate.sh; then
  echo "PASS Singapore KB mapping source contract"
else
  echo "FAIL Singapore KB mapping source contract"
  fail=1
fi


# Workflow 4 / Task 4.2 — Singapore KB backend JWT authentication.
echo "== SINGAPORE KB AUTH SOURCE GATE =="
if bash scripts/pr7-singapore-kb-auth-source-gate.sh; then
  echo "PASS Singapore KB auth source contract"
else
  echo "FAIL Singapore KB auth source contract"
  fail=1
fi

echo "== SINGAPORE KB JWT CONTRACT TEST =="
if bash scripts/pr7-singapore-kb-jwt-contract-test.sh; then
  echo "PASS Singapore KB JWT contract"
else
  echo "FAIL Singapore KB JWT contract"
  fail=1
fi


# Workflow 4 / Task 4.3 — Singapore KB full call-chain contract.
echo "== SINGAPORE KB FULL CALL-CHAIN GATE =="
if bash scripts/pr7-singapore-kb-callchain-gate.sh; then
  echo "PASS Singapore KB full call-chain source contract"
else
  echo "FAIL Singapore KB full call-chain source contract"
  fail=1
fi

echo "== BUILD =="
if npm run build; then echo "PASS npm run build"; else echo "FAIL npm run build"; fail=1; fi
if [ "$fail" -ne 0 ]; then echo "FINAL STATUS: FAIL"; exit 1; fi
echo "SOURCE STATUS: PASS"
echo "PRODUCTION STATUS: STOP"
echo "Reason: production SQL/Edge deployment/runtime smoke not executed by source gate."
exit 2
