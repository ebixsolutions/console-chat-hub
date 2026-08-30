#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def replace_once(path: str, old: str, new: str):
    p = ROOT / path
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"anchor missing in {path}: {old[:100]!r}")
    if s.count(old) != 1:
        raise SystemExit(f"anchor count !=1 in {path}: {s.count(old)}")
    p.write_text(s.replace(old, new))

def regex_once(path: str, pattern: str, repl: str, flags=0):
    p = ROOT / path
    s = p.read_text()
    out, n = re.subn(pattern, repl, s, count=1, flags=flags)
    if n != 1:
        raise SystemExit(f"regex anchor count {n} in {path}: {pattern[:80]}")
    p.write_text(out)

GEN = "supabase/functions/generate-reply/index.ts"
RULES = "supabase/functions/_shared/escalation-rules.ts"
SHADOW = "supabase/functions/_shared/escalation-shadow.ts"
LIVE = "supabase/functions/widget-live-ai-test/index.ts"
PREVIEW = "src/routes/_authenticated/console.widget-preview.tsx"

# generate-reply: canonical conversation intelligence import
replace_once(
    GEN,
    'import { callModel, resolveGenerationMaxTokens, type LlmFailureCode } from "../_shared/llm-router.ts";\n',
    'import { callModel, resolveGenerationMaxTokens, type LlmFailureCode } from "../_shared/llm-router.ts";\nimport { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";\n',
)

regex_once(
    GEN,
    r'const MINIMAL_SAFE_FALLBACK_PROMPT = `.*?`;',
    '''const MINIMAL_SAFE_FALLBACK_PROMPT = `You are a professional and friendly customer service assistant.
Answer customer questions clearly, naturally and concisely.
When a request is incomplete, ask one necessary contextual question instead of escalating.
Never expose internal implementation or retrieval terminology.
Keep responses under 150 words.
Respond in the same language and script the customer is using.\n\n${CUSTOMER_CONVERSATION_POLICY}`;''',
    re.S,
)

regex_once(
    GEN,
    r'function isHandoffIntent\(text: string\): boolean \{.*?\n\}',
    '''function isHandoffIntent(text: string): boolean {
  return classifyHandoffIntent(text).explicit_request;
}''',
    re.S,
)

regex_once(
    GEN,
    r'function detectHandoffLanguage\(text: string\): "zh-TW" \| "zh-CN" \| "en" \| null \{.*?\n\}',
    '''function detectHandoffLanguage(text: string): "zh-TW" | "zh-CN" | "en" | null {
  const classified = classifyHandoffIntent(text);
  return classified.explicit_request ? classified.language : null;
}''',
    re.S,
)

# Human control is canonical: pending counts even before assignment.
for old in [
    'if (conversation.status === "transferred" || (conversation.status === "pending" && conversation.assigned_agent_id)) {',
]:
    p = ROOT / GEN
    s = p.read_text()
    count = s.count(old)
    if count != 2:
        raise SystemExit(f"expected 2 human-control guards, got {count}")
    p.write_text(s.replace(old, 'if (isHumanControlState(conversation.status, conversation.assigned_agent_id ?? null)) {'))
    break

# Required live rules consume canonical handoff classification + negation signal.
replace_once(
    GEN,
    '''  const context: EscalationContext = createEscalationContextBase({
    conversation_id: params.conversation_id,
    source_message_id: params.source_message_id,
    latest_message_content: params.latest_message_content,
    explicit_request: isHandoffIntent(params.latest_message_content),
    expected_tenant_id: params.expected_tenant_id,
  });

  context.conversation_status = availableSignal(params.conversation_status, "conversation_history");''',
    '''  const handoffClassification = classifyHandoffIntent(params.latest_message_content);
  const context: EscalationContext = createEscalationContextBase({
    conversation_id: params.conversation_id,
    source_message_id: params.source_message_id,
    latest_message_content: params.latest_message_content,
    explicit_request: handoffClassification.explicit_request,
    expected_tenant_id: params.expected_tenant_id,
  });
  context.pure_handoff_negation = availableSignal(
    handoffClassification.pure_negation,
    "local_classifier",
    { reason: handoffClassification.reason },
  );

  context.conversation_status = availableSignal(params.conversation_status, "conversation_history");''',
)

# Legacy generation must use the same customer-facing policy and never encourage blind handoff.
replace_once(
    GEN,
    'If you cannot answer a question confidently, acknowledge it honestly and offer to connect the customer with a human agent.\n',
    'If details are missing, ask one concise contextual question. If a fact cannot be verified, say you cannot confirm it and do not guess. Do not offer a human unless the governed escalation layer has decided one is appropriate.\n',
)
replace_once(
    GEN,
    'Do NOT invent estimated wait times, response-time promises, or queue positions.`;',
    'Do NOT invent estimated wait times, response-time promises, or queue positions.\n\n${CUSTOMER_CONVERSATION_POLICY}`;',
)

# Underspecified semantic turns clarify before KB or LLM. Atomic control gate preserves races/idempotency.
replace_once(
    GEN,
    '''  const _visitorLang = detectVisitorLanguage(_h1LastMsg);
  const _pr5ExpectedTenantId =''',
    '''  const _visitorLang = detectVisitorLanguage(_h1LastMsg);
  const _turnClassification = classifyConversationTurn(_h1LastMsg);
  if (_turnClassification.should_clarify_before_kb && !isHandoffIntent(_h1LastMsg)) {
    const clarification = NATURAL_CLARIFICATION[_visitorLang];
    const clarificationCommit = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      clarification,
      {
        response_route: "conversational_clarification",
        escalation_action: "clarification",
        handoff_required: false,
        reason_code: _turnClassification.reason,
      },
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (clarificationCommit.ok) {
      return new Response(JSON.stringify({
        success: true,
        reply: clarification,
        response_route: "conversational_clarification",
        handoff_required: false,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (["human_control", "resolved", "superseded_source"].includes(clarificationCommit.result)) {
      return new Response(JSON.stringify({ success: true, skipped: clarificationCommit.result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: false, error: `clarification_commit_${clarificationCommit.result}` }), {
      status: 409,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const _pr5ExpectedTenantId =''',
)

# Relevant summary-only retrieval is not answerability. Require usable full_content before confident_match.
replace_once(
    GEN,
    '''    _pr5RagMatchState = "confident_match";
    ragResult.chunks = usableChunks;''',
    '''    if (!hasUsableFullContentEvidence(usableChunks, minScore)) {
      _pr5RagMatchState = "partial_match";
      const requiredResponse = await evaluateAndPersistRequiredRulesLive(supabaseAdmin, {
        conversation_id,
        source_message_id,
        latest_message_content: _h1LastMsg,
        conversation_status: conversation.status,
        assigned_agent_id: conversation.assigned_agent_id ?? null,
        greeting_or_trivial: _pr5GreetingOrTrivial,
        visitor_language: _visitorLang,
        expected_tenant_id: _pr5ExpectedTenantId,
        rag_match_state: _pr5RagMatchState,
        topic_risk_level: _pr5LocalRisk?.level,
        verified_local_risk_classification: _pr5LocalRisk?.verified,
        conversation_duration_sec: _pr5ConversationDurationSec,
        turn_count: _pr5History.turn_count,
        consecutive_no_answer: _pr5History.consecutive_no_answer,
        clarification_attempts: _pr5History.clarification_attempts,
        exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
        threat_flag: _pr5ThreatSignal,
        compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal,
      });
      if (requiredResponse) return requiredResponse;
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, _h1LastMsg);
        if (r1Response) return r1Response;
      }
      const clarification = await attemptFirstNoMatchClarification(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        isHighRisk ? "KB_LOW_SCORE_HIGH_RISK" : "KB_LOW_SCORE_STANDARD",
        _visitorLang,
        {
          high_risk: isHighRisk,
          explicit_human_request: isHandoffIntent(_h1LastMsg),
          threat_flag: _pr5ThreatSignal?.value === true,
          compliance_requires_human_review: _pr5ComplianceSignal?.value === true,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
        },
        { ...traceMetadata, answerability: "missing_full_content_evidence" },
      );
      if (clarification) return clarification;
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        isHighRisk ? "KB_LOW_SCORE_HIGH_RISK" : "KB_LOW_SCORE_STANDARD",
        source_message_id,
        { ...traceMetadata, answerability: "missing_full_content_evidence" },
        _visitorLang,
      );
    }
    _pr5RagMatchState = "confident_match";
    ragResult.chunks = usableChunks;''',
)

replace_once(
    GEN,
    'const finalSystemPrompt = [basePrompt, buildMaskedContextBlock(customerContext, opaqueCustomerRef), buildRagBlock(ragResult)].filter((s) => s && s.length > 0).join("\\n\\n");',
    'const finalSystemPrompt = [basePrompt, CUSTOMER_CONVERSATION_POLICY, buildMaskedContextBlock(customerContext, opaqueCustomerRef), buildRagBlock(ragResult)].filter((s) => s && s.length > 0).join("\\n\\n");',
)

# escalation rules: all canonical human-control statuses suppress AI/escalation evaluation.
regex_once(
    RULES,
    r'function isExistingHumanControl\(context: EscalationContext\): boolean \{.*?\n\}',
    '''function isExistingHumanControl(context: EscalationContext): boolean {
  const status = isAvailable(context.conversation_status) ? context.conversation_status.value : null;
  const assigned = isAvailable(context.assigned_agent_id) ? context.assigned_agent_id.value : null;
  return (
    (typeof assigned === "string" && assigned.length > 0) ||
    status === "pending" ||
    status === "transferred" ||
    status === "human_needed" ||
    status === "human_control"
  );
}''',
    re.S,
)

# shadow adapter computes canonical negation signal itself so every caller is protected.
replace_once(
    SHADOW,
    'import { evaluateFullEscalationRuleset } from "./escalation-rules.ts";\n',
    'import { evaluateFullEscalationRuleset } from "./escalation-rules.ts";\nimport { classifyHandoffIntent } from "./conversation-intelligence.ts";\n',
)
replace_once(
    SHADOW,
    '''  context.conversation_status = availableSignal(
    input.conversation_status,
    "conversation_history",
  );''',
    '''  const handoffClassification = classifyHandoffIntent(input.latest_message_content);
  context.explicit_request = availableSignal(
    handoffClassification.explicit_request,
    "local_classifier",
    { reason: handoffClassification.reason },
  );
  context.pure_handoff_negation = availableSignal(
    handoffClassification.pure_negation,
    "local_classifier",
    { reason: handoffClassification.reason },
  );
  context.conversation_status = availableSignal(
    input.conversation_status,
    "conversation_history",
  );''',
)

# widget-live backend returns enough canonical control state for UI recovery after expected 409.
replace_once(
    LIVE,
    '''        conversation_id: requestedConversationId,
        conversation_status: owned.conversation.status,
        messages: await loadTestMessages(admin, requestedConversationId),''',
    '''        conversation_id: requestedConversationId,
        conversation_status: owned.conversation.status,
        assigned_agent_id: owned.conversation.assigned_agent_id ?? null,
        human_control:
          HUMAN_CONTROL_STATUSES.has(String(owned.conversation.status)) ||
          Boolean(owned.conversation.assigned_agent_id),
        messages: await loadTestMessages(admin, requestedConversationId),''',
)
replace_once(
    LIVE,
    '''        conversation_id: conversationId,
        conversation_status: state?.status ?? null,
        messages,''',
    '''        conversation_id: conversationId,
        conversation_status: state?.status ?? null,
        assigned_agent_id: state?.assigned_agent_id ?? null,
        human_control:
          HUMAN_CONTROL_STATUSES.has(String(state?.status ?? "")) ||
          Boolean(state?.assigned_agent_id),
        messages,''',
)
replace_once(
    LIVE,
    '''      conversation_id: conversationId,
      conversation_status: state?.status ?? null,
      handoff_persisted:''',
    '''      conversation_id: conversationId,
      conversation_status: state?.status ?? null,
      assigned_agent_id: state?.assigned_agent_id ?? null,
      human_control:
        HUMAN_CONTROL_STATUSES.has(String(state?.status ?? "")) ||
        Boolean(state?.assigned_agent_id),
      handoff_persisted:''',
)

# Preview: model canonical human state, recover expected 409 by loading persisted conversation, show normal banner, disable send.
replace_once(
    PREVIEW,
    '''  full_content_evidence_count: number;
  references?: Array<{''',
    '''  full_content_evidence_count: number;
  conversation_status?: string | null;
  assigned_agent_id?: string | null;
  human_control?: boolean;
  handoff_persisted?: boolean;
  references?: Array<{''',
)
replace_once(
    PREVIEW,
    '''    setTestConversationId(data.conversation_id);
    window.localStorage.setItem("widget_live_test_conversation_id", data.conversation_id);
    applyServerMessages(data.messages);''',
    '''    setTestConversationId(data.conversation_id);
    window.localStorage.setItem("widget_live_test_conversation_id", data.conversation_id);
    const underHumanControl =
      data.human_control === true ||
      ["pending", "transferred", "human_needed", "human_control"].includes(String(data.conversation_status ?? "")) ||
      Boolean(data.assigned_agent_id);
    setHumanState(underHumanControl ? (data.assigned_agent_id ? "assigned" : "waiting") : "none");
    applyServerMessages(data.messages);
    return { humanControl: underHumanControl };''',
)
replace_once(
    PREVIEW,
    '''      if (
        error ||
        !payload ||
        payload.success !== true
      ) {
        appendLiveFailure(
          text,
          safeLiveError(
            error,
            payload as LiveAiFailure | null,
          ),
        );
        return;
      }''',
    '''      if (
        error ||
        !payload ||
        payload.success !== true
      ) {
        if (testConversationId) {
          const recovered = await loadLiveConversation(testConversationId);
          if (recovered?.humanControl) return;
        }
        appendLiveFailure(
          text,
          safeLiveError(
            error,
            payload as LiveAiFailure | null,
          ),
        );
        return;
      }''',
)
replace_once(
    PREVIEW,
    '''      applyServerMessages(result.messages);
      void loadLiveHistory();''',
    '''      const underHumanControl =
        result.human_control === true ||
        ["pending", "transferred", "human_needed", "human_control"].includes(String(result.conversation_status ?? "")) ||
        Boolean(result.assigned_agent_id) || result.handoff_persisted === true;
      setHumanState(underHumanControl ? (result.assigned_agent_id ? "assigned" : "waiting") : "none");
      applyServerMessages(result.messages);
      void loadLiveHistory();''',
)
replace_once(
    PREVIEW,
    '  const send = () => {\n    if (typing || !input.trim()) return;',
    '  const send = () => {\n    if (typing || !input.trim() || (mode === "live" && humanState !== "none")) return;',
)
replace_once(
    PREVIEW,
    '{mode === "simulation" && humanState !== "none" && (',
    '{humanState !== "none" && (',
)
replace_once(
    PREVIEW,
    '''          {humanState === "waiting"
            ? lang === "zh"
              ? "正在模擬等待真人客服…"
              : "Simulating wait for a human agent…"
            : lang === "zh"
              ? "已模擬真人客服接手；AI 回覆暫停。"
              : "Human agent simulated as connected; AI replies are paused."}''',
    '''          {humanState === "waiting"
            ? lang === "zh"
              ? mode === "live"
                ? "此對話已轉交真人客服，AI 回覆已暫停。客服接手後會在同一對話繼續回覆。"
                : "正在模擬等待真人客服…"
              : mode === "live"
                ? "This conversation has been handed to human support. AI replies are paused until an agent takes over in this same chat."
                : "Simulating wait for a human agent…"
            : lang === "zh"
              ? mode === "live"
                ? "真人客服已接手；AI 回覆暫停。"
                : "已模擬真人客服接手；AI 回覆暫停。"
              : mode === "live"
                ? "A human agent has taken over; AI replies are paused."
                : "Human agent simulated as connected; AI replies are paused."}''',
)
replace_once(
    PREVIEW,
    '''            placeholder={placeholder}
          />''',
    '''            placeholder={
              mode === "live" && humanState !== "none"
                ? (lang === "zh" ? "真人客服處理中，AI 輸入已暫停" : "Human support is handling this conversation")
                : placeholder
            }
            disabled={mode === "live" && humanState !== "none"}
          />''',
)
replace_once(
    PREVIEW,
    '''              (mode === "simulation" &&
                humanState === "assigned")''',
    '''              humanState !== "none"''',
)

print("Task 3.3 conversational runtime patch applied")
