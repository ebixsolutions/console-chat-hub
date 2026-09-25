import {
  prepareConversationRecall,
  type RecallCommerceSnapshot,
} from "../_shared/conversation-recall.ts";
import {
  applyServiceTone,
  buildServicePlanPromptBlock,
  planConversationService,
  renderServicePlanReply,
  renderServiceRecovery,
  renderTargetedServiceQuestion,
  type ServiceDialoguePlan,
} from "../_shared/conversation-service-planner.ts";
import {
  applyServiceRuntimeDerivation,
  deriveServiceRuntimeInputs,
} from "../_shared/conversation-service-runtime.ts";
import { fetchTrustedCustomerContext } from "../_shared/customer360-entitlement-client.ts";
// B7 generate-reply — L5b orchestration skeleton + Task A.1A Deterministic Handoff Patch
//
// Source of truth: Contract 11 §3.1 + Contract 07 + Contract 03 §1.1 + Contract 08
//
// CRITICAL SAFETY INVARIANTS (L5b):
//   1. Adapter flags default to FALSE. Legacy mode is used only when all adapter
//      flags AND all PR-5 escalation runtime gates are disabled. When an explicit
//      PR-5 runtime gate is enabled, orchestration owns canonical escalation routing.
//   2. Orchestration path (any flag true) is SKELETON ONLY. Adapter calls, prompt
//      assembly, status matrix guard, trace writes are gated and conceptual; no
//      schema changes, no PII or full prompt persisted, no tools attached to LLM.
//   3. Full draft / handoff / auto-send policy and Tool Executor Gate are L5c-L5e.
//
// Task A.1A patch (2026-06-29):
//   Adds deterministic handoff branch inside legacyGenerateReply().
//   When visitor message contains handoff intent, returns fixed safe wording directly.
//   No LLM call on handoff intent. Pattern mirrors existing legacyGenerateReply() writes.
//   Pre-checks confirmed: status='pending' valid; is_recalled exists; DELETE pattern used.
//   Authorized by: Director Charlson.

import {
  fetchKBRag,
  type KBDocumentCandidate,
  type KBFullChunk,
  type KBPreActivationActor,
  type KBResolvedScope,
  resolveKBEndpoint,
  resolveTenantScope,
} from "../_shared/kb-client.ts";
import {
  canAnswerBoundedNoCurrentEvidence,
  classifyCurrentFactEvidence,
  NO_CURRENT_EVIDENCE_ROUTE,
  renderBoundedNoCurrentEvidence,
} from "../_shared/current-fact-evidence.ts";
import {
  arbitrateAnaphoricProductFollowUp,
  classifyNaturalCustomerIntent,
  type NaturalCustomerIntent,
  renderNaturalImmediateResponse,
  renderNaturalNoCurrentEvidence,
  requiresCurrentMerchantEvidence,
} from "../_shared/natural-customer-response.ts";
import { productKbSemanticContract } from "../_shared/product-kb-semantic-contract.ts";
import { evaluateEscalationShadow } from "../_shared/escalation-shadow.ts";
import {
  persistRequiredEscalationClarification,
  persistRequiredEscalationHandoff,
} from "../_shared/escalation-live.ts";
import {
  availableSignal,
  createEscalationContextBase,
  type EscalationContext,
  escalationFeatureFlagsFromEnv,
  type EscalationRuleId,
  type RagMatchState,
  type TopicRiskLevel,
} from "../_shared/escalation-signals.ts";
import { evaluateFullEscalationRuleset } from "../_shared/escalation-rules.ts";
import { assessPolicyEvidenceForR4 } from "../_shared/escalation-policy.ts";
import {
  type P1PredictionInput,
  validateP1PredictionSignals,
} from "../_shared/escalation-p1.ts";
import {
  callModel,
  type LlmFailureCode,
  resolveGenerationMaxTokens,
} from "../_shared/deterministic-runtime-router.ts";
import {
  buildCustomerAdvisoryContext,
  buildCustomerContextAcknowledgement,
  buildCustomerContextRequirementsResponse,
  classifyConversationTurn,
  classifyHandoffIntent,
  CUSTOMER_CONVERSATION_POLICY,
  hasUsableFullContentEvidence,
  isHumanControlState,
  NATURAL_CLARIFICATION,
} from "../_shared/conversation-intelligence.ts";
import {
  buildCanonicalContinuityBlock,
  buildCanonicalRetrievalQuery,
  buildWorkflow5TopicalClarification,
  resolveConversationMemoryResponse,
  resolveWorkflow5ConversationLanguage,
  workflow5ShortTopicHint,
} from "../_shared/conversation-runtime-state.ts";
import { classifyCanonicalConversationTurn } from "../_shared/conversation-semantic-contract.ts";
import {
  type CurrentGroundingTarget,
  deriveCurrentGroundingTarget,
  selectCanonicalGrounding,
} from "../_shared/canonical-grounding.ts";
import type { ReferenceAuthorityDecision } from "../_shared/commerce-state-authority.ts";
import { buildCitationMetadata } from "../_shared/citation-lineage.ts";
import {
  type CanonicalKbDirectAnswer,
  resolveCanonicalKbDirectAnswer,
} from "../_shared/canonical-kb-direct-answer.ts";
import {
  buildInheritedTransformCitationMetadata,
  buildPriorGroundedTransformBlock,
  buildPriorGroundedTransformGenerationSystem,
  buildPriorGroundedTransformGenerationUser,
  buildPriorGroundedTransformRetrySystem,
  resolvePriorGroundedTransform,
} from "../_shared/prior-grounded-transform.ts";
import { isDirectViolentThreat } from "../_shared/e2-direct-threat.ts";
import { buildReturnToAiGenerationGuard } from "../_shared/return-to-ai-control.ts";
import {
  buildMissingFactsQuestion,
  buildWarmHandoffPackage,
} from "../_shared/warm-handoff.ts";
import {
  deriveHandoffDecisionInput,
  evaluateHandoffDecision,
} from "../_shared/handoff-decision.ts";
import {
  buildConversationClosureReply,
  classifyConversationClosure,
} from "../_shared/conversation-closure.ts";
import {
  buildC2PendingClosureReply,
  decideTransactionClosure,
} from "../_shared/transaction-closure-handoff.ts";
import { buildRealtimeR3SentimentSignals } from "../_shared/runtime-signal-lifecycle.ts";
import {
  buildEmotionReplyStrategyContext,
  resolvePositiveRecoveryAcknowledgement,
} from "../_shared/emotion-reply-strategy.ts";
import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { bindAuthorizedReply, resumeCommittedLifecycleReply } from "../_shared/revision-bound-reply.ts";
import {
  type CommerceRuntimeOutcome,
  type CommerceStateDbClient,
  resolveCommittedAddressCorrection,
  runCommerceStateRuntime,
} from "../_shared/commerce-state-runtime.ts";
import { interpretCommerceSemantics } from "../_shared/commerce-semantic-interpreter.ts";
import type { CommerceSemanticFrame } from "../_shared/commerce-semantic-frame.ts";
import {
  buildBoundedConversationContext,
  type CanonicalConversationMemory,
  composeBoundedGenerationEnvelope,
  type MemoryHistoryRow,
  refreshConversationLongMemory,
  verifyCommittedRoomCorrectionMemory,
  verifyCommittedLifecycleMemory,
} from "../_shared/conversation-long-memory.ts";
import {
  type ConversationCommerceState,
  isConversationCommerceState,
} from "../_shared/commerce-state-contract.ts";
import {
  historicalQuoteValidityReply,
  isRecoverableTerminalError,
  isRecoverableTerminalStatus,
  runWithTerminalDeadline,
  terminalRecoveryReply,
} from "../_shared/generation-terminal-guard.ts";
import {
  type B2DatabaseClient,
  type B2CanonicalSnapshot,
  type B2Decision,
  type B2KbPriceProof,
  type B2PersistenceKind,
  type B2TrustedTargetedClarification,
  buildB2AuthoritativeReadbackProof,
  classifyCommerceStatePersistenceResult,
  executeB2PersistenceGate,
} from "../_shared/pre-send-conversion-supervisor.ts";
import type { B2TrustedCorrectionCommit, B2TrustedJourneyProgress, B2TrustedLifecycleCommit } from "../_shared/b2-journey-progress-contract.ts";
import { resolveCanonicalCommerceResolution } from "../_shared/conversation-resolution-contract.ts";
import { readExactAiReplyCommit } from "../_shared/authoritative-commit-readback.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.45.0";

type SupabaseAdminClient = SupabaseClient<any, "public", any>;

// Current-main escalation-live.ts intentionally exposes a narrow Promise-shaped
// RPC contract. Supabase-js returns an awaitable Postgrest builder. Normalize that
// boundary once so the frozen escalation semantics/RPC names remain unchanged.
function requiredEscalationRpcClient(client: SupabaseAdminClient) {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const { data, error } = await client.rpc(fn, args as any);
      const payload: Record<string, unknown> | null = data == null
        ? null
        : (typeof data === "object" && !Array.isArray(data)
          ? data as Record<string, unknown>
          : { result: data });
      return {
        data: payload,
        error: error ? { message: String(error.message ?? "rpc_error") } : null,
      };
    },
  };
}
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const MINIMAL_SAFE_FALLBACK_PROMPT =
  `You are a professional and friendly customer service assistant.
Answer customer questions clearly, naturally and concisely.
When a request is incomplete, ask one necessary contextual question instead of escalating.
Never expose internal implementation or retrieval terminology.
Keep responses under 150 words.
Respond in the same language and script the customer is using.

${CUSTOMER_CONVERSATION_POLICY}`;

const SAFE_HANDOFF_WORDING: Record<string, string> = {
  "zh-TW":
    "我們已將你的對話轉交真人客服。客服接手後會在此對話中回覆你；如目前有可用的輪候資料，系統會在此顯示輪候位置及預計等候時間。",
  "zh-CN":
    "我们已将你的对话转交人工客服。客服接手后会在此对话中回复你；如目前有可用的排队资料，系统会在此显示排队位置及预计等待时间。",
  en:
    "I’ve handed this conversation to a human support agent. They will reply in this same chat after taking over; if live queue data is available, your queue position and estimated wait will be shown here.",
};

const HUMAN_SUPPORT_INFO_WORDING: Record<"zh-TW" | "zh-CN" | "en", string> = {
  "zh-TW":
    "我目前沒有已確認的真人客服服務時間資料。如果你現在要轉真人客服，可以直接告訴我。",
  "zh-CN":
    "我目前没有已确认的人工客服服务时间资料。如果你现在要转人工客服，可以直接告诉我。",
  en:
    "I don't currently have confirmed human-support service hours. If you want a human agent now, you can tell me directly.",
};

const REQUIRED_ESCALATION_SAFE_WORDING: Record<
  "E2" | "E1" | "R2",
  Record<"zh-TW" | "zh-CN" | "en", string>
> = {
  E2: {
    "zh-TW": "這個問題需要由客服人員進一步處理。我已將對話轉交客服跟進。",
    "zh-CN": "这个问题需要由客服人员进一步处理。我已将对话转交客服跟进。",
    en:
      "This issue requires human review. I’ve handed the conversation to a support agent for follow-up.",
  },
  E1: {
    "zh-TW":
      "這個問題涉及重要風險或政策內容，為確保資訊準確，我已轉交客服人員跟進。",
    "zh-CN":
      "这个问题涉及重要风险或政策内容，为确保信息准确，我已转交客服人员跟进。",
    en:
      "This issue involves important risk or policy considerations. I’ve handed it to a support agent for accurate follow-up.",
  },
  R2: {
    "zh-TW": "我目前未能可靠解決這個問題，已將對話轉交客服人員跟進。",
    "zh-CN": "我目前未能可靠解决这个问题，已将对话转交客服人员跟进。",
    en:
      "I’m not able to resolve this reliably, so I’ve handed the conversation to a support agent for follow-up.",
  },
};

const R2_CLARIFICATION_SAFE_WORDING: Record<"zh-TW" | "zh-CN" | "en", string> =
  {
    "zh-TW":
      "我想再確認一次，才能更準確地幫你。請補充這個問題中最重要的細節，例如你希望處理的項目或目前遇到的情況。",
    "zh-CN":
      "我想再确认一次，才能更准确地帮你。请补充这个问题中最重要的细节，例如你希望处理的项目或目前遇到的情况。",
    en:
      "I’d like to clarify one detail so I can help more accurately. Please add the most important detail about what you want handled or what is happening now.",
  };

const GROUNDING_RECOVERY_WORDING: Record<"zh-TW" | "zh-CN" | "en", string> = {
  "zh-TW": "我想再確認一下資料，避免答錯。你最想先確認哪一點？",
  "zh-CN": "我想再确认一下资料，避免答错。你最想先确认哪一点？",
  en:
    "I want to verify the information before answering so I don’t give you something inaccurate. Which point would you like me to confirm first?",
};

const C1_AUTHORITY_CONFLICT_WORDING: Record<"zh-TW" | "zh-CN" | "en", string> =
  {
    "zh-TW":
      "我找到兩項同等有效但內容不一致的現行資料，因此不能安全地替你判定。請告訴我你想核實的具體項目、資料來源或日期，我會再精確確認。",
    "zh-CN":
      "我找到两项同等有效但内容不一致的现行资料，因此不能安全地替你判定。请告诉我你想核实的具体项目、资料来源或日期，我会再精确确认。",
    en:
      "I found two equally authoritative current sources that disagree, so I cannot safely choose between them. Please specify the exact item, source, or date you want verified.",
  };

function referenceAuthorityMetadata(
  decision: ReferenceAuthorityDecision,
): Record<string, unknown> {
  return {
    contract: "AI-ABC-C1",
    decision: decision.decision,
    reason: decision.reason,
    selected_source_id: decision.selected_source_id,
    selected_authority_class: decision.selected_authority_class,
    conflict_source_ids: decision.conflict_source_ids,
    rejected: decision.rejected.map((item) => ({
      source_id: item.source_id,
      reason: item.reason,
    })),
    provenance: decision.provenance,
  };
}

const HANDOFF_STRONG_TRIGGERS: Record<string, string[]> = {
  "zh-TW": ["轉真人", "轉人工", "真人客服", "人工客服"],
  "zh-CN": ["转真人", "转人工", "真人客服", "人工客服"],
  en: [
    "human agent",
    "live agent",
    "speak to human",
    "talk to human",
    "real person",
    "human support",
    "speak with someone",
    "talk to someone",
  ],
};
const HANDOFF_WEAK_TERMS = ["客服", "人工", "真人"];
const HANDOFF_INTENT_VERBS_ZH = [
  "要",
  "想",
  "找",
  "轉",
  "转",
  "接",
  "聯絡",
  "联系",
  "幫我",
  "帮我",
];
const HANDOFF_INTENT_VERBS_EN = [
  "speak",
  "talk",
  "connect",
  "need",
  "want",
  "get",
];
const ZH_CN_CHARS = ["转", "们", "队", "预计", "为您", "为我", "为你"];
const ZH_TW_CHARS = ["轉", "們", "隊", "預計", "為您", "為我", "為你"];

function isHandoffIntent(text: string): boolean {
  return classifyHandoffIntent(text).explicit_request;
}

function detectHandoffLanguage(text: string): "zh-TW" | "zh-CN" | "en" | null {
  const classified = classifyHandoffIntent(text);
  return classified.explicit_request ? classified.language : null;
}

function sanitizeUserMessage(text: string): string {
  if (!text) return "";
  let s = text;
  s = s.replace(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    "[redacted_email]",
  );
  s = s.replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted_phone]");
  s = s.replace(/\d{7,}/g, "[redacted_digits]");
  if (s.length > 300) s = s.slice(0, 300);
  return s;
}

async function writeTraces(
  supabaseAdmin: SupabaseAdminClient,
  params: {
    conversation_id: string;
    message_id: string | null;
    user_message_raw: string;
    response_latency_ms: number;
    token_input: number | null;
    token_output: number | null;
    model_used: string;
  },
): Promise<void> {
  // upstream_call_log is owned exclusively by the runtime routing boundary. Keeping a
  // second provider-specific write here would double-count usage and falsely
  // label Vertex calls as Anthropic.
  try {
    await supabaseAdmin.from("final_prompt_trace").insert({
      conversation_id: params.conversation_id,
      message_id: params.message_id,
      model_used: params.model_used,
      system_prompt_snapshot: "[governed_generation_router_v1]",
      token_input: params.token_input,
      token_output: params.token_output,
      latency_ms: params.response_latency_ms,
      rag_context: null,
      tool_calls: null,
      user_message: sanitizeUserMessage(params.user_message_raw),
    });
  } catch (e) {
    console.error(
      "[generate-reply] final_prompt_trace insert failed (non-blocking):",
      e,
    );
  }
}

function buildRouterConversationInput(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  return messages
    .slice(-10)
    .map((message, index) => {
      const label = message.role === "user" ? "Visitor" : "Assistant";
      return `[Turn ${index + 1} ${label}]\n${
        String(message.content ?? "").slice(0, 3000)
      }`;
    })
    .join("\n\n");
}

function routerFailureHttpStatus(code: LlmFailureCode): number {
  if (code === "LLM_INPUT_BLOCKED") return 400;
  if (code === "LLM_TIMEOUT") return 504;
  if (code === "LLM_CONFIG_MISSING") return 503;
  if (code === "LLM_GROUNDING_REJECTED") return 422;
  return 502;
}

async function loadLatestHandoffReason(
  supabaseAdmin: SupabaseAdminClient,
  conversationId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("handoff_event")
    .select("handoff_reason, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error(
      "[generate-reply] latest handoff control lookup failed (non-blocking):",
      conversationId,
    );
    return null;
  }
  return typeof data?.handoff_reason === "string" ? data.handoff_reason : null;
}

function routerFailureToS0(code: LlmFailureCode): string {
  switch (code) {
    case "LLM_TIMEOUT":
      return "LLM_TIMEOUT";
    case "LLM_NETWORK":
      return "LLM_NETWORK_ERROR";
    case "LLM_NON_2XX":
      return "LLM_NON_2XX";
    case "LLM_CONFIG_MISSING":
      return "LLM_NON_2XX";
    case "LLM_INPUT_BLOCKED":
      return "LLM_INPUT_BLOCKED";
    case "LLM_INVALID_OUTPUT":
      return "LLM_INVALID_OUTPUT";
    case "LLM_GROUNDING_REJECTED":
      return "LLM_GROUNDING_REJECTED";
  }
}

async function cleanupThinking(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  source_message_id: string | null,
): Promise<void> {
  if (!source_message_id) {
    console.error(
      "[generate-reply] cleanupThinking skipped: missing source_message_id",
      conversation_id,
    );
    return;
  }
  try {
    await supabaseAdmin.from("messages").delete().eq(
      "conversation_id",
      conversation_id,
    ).eq("content", "__THINKING__").filter(
      "metadata->>source_message_id",
      "eq",
      source_message_id,
    );
  } catch (e) {
    console.error("[generate-reply] cleanupThinking failed (non-blocking):", e);
  }
}

interface SourceVisitorMessage {
  id: string;
  content: string;
  created_at: string;
}

async function loadSourceVisitorMessage(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  source_message_id: string | null,
): Promise<
  | { ok: true; message: SourceVisitorMessage }
  | {
    ok: false;
    error:
      | "source_message_id_required"
      | "source_message_lookup_failed"
      | "invalid_source_message";
  }
> {
  if (
    !source_message_id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      source_message_id,
    )
  ) {
    return { ok: false, error: "source_message_id_required" };
  }

  const { data, error } = await supabaseAdmin
    .from("messages")
    .select("id, content, created_at")
    .eq("id", source_message_id)
    .eq("conversation_id", conversation_id)
    .eq("role", "visitor")
    .eq("is_recalled", false)
    .neq("content", "__THINKING__")
    .maybeSingle();

  if (error) return { ok: false, error: "source_message_lookup_failed" };
  if (!data?.id || typeof data.content !== "string" || !data.created_at) {
    return { ok: false, error: "invalid_source_message" };
  }

  return {
    ok: true,
    message: {
      id: data.id,
      content: data.content,
      created_at: data.created_at,
    },
  };
}

function widgetLiveTestPreActivationActor(
  metadataSource: unknown,
): KBPreActivationActor | undefined {
  if (
    !metadataSource || typeof metadataSource !== "object" ||
    Array.isArray(metadataSource)
  ) {
    return undefined;
  }
  const m = metadataSource as Record<string, unknown>;
  if (
    m.widget_live_test !== true ||
    m.exclude_training !== true ||
    typeof m.owner_user_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      m.owner_user_id,
    )
  ) return undefined;

  return {
    userId: m.owner_user_id,
    allowPreActivation: true,
  };
}

function sourceBoundaryFilter(source: SourceVisitorMessage): string {
  return `created_at.lt.${source.created_at},and(created_at.eq.${source.created_at},id.lte.${source.id})`;
}

function sourceMessageErrorResponse(
  result: {
    ok: false;
    error:
      | "source_message_id_required"
      | "source_message_lookup_failed"
      | "invalid_source_message";
  },
): Response {
  const status = result.error === "source_message_lookup_failed" ? 500 : 400;
  return new Response(JSON.stringify({ success: false, error: result.error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function b2PreventedResponse(
  decision: B2Decision,
  context: Record<string, unknown> = {},
): Response {
  const unavailable = decision.decision === "indeterminate";
  return new Response(
    JSON.stringify({
      success: false,
      error: unavailable
        ? "b2_supervision_indeterminate"
        : "b2_supervision_blocked",
      b2_decision: decision.decision,
      b2_code: decision.code,
      persistence_prevented: true,
      ...context,
    }),
    {
      status: unavailable ? 503 : 409,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
}

async function executeB2RpcPersistence<T>(
  supabaseAdmin: SupabaseAdminClient,
  input: {
    conversation_id: string;
    source_message_id: string;
    proposed_response: string;
    persistence_kind: B2PersistenceKind;
    metadata?: Record<string, unknown> | null;
    trusted_kb_price_proof?: B2KbPriceProof | null;
    trusted_targeted_clarification?: B2TrustedTargetedClarification | null;
    trusted_journey_progress?: B2TrustedJourneyProgress | null;
    trusted_correction_commit?: B2TrustedCorrectionCommit | null;
    trusted_lifecycle_commit?: B2TrustedLifecycleCommit | null;
    expected_commerce_state_revision?: number | null;
  },
  commit: (snapshot: B2CanonicalSnapshot) => Promise<T>,
) {
  return await executeB2PersistenceGate({
    client: supabaseAdmin as unknown as B2DatabaseClient,
    ...input,
    commit,
  });
}

async function commitAiReplyWithControlGate(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  source_message_id: string | null,
  content: string,
  metadata: Record<string, unknown> | null = null,
  trustedKbPriceProof: B2KbPriceProof | null = null,
  trustedTargetedClarification: B2TrustedTargetedClarification | null = null,
  trustedJourneyProgress: B2TrustedJourneyProgress | null = null,
  trustedCorrectionCommit: B2TrustedCorrectionCommit | null = null,
  trustedLifecycleCommit: B2TrustedLifecycleCommit | null = null,
): Promise<
  | { ok: true; message_id: string | null; idempotent: boolean }
  | {
    ok: false;
    result:
      | "human_control"
      | "resolved"
      | "invalid_source_message"
      | "invalid_content"
      | "source_already_replied"
      | "response_substitution"
      | "response_hash_mismatch"
      | "invalid_b2_revision_proof"
      | "stale_authorized_revision"
      | "tenant_mismatch"
      | "superseded_source"
      | "not_found"
      | "b2_block"
      | "b2_indeterminate"
      | "rpc_error"
      | "unexpected_result";
  }
> {
  if (!source_message_id) {
    return { ok: false, result: "invalid_source_message" };
  }

  const expectedRevision = typeof metadata?.commerce_state_revision === "number"
    ? metadata.commerce_state_revision
    : null;
  // This marker is persisted only by the commit callback that
  // executeB2PersistenceGate invokes after an allow decision and exact snapshot
  // revalidation. It gives validation readback a server-persisted proof of the
  // gate and RPC path; assistant-row presence alone is not B2 evidence.
  const b2CommitEvidence = {
    ...(metadata ?? {}),
    b2_gate_contract: "executeB2PersistenceGate:allow_after_revalidation",
    b2_commit_source: "commit_ai_reply_tx",
    b2_source_message_id: source_message_id,
  };
  let attemptedEvidence: Record<string, unknown> | null = null;
  const b2 = await executeB2RpcPersistence(
    supabaseAdmin,
    {
      conversation_id,
      source_message_id,
      proposed_response: content,
      persistence_kind: "ai_reply",
      metadata: b2CommitEvidence,
      trusted_kb_price_proof: trustedKbPriceProof,
      trusted_targeted_clarification: trustedTargetedClarification,
      trusted_journey_progress: trustedJourneyProgress,
      trusted_correction_commit: trustedCorrectionCommit,
      trusted_lifecycle_commit: trustedLifecycleCommit,
      expected_commerce_state_revision: expectedRevision,
    },
    async (snapshot) => {
      attemptedEvidence = await bindAuthorizedReply(snapshot, content, b2CommitEvidence);
      return await supabaseAdmin.rpc("commit_ai_reply_tx", {
        p_conversation_id: conversation_id,
        p_source_message_id: source_message_id,
        p_content: content,
        p_metadata: attemptedEvidence,
      });
    },
  );

  if (!b2.committed) {
    console.warn("[generate-reply] B2 prevented AI reply persistence:", {
      conversation_id,
      decision: b2.decision.decision,
      code: b2.decision.code,
    });
    return {
      ok: false,
      result: b2.decision.decision === "block"
        ? "b2_block"
        : "b2_indeterminate",
    };
  }

  const { data, error } = b2.value;

  const recoverAmbiguousAcknowledgement = async () => {
    const receipt = await readExactAiReplyCommit(supabaseAdmin, {
      conversation_id,
      source_message_id,
      content,
      authorized_revision: attemptedEvidence?.b2_expected_revision as number | undefined,
      company_id: attemptedEvidence?.b2_expected_company_id as string | undefined,
      response_hash: attemptedEvidence?.b2_response_hash as string | undefined,
      idempotency_key: attemptedEvidence?.b2_idempotency_key as string | undefined,
    });
    return receipt.status === "committed"
      ? {
        ok: true as const,
        message_id: receipt.value.message_id,
        idempotent: true,
      }
      : null;
  };

  if (error) {
    console.error("[generate-reply] commit_ai_reply_tx RPC error:", {
      conversation_id,
      code: error.code,
    });
    return await recoverAmbiguousAcknowledgement() ??
      { ok: false, result: "rpc_error" };
  }

  const payload = data ?? {};
  const result = String(payload.result ?? data ?? "unexpected_result");

  switch (result) {
    case "success":
      if (typeof payload.message_id !== "string") {
        return await recoverAmbiguousAcknowledgement() ??
          { ok: false, result: "unexpected_result" };
      }
      return {
        ok: true,
        message_id: payload.message_id,
        idempotent: false,
      };
    case "idempotent":
      if (typeof payload.message_id !== "string") {
        return await recoverAmbiguousAcknowledgement() ??
          { ok: false, result: "unexpected_result" };
      }
      return {
        ok: true,
        message_id: payload.message_id,
        idempotent: true,
      };
    case "human_control":
    case "resolved":
    case "invalid_source_message":
    case "invalid_content":
    case "source_already_replied":
    case "response_substitution":
    case "response_hash_mismatch":
    case "invalid_b2_revision_proof":
    case "stale_authorized_revision":
    case "tenant_mismatch":
    case "superseded_source":
    case "not_found":
      return { ok: false, result };
    default:
      return await recoverAmbiguousAcknowledgement() ??
        { ok: false, result: "unexpected_result" };
  }
}

interface EscClassifierResult {
  rule: "R1" | null;
  confidence: number;
  trigger_span: string;
  language: "zh-TW" | "zh-CN" | "en";
}

function classifyExplicitHandoff(text: string): EscClassifierResult {
  const lang = detectHandoffLanguage(text);
  if (lang) {
    return {
      rule: "R1",
      confidence: 1.0,
      trigger_span: text.slice(0, 100),
      language: lang,
    };
  }
  return { rule: null, confidence: 0, trigger_span: "", language: "zh-TW" };
}

function isGreetingOrTrivial(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  const raw = text.trim();
  const greetingRe =
    /^((hi|hello|hey|你好|嗨|哈囉|早安|午安|晚安|good\s*(morning|afternoon|evening)|thanks|thank you|ok|okay|謝謝|好的|嗯)\s*[!！。.？?，,]*\s*)+$/i;
  const compoundEnRe =
    /^(hi|hello|hey)\s+(there|everyone|guys|all)[!！。.？?，,\s]*$/i;
  const compoundZhRe =
    /^(你好|嗨|哈囉|早安|午安|晚安)[，,、\s]*(呀|啊|大家好?|各位好?)[!！。.？?\s]*$/;
  return greetingRe.test(normalized) || compoundEnRe.test(normalized) ||
    compoundZhRe.test(raw);
}

const E2_LOCAL_THREAT_CLASSIFIER_VERSION = "e2-local-threat-v1.0" as const;

function classifyAuthoritativeThreat(text: string): {
  value: true;
  reason: string;
  provider_version: string;
} | undefined {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (isDirectViolentThreat(normalized)) {
    return {
      value: true,
      reason: "explicit_violence_or_harm_threat",
      provider_version: E2_LOCAL_THREAT_CLASSIFIER_VERSION,
    };
  }
  const lower = normalized.toLowerCase();

  const explicitEnglishThreats = [
    /\b(?:i(?:'ll| will| am going to| am gonna| gonna| plan to| intend to)\s+)?(?:kill|shoot|stab|hurt|attack)\s+(?:you|him|her|them|someone|people|staff|agent|employee)\b/i,
    /\b(?:i(?:'ll| will| am going to| gonna)\s+)?bomb\s+(?:you|this place|the office|the store|the shop|your office|your store)\b/i,
    /\b(?:bomb threat|i have (?:a )?bomb)\b/i,
  ];
  const explicitChineseThreats = [
    /(?:我要|我會|我会|我想|我準備|我准备|我打算|等我|信不信我).{0,8}(?:殺|杀|弄死|砍|刺|打死|傷害|伤害|襲擊|袭击).{0,8}(?:你|你們|你们|他|她|他們|他们|客服|員工|员工|店員|店员|人)/,
    /(?:殺了你|杀了你|弄死你|打死你|砍死你|刺死你)/,
    /(?:我要|我會|我会|我打算).{0,8}(?:炸掉|炸了|放炸彈|放炸弹|引爆).{0,8}(?:你們|你们|你|公司|店|辦公室|办公室|門市|门市)/,
    /(?:我有炸彈|我有炸弹)/,
  ];

  const matched = explicitEnglishThreats.some((re) => re.test(lower)) ||
    explicitChineseThreats.some((re) => re.test(normalized));

  if (!matched) return undefined;

  return {
    value: true,
    reason: "explicit_violence_or_harm_threat",
    provider_version: E2_LOCAL_THREAT_CLASSIFIER_VERSION,
  };
}

interface ComplianceReviewSignal {
  value: boolean;
  reason: string;
  provider_version: string;
}

function resolveAuthoritativeComplianceReview(
  expectedTenantId: string | undefined,
): ComplianceReviewSignal | undefined {
  if (!expectedTenantId) return undefined;
  const raw = Deno.env.get("ESC_E2_COMPLIANCE_REVIEW_BY_TENANT_JSON");
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      "[generate-reply] invalid ESC_E2_COMPLIANCE_REVIEW_BY_TENANT_JSON JSON",
    );
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(
      "[generate-reply] compliance tenant map must be a JSON object",
    );
    return undefined;
  }

  const tenantMap = parsed as Record<string, unknown>;
  if (!(expectedTenantId in tenantMap)) return undefined;
  const value = tenantMap[expectedTenantId];
  if (typeof value !== "boolean") {
    console.error(
      "[generate-reply] compliance tenant value must be boolean",
      expectedTenantId,
    );
    return undefined;
  }

  return {
    value,
    reason: value
      ? "tenant_jurisdiction_requires_human_review"
      : "tenant_jurisdiction_review_not_required",
    provider_version: "e2-tenant-compliance-map-v1.0",
  };
}

function classifyLocalTopicRisk(
  text: string,
): { level: "high"; verified: true } | undefined {
  const transactional = [
    /退[款貨]/,
    /要退/,
    /申請退/,
    /我要.*退/,
    /refund\s*(my|this|the)/i,
    /return\s*(my|this|the)/i,
    /i\s*want\s*(a\s*)?refund/i,
    /i\s*want\s*to\s*return/i,
    /賠償/,
    /補償/,
    /compensation/i,
    /法律行動/,
    /legal\s*action/i,
    /起訴/,
  ];
  const informationOnly = [
    /policy/i,
    /政策/,
    /規定/,
    /條款/,
    /what\s*(is|are)/i,
    /how\s*(do|does|to)/i,
    /tell\s*me\s*about/i,
    /請問/,
    /想了解/,
    /介紹/,
    /說明/,
    /(?:有冇|有没有|是否|係咪).{0,24}(?:退款|退貨|退货|refund|return).{0,24}(?:比例|百分比|規則|规则|政策)?/i,
    /(?:退款|退貨|退货|refund|return).{0,24}(?:有冇|有没有|是否|係咪|幾多|多少|比例|百分比|規則|规则|政策)/i,
  ];
  const alwaysHigh = [
    /醫療/,
    /藥品/,
    /治療/,
    /medical/i,
    /medicine/i,
    /treatment/i,
    /隱私/,
    /個資/,
    /資料保護/,
    /privacy/i,
    /personal\s*data/i,
    /gdpr/i,
    /投資/,
    /理財/,
    /金融/,
    /investment/i,
    /financial/i,
    /finance/i,
  ];

  const matchesTransactional = transactional.some((re) => re.test(text));
  const matchesInformationOnly = informationOnly.some((re) => re.test(text));
  const matchesAlwaysHigh = alwaysHigh.some((re) => re.test(text));

  const highRisk = matchesAlwaysHigh ||
    (matchesTransactional && !matchesInformationOnly);
  if (!highRisk) return undefined;
  return { level: "high", verified: true };
}

interface R3SentimentSignals {
  anger_flag?: true;
  sentiment_score?: number;
  sentiment_trend?: number[];
  sentiment_recovered_same_turn?: true;
  evaluation_id: string;
  provider_version: string;
}

function isFiniteScore(value: unknown): boolean {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n);
}

function explicitAngerLabel(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return [
    "angry",
    "anger",
    "furious",
    "rage",
    "irate",
    "憤怒",
    "愤怒",
    "生氣",
    "生气",
  ]
    .includes(value.trim().toLowerCase());
}

async function loadAuthoritativeR3SentimentSignals(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  expected_tenant_id: string | undefined,
): Promise<R3SentimentSignals | undefined> {
  if (!expected_tenant_id) return undefined;

  /*
   * Product-ready freshness binding.
   *
   * Do NOT select "latest evaluation by created_at" alone. A new evaluation-
   * relevant message marks ce_evaluation_state dirty immediately, so an older
   * evaluation may still be the newest row while already being stale for the
   * current conversation state.
   *
   * R3 may consume CE emotion only when the freshness state says the exact
   * canonical evaluation is up-to-date for the same tenant and methodology.
   */
  const { data: freshness, error: freshnessError } = await supabaseAdmin
    .from("ce_evaluation_state")
    .select(
      "conversation_id, company_id, state, last_success_evaluation_id, last_success_source, last_success_fingerprint, current_evaluation_fingerprint, last_success_at, last_activity_at",
    )
    .eq("conversation_id", conversation_id)
    .eq("company_id", expected_tenant_id)
    .maybeSingle();

  // A new visitor turn correctly marks CE dirty before generation. The last
  // canonical evaluation is therefore historical context, not current-turn
  // truth. We may use its bounded trajectory only when lineage/tenant are valid;
  // current-turn polarity is supplied separately by the deterministic classifier.
  if (
    freshnessError ||
    !freshness ||
    freshness.last_success_source !== "canonical" ||
    !freshness.last_success_evaluation_id ||
    !freshness.last_success_fingerprint
  ) {
    return undefined;
  }

  const { data: evaluation, error: evaluationError } = await supabaseAdmin
    .from("conversation_evaluation")
    .select("id, company_id, created_at, evaluation_fingerprint, freshness")
    .eq("id", freshness.last_success_evaluation_id)
    .eq("conversation_id", conversation_id)
    .eq("company_id", expected_tenant_id)
    .eq("evaluation_fingerprint", freshness.last_success_fingerprint)
    .maybeSingle();

  if (
    evaluationError ||
    !evaluation?.id ||
    evaluation.id !== freshness.last_success_evaluation_id
  ) {
    return undefined;
  }

  const { data: points, error: pointsError } = await supabaseAdmin
    .from("ce_emotion_point")
    .select(
      "turn_index, sentiment, sentiment_score, trigger_label, occurred_at",
    )
    .eq("evaluation_id", evaluation.id)
    .eq("company_id", expected_tenant_id)
    .order("turn_index", { ascending: true })
    .limit(20);
  if (pointsError || !points || points.length === 0) return undefined;

  const usable = (points as Array<{
    turn_index?: unknown;
    sentiment_score?: unknown;
    sentiment?: unknown;
    trigger_label?: unknown;
  }>).map((p) => ({
    turn_index: typeof p.turn_index === "number" ? p.turn_index : -1,
    score: isFiniteScore(p.sentiment_score)
      ? Number(p.sentiment_score)
      : undefined,
    sentiment: p.sentiment,
    trigger_label: p.trigger_label,
  })).filter((p) =>
    p.score !== undefined ||
    explicitAngerLabel(p.sentiment) ||
    explicitAngerLabel(p.trigger_label)
  );
  if (usable.length === 0) return undefined;

  const scoreSeries = usable
    .filter((p) => typeof p.score === "number")
    .sort((a, b) => a.turn_index - b.turn_index)
    .map((p) => p.score as number);

  const latest = [...usable].sort((a, b) => b.turn_index - a.turn_index)[0];
  const latestScore = typeof latest?.score === "number"
    ? latest.score
    : undefined;
  const anger = explicitAngerLabel(latest?.sentiment) ||
    explicitAngerLabel(latest?.trigger_label);

  let recovered: true | undefined;
  if (scoreSeries.length >= 2) {
    const previous = scoreSeries[scoreSeries.length - 2];
    const current = scoreSeries[scoreSeries.length - 1];
    if (previous < -0.2 && current >= 0 && current - previous >= 0.3) {
      recovered = true;
    }
  }

  return {
    ...(anger ? { anger_flag: true as const } : {}),
    ...(latestScore !== undefined ? { sentiment_score: latestScore } : {}),
    ...(scoreSeries.length >= 2
      ? { sentiment_trend: scoreSeries.slice(-5) }
      : {}),
    ...(recovered ? { sentiment_recovered_same_turn: true as const } : {}),
    evaluation_id: evaluation.id,
    provider_version: `ce-emotion-history-v1.0:${
      String(evaluation.evaluation_fingerprint).slice(0, 12)
    }`,
  };
}

interface ConversationHistorySignals {
  turn_count: number;
  consecutive_no_answer: number;
  clarification_attempts: number;
  exact_same_intent_repeated?: true;
}

function normalizeIntentText(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[!！。.？?，,、:：;；"'“”‘’()[\]{}<>《》]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Task 3.3 same-intent matcher.
 *
 * Deterministic, symmetric, bounded, non-LLM, no external calls.
 * Exact normalized equality is preserved first; conservative semantic
 * similarity is then applied so a rephrased repeat of the same request is
 * recognised after a first no-match clarification.
 */
const SAME_INTENT_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "then",
  "so",
  "as",
  "of",
  "to",
  "for",
  "from",
  "with",
  "without",
  "in",
  "on",
  "at",
  "by",
  "about",
  "into",
  "over",
  "under",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "doing",
  "done",
  "can",
  "could",
  "will",
  "would",
  "shall",
  "should",
  "may",
  "might",
  "must",
  "have",
  "has",
  "had",
  "i",
  "me",
  "my",
  "mine",
  "we",
  "us",
  "our",
  "you",
  "your",
  "yours",
  "he",
  "she",
  "it",
  "its",
  "they",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "there",
  "here",
  "what",
  "which",
  "who",
  "whom",
  "whose",
  "when",
  "where",
  "why",
  "how",
  "not",
  "no",
  "yes",
  "just",
  "still",
  "again",
  "also",
  "any",
  "some",
  "more",
  "most",
  "much",
  "many",
  "very",
  "really",
  "please",
  "thanks",
  "thank",
  "hi",
  "hello",
  "hey",
  "ok",
  "okay",
  "sure",
  "need",
  "want",
  "looking",
  "look",
  "get",
  "got",
  "give",
  "tell",
  "know",
  "help",
  "sell",
  "sells",
  "selling",
  "available",
  "availability",
  "stock",
  "order",
  "buy",
  "purchase",
  "see",
  "use",
]);

function extractMeaningfulTokens(normalized: string): Set<string> {
  const tokens = normalized
    .split(/[^\p{L}\p{N}-]+/u)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length >= 3 && !SAME_INTENT_STOP_WORDS.has(t));
  return new Set(tokens);
}

function compactCjk(normalized: string): string {
  return (normalized.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu,
  ) ?? []).join("");
}

function ngramSet(text: string, size: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + size <= text.length; i += 1) {
    out.add(text.slice(i, i + size));
  }
  return out;
}

function containment(a: Set<string>, b: Set<string>): number {
  const denominator = Math.min(a.size, b.size);
  if (denominator === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  return shared / denominator;
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const item of small) if (large.has(item)) shared += 1;
  return shared;
}

function isSameIntentRepeat(rawA: string, rawB: string): boolean {
  const a = normalizeIntentText(rawA);
  const b = normalizeIntentText(rawB);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;

  // Ignore trivially short inputs on both paths.
  if (a.length < 8 || b.length < 8) return false;

  const tokensA = extractMeaningfulTokens(a);
  const tokensB = extractMeaningfulTokens(b);
  if (tokensA.size >= 3 && tokensB.size >= 3) {
    if (
      sharedCount(tokensA, tokensB) >= 3 && containment(tokensA, tokensB) >= 0.7
    ) return true;
  }

  const cjkA = compactCjk(a);
  const cjkB = compactCjk(b);
  if (cjkA.length >= 8 && cjkB.length >= 8) {
    const gramsA = ngramSet(cjkA, 2);
    const gramsB = ngramSet(cjkB, 2);
    if (
      Math.min(gramsA.size, gramsB.size) >= 6 &&
      sharedCount(gramsA, gramsB) >= 6 &&
      containment(gramsA, gramsB) >= 0.6
    ) {
      return true;
    }
  }

  return false;
}

type HistoryRow = {
  role?: string;
  content?: string | null;
  metadata?: unknown;
};

function isClarificationAssistantRow(row: HistoryRow): boolean {
  const metadata = row.metadata;
  if (typeof metadata !== "object" || metadata === null) return false;
  const record = metadata as Record<string, unknown>;
  if (record["escalation_action"] !== "clarification") return false;
  return (
    record["escalation_rule"] === "R2" ||
    record["response_route"] === KB_NO_MATCH_CLARIFICATION_ROUTE
  );
}

function deriveConversationHistorySignals(
  newestFirstMessages: Array<HistoryRow>,
  exactVisitorTurnCount: number,
): ConversationHistorySignals {
  const usable = newestFirstMessages.filter(
    (m) => m.content !== "__THINKING__" && typeof m.role === "string",
  );

  let consecutiveNoAnswer = 0;

  for (const message of usable) {
    const role = message.role;
    if (role === "visitor") {
      consecutiveNoAnswer += 1;
      continue;
    }
    if (role === "assistant" || role === "agent") break;
  }

  // Indices (newest-first) of the two most recent visitor turns.
  const visitorIndices: number[] = [];
  for (let i = 0; i < usable.length && visitorIndices.length < 2; i += 1) {
    if (usable[i]?.role === "visitor") visitorIndices.push(i);
  }

  let exactSameIntentRepeated: true | undefined;
  let clarificationAttempts = 0;

  if (visitorIndices.length >= 2) {
    const latestIndex = visitorIndices[0]!;
    const previousIndex = visitorIndices[1]!;
    const last = String(usable[latestIndex]?.content ?? "");
    const previous = String(usable[previousIndex]?.content ?? "");
    if (isSameIntentRepeat(last, previous)) {
      exactSameIntentRepeated = true;
      // Intent-local clarification count: only assistant turns strictly
      // between the two same-intent visitor turns are considered, capped at 1.
      for (let i = latestIndex + 1; i < previousIndex; i += 1) {
        const row = usable[i];
        if (!row || row.role !== "assistant") continue;
        if (isClarificationAssistantRow(row)) {
          clarificationAttempts = 1;
          break;
        }
      }
    }
  }

  return {
    turn_count: exactVisitorTurnCount,
    consecutive_no_answer: consecutiveNoAnswer,
    clarification_attempts: clarificationAttempts,
    exact_same_intent_repeated: exactSameIntentRepeated,
  };
}

function readPositiveIntegerEnv(name: string): number | undefined {
  const raw = Deno.env.get(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

function buildVerifiedTenantEscalationConfig(): EscalationContext[
  "tenant_config"
] {
  const maxConsecutiveNoAnswer = readPositiveIntegerEnv(
    "ESC_MAX_CONSECUTIVE_NO_ANSWER",
  );
  const maxClarifications = readPositiveIntegerEnv("ESC_MAX_CLARIFICATIONS");
  const sentimentThresholdRaw = Deno.env.get("ESC_SENTIMENT_SCORE_THRESHOLD");
  const parsedSentimentThreshold =
    sentimentThresholdRaw !== undefined && sentimentThresholdRaw.trim() !== ""
      ? Number(sentimentThresholdRaw)
      : undefined;
  const sentimentScoreThreshold =
    typeof parsedSentimentThreshold === "number" &&
      Number.isFinite(parsedSentimentThreshold)
      ? parsedSentimentThreshold
      : undefined;
  const slaWarningRaw = Deno.env.get("ESC_SLA_WARNING_SEC");
  const parsedSlaWarning =
    slaWarningRaw !== undefined && slaWarningRaw.trim() !== ""
      ? Number(slaWarningRaw)
      : undefined;
  const slaWarningSec = typeof parsedSlaWarning === "number" &&
      Number.isInteger(parsedSlaWarning) &&
      parsedSlaWarning >= 0
    ? parsedSlaWarning
    : undefined;

  const predictedCsatRaw = Deno.env.get("ESC_PREDICTED_CSAT_THRESHOLD");
  const parsedPredictedCsat =
    predictedCsatRaw !== undefined && predictedCsatRaw.trim() !== ""
      ? Number(predictedCsatRaw)
      : undefined;
  const predictedCsatThreshold = typeof parsedPredictedCsat === "number" &&
      Number.isFinite(parsedPredictedCsat) &&
      parsedPredictedCsat >= 1 &&
      parsedPredictedCsat <= 5
    ? parsedPredictedCsat
    : undefined;

  const churnRiskRaw = Deno.env.get("ESC_CHURN_RISK_THRESHOLD");
  const parsedChurnRisk =
    churnRiskRaw !== undefined && churnRiskRaw.trim() !== ""
      ? Number(churnRiskRaw)
      : undefined;
  const churnRiskThreshold = typeof parsedChurnRisk === "number" &&
      Number.isFinite(parsedChurnRisk) &&
      parsedChurnRisk >= 0 &&
      parsedChurnRisk <= 1
    ? parsedChurnRisk
    : undefined;

  const escalationScoreRaw = Deno.env.get("ESC_ESCALATION_SCORE_THRESHOLD");
  const parsedEscalationScore =
    escalationScoreRaw !== undefined && escalationScoreRaw.trim() !== ""
      ? Number(escalationScoreRaw)
      : undefined;
  const escalationScoreThreshold = typeof parsedEscalationScore === "number" &&
      Number.isFinite(parsedEscalationScore) &&
      parsedEscalationScore >= 0 &&
      parsedEscalationScore <= 1
    ? parsedEscalationScore
    : undefined;

  if (
    maxConsecutiveNoAnswer === undefined &&
    maxClarifications === undefined &&
    sentimentScoreThreshold === undefined &&
    slaWarningSec === undefined &&
    predictedCsatThreshold === undefined &&
    churnRiskThreshold === undefined &&
    escalationScoreThreshold === undefined
  ) return null;

  return {
    ...(maxConsecutiveNoAnswer !== undefined
      ? { max_consecutive_no_answer: maxConsecutiveNoAnswer }
      : {}),
    ...(maxClarifications !== undefined
      ? { max_clarifications: Math.min(1, maxClarifications) }
      : {}),
    ...(sentimentScoreThreshold !== undefined
      ? { sentiment_score_threshold: sentimentScoreThreshold }
      : {}),
    ...(slaWarningSec !== undefined ? { sla_warning_sec: slaWarningSec } : {}),
    ...(predictedCsatThreshold !== undefined
      ? { predicted_csat_threshold: predictedCsatThreshold }
      : {}),
    ...(churnRiskThreshold !== undefined
      ? { churn_risk_threshold: churnRiskThreshold }
      : {}),
    ...(escalationScoreThreshold !== undefined
      ? { escalation_score_threshold: escalationScoreThreshold }
      : {}),
  };
}

function requiredRuleActivationFromEnv(
  env: { get(name: string): string | undefined },
): ReadonlySet<EscalationRuleId> {
  const flags = escalationFeatureFlagsFromEnv(env);
  const enabled = new Set<EscalationRuleId>();
  if (flags.enable_full_ruleset || flags.enable_e2) enabled.add("E2");
  if (flags.enable_full_ruleset || flags.enable_e1) enabled.add("E1");
  enabled.add("R1");
  enabled.add("R2");
  return enabled;
}

function isE2LiveActivationEnabled(
  env: { get(name: string): string | undefined },
): boolean {
  if (env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") !== "true") return false;
  const flags = escalationFeatureFlagsFromEnv(env);
  return flags.enable_full_ruleset || flags.enable_e2;
}

function isE1LiveActivationEnabled(
  env: { get(name: string): string | undefined },
): boolean {
  if (env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") !== "true") return false;
  const flags = escalationFeatureFlagsFromEnv(env);
  return flags.enable_full_ruleset || flags.enable_e1;
}

async function evaluateAndPersistRequiredRulesLive(
  supabaseAdmin: SupabaseAdminClient,
  params: {
    conversation_id: string;
    source_message_id: string | null;
    latest_message_content: string;
    conversation_status: string;
    assigned_agent_id: string | null;
    greeting_or_trivial: boolean;
    visitor_language: "zh-TW" | "zh-CN" | "en";
    expected_tenant_id?: string;
    suppress_r2_for_prior_grounded_transform?: boolean;
    suppress_r2_for_bounded_no_current_evidence?: boolean;
    warm_handoff_question?: string;
    rag_match_state?: RagMatchState;
    topic_risk_level?: TopicRiskLevel;
    verified_local_risk_classification?: boolean;
    conversation_duration_sec?: number;
    turn_count?: number;
    consecutive_no_answer?: number;
    clarification_attempts?: number;
    exact_same_intent_repeated?: true;
    threat_flag?: { value: true; reason: string; provider_version: string };
    compliance_jurisdiction_requires_human_review?: {
      value: boolean;
      reason: string;
      provider_version: string;
    };
  },
): Promise<Response | null> {
  if (Deno.env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") === "false") return null;

  const enabled = requiredRuleActivationFromEnv(Deno.env);
  if (enabled.size === 0) return null;

  if (!params.source_message_id) {
    console.error(
      "[generate-reply] required-rules live blocked: missing source_message_id",
      params.conversation_id,
    );
    return new Response(
      JSON.stringify({
        success: false,
        error: "required_escalation_missing_source_message_id",
        handoff_persisted: false,
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const handoffClassification = classifyHandoffIntent(
    params.latest_message_content,
  );
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

  context.conversation_status = availableSignal(
    params.conversation_status,
    "conversation_history",
  );
  context.assigned_agent_id = availableSignal(
    params.assigned_agent_id,
    "conversation_history",
  );
  context.greeting_or_trivial = availableSignal(
    params.greeting_or_trivial,
    "local_classifier",
  );

  if (params.threat_flag !== undefined) {
    context.threat_flag = availableSignal(
      params.threat_flag.value,
      "local_classifier",
      {
        provider_version: params.threat_flag.provider_version,
        observed_at: new Date().toISOString(),
        reason: params.threat_flag.reason,
        ...(params.expected_tenant_id
          ? { tenant_id: params.expected_tenant_id }
          : {}),
      },
    );
  }
  if (params.compliance_jurisdiction_requires_human_review !== undefined) {
    const compliance = params.compliance_jurisdiction_requires_human_review;
    context.compliance_jurisdiction_requires_human_review = availableSignal(
      compliance.value,
      "tenant_config",
      {
        provider_version: compliance.provider_version,
        observed_at: new Date().toISOString(),
        reason: compliance.reason,
        ...(params.expected_tenant_id
          ? { tenant_id: params.expected_tenant_id }
          : {}),
      },
    );
  }

  if (params.rag_match_state !== undefined) {
    context.rag_match_state = availableSignal(params.rag_match_state, "kb_rag");
  }
  if (params.topic_risk_level !== undefined) {
    context.topic_risk_level = availableSignal(
      params.topic_risk_level,
      "local_classifier",
    );
  }
  if (params.verified_local_risk_classification !== undefined) {
    context.verified_local_risk_classification = availableSignal(
      params.verified_local_risk_classification,
      "local_classifier",
    );
  }
  if (params.conversation_duration_sec !== undefined) {
    context.conversation_duration_sec = availableSignal(
      params.conversation_duration_sec,
      "conversation_history",
    );
  }
  if (params.turn_count !== undefined) {
    context.turn_count = availableSignal(
      params.turn_count,
      "conversation_history",
    );
  }
  if (params.consecutive_no_answer !== undefined) {
    context.consecutive_no_answer = availableSignal(
      params.consecutive_no_answer,
      "conversation_history",
    );
  }
  if (params.clarification_attempts !== undefined) {
    context.clarification_attempts = availableSignal(
      params.clarification_attempts,
      "conversation_history",
    );
  }
  if (params.exact_same_intent_repeated === true) {
    context.same_intent_repeated = availableSignal(
      true,
      "conversation_history",
      {
        reason: "exact_normalized_repeat",
      },
    );
  }

  context.tenant_config = buildVerifiedTenantEscalationConfig();

  const decision = evaluateFullEscalationRuleset(context, {
    activation: { enabled },
  });

  // A pure transform and a bounded no-current-evidence answer are not unresolved
  // escalation loops. Suppress only R2; E2/E1/R1/S0 retain frozen priority.
  if (
    (params.suppress_r2_for_prior_grounded_transform === true ||
      params.suppress_r2_for_bounded_no_current_evidence === true) &&
    decision.matched_rule === "R2"
  ) {
    return null;
  }

  if (
    decision.decision === "handoff" && decision.matched_rule === "R2" &&
    params.warm_handoff_question
  ) {
    const b2 = await executeB2RpcPersistence(
      supabaseAdmin,
      {
        conversation_id: params.conversation_id,
        source_message_id: params.source_message_id,
        proposed_response: params.warm_handoff_question,
        persistence_kind: "required_escalation_clarification",
        metadata: {
          escalation_rule: "R2",
          escalation_action: "collect_missing_handoff_facts",
          response_route: "warm_handoff_data_collection",
          handoff_required: false,
        },
      },
      async (snapshot) =>
        await supabaseAdmin.rpc("commit_ai_reply_tx", {
          p_conversation_id: params.conversation_id,
          p_source_message_id: params.source_message_id,
          p_content: params.warm_handoff_question,
          p_metadata: await bindAuthorizedReply(snapshot, params.warm_handoff_question!, {
            escalation_rule: "R2",
            escalation_action: "collect_missing_handoff_facts",
            response_route: "warm_handoff_data_collection",
            handoff_required: false,
          }),
        }),
    );
    if (!b2.committed) {
      return b2PreventedResponse(b2.decision, {
        escalation_rule: "R2",
        clarification_persisted: false,
      });
    }
    const { data, error } = b2.value;
    if (error) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "warm_handoff_collection_failed",
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const result = String((data as any)?.result ?? "");
    if (result === "success" || result === "idempotent") {
      await cleanupThinking(
        supabaseAdmin,
        params.conversation_id,
        params.source_message_id,
      );
      return new Response(
        JSON.stringify({
          success: true,
          response_route: "warm_handoff_data_collection",
          handoff_required: false,
          missing_facts_requested: true,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      result === "human_control" || result === "resolved" ||
      result === "superseded_source"
    ) {
      return new Response(JSON.stringify({ success: true, skipped: result }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `warm_handoff_collection_${result || "unexpected"}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  if (
    decision.decision === "clarify" && decision.matched_rule === "R2" &&
    enabled.has("R2")
  ) {
    const clarification = buildWorkflow5TopicalClarification(
      params.latest_message_content,
      params.visitor_language,
    ) ??
      R2_CLARIFICATION_SAFE_WORDING[params.visitor_language];
    const b2 = await executeB2RpcPersistence(
      supabaseAdmin,
      {
        conversation_id: params.conversation_id,
        source_message_id: params.source_message_id,
        proposed_response: clarification,
        persistence_kind: "required_escalation_clarification",
        metadata: {
          escalation_rule: "R2",
          escalation_action: "clarification",
          handoff_required: false,
        },
      },
      async () =>
        await persistRequiredEscalationClarification(
          requiredEscalationRpcClient(supabaseAdmin),
          {
            conversation_id: params.conversation_id,
            source_message_id: params.source_message_id as string,
            decision,
            safe_reply_content: clarification,
          },
        ),
    );
    if (!b2.committed) {
      return b2PreventedResponse(b2.decision, {
        escalation_rule: "R2",
        clarification_persisted: false,
      });
    }
    const persisted = b2.value;

    if (persisted.ok) {
      await cleanupThinking(
        supabaseAdmin,
        params.conversation_id,
        params.source_message_id,
      );
      return new Response(
        JSON.stringify({
          success: true,
          escalation_rule: "R2",
          escalation_action: "clarification",
          clarification_persisted: true,
          rpc_result: persisted.result,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (persisted.result === "already_resolved") {
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "resolved",
          escalation_rule: "R2",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (persisted.result === "already_under_human_control") {
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "human_handling",
          escalation_rule: "R2",
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (persisted.result === "max_clarifications_reached") {
      console.log("[generate-reply] R2 clarification capped at one", {
        conversation_id: params.conversation_id,
      });
      return null;
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: `required_escalation_clarification_${persisted.result}`,
        escalation_rule: "R2",
        clarification_persisted: false,
        ...(persisted.result === "rpc_transport_error"
          ? { handoff_uncertain: true }
          : {}),
      }),
      {
        status: persisted.result === "not_found"
          ? 404
          : persisted.result === "invalid_source_message" ||
              persisted.result === "invalid_input" ||
              persisted.result === "invalid_rule" ||
              persisted.result === "invalid_clarification"
          ? 400
          : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  if (
    decision.decision !== "handoff" ||
    decision.matched_rule === null ||
    !enabled.has(decision.matched_rule)
  ) {
    console.log("[generate-reply] required-rules live no-match:", {
      conversation_id: params.conversation_id,
      matched_rule: decision.matched_rule,
      decision: decision.decision,
      reason_code: decision.reason_code,
      signal_gaps: decision.signal_gaps,
    });
    return null;
  }

  if (
    decision.matched_rule !== "E2" &&
    decision.matched_rule !== "E1" &&
    decision.matched_rule !== "R2"
  ) return null;

  const safeReply = REQUIRED_ESCALATION_SAFE_WORDING[decision.matched_rule][
    params.visitor_language
  ];
  const b2 = await executeB2RpcPersistence(
    supabaseAdmin,
    {
      conversation_id: params.conversation_id,
      source_message_id: params.source_message_id,
      proposed_response: safeReply,
      persistence_kind: "required_escalation_handoff",
      metadata: {
        escalation_rule: decision.matched_rule,
        escalation_action: "handoff",
        handoff_required: true,
      },
    },
    async () =>
      await persistRequiredEscalationHandoff(
        requiredEscalationRpcClient(supabaseAdmin),
        {
          conversation_id: params.conversation_id,
          source_message_id: params.source_message_id as string,
          decision,
          safe_reply_content: safeReply,
        },
      ),
  );
  if (!b2.committed) {
    return b2PreventedResponse(b2.decision, {
      escalation_rule: decision.matched_rule,
      handoff_persisted: false,
    });
  }
  const persisted = b2.value;

  if (persisted.ok) {
    await cleanupThinking(
      supabaseAdmin,
      params.conversation_id,
      params.source_message_id,
    );
    return new Response(
      JSON.stringify({
        success: true,
        escalation_rule: decision.matched_rule,
        handoff_persisted: true,
        rpc_result: persisted.result,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  switch (persisted.result) {
    case "already_resolved":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "resolved",
          escalation_rule: decision.matched_rule,
          handoff_persisted: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_under_human_control":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "human_handling",
          escalation_rule: decision.matched_rule,
          handoff_persisted: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "invalid_source_message":
    case "invalid_input":
    case "invalid_rule":
    case "invalid_priority":
    case "invalid_safe_reply":
      return new Response(
        JSON.stringify({
          success: false,
          error: `required_escalation_${persisted.result}`,
          escalation_rule: decision.matched_rule,
          handoff_persisted: false,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    case "rpc_transport_error":
      return new Response(
        JSON.stringify({
          success: false,
          error: "required_escalation_rpc_transport_error",
          escalation_rule: decision.matched_rule,
          handoff_persisted: false,
          handoff_uncertain: true,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    case "not_found":
      return new Response(
        JSON.stringify({
          success: false,
          error: "required_escalation_conversation_not_found",
          escalation_rule: decision.matched_rule,
          handoff_persisted: false,
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    default:
      return new Response(
        JSON.stringify({
          success: false,
          error: "required_escalation_unexpected_result",
          escalation_rule: decision.matched_rule,
          handoff_persisted: false,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let parsedConversationId: string | null = null;
  let parsedSourceMessageId: string | null = null;
  try {
    const body = await req.json();
    const { conversation_id, source_message_id } = body ?? {};
    if (!conversation_id) {
      return new Response(
        JSON.stringify({ error: "conversation_id required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    parsedConversationId = String(conversation_id);
    parsedSourceMessageId = typeof source_message_id === "string"
      ? source_message_id
      : null;

    const ENABLE_KB = Deno.env.get("ENABLE_KB_ADAPTER") !== "false";
    const ENABLE_COACH = Deno.env.get("ENABLE_COACH_PROMPT_ADAPTER") === "true";
    const ENABLE_C360 = Deno.env.get("ENABLE_CUSTOMER360_ADAPTER") === "true";
    const ENABLE_TOOL_EXEC = Deno.env.get("ENABLE_TOOL_EXECUTOR") === "true";

    const ENABLE_PR5_ESCALATION_RUNTIME =
      Deno.env.get("ESC_MVP_FEATURE_FLAG") === "true" ||
      Deno.env.get("ESC_ENABLE_S0") === "true" ||
      Deno.env.get("ESC_SHADOW_MODE") === "true" ||
      Deno.env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") === "true";

    const result = await runWithTerminalDeadline(
      async (requestSignal) => {
        if (
          !ENABLE_KB &&
          !ENABLE_COACH &&
          !ENABLE_C360 &&
          !ENABLE_TOOL_EXEC &&
          !ENABLE_PR5_ESCALATION_RUNTIME
        ) {
          return await legacyGenerateReply(
            parsedConversationId!,
            parsedSourceMessageId,
            requestSignal,
          );
        }

        return await orchestrationGenerateReply(
          parsedConversationId!,
          { ENABLE_KB, ENABLE_COACH, ENABLE_C360, ENABLE_TOOL_EXEC },
          parsedSourceMessageId,
          requestSignal,
        );
      },
      async () =>
        await persistTerminalRecovery(
          parsedConversationId!,
          parsedSourceMessageId,
          "generation_work_budget_exhausted",
        ),
    );
    return result.kind === "deadline"
      ? result.value
      : await recoverTerminalResponseIfNeeded(
        result.value,
        parsedConversationId,
        parsedSourceMessageId,
      );
  } catch (error) {
    console.error("[generate-reply] unexpected error:", error);
    if (parsedConversationId && parsedSourceMessageId) {
      return await persistTerminalRecovery(
        parsedConversationId,
        parsedSourceMessageId,
        error instanceof Error ? error.name : "unexpected_error",
      );
    }
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function responseErrorCode(response: Response): Promise<string | null> {
  try {
    const payload = await response.clone().json();
    if (!payload || typeof payload !== "object") return null;
    const value = (payload as Record<string, unknown>).error;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

async function recoverTerminalResponseIfNeeded(
  response: Response,
  conversationId: string,
  sourceMessageId: string | null,
): Promise<Response> {
  const errorCode = await responseErrorCode(response);
  if (
    !(isRecoverableTerminalStatus(response.status) &&
      isRecoverableTerminalError(errorCode)) &&
    !(response.status === 409 && isRecoverableTerminalError(errorCode))
  ) return response;
  return await persistTerminalRecovery(
    conversationId,
    sourceMessageId,
    errorCode ?? `http_${response.status}`,
    response,
  );
}

async function persistTerminalRecovery(
  conversationId: string,
  sourceMessageId: string | null,
  reason: string,
  originalResponse?: Response,
): Promise<Response> {
  if (!sourceMessageId) {
    return originalResponse ?? new Response(
      JSON.stringify({
        success: false,
        error: "terminal_recovery_source_required",
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      getSupabaseAdminKey(),
    );
    const source = await loadSourceVisitorMessage(
      admin,
      conversationId,
      sourceMessageId,
    );
    if (!source.ok) {
      await cleanupThinking(admin, conversationId, sourceMessageId);
      return originalResponse ?? sourceMessageErrorResponse(source);
    }
    const language = detectVisitorLanguage(source.message.content);
    const reply = terminalRecoveryReply(language);
    const committed = await commitAiReplyWithControlGate(
      admin,
      conversationId,
      sourceMessageId,
      reply,
      {
        response_route: "terminal_failure_recovery",
        handoff_required: false,
        factual_grounding_required: false,
        degraded: true,
        source_error_code: reason.slice(0, 120),
      },
    );
    await cleanupThinking(admin, conversationId, sourceMessageId);
    if (committed.ok) {
      return new Response(
        JSON.stringify({
          success: true,
          reply,
          degraded: true,
          response_route: "terminal_failure_recovery",
          idempotent: committed.idempotent,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      [
        "source_already_replied",
        "human_control",
        "resolved",
        "superseded_source",
      ]
        .includes(committed.result)
    ) {
      return new Response(
        JSON.stringify({ success: true, skipped: committed.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return originalResponse ?? new Response(
      JSON.stringify({
        success: false,
        error: `terminal_recovery_${committed.result}`,
      }),
      {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    console.error("[generate-reply] terminal recovery failed closed:", {
      conversation_id: conversationId,
      reason: error instanceof Error ? error.name : "unknown_error",
    });
    return originalResponse ?? new Response(
      JSON.stringify({
        success: false,
        error: "terminal_recovery_unavailable",
      }),
      {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
}

async function handleConversationClosureIfNeeded(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  source_message_id: string | null,
  latestMessage: string,
): Promise<Response | null> {
  const classification = classifyConversationClosure(latestMessage);
  if (classification.kind === "none") return null;
  const { data: conversation } = await supabaseAdmin.from("conversations")
    .select("status, assigned_agent_id, company_id").eq("id", conversation_id)
    .maybeSingle();
  if (
    !conversation || !conversation.company_id ||
    conversation.status === "resolved" ||
    isHumanControlState(
      String(conversation.status ?? ""),
      conversation.assigned_agent_id ?? null,
    )
  ) return null;

  const [{ data: prior }, { data: commerce }] = await Promise.all([
    supabaseAdmin.from("messages").select(
      "role, metadata, content, created_at",
    ).eq("conversation_id", conversation_id).eq("is_recalled", false).neq(
      "content",
      "__THINKING__",
    ).order("created_at", { ascending: false }).limit(4),
    supabaseAdmin.from("conversation_commerce_state").select(
      "company_id, revision, source_message_id, state",
    ).eq("conversation_id", conversation_id).eq(
      "company_id",
      conversation.company_id,
    ).maybeSingle(),
  ]);
  const previousAssistant = (prior ?? []).find((r: any) =>
    r.role === "assistant" &&
    String(r.content ?? "") !== buildConversationClosureReply(classification)
  );
  const pm = previousAssistant?.metadata &&
      typeof previousAssistant.metadata === "object"
    ? previousAssistant.metadata as Record<string, unknown>
    : null;
  if (
    !previousAssistant || pm?.handoff_required === true ||
    [
      "warm_handoff_data_collection",
      "kb_no_match_clarification",
      "system_error_handoff",
    ].includes(String(pm?.response_route ?? ""))
  ) return null;

  const closure = decideTransactionClosure({
    utterance_kind: classification.kind,
    commerce_state: commerce?.state ?? null,
    handoff_active: false,
    handoff_required: false,
    professional_confirmation_required: false,
  });
  const content = closure.may_resolve
    ? buildConversationClosureReply(classification)
    : classification.kind === "closure_candidate"
    ? buildConversationClosureReply(classification)
    : buildC2PendingClosureReply(classification.language, closure.blockers);
  if (!content) return null;

  const metadata = {
    response_route: closure.may_resolve
      ? "c2_transaction_closure"
      : "conversation_closure",
    closure_state: closure.state,
    closure_reason: closure.reason,
    closure_blockers: closure.blockers,
    commerce_state_revision: typeof commerce?.revision === "number"
      ? commerce.revision
      : null,
    feedback_eligible_candidate: closure.may_resolve,
    handoff_required: false,
  };

  if (closure.may_resolve) {
    if (!source_message_id) return null;
    const b2 = await executeB2RpcPersistence(
      supabaseAdmin,
      {
        conversation_id,
        source_message_id,
        proposed_response: content,
        persistence_kind: "ai_reply",
        metadata,
        expected_commerce_state_revision: metadata.commerce_state_revision,
      },
      async () =>
        await supabaseAdmin.rpc("c2_commit_closure_tx", {
          p_conversation_id: conversation_id,
          p_company_id: conversation.company_id,
          p_source_message_id: source_message_id,
          p_expected_commerce_revision: metadata.commerce_state_revision,
          p_content: content,
          p_metadata: metadata,
        }),
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (!b2.committed) {
      return b2PreventedResponse(b2.decision, {
        response_route: "c2_transaction_closure",
        closure_state: closure.state,
      });
    }
    const { data, error } = b2.value;
    if (error) {
      return new Response(
        JSON.stringify({ success: false, error: "c2_closure_rpc_error" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const result = String(data?.result ?? "unknown");
    if (result === "success" || result === "idempotent") {
      return new Response(
        JSON.stringify({
          success: true,
          response_route: "c2_transaction_closure",
          closure_state: "RESOLVED",
          idempotent: result === "idempotent",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      [
        "human_control",
        "resolved",
        "superseded_source",
        "transaction_pending",
        "handoff_pending",
      ].includes(result)
    ) {
      return new Response(
        JSON.stringify({ success: true, skipped: result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ success: false, error: `c2_closure_${result}` }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const committed = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversation_id,
    source_message_id,
    content,
    metadata,
  );
  await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
  if (!committed.ok) {
    if (
      ["human_control", "resolved", "superseded_source"].includes(
        committed.result,
      )
    ) {
      return new Response(
        JSON.stringify({ success: true, skipped: committed.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `conversation_closure_${committed.result}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  return new Response(
    JSON.stringify({
      success: true,
      response_route: "conversation_closure",
      closure_state: closure.state,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function legacyGenerateReply(
  conversation_id: string,
  source_message_id: string | null,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    getSupabaseAdminKey(),
  );

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("conversations").select(
      "id, status, assigned_agent_id, created_at, company_id",
    ).eq("id", conversation_id).single();

  if (convError || !conversation) {
    console.error("[generate-reply] conversation not found:", conversation_id);
    return new Response(JSON.stringify({ error: "Conversation not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (conversation.status === "resolved") {
    return new Response(
      JSON.stringify({ success: true, skipped: "resolved" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (
    isHumanControlState(
      conversation.status,
      conversation.assigned_agent_id ?? null,
    )
  ) {
    console.log(
      "[generate-reply] human-handling guard: skipping LLM for status:",
      conversation.status,
      conversation_id,
    );
    return new Response(
      JSON.stringify({ success: true, skipped: "human_handling" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (conversation.assigned_agent_id) {
    console.log(
      "[generate-reply] S-1 assigned_agent_id guard (legacy):",
      conversation_id,
    );
    return new Response(
      JSON.stringify({ success: true, skipped: "assigned_to_agent" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const sourceResult = await loadSourceVisitorMessage(
    supabaseAdmin,
    conversation_id,
    source_message_id,
  );
  if (!sourceResult.ok) return sourceMessageErrorResponse(sourceResult);
  const sourceVisitorMessage = sourceResult.message;

  const { data: newestMessages } = await supabaseAdmin
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversation_id)
    .neq("content", "__THINKING__")
    .eq("is_recalled", false)
    .or(sourceBoundaryFilter(sourceVisitorMessage))
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(10);

  if (!newestMessages || newestMessages.length === 0) {
    return new Response(
      JSON.stringify({ success: true, skipped: "no messages" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const messages = [...newestMessages].reverse();
  const modelMessages: Array<{ role: "user" | "assistant"; content: string }> =
    messages.map((m) => ({
      role: m.role === "visitor" ? "user" : "assistant",
      content: String(m.content ?? ""),
    }));
  if (modelMessages[modelMessages.length - 1].role === "assistant") {
    return new Response(
      JSON.stringify({ success: true, skipped: "last message is assistant" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const lastVisitorMsg = sourceVisitorMessage.content;
  const handoffLang = detectHandoffLanguage(lastVisitorMsg);

  if (handoffLang) {
    if (!source_message_id) {
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(
        JSON.stringify({
          success: false,
          error: "legacy_handoff_missing_source_message_id",
          escalation_rule: "R1",
          handoff_persisted: false,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const b2 = await executeB2RpcPersistence(
      supabaseAdmin,
      {
        conversation_id,
        source_message_id,
        proposed_response: SAFE_HANDOFF_WORDING[handoffLang],
        persistence_kind: "explicit_handoff",
        metadata: { escalation_rule: "R1", handoff_required: true },
      },
      async () =>
        await supabaseAdmin.rpc("explicit_handoff_tx", {
          p_conversation_id: conversation_id,
          p_safe_reply_content: SAFE_HANDOFF_WORDING[handoffLang],
          p_source_message_id: source_message_id,
        }),
    );
    if (!b2.committed) {
      return b2PreventedResponse(b2.decision, {
        escalation_rule: "R1",
        handoff_persisted: false,
      });
    }
    const { data: handoffData, error: handoffError } = b2.value;

    if (handoffError) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "legacy_handoff_rpc_transport_error",
          escalation_rule: "R1",
          handoff_persisted: false,
          handoff_uncertain: true,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const handoffResult = String(handoffData?.result ?? "unknown");
    switch (handoffResult) {
      case "success":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id,
        );
        return new Response(
          JSON.stringify({
            success: true,
            escalation_rule: "R1",
            handoff_persisted: true,
            rpc_result: "success",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      case "already_handled":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id,
        );
        return new Response(
          JSON.stringify({
            success: true,
            escalation_rule: "R1",
            handoff_persisted: true,
            rpc_result: "already_handled",
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      case "already_resolved":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id,
        );
        return new Response(
          JSON.stringify({
            success: true,
            skipped: "resolved",
            escalation_rule: "R1",
            handoff_persisted: false,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      case "already_under_human_control":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id,
        );
        return new Response(
          JSON.stringify({
            success: true,
            skipped: "human_handling",
            escalation_rule: "R1",
            handoff_persisted: false,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      case "invalid_source_message":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id,
        );
        return new Response(
          JSON.stringify({
            success: false,
            error: "legacy_handoff_invalid_source_message",
            escalation_rule: "R1",
            handoff_persisted: false,
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      case "not_found":
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id,
        );
        return new Response(
          JSON.stringify({
            success: false,
            error: "legacy_handoff_conversation_not_found",
            escalation_rule: "R1",
            handoff_persisted: false,
          }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      default:
        return new Response(
          JSON.stringify({
            success: false,
            error: "legacy_handoff_unexpected_result",
            escalation_rule: "R1",
            handoff_persisted: false,
            rpc_result: handoffResult,
          }),
          {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
    }
  }

  const legacyLatestHandoffReason = await loadLatestHandoffReason(
    supabaseAdmin,
    conversation_id,
  );
  const legacyReturnToAiGuard = buildReturnToAiGenerationGuard(
    legacyLatestHandoffReason,
    conversation.assigned_agent_id ?? null,
  );

  const legacySystemPrompt =
    `You are a professional and friendly customer service assistant.
Answer customer questions clearly and concisely.
If details are missing, ask one concise contextual question. If a fact cannot be verified, say you cannot confirm it and do not guess. Do not offer a human unless the governed escalation layer has decided one is appropriate.
Keep responses under 150 words.
Respond in the same language and script the customer is using.
When the customer explicitly requests a human agent, or when you transfer to a human agent, include a short safe handoff status message in the same language and script as the customer. Confirm only that the conversation has been handed to human support and that the agent will reply in this same chat. Queue position, customers-ahead counts, and estimated wait time are dynamic widget runtime data: never invent or hard-code them. If live queue data is available, the widget will display it separately; if it is unavailable, do not promise an estimate.

${CUSTOMER_CONVERSATION_POLICY}

${legacyReturnToAiGuard}`;

  const llm = await callModel({
    purpose: "generation",
    system: legacySystemPrompt,
    user: buildRouterConversationInput(modelMessages),
    maxTokens: resolveGenerationMaxTokens(),
    operationId:
      `generate-reply:legacy:${conversation_id}:${source_message_id}`,
    companyId: typeof conversation.company_id === "string" &&
        conversation.company_id.length > 0
      ? conversation.company_id
      : null,
    conversationId: conversation_id,
    tag: "generate-reply-legacy",
    responseFormat: "text",
    signal: requestSignal,
  });

  if (!llm.ok) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    await writeTraces(supabaseAdmin, {
      conversation_id,
      message_id: null,
      user_message_raw: lastVisitorMsg,
      response_latency_ms: llm.usage.latency_ms,
      token_input: llm.usage.input_tokens,
      token_output: llm.usage.output_tokens,
      model_used: Deno.env.get("LLM_MODEL_GENERATION")?.trim() || "unset",
    });
    return new Response(
      JSON.stringify({
        success: false,
        error: "AI service error",
        error_code: llm.code,
      }),
      {
        status: routerFailureHttpStatus(llm.code),
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const aiReplyContent = llm.text;

  const committed = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversation_id,
    source_message_id,
    aiReplyContent,
    null,
  );
  if (!committed.ok) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (
      committed.result === "human_control" ||
      committed.result === "resolved" ||
      committed.result === "superseded_source"
    ) {
      console.log(
        "[generate-reply] stale AI reply suppressed by control gate:",
        {
          conversation_id,
          result: committed.result,
        },
      );
      return new Response(
        JSON.stringify({ success: true, skipped: committed.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `ai_reply_commit_${committed.result}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  await writeTraces(supabaseAdmin, {
    conversation_id,
    message_id: committed.message_id,
    user_message_raw: lastVisitorMsg,
    response_latency_ms: llm.usage.latency_ms,
    token_input: llm.usage.input_tokens,
    token_output: llm.usage.output_tokens,
    model_used: llm.model,
  });
  console.log(
    "[generate-reply] AI reply committed for conversation:",
    conversation_id,
  );
  return new Response(
    JSON.stringify({ success: true, idempotent: committed.idempotent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

function extractExplicitJurisdictionConstraint(text: string): string | null {
  const t = text.normalize("NFKC").trim();
  const jurisdictions: Array<{ label: string; re: RegExp }> = [
    { label: "Mars", re: /(mars|火星)/ig },
    { label: "香港", re: /(香港|hong\s*kong|\bhk\b)/ig },
    { label: "澳門", re: /(澳門|澳门|macau|macao)/ig },
    { label: "新加坡", re: /(新加坡|singapore)/ig },
    { label: "台灣", re: /(台灣|台湾|taiwan)/ig },
    {
      label: "中國大陸",
      re: /(中國大陸|中国大陆|內地|内地|mainland\s*china)/ig,
    },
  ];
  const negatedMars =
    /(不談|不谈|唔講|唔讲|不要談|不要谈|not\s+(?:talking\s+about|about)|forget\s+about)\s*(mars|火星)/i
      .test(t);
  let best: { label: string; index: number } | null = null;
  for (const item of jurisdictions) {
    item.re.lastIndex = 0;
    for (const match of t.matchAll(item.re)) {
      if (item.label === "Mars" && negatedMars) continue;
      const index = match.index ?? -1;
      if (!best || index > best.index) best = { label: item.label, index };
    }
  }
  return best?.label ?? null;
}

function evidenceSupportsJurisdiction(
  jurisdiction: string | null,
  chunks: Array<{ content?: string; title?: string }>,
): boolean {
  if (!jurisdiction) return true;
  const needle = jurisdiction.toLocaleLowerCase();
  return chunks.some((chunk) =>
    `${chunk.title ?? ""}\n${chunk.content ?? ""}`.toLocaleLowerCase().includes(
      needle,
    )
  );
}

type FlagSet = {
  ENABLE_KB: boolean;
  ENABLE_COACH: boolean;
  ENABLE_C360: boolean;
  ENABLE_TOOL_EXEC: boolean;
};

const KB_FALLBACK_SAFE_TEXT: Record<string, Record<string, string>> = {
  KB_SCOPE_GATE: {
    "zh-TW": "很抱歉，系統暫時無法查詢知識庫。讓我為您轉接客服人員。",
    "zh-CN": "很抱歉，系统暂时无法查询知识库。让我为您转接客服人员。",
    en:
      "Sorry, the knowledge base is temporarily unavailable. Let me connect you with a human agent.",
  },
  KB_API_FAIL: {
    "zh-TW": "系統暫時無法查詢知識庫，讓我為您轉接客服人員。",
    "zh-CN": "系统暂时无法查询知识库，让我为您转接客服人员。",
    en:
      "The knowledge base is temporarily unavailable. Let me connect you with a human agent.",
  },
  KB_EMPTY: {
    "zh-TW":
      "很抱歉，我目前無法確定答案。讓我為您轉接客服人員，以提供更準確的協助。",
    "zh-CN":
      "很抱歉，我目前无法确定答案。让我为您转接客服人员，以提供更准确的协助。",
    en:
      "Sorry, I'm unable to find a definitive answer. Let me connect you with a human agent for more accurate assistance.",
  },
  KB_LOW_SCORE_HIGH_RISK: {
    "zh-TW":
      "這個問題涉及重要政策，為確保您獲得準確資訊，讓我為您轉接客服人員。",
    "zh-CN":
      "这个问题涉及重要政策，为确保您获得准确信息，让我为您转接客服人员。",
    en:
      "This question involves important policy matters. To ensure you receive accurate information, let me connect you with a human agent.",
  },
  KB_LOW_SCORE_STANDARD: {
    "zh-TW":
      "很抱歉，我目前無法確定答案。讓我為您轉接客服人員，以提供更準確的協助。",
    "zh-CN":
      "很抱歉，我目前无法确定答案。让我为您转接客服人员，以提供更准确的协助。",
    en:
      "Sorry, I'm unable to find a definitive answer. Let me connect you with a human agent for more accurate assistance.",
  },
};

const S0_LLM_FAILURE_SAFE_TEXT: Record<string, string> = {
  "zh-TW": "系統暫時無法完成回覆，我已為你轉交客服人員跟進。",
  "zh-CN": "系统暂时无法完成回复，我已为你转交客服人员跟进。",
  en:
    "The system is temporarily unable to complete a response. I\u2019ve handed this conversation to a support agent for follow-up.",
};

function detectVisitorLanguage(text: string): "zh-TW" | "zh-CN" | "en" {
  if (!text) return "zh-TW";
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  const zhCnIndicators = [
    "转",
    "们",
    "队",
    "预计",
    "为您",
    "为我",
    "为你",
    "请",
    "这",
    "没",
  ];
  if (zhCnIndicators.some((c) => text.includes(c))) return "zh-CN";
  return "zh-TW";
}

type KBFallbackRpcResult =
  | "success"
  | "already_handled"
  | "already_resolved"
  | "already_under_human_control"
  | "invalid_source_message"
  | "invalid_branch"
  | "not_found";

/* ------------- ordinary first no-match / low-score clarification ------------ */

/**
 * Product-ready no-match behaviour.
 *
 * An ordinary, low-risk FIRST no-match or partial/low-score retrieval is not a
 * failure and must not escalate: the AI asks exactly ONE clarification turn and
 * keeps AI control. Repeated unresolved same intent, the clarification cap,
 * high-risk topics, explicit human requests, threat/compliance (E1/E2) and real
 * provider/KB outages are untouched and remain fail-closed — this helper is only
 * reached AFTER those required-rule evaluations have declined to act.
 */
const KB_NO_MATCH_CLARIFICATION_TEXT: Record<"zh-TW" | "zh-CN" | "en", string> =
  {
    "zh-TW":
      "為了幫你找到準確的資料，可以再補充一點細節嗎？例如你想了解的產品、服務或具體情況。",
    "zh-CN":
      "为了帮你找到准确的资料，可以再补充一点细节吗？例如你想了解的产品、服务或具体情况。",
    en:
      "To find the right information for you, could you share a bit more detail — for example the product, service, or specific situation you're asking about?",
  };

export const KB_NO_MATCH_CLARIFICATION_ROUTE = "kb_no_match_recovery";

export function isFirstNoMatchClarificationEligible(input: {
  branch_tag: string;
  high_risk: boolean;
  explicit_human_request: boolean;
  threat_flag?: boolean;
  compliance_requires_human_review?: boolean;
  clarification_attempts: number;
  exact_same_intent_repeated: boolean;
  source_message_id: string | null;
}): boolean {
  // Only ordinary retrieval outcomes; provider/KB outage branches stay fail-closed.
  if (
    input.branch_tag !== "KB_EMPTY" &&
    input.branch_tag !== "KB_LOW_SCORE_STANDARD"
  ) return false;
  if (input.high_risk) return false;
  if (input.explicit_human_request) return false;
  if (input.threat_flag === true) return false;
  if (input.compliance_requires_human_review === true) return false;
  if (input.clarification_attempts > 0) return false;
  if (input.exact_same_intent_repeated) return false;
  if (!input.source_message_id) return false;
  return true;
}

async function attemptFirstNoMatchClarification(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  source_message_id: string | null,
  branchTag: string,
  visitorLang: "zh-TW" | "zh-CN" | "en",
  eligibility: Omit<
    Parameters<typeof isFirstNoMatchClarificationEligible>[0],
    "branch_tag" | "source_message_id"
  >,
  servicePlan: ServiceDialoguePlan,
  traceMetadata: Record<string, unknown>,
): Promise<Response | null> {
  if (
    !isFirstNoMatchClarificationEligible({
      ...eligibility,
      branch_tag: branchTag,
      source_message_id,
    })
  ) {
    return null;
  }

  const content = renderTargetedServiceQuestion(servicePlan, visitorLang) ||
    KB_NO_MATCH_CLARIFICATION_TEXT[visitorLang] ||
    KB_NO_MATCH_CLARIFICATION_TEXT["zh-TW"];
  // Same atomic exactly-once gate as every other AI reply: human-control /
  // resolved / superseded races cannot produce a duplicate or late clarification.
  const commit = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversation_id,
    source_message_id,
    content,
    {
      response_route: KB_NO_MATCH_CLARIFICATION_ROUTE,
      escalation_action: "clarification",
      clarification_reason: "clarification_new_intent_no_kb_match",
      kb_lookup: true,
      kb_branch_tag: branchTag,
      handoff_required: false,
      trace_metadata: traceMetadata,
    },
  );

  if (!commit.ok) {
    if (
      commit.result === "human_control" || commit.result === "resolved" ||
      commit.result === "superseded_source"
    ) {
      return new Response(
        JSON.stringify({
          success: true,
          skipped: commit.result,
          response_route: KB_NO_MATCH_CLARIFICATION_ROUTE,
          handoff_required: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    // Anything else falls through to the existing fail-closed fallback.
    return null;
  }

  await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
  return new Response(
    JSON.stringify({
      success: true,
      reply: content,
      no_answer: true,
      handoff_required: false,
      handoff_persisted: false,
      response_route: KB_NO_MATCH_CLARIFICATION_ROUTE,
      escalation_rule: null,
      trace_metadata: {
        ...traceMetadata,
        branch: branchTag,
        clarification_persisted: true,
        idempotent: commit.idempotent,
      },
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function persistC3ServiceRecovery(
  supabaseAdmin: SupabaseAdminClient,
  conversationId: string,
  sourceMessageId: string | null,
  plan: ServiceDialoguePlan,
  state: "no_match" | "tool_failure" | "conflict",
  language: "zh-TW" | "zh-CN" | "en",
  traceMetadata: Record<string, unknown>,
): Promise<Response> {
  const content = renderServiceRecovery(plan, state, language);
  const metadata = {
    ...traceMetadata,
    response_route: `c3_service_${state}`,
    service_plan_version: plan.version,
    service_action: plan.action,
    missing_slots: plan.missing_slots,
    clarification_target: plan.clarification_target,
    knowledge_state: state,
    factual_grounding_required: false,
    conversation_grounded: plan.known_facts.length > 0,
    handoff_required: false,
  };
  const committed = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversationId,
    sourceMessageId,
    content,
    metadata,
  );
  await cleanupThinking(supabaseAdmin, conversationId, sourceMessageId);
  if (!committed.ok) {
    return new Response(
      JSON.stringify({ success: true, skipped: committed.result }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  return new Response(
    JSON.stringify({
      success: true,
      reply: content,
      response_route: metadata.response_route,
      service_action: plan.action,
      handoff_required: false,
      idempotent: committed.idempotent,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function persistBoundedNoCurrentEvidence(
  supabaseAdmin: SupabaseAdminClient,
  conversationId: string,
  sourceMessageId: string | null,
  plan: ServiceDialoguePlan,
  language: "zh-TW" | "zh-CN" | "en",
  traceMetadata: Record<string, unknown>,
  naturalIntent: NaturalCustomerIntent = { kind: "none", product: null },
): Promise<Response> {
  const content = renderNaturalNoCurrentEvidence(naturalIntent, language) ??
    renderBoundedNoCurrentEvidence(language);
  const metadata = {
    ...traceMetadata,
    response_route: NO_CURRENT_EVIDENCE_ROUTE,
    service_plan_version: plan.version,
    service_action: "direct_answer",
    knowledge_state: "no_match",
    grounding_state: "no_current_evidence",
    factual_grounding_required: true,
    historical_evidence_promoted: false,
    handoff_required: false,
  };
  const committed = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversationId,
    sourceMessageId,
    content,
    metadata,
  );
  await cleanupThinking(supabaseAdmin, conversationId, sourceMessageId);
  if (!committed.ok) {
    if (
      ["human_control", "resolved", "superseded_source"].includes(
        committed.result,
      )
    ) {
      return new Response(
        JSON.stringify({ success: true, skipped: committed.result }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `no_current_evidence_commit_${committed.result}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  return new Response(
    JSON.stringify({
      success: true,
      reply: content,
      no_answer: true,
      handoff_required: false,
      response_route: NO_CURRENT_EVIDENCE_ROUTE,
      grounding_state: "no_current_evidence",
      idempotent: committed.idempotent,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function persistNaturalImmediateResponse(
  supabaseAdmin: SupabaseAdminClient,
  conversationId: string,
  sourceMessageId: string | null,
  intent: NaturalCustomerIntent,
  language: "zh-TW" | "zh-CN" | "en",
): Promise<Response | null> {
  // Product guidance can establish durable Commerce entities/constraints.
  // It therefore renders only after the shared Commerce writer has run.
  if (intent.kind === "product_guidance") return null;
  const content = renderNaturalImmediateResponse(intent, language);
  if (!content) return null;
  const responseRoute = intent.kind === "greeting"
    ? "natural_greeting"
    : intent.kind === "product_availability"
    ? "product_availability_clarification"
    : intent.kind === "product_factual_clarification"
    ? "product_referent_clarification"
    : "product_shopping_intent";
  const committed = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversationId,
    sourceMessageId,
    content,
    {
      response_route: responseRoute,
      natural_response_contract: "c3-natural-customer-response-v1",
      natural_intent: intent.kind,
      product_reference_present: Boolean(intent.product),
      product_referent_candidates:
        intent.kind === "product_factual_clarification"
          ? intent.candidates
          : undefined,
      product_referent_reason: intent.kind === "product_factual_clarification"
        ? intent.reason
        : undefined,
      factual_grounding_required: false,
      commerce_state_persist_result: "read_only",
      commerce_state_persistence_classification: "NO_SEMANTIC_CHANGE",
      handoff_required: false,
    },
  );
  await cleanupThinking(supabaseAdmin, conversationId, sourceMessageId);
  if (!committed.ok) {
    if (
      [
        "human_control",
        "resolved",
        "superseded_source",
        "source_already_replied",
      ]
        .includes(committed.result)
    ) {
      return new Response(
        JSON.stringify({ success: true, skipped: committed.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `natural_response_commit_${committed.result}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  return new Response(
    JSON.stringify({
      success: true,
      reply: content,
      response_route: responseRoute,
      handoff_required: false,
      idempotent: committed.idempotent,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function handleKBFallback(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  branchTag: string,
  source_message_id: string | null,
  traceMetadata: Record<string, unknown>,
  visitorLang: "zh-TW" | "zh-CN" | "en" = "zh-TW",
): Promise<Response> {
  const _branchTexts = KB_FALLBACK_SAFE_TEXT[branchTag];
  const safeText = _branchTexts
    ? (_branchTexts[visitorLang] ?? _branchTexts["zh-TW"])
    : undefined;
  if (!safeText) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "kb_fallback_unknown_branch",
        no_answer: true,
        handoff_required: true,
        handoff_persisted: false,
        trace_metadata: {
          ...traceMetadata,
          branch: branchTag,
          handoff_persisted: false,
        },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  if (!source_message_id) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "kb_fallback_missing_source_id",
        reply: safeText,
        no_answer: true,
        handoff_required: true,
        handoff_persisted: false,
        trace_metadata: { ...traceMetadata, handoff_persisted: false },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const b2 = await executeB2RpcPersistence(
    supabaseAdmin,
    {
      conversation_id,
      source_message_id,
      proposed_response: safeText,
      persistence_kind: "kb_fallback_handoff",
      metadata: { branch: branchTag, handoff_required: true },
    },
    async () =>
      await supabaseAdmin.rpc("kb_fallback_handoff_tx", {
        p_conversation_id: conversation_id,
        p_safe_reply_content: safeText,
        p_branch_tag: branchTag,
        p_source_message_id: source_message_id,
      }),
  );
  if (!b2.committed) {
    return b2PreventedResponse(b2.decision, {
      branch: branchTag,
      handoff_persisted: false,
    });
  }
  const { data: rpcData, error: rpcErr } = b2.value;
  if (rpcErr) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "kb_fallback_persistence_failed",
        reply: safeText,
        no_answer: true,
        handoff_required: true,
        handoff_persisted: false,
        trace_metadata: { ...traceMetadata, handoff_persisted: false },
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  const result: string = rpcData?.result ?? "unknown";
  switch (result as KBFallbackRpcResult | "unknown") {
    case "success":
      return new Response(
        JSON.stringify({
          success: true,
          reply: safeText,
          no_answer: true,
          handoff_required: true,
          handoff_persisted: true,
          trace_metadata: {
            ...traceMetadata,
            rpc_result: "success",
            handoff_persisted: true,
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_handled":
      return new Response(
        JSON.stringify({
          success: true,
          reply: null,
          no_answer: true,
          handoff_required: false,
          handoff_persisted: true,
          trace_metadata: {
            ...traceMetadata,
            rpc_result: "already_handled",
            handoff_persisted: true,
            existing_branch: rpcData?.existing_branch,
            requested_branch: rpcData?.requested_branch,
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_resolved":
      return new Response(
        JSON.stringify({
          success: false,
          error: "conversation_resolved",
          reply: null,
          no_answer: false,
          handoff_required: false,
          handoff_persisted: false,
          trace_metadata: {
            ...traceMetadata,
            rpc_result: "already_resolved",
            handoff_persisted: false,
          },
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    case "already_under_human_control":
      return new Response(
        JSON.stringify({
          success: true,
          reply: null,
          no_answer: false,
          handoff_required: false,
          handoff_persisted: false,
          trace_metadata: {
            ...traceMetadata,
            rpc_result: "already_under_human_control",
            handoff_persisted: false,
          },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "invalid_source_message":
      return new Response(
        JSON.stringify({
          success: false,
          error: "kb_fallback_invalid_source",
          reply: safeText,
          no_answer: true,
          handoff_required: true,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, handoff_persisted: false },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    case "invalid_branch":
      return new Response(
        JSON.stringify({
          success: false,
          error: "kb_fallback_invalid_branch",
          no_answer: true,
          handoff_required: true,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, handoff_persisted: false },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    case "not_found":
      return new Response(
        JSON.stringify({
          success: false,
          error: "kb_fallback_conversation_not_found",
          no_answer: true,
          handoff_required: true,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, handoff_persisted: false },
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    default:
      return new Response(
        JSON.stringify({
          success: false,
          error: "kb_fallback_unexpected_result",
          reply: safeText,
          no_answer: true,
          handoff_required: true,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, handoff_persisted: false },
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
  }
}

async function handleS0Handoff(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  source_message_id: string | null,
  failure_type: string,
  visitorLang: "zh-TW" | "zh-CN" | "en",
): Promise<Response> {
  const isKBFailure = failure_type === "KB_SCOPE_GATE" ||
    failure_type === "KB_API_FAIL";
  let safeReply: string;
  if (isKBFailure) {
    const branchTexts = KB_FALLBACK_SAFE_TEXT[failure_type];
    safeReply = branchTexts?.[visitorLang] ?? branchTexts?.["zh-TW"] ?? "";
  } else {safeReply = S0_LLM_FAILURE_SAFE_TEXT[visitorLang] ??
      S0_LLM_FAILURE_SAFE_TEXT["zh-TW"];}

  if (!safeReply) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "s0_no_safe_reply",
        failure_type,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  if (!source_message_id) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "s0_missing_source_message_id",
        failure_type,
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const b2 = await executeB2RpcPersistence(
    supabaseAdmin,
    {
      conversation_id,
      source_message_id,
      proposed_response: safeReply,
      persistence_kind: "system_failure_handoff",
      metadata: { escalation_rule: "S0", failure_type, handoff_required: true },
    },
    async () =>
      await supabaseAdmin.rpc("s0_handoff_tx", {
        p_conversation_id: conversation_id,
        p_safe_reply_content: safeReply,
        p_source_message_id: source_message_id,
        p_failure_type: failure_type,
      }),
  );
  if (!b2.committed) {
    return b2PreventedResponse(b2.decision, {
      escalation_rule: "S0",
      failure_type,
      handoff_persisted: false,
    });
  }
  const { data: rpcData, error: rpcErr } = b2.value;
  if (rpcErr) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "s0_rpc_transport_error",
        failure_type,
        handoff_persisted: false,
        handoff_uncertain: true,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const _s0Result: string = rpcData?.result ?? "unknown";
  switch (_s0Result) {
    case "success":
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(
        JSON.stringify({
          success: true,
          escalation_rule: "S0",
          failure_type,
          handoff_persisted: true,
          rpc_result: "success",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_handled":
      return new Response(
        JSON.stringify({
          success: true,
          escalation_rule: "S0",
          failure_type,
          handoff_persisted: true,
          rpc_result: "already_handled",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_resolved":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "resolved",
          escalation_rule: "S0",
          failure_type,
          handoff_persisted: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_under_human_control":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "human_handling",
          escalation_rule: "S0",
          failure_type,
          handoff_persisted: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "invalid_source_message":
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_invalid_source_message",
          escalation_rule: "S0",
          failure_type,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    case "invalid_input":
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_invalid_input",
          escalation_rule: "S0",
          failure_type,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    case "invalid_failure_type":
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_invalid_failure_type",
          escalation_rule: "S0",
          failure_type,
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    case "not_found":
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_conversation_not_found",
          escalation_rule: "S0",
          failure_type,
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    default:
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_rpc_unknown_result",
          escalation_rule: "S0",
          failure_type,
          rpc_result: _s0Result,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
  }
}

type HF1RuntimeSignals = {
  anger_level?: "high" | "medium" | "low" | null;
  sentiment_trend?: number[] | null;
  unresolved_turns?: number;
  same_intent_repeat?: boolean;
  prior_clarification_count?: number;
  vip_tier?: string | null;
  high_value_customer?: boolean | null;
  predicted_csat?: number | null;
  churn_risk?: number | null;
  policy_risk?: "high" | "standard" | null;
  threat_flag?: boolean;
  rag_state?: string | null;
  current_intent?: string | null;
};

async function persistExplicitR1IfRequested(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  source_message_id: string | null,
  latestMessage: string,
  runtimeSignals: HF1RuntimeSignals = {},
): Promise<Response | null> {
  const classified = classifyExplicitHandoff(latestMessage);
  const { data: handoffHistory, error: handoffHistoryError } =
    await supabaseAdmin.from("messages").select(
      "id, role, content, metadata, created_at",
    ).eq("conversation_id", conversation_id).eq("is_recalled", false).order(
      "created_at",
      { ascending: true },
    ).order("id", { ascending: true }).limit(40);
  const pkg = buildWarmHandoffPackage(handoffHistory ?? [], "R1");
  const collectionContinuation = pkg.collection_already_attempted &&
    classified.rule !== "R1";
  if (classified.rule !== "R1" && !collectionContinuation) return null;
  const urgent = isDirectViolentThreat(latestMessage);
  const hf1Input = deriveHandoffDecisionInput(
    handoffHistory ?? [],
    latestMessage,
    pkg.missing_facts,
    {
      explicit_human_request: classified.rule === "R1",
      threat_flag: runtimeSignals.threat_flag ?? urgent,
      anger_level: runtimeSignals.anger_level ?? null,
      sentiment_trend: runtimeSignals.sentiment_trend ?? null,
      unresolved_turns: runtimeSignals.unresolved_turns ?? 0,
      same_intent_repeat: runtimeSignals.same_intent_repeat ?? false,
      prior_clarification_count: runtimeSignals.prior_clarification_count,
      vip_tier: runtimeSignals.vip_tier ?? null,
      high_value_customer: runtimeSignals.high_value_customer ?? null,
      predicted_csat: runtimeSignals.predicted_csat ?? null,
      churn_risk: runtimeSignals.churn_risk ?? null,
      policy_risk: runtimeSignals.policy_risk ?? null,
      rag_state: runtimeSignals.rag_state ?? null,
      current_intent: runtimeSignals.current_intent ?? null,
      current_topic: pkg.customer_goal,
    },
  );
  const hf1Decision = evaluateHandoffDecision(hf1Input);
  if (handoffHistoryError) {
    console.error(
      "[generate-reply] HF1 handoff history unavailable; fail-open to immediate handoff",
      conversation_id,
    );
  }
  if (
    classified.rule === "R1" && !handoffHistoryError &&
    hf1Decision.handoff_mode === "optional_clarification_then_handoff" &&
    !pkg.collection_already_attempted
  ) {
    const question = buildMissingFactsQuestion(pkg, classified.language);
    if (question) {
      const collected = await commitAiReplyWithControlGate(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        question,
        {
          escalation_rule: "R1",
          escalation_action: "collect_missing_handoff_facts",
          response_route: "warm_handoff_data_collection",
          handoff_required: false,
          hf1_decision: hf1Decision,
        },
      );
      if (collected.ok) {
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id,
        );
        return new Response(
          JSON.stringify({
            success: true,
            escalation_rule: "R1",
            response_route: "warm_handoff_data_collection",
            handoff_required: false,
            handoff_mode: hf1Decision.handoff_mode,
            missing_info_policy: hf1Decision.missing_info_policy,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      if (
        ["human_control", "resolved", "superseded_source"].includes(
          collected.result,
        )
      ) {
        return new Response(
          JSON.stringify({ success: true, skipped: collected.result }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: `r1_optional_clarification_${collected.result}`,
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
  }
  if (!source_message_id) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "esc_missing_source_message_id",
        escalation_rule: "R1",
        handoff_persisted: false,
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const b2 = await executeB2RpcPersistence(
    supabaseAdmin,
    {
      conversation_id,
      source_message_id,
      proposed_response: SAFE_HANDOFF_WORDING[classified.language],
      persistence_kind: "explicit_handoff",
      metadata: { escalation_rule: "R1", handoff_required: true },
    },
    async () =>
      await supabaseAdmin.rpc("explicit_handoff_tx", {
        p_conversation_id: conversation_id,
        p_safe_reply_content: SAFE_HANDOFF_WORDING[classified.language],
        p_source_message_id: source_message_id,
      }),
  );
  if (!b2.committed) {
    return b2PreventedResponse(b2.decision, {
      escalation_rule: "R1",
      handoff_persisted: false,
    });
  }
  const { data, error } = b2.value;
  if (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: "esc_rpc_transport_error",
        escalation_rule: "R1",
        handoff_persisted: false,
        handoff_uncertain: true,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const result: string = data?.result ?? "unknown";
  switch (result) {
    case "success":
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(
        JSON.stringify({
          success: true,
          escalation_rule: "R1",
          response_route: "explicit_handoff",
          handoff_required: true,
          handoff_persisted: true,
          rpc_result: "success",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_handled":
      return new Response(
        JSON.stringify({
          success: true,
          escalation_rule: "R1",
          response_route: "explicit_handoff",
          handoff_required: true,
          handoff_persisted: true,
          rpc_result: "already_handled",
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_resolved":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "resolved",
          escalation_rule: "R1",
          handoff_persisted: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_under_human_control":
      return new Response(
        JSON.stringify({
          success: true,
          skipped: "human_handling",
          escalation_rule: "R1",
          handoff_persisted: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "not_found":
      return new Response(
        JSON.stringify({
          success: false,
          error: "esc_conversation_not_found",
          escalation_rule: "R1",
        }),
        {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    case "invalid_source_message":
      return new Response(
        JSON.stringify({
          success: false,
          error: "esc_invalid_source_message",
          escalation_rule: "R1",
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    default:
      return new Response(
        JSON.stringify({
          success: false,
          error: "esc_rpc_unknown_result",
          escalation_rule: "R1",
          rpc_result: result,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
  }
}

async function orchestrationGenerateReply(
  conversation_id: string,
  flags: FlagSet,
  source_message_id: string | null,
  requestSignal?: AbortSignal,
): Promise<Response> {
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    getSupabaseAdminKey(),
  );
  const { data: conversation, error: convError } = await supabaseAdmin.from(
    "conversations",
  ).select(
    "id, status, assigned_agent_id, created_at, company_id, metadata_source",
  ).eq("id", conversation_id).single();
  if (convError || !conversation) {
    return new Response(JSON.stringify({ error: "Conversation not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (conversation.status === "resolved" || conversation.status === "closed") {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return safeRefusal("CONV_RESOLVED_OR_CLOSED");
  }
  if (
    isHumanControlState(
      conversation.status,
      conversation.assigned_agent_id ?? null,
    )
  ) {
    console.log(
      "[generate-reply] orchestration human-handling guard:",
      conversation.status,
      conversation_id,
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: true, skipped: "human_handling" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  if (conversation.assigned_agent_id) {
    console.log(
      "[generate-reply] S-1 assigned_agent_id guard (orchestration):",
      conversation_id,
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: true, skipped: "assigned_to_agent" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const sourceResult = await loadSourceVisitorMessage(
    supabaseAdmin,
    conversation_id,
    source_message_id,
  );
  if (!sourceResult.ok) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return sourceMessageErrorResponse(sourceResult);
  }
  const sourceVisitorMessage = sourceResult.message;
  const _h1SourceMessageId = sourceVisitorMessage.id;
  const _h1LastMsg = sourceVisitorMessage.content;

  const _closureResponse = await handleConversationClosureIfNeeded(
    supabaseAdmin,
    conversation_id,
    source_message_id,
    _h1LastMsg,
  );
  if (_closureResponse) return _closureResponse;

  const [
    { data: _pr5HistoryRows },
    { count: _pr5VisitorTurnCount },
  ] = await Promise.all([
    supabaseAdmin
      .from("messages")
      .select("id, role, content, created_at, metadata")
      .eq("conversation_id", conversation_id)
      .eq("is_recalled", false)
      .neq("content", "__THINKING__")
      .or(sourceBoundaryFilter(sourceVisitorMessage))
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(50),
    supabaseAdmin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversation_id)
      .eq("role", "visitor")
      .eq("is_recalled", false)
      .neq("content", "__THINKING__")
      .or(sourceBoundaryFilter(sourceVisitorMessage)),
  ]);

  const _pr5History = deriveConversationHistorySignals(
    _pr5HistoryRows ?? [],
    _pr5VisitorTurnCount ?? 0,
  );
  const _priorGroundedTransform = resolvePriorGroundedTransform(
    _h1LastMsg,
    _pr5HistoryRows ?? [],
  );
  const _conversationContinuityBlock = buildCanonicalContinuityBlock(
    _pr5HistoryRows ?? [],
  );

  const _visitorLang = resolveWorkflow5ConversationLanguage(
    _h1LastMsg,
    _pr5HistoryRows ?? [],
  );
  const _explicitHandoffRequested = isHandoffIntent(_h1LastMsg);
  const _w5ShortTopicHint = _explicitHandoffRequested
    ? null
    : workflow5ShortTopicHint(_h1LastMsg);
  if (_w5ShortTopicHint === "membership tiers") {
    const topicalReply = _visitorLang === "en"
      ? "You’re asking about membership tiers. I don’t have enough confirmed published information to state the tier structure, inclusions, or limits, so I won’t guess."
      : _visitorLang === "zh-CN"
      ? "你问的是会员等级。目前没有足够已确认的已发布资料来确定会员等级的架构、包含内容或限制，所以我不会猜。"
      : "你問的是會員等級。目前未有足夠已確認的已發布資料去確定會員等級的架構、包含內容或限制，所以我唔會估。";
    const topicalCommit = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      topicalReply,
      {
        response_route: "workflow5_topical_recovery",
        escalation_action: "continue_ai",
        handoff_required: false,
        topic: _w5ShortTopicHint,
        factual_grounding_required: true,
        grounding_state: "published_evidence_unconfirmed",
      },
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (topicalCommit.ok) {
      return new Response(
        JSON.stringify({
          success: true,
          reply: topicalReply,
          response_route: "workflow5_topical_recovery",
          handoff_required: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      ["human_control", "resolved", "superseded_source"].includes(
        topicalCommit.result,
      )
    ) {
      return new Response(
        JSON.stringify({ success: true, skipped: topicalCommit.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `workflow5_topical_recovery_${topicalCommit.result}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  // P0 critical preflight: E2 must run before customer-context and generic clarification early returns.
  const _criticalE2ExpectedTenantId =
    typeof conversation.company_id === "string" &&
      conversation.company_id.length > 0
      ? conversation.company_id
      : undefined;
  const _criticalE2ThreatSignal = classifyAuthoritativeThreat(_h1LastMsg);
  if (isE2LiveActivationEnabled(Deno.env) && _criticalE2ThreatSignal) {
    const _criticalE2Response = await evaluateAndPersistRequiredRulesLive(
      supabaseAdmin,
      {
        conversation_id,
        source_message_id: _h1SourceMessageId,
        latest_message_content: _h1LastMsg,
        conversation_status: conversation.status,
        assigned_agent_id: conversation.assigned_agent_id ?? null,
        greeting_or_trivial: isGreetingOrTrivial(_h1LastMsg),
        visitor_language: _visitorLang,
        expected_tenant_id: _criticalE2ExpectedTenantId,
        turn_count: _pr5History.turn_count,
        consecutive_no_answer: _pr5History.consecutive_no_answer,
        clarification_attempts: _pr5History.clarification_attempts,
        exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
        threat_flag: _criticalE2ThreatSignal,
        compliance_jurisdiction_requires_human_review:
          resolveAuthoritativeComplianceReview(_criticalE2ExpectedTenantId),
      },
    );
    if (_criticalE2Response) return _criticalE2Response;
  }
  const _naturalCustomerIntent = classifyNaturalCustomerIntent(_h1LastMsg);
  const _productFollowUpArbitration = arbitrateAnaphoricProductFollowUp(
    _h1LastMsg,
    ((_pr5HistoryRows ?? []) as MemoryHistoryRow[]).map((row) => ({
      role: String(row.role ?? ""),
      content: String(row.content ?? ""),
      conversation_id,
      company_id: _criticalE2ExpectedTenantId ?? "",
    })),
    _criticalE2ExpectedTenantId ? { conversation_id, company_id: _criticalE2ExpectedTenantId } : undefined,
  );
  const _effectiveNaturalCustomerIntent: NaturalCustomerIntent =
    _productFollowUpArbitration.kind === "resolved" ||
      _productFollowUpArbitration.kind === "clarification"
      ? _productFollowUpArbitration.intent
      : _naturalCustomerIntent;
  // This query is server-derived from a recent explicit model. It affects
  // factual routing/retrieval/proof only; customer history remains unchanged.
  const _productFactualRequest = _productFollowUpArbitration.kind === "resolved"
    ? _productFollowUpArbitration.grounded_question
    : _h1LastMsg;
  const _naturalImmediateResponse = await persistNaturalImmediateResponse(
    supabaseAdmin,
    conversation_id,
    _h1SourceMessageId,
    _effectiveNaturalCustomerIntent,
    _visitorLang,
  );
  if (_naturalImmediateResponse) return _naturalImmediateResponse;
  // ===== TASK A3.1: multilingual universal semantic interpreter =====
  // LLM proposes a schema-constrained, language-neutral semantic frame only.
  // It never writes commerce state and never supplies external product/policy facts.
  let _a3SemanticFrame: CommerceSemanticFrame | null = null;
  if (
    _criticalE2ExpectedTenantId &&
    (!requiresCurrentMerchantEvidence(_effectiveNaturalCustomerIntent) ||
      (_productFollowUpArbitration.kind === "resolved" &&
        _productFollowUpArbitration.resolution_strategy === "PER_TOPIC_REFERENT_HISTORY" &&
        Boolean(_productFollowUpArbitration.resolved_topic)))
  ) {
    try {
      const semanticResult = await interpretCommerceSemantics({
        company_id: _criticalE2ExpectedTenantId,
        conversation_id,
        source_message_id: _h1SourceMessageId,
        latest: _h1LastMsg,
        history: (_pr5HistoryRows ?? []).map((row: MemoryHistoryRow) => ({
          role: String((row as { role?: unknown }).role ?? ""),
          content: String((row as { content?: unknown }).content ?? ""),
        })),
        signal: requestSignal,
      });
      _a3SemanticFrame = semanticResult.frame;
    } catch (error) {
      console.error(
        "[generate-reply] A3.1 semantic interpreter fallback",
        error instanceof Error ? error.name : "unknown_error",
      );
    }
  }

  // ===== TASK A3: persistent commerce state runtime =====
  // Runs AFTER the critical E2 safety branch and BEFORE CUSTOMER_CONTEXT_UPDATE,
  // generic clarification, conversation-memory shortcut and KB retrieval.
  let _a3Commerce: CommerceRuntimeOutcome | null = null;
  let _c3Memory: CanonicalConversationMemory | null = null;
  let _c3MemoryContext = "";
  let _c3CommerceSnapshot: RecallCommerceSnapshot | null = null;
  if (
    _criticalE2ExpectedTenantId &&
    (!requiresCurrentMerchantEvidence(_effectiveNaturalCustomerIntent) ||
      (_productFollowUpArbitration.kind === "resolved" &&
        _productFollowUpArbitration.resolution_strategy === "PER_TOPIC_REFERENT_HISTORY" &&
        Boolean(_productFollowUpArbitration.resolved_topic)))
  ) {
    try {
      _a3Commerce = await runCommerceStateRuntime(
        supabaseAdmin as unknown as CommerceStateDbClient,
        {
          conversation_id,
          company_id: _criticalE2ExpectedTenantId,
          source_message_id: _h1SourceMessageId,
          text: _h1LastMsg,
          language: _visitorLang === "en"
            ? "en"
            : _visitorLang === "zh-CN"
            ? "zh-CN"
            : "zh-TW",
          occurred_at: sourceVisitorMessage.created_at ?? null,
          history: (_pr5HistoryRows ?? []).map((row: MemoryHistoryRow) => ({
            role: String((row as { role?: unknown }).role ?? ""),
            content: String((row as { content?: unknown }).content ?? ""),
          })),
          semantic_frame: _a3SemanticFrame,
          trusted_product_topic_focus:
            _productFollowUpArbitration.kind === "resolved" &&
              _productFollowUpArbitration.resolution_strategy === "PER_TOPIC_REFERENT_HISTORY" &&
              _productFollowUpArbitration.resolved_topic
              ? {
                topic: _productFollowUpArbitration.resolved_topic,
                product: _productFollowUpArbitration.intent.product,
                resolution_strategy: "PER_TOPIC_REFERENT_HISTORY",
              }
              : null,
        },
      );
    } catch (commerceError) {
      console.error(
        "[generate-reply] A3 commerce state runtime failed (non-blocking):",
        commerceError,
      );
      _a3Commerce = null;
    }
  }
  const _c3PreMemoryResolution = resolveCanonicalCommerceResolution({
    outcome: _a3Commerce,
    authoritative_address_correction: false,
  });

  // ===== AI-ABC-C3: canonical bounded long-conversation memory =====
  // The source visitor turn is already durable and A3 has resolved canonical
  // commerce state. Memory is committed now so it cannot become commerce
  // authority and cannot bypass the existing B2 response-persistence gate.
  if (_criticalE2ExpectedTenantId) {
    try {
      const [{ data: persistedMemory }, { data: commerceRow }] = await Promise
        .all([
          supabaseAdmin.from("conversation_memory_state")
            .select("source_message_id")
            .eq("conversation_id", conversation_id)
            .eq("company_id", _criticalE2ExpectedTenantId)
            .maybeSingle(),
          supabaseAdmin.from("conversation_commerce_state")
            .select(
              "conversation_id,company_id,source_message_id,revision,state",
            )
            .eq("conversation_id", conversation_id)
            .eq("company_id", _criticalE2ExpectedTenantId)
            .maybeSingle(),
        ]);
      let memoryHistory = (_pr5HistoryRows ?? []) as MemoryHistoryRow[];
      if (!persistedMemory && (_pr5VisitorTurnCount ?? 0) > 50) {
        const { data: rebuildRows } = await supabaseAdmin.from("messages")
          .select("id,role,content,created_at,metadata")
          .eq("conversation_id", conversation_id)
          .eq("is_recalled", false)
          .neq("content", "__THINKING__")
          .or(sourceBoundaryFilter(sourceVisitorMessage))
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(500);
        memoryHistory = (rebuildRows ?? memoryHistory) as MemoryHistoryRow[];
      }
      const commerceState: ConversationCommerceState | null =
        isConversationCommerceState(commerceRow?.state)
          ? commerceRow.state
          : null;
      if (commerceState && commerceRow) {
        _c3CommerceSnapshot = {
          conversation_id: String(commerceRow.conversation_id),
          company_id: String(commerceRow.company_id),
          source_message_id: String(commerceRow.source_message_id ?? ""),
          revision: Number(commerceRow.revision),
          state: commerceState,
        };
      }
      const memoryOutcome = _c3PreMemoryResolution.skip_memory_refresh
        ? null
        : await refreshConversationLongMemory(
          supabaseAdmin as unknown as Parameters<
            typeof refreshConversationLongMemory
          >[0],
          {
            conversation_id,
            company_id: _criticalE2ExpectedTenantId,
            source_message_id: _h1SourceMessageId,
            source_created_at: String(
              sourceVisitorMessage.created_at ?? new Date().toISOString(),
            ),
            commerce_state_revision: commerceRow?.revision == null
              ? null
              : Number(commerceRow.revision),
            commerce_state: commerceState,
            pending_lifecycle_reply: _a3Commerce?.trusted_lifecycle_commit ?? null,
            newest_first: memoryHistory,
            visitor_turn_count: _pr5VisitorTurnCount ?? 0,
          },
        );
      if (memoryOutcome?.ok) {
        _c3Memory = memoryOutcome.memory;
        _c3MemoryContext = buildBoundedConversationContext(
          _c3Memory,
          (_pr5HistoryRows ?? []) as MemoryHistoryRow[],
        ).block;
      } else if (memoryOutcome) {
        console.warn("[generate-reply] C3 bounded memory degraded", {
          conversation_id,
          reason: memoryOutcome.reason,
        });
      }
    } catch (memoryError) {
      console.error(
        "[generate-reply] C3 memory refresh failed safely",
        memoryError instanceof Error ? memoryError.name : "unknown_error",
      );
    }
  }
  // C3 fact ownership routing: after E2/A3 and durable memory, before commerce
  // If Commerce and Memory already committed this exact source on a prior
  // attempt, reuse their bounded server-derived receipt. Never run a second
  // lifecycle mutation and never authorize against a newer revision.
  const _pendingLifecycle = _c3Memory?.pending_lifecycle_reply;
  const _resumableLifecycle = !_a3Commerce?.trusted_lifecycle_commit
    ? resumeCommittedLifecycleReply({
      conversation_id, company_id: _criticalE2ExpectedTenantId ?? "",
      source_message_id: _h1SourceMessageId, memory: _c3Memory,
      commerce: _c3CommerceSnapshot,
    })
    : null;
  if (_resumableLifecycle) {
    _a3Commerce = {
      authority: "CONVERSATION_STATE",
      reply: _resumableLifecycle.reply,
      revision: _resumableLifecycle.committed_revision,
      persist_result: "success",
      reason: "authoritative_scoped_lifecycle_applied",
      route: "commerce_state_answer",
      trusted_lifecycle_commit: _resumableLifecycle,
    };
  }
  if ((_pendingLifecycle && !_a3Commerce?.trusted_lifecycle_commit) ||
    (_c3CommerceSnapshot?.source_message_id === _h1SourceMessageId &&
      !_a3Commerce?.trusted_lifecycle_commit &&
      _a3Commerce?.reason === "ambiguous_lifecycle_target")) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({
      success: false,
      error: _pendingLifecycle
        ? "lifecycle_reply_stale_revalidate"
        : "lifecycle_reply_receipt_unavailable",
    }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  // C3 fact ownership routing: after E2/A3 and durable memory, before commerce
  // reply shortcuts, context clarification and current-KB/C1 resolution.
  const _c3Recall = prepareConversationRecall({
    conversation_id,
    company_id: _criticalE2ExpectedTenantId ?? "",
    source_message_id: _h1SourceMessageId,
    question: _productFactualRequest,
    memory: _c3Memory,
    commerce: _c3CommerceSnapshot,
    explicit_handoff: _explicitHandoffRequested,
    referents: _a3SemanticFrame?.referents ?? [],
    recent_questions: ((_pr5HistoryRows ?? []) as MemoryHistoryRow[])
      .filter((row) => row.role === "visitor" && row.id !== _h1SourceMessageId)
      .slice(0, 12).map((row) => String(row.content ?? "")),
  }, _visitorLang);
  const _c3RecentServiceMessages =
    ((_pr5HistoryRows ?? []) as MemoryHistoryRow[])
      .map((row) => ({
        role: typeof row.role === "string" ? row.role : "unknown",
        content: String(row.content ?? ""),
      }));
  const _c3TrustedCustomerContext = await fetchTrustedCustomerContext({
    conversation_id,
    company_id: _criticalE2ExpectedTenantId ?? "",
  });
  const _c3RuntimeInputs = deriveServiceRuntimeInputs({
    question: _productFactualRequest,
    recent_messages: _c3RecentServiceMessages,
    commerce: _c3CommerceSnapshot?.state ?? null,
    trusted_customer_context: _c3TrustedCustomerContext,
    expected_conversation_id: conversation_id,
    expected_company_id: _criticalE2ExpectedTenantId ?? "",
  });
  const _c3ServicePlan: ServiceDialoguePlan = planConversationService(
    applyServiceRuntimeDerivation({
      question: _productFactualRequest,
      language: _visitorLang,
      recall:
        requiresCurrentMerchantEvidence(_effectiveNaturalCustomerIntent) &&
          (_effectiveNaturalCustomerIntent.kind === "product_factual_query" ||
            !_c3Recall.decision.handled)
          ? {
            handled: false,
            reason: "CURRENT_KB_REQUIRED",
            detail:
              _effectiveNaturalCustomerIntent.kind === "product_factual_query"
                ? "EXACT_PRODUCT_FACT_QUERY"
                : "PRODUCT_AVAILABILITY_QUERY",
            requested_facts: [],
          }
          : _c3Recall.decision,
      memory: _c3Memory,
      commerce: _c3CommerceSnapshot?.state ?? null,
      recent_messages: _c3RecentServiceMessages,
      clarification_attempts: _pr5History.clarification_attempts,
      exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
      explicit_handoff: _explicitHandoffRequested,
    }, _c3RuntimeInputs),
  );
  const _c3ResolvedAddressCorrection = resolveCommittedAddressCorrection({
    text: _h1LastMsg,
    source_message_id: _h1SourceMessageId,
    language: _visitorLang === "en"
      ? "en"
      : _visitorLang === "zh-CN"
      ? "zh-CN"
      : "zh-TW",
    memory: _c3Memory,
    commerce: _c3CommerceSnapshot,
  });
  const _c3CorrectionReceipt = _a3Commerce?.trusted_correction_commit ?? null;
  const _c3VerifiedCorrectionReceipt = _c3CorrectionReceipt &&
      verifyCommittedRoomCorrectionMemory({
        memory: _c3Memory,
        receipt: _c3CorrectionReceipt,
        commerce: _c3CommerceSnapshot,
      })
    ? _c3CorrectionReceipt : null;
  if (_c3CorrectionReceipt && !_c3VerifiedCorrectionReceipt) {
    return new Response(
      JSON.stringify({ success: false, error: "correction_memory_commerce_mismatch" }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const _c3LifecycleReceipt = _a3Commerce?.trusted_lifecycle_commit ?? null;
  if (_c3LifecycleReceipt && !verifyCommittedLifecycleMemory({
    memory: _c3Memory, receipt: _c3LifecycleReceipt, commerce: _c3CommerceSnapshot,
  })) {
    return new Response(JSON.stringify({ success: false, error: "lifecycle_memory_commerce_mismatch" }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  const _c3Resolution = resolveCanonicalCommerceResolution({
    outcome: _a3Commerce,
    authoritative_address_correction: Boolean(_c3ResolvedAddressCorrection),
  });
  const _naturalGuidanceReply = _effectiveNaturalCustomerIntent.kind ===
      "product_guidance"
    ? renderNaturalImmediateResponse(
      _effectiveNaturalCustomerIntent,
      _visitorLang,
    )
    : null;
  const _c3PlannedReply = _c3Resolution.bypass_service_plan
    ? null
    : _naturalGuidanceReply ?? applyServiceTone(
      _c3ServicePlan,
      renderServicePlanReply(
        _c3ServicePlan,
        _c3Recall.reply,
        _c3RecentServiceMessages,
      ) ??
        ([
            "targeted_clarification",
            "partial_answer_then_question",
            "offer_handoff_or_reframe",
            "explicit_handoff",
          ].includes(_c3ServicePlan.action)
          ? renderTargetedServiceQuestion(_c3ServicePlan, _visitorLang)
          : null),
    );
  // A service plan may describe an explicit handoff, but it is not authorized
  // to persist one. Let R1 continue to the existing B2-supervised
  // explicit_handoff_tx path instead of committing a clarification-shaped AI
  // reply that leaves the conversation under AI control.
  if (_c3PlannedReply && !_explicitHandoffRequested) {
    const serviceMetadata = {
      ..._c3Recall.metadata,
      response_route: _naturalGuidanceReply
        ? "product_guidance"
        : _c3ServicePlan.action === "historical_calculation"
        ? "c3_historical_conditional_calculation"
        : _c3ServicePlan.action === "shorten_previous_answer"
        ? "c3_grounded_shorten"
        : _c3ServicePlan.action === "current_state_checklist"
        ? "c3_current_state_checklist"
        : _c3Recall.metadata.response_route,
      service_plan_version: _c3ServicePlan.version,
      service_action: _c3ServicePlan.action,
      missing_slots: _c3ServicePlan.missing_slots,
      clarification_target: _c3ServicePlan.clarification_target,
      clarification_previously_asked:
        _c3ServicePlan.clarification_previously_asked,
      knowledge_state: _c3ServicePlan.knowledge_state,
      safe_assumptions: _c3ServicePlan.safe_assumptions,
      emotion_trace: _c3ServicePlan.emotion_trace ?? null,
      entitlement_status: _c3ServicePlan.entitlement_status,
      entitlement_trace: _c3ServicePlan.entitlement_trace ?? null,
      service_runtime_version: _c3RuntimeInputs.version,
      calculation_input_status: _c3RuntimeInputs.calculation_status,
      natural_response_contract: _naturalGuidanceReply
        ? "c3-natural-customer-response-v2"
        : undefined,
      natural_intent: _naturalGuidanceReply
        ? _effectiveNaturalCustomerIntent.kind
        : undefined,
    };
    const recallCommit = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      _h1SourceMessageId,
      _c3PlannedReply,
      serviceMetadata,
    );
    await cleanupThinking(supabaseAdmin, conversation_id, _h1SourceMessageId);
    if (recallCommit.ok) {
      return new Response(
        JSON.stringify({
          success: true,
          reply: _c3PlannedReply,
          response_route: serviceMetadata.response_route,
          recall_authority: _c3Recall.metadata.recall_authority,
          recall_fact_type: _c3Recall.metadata.recall_fact_type,
          service_action: _c3ServicePlan.action,
          handoff_required: false,
          idempotent: recallCommit.idempotent,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      [
        "human_control",
        "resolved",
        "superseded_source",
        "source_already_replied",
      ].includes(recallCommit.result)
    ) {
      return new Response(
        JSON.stringify({ success: true, skipped: recallCommit.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `conversation_memory_commit_${recallCommit.result}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  const _c3CommerceReply = _c3ResolvedAddressCorrection?.reply ??
    (_a3Commerce?.reason === "explicit_address_correction_applied"
      ? null
      : _a3Commerce?.reply ?? null);
  if (_c3CommerceReply && !_explicitHandoffRequested) {
    const commerceReply = _a3Commerce?.reason ===
        "previous_quote_not_authoritative_for_current_price"
      ? historicalQuoteValidityReply(_visitorLang)
      : _c3CommerceReply;
    const commerceRoute = _c3ResolvedAddressCorrection
      ? "commerce_state_answer"
      : _a3Commerce!.route;
    const commerceAuthority = _c3ResolvedAddressCorrection
      ? "CONVERSATION_STATE"
      : _a3Commerce!.authority;
    const commerceRevision = _c3ResolvedAddressCorrection
      ? _c3CommerceSnapshot!.revision
      : _a3Commerce!.revision;
    const commercePersistResult = _c3ResolvedAddressCorrection
      ? "authoritative_post_commit_readback"
      : _a3Commerce!.persist_result;
    const commercePersistenceClassification =
      classifyCommerceStatePersistenceResult(commercePersistResult);
    const commerceReason = _c3ResolvedAddressCorrection?.reason ??
      _a3Commerce!.reason;
    const commerceCommit = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      commerceReply,
      {
        response_route: commerceRoute,
        escalation_action: "continue_ai",
        handoff_required: false,
        commerce_authority: commerceAuthority,
        commerce_state_revision: commerceRevision,
        commerce_state_persist_result: commercePersistResult,
        commerce_state_persistence_classification:
          commercePersistenceClassification,
        commerce_reason: commerceReason,
        contextual_decision: _a3Commerce?.contextual_decision ?? null,
        commerce_state_path: _a3Commerce?.state_path ?? null,
        commerce_state_readback_proof: _c3CommerceSnapshot &&
            _a3Commerce?.state_path
          ? buildB2AuthoritativeReadbackProof(
            _c3CommerceSnapshot.state,
            _a3Commerce.state_path,
          )
          : null,
        commerce_calculation: _a3Commerce?.calculation ?? null,
        correction_resolution: _c3ResolvedAddressCorrection?.status ?? null,
        correction_operation: _c3ResolvedAddressCorrection?.operation ?? null,
        correction_source_message_id:
          _c3ResolvedAddressCorrection?.source_message_id ?? null,
      },
      null,
      _a3Commerce?.reason === "contextual_targeted_clarification" &&
        _a3Commerce.persist_result === "read_only" &&
        _a3Commerce.contextual_decision
        ? {
          reply: _a3Commerce.reply ?? "",
          revision: _a3Commerce.revision,
          contextual_decision: _a3Commerce.contextual_decision,
        }
        : null,
      _a3Commerce?.trusted_journey_progress ?? null,
      _c3VerifiedCorrectionReceipt,
      _c3LifecycleReceipt,
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (commerceCommit.ok) {
      return new Response(
        JSON.stringify({
          success: true,
          reply: commerceReply,
          response_route: commerceRoute,
          commerce_authority: commerceAuthority,
          commerce_state_revision: commerceRevision,
          handoff_required: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      ["human_control", "resolved", "superseded_source"].includes(
        commerceCommit.result,
      )
    ) {
      return new Response(
        JSON.stringify({ success: true, skipped: commerceCommit.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `commerce_state_runtime_${commerceCommit.result}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  const _criticalLocalRisk = classifyLocalTopicRisk(_h1LastMsg);
  const _canonicalTurn = classifyCanonicalConversationTurn(
    _h1LastMsg,
    _pr5HistoryRows ?? [],
    { explicit_handoff: isHandoffIntent(_h1LastMsg) },
  );
  if (
    _canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE" &&
    !requiresCurrentMerchantEvidence(_effectiveNaturalCustomerIntent)
  ) {
    const acknowledgement =
      _canonicalTurn.reason === "customer_context_requirements_request"
        ? buildCustomerContextRequirementsResponse(
          _canonicalTurn.language,
          _pr5HistoryRows ?? [],
        )
        : buildCustomerContextAcknowledgement(_canonicalTurn.language);
    const contextCommit = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      acknowledgement,
      {
        response_route: "customer_context_update",
        escalation_action: "continue_ai",
        handoff_required: false,
        reason_code: _canonicalTurn.reason,
      },
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (contextCommit.ok) {
      return new Response(
        JSON.stringify({
          success: true,
          reply: acknowledgement,
          response_route: "customer_context_update",
          handoff_required: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      ["human_control", "resolved", "superseded_source"].includes(
        contextCommit.result,
      )
    ) {
      return new Response(
        JSON.stringify({ success: true, skipped: contextCommit.result }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `context_update_commit_${contextCommit.result}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  const _turnClassification = classifyConversationTurn(_h1LastMsg);
  if (
    !_w5ShortTopicHint &&
    !requiresCurrentMerchantEvidence(_effectiveNaturalCustomerIntent) &&
    _turnClassification.should_clarify_before_kb &&
    !isHandoffIntent(_h1LastMsg) && _criticalLocalRisk?.level !== "high"
  ) {
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
      return new Response(
        JSON.stringify({
          success: true,
          reply: clarification,
          response_route: "conversational_clarification",
          handoff_required: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (
      ["human_control", "resolved", "superseded_source"].includes(
        clarificationCommit.result,
      )
    ) {
      return new Response(
        JSON.stringify({ success: true, skipped: clarificationCommit.result }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `clarification_commit_${clarificationCommit.result}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  const _pr5ExpectedTenantId = typeof conversation.company_id === "string" &&
      conversation.company_id.length > 0
    ? conversation.company_id
    : undefined;
  const _widgetLiveTestActor = _pr5ExpectedTenantId === undefined
    ? widgetLiveTestPreActivationActor(conversation.metadata_source)
    : undefined;
  const _pr5ThreatSignal = classifyAuthoritativeThreat(_h1LastMsg);
  const _pr5ComplianceSignal = resolveAuthoritativeComplianceReview(
    _pr5ExpectedTenantId,
  );
  const _pr5LocalRisk = classifyLocalTopicRisk(_h1LastMsg);
  const _pr5HistoricalR3Sentiment = await loadAuthoritativeR3SentimentSignals(
    supabaseAdmin,
    conversation_id,
    _pr5ExpectedTenantId,
  );
  const _pr5R3Sentiment = buildRealtimeR3SentimentSignals(
    _h1LastMsg,
    _pr5HistoricalR3Sentiment,
  );
  const _pr5ConversationDurationSec = conversation.created_at
    ? Math.max(
      0,
      Math.floor(
        (Date.now() - new Date(conversation.created_at).getTime()) / 1000,
      ),
    )
    : undefined;
  const _pr5VerifiedTenantConfig = buildVerifiedTenantEscalationConfig();

  const _pr5GreetingOrTrivial = isGreetingOrTrivial(_h1LastMsg);

  const _pr5Shadow = evaluateEscalationShadow(
    {
      conversation_id,
      source_message_id,
      latest_message_content: _h1LastMsg,
      conversation_status: conversation.status,
      assigned_agent_id: conversation.assigned_agent_id ?? null,
      explicit_request: isHandoffIntent(_h1LastMsg),
      greeting_or_trivial: _pr5GreetingOrTrivial,
      expected_tenant_id: _pr5ExpectedTenantId,
      threat_flag: _pr5ThreatSignal,
      compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal,
      anger_flag: _pr5R3Sentiment?.anger_flag,
      sentiment_score: _pr5R3Sentiment?.sentiment_score,
      sentiment_trend: _pr5R3Sentiment?.sentiment_trend,
      sentiment_recovered_same_turn: _pr5R3Sentiment
        ?.sentiment_recovered_same_turn,
      sentiment_provider_version: _pr5R3Sentiment?.provider_version,
      sentiment_evaluation_id: _pr5R3Sentiment?.evaluation_id,
      conversation_duration_sec: _pr5ConversationDurationSec,
      tenant_config: _pr5VerifiedTenantConfig,
    },
    Deno.env,
  );

  if (_pr5Shadow) {
    console.log("[generate-reply] PR-5 escalation shadow:", {
      conversation_id,
      matched_rule: _pr5Shadow.matched_rule,
      decision: _pr5Shadow.decision,
      reason_code: _pr5Shadow.reason_code,
      signal_gaps: _pr5Shadow.signal_gaps,
      provider_warnings: _pr5Shadow.provider_warnings,
    });
  }

  if (isE2LiveActivationEnabled(Deno.env)) {
    const _pr5E2PreflightResponse = await evaluateAndPersistRequiredRulesLive(
      supabaseAdmin,
      {
        conversation_id,
        source_message_id,
        latest_message_content: _h1LastMsg,
        conversation_status: conversation.status,
        assigned_agent_id: conversation.assigned_agent_id ?? null,
        greeting_or_trivial: _pr5GreetingOrTrivial,
        visitor_language: _visitorLang,
        expected_tenant_id: _pr5ExpectedTenantId,
        turn_count: _pr5History.turn_count,
        consecutive_no_answer: _pr5History.consecutive_no_answer,
        clarification_attempts: _pr5History.clarification_attempts,
        exact_same_intent_repeated: _pr5History.exact_same_intent_repeated,
        threat_flag: _pr5ThreatSignal,
        compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal,
      },
    );
    if (_pr5E2PreflightResponse) return _pr5E2PreflightResponse;
  }

  const _deferR1ForE1 = isE1LiveActivationEnabled(Deno.env) &&
    _pr5LocalRisk?.level === "high" &&
    flags.ENABLE_KB &&
    !_pr5GreetingOrTrivial;

  let _hf1CustomerContext: {
    masked_summary?: string;
    tier?: string;
    predicted_csat?: number;
    churn_risk?: number;
    escalation_score?: number;
    p1_provider_version?: string;
  } | null = null;
  let _hf1OpaqueCustomerRef: string | null = null;
  const _hf1ExplicitClassification = classifyExplicitHandoff(_h1LastMsg);
  if (
    !_deferR1ForE1 && flags.ENABLE_C360 &&
    _hf1ExplicitClassification.rule === "R1"
  ) {
    const c360 = await callCustomer360Adapter(conversation_id);
    if (c360.success && c360.customer_context) {
      _hf1CustomerContext = c360.customer_context;
      _hf1OpaqueCustomerRef = c360.customer_ref ?? null;
    }
  }

  if (!_deferR1ForE1) {
    const r1Response = await persistExplicitR1IfRequested(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      _h1LastMsg,
      {
        anger_level: _pr5R3Sentiment?.anger_flag === true ? "high" : null,
        sentiment_trend: _pr5R3Sentiment?.sentiment_trend ?? null,
        unresolved_turns: _pr5History.consecutive_no_answer,
        same_intent_repeat: _pr5History.exact_same_intent_repeated === true,
        prior_clarification_count: _pr5History.clarification_attempts,
        vip_tier: _hf1CustomerContext?.tier ?? null,
        high_value_customer: null,
        predicted_csat: _hf1CustomerContext?.predicted_csat ?? null,
        churn_risk: _hf1CustomerContext?.churn_risk ?? null,
        policy_risk: (_pr5ComplianceSignal?.value === true ||
            _pr5LocalRisk?.level === "high")
          ? "high"
          : "standard",
        threat_flag: _pr5ThreatSignal?.value === true,
        rag_state: null,
        current_intent: _canonicalTurn.operation,
      },
    );
    if (r1Response) return r1Response;
  }

  // Asking about human-support availability/contact is informational, not an
  // explicit R1 request. Keep AI control and answer deterministically rather
  // than routing the question through KB/LLM grounding, where absence of an
  // authoritative schedule could incorrectly become S0.
  const _humanSupportIntent = classifyHandoffIntent(_h1LastMsg);
  if (_humanSupportIntent.kind === "question_about_human_support") {
    const infoReply = HUMAN_SUPPORT_INFO_WORDING[_humanSupportIntent.language];
    const committed = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      infoReply,
      {
        response_route: "human_support_information",
        handoff_required: false,
        escalation_rule: null,
        handoff_intent_kind: _humanSupportIntent.kind,
      },
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (!committed.ok) {
      if (
        committed.result === "human_control" ||
        committed.result === "resolved" ||
        committed.result === "superseded_source"
      ) {
        return new Response(
          JSON.stringify({ success: true, skipped: committed.result }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: `human_support_info_commit_${committed.result}`,
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        response_route: "human_support_information",
        handoff_required: false,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Pure positive-recovery acknowledgements are non-factual and must not enter KB/LLM grounding.
  const _positiveRecoveryAcknowledgement =
    _pr5R3Sentiment?.emotion_kind === "positive_recovery"
      ? resolvePositiveRecoveryAcknowledgement(_h1LastMsg, _visitorLang)
      : null;
  if (
    _positiveRecoveryAcknowledgement &&
    !requiresCurrentMerchantEvidence(_effectiveNaturalCustomerIntent)
  ) {
    const committed = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      _positiveRecoveryAcknowledgement,
      {
        response_route: "positive_recovery_acknowledgement",
        handoff_required: false,
        factual_grounding_required: false,
      },
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (!committed.ok) {
      if (
        committed.result === "human_control" ||
        committed.result === "resolved" ||
        committed.result === "superseded_source"
      ) {
        return new Response(
          JSON.stringify({ success: true, skipped: committed.result }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: `positive_recovery_commit_${committed.result}`,
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        response_route: "positive_recovery_acknowledgement",
        handoff_required: false,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const _conversationMemoryReply =
    !requiresCurrentMerchantEvidence(_effectiveNaturalCustomerIntent) &&
      !_c3Recall.decision.handled &&
      _c3Recall.decision.reason === "NOT_A_RECALL_QUERY" &&
      _c3Recall.decision.detail !== "HANDOFF_PRECEDENCE"
      ? resolveConversationMemoryResponse(_h1LastMsg, _pr5HistoryRows ?? [])
      : null;
  if (_conversationMemoryReply) {
    const committed = await commitAiReplyWithControlGate(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      _conversationMemoryReply,
      { response_route: "conversation_memory", conversation_grounded: true },
    );
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (!committed.ok) {
      if (
        committed.result === "human_control" ||
        committed.result === "resolved" ||
        committed.result === "superseded_source"
      ) {
        return new Response(
          JSON.stringify({ success: true, skipped: committed.result }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          success: false,
          error: `conversation_memory_commit_${committed.result}`,
        }),
        {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        response_route: "conversation_memory",
        conversation_grounded: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // A verified transform reuses the immutable evidence authority of the prior
  // grounded answer. It must not perform a second/current KB retrieval because
  // that can select different evidence and falsely reject a faithful transform.
  const _g1SkipKB = _pr5GreetingOrTrivial || Boolean(_priorGroundedTransform);

  let _pr5RagMatchState: RagMatchState | undefined;
  const _escEnableS0 = Deno.env.get("ESC_ENABLE_S0") !== "false";

  let basePrompt = MINIMAL_SAFE_FALLBACK_PROMPT;
  let coachTrace: {
    version_id?: string;
    version_label?: string;
    prompt_hash?: string;
    source: "upstream" | "minimal_fallback";
  } = { source: "minimal_fallback" };

  if (flags.ENABLE_COACH && !_priorGroundedTransform) {
    const promptResult = await callCoachPromptAdapter(conversation_id);

    if (!promptResult.success || !promptResult.content) {
      console.error("[generate-reply] COACH_PROMPT_REQUIRED_UNAVAILABLE", {
        conversation_id,
        error_type: promptResult.error_type ?? "COACH_UNKNOWN_FAILURE",
      });

      await cleanupThinking(
        supabaseAdmin,
        conversation_id,
        source_message_id,
      );

      return new Response(
        JSON.stringify({
          success: false,
          error: "coach_prompt_required_unavailable",
          error_type: promptResult.error_type ?? "COACH_UNKNOWN_FAILURE",
          retryable: promptResult.error_type === "COACH_API_TIMEOUT" ||
            promptResult.error_type === "COACH_API_ERROR" ||
            promptResult.error_type === "COACH_API_EXCEPTION",
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    basePrompt = promptResult.content;
    coachTrace = {
      version_id: promptResult.version_id,
      version_label: promptResult.version_label,
      prompt_hash: promptResult.prompt_hash,
      source: "upstream",
    };
  }

  let customerContext: {
    masked_summary?: string;
    tier?: string;
    predicted_csat?: number;
    churn_risk?: number;
    escalation_score?: number;
    p1_provider_version?: string;
  } | null = _hf1CustomerContext;
  let opaqueCustomerRef: string | null = _hf1OpaqueCustomerRef;
  if (flags.ENABLE_C360 && customerContext === null) {
    const c360Result = await callCustomer360Adapter(conversation_id);
    if (c360Result.success && c360Result.customer_context) {
      customerContext = c360Result.customer_context;
      opaqueCustomerRef = c360Result.customer_ref ?? null;
    }
  }

  const _pr5P1Input: P1PredictionInput | undefined =
    customerContext?.p1_provider_version
      ? {
        predicted_csat: customerContext.predicted_csat,
        churn_risk: customerContext.churn_risk,
        escalation_score: customerContext.escalation_score,
        provider_version: customerContext.p1_provider_version,
        provider_source: "customer360",
      }
      : undefined;
  const _pr5P1Signals = validateP1PredictionSignals(_pr5P1Input);

  let finalPromptChunks: KBFullChunk[] = [];
  let _canonicalKbDirectAnswer: CanonicalKbDirectAnswer | null = null;
  let _canonicalKbTenantId: string | null = null;
  let _c1AuthorityDecision: ReferenceAuthorityDecision | null = null;
  let _c1CurrentTarget: CurrentGroundingTarget | null = null;
  let _kbDone = false;
  let ragResult: {
    success: boolean;
    no_answer?: boolean;
    retrieval_quality?: "high" | "medium" | "low" | "failed";
    chunks?: Array<{
      document_id?: string;
      doc_id?: string;
      chunk_id?: string;
      title?: string;
      content?: string;
      score?: number;
      chunk_type?: string;
      industry?: string;
      company_id?: number;
      language?: string;
      status?: string;
      source_type?: string;
      published_at?: string;
      updated_at?: string;
    }>;
    documents?: KBDocumentCandidate[];
    llm_context?: {
      selected_document_id: string;
      orientation_summary: string | null;
      full_content_evidence: Array<{
        document_id: string;
        chunk_id?: string;
        content: string;
        score: number;
        source_type: string;
      }>;
    };
    meta?: {
      document_score: number;
      highest_chunk_score: number;
      second_highest_chunk_score: number;
      returned_summary_count: number;
      returned_full_content_count: number;
      dropped_without_document_id: number;
      dropped_without_content: number;
    };
    query_text_preview?: string;
    trace_metadata?: Record<string, unknown>;
  } | null = null;

  const _boundedNoCurrentEvidenceDecision = classifyCurrentFactEvidence({
    knowledge_state: _c3ServicePlan.knowledge_state,
    current_evidence_count: 0,
  });
  const _canPersistBoundedNoCurrentEvidence = canAnswerBoundedNoCurrentEvidence(
    {
      decision: _boundedNoCurrentEvidenceDecision,
      high_risk: _pr5LocalRisk?.level === "high",
      explicit_human_request: isHandoffIntent(_h1LastMsg),
      threat: _pr5ThreatSignal?.value === true,
      compliance_requires_human_review: _pr5ComplianceSignal?.value === true,
    },
  );

  if (flags.ENABLE_KB && !_g1SkipKB) {
    const _kbTenantResult = await resolveTenantScope(
      conversation_id,
      _widgetLiveTestActor,
      conversation.company_id,
    );
    if (!_kbTenantResult.resolved) {
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _h1LastMsg,
        );
        if (r1Response) return r1Response;
      }
      if (_escEnableS0) {
        return await handleS0Handoff(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          "KB_SCOPE_GATE",
          _visitorLang,
        );
      }
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        "KB_SCOPE_GATE",
        source_message_id,
        { rag_api_status: "scope_unavailable" },
        _visitorLang,
      );
    }
    const _semanticRetrieval = buildCanonicalRetrievalQuery(
      _productFactualRequest,
      _pr5HistoryRows ?? [],
    );
    const _productKbContract = productKbSemanticContract(
      _effectiveNaturalCustomerIntent,
      _productFollowUpArbitration.kind === "resolved"
        ? _productFollowUpArbitration.resolved_topic
        : null,
      _h1LastMsg,
    );
    const userQuery = _productKbContract?.query || _c3ServicePlan.kb_query || _semanticRetrieval.query;
    ragResult = !userQuery
      ? {
        success: true,
        no_answer: true,
        retrieval_quality: "failed",
        chunks: [],
      }
      : await callKBAdapter(
        conversation_id,
        userQuery,
        _kbTenantResult.scope,
        requestSignal,
      );
    if (!ragResult || !ragResult.success) {
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _h1LastMsg,
        );
        if (r1Response) return r1Response;
      }
      if (_escEnableS0) {
        return await handleS0Handoff(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          "KB_API_FAIL",
          _visitorLang,
        );
      }
      return await persistC3ServiceRecovery(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        _c3ServicePlan,
        "tool_failure",
        _visitorLang,
        { rag_api_status: "failure" },
      );
    }
    if (
      ragResult.no_answer || !ragResult.chunks || ragResult.chunks.length === 0
    ) {
      _pr5RagMatchState = "no_match";
      const requiredResponse = await evaluateAndPersistRequiredRulesLive(
        supabaseAdmin,
        {
          conversation_id,
          source_message_id,
          latest_message_content: _h1LastMsg,
          conversation_status: conversation.status,
          assigned_agent_id: conversation.assigned_agent_id ?? null,
          greeting_or_trivial: _pr5GreetingOrTrivial,
          visitor_language: _visitorLang,
          expected_tenant_id: _pr5ExpectedTenantId,
          warm_handoff_question: buildMissingFactsQuestion(
            buildWarmHandoffPackage(_pr5HistoryRows ?? [], "R2"),
            _visitorLang,
          ) ?? undefined,
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
          suppress_r2_for_bounded_no_current_evidence:
            _canPersistBoundedNoCurrentEvidence,
        },
      );
      if (requiredResponse) return requiredResponse;
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _h1LastMsg,
        );
        if (r1Response) return r1Response;
      }
      if (_canPersistBoundedNoCurrentEvidence) {
        return await persistBoundedNoCurrentEvidence(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _c3ServicePlan,
          _visitorLang,
          {
            rag_api_status: "success_empty",
            evidence_decision: _boundedNoCurrentEvidenceDecision.kind,
          },
          _effectiveNaturalCustomerIntent,
        );
      }
      const clarification = await attemptFirstNoMatchClarification(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        "KB_EMPTY",
        _visitorLang,
        {
          high_risk: _pr5LocalRisk?.level === "high",
          explicit_human_request: isHandoffIntent(_h1LastMsg),
          threat_flag: _pr5ThreatSignal?.value === true,
          compliance_requires_human_review:
            _pr5ComplianceSignal?.value === true,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated:
            _pr5History.exact_same_intent_repeated === true,
        },
        _c3ServicePlan,
        { rag_api_status: "success_empty" },
      );
      if (clarification) return clarification;
      return await persistC3ServiceRecovery(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        _c3ServicePlan,
        "no_match",
        _visitorLang,
        { rag_api_status: "success_empty" },
      );
    }

    const isHighRisk = _pr5LocalRisk?.level === "high";
    const minScore = isHighRisk ? 0.78 : 0.45;
    const _semanticEntityIds = (_a3SemanticFrame?.entities ?? [])
      .flatMap((entity) => [
        entity.entity_ref,
        entity.name,
        entity.sku,
        entity.model,
        entity.category_hint,
      ])
      .filter((value): value is string =>
        typeof value === "string" && value.trim().length > 0
      );
    const _semanticTopicIds = [
      _a3SemanticFrame?.topic,
      ...(_a3SemanticFrame?.requested_facts ?? []),
    ].filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    );
    const _c1TargetChanged = _canonicalTurn.topic_action === "SWITCH" ||
      _canonicalTurn.topic_action === "CORRECT" ||
      _a3SemanticFrame?.customer_correction === true;
    _c1CurrentTarget = deriveCurrentGroundingTarget(
      _productFactualRequest,
      userQuery,
      _productKbContract?.entity_ids ?? _semanticEntityIds,
      _productKbContract?.topic_ids ?? _semanticTopicIds,
      _c1TargetChanged,
    );
    const _groundingSelection = selectCanonicalGrounding(
      ragResult.documents ?? [],
      {
        minScore,
        requirePublished: true,
        requestText: userQuery,
        currentTurnText: _h1LastMsg,
        expectedTenantId: _kbTenantResult.scope.singaporeTenantId,
        expectedEntityIds: _c1CurrentTarget.entity_ids,
        expectedTopicIds: _c1CurrentTarget.topic_ids,
        expectedRegion: _c1CurrentTarget.region,
        requiresCurrentKb: true,
        targetChanged: _c1CurrentTarget.target_changed,
      },
    );
    _c1AuthorityDecision = _groundingSelection.ok
      ? _groundingSelection.authority_decision
      : null;
    const _scoreUsableChunks = _groundingSelection.ok
      ? _groundingSelection.chunks
      : [];
    const _explicitJurisdiction = extractExplicitJurisdictionConstraint(
      _h1LastMsg,
    );
    const _jurisdictionSupported = evidenceSupportsJurisdiction(
      _explicitJurisdiction,
      _scoreUsableChunks,
    );
    const usableChunks = _jurisdictionSupported ? _scoreUsableChunks : [];
    const traceMetadata = {
      rag_api_status: "success",
      total_results: ragResult.chunks.length,
      filtered_results: usableChunks.length,
      jurisdiction_constraint: _explicitJurisdiction,
      jurisdiction_supported: _jurisdictionSupported,
      min_score_used: usableChunks.length > 0
        ? Math.min(...usableChunks.map((c) => c.score ?? 0))
        : null,
      max_score_used: usableChunks.length > 0
        ? Math.max(...usableChunks.map((c) => c.score ?? 0))
        : null,
      high_risk_topic: isHighRisk,
      min_threshold: minScore,
      reference_authority: _c1AuthorityDecision
        ? referenceAuthorityMetadata(_c1AuthorityDecision)
        : null,
      citations: usableChunks.map((c) => ({
        doc_id: c.doc_id,
        chunk_id: c.chunk_id,
        title: c.title,
        score: c.score,
        source_type: c.source_type,
      })),
    };
    ragResult.trace_metadata = traceMetadata;
    if (usableChunks.length === 0) {
      _pr5RagMatchState = _c1AuthorityDecision?.decision ===
          "CONFLICT_UNRESOLVED"
        ? "conflict"
        : "partial_match";
      const boundedNoEvidenceWithoutConflict =
        _canPersistBoundedNoCurrentEvidence &&
        _c1AuthorityDecision?.decision !== "CONFLICT_UNRESOLVED";
      const requiredResponse = await evaluateAndPersistRequiredRulesLive(
        supabaseAdmin,
        {
          conversation_id,
          source_message_id,
          latest_message_content: _h1LastMsg,
          conversation_status: conversation.status,
          assigned_agent_id: conversation.assigned_agent_id ?? null,
          greeting_or_trivial: _pr5GreetingOrTrivial,
          visitor_language: _visitorLang,
          expected_tenant_id: _pr5ExpectedTenantId,
          warm_handoff_question: buildMissingFactsQuestion(
            buildWarmHandoffPackage(_pr5HistoryRows ?? [], "R2"),
            _visitorLang,
          ) ?? undefined,
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
          suppress_r2_for_bounded_no_current_evidence:
            boundedNoEvidenceWithoutConflict,
        },
      );
      if (requiredResponse) return requiredResponse;
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _h1LastMsg,
        );
        if (r1Response) return r1Response;
      }
      if (boundedNoEvidenceWithoutConflict) {
        return await persistBoundedNoCurrentEvidence(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _c3ServicePlan,
          _visitorLang,
          {
            ...traceMetadata,
            evidence_decision: _boundedNoCurrentEvidenceDecision.kind,
          },
          _effectiveNaturalCustomerIntent,
        );
      }
      if (_c1AuthorityDecision?.decision === "CONFLICT_UNRESOLVED") {
        const conflictReply = C1_AUTHORITY_CONFLICT_WORDING[_visitorLang] ??
          C1_AUTHORITY_CONFLICT_WORDING.en;
        const committed = await commitAiReplyWithControlGate(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          conflictReply,
          {
            response_route: "c1_authority_conflict_clarification",
            handoff_required: false,
            factual_grounding_required: true,
            grounding_state: "authority_conflict_unresolved",
            reference_authority: referenceAuthorityMetadata(
              _c1AuthorityDecision,
            ),
            current_grounding_target: _c1CurrentTarget,
          },
        );
        await cleanupThinking(
          supabaseAdmin,
          conversation_id,
          source_message_id,
        );
        if (!committed.ok) {
          if (
            ["human_control", "resolved", "superseded_source"].includes(
              committed.result,
            )
          ) {
            return new Response(
              JSON.stringify({ success: true, skipped: committed.result }),
              {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }
          return new Response(
            JSON.stringify({
              success: false,
              error: `c1_authority_conflict_commit_${committed.result}`,
            }),
            {
              status: 409,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            },
          );
        }
        return new Response(
          JSON.stringify({
            success: true,
            response_route: "c1_authority_conflict_clarification",
            handoff_required: false,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
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
          compliance_requires_human_review:
            _pr5ComplianceSignal?.value === true,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated:
            _pr5History.exact_same_intent_repeated === true,
        },
        _c3ServicePlan,
        traceMetadata,
      );
      if (clarification) return clarification;
      if (!isHighRisk) {
        return await persistC3ServiceRecovery(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _c3ServicePlan,
          "no_match",
          _visitorLang,
          traceMetadata,
        );
      }
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        isHighRisk ? "KB_LOW_SCORE_HIGH_RISK" : "KB_LOW_SCORE_STANDARD",
        source_message_id,
        traceMetadata,
        _visitorLang,
      );
    }
    if (!hasUsableFullContentEvidence(usableChunks, minScore)) {
      _pr5RagMatchState = "partial_match";
      const requiredResponse = await evaluateAndPersistRequiredRulesLive(
        supabaseAdmin,
        {
          conversation_id,
          source_message_id,
          latest_message_content: _h1LastMsg,
          conversation_status: conversation.status,
          assigned_agent_id: conversation.assigned_agent_id ?? null,
          greeting_or_trivial: _pr5GreetingOrTrivial,
          visitor_language: _visitorLang,
          expected_tenant_id: _pr5ExpectedTenantId,
          warm_handoff_question: buildMissingFactsQuestion(
            buildWarmHandoffPackage(_pr5HistoryRows ?? [], "R2"),
            _visitorLang,
          ) ?? undefined,
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
          suppress_r2_for_bounded_no_current_evidence:
            _canPersistBoundedNoCurrentEvidence,
        },
      );
      if (requiredResponse) return requiredResponse;
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _h1LastMsg,
        );
        if (r1Response) return r1Response;
      }
      if (_canPersistBoundedNoCurrentEvidence) {
        return await persistBoundedNoCurrentEvidence(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _c3ServicePlan,
          _visitorLang,
          {
            ...traceMetadata,
            answerability: "missing_full_content_evidence",
            evidence_decision: _boundedNoCurrentEvidenceDecision.kind,
          },
          _effectiveNaturalCustomerIntent,
        );
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
          compliance_requires_human_review:
            _pr5ComplianceSignal?.value === true,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated:
            _pr5History.exact_same_intent_repeated === true,
        },
        _c3ServicePlan,
        { ...traceMetadata, answerability: "missing_full_content_evidence" },
      );
      if (clarification) return clarification;
      if (!isHighRisk) {
        return await persistC3ServiceRecovery(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          _c3ServicePlan,
          "no_match",
          _visitorLang,
          { ...traceMetadata, answerability: "missing_full_content_evidence" },
        );
      }
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
    ragResult.chunks = usableChunks;
    ragResult.no_answer = false;

    const usableSummary = usableChunks.find((c) =>
      c.chunk_type === "rag_summary"
    );
    const usableFullContent = usableChunks
      .filter((c) => c.chunk_type === "full_content")
      .slice(0, 3);
    const selectedDocumentId = usableChunks[0]?.document_id ??
      usableChunks[0]?.doc_id;

    ragResult.llm_context = selectedDocumentId
      ? {
        selected_document_id: selectedDocumentId,
        orientation_summary: usableSummary?.content ?? null,
        full_content_evidence: usableFullContent.map((c) => ({
          document_id: c.document_id ?? c.doc_id ?? selectedDocumentId,
          ...(c.chunk_id ? { chunk_id: c.chunk_id } : {}),
          content: c.content ?? "",
          score: c.score ?? 0,
          source_type: c.source_type ?? "unknown",
        })),
      }
      : undefined;

    finalPromptChunks = usableFullContent;
    _canonicalKbDirectAnswer = resolveCanonicalKbDirectAnswer({
      request: _productFactualRequest,
      selection: _groundingSelection,
      language: _visitorLang,
    });
    _canonicalKbTenantId = _kbTenantResult.scope.singaporeTenantId;
    _kbDone = true;
  }
  if (!flags.ENABLE_KB || _g1SkipKB) _kbDone = true;
  if (flags.ENABLE_KB && !_g1SkipKB && !_kbDone) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ error: "Internal KB processing error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  let _pr5R4Policy:
    | {
      match_state:
        | "confident_match"
        | "partial_match"
        | "conflict"
        | "no_match"
        | "unavailable";
      provider_version: string;
      reason: string;
    }
    | undefined;

  const _pr5ShadowFlags = escalationFeatureFlagsFromEnv(Deno.env);
  if (
    _pr5ShadowFlags.shadow_mode &&
    (_pr5ShadowFlags.enable_full_ruleset || _pr5ShadowFlags.enable_r4)
  ) {
    const structuredPolicyEvidence =
      ragResult?.llm_context?.full_content_evidence
        ?.filter((item) =>
          typeof item.source_type === "string" &&
          item.source_type.toLowerCase().includes("policy") &&
          typeof item.content === "string" &&
          item.content.trim().length > 0
        )
        .slice(0, 3) ?? [];

    const policyEvidence = structuredPolicyEvidence.map((item, index) => ({
      label: `Policy evidence ${index + 1}`,
      content: item.content.slice(0, 800),
      source_type: item.source_type.slice(0, 40),
    }));

    if (policyEvidence.length > 0) {
      _pr5R4Policy = await assessPolicyEvidenceForR4(
        _h1LastMsg,
        policyEvidence,
        {
          company_id: _pr5ExpectedTenantId ?? null,
          conversation_id,
          operation_id: `generate-reply:r4-policy:${conversation_id}:${
            source_message_id ?? "none"
          }`,
        },
        { signal: requestSignal },
      );
    }
  }

  if (
    Deno.env.get("ESC_SHADOW_MODE") === "true" &&
    _pr5LocalRisk?.level === "high"
  ) {
    const e1Shadow = evaluateEscalationShadow({
      conversation_id,
      source_message_id,
      latest_message_content: _h1LastMsg,
      conversation_status: conversation.status,
      assigned_agent_id: conversation.assigned_agent_id ?? null,
      explicit_request: isHandoffIntent(_h1LastMsg),
      greeting_or_trivial: _pr5GreetingOrTrivial,
      expected_tenant_id: _pr5ExpectedTenantId,
      threat_flag: _pr5ThreatSignal,
      compliance_jurisdiction_requires_human_review: _pr5ComplianceSignal,
      rag_match_state: _pr5RagMatchState,
      topic_risk_level: _pr5LocalRisk.level,
      verified_local_risk_classification: _pr5LocalRisk.verified,
    }, Deno.env);
    if (e1Shadow) {
      console.log("[generate-reply] PR-5 E1 post-KB shadow:", {
        conversation_id,
        matched_rule: e1Shadow.matched_rule,
        decision: e1Shadow.decision,
        reason_code: e1Shadow.reason_code,
        signal_gaps: e1Shadow.signal_gaps,
      });
    }
  }

  const _warmHandoffPackage = buildWarmHandoffPackage(
    _pr5HistoryRows ?? [],
    "R2",
  );
  const _warmHandoffQuestion = buildMissingFactsQuestion(
    _warmHandoffPackage,
    _visitorLang,
  );

  const _pr5RequiredLiveResponse = await evaluateAndPersistRequiredRulesLive(
    supabaseAdmin,
    {
      conversation_id,
      source_message_id,
      latest_message_content: _h1LastMsg,
      conversation_status: conversation.status,
      assigned_agent_id: conversation.assigned_agent_id ?? null,
      greeting_or_trivial: _pr5GreetingOrTrivial,
      visitor_language: _visitorLang,
      expected_tenant_id: _pr5ExpectedTenantId,
      suppress_r2_for_prior_grounded_transform: Boolean(
        _priorGroundedTransform,
      ),
      warm_handoff_question: _warmHandoffQuestion ?? undefined,
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
    },
  );
  if (_pr5RequiredLiveResponse) return _pr5RequiredLiveResponse;

  if (_deferR1ForE1) {
    const r1Response = await persistExplicitR1IfRequested(
      supabaseAdmin,
      conversation_id,
      source_message_id,
      _h1LastMsg,
    );
    if (r1Response) return r1Response;
  }

  if (
    _canonicalKbDirectAnswer && _c1AuthorityDecision && _c1CurrentTarget &&
    !_priorGroundedTransform
  ) {
    const citation = buildCitationMetadata(
      _canonicalKbDirectAnswer.evidence_chunks,
      ragResult?.llm_context?.selected_document_id ?? null,
      {
        authorityDecision: _c1AuthorityDecision,
        currentTarget: _c1CurrentTarget,
      },
    );
    // No answer without exact source and chunk lineage.
    if (citation) {
      const route = "canonical_kb_direct_answer";
      const priceFact = _canonicalKbDirectAnswer.price_fact;
      const trustedProof: B2KbPriceProof | null =
        priceFact && _canonicalKbTenantId &&
          typeof conversation.company_id === "string"
          ? {
            field: "selling_price",
            value: priceFact.value,
            currency: priceFact.currency,
            model: priceFact.model,
            document_id: priceFact.document_id,
            chunk_id: priceFact.chunk_id,
            tenant_id: _canonicalKbTenantId,
            company_id: conversation.company_id,
            currentness: "current",
            authority_decision: "USE_CURRENT_KB",
            request: _productFactualRequest,
            full_content: priceFact.full_content,
          }
          : null;
      const publicPriceProof = trustedProof
        ? {
          field: trustedProof.field,
          value: trustedProof.value,
          currency: trustedProof.currency,
          model: trustedProof.model,
          document_id: trustedProof.document_id,
          chunk_id: trustedProof.chunk_id,
          tenant_id: trustedProof.tenant_id,
          currentness: trustedProof.currentness,
          authority_decision: trustedProof.authority_decision,
        }
        : null;
      const committed = await commitAiReplyWithControlGate(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        _canonicalKbDirectAnswer.reply,
        {
          ...citation,
          reference_authority: referenceAuthorityMetadata(_c1AuthorityDecision),
          response_route: route,
          answer_kind: _canonicalKbDirectAnswer.kind,
          product_follow_up_arbitration:
            _productFollowUpArbitration.kind === "resolved"
              ? {
                decision: "CURRENT_KB_REQUIRED",
                referent: _productFollowUpArbitration.intent.product,
                attributes: _productFollowUpArbitration.intent.facts,
                source_turn_offset:
                  _productFollowUpArbitration.source_turn_offset,
                resolved_topic: _productFollowUpArbitration.resolved_topic,
                resolution_strategy: _productFollowUpArbitration.resolution_strategy,
              }
              : null,
          ...(publicPriceProof ? { kb_fact_proof: publicPriceProof } : {}),
          rag_api_status: "success",
        },
        trustedProof,
      );
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      if (!committed.ok) {
        if (
          ["human_control", "resolved", "superseded_source"].includes(
            committed.result,
          )
        ) {
          return new Response(
            JSON.stringify({ success: true, skipped: committed.result }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            success: false,
            error: `canonical_kb_direct_answer_commit_${committed.result}`,
          }),
          {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          response_route: route,
          idempotent: committed.idempotent,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  }

  if (Deno.env.get("ESC_SHADOW_MODE") === "true") {
    const advisoryShadow = evaluateEscalationShadow({
      conversation_id,
      source_message_id,
      latest_message_content: _h1LastMsg,
      conversation_status: conversation.status,
      assigned_agent_id: conversation.assigned_agent_id ?? null,
      explicit_request: isHandoffIntent(_h1LastMsg),
      greeting_or_trivial: _pr5GreetingOrTrivial,
      expected_tenant_id: _pr5ExpectedTenantId,
      anger_flag: _pr5R3Sentiment?.anger_flag,
      sentiment_score: _pr5R3Sentiment?.sentiment_score,
      sentiment_trend: _pr5R3Sentiment?.sentiment_trend,
      sentiment_recovered_same_turn: _pr5R3Sentiment
        ?.sentiment_recovered_same_turn,
      sentiment_provider_version: _pr5R3Sentiment?.provider_version,
      sentiment_evaluation_id: _pr5R3Sentiment?.evaluation_id,
      conversation_duration_sec: _pr5ConversationDurationSec,
      tenant_config: _pr5VerifiedTenantConfig,
      policy_match_state: _pr5R4Policy?.match_state,
      policy_provider_version: _pr5R4Policy?.provider_version,
      policy_provider_reason: _pr5R4Policy?.reason,
      predicted_csat: _pr5P1Signals?.predicted_csat,
      churn_risk: _pr5P1Signals?.churn_risk,
      escalation_score: _pr5P1Signals?.escalation_score,
      p1_provider_version: _pr5P1Signals?.provider_version,
      p1_provider_source: _pr5P1Signals?.provider_source,
    }, Deno.env);
    if (advisoryShadow) {
      console.log("[generate-reply] PR-5 advisory post-KB shadow:", {
        conversation_id,
        matched_rule: advisoryShadow.matched_rule,
        decision: advisoryShadow.decision,
        reason_code: advisoryShadow.reason_code,
        signal_gaps: advisoryShadow.signal_gaps,
        sentiment_evaluation_id: _pr5R3Sentiment?.evaluation_id,
      });
    }
  }

  if (flags.ENABLE_TOOL_EXEC) {
    console.log(
      "[generate-reply] ENABLE_TOOL_EXECUTOR=true: Gate present, tools NOT attached (L5d scope)",
    );
  }

  const _customerAdvisoryBlock = buildCustomerAdvisoryContext({
    tier: customerContext?.tier,
    anger_flag: _pr5R3Sentiment?.anger_flag,
    sentiment_score: _pr5R3Sentiment?.sentiment_score,
    churn_risk: customerContext?.churn_risk,
    escalation_score: customerContext?.escalation_score,
  });
  const _emotionReplyStrategyBlock = buildEmotionReplyStrategyContext({
    emotion_kind: _pr5R3Sentiment?.emotion_kind,
    emotion_intensity: _pr5R3Sentiment?.emotion_intensity,
    emotion_confidence: _pr5R3Sentiment?.emotion_confidence,
    sentiment_recovered_same_turn: _pr5R3Sentiment
      ?.sentiment_recovered_same_turn,
  });
  const latestHandoffReason = await loadLatestHandoffReason(
    supabaseAdmin,
    conversation_id,
  );
  const returnToAiGuard = buildReturnToAiGenerationGuard(
    latestHandoffReason,
    conversation.assigned_agent_id ?? null,
  );
  let finalSystemPrompt = _priorGroundedTransform
    ? buildPriorGroundedTransformGenerationSystem(_priorGroundedTransform)
    : [
      basePrompt,
      CUSTOMER_CONVERSATION_POLICY,
      buildServicePlanPromptBlock(_c3ServicePlan),
      _conversationContinuityBlock,
      _c3MemoryContext,
      returnToAiGuard,
      _customerAdvisoryBlock,
      _emotionReplyStrategyBlock,
      buildMaskedContextBlock(customerContext, opaqueCustomerRef),
      buildRagBlock(ragResult),
    ].filter((s) => s && s.length > 0).join("\n\n");
  const { data: newestMessages } = await supabaseAdmin
    .from("messages")
    .select("id, role, content, created_at")
    .eq("conversation_id", conversation_id)
    .neq("content", "__THINKING__")
    .eq("is_recalled", false)
    .or(sourceBoundaryFilter(sourceVisitorMessage))
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(10);
  if (!newestMessages || newestMessages.length === 0) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: true, skipped: "no messages" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const messages = [...newestMessages].reverse();
  const modelMessages: Array<{ role: "user" | "assistant"; content: string }> =
    messages.map((m) => ({
      role: m.role === "visitor" ? "user" : "assistant",
      content: String(m.content ?? ""),
    }));
  if (modelMessages[modelMessages.length - 1].role === "assistant") {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: true, skipped: "last message is assistant" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (flags.ENABLE_TOOL_EXEC) {
    console.warn(
      "[generate-reply] TOOL_EXECUTOR_NOT_READY: tools withheld from governed LLM request",
      { conversation_id },
    );
  }

  const _generationCompanyId = typeof conversation.company_id === "string" &&
      conversation.company_id.length > 0
    ? conversation.company_id
    : null;
  let _generationUserInput = _priorGroundedTransform
    ? buildPriorGroundedTransformGenerationUser(_h1LastMsg)
    : buildRouterConversationInput(modelMessages);
  if (!_priorGroundedTransform && _c3Memory) {
    const boundedEnvelope = composeBoundedGenerationEnvelope({
      required_parts: [
        basePrompt,
        CUSTOMER_CONVERSATION_POLICY,
        buildServicePlanPromptBlock(_c3ServicePlan),
        returnToAiGuard,
        _customerAdvisoryBlock,
        _emotionReplyStrategyBlock,
        buildMaskedContextBlock(customerContext, opaqueCustomerRef),
        buildRagBlock(ragResult),
      ],
      memory_part: _c3MemoryContext,
      continuity_part: _conversationContinuityBlock,
      user: _h1LastMsg,
    });
    finalSystemPrompt = boundedEnvelope.system;
    _generationUserInput = boundedEnvelope.user;
  }

  let llm = await callModel({
    purpose: "generation",
    system: finalSystemPrompt,
    user: _generationUserInput,
    maxTokens: resolveGenerationMaxTokens(),
    operationId:
      `generate-reply:orchestration:${conversation_id}:${source_message_id}`,
    companyId: _generationCompanyId,
    conversationId: conversation_id,
    tag: "generate-reply-orchestration",
    responseFormat: "text",
    signal: requestSignal,
  });

  // A verifier rejection on a prior-grounded transform is not yet proof of an
  // upstream/system outage. Retry once with stricter factual isolation. Both
  // drafts are still gated by the same exact + semantic grounding verifier.
  if (
    _priorGroundedTransform && !llm.ok &&
    (llm.code === "LLM_INVALID_OUTPUT" || llm.code === "LLM_GROUNDING_REJECTED")
  ) {
    llm = await callModel({
      purpose: "generation",
      system: buildPriorGroundedTransformRetrySystem(_priorGroundedTransform),
      user: _generationUserInput,
      maxTokens: resolveGenerationMaxTokens(),
      operationId:
        `generate-reply:orchestration:${conversation_id}:${source_message_id}:transform-retry`,
      companyId: _generationCompanyId,
      conversationId: conversation_id,
      tag: "generate-reply-orchestration-transform-retry",
      responseFormat: "text",
      signal: requestSignal,
    });
  }

  if (!llm.ok) {
    if (llm.code === "LLM_GROUNDING_REJECTED") {
      const recoveryReply = GROUNDING_RECOVERY_WORDING[_visitorLang] ??
        GROUNDING_RECOVERY_WORDING.en;
      const committed = await commitAiReplyWithControlGate(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        recoveryReply,
        {
          response_route: "grounding_recovery_clarification",
          handoff_required: false,
          factual_grounding_required: false,
          source_error_code: "LLM_GROUNDING_REJECTED",
        },
      );
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      if (!committed.ok) {
        if (
          ["human_control", "resolved", "superseded_source"].includes(
            committed.result,
          )
        ) {
          return new Response(
            JSON.stringify({ success: true, skipped: committed.result }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            success: false,
            error: `grounding_recovery_commit_${committed.result}`,
          }),
          {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          response_route: "grounding_recovery_clarification",
          handoff_required: false,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (_escEnableS0) {
      return await handleS0Handoff(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        routerFailureToS0(llm.code),
        _visitorLang,
      );
    }
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({
        success: false,
        error: "AI service error",
        error_code: llm.code,
      }),
      {
        status: routerFailureHttpStatus(llm.code),
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const aiReplyContent = llm.text;

  const citationMetaBase = _priorGroundedTransform
    ? buildInheritedTransformCitationMetadata(_priorGroundedTransform)
    : finalPromptChunks.length > 0
    ? buildCitationMetadata(
      finalPromptChunks,
      ragResult?.llm_context?.selected_document_id ?? null,
      _c1AuthorityDecision && _c1CurrentTarget
        ? {
          authorityDecision: _c1AuthorityDecision,
          currentTarget: _c1CurrentTarget,
        }
        : undefined,
    )
    : null;
  const citationMeta = citationMetaBase && _c1AuthorityDecision
    ? {
      ...citationMetaBase,
      reference_authority: referenceAuthorityMetadata(_c1AuthorityDecision),
    }
    : citationMetaBase;
  if (_priorGroundedTransform && !citationMeta) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({
        success: false,
        error: "prior_grounded_transform_lineage_unavailable",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  if (
    flags.ENABLE_KB && !_g1SkipKB && finalPromptChunks.length > 0 &&
    !citationMeta
  ) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: false, error: "citation_lineage_unavailable" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  const committed = await commitAiReplyWithControlGate(
    supabaseAdmin,
    conversation_id,
    source_message_id,
    aiReplyContent,
    citationMeta,
  );
  if (!committed.ok) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (
      committed.result === "human_control" ||
      committed.result === "resolved" ||
      committed.result === "superseded_source"
    ) {
      console.log("[generate-reply] stale orchestration reply suppressed:", {
        conversation_id,
        result: committed.result,
      });
      return new Response(
        JSON.stringify({ success: true, skipped: committed.result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        success: false,
        error: `ai_reply_commit_${committed.result}`,
      }),
      {
        status: 409,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
  if (flags.ENABLE_COACH) void coachTrace;
  if (flags.ENABLE_KB && ragResult?.success) void ragResult;
  console.log(
    "[generate-reply] AI reply committed (orchestration path) for conversation:",
    conversation_id,
  );
  return new Response(
    JSON.stringify({ success: true, idempotent: committed.idempotent }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

function safeRefusal(code: string): Response {
  return new Response(
    JSON.stringify({
      success: true,
      skipped: "refused",
      reason_code: code,
      handoff_required: true,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

function buildMaskedContextBlock(
  customerContext: {
    masked_summary?: string;
    tier?: string;
    predicted_csat?: number;
    churn_risk?: number;
    escalation_score?: number;
    p1_provider_version?: string;
  } | null,
  opaqueCustomerRef: string | null,
): string {
  if (!customerContext) return "";
  const parts: string[] = [];
  if (customerContext.tier) {
    parts.push(`Customer tier: ${customerContext.tier}`);
  }
  if (customerContext.masked_summary) {
    parts.push(customerContext.masked_summary);
  }
  if (opaqueCustomerRef) {
    parts.push(
      `Customer reference (pseudonymous): ${
        pseudonymizeRef(opaqueCustomerRef)
      }`,
    );
  }
  return parts.length === 0
    ? ""
    : `Customer context (masked):\n${parts.join("\n")}`;
}

function buildRagBlock(
  ragResult: {
    success: boolean;
    chunks?: Array<{
      title?: string;
      content?: string;
      score?: number;
      source_type?: string;
      chunk_type?: string;
      short_snippet?: string;
    }>;
    llm_context?: {
      selected_document_id: string;
      orientation_summary: string | null;
      full_content_evidence: Array<{
        document_id: string;
        chunk_id?: string;
        content: string;
        score: number;
        source_type: string;
      }>;
    };
  } | null,
): string {
  if (!ragResult || !ragResult.success) return "";

  const context = ragResult.llm_context;
  if (context) {
    const sections: string[] = [
      "Knowledge Base grounding rules:",
      "- Answer ONLY from the evidence below.",
      "- The server has already selected this evidence using tenant, entity, region, publication, currentness, source precedence, and version authority.",
      "- Similarity indicates relevance only; it never overrides authority or currentness.",
      "- Never use rejected, unselected, historical, superseded, or cancelled material as a current fact.",
      "- The RAG summary is orientation only; never use it alone for exact facts.",
      "- Prices, dates, dimensions, policy conditions, procedures, limits, and other exact facts MUST be supported by Full Content Evidence.",
      "- If Full Content Evidence does not support an exact claim, state that the knowledge base does not provide enough evidence and offer human assistance.",
      `Selected document: ${context.selected_document_id}`,
    ];

    if (context.orientation_summary) {
      sections.push(
        `Orientation Summary (not sufficient by itself for exact facts):\n${
          context.orientation_summary.slice(0, 1200)
        }`,
      );
    }

    if (context.full_content_evidence.length > 0) {
      const evidence = context.full_content_evidence
        .slice(0, 3)
        .map((item, index) =>
          `[Full Content Evidence ${index + 1}]` +
          `${item.chunk_id ? ` [chunk:${item.chunk_id}]` : ""}\n` +
          item.content.slice(0, 1200)
        )
        .join("\n\n");
      sections.push(`Full Content Evidence:\n${evidence}`);
    } else {
      sections.push(
        "Full Content Evidence: none. Do not assert exact facts from the summary.",
      );
    }

    return sections.join("\n\n");
  }

  if (!ragResult.chunks?.length) return "";

  const summaries = ragResult.chunks
    .filter((c) => c.chunk_type === "rag_summary")
    .slice(0, 1);
  const evidence = ragResult.chunks
    .filter((c) => c.chunk_type === "full_content")
    .slice(0, 3);

  if (summaries.length === 0 && evidence.length === 0) return "";

  return [
    "Knowledge Base grounding rules:",
    "- Answer ONLY from the evidence below.",
    "- Summary is orientation only and cannot independently support exact facts.",
    summaries[0]?.content
      ? `Orientation Summary:\n${summaries[0].content.slice(0, 1200)}`
      : "",
    evidence.length > 0
      ? `Full Content Evidence:\n${
        evidence
          .map((c, i) =>
            `[${i + 1}]\n${(c.content ?? c.short_snippet ?? "").slice(0, 1200)}`
          )
          .join("\n\n")
      }`
      : "Full Content Evidence: none. Do not assert exact facts.",
  ].filter(Boolean).join("\n\n");
}

function pseudonymizeRef(ref: string): string {
  let h = 0;
  for (let i = 0; i < ref.length; i++) {
    h = ((h << 5) - h + ref.charCodeAt(i)) | 0;
  }
  return `cust_${(h >>> 0).toString(36)}`;
}

async function callCoachPromptAdapter(
  conversation_id: string,
): Promise<
  {
    success: boolean;
    content?: string;
    version_id?: string;
    version_label?: string;
    prompt_hash?: string;
    error_type?: string;
  }
> {
  const FAIL = (error_type: string) => ({
    success: false as const,
    error_type,
  });
  const endpoint = Deno.env.get("COACH_PROMPT_ENDPOINT");
  const token = Deno.env.get("COACH_PROMPT_INTERNAL_TOKEN");
  const timeoutMs = parseInt(Deno.env.get("COACH_AI_TIMEOUT_MS") || "3000");
  if (!endpoint) return FAIL("COACH_API_NOT_CONFIGURED");
  if (!token) return FAIL("COACH_TOKEN_MISSING");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-coach-internal-token": token,
        "x-coach-runtime": "C0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ include_content: true }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return FAIL("COACH_API_ERROR");
    let data;
    try {
      data = await response.json();
    } catch {
      return FAIL("COACH_JSON_INVALID");
    }
    if (!data.ok || !data.data?.content) return FAIL("COACH_NO_ACTIVE_PROMPT");
    const content = data.data.content;
    const validationError = validateCoachPromptContent(content);
    if (validationError) return FAIL(validationError);
    const versionId = data.data.id || "";
    const promptHash = await computePromptHash(
      content,
      versionId,
      conversation_id,
    );
    return {
      success: true,
      content,
      version_id: versionId,
      version_label: data.data.label || "",
      prompt_hash: promptHash,
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === "AbortError") {
      return FAIL("COACH_API_TIMEOUT");
    }
    return FAIL("COACH_API_EXCEPTION");
  }
}

function validateCoachPromptContent(content: unknown): string | null {
  if (typeof content !== "string") return "COACH_SCHEMA_INVALID";
  if (content.length === 0) return "COACH_CONTENT_EMPTY";
  if (content.length > 20000) return "COACH_CONTENT_TOO_LONG";
  if (/sk-ant-[a-zA-Z0-9]+/.test(content) || /service_role/.test(content)) {
    return "COACH_SCHEMA_INVALID";
  }
  return null;
}

async function computePromptHash(
  content: string,
  versionId: string,
  conversationId: string,
): Promise<string> {
  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content + "|" + versionId + "|" + conversationId),
  );
  return Array.from(new Uint8Array(hashBuffer)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("").substring(0, 12);
}

async function callCustomer360Adapter(conversation_id: string): Promise<{
  success: boolean;
  customer_context?: {
    masked_summary?: string;
    tier?: string;
    predicted_csat?: number;
    churn_risk?: number;
    escalation_score?: number;
    p1_provider_version?: string;
  };
  customer_ref?: string;
  error_type?: string;
}> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const internalToken = Deno.env.get("CUSTOMER360_INTERNAL_TOKEN");
  const timeoutRaw = Number.parseInt(
    Deno.env.get("CUSTOMER360_CALLER_TIMEOUT_MS") ?? "6000",
    10,
  );
  const timeoutMs =
    Number.isInteger(timeoutRaw) && timeoutRaw >= 1000 && timeoutRaw <= 15000
      ? timeoutRaw
      : 6000;

  if (!supabaseUrl || !internalToken) {
    console.error("[generate-reply] C360_CALLER_CONFIG_MISSING");
    return { success: false, error_type: "C360_CALLER_CONFIG_MISSING" };
  }

  const endpoint = `${
    supabaseUrl.replace(/\/+$/, "")
  }/functions/v1/customer360-adapter`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service-Token": internalToken,
      },
      body: JSON.stringify({
        conversation_id,
        fields_requested: [
          "masked_summary",
          "tier",
          "predicted_csat",
          "churn_risk",
          "escalation_score",
          "p1_provider_version",
          "privacy_flags",
          "context_quality",
        ],
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const errorType =
      error instanceof DOMException && error.name === "AbortError"
        ? "C360_CALLER_TIMEOUT"
        : "C360_CALLER_FETCH_EXCEPTION";
    console.error("[generate-reply] Customer360 caller failed", {
      conversation_id,
      error_type: errorType,
    });
    return { success: false, error_type: errorType };
  }
  clearTimeout(timeout);

  if (!response.ok) {
    console.error("[generate-reply] Customer360 caller non-2xx", {
      conversation_id,
      status: response.status,
    });
    return {
      success: false,
      error_type: `C360_CALLER_HTTP_${response.status}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { success: false, error_type: "C360_CALLER_INVALID_JSON" };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { success: false, error_type: "C360_CALLER_INVALID_SCHEMA" };
  }

  const data = payload as Record<string, unknown>;
  if (data.success !== true) {
    const errorObj =
      data.error && typeof data.error === "object" && !Array.isArray(data.error)
        ? data.error as Record<string, unknown>
        : null;
    const code = errorObj && typeof errorObj.error_code === "string"
      ? errorObj.error_code.slice(0, 80)
      : "C360_UPSTREAM_DEGRADED";
    return { success: false, error_type: code };
  }

  const context =
    data.customer_context && typeof data.customer_context === "object" &&
      !Array.isArray(data.customer_context)
      ? data.customer_context as Record<string, unknown>
      : null;

  const customerRef = typeof data.customer_ref === "string" &&
      /^cus_[A-Za-z0-9_-]{16,64}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        .test(data.customer_ref)
    ? data.customer_ref
    : undefined;

  if (!context || !customerRef) {
    return { success: false, error_type: "C360_CALLER_INVALID_SCHEMA" };
  }

  const safeContext: {
    masked_summary?: string;
    tier?: string;
    predicted_csat?: number;
    churn_risk?: number;
    escalation_score?: number;
    p1_provider_version?: string;
  } = {};

  if (
    typeof context.masked_summary === "string" && context.masked_summary.trim()
  ) {
    safeContext.masked_summary = context.masked_summary.trim().slice(0, 1000);
  }
  if (typeof context.tier === "string" && context.tier.trim()) {
    safeContext.tier = context.tier.trim().slice(0, 100);
  }
  if (
    typeof context.predicted_csat === "number" &&
    Number.isFinite(context.predicted_csat)
  ) {
    safeContext.predicted_csat = context.predicted_csat;
  }
  if (
    typeof context.churn_risk === "number" &&
    Number.isFinite(context.churn_risk)
  ) {
    safeContext.churn_risk = context.churn_risk;
  }
  if (
    typeof context.escalation_score === "number" &&
    Number.isFinite(context.escalation_score)
  ) {
    safeContext.escalation_score = context.escalation_score;
  }
  if (
    typeof context.p1_provider_version === "string" &&
    context.p1_provider_version.trim()
  ) {
    safeContext.p1_provider_version = context.p1_provider_version.trim().slice(
      0,
      120,
    );
  }

  return {
    success: true,
    customer_context: safeContext,
    customer_ref: customerRef,
  };
}

async function callKBAdapter(
  _conversation_id: string,
  userMessage: string,
  scope: KBResolvedScope,
  signal?: AbortSignal,
): Promise<{
  success: boolean;
  no_answer?: boolean;
  retrieval_quality?: "high" | "medium" | "low" | "failed";
  chunks?: KBFullChunk[];
  documents?: KBDocumentCandidate[];
  llm_context?: {
    selected_document_id: string;
    orientation_summary: string | null;
    full_content_evidence: Array<{
      document_id: string;
      chunk_id?: string;
      content: string;
      score: number;
      source_type: string;
    }>;
  };
  meta?: {
    document_score: number;
    highest_chunk_score: number;
    second_highest_chunk_score: number;
    returned_summary_count: number;
    returned_full_content_count: number;
    dropped_without_document_id: number;
    dropped_without_content: number;
  };
  query_text_preview?: string;
}> {
  const endpointCfg = resolveKBEndpoint();
  if (!endpointCfg) {
    return { success: false, no_answer: true, retrieval_quality: "failed" };
  }
  const result = await fetchKBRag(
    { query: userMessage, top_k: 5 },
    scope,
    endpointCfg,
    { timeoutMs: 15000, signal },
  );
  if (!result.success) {
    return { success: false, no_answer: true, retrieval_quality: "failed" };
  }
  if (result.chunks.length === 0) {
    return {
      success: true,
      no_answer: true,
      retrieval_quality: "failed",
      chunks: [],
      query_text_preview: userMessage.slice(0, 100),
    };
  }
  return {
    success: true,
    no_answer: false,
    retrieval_quality: "high",
    chunks: result.chunks,
    documents: result.documents,
    ...(result.llm_context ? { llm_context: result.llm_context } : {}),
    ...(result.meta ? { meta: result.meta } : {}),
    query_text_preview: userMessage.slice(0, 100),
  };
}

type GateDecisionKind = "ALLOW" | "DENY" | "DOWNGRADE_TO_DRAFT" | "ESCALATE";
interface GateDecision {
  decision: GateDecisionKind;
  reason?: string;
  execution_allowed?: boolean;
  force_draft?: boolean;
  handoff_required?: boolean;
  execution_deferred_to?: "L5d";
  draft_enforcement_deferred_to?: "L5e";
  action_deferred_to?: "L5e";
  message_to_llm?: string;
}
interface ToolRequest {
  tool_name: string;
  input: Record<string, unknown>;
}
interface ExecutionContext {
  conversation: { id: string; status: string };
  caller_mode: "system_auto" | "human_agent" | "ai_assist";
  risk_level: "low" | "medium" | "high";
  privacy_flags?: {
    do_not_profile?: boolean;
    consent_status?: "granted" | "withdrawn" | "unknown";
  };
  turn_tool_calls: Set<string>;
  turn_budget: { total: number; kb_search: number; c360: number };
  server_resolved_customer_ref?: string | null;
}
const ALLOWED_TOOLS = [
  "kb_search",
  "escalate_to_human",
  "get_customer_context",
  "get_order_summary",
  "create_handoff_summary",
  "mark_unresolved",
  "suggest_reply",
] as const;
const READ_ONLY_TOOLS = [
  "kb_search",
  "get_customer_context",
  "get_order_summary",
] as const;
const HIGH_RISK_ALLOWED = [
  "kb_search",
  "get_customer_context",
  "escalate_to_human",
  "create_handoff_summary",
] as const;
const OFFLINE_BOT_ALLOWED = ["kb_search", "escalate_to_human"] as const;
const MAX_TOOL_CALLS = 10, MAX_KB_SEARCH = 3, MAX_C360_CALLS = 2;

function buildSafeDedupeKey(
  tool_name: string,
  input: Record<string, unknown>,
  server_resolved_customer_ref?: string | null,
): string | null {
  if (tool_name === "get_order_summary") {
    return server_resolved_customer_ref
      ? `get_order_summary:${server_resolved_customer_ref}`
      : null;
  }
  const SAFE_FIELDS: Record<string, string[]> = {
    kb_search: ["query_norm", "locale"],
    get_customer_context: [],
    escalate_to_human: ["reason_code"],
    create_handoff_summary: ["reason_code"],
    mark_unresolved: ["reason_code"],
    suggest_reply: ["intent_code"],
  };
  const safe: Record<string, unknown> = {};
  for (const k of SAFE_FIELDS[tool_name] ?? []) {
    if (input[k] !== undefined && typeof input[k] !== "object") {
      safe[k] = String(input[k]).slice(0, 200);
    }
  }
  return `${tool_name}:${JSON.stringify(safe)}`;
}

export function toolExecutorGate(
  toolRequest: ToolRequest,
  context: ExecutionContext,
): GateDecision {
  const { tool_name, input } = toolRequest;
  const {
    conversation,
    caller_mode,
    risk_level,
    privacy_flags,
    turn_tool_calls,
    turn_budget,
    server_resolved_customer_ref,
  } = context;
  if (tool_name === "schedule_feedback_request") {
    return { decision: "DENY", reason: "TOOL_EXCLUDED" };
  }
  if (!(ALLOWED_TOOLS as readonly string[]).includes(tool_name)) {
    return { decision: "DENY", reason: "TOOL_NOT_REGISTERED" };
  }
  const status = conversation.status;
  if (status === "resolved" || status === "closed") {
    return { decision: "DENY", reason: "CONV_RESOLVED_OR_CLOSED" };
  }
  if (
    (status === "human_needed" || status === "human_control") &&
    !(READ_ONLY_TOOLS as readonly string[]).includes(tool_name)
  ) return { decision: "DENY", reason: "TOOL_NOT_ALLOWED_IN_STATUS" };
  if (
    status === "offline_bot" &&
    !(OFFLINE_BOT_ALLOWED as readonly string[]).includes(tool_name)
  ) return { decision: "DENY", reason: "TOOL_NOT_ALLOWED_OFFLINE" };
  if (
    risk_level === "high" &&
    !(HIGH_RISK_ALLOWED as readonly string[]).includes(tool_name)
  ) return { decision: "ESCALATE", reason: "HIGH_RISK_TOOL_BLOCKED" };
  if (tool_name === "mark_unresolved" && caller_mode === "system_auto") {
    return { decision: "DENY", reason: "MARK_UNRESOLVED_REQUIRES_HUMAN" };
  }
  if (
    (privacy_flags?.do_not_profile === true ||
      privacy_flags?.consent_status === "withdrawn") &&
    tool_name === "get_customer_context"
  ) return { decision: "DENY", reason: "PRIVACY_DO_NOT_PROFILE" };
  const dedupe_key = buildSafeDedupeKey(
    tool_name,
    input,
    server_resolved_customer_ref,
  );
  if (dedupe_key === null) {
    return { decision: "DENY", reason: "SERVER_REFERENCE_REQUIRED" };
  }
  if (turn_tool_calls.has(dedupe_key)) {
    return { decision: "DENY", reason: "DUPLICATE_TOOL_CALL_IN_TURN" };
  }
  turn_tool_calls.add(dedupe_key);
  if (turn_budget.total >= MAX_TOOL_CALLS) {
    return { decision: "DENY", reason: "TOOL_BUDGET_EXCEEDED" };
  }
  if (tool_name === "kb_search" && turn_budget.kb_search >= MAX_KB_SEARCH) {
    return { decision: "DENY", reason: "KB_SEARCH_BUDGET_EXCEEDED" };
  }
  if (
    tool_name === "get_customer_context" && turn_budget.c360 >= MAX_C360_CALLS
  ) return { decision: "DENY", reason: "C360_BUDGET_EXCEEDED" };
  if (status === "ai_draft_only" || status === "unresolved") {
    return {
      decision: "DOWNGRADE_TO_DRAFT",
      reason: "STATUS_DRAFT_ONLY",
      execution_allowed: true,
      force_draft: true,
      execution_deferred_to: "L5d",
      draft_enforcement_deferred_to: "L5e",
    };
  }
  if (status === "escalation_risk") {
    return {
      decision: "DOWNGRADE_TO_DRAFT",
      reason: "ESCALATION_RISK_DOWNGRADE",
      execution_allowed: true,
      force_draft: true,
      execution_deferred_to: "L5d",
      draft_enforcement_deferred_to: "L5e",
    };
  }
  return {
    decision: "ALLOW",
    reason: "GATE_PASSED",
    execution_allowed: true,
    execution_deferred_to: "L5d",
  };
}

export function handleGateDecision(decision: GateDecision): GateDecision {
  switch (decision.decision) {
    case "ALLOW":
      return {
        decision: "ALLOW",
        reason: decision.reason ?? "GATE_PASSED",
        execution_allowed: true,
        execution_deferred_to: "L5d",
      };
    case "DENY":
      return {
        decision: "DENY",
        reason: decision.reason,
        message_to_llm: "tool not available in current context",
      };
    case "DOWNGRADE_TO_DRAFT":
      return {
        decision: "DOWNGRADE_TO_DRAFT",
        reason: decision.reason,
        execution_allowed: true,
        force_draft: true,
        execution_deferred_to: "L5d",
        draft_enforcement_deferred_to: "L5e",
      };
    case "ESCALATE":
      return {
        decision: "ESCALATE",
        reason: decision.reason,
        handoff_required: true,
        action_deferred_to: "L5e",
      };
  }
}

const TOOL_DEFINITIONS = [
  {
    name: "kb_search",
    description:
      "Search the knowledge base for policy, FAQ, or product information to answer customer questions.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search query extracted from customer message (must be PII-redacted before stub log or trace).",
        },
        industry: {
          type: "string",
          description:
            "Industry context (optional, inferred from conversation).",
        },
        top_k: {
          type: "number",
          description: "Number of results to return (default 5, max 10).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Escalate conversation to a human agent when AI cannot resolve the issue.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Reason for escalation (sanitized, no PII).",
        },
        summary: {
          type: "string",
          description:
            "Brief conversation summary (sanitized, max 500 chars, no PII).",
        },
      },
      required: ["reason", "summary"],
    },
  },
  {
    name: "get_customer_context",
    description:
      "Get customer context (tier, sentiment, language preference) to personalize response tone.",
    input_schema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Requested fields (advisory only — server enforces masking level allowlist).",
        },
      },
      required: [],
    },
  },
  {
    name: "get_order_summary",
    description:
      "Get order status summary for delivery, return, or refund inquiries.",
    input_schema: {
      type: "object",
      properties: {
        inquiry_type: {
          type: "string",
          enum: [
            "delivery_status",
            "return_request",
            "refund_inquiry",
            "order_general",
          ],
          description: "Type of order inquiry.",
        },
      },
      required: ["inquiry_type"],
    },
  },
  {
    name: "create_handoff_summary",
    description:
      "Generate a conversation summary for the human agent who will take over this conversation.",
    input_schema: {
      type: "object",
      properties: {
        summary_focus: {
          type: "string",
          description:
            "Optional focus area for the summary (e.g. 'refund concern', 'delivery issue').",
        },
      },
      required: [],
    },
  },
  {
    name: "mark_unresolved",
    description:
      "Mark conversation as unresolved for follow-up. Only available in console suggest mode.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Reason conversation is unresolved (sanitized).",
        },
        follow_up_at: {
          type: "string",
          description:
            "Suggested follow-up datetime (ISO 8601, optional — advisory only in L5d, not written/scheduled).",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "suggest_reply",
    description:
      "Generate a suggested reply for the customer based on KB findings and context.",
    input_schema: {
      type: "object",
      properties: {
        context_summary: {
          type: "string",
          description:
            "Summary of context assembled by generate-reply (sanitized, max 500 chars, no PII).",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Citation labels from KB results.",
        },
      },
      required: ["context_summary"],
    },
  },
];

interface ToolResult {
  tool_name: string;
  status: "stub" | "denied";
  result_classification: "internal_only";
  [k: string]: unknown;
}
export async function handleToolCall(
  tool_name: string,
  _tool_input: Record<string, unknown>,
  _context: ExecutionContext,
): Promise<ToolResult> {
  switch (tool_name) {
    case "kb_search":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        retrieval_quality: "failed",
        no_answer: true,
        handoff_required: true,
        results: [],
        stub_note: "KB adapter not yet enabled (L5d stub)",
      };
    case "escalate_to_human":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        escalated: false,
        stub_note:
          "Escalation workflow deferred to L5e — no state changes in L5d",
      };
    case "get_customer_context":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        customer_context: null,
        context_available: false,
        stub_note:
          "Customer360 adapter not enabled; no customer context returned",
      };
    case "get_order_summary":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        order_available: false,
        stub_note: "Order adapter not yet enabled (L5d stub)",
      };
    case "create_handoff_summary":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        summary: "[Handoff summary not yet available — L5d stub]",
        stub_note:
          "Handoff summary generation deferred to L5e; conversation_id server-side only",
      };
    case "mark_unresolved":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        marked: false,
        stub_note:
          "mark_unresolved write action deferred to L5e — no state changes in L5d",
      };
    case "suggest_reply":
      return {
        tool_name,
        status: "stub",
        result_classification: "internal_only",
        draft_content: "",
        confidence: 0,
        recommended_action: "human_review",
        stub_note:
          "suggest_reply draft write deferred to L5e — no state changes in L5d",
      };
    default:
      return {
        tool_name,
        status: "denied",
        result_classification: "internal_only",
        error: "tool not available in current context",
      };
  }
}

type L5eOutputAction = "auto_send" | "draft_only" | "refuse";
interface L5eOutputMode {
  action: L5eOutputAction;
  reason: string;
}
interface L5eGuardrailResult {
  pass: boolean;
  reason: string;
}
interface L5eToolResult {
  tool_name: string;
  result_classification?:
    | "public_safe"
    | "draft_only"
    | "supervisor_only"
    | "internal_only";
  handoff_required?: boolean;
  citation_required?: boolean;
  has_valid_citation?: boolean;
}
interface L5eRagResult {
  no_answer?: boolean;
  conflict_detected?: boolean;
  retrieval_quality?: "high" | "medium" | "low";
  policy_gap?: boolean;
  source_scope?: "customer_answer" | "internal_only" | string;
}
type L5eCallerMode = "system_auto" | "console_suggest";

export function determineOutputMode(
  conversationStatus: string,
  toolResults: L5eToolResult[],
  ragResult: L5eRagResult | null,
  mode: L5eCallerMode,
): L5eOutputMode {
  switch (conversationStatus) {
    case "resolved":
    case "closed":
      return { action: "refuse", reason: "CONV_RESOLVED_OR_CLOSED" };
    case "ai_handling":
      break;
    case "ai_draft_only":
      return { action: "draft_only", reason: "STATUS_AI_DRAFT_ONLY" };
    case "human_needed":
    case "human_control":
      return { action: "draft_only", reason: "STATUS_HUMAN_CONTROL" };
    case "escalation_risk":
      return { action: "draft_only", reason: "STATUS_ESCALATION_RISK" };
    case "unresolved":
      return { action: "draft_only", reason: "STATUS_UNRESOLVED" };
    case "offline_bot":
      return { action: "draft_only", reason: "STATUS_OFFLINE_BOT" };
    case "reopened":
      return { action: "draft_only", reason: "STATUS_REOPENED_TRANSITIONAL" };
    default:
      return { action: "draft_only", reason: "STATUS_UNKNOWN_SAFE_FALLBACK" };
  }
  const guardrailsPass = checkGuardrails(toolResults, ragResult, mode);
  return guardrailsPass.pass
    ? { action: "auto_send", reason: "GUARDRAILS_PASSED" }
    : { action: "draft_only", reason: guardrailsPass.reason };
}

export function checkGuardrails(
  toolResults: L5eToolResult[],
  ragResult: L5eRagResult | null,
  mode: L5eCallerMode,
): L5eGuardrailResult {
  if (mode === "console_suggest") {
    return { pass: false, reason: "CONSOLE_SUGGEST_ALWAYS_DRAFT" };
  }
  if (ragResult) {
    if (ragResult.no_answer) return { pass: false, reason: "KB_NO_ANSWER" };
    if (ragResult.conflict_detected) {
      return { pass: false, reason: "KB_CONFLICT" };
    }
    if (ragResult.retrieval_quality === "low") {
      return { pass: false, reason: "KB_LOW_QUALITY" };
    }
    if (ragResult.policy_gap) return { pass: false, reason: "KB_POLICY_GAP" };
    if (ragResult.source_scope !== "customer_answer") {
      return { pass: false, reason: "KB_SCOPE_NOT_CUSTOMER_ANSWER" };
    }
  }
  for (const result of toolResults) {
    if (result.result_classification === "draft_only") {
      return { pass: false, reason: "TOOL_RESULT_DRAFT_ONLY" };
    }
    if (result.result_classification === "supervisor_only") {
      return { pass: false, reason: "TOOL_RESULT_SUPERVISOR_ONLY" };
    }
  }
  const suggestResult = toolResults.find((r) =>
    r.tool_name === "suggest_reply"
  );
  if (suggestResult?.citation_required && !suggestResult?.has_valid_citation) {
    return { pass: false, reason: "SUGGEST_REPLY_MISSING_CITATION" };
  }
  if (toolResults.some((r) => r.handoff_required)) {
    return { pass: false, reason: "HANDOFF_REQUIRED_BY_TOOL" };
  }
  return { pass: true, reason: "ALL_GUARDRAILS_PASSED" };
}

interface L5eExecutionContextLike {
  flags: { ENABLE_TOOL_EXEC: boolean; [k: string]: unknown };
  llm_generated_content?: string;
  handoff_summary_from_tool?: string;
  [k: string]: unknown;
}
interface L5eSuggestReplyInput {
  [k: string]: unknown;
}
interface L5eEscalateInput {
  reason?: string;
  summary?: string;
  [k: string]: unknown;
}
interface L5eMarkUnresolvedInput {
  reason?: string;
  follow_up_at?: string;
  [k: string]: unknown;
}
interface L5eDeferredResult {
  deferred: boolean;
  reason: string;
  auto_sent?: boolean;
  escalated?: boolean;
  marked?: boolean;
}
function l5eSanitize(
  input: string | undefined | null,
  opts: { maxChars: number; noPII: boolean },
): string {
  if (!input) return "";
  let s = String(input);
  if (opts.noPII) {
    s = s.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]");
    s = s.replace(/\+?\d[\d\s\-().]{7,}\d/g, "[phone]");
    s = s.replace(/\b\d{9,}\b/g, "[digits]");
  }
  return s.length > opts.maxChars ? s.slice(0, opts.maxChars) : s;
}
export async function executeSuggestReply(
  _input: L5eSuggestReplyInput,
  context: L5eExecutionContextLike,
  outputMode: L5eOutputMode,
): Promise<L5eDeferredResult> {
  if (!context.flags.ENABLE_TOOL_EXEC) {
    return { auto_sent: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
  }
  void outputMode;
  return { deferred: true, reason: "GATE_B_REQUIRED" };
}
export async function executeEscalateToHuman(
  input: L5eEscalateInput,
  context: L5eExecutionContextLike,
): Promise<L5eDeferredResult> {
  const _reason = l5eSanitize(input.reason, { maxChars: 500, noPII: true });
  const _summary = l5eSanitize(input.summary, { maxChars: 500, noPII: true });
  const _handoffSummary = context.handoff_summary_from_tool || _summary;
  void _reason;
  void _handoffSummary;
  if (!context.flags.ENABLE_TOOL_EXEC) {
    return { escalated: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
  }
  return { deferred: true, reason: "GATE_B_REQUIRED" };
}
export async function executeMarkUnresolved(
  input: L5eMarkUnresolvedInput,
  context: L5eExecutionContextLike,
): Promise<L5eDeferredResult> {
  if (!context.flags.ENABLE_TOOL_EXEC) {
    return { marked: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
  }
  void input;
  return { deferred: true, reason: "GATE_B_REQUIRED" };
}
