// B7 generate-reply — L5b orchestration skeleton + Task A.1A Deterministic Handoff Patch
//
// Source of truth: Contract 11 §3.1 + Contract 07 + Contract 03 §1.1 + Contract 08
//
// CRITICAL SAFETY INVARIANTS (L5b):
//   1. All adapter flags default to FALSE. When ALL flags are false, the function
//      enters legacyGenerateReply() immediately and behaves 100% identically to L5a.
//      No new budget check, no prompt_overlay read, no adapter calls, no extra trace
//      writes, no status guard changes, no response shape change.
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

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// F-1: Explicit Anthropic timeout (25s) — applies to both legacy and orchestration paths.
const ANTHROPIC_TIMEOUT_MS = 25000;

// Contract 05 §5 — minimal safe fallback prompt (in-memory only, never persisted).
const MINIMAL_SAFE_FALLBACK_PROMPT = `You are a professional and friendly customer service assistant. 
Answer customer questions clearly and concisely. 
If you cannot answer a question confidently, acknowledge it honestly and offer to connect the customer with a human agent.
Keep responses under 150 words.
Respond in the same language the customer is using.`;

// ── Task A.1A: Deterministic Handoff Detection ────────────────────────────
const SAFE_HANDOFF_WORDING: Record<string, string> = {
  "zh-TW": "我們已將你的對話記錄，客服接手後會在此對話中回覆你。目前未啟用即時輪候時間顯示。",
  "zh-CN": "我们已将你的对话记录，客服接手后会在此对话中回复你。目前未启用实时排队位置和预计等待时间显示。",
  en: "We have recorded your conversation. A human agent will reply in this same chat after taking over. Real-time queue position and estimated wait time are not currently enabled.",
};
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
const HANDOFF_INTENT_VERBS_ZH = ["要", "想", "找", "轉", "转", "接", "聯絡", "联系", "幫我", "帮我"];
const HANDOFF_INTENT_VERBS_EN = ["speak", "talk", "connect", "need", "want", "get"];
const ZH_CN_CHARS = ["转", "们", "队", "预计", "为您", "为我", "为你"];
const ZH_TW_CHARS = ["轉", "們", "隊", "預計", "為您", "為我", "為你"];

function isHandoffIntent(text: string): boolean {
  const lower = text.toLowerCase();
  const allStrong = [
    ...HANDOFF_STRONG_TRIGGERS["zh-TW"],
    ...HANDOFF_STRONG_TRIGGERS["zh-CN"],
    ...HANDOFF_STRONG_TRIGGERS["en"],
  ];
  if (allStrong.some((kw) => lower.includes(kw.toLowerCase()))) return true;
  const hasWeak = HANDOFF_WEAK_TERMS.some((kw) => text.includes(kw));
  const hasIntent = [...HANDOFF_INTENT_VERBS_ZH, ...HANDOFF_INTENT_VERBS_EN].some((kw) =>
    lower.includes(kw.toLowerCase()),
  );
  return hasWeak && hasIntent;
}

function detectHandoffLanguage(text: string): "zh-TW" | "zh-CN" | "en" | null {
  if (!isHandoffIntent(text)) return null;
  const lower = text.toLowerCase();
  if (
    HANDOFF_STRONG_TRIGGERS["en"].some((kw) => lower.includes(kw)) ||
    (HANDOFF_INTENT_VERBS_EN.some((kw) => lower.includes(kw)) && HANDOFF_WEAK_TERMS.some((kw) => text.includes(kw)))
  )
    return "en";
  if (ZH_CN_CHARS.some((kw) => text.includes(kw))) return "zh-CN";
  if (ZH_TW_CHARS.some((kw) => text.includes(kw))) return "zh-TW";
  if (HANDOFF_STRONG_TRIGGERS["zh-CN"].some((kw) => text.includes(kw))) return "zh-CN";
  if (HANDOFF_STRONG_TRIGGERS["zh-TW"].some((kw) => text.includes(kw))) return "zh-TW";
  return "zh-TW";
}
// ── End Task A.1A helpers ─────────────────────────────────────────────────

// ── Dev19a: PII-safe user_message sanitizer + best-effort trace writer ────
function sanitizeUserMessage(text: string): string {
  if (!text) return "";
  let s = text;
  // redact email
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted_email]");
  // redact phone-like sequences with separators
  s = s.replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted_phone]");
  // redact any remaining long digit runs (7+)
  s = s.replace(/\d{7,}/g, "[redacted_digits]");
  if (s.length > 300) s = s.slice(0, 300);
  return s;
}

async function writeTraces(
  supabaseAdmin: ReturnType<typeof createClient>,
  params: {
    conversation_id: string;
    message_id: string | null;
    user_message_raw: string;
    response_status: number | null;
    response_latency_ms: number;
    error_message: string | null;
    request_payload: Record<string, unknown>;
    token_input: number | null;
    token_output: number | null;
    ai_reply_content: string;
  },
): Promise<void> {
  try {
    await supabaseAdmin.from("upstream_call_log").insert({
      upstream_service: "llm",
      conversation_id: params.conversation_id,
      response_status: params.response_status,
      response_latency_ms: params.response_latency_ms,
      error_message: params.error_message,
      request_payload: {
        ...params.request_payload,
        provider: "anthropic",
      },
    });
  } catch (e) {
    console.error("[generate-reply] upstream_call_log insert failed (non-blocking):", e);
  }
  try {
    await supabaseAdmin.from("final_prompt_trace").insert({
      conversation_id: params.conversation_id,
      message_id: params.message_id,
      model_used: "claude-haiku-4-5-20251001",
      system_prompt_snapshot: "[legacy_inline_cs_prompt_v1]",
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
// ── End Dev19a helpers ────────────────────────────────────────────────────

// ── DEFECT-1 fix: scoped __THINKING__ cleanup helper ─────────────────────
async function cleanupThinking(
  supabaseAdmin: ReturnType<typeof createClient>,
  conversation_id: string,
  source_message_id: string | null,
): Promise<void> {
  if (!source_message_id) {
    console.error("[generate-reply] cleanupThinking skipped: missing source_message_id", conversation_id);
    return;
  }
  try {
    await supabaseAdmin
      .from("messages")
      .delete()
      .eq("conversation_id", conversation_id)
      .eq("content", "__THINKING__")
      .filter("metadata->>source_message_id", "eq", source_message_id);
  } catch (e) {
    console.error("[generate-reply] cleanupThinking failed (non-blocking):", e);
  }
}
// ── End DEFECT-1 helper ──────────────────────────────────────────────────

// ── ESC-MVP R1: Explicit Handoff Classifier ──────────────────────────────
// Per-trigger-span evaluation. R1 = explicit handoff request.
// Reuses isHandoffIntent() + detectHandoffLanguage() for R1-only.
// Future R2–R4 rules will extend this classifier without changing R1 logic.
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
// ── End ESC-MVP R1 classifier ────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { conversation_id, source_message_id } = body ?? {};
    if (!conversation_id) {
      return new Response(JSON.stringify({ error: "conversation_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Feature flags (read at request time so they can be toggled per deploy) ──
    const ENABLE_KB = Deno.env.get("ENABLE_KB_ADAPTER") === "true";
    const ENABLE_COACH = Deno.env.get("ENABLE_COACH_PROMPT_ADAPTER") === "true";
    const ENABLE_C360 = Deno.env.get("ENABLE_CUSTOMER360_ADAPTER") === "true";
    const ENABLE_TOOL_EXEC = Deno.env.get("ENABLE_TOOL_EXECUTOR") === "true";

    // ⚠️ LEGACY GATE — MUST be checked FIRST, before any other logic.
    // All flags false → behavior 100% identical to L5a.
    if (!ENABLE_KB && !ENABLE_COACH && !ENABLE_C360 && !ENABLE_TOOL_EXEC) {
      return await legacyGenerateReply(conversation_id, source_message_id ?? null);
    }

    // ── ORCHESTRATION PATH (only reached when at least one flag is true) ──────
    return await orchestrationGenerateReply(
      conversation_id,
      {
        ENABLE_KB,
        ENABLE_COACH,
        ENABLE_C360,
        ENABLE_TOOL_EXEC,
      },
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

// ────────────────────────────────────────────────────────────────────────────
// LEGACY PATH — preserved L5a behavior, byte-for-byte equivalent to pre-L5b.
// ⚠️ Do NOT add adapter calls / overlay reads / trace writes / status changes here.
// Task A.1A: deterministic handoff branch added ONLY (before anthropicKey check).
// ────────────────────────────────────────────────────────────────────────────
async function legacyGenerateReply(conversation_id: string, source_message_id: string | null): Promise<Response> {
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("conversations")
    .select("id, status, assigned_agent_id")
    .eq("id", conversation_id)
    .single();

  if (convError || !conversation) {
    console.error("[generate-reply] conversation not found:", conversation_id);
    return new Response(JSON.stringify({ error: "Conversation not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (conversation.status === "resolved") {
    return new Response(JSON.stringify({ success: true, skipped: "resolved" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Dev21 Batch 1: Human-handling defense-in-depth guard ────────────
  // When status is 'pending' or 'transferred', a human agent is handling.
  // Do not call LLM. Clear ai_generating flag and return.
  if (conversation.status === "pending" || conversation.status === "transferred") {
    console.log(
      "[generate-reply] human-handling guard: skipping LLM for status:",
      conversation.status,
      conversation_id,
    );
    return new Response(JSON.stringify({ success: true, skipped: "human_handling" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // ── End Dev21 Batch 1 guard ─────────────────────────────────────────

  // ── S-1: assigned_agent_id defense-in-depth guard ──────────────────
  if (conversation.assigned_agent_id) {
    console.log("[generate-reply] S-1 assigned_agent_id guard (legacy):", conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: "assigned_to_agent" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // ── End S-1 (legacy) ───────────────────────────────────────────────
  const { data: messages } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversation_id)
    .neq("content", "__THINKING__")
    .eq("is_recalled", false)
    .order("created_at", { ascending: true })
    .limit(10);

  if (!messages || messages.length === 0) {
    return new Response(JSON.stringify({ success: true, skipped: "no messages" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const claudeMessages = messages.map((m) => ({
    role: m.role === "visitor" ? "user" : "assistant",
    content: m.content,
  }));

  if (claudeMessages[claudeMessages.length - 1].role === "assistant") {
    return new Response(JSON.stringify({ success: true, skipped: "last message is assistant" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ── Task A.1A: Deterministic handoff branch ──────────────────────────────
  const lastVisitorMsg = messages.filter((m) => m.role === "visitor").at(-1)?.content ?? "";
  const handoffLang = detectHandoffLanguage(lastVisitorMsg);

  if (handoffLang) {
    const safeWording = SAFE_HANDOFF_WORDING[handoffLang];

    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);

    const { error: insertError } = await supabaseAdmin.from("messages").insert({
      conversation_id: conversation_id,
      role: "assistant",
      content: safeWording,
      status: "delivered",
      is_recalled: false,
    });

    if (insertError) {
      console.error("[generate-reply] deterministic handoff insert error:", insertError);
    }

    const { error: pendingUpdateErr } = await supabaseAdmin
      .from("conversations")
      .update({
        status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversation_id);

    if (pendingUpdateErr) {
      console.error(
        "[generate-reply] CRITICAL: failed to mark conversation pending after handoff:",
        pendingUpdateErr.message,
        conversation_id,
      );
    }

    console.log("[generate-reply] deterministic handoff reply sent:", conversation_id, handoffLang);
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // ── End Task A.1A handoff branch ─────────────────────────────────────────

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    console.error("[generate-reply] ANTHROPIC_API_KEY not set");
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ error: "AI service not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const requestPayload = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: `You are a professional and friendly customer service assistant. 
Answer customer questions clearly and concisely. 
If you cannot answer a question confidently, acknowledge it honestly and offer to connect the customer with a human agent.
Keep responses under 150 words.
Respond in the same language and script the customer is using.
When the customer explicitly requests a human agent, or when you transfer to a human agent, include a short safe handoff status message in the same language and script as the customer. The message must state that the conversation has been recorded and that a human agent will reply in this same chat after taking over. If the customer is using Traditional Chinese, use: "我們已將你的對話記錄，客服接手後會在此對話中回覆你。目前未啟用即時輪候時間顯示。" If the customer is using Simplified Chinese, use: "我们已将你的对话记录，客服接手后会在此对话中回复你。目前未启用实时排队位置和预计等待时间显示。" If the customer is using English, use: "We have recorded your conversation. A human agent will reply in this same chat after taking over. Real-time queue position and estimated wait time are not currently enabled." Do NOT invent estimated wait times, response-time promises, or queue positions.`,
    messages: claudeMessages,
  };

  const requestTimestamp = Date.now();
  let claudeResponse: Response | null = null;
  // F-1: Explicit timeout guard
  const _legacyAbortCtrl = new AbortController();
  const _legacyTimeout = setTimeout(() => _legacyAbortCtrl.abort(), ANTHROPIC_TIMEOUT_MS);
  let fetchThrew = false;
  try {
    claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(requestPayload),
      signal: _legacyAbortCtrl.signal,
    });
  } catch (e) {
    fetchThrew = true;
    if (e instanceof DOMException && e.name === "AbortError") {
      console.error("[generate-reply] F-1 Anthropic timeout after 25s:", conversation_id);
      // Clean up __THINKING__ to stop Widget typing indicator
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    } else {
      console.error("[generate-reply] Anthropic fetch threw:", e);
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    }
  } finally {
    clearTimeout(_legacyTimeout);
  }

  const responseTimestamp = Date.now();
  const responseLatencyMs = responseTimestamp - requestTimestamp;

  const tracePayloadRedacted = {
    model: requestPayload.model,
    max_tokens: requestPayload.max_tokens,
    system_prompt_ref: "[legacy_inline_cs_prompt_v1]",
    message_count: claudeMessages.length,
  };

  if (fetchThrew || !claudeResponse) {
    await writeTraces(supabaseAdmin, {
      conversation_id,
      message_id: null,
      user_message_raw: lastVisitorMsg,
      response_status: null,
      response_latency_ms: responseLatencyMs,
      error_message: "api_exception",
      request_payload: tracePayloadRedacted,
      token_input: null,
      token_output: null,
      ai_reply_content: "",
    });
    return new Response(JSON.stringify({ error: "AI service error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!claudeResponse.ok) {
    const errText = await claudeResponse.text();
    console.error("[generate-reply] Claude API error:", claudeResponse.status, errText);
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    await writeTraces(supabaseAdmin, {
      conversation_id,
      message_id: null,
      user_message_raw: lastVisitorMsg,
      response_status: claudeResponse.status,
      response_latency_ms: responseLatencyMs,
      error_message: `api_error_${claudeResponse.status}`,
      request_payload: tracePayloadRedacted,
      token_input: null,
      token_output: null,
      ai_reply_content: "",
    });
    return new Response(JSON.stringify({ error: "AI service error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const claudeData = await claudeResponse.json();
  const aiReplyContent = claudeData.content?.[0]?.text ?? "";
  const tokenInput = claudeData.usage?.input_tokens ?? null;
  const tokenOutput = claudeData.usage?.output_tokens ?? null;

  if (!aiReplyContent) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    await writeTraces(supabaseAdmin, {
      conversation_id,
      message_id: null,
      user_message_raw: lastVisitorMsg,
      response_status: claudeResponse.status,
      response_latency_ms: responseLatencyMs,
      error_message: "empty_response",
      request_payload: tracePayloadRedacted,
      token_input: tokenInput,
      token_output: tokenOutput,
      ai_reply_content: "",
    });
    return new Response(JSON.stringify({ error: "Empty AI response" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);

  const { data: insertedMsg, error: insertError } = await supabaseAdmin
    .from("messages")
    .insert({
      conversation_id: conversation_id,
      role: "assistant",
      content: aiReplyContent,
      status: "delivered",
      is_recalled: false,
    })
    .select("id")
    .maybeSingle();

  if (insertError) {
    console.error("[generate-reply] insert error:", insertError);
  }

  await supabaseAdmin
    .from("conversations")
    .update({
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversation_id);

  await writeTraces(supabaseAdmin, {
    conversation_id,
    message_id: insertedMsg?.id ?? null,
    user_message_raw: lastVisitorMsg,
    response_status: claudeResponse.status,
    response_latency_ms: responseLatencyMs,
    error_message: null,
    request_payload: tracePayloadRedacted,
    token_input: tokenInput,
    token_output: tokenOutput,
    ai_reply_content: aiReplyContent,
  });

  console.log("[generate-reply] AI reply sent for conversation:", conversation_id);
  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// ORCHESTRATION PATH — 7-step skeleton per Contract 11 §3.1.
// Each adapter step is independently flag-gated. With all flags false this
// function is unreachable (legacyGenerateReply() is called instead).
//
// NOTE: This skeleton is intentionally non-executing in L5b. Adapter calls
// and trace writes are placeholders with safe fallbacks; live adapter
// invocations and trace inserts are deferred to L5c+ once schema is verified.
// ────────────────────────────────────────────────────────────────────────────
// ── W5: Citation metadata builder (orchestration path only) ──────────────
function buildCitationMetadata(
  chunks: Array<{ title?: string; score?: number; source_type?: string }>,
): { citations: Array<{ label: string; source_type: string; relevance?: string }> } | null {
  const seen = new Set<string>();
  const citations: Array<{ label: string; source_type: string; relevance?: string }> = [];
  for (const c of chunks) {
    if (citations.length >= 3) break;
    const label = (typeof c.title === "string" ? c.title : "").trim().slice(0, 120);
    if (!label) continue;
    const dedupeKey = label.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const rawSt = typeof c.source_type === "string" ? c.source_type.trim().slice(0, 40) : "";
    const source_type = rawSt || "unknown";
    const relevance = typeof c.score === "number" ? (c.score >= 0.85 ? "high" : "medium") : undefined;
    citations.push({ label, source_type, ...(relevance ? { relevance } : {}) });
  }
  return citations.length > 0 ? { citations } : null;
}
// ── End W5 helper ────────────────────────────────────────────────────────
type FlagSet = {
  ENABLE_KB: boolean;
  ENABLE_COACH: boolean;
  ENABLE_C360: boolean;
  ENABLE_TOOL_EXEC: boolean;
};

// F-2: Multilingual KB fallback safe text
const KB_FALLBACK_SAFE_TEXT: Record<string, Record<string, string>> = {
  KB_SCOPE_GATE: {
    "zh-TW": "很抱歉，系統暫時無法查詢知識庫。讓我為您轉接客服人員。",
    "zh-CN": "很抱歉，系统暂时无法查询知识库。让我为您转接客服人员。",
    en: "Sorry, the knowledge base is temporarily unavailable. Let me connect you with a human agent.",
  },
  KB_API_FAIL: {
    "zh-TW": "系統暫時無法查詢知識庫，讓我為您轉接客服人員。",
    "zh-CN": "系统暂时无法查询知识库，让我为您转接客服人员。",
    en: "The knowledge base is temporarily unavailable. Let me connect you with a human agent.",
  },
  KB_EMPTY: {
    "zh-TW": "很抱歉，我目前無法確定答案。讓我為您轉接客服人員，以提供更準確的協助。",
    "zh-CN": "很抱歉，我目前无法确定答案。让我为您转接客服人员，以提供更准确的协助。",
    en: "Sorry, I'm unable to find a definitive answer. Let me connect you with a human agent for more accurate assistance.",
  },
  KB_LOW_SCORE_HIGH_RISK: {
    "zh-TW": "這個問題涉及重要政策，為確保您獲得準確資訊，讓我為您轉接客服人員。",
    "zh-CN": "这个问题涉及重要政策，为确保您获得准确信息，让我为您转接客服人员。",
    en: "This question involves important policy matters. To ensure you receive accurate information, let me connect you with a human agent.",
  },
  KB_LOW_SCORE_STANDARD: {
    "zh-TW": "很抱歉，我目前無法確定答案。讓我為您轉接客服人員，以提供更準確的協助。",
    "zh-CN": "很抱歉，我目前无法确定答案。让我为您转接客服人员，以提供更准确的协助。",
    en: "Sorry, I'm unable to find a definitive answer. Let me connect you with a human agent for more accurate assistance.",
  },
};

// ── S0: LLM failure safe wording (D-5 approved — exact frozen text) ─────
const S0_LLM_FAILURE_SAFE_TEXT: Record<string, string> = {
  "zh-TW": "系統暫時無法完成回覆，我已為你轉交客服人員跟進。",
  "zh-CN": "系统暂时无法完成回复，我已为你转交客服人员跟进。",
  en: "The system is temporarily unable to complete a response. I\u2019ve handed this conversation to a support agent for follow-up.",
};
// ── End S0 safe wording ─────────────────────────────────────────────────

// F-2: Detect visitor language from message content
function detectVisitorLanguage(text: string): "zh-TW" | "zh-CN" | "en" {
  if (!text) return "zh-TW";
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  if (!hasChinese) return "en";
  const zhCnIndicators = ["转", "们", "队", "预计", "为您", "为我", "为你", "请", "这", "没"];
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
async function handleKBFallback(
  supabaseAdmin: ReturnType<typeof createClient>,
  conversation_id: string,
  branchTag: string,
  source_message_id: string | null,
  traceMetadata: Record<string, unknown>,
  visitorLang: "zh-TW" | "zh-CN" | "en" = "zh-TW",
): Promise<Response> {
  const _branchTexts = KB_FALLBACK_SAFE_TEXT[branchTag];
  const safeText = _branchTexts ? (_branchTexts[visitorLang] ?? _branchTexts["zh-TW"]) : undefined;
  if (!safeText) {
    console.error(`[generate-reply] CRITICAL unknown branch: ${branchTag}`, conversation_id);
    return new Response(
      JSON.stringify({
        success: false,
        error: "kb_fallback_unknown_branch",
        no_answer: true,
        handoff_required: true,
        handoff_persisted: false,
        trace_metadata: { ...traceMetadata, branch: branchTag, handoff_persisted: false },
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  if (!source_message_id) {
    console.error(`[generate-reply] CRITICAL source_message_id missing`, conversation_id);
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
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc("kb_fallback_handoff_tx", {
    p_conversation_id: conversation_id,
    p_safe_reply_content: safeText,
    p_branch_tag: branchTag,
    p_source_message_id: source_message_id,
  });
  if (rpcErr) {
    console.error(`[generate-reply] CRITICAL RPC failed [${branchTag}]:`, rpcErr.message, conversation_id);
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
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const result: string = rpcData?.result ?? "unknown";
  switch (result as KBFallbackRpcResult | "unknown") {
    case "success":
      console.log(`[generate-reply] KB fallback persisted [${branchTag}]:`, conversation_id);
      return new Response(
        JSON.stringify({
          success: true,
          reply: safeText,
          no_answer: true,
          handoff_required: true,
          handoff_persisted: true,
          trace_metadata: { ...traceMetadata, rpc_result: "success", handoff_persisted: true },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_handled":
      console.log(
        `[generate-reply] KB fallback idempotent [${branchTag}]:`,
        conversation_id,
        "existing:",
        rpcData?.existing_branch,
        "requested:",
        rpcData?.requested_branch,
      );
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
      console.log(`[generate-reply] KB skipped resolved [${branchTag}]:`, conversation_id);
      return new Response(
        JSON.stringify({
          success: false,
          error: "conversation_resolved",
          reply: null,
          no_answer: false,
          handoff_required: false,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, rpc_result: "already_resolved", handoff_persisted: false },
        }),
        { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "already_under_human_control":
      console.log(`[generate-reply] KB skipped human control [${branchTag}]:`, conversation_id);
      return new Response(
        JSON.stringify({
          success: true,
          reply: null,
          no_answer: false,
          handoff_required: false,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, rpc_result: "already_under_human_control", handoff_persisted: false },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "invalid_source_message":
      console.error(`[generate-reply] invalid source_message [${branchTag}]:`, conversation_id);
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
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "invalid_branch":
      console.error(`[generate-reply] invalid branch from RPC [${branchTag}]:`, conversation_id);
      return new Response(
        JSON.stringify({
          success: false,
          error: "kb_fallback_invalid_branch",
          no_answer: true,
          handoff_required: true,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, handoff_persisted: false },
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "not_found":
      console.error(`[generate-reply] conversation not found [${branchTag}]:`, conversation_id);
      return new Response(
        JSON.stringify({
          success: false,
          error: "kb_fallback_conversation_not_found",
          no_answer: true,
          handoff_required: true,
          handoff_persisted: false,
          trace_metadata: { ...traceMetadata, handoff_persisted: false },
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    default:
      console.error(`[generate-reply] unexpected RPC result [${branchTag}]:`, result, conversation_id);
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
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
  }
}

// ── S0: System-failure handoff handler ───────────────────────────────────
// Routes 6 failure types to s0_handoff_tx RPC.
// D-2b(i) STRICT:
//   - NO cleanupThinking before RPC
//   - cleanupThinking ONLY inside "success" branch
//   - All non-success branches: ZERO mutation (no cleanup)
//   - RPC transport error: ZERO mutation (handoff state uncertain)
//   - Pre-RPC validation failures: ZERO mutation
// D-5: KB failures use KB_FALLBACK_SAFE_TEXT; LLM failures use S0_LLM_FAILURE_SAFE_TEXT.
async function handleS0Handoff(
  supabaseAdmin: ReturnType<typeof createClient>,
  conversation_id: string,
  source_message_id: string | null,
  failure_type: string,
  visitorLang: "zh-TW" | "zh-CN" | "en",
): Promise<Response> {
  // Determine safe reply: KB failures → existing KB text; LLM failures → D-5 text
  const isKBFailure = failure_type === "KB_SCOPE_GATE" || failure_type === "KB_API_FAIL";
  let safeReply: string;
  if (isKBFailure) {
    const branchTexts = KB_FALLBACK_SAFE_TEXT[failure_type];
    safeReply = branchTexts?.[visitorLang] ?? branchTexts?.["zh-TW"] ?? "";
  } else {
    safeReply = S0_LLM_FAILURE_SAFE_TEXT[visitorLang] ?? S0_LLM_FAILURE_SAFE_TEXT["zh-TW"];
  }

  if (!safeReply) {
    // Pre-RPC config failure — ZERO mutation per D-2b(i)
    console.error(`[generate-reply] S0: no safe reply for failure_type=${failure_type}`, conversation_id);
    return new Response(JSON.stringify({ success: false, error: "s0_no_safe_reply", failure_type }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (!source_message_id) {
    // Pre-RPC validation failure — ZERO mutation per D-2b(i)
    console.error(`[generate-reply] S0: missing source_message_id for ${failure_type}`, conversation_id);
    return new Response(JSON.stringify({ success: false, error: "s0_missing_source_message_id", failure_type }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // D-2b(i): NO cleanupThinking before RPC
  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc("s0_handoff_tx", {
    p_conversation_id: conversation_id,
    p_safe_reply_content: safeReply,
    p_source_message_id: source_message_id,
    p_failure_type: failure_type,
  });

  // D-2b(i): NO shared cleanup here — cleanup ONLY inside "success" branch below

  if (rpcErr) {
    // RPC transport error — handoff state UNCERTAIN
    // DB transaction may have committed; client disconnected during response
    // ZERO mutation: no cleanup, no retry, no fallback
    console.error(`[generate-reply] S0 RPC transport error [${failure_type}]:`, rpcErr.message, conversation_id);
    return new Response(
      JSON.stringify({
        success: false,
        error: "s0_rpc_transport_error",
        failure_type,
        handoff_persisted: false,
        handoff_uncertain: true,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const _s0Result: string = rpcData?.result ?? "unknown";
  switch (_s0Result) {
    case "success":
      // D-2b(i): cleanup ONLY here — RPC confirmed committed
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      console.log(`[generate-reply] S0 handoff [${failure_type}]:`, conversation_id);
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
      // Non-success per frozen contract — ZERO cleanup
      console.log(`[generate-reply] S0 idempotent [${failure_type}]:`, conversation_id);
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
      // Non-success — ZERO cleanup
      console.log(`[generate-reply] S0 skipped resolved [${failure_type}]:`, conversation_id);
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
      // Non-success — ZERO cleanup
      console.log(`[generate-reply] S0 skipped human_control [${failure_type}]:`, conversation_id);
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
      // Non-success — ZERO cleanup
      console.error(`[generate-reply] S0 invalid source [${failure_type}]:`, conversation_id);
      return new Response(
        JSON.stringify({ success: false, error: "s0_invalid_source_message", escalation_rule: "S0", failure_type }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "invalid_input":
      // Non-success — ZERO cleanup
      console.error(`[generate-reply] S0 invalid input [${failure_type}]:`, conversation_id);
      return new Response(
        JSON.stringify({ success: false, error: "s0_invalid_input", escalation_rule: "S0", failure_type }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "invalid_failure_type":
      // Non-success — ZERO cleanup
      console.error(`[generate-reply] S0 invalid failure_type [${failure_type}]:`, conversation_id);
      return new Response(
        JSON.stringify({ success: false, error: "s0_invalid_failure_type", escalation_rule: "S0", failure_type }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    case "not_found":
      // Non-success — ZERO cleanup
      console.error(`[generate-reply] S0 conversation not found [${failure_type}]:`, conversation_id);
      return new Response(
        JSON.stringify({ success: false, error: "s0_conversation_not_found", escalation_rule: "S0", failure_type }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    default:
      // Unknown result — ZERO cleanup
      console.error(`[generate-reply] S0 unknown result [${failure_type}]:`, _s0Result, conversation_id);
      return new Response(
        JSON.stringify({
          success: false,
          error: "s0_rpc_unknown_result",
          escalation_rule: "S0",
          failure_type,
          rpc_result: _s0Result,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
  }
}
// ── End S0 handler ───────────────────────────────────────────────────────

async function orchestrationGenerateReply(
  conversation_id: string,
  flags: FlagSet,
  source_message_id: string | null,
): Promise<Response> {
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Load conversation
  const { data: conversation, error: convError } = await supabaseAdmin
    .from("conversations")
    .select("id, status, assigned_agent_id")
    .eq("id", conversation_id)
    .single();

  if (convError || !conversation) {
    return new Response(JSON.stringify({ error: "Conversation not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Step 6 (early): Status Matrix Skeleton Guard — orchestration path ONLY.
  // L5b skeleton: only resolved/closed are refused. Full policy is L5e.
  if (conversation.status === "resolved" || conversation.status === "closed") {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return safeRefusal("CONV_RESOLVED_OR_CLOSED");
  }

  // ── Dev21 Batch 1: Human-handling defense-in-depth guard ────────────
  // Do NOT use safeRefusal() here — its response includes handoff_required:true
  // and skipped:"refused" which are semantically incorrect for human_handling.
  // Human-handling guard must not generate any AI/assistant message or suggest handoff.
  if (conversation.status === "pending" || conversation.status === "transferred") {
    console.log("[generate-reply] orchestration human-handling guard:", conversation.status, conversation_id);
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ success: true, skipped: "human_handling" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // ── End Dev21 Batch 1 guard ─────────────────────────────────────────

  // ── S-1: assigned_agent_id defense-in-depth guard ──────────────────
  if (conversation.assigned_agent_id) {
    console.log("[generate-reply] S-1 assigned_agent_id guard (orchestration):", conversation_id);
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ success: true, skipped: "assigned_to_agent" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // ── End S-1 (orchestration) ────────────────────────────────────────

  // ── H-1: Deterministic handoff detection (orchestration path) ──────
  const { data: _h1VisitorMsgs } = await supabaseAdmin
    .from("messages")
    .select("content")
    .eq("conversation_id", conversation_id)
    .eq("role", "visitor")
    .eq("is_recalled", false)
    .order("created_at", { ascending: false })
    .limit(1);
  const _h1LastMsg = _h1VisitorMsgs?.[0]?.content ?? "";
  const _h1HandoffLang = detectHandoffLanguage(_h1LastMsg);

  // ── ESC-MVP R1: Classifier invocation (orchestration only) ─────────
  // When enabled, RPC is the SOLE write path for handoff. All RPC results
  // handled explicitly — NO H-1 fallback after any RPC attempt or when
  // ESC block determines R1 intent. H-1 only when flag is disabled.
  const _escMvpEnabled = Deno.env.get("ESC_MVP_FEATURE_FLAG") === "true";
  let _escHandled = false;

  if (_escMvpEnabled && _h1HandoffLang) {
    const _escResult = classifyExplicitHandoff(_h1LastMsg);

    if (_escResult.rule === "R1") {
      // ESC block claims this handoff — H-1 must not run regardless of outcome
      _escHandled = true;

      if (!source_message_id) {
        // No source_message_id — cannot call RPC safely. Do not fall back to H-1
        // because H-1 would also lack a valid source for cleanupThinking.
        console.error("[generate-reply] ESC-MVP R1: missing source_message_id, no fallback:", conversation_id);
        return new Response(
          JSON.stringify({
            success: false,
            error: "esc_missing_source_message_id",
            escalation_rule: "R1",
            handoff_persisted: false,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
      const _escSafeWording = SAFE_HANDOFF_WORDING[_escResult.language];

      const { data: _escRpcData, error: _escRpcErr } = await supabaseAdmin.rpc("explicit_handoff_tx", {
        p_conversation_id: conversation_id,
        p_safe_reply_content: _escSafeWording,
        p_source_message_id: source_message_id,
      });

      if (_escRpcErr) {
        // Transport/network error — outcome uncertain. No H-1 fallback.
        console.error(
          "[generate-reply] ESC-MVP R1 RPC transport error (no fallback):",
          _escRpcErr.message,
          conversation_id,
        );
        return new Response(
          JSON.stringify({
            success: false,
            error: "esc_rpc_transport_error",
            escalation_rule: "R1",
            handoff_persisted: false,
            handoff_uncertain: true,
          }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const _escRpcResult: string = _escRpcData?.result ?? "unknown";

      switch (_escRpcResult) {
        case "success":
          console.log("[generate-reply] ESC-MVP R1 handoff:", conversation_id, _escResult.language);
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
          console.log(
            "[generate-reply] ESC-MVP R1 idempotent:",
            conversation_id,
            "existing:",
            _escRpcData?.existing_branch,
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
          console.log("[generate-reply] ESC-MVP R1 skipped (resolved/closed):", conversation_id);
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
          console.log("[generate-reply] ESC-MVP R1 skipped (human_control):", conversation_id);
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
          console.error("[generate-reply] ESC-MVP R1 conversation not found:", conversation_id);
          return new Response(
            JSON.stringify({ success: false, error: "esc_conversation_not_found", escalation_rule: "R1" }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );

        case "invalid_source_message":
          console.error("[generate-reply] ESC-MVP R1 invalid source_message:", conversation_id);
          return new Response(
            JSON.stringify({ success: false, error: "esc_invalid_source_message", escalation_rule: "R1" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );

        default:
          console.error("[generate-reply] ESC-MVP R1 unknown RPC result:", _escRpcResult, conversation_id);
          return new Response(
            JSON.stringify({
              success: false,
              error: "esc_rpc_unknown_result",
              escalation_rule: "R1",
              rpc_result: _escRpcResult,
            }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
          );
      }
    }
  }
  // ── End ESC-MVP R1 invocation ──────────────────────────────────────

  // H-1: only reachable when ESC feature flag is disabled (_escHandled=false).
  // When ESC is enabled, all handoff-intent paths return above.
  if (_h1HandoffLang && !_escHandled) {
    const safeWording = SAFE_HANDOFF_WORDING[_h1HandoffLang];
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    await supabaseAdmin.from("messages").insert({
      conversation_id,
      role: "assistant",
      content: safeWording,
      status: "delivered",
      is_recalled: false,
    });
    await supabaseAdmin
      .from("conversations")
      .update({
        status: "pending",
        updated_at: new Date().toISOString(),
      })
      .eq("id", conversation_id);
    console.log("[generate-reply] H-1 orchestration handoff:", conversation_id, _h1HandoffLang);
    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // ── End H-1 ────────────────────────────────────────────────────────

  // ── G-1: Greeting/trivial bypass — skip KB for simple greetings ────
  // F-4: Normalize input + support repeated greetings
  // DEFECT-2 v1.1: separate EN/ZH compound patterns
  const _g1Normalized = _h1LastMsg.trim().replace(/\s+/g, " ").toLowerCase();
  const _g1Raw = _h1LastMsg.trim();
  const _g1GreetingRe =
    /^((hi|hello|hey|你好|嗨|哈囉|早安|午安|晚安|good\s*(morning|afternoon|evening)|thanks|thank you|ok|okay|謝謝|好的|嗯)\s*[!！。.？?，,]*\s*)+$/i;
  // G-1b EN: greeting + space + filler word (there/everyone/guys/all) + optional trailing punct
  const _g1CompoundEnRe = /^(hi|hello|hey)\s+(there|everyone|guys|all)[!！。.？?，,\s]*$/i;
  // G-1b ZH: greeting + optional punct/space + filler (呀/啊/大家好) + optional trailing punct
  // Uses _g1Raw (not lowercased) since Chinese chars are case-insensitive
  const _g1CompoundZhRe = /^(你好|嗨|哈囉|早安|午安|晚安)[，,、\s]*(呀|啊|大家好?|各位好?)[!！。.？?\s]*$/;
  let _g1SkipKB = false;
  if (_g1GreetingRe.test(_g1Normalized) || _g1CompoundEnRe.test(_g1Normalized) || _g1CompoundZhRe.test(_g1Raw)) {
    console.log("[generate-reply] G-1 greeting bypass, skipping KB:", conversation_id);
    _g1SkipKB = true;
  }
  // ── End G-1 ────────────────────────────────────────────────────────

  // F-2: Detect visitor language for KB fallback messages
  const _visitorLang = detectVisitorLanguage(_h1LastMsg);

  // ── S0: Feature flag (absent env = disabled) ───────────────────────────
  const _escEnableS0 = Deno.env.get("ESC_ENABLE_S0") === "true";
  // ── End S0 flag ────────────────────────────────────────────────────────

  // Step 0: Budget check (orchestration path only).
  // TODO L5e: enforce per-conversation LLM/tool budget; on exceed → handoff.
  //   if (await budgetExceeded(conversation_id)) { return safeRefusal('BUDGET_EXCEEDED'); }

  // Step 1: Coach Prompt Adapter (ENABLE_COACH).
  // In-memory only — base_prompt body is NEVER persisted.
  let basePrompt = MINIMAL_SAFE_FALLBACK_PROMPT;
  let coachTrace: {
    version_id?: string;
    version_label?: string;
    prompt_hash?: string;
    source: "upstream" | "minimal_fallback";
  } = {
    source: "minimal_fallback",
  };
  if (flags.ENABLE_COACH) {
    const promptResult = await callCoachPromptAdapter(conversation_id);
    if (promptResult.success && promptResult.content) {
      basePrompt = promptResult.content; // in-memory only
      coachTrace = {
        version_id: promptResult.version_id,
        version_label: promptResult.version_label,
        prompt_hash: promptResult.prompt_hash,
        source: "upstream",
      };
    } else {
      // Fallback: keep MINIMAL_SAFE_FALLBACK_PROMPT.
      // upstream_call_log is written by the adapter; do NOT duplicate here.
      console.warn("[generate-reply] coach_prompt_adapter fallback", { conversation_id, code: "F-02" });
    }
  }

  // Step 2: prompt_overlay (orchestration path only; NO separate flag).
  // ⚠️ Schema unverified in L5b — comment-only. Future hook:
  //   const overlay = await loadPromptOverlay(conversation_id);
  //   basePrompt = mergeOverlay(basePrompt, overlay);  // in-memory only

  // Step 3: Customer360 Adapter (ENABLE_C360).
  // customer_context lives in memory only; full PII is never persisted or sent to LLM.
  let customerContext: { masked_summary?: string; tier?: string } | null = null;
  let opaqueCustomerRef: string | null = null;
  if (flags.ENABLE_C360) {
    const c360Result = await callCustomer360Adapter(conversation_id);
    if (c360Result.success && c360Result.customer_context) {
      // Adapter is expected to return masked/summarised data only.
      customerContext = c360Result.customer_context;
      opaqueCustomerRef = c360Result.customer_ref ?? null; // opaque cus_* / uuid only
    } else {
      // Fallback per Contract 06 §5: null context, default Standard tier.
      customerContext = null;
      console.warn("[generate-reply] customer360_adapter fallback", { conversation_id, code: "F-04" });
    }
  }

  // W5: Track chunks actually used in the final LLM prompt (post all safety/scope/score filtering)
  let finalPromptChunks: Array<{ title?: string; score?: number; source_type?: string }> = [];
  // Step 4: KB Adapter (ENABLE_KB) + L5 Safety Checks.
  // L5 RAG Answer Safety Contract v1.1b — Demo Implementation.
  // v1.2: company_id / industry from env (schema has no these fields).
  // ESC-MVP: _kbDone flag prevents null-access fall-through (4 runtime defects)
  let _kbDone = false;
  let ragResult: {
    success: boolean;
    no_answer?: boolean;
    retrieval_quality?: "high" | "medium" | "low" | "failed";
    chunks?: Array<{
      doc_id?: string;
      chunk_id?: string;
      title?: string;
      content?: string;
      score?: number;
      industry?: string;
      company_id?: number;
      language?: string;
      status?: string;
      source_type?: string;
      published_at?: string;
      updated_at?: string;
    }>;
    query_text_preview?: string;
    trace_metadata?: Record<string, unknown>;
  } | null = null;

  if (flags.ENABLE_KB && !_g1SkipKB) {
    // Resolve scope from env (Demo: schema has no company_id/industry fields)
    const demoCompanyIdStr = Deno.env.get("KB_DEMO_COMPANY_ID");
    const demoIndustry = Deno.env.get("KB_DEMO_INDUSTRY");
    const demoLanguage = Deno.env.get("KB_DEMO_LANGUAGE") ?? "zh-TW";

    const widgetCompanyId = demoCompanyIdStr ? parseInt(demoCompanyIdStr, 10) : null;
    const widgetIndustry = demoIndustry ?? null;

    // L5 Scope Gate: if scope unavailable, cannot safely query → handoff
    if (widgetCompanyId === null || isNaN(widgetCompanyId) || !widgetIndustry) {
      console.warn("[generate-reply] KB scope env vars not set", {
        conversation_id,
        hasCompanyId: widgetCompanyId !== null && !isNaN(widgetCompanyId),
        hasIndustry: !!widgetIndustry,
      });
      // S0: route to s0_handoff_tx when enabled; else existing KB fallback
      if (_escEnableS0) {
        return await handleS0Handoff(supabaseAdmin, conversation_id, source_message_id, "KB_SCOPE_GATE", _visitorLang);
      }
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        "KB_SCOPE_GATE",
        source_message_id,
        {
          rag_api_status: "scope_unavailable",
        },
        _visitorLang,
      );
    }

    // Get the latest user message for RAG query
    const { data: latestMsgs } = await supabaseAdmin
      .from("messages")
      .select("content")
      .eq("conversation_id", conversation_id)
      .eq("role", "visitor")
      .order("created_at", { ascending: false })
      .limit(1);
    const userQuery = latestMsgs?.[0]?.content ?? "";

    if (!userQuery) {
      ragResult = { success: true, no_answer: true, retrieval_quality: "failed", chunks: [] };
    } else {
      ragResult = await callKBAdapter(conversation_id, userQuery, {
        company_id: widgetCompanyId,
        industry: widgetIndustry,
        language: demoLanguage,
      });
    }

    // — L5 Safety Checks (Demo-only, inline) —
    if (!ragResult || !ragResult.success) {
      console.error("[CRITICAL] KB RAG API failure", { conversation_id, code: "KB_API_FAIL" });
      // S0: route to s0_handoff_tx when enabled; else existing KB fallback
      if (_escEnableS0) {
        return await handleS0Handoff(supabaseAdmin, conversation_id, source_message_id, "KB_API_FAIL", _visitorLang);
      }
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        "KB_API_FAIL",
        source_message_id,
        {
          rag_api_status: "failure",
        },
        _visitorLang,
      );
    }

    if (ragResult.no_answer || !ragResult.chunks || ragResult.chunks.length === 0) {
      console.warn("[generate-reply] KB no results", { conversation_id, code: "KB_EMPTY" });
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        "KB_EMPTY",
        source_message_id,
        {
          rag_api_status: "success_empty",
        },
        _visitorLang,
      );
    }

    // L5 Score threshold + scope filter (client-side double-check)
    // F-3: Distinguish transactional requests (high risk) from information queries
    const _f3Lower = userQuery.toLowerCase();
    const HIGH_RISK_TRANSACTIONAL = [
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
    const INFO_QUERY_OVERRIDE = [
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
    ];
    const ALWAYS_HIGH_RISK_TOPICS = [
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
    const matchesTransactional = HIGH_RISK_TRANSACTIONAL.some((re) => re.test(userQuery));
    const matchesInfoOverride = INFO_QUERY_OVERRIDE.some((re) => re.test(userQuery));
    const matchesAlwaysHigh = ALWAYS_HIGH_RISK_TOPICS.some((re) => re.test(userQuery));
    const isHighRisk = matchesAlwaysHigh || (matchesTransactional && !matchesInfoOverride);
    const minScore = isHighRisk ? 0.78 : 0.55;

    const usableChunks = ragResult.chunks.filter((c) => {
      if (!c.score || c.score < minScore) return false;
      if (c.status && c.status !== "published") return false;
      if (c.company_id !== undefined && c.company_id !== widgetCompanyId) return false;
      if (c.industry && c.industry !== widgetIndustry) return false;
      return true;
    });

    const traceMetadata = {
      rag_api_status: "success",
      total_results: ragResult.chunks.length,
      filtered_results: usableChunks.length,
      min_score_used: usableChunks.length > 0 ? Math.min(...usableChunks.map((c) => c.score ?? 0)) : null,
      max_score_used: usableChunks.length > 0 ? Math.max(...usableChunks.map((c) => c.score ?? 0)) : null,
      high_risk_topic: isHighRisk,
      min_threshold: minScore,
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
      const lowScoreBranch = isHighRisk ? "KB_LOW_SCORE_HIGH_RISK" : "KB_LOW_SCORE_STANDARD";
      console.warn("[generate-reply] KB all results below threshold", {
        conversation_id,
        minScore,
        isHighRisk,
        code: "KB_LOW_SCORE",
        branch: lowScoreBranch,
      });
      return await handleKBFallback(
        supabaseAdmin,
        conversation_id,
        lowScoreBranch,
        source_message_id,
        traceMetadata,
        _visitorLang,
      );
    }

    ragResult.chunks = usableChunks;
    ragResult.no_answer = false;
    finalPromptChunks = usableChunks; // W5: same variable used by buildRagBlock → LLM prompt
    _kbDone = true;
  }

  // ESC-MVP: mark done when KB intentionally skipped
  if (!flags.ENABLE_KB || _g1SkipKB) {
    _kbDone = true;
  }

  // ESC-MVP: safety check — KB was supposed to run but fell through without completion
  if (flags.ENABLE_KB && !_g1SkipKB && !_kbDone) {
    console.error("[generate-reply] CRITICAL: KB block fell through without completion", conversation_id);
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ error: "Internal KB processing error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Step 5: Tool registration — NOT in L5c Gate A.
  if (flags.ENABLE_TOOL_EXEC) {
    console.log("[generate-reply] ENABLE_TOOL_EXECUTOR=true: Gate present, tools NOT attached (L5d scope)");
  }

  // Step 7: LLM Generate.
  const maskedContextBlock = buildMaskedContextBlock(customerContext, opaqueCustomerRef);
  const ragBlock = buildRagBlock(ragResult);
  const finalSystemPrompt = [basePrompt, maskedContextBlock, ragBlock].filter((s) => s && s.length > 0).join("\n\n");

  const { data: messages } = await supabaseAdmin
    .from("messages")
    .select("role, content, created_at")
    .eq("conversation_id", conversation_id)
    .neq("content", "__THINKING__")
    .eq("is_recalled", false)
    .order("created_at", { ascending: true })
    .limit(10);

  if (!messages || messages.length === 0) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ success: true, skipped: "no messages" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const claudeMessages = messages.map((m) => ({
    role: m.role === "visitor" ? "user" : "assistant",
    content: m.content,
  }));

  if (claudeMessages[claudeMessages.length - 1].role === "assistant") {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ success: true, skipped: "last message is assistant" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ error: "AI service not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const anthropicRequestBody: Record<string, unknown> = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 500,
    system: finalSystemPrompt,
    messages: claudeMessages,
  };
  if (flags.ENABLE_TOOL_EXEC) {
    anthropicRequestBody.tools = TOOL_DEFINITIONS;
  }

  // F-1: Explicit timeout guard (orchestration)
  const _orchAbortCtrl = new AbortController();
  const _orchTimeout = setTimeout(() => _orchAbortCtrl.abort(), ANTHROPIC_TIMEOUT_MS);
  let claudeResponse: Response;
  try {
    claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(anthropicRequestBody),
      signal: _orchAbortCtrl.signal,
    });
  } catch (e) {
    clearTimeout(_orchTimeout);
    if (e instanceof DOMException && e.name === "AbortError") {
      console.error("[generate-reply] F-1 orchestration Anthropic timeout:", conversation_id);
      // S0: route to s0_handoff_tx when enabled
      if (_escEnableS0) {
        return await handleS0Handoff(supabaseAdmin, conversation_id, source_message_id, "LLM_TIMEOUT", _visitorLang);
      }
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    } else {
      console.error("[generate-reply] orchestration Anthropic fetch error:", e);
      // S0: route to s0_handoff_tx when enabled
      if (_escEnableS0) {
        return await handleS0Handoff(
          supabaseAdmin,
          conversation_id,
          source_message_id,
          "LLM_NETWORK_ERROR",
          _visitorLang,
        );
      }
      await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    }
    return new Response(JSON.stringify({ error: "AI service timeout" }), {
      status: 504,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  clearTimeout(_orchTimeout);

  if (!claudeResponse.ok) {
    const errText = await claudeResponse.text();
    console.error("[generate-reply] Claude API error:", claudeResponse.status, errText);
    // S0: route to s0_handoff_tx when enabled
    if (_escEnableS0) {
      return await handleS0Handoff(supabaseAdmin, conversation_id, source_message_id, "LLM_NON_2XX", _visitorLang);
    }
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ error: "AI service error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const claudeData = await claudeResponse.json();
  const aiReplyContent = claudeData.content?.[0]?.text ?? "";

  if (!aiReplyContent) {
    // S0: route to s0_handoff_tx when enabled
    if (_escEnableS0) {
      return await handleS0Handoff(
        supabaseAdmin,
        conversation_id,
        source_message_id,
        "LLM_EMPTY_RESPONSE",
        _visitorLang,
      );
    }
    await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);
    return new Response(JSON.stringify({ error: "Empty AI response" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  await cleanupThinking(supabaseAdmin, conversation_id, source_message_id);

  // W5: Build citation metadata from the exact chunks used in the LLM prompt
  const citationMeta = finalPromptChunks.length > 0 ? buildCitationMetadata(finalPromptChunks) : null;

  await supabaseAdmin.from("messages").insert({
    conversation_id,
    role: "assistant",
    content: aiReplyContent,
    status: "delivered",
    is_recalled: false,
    metadata: citationMeta,
  });

  await supabaseAdmin.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversation_id);

  if (flags.ENABLE_COACH) {
    void coachTrace;
  }

  if (flags.ENABLE_KB && ragResult?.success) {
    void ragResult;
  }

  console.log("[generate-reply] AI reply sent (orchestration path) for conversation:", conversation_id);
  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function safeRefusal(code: string): Response {
  return new Response(
    JSON.stringify({ success: true, skipped: "refused", reason_code: code, handoff_required: true }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

function buildMaskedContextBlock(
  customerContext: { masked_summary?: string; tier?: string } | null,
  opaqueCustomerRef: string | null,
): string {
  if (!customerContext) return "";
  const parts: string[] = [];
  if (customerContext.tier) parts.push(`Customer tier: ${customerContext.tier}`);
  if (customerContext.masked_summary) parts.push(customerContext.masked_summary);
  if (opaqueCustomerRef) {
    const pseudo = pseudonymizeRef(opaqueCustomerRef);
    parts.push(`Customer reference (pseudonymous): ${pseudo}`);
  }
  if (parts.length === 0) return "";
  return `Customer context (masked):\n${parts.join("\n")}`;
}

function buildRagBlock(
  ragResult: {
    success: boolean;
    chunks?: Array<{ title?: string; content?: string; score?: number; source_type?: string; short_snippet?: string }>;
  } | null,
): string {
  if (!ragResult || !ragResult.success || !ragResult.chunks?.length) return "";
  const snippets = ragResult.chunks
    .map((c, i) => {
      const text = c.content ?? c.short_snippet ?? "";
      const source = c.title ? `[Source: ${c.title}]` : `[${i + 1}]`;
      return `${source}\n${text.slice(0, 500)}`;
    })
    .join("\n\n");
  return `You MUST answer ONLY based on the following knowledge base evidence.\nDo NOT add information not present in the evidence.\nIf the evidence does not fully answer the question, say so and offer to connect to a human agent.\n\nEvidence:\n${snippets}`;
}

function pseudonymizeRef(ref: string): string {
  let h = 0;
  for (let i = 0; i < ref.length; i++) h = ((h << 5) - h + ref.charCodeAt(i)) | 0;
  return `cust_${(h >>> 0).toString(36)}`;
}

// ── C0: Coach Prompt Adapter (adapter-ready, no real API until C1) ──────────
async function callCoachPromptAdapter(conversation_id: string): Promise<{
  success: boolean;
  content?: string;
  version_id?: string;
  version_label?: string;
  prompt_hash?: string;
  error_type?: string;
}> {
  const FAIL = (error_type: string) => ({ success: false as const, error_type });
  const endpoint = Deno.env.get("COACH_PROMPT_ENDPOINT");
  const token = Deno.env.get("COACH_PROMPT_INTERNAL_TOKEN");
  const timeoutMs = parseInt(Deno.env.get("COACH_AI_TIMEOUT_MS") || "3000");

  // Gate 1: endpoint not configured (expected in C0 — SU CoachAI API not yet built)
  if (!endpoint) {
    console.log("[generate-reply] COACH_API_NOT_CONFIGURED", { conversation_id });
    return FAIL("COACH_API_NOT_CONFIGURED");
  }

  // Gate 2: token not configured
  if (!token) {
    console.warn("[generate-reply] COACH_TOKEN_MISSING", { conversation_id });
    return FAIL("COACH_TOKEN_MISSING");
  }

  // Gate 3: actual API call (C1 scope — executes when endpoint + token are both set)
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

    if (!response.ok) {
      console.warn("[generate-reply] COACH_API_ERROR", { conversation_id, status: response.status });
      return FAIL("COACH_API_ERROR");
    }

    let data;
    try {
      data = await response.json();
    } catch {
      console.warn("[generate-reply] COACH_JSON_INVALID", { conversation_id });
      return FAIL("COACH_JSON_INVALID");
    }

    if (!data.ok || !data.data?.content) {
      console.warn("[generate-reply] COACH_NO_ACTIVE_PROMPT", { conversation_id });
      return FAIL("COACH_NO_ACTIVE_PROMPT");
    }

    const content = data.data.content;
    const validationError = validateCoachPromptContent(content);
    if (validationError) {
      console.warn(`[generate-reply] ${validationError}`, { conversation_id, len: content?.length });
      return FAIL(validationError);
    }

    const versionId = data.data.id || "";
    const promptHash = await computePromptHash(content, versionId, conversation_id);

    console.log("[generate-reply] Coach prompt fetched:", {
      conversation_id,
      version_label: data.data.label || "",
      prompt_hash: promptHash,
      source: "upstream",
    });

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
      console.warn("[generate-reply] COACH_API_TIMEOUT", { conversation_id, timeoutMs });
      return FAIL("COACH_API_TIMEOUT");
    }
    console.warn("[generate-reply] COACH_API_EXCEPTION", { conversation_id, error: String(err) });
    return FAIL("COACH_API_EXCEPTION");
  }
}

// ── C0: Validate coach prompt content ───────────────────────────────────────
function validateCoachPromptContent(content: unknown): string | null {
  if (typeof content !== "string") return "COACH_SCHEMA_INVALID";
  if (content.length === 0) return "COACH_CONTENT_EMPTY";
  if (content.length > 20000) return "COACH_CONTENT_TOO_LONG";
  if (/sk-ant-[a-zA-Z0-9]+/.test(content)) return "COACH_SCHEMA_INVALID";
  if (/service_role/.test(content)) return "COACH_SCHEMA_INVALID";
  return null;
}

// ── C0: Compute prompt hash — SHA-256(content + version_id + conversation_id) first 12 hex ──
async function computePromptHash(content: string, versionId: string, conversationId: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashInput = content + "|" + versionId + "|" + conversationId;
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(hashInput));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return hashHex.substring(0, 12);
}
// ── End C0 additions ────────────────────────────────────────────────────────

async function callCustomer360Adapter(_conversation_id: string): Promise<{
  success: boolean;
  customer_context?: { masked_summary?: string; tier?: string };
  customer_ref?: string;
}> {
  return { success: false };
}

async function callKBAdapter(
  _conversation_id: string,
  userMessage: string,
  scope: { company_id: number; industry: string; language: string },
): Promise<{
  success: boolean;
  no_answer?: boolean;
  retrieval_quality?: "high" | "medium" | "low" | "failed";
  chunks?: KBFullChunk[];
  query_text_preview?: string;
}> {
  const kbConfig = resolveKBConfig();
  if (!kbConfig) {
    console.error("[CRITICAL] KB config not available");
    return { success: false, no_answer: true, retrieval_quality: "failed" };
  }

  const result = await fetchKBRag(
    {
      query: userMessage,
      top_k: 5,
      company_id: scope.company_id,
      industry: scope.industry,
      language: scope.language,
    },
    kbConfig,
    { timeoutMs: 15000 },
  );

  if (!result.success) {
    console.error("[CRITICAL] KB RAG API failure", { code: result.error_code });
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
    query_text_preview: userMessage.slice(0, 100),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// L5c Tool Executor Gate — deterministic decision layer (Gate A).
// [Unchanged from original — full implementation retained below]
// ────────────────────────────────────────────────────────────────────────────

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
  privacy_flags?: { do_not_profile?: boolean; consent_status?: "granted" | "withdrawn" | "unknown" };
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
const READ_ONLY_TOOLS = ["kb_search", "get_customer_context", "get_order_summary"] as const;
const HIGH_RISK_ALLOWED = ["kb_search", "get_customer_context", "escalate_to_human", "create_handoff_summary"] as const;
const OFFLINE_BOT_ALLOWED = ["kb_search", "escalate_to_human"] as const;
const MAX_TOOL_CALLS = 10;
const MAX_KB_SEARCH = 3;
const MAX_C360_CALLS = 2;

function buildSafeDedupeKey(
  tool_name: string,
  input: Record<string, unknown>,
  server_resolved_customer_ref?: string | null,
): string | null {
  if (tool_name === "get_order_summary") {
    if (!server_resolved_customer_ref) return null;
    return `get_order_summary:${server_resolved_customer_ref}`;
  }
  const SAFE_FIELDS: Record<string, string[]> = {
    kb_search: ["query_norm", "locale"],
    get_customer_context: [],
    escalate_to_human: ["reason_code"],
    create_handoff_summary: ["reason_code"],
    mark_unresolved: ["reason_code"],
    suggest_reply: ["intent_code"],
  };
  const allowed = SAFE_FIELDS[tool_name] ?? [];
  const safe: Record<string, unknown> = {};
  for (const k of allowed) {
    if (input[k] !== undefined && typeof input[k] !== "object") {
      safe[k] = String(input[k]).slice(0, 200);
    }
  }
  return `${tool_name}:${JSON.stringify(safe)}`;
}

export function toolExecutorGate(toolRequest: ToolRequest, context: ExecutionContext): GateDecision {
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
  if (tool_name === "schedule_feedback_request") return { decision: "DENY", reason: "TOOL_EXCLUDED" };
  if (!(ALLOWED_TOOLS as readonly string[]).includes(tool_name))
    return { decision: "DENY", reason: "TOOL_NOT_REGISTERED" };
  const status = conversation.status;
  if (status === "resolved" || status === "closed") return { decision: "DENY", reason: "CONV_RESOLVED_OR_CLOSED" };
  if (
    (status === "human_needed" || status === "human_control") &&
    !(READ_ONLY_TOOLS as readonly string[]).includes(tool_name)
  )
    return { decision: "DENY", reason: "TOOL_NOT_ALLOWED_IN_STATUS" };
  if (status === "offline_bot" && !(OFFLINE_BOT_ALLOWED as readonly string[]).includes(tool_name))
    return { decision: "DENY", reason: "TOOL_NOT_ALLOWED_OFFLINE" };
  if (risk_level === "high" && !(HIGH_RISK_ALLOWED as readonly string[]).includes(tool_name))
    return { decision: "ESCALATE", reason: "HIGH_RISK_TOOL_BLOCKED" };
  if (tool_name === "mark_unresolved" && caller_mode === "system_auto")
    return { decision: "DENY", reason: "MARK_UNRESOLVED_REQUIRES_HUMAN" };
  if (privacy_flags?.do_not_profile === true || privacy_flags?.consent_status === "withdrawn") {
    if (tool_name === "get_customer_context") return { decision: "DENY", reason: "PRIVACY_DO_NOT_PROFILE" };
  }
  const dedupe_key = buildSafeDedupeKey(tool_name, input, server_resolved_customer_ref);
  if (dedupe_key === null) return { decision: "DENY", reason: "SERVER_REFERENCE_REQUIRED" };
  if (turn_tool_calls.has(dedupe_key)) return { decision: "DENY", reason: "DUPLICATE_TOOL_CALL_IN_TURN" };
  turn_tool_calls.add(dedupe_key);
  if (turn_budget.total >= MAX_TOOL_CALLS) return { decision: "DENY", reason: "TOOL_BUDGET_EXCEEDED" };
  if (tool_name === "kb_search" && turn_budget.kb_search >= MAX_KB_SEARCH)
    return { decision: "DENY", reason: "KB_SEARCH_BUDGET_EXCEEDED" };
  if (tool_name === "get_customer_context" && turn_budget.c360 >= MAX_C360_CALLS)
    return { decision: "DENY", reason: "C360_BUDGET_EXCEEDED" };
  if (status === "ai_draft_only" || status === "unresolved")
    return {
      decision: "DOWNGRADE_TO_DRAFT",
      reason: "STATUS_DRAFT_ONLY",
      execution_allowed: true,
      force_draft: true,
      execution_deferred_to: "L5d",
      draft_enforcement_deferred_to: "L5e",
    };
  if (status === "escalation_risk")
    return {
      decision: "DOWNGRADE_TO_DRAFT",
      reason: "ESCALATION_RISK_DOWNGRADE",
      execution_allowed: true,
      force_draft: true,
      execution_deferred_to: "L5d",
      draft_enforcement_deferred_to: "L5e",
    };
  return { decision: "ALLOW", reason: "GATE_PASSED", execution_allowed: true, execution_deferred_to: "L5d" };
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
      return { decision: "DENY", reason: decision.reason, message_to_llm: "tool not available in current context" };
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
      return { decision: "ESCALATE", reason: decision.reason, handoff_required: true, action_deferred_to: "L5e" };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// L5d — Tool Definitions & Stubs (Gate A — unchanged from original)
// ────────────────────────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    name: "kb_search",
    description: "Search the knowledge base for policy, FAQ, or product information to answer customer questions.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query extracted from customer message (must be PII-redacted before stub log or trace).",
        },
        industry: { type: "string", description: "Industry context (optional, inferred from conversation)." },
        top_k: { type: "number", description: "Number of results to return (default 5, max 10)." },
      },
      required: ["query"],
    },
  },
  {
    name: "escalate_to_human",
    description: "Escalate conversation to a human agent when AI cannot resolve the issue.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Reason for escalation (sanitized, no PII)." },
        summary: { type: "string", description: "Brief conversation summary (sanitized, max 500 chars, no PII)." },
      },
      required: ["reason", "summary"],
    },
  },
  {
    name: "get_customer_context",
    description: "Get customer context (tier, sentiment, language preference) to personalize response tone.",
    input_schema: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Requested fields (advisory only — server enforces masking level allowlist).",
        },
      },
      required: [],
    },
  },
  {
    name: "get_order_summary",
    description: "Get order status summary for delivery, return, or refund inquiries.",
    input_schema: {
      type: "object",
      properties: {
        inquiry_type: {
          type: "string",
          enum: ["delivery_status", "return_request", "refund_inquiry", "order_general"],
          description: "Type of order inquiry.",
        },
      },
      required: ["inquiry_type"],
    },
  },
  {
    name: "create_handoff_summary",
    description: "Generate a conversation summary for the human agent who will take over this conversation.",
    input_schema: {
      type: "object",
      properties: {
        summary_focus: {
          type: "string",
          description: "Optional focus area for the summary (e.g. 'refund concern', 'delivery issue').",
        },
      },
      required: [],
    },
  },
  {
    name: "mark_unresolved",
    description: "Mark conversation as unresolved for follow-up. Only available in console suggest mode.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Reason conversation is unresolved (sanitized)." },
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
    description: "Generate a suggested reply for the customer based on KB findings and context.",
    input_schema: {
      type: "object",
      properties: {
        context_summary: {
          type: "string",
          description: "Summary of context assembled by generate-reply (sanitized, max 500 chars, no PII).",
        },
        sources: { type: "array", items: { type: "string" }, description: "Citation labels from KB results." },
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
        tool_name: "kb_search",
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
        tool_name: "escalate_to_human",
        status: "stub",
        result_classification: "internal_only",
        escalated: false,
        stub_note: "Escalation workflow deferred to L5e — no state changes in L5d",
      };
    case "get_customer_context":
      return {
        tool_name: "get_customer_context",
        status: "stub",
        result_classification: "internal_only",
        customer_context: { tier: "Standard", language_preference: "en", sentiment: "neutral" },
        stub_note: "Customer360 adapter not yet enabled (L5d stub) — using safe defaults",
      };
    case "get_order_summary":
      return {
        tool_name: "get_order_summary",
        status: "stub",
        result_classification: "internal_only",
        order_available: false,
        stub_note: "Order adapter not yet enabled (L5d stub)",
      };
    case "create_handoff_summary":
      return {
        tool_name: "create_handoff_summary",
        status: "stub",
        result_classification: "internal_only",
        summary: "[Handoff summary not yet available — L5d stub]",
        stub_note: "Handoff summary generation deferred to L5e; conversation_id server-side only",
      };
    case "mark_unresolved":
      return {
        tool_name: "mark_unresolved",
        status: "stub",
        result_classification: "internal_only",
        marked: false,
        stub_note: "mark_unresolved write action deferred to L5e — no state changes in L5d",
      };
    case "suggest_reply":
      return {
        tool_name: "suggest_reply",
        status: "stub",
        result_classification: "internal_only",
        draft_content: "",
        confidence: 0,
        recommended_action: "human_review",
        stub_note: "suggest_reply draft write deferred to L5e — no state changes in L5d",
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

// ────────────────────────────────────────────────────────────────────────────
// L5e — Draft / Handoff / Auto-Send Policy (Gate A — unchanged from original)
// ────────────────────────────────────────────────────────────────────────────

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
  result_classification?: "public_safe" | "draft_only" | "supervisor_only" | "internal_only";
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
  if (!guardrailsPass.pass) return { action: "draft_only", reason: guardrailsPass.reason };
  return { action: "auto_send", reason: "GUARDRAILS_PASSED" };
}

export function checkGuardrails(
  toolResults: L5eToolResult[],
  ragResult: L5eRagResult | null,
  mode: L5eCallerMode,
): L5eGuardrailResult {
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
    if (result.result_classification === "supervisor_only")
      return { pass: false, reason: "TOOL_RESULT_SUPERVISOR_ONLY" };
  }
  const suggestResult = toolResults.find((r) => r.tool_name === "suggest_reply");
  if (suggestResult?.citation_required && !suggestResult?.has_valid_citation)
    return { pass: false, reason: "SUGGEST_REPLY_MISSING_CITATION" };
  if (toolResults.some((r) => r.handoff_required)) return { pass: false, reason: "HANDOFF_REQUIRED_BY_TOOL" };
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

function l5eSanitize(input: string | undefined | null, opts: { maxChars: number; noPII: boolean }): string {
  if (!input) return "";
  let s = String(input);
  if (opts.noPII) {
    s = s.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]");
    s = s.replace(/\+?\d[\d\s\-().]{7,}\d/g, "[phone]");
    s = s.replace(/\b\d{9,}\b/g, "[digits]");
  }
  if (s.length > opts.maxChars) s = s.slice(0, opts.maxChars);
  return s;
}

export async function executeSuggestReply(
  _input: L5eSuggestReplyInput,
  context: L5eExecutionContextLike,
  outputMode: L5eOutputMode,
): Promise<L5eDeferredResult> {
  if (!context.flags.ENABLE_TOOL_EXEC) return { auto_sent: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
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
  if (!context.flags.ENABLE_TOOL_EXEC) return { escalated: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
  return { deferred: true, reason: "GATE_B_REQUIRED" };
}

export async function executeMarkUnresolved(
  input: L5eMarkUnresolvedInput,
  context: L5eExecutionContextLike,
): Promise<L5eDeferredResult> {
  if (!context.flags.ENABLE_TOOL_EXEC) return { marked: false, deferred: true, reason: "TOOL_EXEC_DISABLED" };
  void input;
  return { deferred: true, reason: "GATE_B_REQUIRED" };
}
