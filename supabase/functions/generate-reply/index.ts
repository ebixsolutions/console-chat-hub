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

import { resolveKBEndpoint, resolveTenantScope, fetchKBRag, type KBFullChunk, type KBDocumentCandidate, type KBResolvedScope, type KBPreActivationActor } from "../_shared/kb-client.ts";
import { evaluateEscalationShadow } from "../_shared/escalation-shadow.ts";
import {
  persistRequiredEscalationClarification,
  persistRequiredEscalationHandoff,
} from "../_shared/escalation-live.ts";
import { availableSignal, createEscalationContextBase, escalationFeatureFlagsFromEnv, type EscalationContext, type EscalationRuleId, type RagMatchState, type TopicRiskLevel } from "../_shared/escalation-signals.ts";
import { evaluateFullEscalationRuleset } from "../_shared/escalation-rules.ts";
import { assessPolicyEvidenceForR4 } from "../_shared/escalation-policy.ts";
import { validateP1PredictionSignals, type P1PredictionInput } from "../_shared/escalation-p1.ts";
import { callModel, resolveGenerationMaxTokens, type LlmFailureCode } from "../_shared/llm-router.ts";
import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildCustomerAdvisoryContext, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";
import { buildCanonicalRetrievalQuery, buildCanonicalContinuityBlock, resolveConversationMemoryResponse } from "../_shared/conversation-runtime-state.ts";
import { selectCanonicalGrounding } from "../_shared/canonical-grounding.ts";
import { buildCitationMetadata } from "../_shared/citation-lineage.ts";
import { buildInheritedTransformCitationMetadata, buildPriorGroundedTransformBlock, resolvePriorGroundedTransform } from "../_shared/prior-grounded-transform.ts";
import { buildRealtimeR3SentimentSignals } from "../_shared/runtime-signal-lifecycle.ts";
import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

type SupabaseAdminClient = SupabaseClient<any, "public", any>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};


const MINIMAL_SAFE_FALLBACK_PROMPT = `You are a professional and friendly customer service assistant.
Answer customer questions clearly, naturally and concisely.
When a request is incomplete, ask one necessary contextual question instead of escalating.
Never expose internal implementation or retrieval terminology.
Keep responses under 150 words.
Respond in the same language and script the customer is using.

${CUSTOMER_CONVERSATION_POLICY}`;

const SAFE_HANDOFF_WORDING: Record<string, string> = {
  "zh-TW": "我們已將你的對話記錄，客服接手後會在此對話中回覆你。目前未啟用即時輪候時間顯示。",
  "zh-CN": "我们已将你的对话记录，客服接手后会在此对话中回复你。目前未启用实时排队位置和预计等待时间显示。",
  en: "We have recorded your conversation. A human agent will reply in this same chat after taking over. Real-time queue position and estimated wait time are not currently enabled.",
};

const REQUIRED_ESCALATION_SAFE_WORDING: Record<
  "E2" | "E1" | "R2",
  Record<"zh-TW" | "zh-CN" | "en", string>
> = {
  E2: {
    "zh-TW": "這個問題需要由客服人員進一步處理。我已將對話轉交客服跟進。",
    "zh-CN": "这个问题需要由客服人员进一步处理。我已将对话转交客服跟进。",
    en: "This issue requires human review. I’ve handed the conversation to a support agent for follow-up.",
  },
  E1: {
    "zh-TW": "這個問題涉及重要風險或政策內容，為確保資訊準確，我已轉交客服人員跟進。",
    "zh-CN": "这个问题涉及重要风险或政策内容，为确保信息准确，我已转交客服人员跟进。",
    en: "This issue involves important risk or policy considerations. I’ve handed it to a support agent for accurate follow-up.",
  },
  R2: {
    "zh-TW": "我目前未能可靠解決這個問題，已將對話轉交客服人員跟進。",
    "zh-CN": "我目前未能可靠解决这个问题，已将对话转交客服人员跟进。",
    en: "I’m not able to resolve this reliably, so I’ve handed the conversation to a support agent for follow-up.",
  },
};

const R2_CLARIFICATION_SAFE_WORDING: Record<"zh-TW" | "zh-CN" | "en", string> = {
  "zh-TW": "我想再確認一次，才能更準確地幫你。請補充這個問題中最重要的細節，例如你希望處理的項目或目前遇到的情況。",
  "zh-CN": "我想再确认一次，才能更准确地帮你。请补充这个问题中最重要的细节，例如你希望处理的项目或目前遇到的情况。",
  en: "I’d like to clarify one detail so I can help more accurately. Please add the most important detail about what you want handled or what is happening now.",
};

const HANDOFF_STRONG_TRIGGERS: Record<string, string[]> = {
  "zh-TW": ["轉真人", "轉人工", "真人客服", "人工客服"],
  "zh-CN": ["转真人", "转人工", "真人客服", "人工客服"],
  en: ["human agent", "live agent", "speak to human", "talk to human", "real person", "human support", "speak with someone", "talk to someone"],
};
const HANDOFF_WEAK_TERMS = ["客服", "人工", "真人"];
const HANDOFF_INTENT_VERBS_ZH = ["要", "想", "找", "轉", "转", "接", "聯絡", "联系", "幫我", "帮我"];
const HANDOFF_INTENT_VERBS_EN = ["speak", "talk", "connect", "need", "want", "get"];
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
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted_email]");
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
  // upstream_call_log is owned exclusively by _shared/llm-router.ts. Keeping a
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
    console.error("[generate-reply] final_prompt_trace insert failed (non-blocking):", e);
  }
}

function buildRouterConversationInput(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
): string {
  return messages
    .slice(-10)
    .map((message, index) => {
      const label = message.role === "user" ? "Visitor" : "Assistant";
      return `[Turn ${index + 1} ${label}]\n${String(message.content ?? "").slice(0, 3000)}`;
    })
    .join("\n\n");
}

function routerFailureHttpStatus(code: LlmFailureCode): number {
  if (code === "LLM_INPUT_BLOCKED") return 400;
  if (code === "LLM_TIMEOUT") return 504;
  if (code === "LLM_CONFIG_MISSING") return 503;
  return 502;
}

function routerFailureToS0(code: LlmFailureCode): string {
  switch (code) {
    case "LLM_TIMEOUT": return "LLM_TIMEOUT";
    case "LLM_NETWORK": return "LLM_NETWORK_ERROR";
    case "LLM_NON_2XX": return "LLM_NON_2XX";
    case "LLM_CONFIG_MISSING": return "LLM_NON_2XX";
    case "LLM_INPUT_BLOCKED": return "LLM_EMPTY_RESPONSE";
    case "LLM_INVALID_OUTPUT": return "LLM_EMPTY_RESPONSE";
  }
}

async function cleanupThinking(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  source_message_id: string | null,
): Promise<void> {
  if (!source_message_id) {
    console.error("[generate-reply] cleanupThinking skipped: missing source_message_id", conversation_id);
    return;
  }
  try {
    await supabaseAdmin.from("messages").delete().eq("conversation_id", conversation_id).eq("content", "__THINKING__").filter("metadata->>source_message_id", "eq", source_message_id);
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
  | { ok: false; error: "source_message_id_required" | "source_message_lookup_failed" | "invalid_source_message" }
> {
  if (
    !source_message_id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source_message_id)
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
  if (!metadataSource || typeof metadataSource !== "object" || Array.isArray(metadataSource)) {
    return undefined;
  }
  const m = metadataSource as Record<string, unknown>;
  if (
    m.widget_live_test !== true ||
    m.exclude_training !== true ||
    typeof m.owner_user_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(m.owner_user_id)
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
  result: { ok: false; error: "source_message_id_required" | "source_message_lookup_failed" | "invalid_source_message" },
): Response {
  const status = result.error === "source_message_lookup_failed" ? 500 : 400;
  return new Response(JSON.stringify({ success: false, error: result.error }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function commitAiReplyWithControlGate(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  source_message_id: string | null,
  content: string,
  metadata: Record<string, unknown> | null = null,
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
        | "superseded_source"
        | "not_found"
        | "rpc_error"
        | "unexpected_result";
    }
> {
  if (!source_message_id) return { ok: false, result: "invalid_source_message" };

  const { data, error } = await supabaseAdmin.rpc("commit_ai_reply_tx", {
    p_conversation_id: conversation_id,
    p_source_message_id: source_message_id,
    p_content: content,
    p_metadata: metadata,
  });

  if (error) {
    console.error("[generate-reply] commit_ai_reply_tx RPC error:", {
      conversation_id,
      code: error.code,
    });
    return { ok: false, result: "rpc_error" };
  }

  const payload = data ?? {};
  const result = String(payload.result ?? data ?? "unexpected_result");

  switch (result) {
    case "success":
      return {
        ok: true,
        message_id: typeof payload.message_id === "string" ? payload.message_id : null,
        idempotent: false,
      };
    case "idempotent":
      return {
        ok: true,
        message_id: typeof payload.message_id === "string" ? payload.message_id : null,
        idempotent: true,
      };
    case "human_control":
    case "resolved":
    case "invalid_source_message":
    case "invalid_content":
    case "source_already_replied":
    case "superseded_source":
    case "not_found":
      return { ok: false, result };
    default:
      return { ok: false, result: "unexpected_result" };
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
  if (lang) return { rule: "R1", confidence: 1.0, trigger_span: text.slice(0, 100), language: lang };
  return { rule: null, confidence: 0, trigger_span: "", language: "zh-TW" };
}

function isGreetingOrTrivial(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, " ").toLowerCase();
  const raw = text.trim();
  const greetingRe =
    /^((hi|hello|hey|你好|嗨|哈囉|早安|午安|晚安|good\s*(morning|afternoon|evening)|thanks|thank you|ok|okay|謝謝|好的|嗯)\s*[!！。.？?，,]*\s*)+$/i;
  const compoundEnRe = /^(hi|hello|hey)\s+(there|everyone|guys|all)[!！。.？?，,\s]*$/i;
  const compoundZhRe = /^(你好|嗨|哈囉|早安|午安|晚安)[，,、\s]*(呀|啊|大家好?|各位好?)[!！。.？?\s]*$/;
  return greetingRe.test(normalized) || compoundEnRe.test(normalized) || compoundZhRe.test(raw);
}

const E2_LOCAL_THREAT_CLASSIFIER_VERSION = "e2-local-threat-v1.0" as const;

function classifyAuthoritativeThreat(text: string): {
  value: true;
  reason: string;
  provider_version: string;
} | undefined {
  const normalized = text.trim().replace(/\s+/g, " ");
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
    console.error("[generate-reply] invalid ESC_E2_COMPLIANCE_REVIEW_BY_TENANT_JSON JSON");
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("[generate-reply] compliance tenant map must be a JSON object");
    return undefined;
  }

  const tenantMap = parsed as Record<string, unknown>;
  if (!(expectedTenantId in tenantMap)) return undefined;
  const value = tenantMap[expectedTenantId];
  if (typeof value !== "boolean") {
    console.error("[generate-reply] compliance tenant value must be boolean", expectedTenantId);
    return undefined;
  }

  return {
    value,
    reason: value ? "tenant_jurisdiction_requires_human_review" : "tenant_jurisdiction_review_not_required",
    provider_version: "e2-tenant-compliance-map-v1.0",
  };
}

function classifyLocalTopicRisk(text: string): { level: "high"; verified: true } | undefined {
  const transactional = [
    /退[款貨]/, /要退/, /申請退/, /我要.*退/,
    /refund\s*(my|this|the)/i, /return\s*(my|this|the)/i,
    /i\s*want\s*(a\s*)?refund/i, /i\s*want\s*to\s*return/i,
    /賠償/, /補償/, /compensation/i, /法律行動/, /legal\s*action/i, /起訴/,
  ];
  const informationOnly = [
    /policy/i, /政策/, /規定/, /條款/,
    /what\s*(is|are)/i, /how\s*(do|does|to)/i, /tell\s*me\s*about/i,
    /請問/, /想了解/, /介紹/, /說明/,
  ];
  const alwaysHigh = [
    /醫療/, /藥品/, /治療/, /medical/i, /medicine/i, /treatment/i,
    /隱私/, /個資/, /資料保護/, /privacy/i, /personal\s*data/i, /gdpr/i,
    /投資/, /理財/, /金融/, /investment/i, /financial/i, /finance/i,
  ];

  const matchesTransactional = transactional.some((re) => re.test(text));
  const matchesInformationOnly = informationOnly.some((re) => re.test(text));
  const matchesAlwaysHigh = alwaysHigh.some((re) => re.test(text));

  const highRisk = matchesAlwaysHigh || (matchesTransactional && !matchesInformationOnly);
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
  return ["angry","anger","furious","rage","irate","憤怒","愤怒","生氣","生气"]
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
    .select("turn_index, sentiment, sentiment_score, trigger_label, occurred_at")
    .eq("evaluation_id", evaluation.id)
    .eq("company_id", expected_tenant_id)
    .order("turn_index", { ascending: true })
    .limit(20);
  if (pointsError || !points || points.length === 0) return undefined;

  const usable = points.map((p) => ({
    turn_index: typeof p.turn_index === "number" ? p.turn_index : -1,
    score: isFiniteScore(p.sentiment_score) ? Number(p.sentiment_score) : undefined,
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
    .sort((a,b) => a.turn_index - b.turn_index)
    .map((p) => p.score as number);

  const latest = [...usable].sort((a,b) => b.turn_index - a.turn_index)[0];
  const latestScore = typeof latest?.score === "number" ? latest.score : undefined;
  const anger = explicitAngerLabel(latest?.sentiment) || explicitAngerLabel(latest?.trigger_label);

  let recovered: true | undefined;
  if (scoreSeries.length >= 2) {
    const previous = scoreSeries[scoreSeries.length - 2];
    const current = scoreSeries[scoreSeries.length - 1];
    if (previous < -0.2 && current >= 0 && current - previous >= 0.3) recovered = true;
  }

  return {
    ...(anger ? { anger_flag: true as const } : {}),
    ...(latestScore !== undefined ? { sentiment_score: latestScore } : {}),
    ...(scoreSeries.length >= 2 ? { sentiment_trend: scoreSeries.slice(-5) } : {}),
    ...(recovered ? { sentiment_recovered_same_turn: true as const } : {}),
    evaluation_id: evaluation.id,
    provider_version: `ce-emotion-history-v1.0:${String(evaluation.evaluation_fingerprint).slice(0, 12)}`,
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
  "a","an","the","and","or","but","if","then","so","as","of","to","for","from","with","without",
  "in","on","at","by","about","into","over","under","is","are","was","were","be","been","being",
  "am","do","does","did","doing","done","can","could","will","would","shall","should","may","might",
  "must","have","has","had","i","me","my","mine","we","us","our","you","your","yours","he","she",
  "it","its","they","them","their","this","that","these","those","there","here","what","which",
  "who","whom","whose","when","where","why","how","not","no","yes","just","still","again","also",
  "any","some","more","most","much","many","very","really","please","thanks","thank","hi","hello",
  "hey","ok","okay","sure","need","want","looking","look","get","got","give","tell","know","help",
  "sell","sells","selling","available","availability","stock","order","buy","purchase","see","use",
]);

function extractMeaningfulTokens(normalized: string): Set<string> {
  const tokens = normalized
    .split(/[^\p{L}\p{N}-]+/u)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length >= 3 && !SAME_INTENT_STOP_WORDS.has(t));
  return new Set(tokens);
}

function compactCjk(normalized: string): string {
  return (normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) ?? []).join("");
}

function ngramSet(text: string, size: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + size <= text.length; i += 1) out.add(text.slice(i, i + size));
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
    if (sharedCount(tokensA, tokensB) >= 3 && containment(tokensA, tokensB) >= 0.7) return true;
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

function buildVerifiedTenantEscalationConfig(): EscalationContext["tenant_config"] {
  const maxConsecutiveNoAnswer = readPositiveIntegerEnv("ESC_MAX_CONSECUTIVE_NO_ANSWER");
  const maxClarifications = readPositiveIntegerEnv("ESC_MAX_CLARIFICATIONS");
  const sentimentThresholdRaw = Deno.env.get("ESC_SENTIMENT_SCORE_THRESHOLD");
  const parsedSentimentThreshold =
    sentimentThresholdRaw !== undefined && sentimentThresholdRaw.trim() !== ""
      ? Number(sentimentThresholdRaw)
      : undefined;
  const sentimentScoreThreshold =
    typeof parsedSentimentThreshold === "number" && Number.isFinite(parsedSentimentThreshold)
      ? parsedSentimentThreshold
      : undefined;
  const slaWarningRaw = Deno.env.get("ESC_SLA_WARNING_SEC");
  const parsedSlaWarning =
    slaWarningRaw !== undefined && slaWarningRaw.trim() !== ""
      ? Number(slaWarningRaw)
      : undefined;
  const slaWarningSec =
    typeof parsedSlaWarning === "number" &&
    Number.isInteger(parsedSlaWarning) &&
    parsedSlaWarning >= 0
      ? parsedSlaWarning
      : undefined;

  const predictedCsatRaw = Deno.env.get("ESC_PREDICTED_CSAT_THRESHOLD");
  const parsedPredictedCsat =
    predictedCsatRaw !== undefined && predictedCsatRaw.trim() !== ""
      ? Number(predictedCsatRaw)
      : undefined;
  const predictedCsatThreshold =
    typeof parsedPredictedCsat === "number" &&
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
  const churnRiskThreshold =
    typeof parsedChurnRisk === "number" &&
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
  const escalationScoreThreshold =
    typeof parsedEscalationScore === "number" &&
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
    ...(slaWarningSec !== undefined
      ? { sla_warning_sec: slaWarningSec }
      : {}),
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

function isE2LiveActivationEnabled(env: { get(name: string): string | undefined }): boolean {
  if (env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") !== "true") return false;
  const flags = escalationFeatureFlagsFromEnv(env);
  return flags.enable_full_ruleset || flags.enable_e2;
}

function isE1LiveActivationEnabled(env: { get(name: string): string | undefined }): boolean {
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
    console.error("[generate-reply] required-rules live blocked: missing source_message_id", params.conversation_id);
    return new Response(
      JSON.stringify({
        success: false,
        error: "required_escalation_missing_source_message_id",
        handoff_persisted: false,
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const handoffClassification = classifyHandoffIntent(params.latest_message_content);
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

  context.conversation_status = availableSignal(params.conversation_status, "conversation_history");
  context.assigned_agent_id = availableSignal(params.assigned_agent_id, "conversation_history");
  context.greeting_or_trivial = availableSignal(params.greeting_or_trivial, "local_classifier");

  if (params.threat_flag !== undefined) {
    context.threat_flag = availableSignal(params.threat_flag.value, "local_classifier", {
      provider_version: params.threat_flag.provider_version,
      observed_at: new Date().toISOString(),
      reason: params.threat_flag.reason,
      ...(params.expected_tenant_id ? { tenant_id: params.expected_tenant_id } : {}),
    });
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
        ...(params.expected_tenant_id ? { tenant_id: params.expected_tenant_id } : {}),
      },
    );
  }

  if (params.rag_match_state !== undefined) {
    context.rag_match_state = availableSignal(params.rag_match_state, "kb_rag");
  }
  if (params.topic_risk_level !== undefined) {
    context.topic_risk_level = availableSignal(params.topic_risk_level, "local_classifier");
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
    context.turn_count = availableSignal(params.turn_count, "conversation_history");
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
    context.same_intent_repeated = availableSignal(true, "conversation_history", {
      reason: "exact_normalized_repeat",
    });
  }

  context.tenant_config = buildVerifiedTenantEscalationConfig();

  const decision = evaluateFullEscalationRuleset(context, {
    activation: { enabled },
  });

  if (decision.decision === "clarify" && decision.matched_rule === "R2" && enabled.has("R2")) {
    const clarification = R2_CLARIFICATION_SAFE_WORDING[params.visitor_language];
    const persisted = await persistRequiredEscalationClarification(supabaseAdmin, {
      conversation_id: params.conversation_id,
      source_message_id: params.source_message_id,
      decision,
      safe_reply_content: clarification,
    });

    if (persisted.ok) {
      await cleanupThinking(supabaseAdmin, params.conversation_id, params.source_message_id);
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
      return new Response(JSON.stringify({ success: true, skipped: "resolved", escalation_rule: "R2" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (persisted.result === "already_under_human_control") {
      return new Response(JSON.stringify({ success: true, skipped: "human_handling", escalation_rule: "R2" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
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
        ...(persisted.result === "rpc_transport_error" ? { handoff_uncertain: true } : {}),
      }),
      {
        status:
          persisted.result === "not_found"
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

  const safeReply =
    REQUIRED_ESCALATION_SAFE_WORDING[decision.matched_rule][params.visitor_language];

  const persisted = await persistRequiredEscalationHandoff(supabaseAdmin, {
    conversation_id: params.conversation_id,
    source_message_id: params.source_message_id,
    decision,
    safe_reply_content: safeReply,
  });

  if (persisted.ok) {
    await cleanupThinking(supabaseAdmin, params.conversation_id, params.source_message_id);
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
        JSON.stringify({ success: true, skipped: "resolved", escalation_rule: decision.matched_rule, handoff_persisted: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_under_human_control":
      return new Response(
        JSON.stringify({ success: true, skipped: "human_handling", escalation_rule: decision.matched_rule, handoff_persisted: false }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "invalid_source_message":
    case "invalid_input":
    case "invalid_rule":
    case "invalid_priority":
    case "invalid_safe_reply":
      return new Response(
        JSON.stringify({ success: false, error: `required_escalation_${persisted.result}`, escalation_rule: decision.matched_rule, handoff_persisted: false }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "rpc_transport_error":
      return new Response(
        JSON.stringify({ success: false, error: "required_escalation_rpc_transport_error", escalation_rule: decision.matched_rule, handoff_persisted: false, handoff_uncertain: true }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "not_found":
      return new Response(
        JSON.stringify({ success: false, error: "required_escalation_conversation_not_found", escalation_rule: decision.matched_rule, handoff_persisted: false }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    default:
      return new Response(
        JSON.stringify({ success: false, error: "required_escalation_unexpected_result", escalation_rule: decision.matched_rule, handoff_persisted: false }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { conversation_id, source_message_id } = body ?? {};
    if (!conversation_id) {
      return new Response(JSON.stringify({ error: "conversation_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ENABLE_KB = Deno.env.get("ENABLE_KB_ADAPTER") !== "false";
    const ENABLE_COACH = Deno.env.get("ENABLE_COACH_PROMPT_ADAPTER") === "true";
    const ENABLE_C360 = Deno.env.get("ENABLE_CUSTOMER360_ADAPTER") === "true";
    const ENABLE_TOOL_EXEC = Deno.env.get("ENABLE_TOOL_EXECUTOR") === "true";

    const ENABLE_PR5_ESCALATION_RUNTIME =
      Deno.env.get("ESC_MVP_FEATURE_FLAG") === "true" ||
      Deno.env.get("ESC_ENABLE_S0") === "true" ||
      Deno.env.get("ESC_SHADOW_MODE") === "true" ||
      Deno.env.get("ESC_ENABLE_REQUIRED_RULES_LIVE") === "true";

    if (
      !ENABLE_KB &&
      !ENABLE_COACH &&
      !ENABLE_C360 &&
      !ENABLE_TOOL_EXEC &&
      !ENABLE_PR5_ESCALATION_RUNTIME
    ) {
      return await legacyGenerateReply(conversation_id, source_message_id ?? null);
    }

    return await orchestrationGenerateReply(
      conversation_id,
      { ENABLE_KB, ENABLE_COACH, ENABLE_C360, ENABLE_TOOL_EXEC },
      source_message_id ?? null,
    );
  } catch (error) {
    console.error("[generate-reply] unexpected error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

async function legacyGenerateReply(conversation_id: string, source_message_id: string | null): Promise<Response> {
  const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL") ?? "", getSupabaseAdminKey());

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("conversations").select("id, status, assigned_agent_id, created_at, company_id").eq("id", conversation_id).single();

  if (convError || !conversation) {
    console.error("[generate-reply] conversation not found:", conversation_id);
    return new Response(JSON.stringify({ error: "Conversation not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if (conversation.status === "resolved") return new Response(JSON.stringify({ success: true, skipped: "resolved" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (isHumanControlState(conversation.status, conversation.assigned_agent_id ?? null)) {
    console.log("[generate-reply] human-handling guard: skipping LLM for status:", conversation.status, conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: "human_handling" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if (conversation.assigned_agent_id) {
    console.log("[generate-reply] S-1 assigned_agent_id guard (legacy):", conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: "assigned_to_agent" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

  if (!newestMessages || newestMessages.length === 0) return new Response(JSON.stringify({ success: true, skipped: "no messages" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const messages = [...newestMessages].reverse();
  const modelMessages: Array<{ role: "user" | "assistant"; content: string }> = messages.map((m) => ({ role: m.role === "visitor" ? "user" : "assistant", content: String(m.content ?? "") }));
  if (modelMessages[modelMessages.length - 1].role === "assistant") return new Response(JSON.stringify({ success: true, skipped: "last message is assistant" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const lastVisitorMsg = sourceVisitorMessage.content;
  const handoffLang = detectHandoffLanguage(lastVisitorMsg);

  if (handoffLang) {
    if (!source_message_id) {
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(
        JSON.stringify({ success: false, error: "legacy_handoff_missing_source_message_id", escalation_rule: "R1", handoff_persisted: false }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: handoffData, error: handoffError } = await supabaseAdmin.rpc(
      "explicit_handoff_tx",
      {
        p_conversation_id: conversation_id,
        p_safe_reply_content: SAFE_HANDOFF_WORDING[handoffLang],
        p_source_message_id: source_message_id,
      },
    );

    if (handoffError) {
      return new Response(
        JSON.stringify({ success: false, error: "legacy_handoff_rpc_transport_error", escalation_rule: "R1", handoff_persisted: false, handoff_uncertain: true }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const handoffResult = String(handoffData?.result ?? "unknown");
    switch (handoffResult) {
      case "success":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: true, escalation_rule: "R1", handoff_persisted: true, rpc_result: "success" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "already_handled":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: true, escalation_rule: "R1", handoff_persisted: true, rpc_result: "already_handled" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "already_resolved":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: true, skipped: "resolved", escalation_rule: "R1", handoff_persisted: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "already_under_human_control":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: true, skipped: "human_handling", escalation_rule: "R1", handoff_persisted: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "invalid_source_message":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: false, error: "legacy_handoff_invalid_source_message", escalation_rule: "R1", handoff_persisted: false }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      case "not_found":
        await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
        return new Response(JSON.stringify({ success: false, error: "legacy_handoff_conversation_not_found", escalation_rule: "R1", handoff_persisted: false }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      default:
        return new Response(JSON.stringify({ success: false, error: "legacy_handoff_unexpected_result", escalation_rule: "R1", handoff_persisted: false, rpc_result: handoffResult }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  }

  const legacySystemPrompt = `You are a professional and friendly customer service assistant.
Answer customer questions clearly and concisely.
If details are missing, ask one concise contextual question. If a fact cannot be verified, say you cannot confirm it and do not guess. Do not offer a human unless the governed escalation layer has decided one is appropriate.
Keep responses under 150 words.
Respond in the same language and script the customer is using.
When the customer explicitly requests a human agent, or when you transfer to a human agent, include a short safe handoff status message in the same language and script as the customer. The message must state that the conversation has been recorded and that a human agent will reply in this same chat after taking over. If the customer is using Traditional Chinese, use: "我們已將你的對話記錄，客服接手後會在此對話中回覆你。目前未啟用即時輪候時間顯示。" If the customer is using Simplified Chinese, use: "我们已将你的对话记录，客服接手后会在此对话中回复你。目前未启用实时排队位置和预计等待时间显示。" If the customer is using English, use: "We have recorded your conversation. A human agent will reply in this same chat after taking over. Real-time queue position and estimated wait time are not currently enabled." Do NOT invent estimated wait times, response-time promises, or queue positions.

${CUSTOMER_CONVERSATION_POLICY}`;

  const llm = await callModel({
    purpose: "generation",
    system: legacySystemPrompt,
    user: buildRouterConversationInput(modelMessages),
    maxTokens: resolveGenerationMaxTokens(),
    operationId: `generate-reply:legacy:${conversation_id}:${source_message_id}`,
    companyId:
      typeof conversation.company_id === "string" && conversation.company_id.length > 0
        ? conversation.company_id
        : null,
    conversationId: conversation_id,
    tag: "generate-reply-legacy",
    responseFormat: "text",
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
      JSON.stringify({ success: false, error: "AI service error", error_code: llm.code }),
      { status: routerFailureHttpStatus(llm.code), headers: { ...corsHeaders, "Content-Type": "application/json" } },
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
      console.log("[generate-reply] stale AI reply suppressed by control gate:", {
        conversation_id,
        result: committed.result,
      });
      return new Response(JSON.stringify({ success: true, skipped: committed.result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: false, error: `ai_reply_commit_${committed.result}` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
  console.log("[generate-reply] AI reply committed for conversation:", conversation_id);
  return new Response(JSON.stringify({ success: true, idempotent: committed.idempotent }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function extractExplicitJurisdictionConstraint(text: string): string | null {
  const t = text.normalize("NFKC").trim();
  const jurisdictions: Array<{ label: string; re: RegExp }> = [
    { label: "Mars", re: /(mars|火星)/ig },
    { label: "香港", re: /(香港|hong\s*kong|\bhk\b)/ig },
    { label: "澳門", re: /(澳門|澳门|macau|macao)/ig },
    { label: "新加坡", re: /(新加坡|singapore)/ig },
    { label: "台灣", re: /(台灣|台湾|taiwan)/ig },
    { label: "中國大陸", re: /(中國大陸|中国大陆|內地|内地|mainland\s*china)/ig },
  ];
  const negatedMars = /(不談|不谈|唔講|唔讲|不要談|不要谈|not\s+(?:talking\s+about|about)|forget\s+about)\s*(mars|火星)/i.test(t);
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
    `${chunk.title ?? ""}\n${chunk.content ?? ""}`.toLocaleLowerCase().includes(needle)
  );
}


type FlagSet = { ENABLE_KB: boolean; ENABLE_COACH: boolean; ENABLE_C360: boolean; ENABLE_TOOL_EXEC: boolean };

const KB_FALLBACK_SAFE_TEXT: Record<string, Record<string, string>> = {
  KB_SCOPE_GATE: { "zh-TW": "很抱歉，系統暫時無法查詢知識庫。讓我為您轉接客服人員。", "zh-CN": "很抱歉，系统暂时无法查询知识库。让我为您转接客服人员。", en: "Sorry, the knowledge base is temporarily unavailable. Let me connect you with a human agent." },
  KB_API_FAIL: { "zh-TW": "系統暫時無法查詢知識庫，讓我為您轉接客服人員。", "zh-CN": "系统暂时无法查询知识库，让我为您转接客服人员。", en: "The knowledge base is temporarily unavailable. Let me connect you with a human agent." },
  KB_EMPTY: { "zh-TW": "很抱歉，我目前無法確定答案。讓我為您轉接客服人員，以提供更準確的協助。", "zh-CN": "很抱歉，我目前无法确定答案。让我为您转接客服人员，以提供更准确的协助。", en: "Sorry, I'm unable to find a definitive answer. Let me connect you with a human agent for more accurate assistance." },
  KB_LOW_SCORE_HIGH_RISK: { "zh-TW": "這個問題涉及重要政策，為確保您獲得準確資訊，讓我為您轉接客服人員。", "zh-CN": "这个问题涉及重要政策，为确保您获得准确信息，让我为您转接客服人员。", en: "This question involves important policy matters. To ensure you receive accurate information, let me connect you with a human agent." },
  KB_LOW_SCORE_STANDARD: { "zh-TW": "很抱歉，我目前無法確定答案。讓我為您轉接客服人員，以提供更準確的協助。", "zh-CN": "很抱歉，我目前无法确定答案。让我为您转接客服人员，以提供更准确的协助。", en: "Sorry, I'm unable to find a definitive answer. Let me connect you with a human agent for more accurate assistance." },
};

const S0_LLM_FAILURE_SAFE_TEXT: Record<string, string> = {
  "zh-TW": "系統暫時無法完成回覆，我已為你轉交客服人員跟進。",
  "zh-CN": "系统暂时无法完成回复，我已为你转交客服人员跟进。",
  en: "The system is temporarily unable to complete a response. I\u2019ve handed this conversation to a support agent for follow-up.",
};

function detectVisitorLanguage(text: string): "zh-TW" | "zh-CN" | "en" {
  if (!text) return "zh-TW";
  if (!/[\u4e00-\u9fff]/.test(text)) return "en";
  const zhCnIndicators = ["转", "们", "队", "预计", "为您", "为我", "为你", "请", "这", "没"];
  if (zhCnIndicators.some((c) => text.includes(c))) return "zh-CN";
  return "zh-TW";
}

type KBFallbackRpcResult = "success" | "already_handled" | "already_resolved" | "already_under_human_control" | "invalid_source_message" | "invalid_branch" | "not_found";

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
const KB_NO_MATCH_CLARIFICATION_TEXT: Record<"zh-TW" | "zh-CN" | "en", string> = {
  "zh-TW": "為了幫你找到準確的資料，可以再補充一點細節嗎？例如你想了解的產品、服務或具體情況。",
  "zh-CN": "为了帮你找到准确的资料，可以再补充一点细节吗？例如你想了解的产品、服务或具体情况。",
  en: "To find the right information for you, could you share a bit more detail — for example the product, service, or specific situation you're asking about?",
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
  if (input.branch_tag !== "KB_EMPTY" && input.branch_tag !== "KB_LOW_SCORE_STANDARD") return false;
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
  eligibility: Omit<Parameters<typeof isFirstNoMatchClarificationEligible>[0], "branch_tag" | "source_message_id">,
  traceMetadata: Record<string, unknown>,
): Promise<Response | null> {
  if (!isFirstNoMatchClarificationEligible({ ...eligibility, branch_tag: branchTag, source_message_id })) {
    return null;
  }

  const content = KB_NO_MATCH_CLARIFICATION_TEXT[visitorLang] ?? KB_NO_MATCH_CLARIFICATION_TEXT["zh-TW"];
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
    if (commit.result === "human_control" || commit.result === "resolved" || commit.result === "superseded_source") {
      return new Response(
        JSON.stringify({ success: true, skipped: commit.result, response_route: KB_NO_MATCH_CLARIFICATION_ROUTE, handoff_required: false }),
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
      trace_metadata: { ...traceMetadata, branch: branchTag, clarification_persisted: true, idempotent: commit.idempotent },
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function handleKBFallback(
  supabaseAdmin: SupabaseAdminClient, conversation_id: string, branchTag: string,
  source_message_id: string | null, traceMetadata: Record<string, unknown>, visitorLang: "zh-TW" | "zh-CN" | "en" = "zh-TW",
): Promise<Response> {
  const _branchTexts = KB_FALLBACK_SAFE_TEXT[branchTag];
  const safeText = _branchTexts ? (_branchTexts[visitorLang] ?? _branchTexts["zh-TW"]) : undefined;
  if (!safeText) return new Response(JSON.stringify({ success: false, error: "kb_fallback_unknown_branch", no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, branch: branchTag, handoff_persisted: false } }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (!source_message_id) return new Response(JSON.stringify({ success: false, error: "kb_fallback_missing_source_id", reply: safeText, no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc("kb_fallback_handoff_tx", { p_conversation_id: conversation_id, p_safe_reply_content: safeText, p_branch_tag: branchTag, p_source_message_id: source_message_id });
  if (rpcErr) return new Response(JSON.stringify({ success: false, error: "kb_fallback_persistence_failed", reply: safeText, no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  const result: string = rpcData?.result ?? "unknown";
  switch (result as KBFallbackRpcResult | "unknown") {
    case "success": return new Response(JSON.stringify({ success: true, reply: safeText, no_answer: true, handoff_required: true, handoff_persisted: true, trace_metadata: { ...traceMetadata, rpc_result: "success", handoff_persisted: true } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_handled": return new Response(JSON.stringify({ success: true, reply: null, no_answer: true, handoff_required: false, handoff_persisted: true, trace_metadata: { ...traceMetadata, rpc_result: "already_handled", handoff_persisted: true, existing_branch: rpcData?.existing_branch, requested_branch: rpcData?.requested_branch } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_resolved": return new Response(JSON.stringify({ success: false, error: "conversation_resolved", reply: null, no_answer: false, handoff_required: false, handoff_persisted: false, trace_metadata: { ...traceMetadata, rpc_result: "already_resolved", handoff_persisted: false } }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_under_human_control": return new Response(JSON.stringify({ success: true, reply: null, no_answer: false, handoff_required: false, handoff_persisted: false, trace_metadata: { ...traceMetadata, rpc_result: "already_under_human_control", handoff_persisted: false } }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_source_message": return new Response(JSON.stringify({ success: false, error: "kb_fallback_invalid_source", reply: safeText, no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_branch": return new Response(JSON.stringify({ success: false, error: "kb_fallback_invalid_branch", no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "not_found": return new Response(JSON.stringify({ success: false, error: "kb_fallback_conversation_not_found", no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    default: return new Response(JSON.stringify({ success: false, error: "kb_fallback_unexpected_result", reply: safeText, no_answer: true, handoff_required: true, handoff_persisted: false, trace_metadata: { ...traceMetadata, handoff_persisted: false } }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

async function handleS0Handoff(
  supabaseAdmin: SupabaseAdminClient, conversation_id: string, source_message_id: string | null,
  failure_type: string, visitorLang: "zh-TW" | "zh-CN" | "en",
): Promise<Response> {
  const isKBFailure = failure_type === "KB_SCOPE_GATE" || failure_type === "KB_API_FAIL";
  let safeReply: string;
  if (isKBFailure) {
    const branchTexts = KB_FALLBACK_SAFE_TEXT[failure_type];
    safeReply = branchTexts?.[visitorLang] ?? branchTexts?.["zh-TW"] ?? "";
  } else safeReply = S0_LLM_FAILURE_SAFE_TEXT[visitorLang] ?? S0_LLM_FAILURE_SAFE_TEXT["zh-TW"];

  if (!safeReply) return new Response(JSON.stringify({ success: false, error: "s0_no_safe_reply", failure_type }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (!source_message_id) return new Response(JSON.stringify({ success: false, error: "s0_missing_source_message_id", failure_type }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc("s0_handoff_tx", { p_conversation_id: conversation_id, p_safe_reply_content: safeReply, p_source_message_id: source_message_id, p_failure_type: failure_type });
  if (rpcErr) return new Response(JSON.stringify({ success: false, error: "s0_rpc_transport_error", failure_type, handoff_persisted: false, handoff_uncertain: true }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const _s0Result: string = rpcData?.result ?? "unknown";
  switch (_s0Result) {
    case "success": await cleanupThinking(supabaseAdmin, conversation_id, source_message_id); return new Response(JSON.stringify({ success: true, escalation_rule: "S0", failure_type, handoff_persisted: true, rpc_result: "success" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_handled": return new Response(JSON.stringify({ success: true, escalation_rule: "S0", failure_type, handoff_persisted: true, rpc_result: "already_handled" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_resolved": return new Response(JSON.stringify({ success: true, skipped: "resolved", escalation_rule: "S0", failure_type, handoff_persisted: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "already_under_human_control": return new Response(JSON.stringify({ success: true, skipped: "human_handling", escalation_rule: "S0", failure_type, handoff_persisted: false }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_source_message": return new Response(JSON.stringify({ success: false, error: "s0_invalid_source_message", escalation_rule: "S0", failure_type }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_input": return new Response(JSON.stringify({ success: false, error: "s0_invalid_input", escalation_rule: "S0", failure_type }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "invalid_failure_type": return new Response(JSON.stringify({ success: false, error: "s0_invalid_failure_type", escalation_rule: "S0", failure_type }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    case "not_found": return new Response(JSON.stringify({ success: false, error: "s0_conversation_not_found", escalation_rule: "S0", failure_type }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    default: return new Response(JSON.stringify({ success: false, error: "s0_rpc_unknown_result", escalation_rule: "S0", failure_type, rpc_result: _s0Result }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
}

async function persistExplicitR1IfRequested(
  supabaseAdmin: SupabaseAdminClient,
  conversation_id: string,
  source_message_id: string | null,
  latestMessage: string,
): Promise<Response | null> {
  const classified = classifyExplicitHandoff(latestMessage);
  if (classified.rule !== "R1") return null;
  if (!source_message_id) {
    return new Response(JSON.stringify({ success: false, error: "esc_missing_source_message_id", escalation_rule: "R1", handoff_persisted: false }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const { data, error } = await supabaseAdmin.rpc("explicit_handoff_tx", {
    p_conversation_id: conversation_id,
    p_safe_reply_content: SAFE_HANDOFF_WORDING[classified.language],
    p_source_message_id: source_message_id,
  });
  if (error) {
    return new Response(JSON.stringify({ success: false, error: "esc_rpc_transport_error", escalation_rule: "R1", handoff_persisted: false, handoff_uncertain: true }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  const result: string = data?.result ?? "unknown";
  switch (result) {
    case "success":
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      return new Response(JSON.stringify({ success:true, escalation_rule:"R1", handoff_persisted:true, rpc_result:"success" }), { headers:{...corsHeaders,"Content-Type":"application/json"} });
    case "already_handled":
      return new Response(JSON.stringify({ success:true, escalation_rule:"R1", handoff_persisted:true, rpc_result:"already_handled" }), { headers:{...corsHeaders,"Content-Type":"application/json"} });
    case "already_resolved":
      return new Response(JSON.stringify({ success:true, skipped:"resolved", escalation_rule:"R1", handoff_persisted:false }), { headers:{...corsHeaders,"Content-Type":"application/json"} });
    case "already_under_human_control":
      return new Response(JSON.stringify({ success:true, skipped:"human_handling", escalation_rule:"R1", handoff_persisted:false }), { headers:{...corsHeaders,"Content-Type":"application/json"} });
    case "not_found":
      return new Response(JSON.stringify({ success:false, error:"esc_conversation_not_found", escalation_rule:"R1" }), { status:404, headers:{...corsHeaders,"Content-Type":"application/json"} });
    case "invalid_source_message":
      return new Response(JSON.stringify({ success:false, error:"esc_invalid_source_message", escalation_rule:"R1" }), { status:400, headers:{...corsHeaders,"Content-Type":"application/json"} });
    default:
      return new Response(JSON.stringify({ success:false, error:"esc_rpc_unknown_result", escalation_rule:"R1", rpc_result:result }), { status:500, headers:{...corsHeaders,"Content-Type":"application/json"} });
  }
}

async function orchestrationGenerateReply(conversation_id: string, flags: FlagSet, source_message_id: string | null): Promise<Response> {
  const supabaseAdmin = createClient(Deno.env.get("SUPABASE_URL") ?? "", getSupabaseAdminKey());
  const { data: conversation, error: convError } = await supabaseAdmin.from("conversations").select("id, status, assigned_agent_id, created_at, company_id, metadata_source").eq("id", conversation_id).single();
  if (convError || !conversation) return new Response(JSON.stringify({ error: "Conversation not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  if (conversation.status === "resolved" || conversation.status === "closed") {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return safeRefusal("CONV_RESOLVED_OR_CLOSED");
  }
  if (isHumanControlState(conversation.status, conversation.assigned_agent_id ?? null)) {
    console.log("[generate-reply] orchestration human-handling guard:", conversation.status, conversation_id);
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ success: true, skipped: "human_handling" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (conversation.assigned_agent_id) {
    console.log("[generate-reply] S-1 assigned_agent_id guard (orchestration):", conversation_id);
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ success: true, skipped: "assigned_to_agent" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
  const _h1LastMsg = sourceVisitorMessage.content;

  const [
    { data: _pr5HistoryRows },
    { count: _pr5VisitorTurnCount },
  ] = await Promise.all([
    supabaseAdmin
      .from("messages")
      .select("role, content, created_at, metadata")
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
  const _conversationContinuityBlock = buildCanonicalContinuityBlock(_pr5HistoryRows ?? []);


  const _visitorLang = detectVisitorLanguage(_h1LastMsg);
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
  const _pr5ExpectedTenantId =
    typeof conversation.company_id === "string" && conversation.company_id.length > 0
      ? conversation.company_id
      : undefined;
  const _widgetLiveTestActor =
    _pr5ExpectedTenantId === undefined
      ? widgetLiveTestPreActivationActor(conversation.metadata_source)
      : undefined;
  const _pr5ThreatSignal = classifyAuthoritativeThreat(_h1LastMsg);
  const _pr5ComplianceSignal = resolveAuthoritativeComplianceReview(_pr5ExpectedTenantId);
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
  const _pr5ConversationDurationSec =
    conversation.created_at
      ? Math.max(0, Math.floor((Date.now() - new Date(conversation.created_at).getTime()) / 1000))
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
      sentiment_recovered_same_turn: _pr5R3Sentiment?.sentiment_recovered_same_turn,
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
    const _pr5E2PreflightResponse = await evaluateAndPersistRequiredRulesLive(supabaseAdmin, {
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
    });
    if (_pr5E2PreflightResponse) return _pr5E2PreflightResponse;
  }

  const _deferR1ForE1 =
    isE1LiveActivationEnabled(Deno.env) &&
    _pr5LocalRisk?.level === "high" &&
    flags.ENABLE_KB &&
    !_pr5GreetingOrTrivial;

  if (!_deferR1ForE1) {
    const r1Response = await persistExplicitR1IfRequested(
      supabaseAdmin, conversation_id, source_message_id, _h1LastMsg,
    );
    if (r1Response) return r1Response;
  }

  const _conversationMemoryReply = resolveConversationMemoryResponse(_h1LastMsg, _pr5HistoryRows ?? []);
  if (_conversationMemoryReply) {
    const committed = await commitAiReplyWithControlGate(supabaseAdmin, conversation_id, source_message_id, _conversationMemoryReply, { response_route: "conversation_memory", conversation_grounded: true });
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    if (!committed.ok) {
      if (committed.result === "human_control" || committed.result === "resolved" || committed.result === "superseded_source") return new Response(JSON.stringify({ success: true, skipped: committed.result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      return new Response(JSON.stringify({ success: false, error: `conversation_memory_commit_${committed.result}` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: true, response_route: "conversation_memory", conversation_grounded: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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

  if (flags.ENABLE_COACH) {
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
          error_type:
            promptResult.error_type ?? "COACH_UNKNOWN_FAILURE",
          retryable:
            promptResult.error_type === "COACH_API_TIMEOUT" ||
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
  } | null = null;
  let opaqueCustomerRef: string | null = null;
  if (flags.ENABLE_C360) {
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

  if (flags.ENABLE_KB && !_g1SkipKB) {
    const _kbTenantResult = await resolveTenantScope(conversation_id, _widgetLiveTestActor);
    if (!_kbTenantResult.resolved) {
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, _h1LastMsg);
        if (r1Response) return r1Response;
      }
      if (_escEnableS0) return await handleS0Handoff(supabaseAdmin, conversation_id, source_message_id, "KB_SCOPE_GATE", _visitorLang);
      return await handleKBFallback(supabaseAdmin, conversation_id, "KB_SCOPE_GATE", source_message_id, { rag_api_status: "scope_unavailable" }, _visitorLang);
    }
    const _semanticRetrieval = buildCanonicalRetrievalQuery(_h1LastMsg, _pr5HistoryRows ?? []);
    const userQuery = _semanticRetrieval.query;
    ragResult = !userQuery ? { success: true, no_answer: true, retrieval_quality: "failed", chunks: [] } : await callKBAdapter(conversation_id, userQuery, _kbTenantResult.scope);
    if (!ragResult || !ragResult.success) {
      if (_deferR1ForE1) {
        const r1Response = await persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, _h1LastMsg);
        if (r1Response) return r1Response;
      }
      if (_escEnableS0) return await handleS0Handoff(supabaseAdmin, conversation_id, source_message_id, "KB_API_FAIL", _visitorLang);
      return await handleKBFallback(supabaseAdmin, conversation_id, "KB_API_FAIL", source_message_id, { rag_api_status: "failure" }, _visitorLang);
    }
    if (ragResult.no_answer || !ragResult.chunks || ragResult.chunks.length === 0) {
      _pr5RagMatchState = "no_match";
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
        "KB_EMPTY",
        _visitorLang,
        {
          high_risk: _pr5LocalRisk?.level === "high",
          explicit_human_request: isHandoffIntent(_h1LastMsg),
          threat_flag: _pr5ThreatSignal?.value === true,
          compliance_requires_human_review: _pr5ComplianceSignal?.value === true,
          clarification_attempts: _pr5History.clarification_attempts,
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated === true,
        },
        { rag_api_status: "success_empty" },
      );
      if (clarification) return clarification;
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        "KB_EMPTY",
        source_message_id,
        { rag_api_status: "success_empty" },
        _visitorLang,
      );
    }

    const isHighRisk = _pr5LocalRisk?.level === "high";
    const minScore = isHighRisk ? 0.78 : 0.55;
    const _groundingSelection = selectCanonicalGrounding(ragResult.documents ?? [], {
      minScore,
      requirePublished: true,
      requestText: userQuery,
    });
    const _scoreUsableChunks = _groundingSelection.ok ? _groundingSelection.chunks : [];
    const _explicitJurisdiction = extractExplicitJurisdictionConstraint(_h1LastMsg);
    const _jurisdictionSupported = evidenceSupportsJurisdiction(_explicitJurisdiction, _scoreUsableChunks);
    const usableChunks = _jurisdictionSupported ? _scoreUsableChunks : [];
    const traceMetadata = { rag_api_status: "success", total_results: ragResult.chunks.length, filtered_results: usableChunks.length, jurisdiction_constraint: _explicitJurisdiction, jurisdiction_supported: _jurisdictionSupported, min_score_used: usableChunks.length > 0 ? Math.min(...usableChunks.map((c) => c.score ?? 0)) : null, max_score_used: usableChunks.length > 0 ? Math.max(...usableChunks.map((c) => c.score ?? 0)) : null, high_risk_topic: isHighRisk, min_threshold: minScore, citations: usableChunks.map((c) => ({ doc_id: c.doc_id, chunk_id: c.chunk_id, title: c.title, score: c.score, source_type: c.source_type })) };
    ragResult.trace_metadata = traceMetadata;
    if (usableChunks.length === 0) {
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
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated === true,
        },
        traceMetadata,
      );
      if (clarification) return clarification;
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
          exact_same_intent_repeated: _pr5History.exact_same_intent_repeated === true,
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
    ragResult.chunks = usableChunks;
    ragResult.no_answer = false;

    const usableSummary = usableChunks.find((c) => c.chunk_type === "rag_summary");
    const usableFullContent = usableChunks
      .filter((c) => c.chunk_type === "full_content")
      .slice(0, 3);
    const selectedDocumentId =
      usableChunks[0]?.document_id ?? usableChunks[0]?.doc_id;

    ragResult.llm_context =
      selectedDocumentId
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
    _kbDone = true;
  }
  if (!flags.ENABLE_KB || _g1SkipKB) _kbDone = true;
  if (flags.ENABLE_KB && !_g1SkipKB && !_kbDone) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ error: "Internal KB processing error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  let _pr5R4Policy:
    | { match_state: "confident_match" | "partial_match" | "conflict" | "no_match" | "unavailable"; provider_version: string; reason: string }
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
          operation_id: `generate-reply:r4-policy:${conversation_id}:${source_message_id ?? "none"}`,
        },
      );
    }
  }

  if (Deno.env.get("ESC_SHADOW_MODE") === "true" && _pr5LocalRisk?.level === "high") {
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

  const _pr5RequiredLiveResponse = await evaluateAndPersistRequiredRulesLive(supabaseAdmin, {
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
  if (_pr5RequiredLiveResponse) return _pr5RequiredLiveResponse;

  if (_deferR1ForE1) {
    const r1Response = await persistExplicitR1IfRequested(supabaseAdmin, conversation_id, source_message_id, _h1LastMsg);
    if (r1Response) return r1Response;
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
      sentiment_recovered_same_turn: _pr5R3Sentiment?.sentiment_recovered_same_turn,
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

  if (flags.ENABLE_TOOL_EXEC) console.log("[generate-reply] ENABLE_TOOL_EXECUTOR=true: Gate present, tools NOT attached (L5d scope)");

  const _customerAdvisoryBlock = buildCustomerAdvisoryContext({
    tier: customerContext?.tier,
    anger_flag: _pr5R3Sentiment?.anger_flag,
    sentiment_score: _pr5R3Sentiment?.sentiment_score,
    churn_risk: customerContext?.churn_risk,
    escalation_score: customerContext?.escalation_score,
  });
  const finalSystemPrompt = [
    basePrompt,
    CUSTOMER_CONVERSATION_POLICY,
    _conversationContinuityBlock,
    _customerAdvisoryBlock,
    buildMaskedContextBlock(customerContext, opaqueCustomerRef),
    buildRagBlock(ragResult),
    buildPriorGroundedTransformBlock(_priorGroundedTransform),
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
  if (!newestMessages || newestMessages.length === 0) { await cleanupThinking(supabaseAdmin, conversation_id, source_message_id); return new Response(JSON.stringify({ success: true, skipped: "no messages" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
  const messages = [...newestMessages].reverse();
  const modelMessages: Array<{ role: "user" | "assistant"; content: string }> = messages.map((m) => ({ role: m.role === "visitor" ? "user" : "assistant", content: String(m.content ?? "") }));
  if (modelMessages[modelMessages.length - 1].role === "assistant") { await cleanupThinking(supabaseAdmin, conversation_id, source_message_id); return new Response(JSON.stringify({ success: true, skipped: "last message is assistant" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

  if (flags.ENABLE_TOOL_EXEC) {
    console.warn(
      "[generate-reply] TOOL_EXECUTOR_NOT_READY: tools withheld from governed LLM request",
      { conversation_id },
    );
  }

  const llm = await callModel({
    purpose: "generation",
    system: finalSystemPrompt,
    user: buildRouterConversationInput(modelMessages),
    maxTokens: resolveGenerationMaxTokens(),
    operationId: `generate-reply:orchestration:${conversation_id}:${source_message_id}`,
    companyId:
      typeof conversation.company_id === "string" && conversation.company_id.length > 0
        ? conversation.company_id
        : null,
    conversationId: conversation_id,
    tag: "generate-reply-orchestration",
    responseFormat: "text",
  });

  if (!llm.ok) {
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
      JSON.stringify({ success: false, error: "AI service error", error_code: llm.code }),
      { status: routerFailureHttpStatus(llm.code), headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const aiReplyContent = llm.text;

  const citationMeta = _priorGroundedTransform
    ? buildInheritedTransformCitationMetadata(_priorGroundedTransform)
    : finalPromptChunks.length > 0
      ? buildCitationMetadata(
          finalPromptChunks,
          ragResult?.llm_context?.selected_document_id ?? null,
        )
      : null;
  if (_priorGroundedTransform && !citationMeta) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: false, error: "prior_grounded_transform_lineage_unavailable" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  if (flags.ENABLE_KB && !_g1SkipKB && finalPromptChunks.length > 0 && !citationMeta) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(
      JSON.stringify({ success: false, error: "citation_lineage_unavailable" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
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
      return new Response(JSON.stringify({ success: true, skipped: committed.result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ success: false, error: `ai_reply_commit_${committed.result}` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
  if (flags.ENABLE_COACH) void coachTrace;
  if (flags.ENABLE_KB && ragResult?.success) void ragResult;
  console.log("[generate-reply] AI reply committed (orchestration path) for conversation:", conversation_id);
  return new Response(JSON.stringify({ success: true, idempotent: committed.idempotent }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function safeRefusal(code: string): Response {
  return new Response(JSON.stringify({ success: true, skipped: "refused", reason_code: code, handoff_required: true }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
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
  if (customerContext.tier) parts.push(`Customer tier: ${customerContext.tier}`);
  if (customerContext.masked_summary) parts.push(customerContext.masked_summary);
  if (opaqueCustomerRef) parts.push(`Customer reference (pseudonymous): ${pseudonymizeRef(opaqueCustomerRef)}`);
  return parts.length === 0 ? "" : `Customer context (masked):\n${parts.join("\n")}`;
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
      "- The RAG summary is orientation only; never use it alone for exact facts.",
      "- Prices, dates, dimensions, policy conditions, procedures, limits, and other exact facts MUST be supported by Full Content Evidence.",
      "- If Full Content Evidence does not support an exact claim, state that the knowledge base does not provide enough evidence and offer human assistance.",
      `Selected document: ${context.selected_document_id}`,
    ];

    if (context.orientation_summary) {
      sections.push(
        `Orientation Summary (not sufficient by itself for exact facts):\n${context.orientation_summary.slice(0, 1200)}`,
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
      ? `Full Content Evidence:\n${evidence
          .map((c, i) => `[${i + 1}]\n${(c.content ?? c.short_snippet ?? "").slice(0, 1200)}`)
          .join("\n\n")}`
      : "Full Content Evidence: none. Do not assert exact facts.",
  ].filter(Boolean).join("\n\n");
}

function pseudonymizeRef(ref: string): string {
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = ((h << 5) - h + ref.charCodeAt(i)) | 0;
  return `cust_${(h >>> 0).toString(36)}`;
}

async function callCoachPromptAdapter(conversation_id: string): Promise<{ success: boolean; content?: string; version_id?: string; version_label?: string; prompt_hash?: string; error_type?: string }> {
  const FAIL = (error_type: string) => ({ success: false as const, error_type });
  const endpoint = Deno.env.get("COACH_PROMPT_ENDPOINT");
  const token = Deno.env.get("COACH_PROMPT_INTERNAL_TOKEN");
  const timeoutMs = parseInt(Deno.env.get("COACH_AI_TIMEOUT_MS") || "3000");
  if (!endpoint) return FAIL("COACH_API_NOT_CONFIGURED");
  if (!token) return FAIL("COACH_TOKEN_MISSING");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "x-coach-internal-token": token, "x-coach-runtime": "C0", "Content-Type": "application/json" }, body: JSON.stringify({ include_content: true }), signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return FAIL("COACH_API_ERROR");
    let data; try { data = await response.json(); } catch { return FAIL("COACH_JSON_INVALID"); }
    if (!data.ok || !data.data?.content) return FAIL("COACH_NO_ACTIVE_PROMPT");
    const content = data.data.content;
    const validationError = validateCoachPromptContent(content);
    if (validationError) return FAIL(validationError);
    const versionId = data.data.id || "";
    const promptHash = await computePromptHash(content, versionId, conversation_id);
    return { success: true, content, version_id: versionId, version_label: data.data.label || "", prompt_hash: promptHash };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === "AbortError") return FAIL("COACH_API_TIMEOUT");
    return FAIL("COACH_API_EXCEPTION");
  }
}

function validateCoachPromptContent(content: unknown): string | null {
  if (typeof content !== "string") return "COACH_SCHEMA_INVALID";
  if (content.length === 0) return "COACH_CONTENT_EMPTY";
  if (content.length > 20000) return "COACH_CONTENT_TOO_LONG";
  if (/sk-ant-[a-zA-Z0-9]+/.test(content) || /service_role/.test(content)) return "COACH_SCHEMA_INVALID";
  return null;
}

async function computePromptHash(content: string, versionId: string, conversationId: string): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content + "|" + versionId + "|" + conversationId));
  return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 12);
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

  const endpoint = `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/customer360-adapter`;
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
    return { success: false, error_type: `C360_CALLER_HTTP_${response.status}` };
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
    const errorObj = data.error && typeof data.error === "object" && !Array.isArray(data.error)
      ? data.error as Record<string, unknown>
      : null;
    const code = errorObj && typeof errorObj.error_code === "string"
      ? errorObj.error_code.slice(0, 80)
      : "C360_UPSTREAM_DEGRADED";
    return { success: false, error_type: code };
  }

  const context = data.customer_context && typeof data.customer_context === "object" && !Array.isArray(data.customer_context)
      ? data.customer_context as Record<string, unknown>
      : null;

  const customerRef =
    typeof data.customer_ref === "string" &&
    /^cus_[A-Za-z0-9_-]{16,64}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.customer_ref)
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

  if (typeof context.masked_summary === "string" && context.masked_summary.trim()) {
    safeContext.masked_summary = context.masked_summary.trim().slice(0, 1000);
  }
  if (typeof context.tier === "string" && context.tier.trim()) {
    safeContext.tier = context.tier.trim().slice(0, 100);
  }
  if (typeof context.predicted_csat === "number" && Number.isFinite(context.predicted_csat)) {
    safeContext.predicted_csat = context.predicted_csat;
  }
  if (typeof context.churn_risk === "number" && Number.isFinite(context.churn_risk)) {
    safeContext.churn_risk = context.churn_risk;
  }
  if (typeof context.escalation_score === "number" && Number.isFinite(context.escalation_score)) {
    safeContext.escalation_score = context.escalation_score;
  }
  if (typeof context.p1_provider_version === "string" && context.p1_provider_version.trim()) {
    safeContext.p1_provider_version = context.p1_provider_version.trim().slice(0, 120);
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
  if (!endpointCfg) return { success: false, no_answer: true, retrieval_quality: "failed" };
  const result = await fetchKBRag({ query: userMessage, top_k: 5 }, scope, endpointCfg, { timeoutMs: 15000 });
  if (!result.success) return { success: false, no_answer: true, retrieval_quality: "failed" };
  if (result.chunks.length === 0) return { success: true, no_answer: true, retrieval_quality: "failed", chunks: [], query_text_preview: userMessage.slice(0, 100) };
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
interface GateDecision { decision: GateDecisionKind; reason?: string; execution_allowed?: boolean; force_draft?: boolean; handoff_required?: boolean; execution_deferred_to?: "L5d"; draft_enforcement_deferred_to?: "L5e"; action_deferred_to?: "L5e"; message_to_llm?: string; }
interface ToolRequest { tool_name: string; input: Record<string, unknown>; }
interface ExecutionContext { conversation: { id: string; status: string }; caller_mode: "system_auto" | "human_agent" | "ai_assist"; risk_level: "low" | "medium" | "high"; privacy_flags?: { do_not_profile?: boolean; consent_status?: "granted" | "withdrawn" | "unknown" }; turn_tool_calls: Set<string>; turn_budget: { total: number; kb_search: number; c360: number }; server_resolved_customer_ref?: string | null; }
const ALLOWED_TOOLS = ["kb_search", "escalate_to_human", "get_customer_context", "get_order_summary", "create_handoff_summary", "mark_unresolved", "suggest_reply"] as const;
const READ_ONLY_TOOLS = ["kb_search", "get_customer_context", "get_order_summary"] as const;
const HIGH_RISK_ALLOWED = ["kb_search", "get_customer_context", "escalate_to_human", "create_handoff_summary"] as const;
const OFFLINE_BOT_ALLOWED = ["kb_search", "escalate_to_human"] as const;
const MAX_TOOL_CALLS = 10, MAX_KB_SEARCH = 3, MAX_C360_CALLS = 2;

function buildSafeDedupeKey(tool_name: string, input: Record<string, unknown>, server_resolved_customer_ref?: string | null): string | null {
  if (tool_name === "get_order_summary") return server_resolved_customer_ref ? `get_order_summary:${server_resolved_customer_ref}` : null;
  const SAFE_FIELDS: Record<string, string[]> = { kb_search: ["query_norm", "locale"], get_customer_context: [], escalate_to_human: ["reason_code"], create_handoff_summary: ["reason_code"], mark_unresolved: ["reason_code"], suggest_reply: ["intent_code"] };
  const safe: Record<string, unknown> = {};
  for (const k of SAFE_FIELDS[tool_name] ?? []) if (input[k] !== undefined && typeof input[k] !== "object") safe[k] = String(input[k]).slice(0, 200);
  return `${tool_name}:${JSON.stringify(safe)}`;
}

export function toolExecutorGate(toolRequest: ToolRequest, context: ExecutionContext): GateDecision {
  const { tool_name, input } = toolRequest; const { conversation, caller_mode, risk_level, privacy_flags, turn_tool_calls, turn_budget, server_resolved_customer_ref } = context;
  if (tool_name === "schedule_feedback_request") return { decision: "DENY", reason: "TOOL_EXCLUDED" };
  if (!(ALLOWED_TOOLS as readonly string[]).includes(tool_name)) return { decision: "DENY", reason: "TOOL_NOT_REGISTERED" };
  const status = conversation.status;
  if (status === "resolved" || status === "closed") return { decision: "DENY", reason: "CONV_RESOLVED_OR_CLOSED" };
  if ((status === "human_needed" || status === "human_control") && !(READ_ONLY_TOOLS as readonly string[]).includes(tool_name)) return { decision: "DENY", reason: "TOOL_NOT_ALLOWED_IN_STATUS" };
  if (status === "offline_bot" && !(OFFLINE_BOT_ALLOWED as readonly string[]).includes(tool_name)) return { decision: "DENY", reason: "TOOL_NOT_ALLOWED_OFFLINE" };
  if (risk_level === "high" && !(HIGH_RISK_ALLOWED as readonly string[]).includes(tool_name)) return { decision: "ESCALATE", reason: "HIGH_RISK_TOOL_BLOCKED" };
  if (tool_name === "mark_unresolved" && caller_mode === "system_auto") return { decision: "DENY", reason: "MARK_UNRESOLVED_REQUIRES_HUMAN" };
  if ((privacy_flags?.do_not_profile === true || privacy_flags?.consent_status === "withdrawn") && tool_name === "get_customer_context") return { decision: "DENY", reason: "PRIVACY_DO_NOT_PROFILE" };
  const dedupe_key = buildSafeDedupeKey(tool_name, input, server_resolved_customer_ref);
  if (dedupe_key === null) return { decision: "DENY", reason: "SERVER_REFERENCE_REQUIRED" };
  if (turn_tool_calls.has(dedupe_key)) return { decision: "DENY", reason: "DUPLICATE_TOOL_CALL_IN_TURN" };
  turn_tool_calls.add(dedupe_key);
  if (turn_budget.total >= MAX_TOOL_CALLS) return { decision: "DENY", reason: "TOOL_BUDGET_EXCEEDED" };
  if (tool_name === "kb_search" && turn_budget.kb_search >= MAX_KB_SEARCH) return { decision: "DENY", reason: "KB_SEARCH_BUDGET_EXCEEDED" };
  if (tool_name === "get_customer_context" && turn_budget.c360 >= MAX_C360_CALLS) return { decision: "DENY", reason: "C360_BUDGET_EXCEEDED" };
  if (status === "ai_draft_only" || status === "unresolved") return { decision: "DOWNGRADE_TO_DRAFT", reason: "STATUS_DRAFT_ONLY", execution_allowed: true, force_draft: true, execution_deferred_to: "L5d", draft_enforcement_deferred_to: "L5e" };
  if (status === "escalation_risk") return { decision: "DOWNGRADE_TO_DRAFT", reason: "ESCALATION_RISK_DOWNGRADE", execution_allowed: true, force_draft: true, execution_deferred_to: "L5d", draft_enforcement_deferred_to: "L5e" };
  return { decision: "ALLOW", reason: "GATE_PASSED", execution_allowed: true, execution_deferred_to: "L5d" };
}

export function handleGateDecision(decision: GateDecision): GateDecision {
  switch (decision.decision) {
    case "ALLOW": return { decision: "ALLOW", reason: decision.reason ?? "GATE_PASSED", execution_allowed: true, execution_deferred_to: "L5d" };
    case "DENY": return { decision: "DENY", reason: decision.reason, message_to_llm: "tool not available in current context" };
    case "DOWNGRADE_TO_DRAFT": return { decision: "DOWNGRADE_TO_DRAFT", reason: decision.reason, execution_allowed: true, force_draft: true, execution_deferred_to: "L5d", draft_enforcement_deferred_to: "L5e" };
    case "ESCALATE": return { decision: "ESCALATE", reason: decision.reason, handoff_required: true, action_deferred_to: "L5e" };
  }
}

const TOOL_DEFINITIONS = [
  { name: "kb_search", description: "Search the knowledge base for policy, FAQ, or product information to answer customer questions.", input_schema: { type: "object", properties: { query: { type: "string", description: "Search query extracted from customer message (must be PII-redacted before stub log or trace)." }, industry: { type: "string", description: "Industry context (optional, inferred from conversation)." }, top_k: { type: "number", description: "Number of results to return (default 5, max 10)." } }, required: ["query"] } },
  { name: "escalate_to_human", description: "Escalate conversation to a human agent when AI cannot resolve the issue.", input_schema: { type: "object", properties: { reason: { type: "string", description: "Reason for escalation (sanitized, no PII)." }, summary: { type: "string", description: "Brief conversation summary (sanitized, max 500 chars, no PII)." } }, required: ["reason", "summary"] } },
  { name: "get_customer_context", description: "Get customer context (tier, sentiment, language preference) to personalize response tone.", input_schema: { type: "object", properties: { fields: { type: "array", items: { type: "string" }, description: "Requested fields (advisory only — server enforces masking level allowlist)." } }, required: [] } },
  { name: "get_order_summary", description: "Get order status summary for delivery, return, or refund inquiries.", input_schema: { type: "object", properties: { inquiry_type: { type: "string", enum: ["delivery_status", "return_request", "refund_inquiry", "order_general"], description: "Type of order inquiry." } }, required: ["inquiry_type"] } },
  { name: "create_handoff_summary", description: "Generate a conversation summary for the human agent who will take over this conversation.", input_schema: { type: "object", properties: { summary_focus: { type: "string", description: "Optional focus area for the summary (e.g. 'refund concern', 'delivery issue')." } }, required: [] } },
  { name: "mark_unresolved", description: "Mark conversation as unresolved for follow-up. Only available in console suggest mode.", input_schema: { type: "object", properties: { reason: { type: "string", description: "Reason conversation is unresolved (sanitized)." }, follow_up_at: { type: "string", description: "Suggested follow-up datetime (ISO 8601, optional — advisory only in L5d, not written/scheduled)." } }, required: ["reason"] } },
  { name: "suggest_reply", description: "Generate a suggested reply for the customer based on KB findings and context.", input_schema: { type: "object", properties: { context_summary: { type: "string", description: "Summary of context assembled by generate-reply (sanitized, max 500 chars, no PII)." }, sources: { type: "array", items: { type: "string" }, description: "Citation labels from KB results." } }, required: ["context_summary"] } },
];

interface ToolResult { tool_name: string; status: "stub" | "denied"; result_classification: "internal_only"; [k: string]: unknown; }
export async function handleToolCall(tool_name: string, _tool_input: Record<string, unknown>, _context: ExecutionContext): Promise<ToolResult> {
  switch (tool_name) {
    case "kb_search": return { tool_name, status: "stub", result_classification: "internal_only", retrieval_quality: "failed", no_answer: true, handoff_required: true, results: [], stub_note: "KB adapter not yet enabled (L5d stub)" };
    case "escalate_to_human": return { tool_name, status: "stub", result_classification: "internal_only", escalated: false, stub_note: "Escalation workflow deferred to L5e — no state changes in L5d" };
    case "get_customer_context": return { tool_name, status: "stub", result_classification: "internal_only", customer_context: null, context_available: false, stub_note: "Customer360 adapter not enabled; no customer context returned" };
    case "get_order_summary": return { tool_name, status: "stub", result_classification: "internal_only", order_available: false, stub_note: "Order adapter not yet enabled (L5d stub)" };
    case "create_handoff_summary": return { tool_name, status: "stub", result_classification: "internal_only", summary: "[Handoff summary not yet available — L5d stub]", stub_note: "Handoff summary generation deferred to L5e; conversation_id server-side only" };
    case "mark_unresolved": return { tool_name, status: "stub", result_classification: "internal_only", marked: false, stub_note: "mark_unresolved write action deferred to L5e — no state changes in L5d" };
    case "suggest_reply": return { tool_name, status: "stub", result_classification: "internal_only", draft_content: "", confidence: 0, recommended_action: "human_review", stub_note: "suggest_reply draft write deferred to L5e — no state changes in L5d" };
    default: return { tool_name, status: "denied", result_classification: "internal_only", error: "tool not available in current context" };
  }
}

type L5eOutputAction = "auto_send" | "draft_only" | "refuse";
interface L5eOutputMode { action: L5eOutputAction; reason: string; }
interface L5eGuardrailResult { pass: boolean; reason: string; }
interface L5eToolResult { tool_name: string; result_classification?: "public_safe" | "draft_only" | "supervisor_only" | "internal_only"; handoff_required?: boolean; citation_required?: boolean; has_valid_citation?: boolean; }
interface L5eRagResult { no_answer?: boolean; conflict_detected?: boolean; retrieval_quality?: "high" | "medium" | "low"; policy_gap?: boolean; source_scope?: "customer_answer" | "internal_only" | string; }
type L5eCallerMode = "system_auto" | "console_suggest";

export function determineOutputMode(conversationStatus: string, toolResults: L5eToolResult[], ragResult: L5eRagResult | null, mode: L5eCallerMode): L5eOutputMode {
  switch (conversationStatus) {
    case "resolved": case "closed": return { action: "refuse", reason: "CONV_RESOLVED_OR_CLOSED" };
    case "ai_handling": break;
    case "ai_draft_only": return { action: "draft_only", reason: "STATUS_AI_DRAFT_ONLY" };
    case "human_needed": case "human_control": return { action: "draft_only", reason: "STATUS_HUMAN_CONTROL" };
    case "escalation_risk": return { action: "draft_only", reason: "STATUS_ESCALATION_RISK" };
    case "unresolved": return { action: "draft_only", reason: "STATUS_UNRESOLVED" };
    case "offline_bot": return { action: "draft_only", reason: "STATUS_OFFLINE_BOT" };
    case "reopened": return { action: "draft_only", reason: "STATUS_REOPENED_TRANSITIONAL" };
    default: return { action: "draft_only", reason: "STATUS_UNKNOWN_SAFE_FALLBACK" };
  }
  const guardrailsPass = checkGuardrails(toolResults, ragResult, mode);
  return guardrailsPass.pass ? { action: "auto_send", reason: "GUARDRAILS_PASSED" } : { action: "draft_only", reason: guardrailsPass.reason };
}

export function checkGuardrails(toolResults: L5eToolResult[], ragResult: L5eRagResult | null, mode: L5eCallerMode): L5eGuardrailResult {
  if (mode === "console_suggest") return { pass: false, reason: "CONSOLE_SUGGEST_ALWAYS_DRAFT" };
  if (ragResult) {
    if (ragResult.no_answer) return { pass: false, reason: "KB_NO_ANSWER" };
    if (ragResult.conflict_detected) return { pass: false, reason: "KB_CONFLICT" };
    if (ragResult.retrieval_quality === "low") return { pass: false, reason: "KB_LOW_QUALITY" };
    if (ragResult.policy_gap) return { pass: false, reason: "KB_POLICY_GAP" };
    if (ragResult.source_scope !== "customer_answer") return { pass: false, reason: "KB_SCOPE_NOT_CUSTOMER_ANSWER" };
  }
  for (const result of toolResults) {
    if (result.result_classification === "draft_only") return { pass: false, reason: "TOOL_RESULT_DRAFT_ONLY" };
    if (result.result_classification === "supervisor_only") return { pass: false, reason: "TOOL_RESULT_SUPERVISOR_ONLY" };
  }
  const suggestResult = toolResults.find((r) => r.tool_name === "suggest_reply");
  if (suggestResult?.citation_required && !suggestResult?.has_valid_citation) return { pass: false, reason: "SUGGEST_REPLY_MISSING_CITATION" };
  if (toolResults.some((r) => r.handoff_required)) return { pass: false, reason: "HANDOFF_REQUIRED_BY_TOOL" };
  return { pass: true, reason: "ALL_GUARDRAILS_PASSED" };
}

interface L5eExecutionContextLike { flags: { ENABLE_TOOL_EXEC: boolean; [k: string]: unknown }; llm_generated_content?: string; handoff_summary_from_tool?: string; [k: string]: unknown; }
interface L5eSuggestReplyInput { [k: string]: unknown; }
interface L5eEscalateInput { reason?: string; summary?: string; [k: string]: unknown; }
interface L5eMarkUnresolvedInput { reason?: string; follow_up_at?: string; [k: string]: unknown; }
interface L5eDeferredResult { deferred: boolean; reason: string; auto_sent?: boolean; escalated?: boolean; marked?: boolean; }
function l5eSanitize(input: string | undefined | null, opts: { maxChars: number; noPII: boolean }): string {
  if (!input) return ""; let s = String(input);
  if (opts.noPII) { s = s.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]"); s = s.replace(/\+?\d[\d\s\-().]{7,}\d/g, "[phone]"); s = s.replace(/\b\d{9,}\b/g, "[digits]"); }
  return s.length > opts.maxChars ? s.slice(0, opts.maxChars) : s;
}
export async function executeSuggestReply(_input: L5eSuggestReplyInput, context: L5eExecutionContextLike, outputMode: L5eOutputMode): Promise<L5eDeferredResult> { if (!context.flags.ENABLE_TOOL_EXEC) return { auto_sent: false, deferred: true, reason: "TOOL_EXEC_DISABLED" }; void outputMode; return { deferred: true, reason: "GATE_B_REQUIRED" }; }
export async function executeEscalateToHuman(input: L5eEscalateInput, context: L5eExecutionContextLike): Promise<L5eDeferredResult> { const _reason = l5eSanitize(input.reason, { maxChars: 500, noPII: true }); const _summary = l5eSanitize(input.summary, { maxChars: 500, noPII: true }); const _handoffSummary = context.handoff_summary_from_tool || _summary; void _reason; void _handoffSummary; if (!context.flags.ENABLE_TOOL_EXEC) return { escalated: false, deferred: true, reason: "TOOL_EXEC_DISABLED" }; return { deferred: true, reason: "GATE_B_REQUIRED" }; }
export async function executeMarkUnresolved(input: L5eMarkUnresolvedInput, context: L5eExecutionContextLike): Promise<L5eDeferredResult> { if (!context.flags.ENABLE_TOOL_EXEC) return { marked: false, deferred: true, reason: "TOOL_EXEC_DISABLED" }; void input; return { deferred: true, reason: "GATE_B_REQUIRED" }; }
