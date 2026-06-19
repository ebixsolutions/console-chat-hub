// coach_prompt_adapter — NexusAI Phase 2 L4b
// Internal-only adapter. Callable ONLY server-side by generate-reply / prompt-preview
// with header X-Internal-Service-Token === COACH_PROMPT_INTERNAL_TOKEN.
// Fail-closed: any other caller -> 401, no business logic, no DB writes.
//
// Contract refs: 03 §4.2 (C-class adapter), 05 v1.1 (CoachAI prompt adapter),
//                08 F-01 (FM_PROMPT_UNAVAILABLE).
//
// HARD RULES:
// - No CORS for browsers (no Access-Control-Allow-Origin: *).
// - SU Coach AI is the single source of truth for PromptVersion.
//   NEVER persist full prompt content anywhere.
// - final_prompt_trace stores only: version_id / version_label / prompt_hash /
//   redacted_snapshot(≤4000 chars). Never the full body.
// - No new tables / columns / migrations / enum values.
// - URL must come from Deno.env.get("COACH_AI_API_URL") only — never hardcode
//   any Base44 app URL or any other inferred endpoint.
// - caller_type in request body is UNTRUSTED for auth/visibility (Gate A).

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// -- types --------------------------------------------------------------

interface CoachPromptAdapterInput {
  conversation_id: string;
  workspace_id: string;
  tenant_id: string;
  // caller_type: NOT TRUSTED in L4b Gate A. Accepted but ignored for visibility.
  caller_type?: string;
  persona?: string;
}

interface TraceData {
  version_id: string;
  version_label: string;
  prompt_hash: string;
  redacted_snapshot: string; // ≤4000 chars, no full body, no PII/keys
}

interface CoachPromptAdapterOutput {
  success: boolean;
  source: "upstream" | "minimal_fallback";
  version_id?: string;
  version_label?: string;
  persona?: string;
  version_number?: string;
  status?: string;
  is_active?: boolean;
  prompt_hash?: string;
  // content is NEVER returned in Gate A (no caller_type-based visibility).
  content?: string | null;
  metrics?: {
    avg_quality_score?: number;
    avg_csat?: number;
    hallucination_rate?: number;
    escalation_rate?: number;
  };
  handoff_required: boolean;
  use_fallback: boolean;
  trace_data: TraceData | null;
  error?: { error_code: string; message_safe: string; retryable: boolean };
  request_id: string;
}

// -- helpers ------------------------------------------------------------

function jsonNoCors(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function newRequestId(): string {
  return crypto.randomUUID();
}

function safeError(code: string): string {
  // Generic, sanitized messages. Never mention env names / secret names /
  // prompt content / tokens / stack traces.
  const map: Record<string, string> = {
    UNAUTHORIZED: "Unauthorized.",
    INVALID_INPUT: "Invalid input.",
    COACH_CONFIG_MISSING: "Prompt service temporarily unavailable.",
    COACH_TIMEOUT: "Prompt service timed out.",
    COACH_NETWORK: "Prompt service unreachable.",
    COACH_AUTH: "Prompt service authorization failed.",
    COACH_4XX: "Prompt service rejected the request.",
    COACH_5XX: "Prompt service internal error.",
    COACH_BAD_RESPONSE: "Prompt service returned an unexpected response.",
    NON_ACTIVE_PROMPT: "Active prompt unavailable.",
    INTERNAL: "Internal adapter error.",
  };
  return map[code] ?? "Internal adapter error.";
}

function getServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// -- DB writes (best-effort, never throw to caller) ---------------------

async function writeUpstreamLog(
  supa: SupabaseClient,
  args: {
    conversation_id: string;
    request_id: string;
    // Use existing schema values only. We do NOT add new enum values.
    // 'fallback'/'blocked' distinction lives in request_payload.status field.
    statusTag: "success" | "failed" | "timeout" | "fallback" | "blocked";
    httpStatus: number;
    latency_ms: number;
    endpoint?: string;
    source?: "upstream" | "minimal_fallback";
    error_code?: string;
    error_message_safe?: string;
  },
) {
  try {
    await supa.from("upstream_call_log").insert({
      conversation_id: args.conversation_id,
      upstream_service: "coach_ai",
      // request_payload is the metadata sink — no token, no PII, no full prompt.
      request_payload: {
        adapter_name: "coach_prompt_adapter",
        request_id: args.request_id,
        endpoint: args.endpoint,
        status: args.statusTag,
        source: args.source,
        error_code: args.error_code,
      },
      response_status: args.httpStatus,
      response_latency_ms: args.latency_ms,
      error_message: args.error_message_safe ?? null,
    });
  } catch (e) {
    console.error("[coach_prompt_adapter] upstream_call_log insert failed:", (e as Error).message);
  }
}

async function writeFinalPromptTrace(
  supa: SupabaseClient,
  args: {
    conversation_id: string;
    request_id: string;
    source: "upstream" | "minimal_fallback";
    trace: TraceData;
    fallback_id?: string;
    fallback_hash?: string;
  },
) {
  try {
    // Map to existing columns ONLY. Full prompt content is never stored.
    // - system_prompt_snapshot: redacted_snapshot (≤4000), label only for fallback.
    // - rag_context: jsonb sink for version_id/label/hash/source/request_id.
    const snapshot = (args.trace.redacted_snapshot ?? "").slice(0, 4000);
    await supa.from("final_prompt_trace").insert({
      conversation_id: args.conversation_id,
      system_prompt_snapshot: snapshot,
      user_message: "",
      rag_context: {
        adapter: "coach_prompt_adapter",
        request_id: args.request_id,
        source: args.source,
        version_id: args.trace.version_id,
        version_label: args.trace.version_label,
        prompt_hash: args.trace.prompt_hash,
        fallback_id: args.fallback_id,
        fallback_hash: args.fallback_hash,
      },
    });
  } catch (e) {
    console.error("[coach_prompt_adapter] final_prompt_trace insert failed:", (e as Error).message);
  }
}

// -- Minimal Safe Fallback (Contract 05 §5) -----------------------------
// Hardcoded safety guardrail. NOT a PromptVersion. Never auto-sent in Gate A.

const MINIMAL_SAFE_FALLBACK_PROMPT = `You are a customer service assistant.
Only answer questions that are directly supported by provided knowledge sources.
Do not interpret or explain policies beyond what is explicitly stated.
Do not make promises about promotions, refunds, or compensation.
For any high-risk request (refund, payment dispute, legal, privacy, medical):
  escalate to human agent immediately.
Keep responses factual, neutral, and brief.`;

const MINIMAL_SAFE_FALLBACK_ID = "MINIMAL_SAFE_FALLBACK_V1";
const MINIMAL_SAFE_FALLBACK_LABEL = "Minimal safety guardrail v1";

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// -- handler ------------------------------------------------------------

Deno.serve(async (req) => {
  // No CORS preflight for browsers; only server-side POST.
  if (req.method !== "POST") {
    return jsonNoCors(
      { error: { error_code: "INVALID_INPUT", message_safe: "Method not allowed", retryable: false } },
      405,
    );
  }

  const request_id = newRequestId();
  const internalToken = Deno.env.get("COACH_PROMPT_INTERNAL_TOKEN");
  const presented =
    req.headers.get("X-Internal-Service-Token") ?? req.headers.get("x-internal-service-token");

  // Fail-closed auth. No business logic, no business-table writes.
  if (!internalToken || !presented || presented !== internalToken) {
    console.warn(JSON.stringify({
      request_id,
      ts: new Date().toISOString(),
      reason: "unauthorized_internal_adapter_call",
    }));
    return jsonNoCors(
      {
        success: false,
        source: "upstream",
        handoff_required: true,
        use_fallback: false,
        trace_data: null,
        error: { error_code: "UNAUTHORIZED", message_safe: safeError("UNAUTHORIZED"), retryable: false },
        request_id,
      },
      401,
    );
  }

  let input: CoachPromptAdapterInput;
  try {
    input = await req.json();
  } catch {
    return jsonNoCors(
      {
        success: false,
        source: "upstream",
        handoff_required: true,
        use_fallback: false,
        trace_data: null,
        error: { error_code: "INVALID_INPUT", message_safe: safeError("INVALID_INPUT"), retryable: false },
        request_id,
      },
      400,
    );
  }

  if (!input?.conversation_id || !input?.workspace_id || !input?.tenant_id) {
    return jsonNoCors(
      {
        success: false,
        source: "upstream",
        handoff_required: true,
        use_fallback: false,
        trace_data: null,
        error: { error_code: "INVALID_INPUT", message_safe: safeError("INVALID_INPUT"), retryable: false },
        request_id,
      },
      400,
    );
  }

  // NOTE: input.caller_type is intentionally NOT consulted for any auth or
  // visibility decision in L4b Gate A. content is never returned here.

  const supa = getServiceClient();
  const started = Date.now();

  const coachUrl = Deno.env.get("COACH_AI_API_URL");
  const coachToken = Deno.env.get("COACH_AI_API_TOKEN");
  const timeoutMs = Number(Deno.env.get("COACH_AI_TIMEOUT_MS") ?? "8000");
  // timeoutMs is read for future Gate B fetch; referenced to avoid lint noise.
  void timeoutMs;

  // Missing-config safe path. Detect BEFORE any fetch().
  // Generic message only — must NOT mention env names or secret names.
  if (!coachUrl || !coachToken) {
    await writeUpstreamLog(supa, {
      conversation_id: input.conversation_id,
      request_id,
      statusTag: "failed",
      httpStatus: 0,
      latency_ms: Date.now() - started,
      endpoint: "active-base-prompt",
      error_code: "COACH_CONFIG_MISSING",
      error_message_safe: safeError("COACH_CONFIG_MISSING"),
    });

    // Gate A: produce metadata-only fallback trace. Do NOT auto-send the
    // fallback prompt body to any customer. Actual generation deferred to L5.
    const fallback_hash = await sha256Hex(MINIMAL_SAFE_FALLBACK_PROMPT);
    await writeFinalPromptTrace(supa, {
      conversation_id: input.conversation_id,
      request_id,
      source: "minimal_fallback",
      trace: {
        version_id: MINIMAL_SAFE_FALLBACK_ID,
        version_label: MINIMAL_SAFE_FALLBACK_LABEL,
        prompt_hash: fallback_hash,
        // Label only — DO NOT include the full fallback prompt body.
        redacted_snapshot: MINIMAL_SAFE_FALLBACK_LABEL,
      },
      fallback_id: MINIMAL_SAFE_FALLBACK_ID,
      fallback_hash,
    });

    const out: CoachPromptAdapterOutput = {
      success: false,
      source: "minimal_fallback",
      handoff_required: true,
      use_fallback: true,
      content: null,
      trace_data: {
        version_id: MINIMAL_SAFE_FALLBACK_ID,
        version_label: MINIMAL_SAFE_FALLBACK_LABEL,
        prompt_hash: fallback_hash,
        redacted_snapshot: MINIMAL_SAFE_FALLBACK_LABEL,
      },
      error: {
        error_code: "COACH_CONFIG_MISSING",
        message_safe: safeError("COACH_CONFIG_MISSING"),
        retryable: false,
      },
      request_id,
    };
    return jsonNoCors(out, 200);
  }

  // Gate B (DEFERRED): real SU Coach AI fetch happens here once Director
  // confirms COACH_AI_API_URL / COACH_AI_API_TOKEN. Until then, treat as
  // unavailable and emit the same safe response.
  await writeUpstreamLog(supa, {
    conversation_id: input.conversation_id,
    request_id,
    statusTag: "failed",
    httpStatus: 0,
    latency_ms: Date.now() - started,
    endpoint: "active-base-prompt",
    error_code: "INTERNAL",
    error_message_safe: safeError("INTERNAL"),
  });
  const out: CoachPromptAdapterOutput = {
    success: false,
    source: "upstream",
    handoff_required: true,
    use_fallback: false,
    content: null,
    trace_data: null,
    error: { error_code: "INTERNAL", message_safe: safeError("INTERNAL"), retryable: false },
    request_id,
  };
  return jsonNoCors(out, 200);
});
