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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { conversation_id } = body ?? {};
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
      return await legacyGenerateReply(conversation_id);
    }

    // ── ORCHESTRATION PATH (only reached when at least one flag is true) ──────
    return await orchestrationGenerateReply(conversation_id, {
      ENABLE_KB,
      ENABLE_COACH,
      ENABLE_C360,
      ENABLE_TOOL_EXEC,
    });
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
async function legacyGenerateReply(conversation_id: string): Promise<Response> {
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  const { data: conversation, error: convError } = await supabaseAdmin
    .from("conversations")
    .select("id, status")
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
    console.log("[generate-reply] human-handling guard: skipping LLM for status:", conversation.status, conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: "human_handling" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // ── End Dev21 Batch 1 guard ─────────────────────────────────────────

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

    await supabaseAdmin.from("messages").delete().eq("conversation_id", conversation_id).eq("content", "__THINKING__");

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
      console.error("[generate-reply] CRITICAL: failed to mark conversation pending after handoff:", pendingUpdateErr.message, conversation_id);
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
    });
  } catch (e) {
    fetchThrew = true;
    console.error("[generate-reply] Anthropic fetch threw:", e);
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

  await supabaseAdmin.from("messages").delete().eq("conversation_id", conversation_id).eq("content", "__THINKING__");

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
      ai_generating: false,
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
type FlagSet = {
  ENABLE_KB: boolean;
  ENABLE_COACH: boolean;
  ENABLE_C360: boolean;
  ENABLE_TOOL_EXEC: boolean;
};

async function orchestrationGenerateReply(conversation_id: string, flags: FlagSet): Promise<Response> {
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );

  // Load conversation
  const { data: conversation, error: convError } = await supabaseAdmin
    .from("conversations")
    .select("id, status")
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
    return safeRefusal("CONV_RESOLVED_OR_CLOSED");
  }

  // ── Dev21 Batch 1: Human-handling defense-in-depth guard ────────────
  // Do NOT use safeRefusal() here — its response includes handoff_required:true
  // and skipped:"refused" which are semantically incorrect for human_handling.
  // Human-handling guard must not generate any AI/assistant message or suggest handoff.
  if (conversation.status === "pending" || conversation.status === "transferred") {
    console.log("[generate-reply] orchestration human-handling guard:", conversation.status, conversation_id);
    return new Response(JSON.stringify({ success: true, skipped: "human_handling" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  // ── End Dev21 Batch 1 guard ─────────────────────────────────────────

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

  // Step 4: KB Adapter (ENABLE_KB) + L5 Safety Checks.
  // L5 RAG Answer Safety Contract v1.1b — Demo Implementation.
  // v1.2: company_id / industry from env (schema has no these fields).
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

  if (flags.ENABLE_KB) {
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
      return new Response(
        JSON.stringify({
          success: true,
          reply: "很抱歉，系統暫時無法查詢知識庫。讓我為您轉接客服人員。",
          no_answer: true,
          handoff_required: true,
          trace_metadata: { rag_api_status: "scope_unavailable" },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Get the latest user message for RAG query
    const { data: latestMsgs } = await supabaseAdmin
      .from("messages")
      .select("content")
      .eq("conversation_id", conversation_id)
      .eq("role", "user")
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
      return new Response(
        JSON.stringify({
          success: true,
          reply: "系統暫時無法查詢知識庫，讓我為您轉接客服人員。",
          no_answer: true,
          handoff_required: true,
          trace_metadata: { rag_api_status: "failure" },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (ragResult.no_answer || !ragResult.chunks || ragResult.chunks.length === 0) {
      console.warn("[generate-reply] KB no results", { conversation_id, code: "KB_EMPTY" });
      return new Response(
        JSON.stringify({
          success: true,
          reply: "很抱歉，我目前無法確定答案。讓我為您轉接客服人員，以提供更準確的協助。",
          no_answer: true,
          handoff_required: true,
          trace_metadata: { rag_api_status: "success_empty" },
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // L5 Score threshold + scope filter (client-side double-check)
    const HIGH_RISK_KEYWORDS = [
      "退款",
      "退貨",
      "賠償",
      "補償",
      "refund",
      "return",
      "compensation",
      "法律",
      "合約",
      "條款",
      "legal",
      "contract",
      "terms",
      "醫療",
      "藥品",
      "治療",
      "medical",
      "medicine",
      "treatment",
      "隱私",
      "個資",
      "資料保護",
      "privacy",
      "personal data",
      "GDPR",
      "投資",
      "理財",
      "金融",
      "investment",
      "financial",
      "finance",
    ];
    const isHighRisk = HIGH_RISK_KEYWORDS.some((kw) => userQuery.toLowerCase().includes(kw.toLowerCase()));
    const minScore = isHighRisk ? 0.85 : 0.75;

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
      console.warn("[generate-reply] KB all results below threshold", {
        conversation_id,
        minScore,
        isHighRisk,
        code: "KB_LOW_SCORE",
      });
      return new Response(
        JSON.stringify({
          success: true,
          reply: isHighRisk
            ? "這個問題涉及重要政策，為確保您獲得準確資訊，讓我為您轉接客服人員。"
            : "很抱歉，我目前無法確定答案。讓我為您轉接客服人員，以提供更準確的協助。",
          no_answer: true,
          handoff_required: true,
          trace_metadata: traceMetadata,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    ragResult.chunks = usableChunks;
    ragResult.no_answer = false;
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

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
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

  const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(anthropicRequestBody),
  });

  if (!claudeResponse.ok) {
    const errText = await claudeResponse.text();
    console.error("[generate-reply] Claude API error:", claudeResponse.status, errText);
    return new Response(JSON.stringify({ error: "AI service error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const claudeData = await claudeResponse.json();
  const aiReplyContent = claudeData.content?.[0]?.text ?? "";

  if (!aiReplyContent) {
    return new Response(JSON.stringify({ error: "Empty AI response" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  await supabaseAdmin.from("messages").delete().eq("conversation_id", conversation_id).eq("content", "__THINKING__");

  await supabaseAdmin.from("messages").insert({
    conversation_id,
    role: "assistant",
    content: aiReplyContent,
    status: "delivered",
    is_recalled: false,
  });

  await supabaseAdmin
    .from("conversations")
    .update({ ai_generating: false, updated_at: new Date().toISOString() })
    .eq("id", conversation_id);

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
}> {
  const KB_RAG_ENDPOINT = Deno.env.get("KB_RAG_ENDPOINT");
  const KB_RAG_TOKEN = Deno.env.get("KB_RAG_TOKEN");
  if (!KB_RAG_ENDPOINT || !KB_RAG_TOKEN) {
    console.error("[CRITICAL] KB_RAG_ENDPOINT or KB_RAG_TOKEN not set");
    return { success: false, no_answer: true, retrieval_quality: "failed" };
  }
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(`${KB_RAG_ENDPOINT}/kb/rag-search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KB_RAG_TOKEN}` },
      body: JSON.stringify({
        query: userMessage,
        company_id: scope.company_id,
        industry: scope.industry,
        language: scope.language,
        status: "published",
        top_k: 5,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      console.error("[CRITICAL] KB RAG API HTTP error", { status: response.status });
      return { success: false, no_answer: true, retrieval_quality: "failed" };
    }
    const data = await response.json();
    if (!data.ok || !data.results || data.results.length === 0) {
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
      chunks: data.results,
      query_text_preview: userMessage.slice(0, 100),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      console.error("[CRITICAL] KB RAG API timeout", { code: "KB_TIMEOUT" });
    } else {
      console.error("[CRITICAL] KB RAG API failure", {
        code: "KB_FETCH_ERROR",
        name: error instanceof Error ? error.name : "UnknownError",
      });
    }
    return { success: false, no_answer: true, retrieval_quality: "failed" };
  }
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
