// kb_adapter — NexusAI Phase 2 L4a
// Internal-only adapter. Callable ONLY by generate-reply server-side
// with header X-Internal-Service-Token === KB_INTERNAL_SERVICE_TOKEN.
// Fail-closed: any other caller -> 401, no business logic, no DB writes.
//
// Contract refs: 03 §4.3 (C-class adapter), 04 v1.1 (kbRagSearch),
//                08 F-02/F-03 (failure handling).
//
// Hard rules:
// - No CORS for browsers (no Access-Control-Allow-Origin: *).
// - Do NOT persist full KB chunk content anywhere.
// - Do NOT create new tables / columns. Use existing rag_trace + upstream_call_log.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// -- types --------------------------------------------------------------

interface KBAdapterInput {
  conversation_id: string;
  message_id?: string;
  workspace_id: string;
  tenant_id: string;
  query: string;
  language?: string;
  industry?: string;
  sub_industry?: string;
  market_region?: string;
  customer_tier?: string;
  intent?: string;
  risk_level?: "low" | "medium" | "high";
  top_k?: number;
  source_priority?: string[];
}

interface ChunkForLLM {
  content: string;
  citation_label: string;
  source_type: string;
  source_scope: string;
  score: number;
}

interface TraceChunk {
  chunk_id: string;
  document_id: string;
  document_title: string;
  score: number;
  citation_label: string;
  source_type: string;
  source_scope: string;
  industry?: string;
  language: string;
  version?: string;
  last_updated_at?: string;
  freshness_status: "fresh" | "stale" | "expiring";
  short_snippet: string;
}

interface KBAdapterOutput {
  chunks_for_llm: ChunkForLLM[];
  retrieval_quality: "high" | "medium" | "low" | "failed";
  no_answer: boolean;
  handoff_required: boolean;
  kb_gap_detected: boolean;
  conflict_detected: boolean;
  policy_gap: boolean;
  citation_required: boolean;
  trace_chunks: TraceChunk[];
  error?: { error_code: string; message_safe: string; retryable: boolean };
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

const PII_PATTERNS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[REDACTED]"],            // email
  [/\+?\d[\d\s\-()]{6,}\d/g, "[REDACTED]"],                // phone-ish
  [/\b\d{6,}\b/g, "[REDACTED]"],                           // long digit runs (order/id)
];

function sanitizeQuery(raw: string): { text: string; redacted: string; injection: boolean } {
  let text = (raw ?? "").toString();
  if (text.length > 2000) text = text.slice(0, 2000);
  text = text.replace(/<[^>]+>/g, ""); // strip HTML tags

  // very lightweight prompt-injection markers
  const injectionRe =
    /(ignore (all|previous|above) (instructions|prompts)|system prompt|developer prompt|you are now|jailbreak)/i;
  const injection = injectionRe.test(text);

  let redacted = text;
  for (const [re, repl] of PII_PATTERNS) redacted = redacted.replace(re, repl);

  return { text, redacted, injection };
}

function safeError(code: string): string {
  // never leak KB internals, tokens, stack traces, full content
  const map: Record<string, string> = {
    KB_TIMEOUT: "Upstream KB timed out.",
    KB_NETWORK: "Upstream KB unreachable.",
    KB_AUTH: "Upstream KB authorization failed.",
    KB_4XX: "Upstream KB rejected the request.",
    KB_5XX: "Upstream KB internal error.",
    KB_BAD_RESPONSE: "Upstream KB returned an unexpected response.",
    PROMPT_INJECTION_BLOCKED: "Query blocked by safety filter.",
    UNAUTHORIZED: "Unauthorized.",
    INVALID_INPUT: "Invalid input.",
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

async function writeRagTrace(
  supa: SupabaseClient,
  args: {
    conversation_id: string;
    message_id?: string;
    redactedQuery: string;
    output: KBAdapterOutput;
  },
) {
  try {
    const flags = {
      retrieval_quality: args.output.retrieval_quality,
      no_answer: args.output.no_answer,
      handoff_required: args.output.handoff_required,
      kb_gap_detected: args.output.kb_gap_detected,
      conflict_detected: args.output.conflict_detected,
      policy_gap: args.output.policy_gap,
      citation_required: args.output.citation_required,
    };
    const topScore = args.output.trace_chunks.reduce(
      (m, c) => (c.score > m ? c.score : m),
      0,
    );
    await supa.from("rag_trace").insert({
      conversation_id: args.conversation_id,
      message_id: args.message_id ?? null,
      query_sent: args.redactedQuery, // PII-redacted only
      retrieved_chunks: { chunks: args.output.trace_chunks, flags },
      top_score: topScore,
      kb_source: "nexus_kb",
    });
  } catch (e) {
    console.error("[kb_adapter] rag_trace insert failed:", (e as Error).message);
  }
}

async function writeUpstreamLog(
  supa: SupabaseClient,
  args: {
    conversation_id: string;
    request_id: string;
    status: "success" | "failed" | "timeout" | "blocked";
    httpStatus: number;
    latency_ms: number;
    error_code?: string;
    error_message_safe?: string;
    retrieval_quality?: KBAdapterOutput["retrieval_quality"];
    no_answer?: boolean;
  },
) {
  try {
    await supa.from("upstream_call_log").insert({
      conversation_id: args.conversation_id,
      upstream_service: "kb",
      // request_payload reused as a metadata sink — no raw token, no PII, no full content
      request_payload: {
        request_id: args.request_id,
        status: args.status,
        error_code: args.error_code,
        retrieval_quality: args.retrieval_quality,
        no_answer: args.no_answer,
      },
      response_status: args.httpStatus,
      response_latency_ms: args.latency_ms,
      error_message: args.error_message_safe ?? null,
    });
  } catch (e) {
    console.error("[kb_adapter] upstream_call_log insert failed:", (e as Error).message);
  }
}

// -- KB call ------------------------------------------------------------

async function callKB(
  url: string,
  token: string,
  timeoutMs: number,
  payload: Record<string, unknown>,
): Promise<{ ok: true; data: any; httpStatus: number } | { ok: false; code: string; httpStatus: number; retryable: boolean }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, code: "KB_AUTH", httpStatus: resp.status, retryable: false };
    }
    if (resp.status >= 400 && resp.status < 500) {
      return { ok: false, code: "KB_4XX", httpStatus: resp.status, retryable: false };
    }
    if (resp.status >= 500) {
      return { ok: false, code: "KB_5XX", httpStatus: resp.status, retryable: true };
    }
    const data = await resp.json().catch(() => null);
    if (!data) return { ok: false, code: "KB_BAD_RESPONSE", httpStatus: resp.status, retryable: false };
    return { ok: true, data, httpStatus: resp.status };
  } catch (e) {
    const isAbort = (e as Error).name === "AbortError";
    return {
      ok: false,
      code: isAbort ? "KB_TIMEOUT" : "KB_NETWORK",
      httpStatus: isAbort ? 408 : 0,
      retryable: true,
    };
  } finally {
    clearTimeout(t);
  }
}

async function callKBWithRetry(
  url: string,
  token: string,
  timeoutMs: number,
  payload: Record<string, unknown>,
) {
  const first = await callKB(url, token, timeoutMs, payload);
  if (first.ok || !first.retryable) return first;
  return await callKB(url, token, timeoutMs, payload);
}

// -- response shaping ---------------------------------------------------

function shapeOutput(kbData: any, opts: { intent?: string; risk_level?: string }): KBAdapterOutput {
  const rawChunks: any[] = Array.isArray(kbData?.chunks) ? kbData.chunks : [];

  const chunks_for_llm: ChunkForLLM[] = rawChunks.map((c) => ({
    content: String(c.content ?? "").slice(0, 3000),
    citation_label: String(c.citation_label ?? c.document_title ?? ""),
    source_type: String(c.source_type ?? "unknown"),
    source_scope: String(c.source_scope ?? "customer_answer"),
    score: Number(c.score ?? 0),
  }));

  const trace_chunks: TraceChunk[] = rawChunks.map((c) => ({
    chunk_id: String(c.chunk_id ?? c.id ?? ""),
    document_id: String(c.document_id ?? ""),
    document_title: String(c.document_title ?? ""),
    score: Number(c.score ?? 0),
    citation_label: String(c.citation_label ?? c.document_title ?? ""),
    source_type: String(c.source_type ?? "unknown"),
    source_scope: String(c.source_scope ?? "customer_answer"),
    industry: c.industry,
    language: String(c.language ?? "auto"),
    version: c.version,
    last_updated_at: c.last_updated_at,
    freshness_status: (c.freshness_status ?? "fresh") as TraceChunk["freshness_status"],
    short_snippet: String(c.short_snippet ?? "").slice(0, 300),
  }));

  const topScore = chunks_for_llm.reduce((m, c) => (c.score > m ? c.score : m), 0);
  const no_answer = Boolean(kbData?.no_answer) || chunks_for_llm.length === 0;
  const conflict_detected = Boolean(kbData?.conflict_detected);
  const kb_gap_detected = Boolean(kbData?.kb_gap_detected) || no_answer;

  const HIGH_RISK_INTENTS = new Set(["refund_exchange", "warranty", "complaint", "legal"]);
  const isHighRisk = opts.risk_level === "high" || (opts.intent && HIGH_RISK_INTENTS.has(opts.intent));
  const hasPolicy = chunks_for_llm.some((c) => c.source_type === "policy");
  const policy_gap = !no_answer && Boolean(isHighRisk) && !hasPolicy;

  let retrieval_quality: KBAdapterOutput["retrieval_quality"];
  if (no_answer) retrieval_quality = "failed";
  else if (topScore >= 0.85) retrieval_quality = "high";
  else if (topScore >= 0.75) retrieval_quality = "medium";
  else retrieval_quality = "low";

  const handoff_required = no_answer || policy_gap || conflict_detected;
  const citation_required = !no_answer;

  return {
    chunks_for_llm: no_answer ? [] : chunks_for_llm,
    retrieval_quality,
    no_answer,
    handoff_required,
    kb_gap_detected,
    conflict_detected,
    policy_gap,
    citation_required,
    trace_chunks,
  };
}

// -- handler ------------------------------------------------------------

Deno.serve(async (req) => {
  // No CORS preflight allowed for browsers; only POST from server.
  if (req.method !== "POST") {
    return jsonNoCors({ error: { error_code: "INVALID_INPUT", message_safe: "Method not allowed", retryable: false } }, 405);
  }

  const request_id = newRequestId();
  const internalToken = Deno.env.get("KB_INTERNAL_SERVICE_TOKEN");
  const presented = req.headers.get("X-Internal-Service-Token") ?? req.headers.get("x-internal-service-token");

  // Fail-closed auth. No business logic, no business-table writes.
  if (!internalToken || !presented || presented !== internalToken) {
    console.warn(JSON.stringify({
      request_id,
      ts: new Date().toISOString(),
      reason: "unauthorized_internal_adapter_call",
    }));
    return jsonNoCors(
      { error: { error_code: "UNAUTHORIZED", message_safe: safeError("UNAUTHORIZED"), retryable: false }, request_id },
      401,
    );
  }

  let input: KBAdapterInput;
  try {
    input = await req.json();
  } catch {
    return jsonNoCors(
      { error: { error_code: "INVALID_INPUT", message_safe: safeError("INVALID_INPUT"), retryable: false }, request_id },
      400,
    );
  }

  if (!input?.conversation_id || !input?.workspace_id || !input?.tenant_id || !input?.query) {
    return jsonNoCors(
      { error: { error_code: "INVALID_INPUT", message_safe: safeError("INVALID_INPUT"), retryable: false }, request_id },
      400,
    );
  }

  const supa = getServiceClient();
  const started = Date.now();

  const { redacted, injection } = sanitizeQuery(input.query);

  // Prompt injection: short-circuit, write upstream_call_log as blocked, no KB call.
  if (injection) {
    const output: KBAdapterOutput = {
      chunks_for_llm: [],
      retrieval_quality: "failed",
      no_answer: true,
      handoff_required: true,
      kb_gap_detected: true,
      conflict_detected: false,
      policy_gap: false,
      citation_required: false,
      trace_chunks: [],
      error: {
        error_code: "PROMPT_INJECTION_BLOCKED",
        message_safe: safeError("PROMPT_INJECTION_BLOCKED"),
        retryable: false,
      },
    };
    await writeUpstreamLog(supa, {
      conversation_id: input.conversation_id,
      request_id,
      status: "blocked",
      httpStatus: 0,
      latency_ms: Date.now() - started,
      error_code: "PROMPT_INJECTION_BLOCKED",
      error_message_safe: safeError("PROMPT_INJECTION_BLOCKED"),
    });
    await writeRagTrace(supa, {
      conversation_id: input.conversation_id,
      message_id: input.message_id,
      redactedQuery: redacted,
      output,
    });
    return jsonNoCors({ ...output, request_id }, 200);
  }

  const kbUrl = Deno.env.get("KB_RAG_API_URL");
  const kbToken = Deno.env.get("KB_RAG_API_TOKEN");
  const timeoutMs = Number(Deno.env.get("KB_RAG_TIMEOUT_MS") ?? "8000");

  if (!kbUrl || !kbToken) {
    const errOut: KBAdapterOutput = {
      chunks_for_llm: [],
      retrieval_quality: "failed",
      no_answer: true,
      handoff_required: true,
      kb_gap_detected: true,
      conflict_detected: false,
      policy_gap: false,
      citation_required: false,
      trace_chunks: [],
      error: { error_code: "INTERNAL", message_safe: safeError("INTERNAL"), retryable: false },
    };
    await writeUpstreamLog(supa, {
      conversation_id: input.conversation_id,
      request_id,
      status: "failed",
      httpStatus: 0,
      latency_ms: Date.now() - started,
      error_code: "INTERNAL",
      error_message_safe: "KB env not configured",
    });
    return jsonNoCors({ ...errOut, request_id }, 200);
  }

  const risk_level = input.risk_level ?? "medium";
  const top_k = Math.min(input.top_k ?? 5, 10);

  const kbPayload = {
    query: redacted,
    workspace_id: input.workspace_id,
    tenant_id: input.tenant_id,
    industry: input.industry,
    sub_industry: input.sub_industry,
    market_region: input.market_region,
    language: input.language ?? "auto",
    customer_tier: input.customer_tier,
    intent: input.intent,
    risk_level,
    top_k,
    min_score_threshold: risk_level === "high" ? 0.85 : 0.75,
    max_content_chars_per_chunk: 3000,
    max_total_context_chars: 12000,
    max_source_age_days: 180,
    source_priority: input.source_priority,
    filters: {
      status: "published",
      vector_status: "indexed",
      available_to_ai_chatbot: true,
      is_outdated: false,
    },
  };

  const result = await callKBWithRetry(kbUrl, kbToken, timeoutMs, kbPayload);
  const latency = Date.now() - started;

  if (!result.ok) {
    const status = result.code === "KB_TIMEOUT" ? "timeout" : "failed";
    const output: KBAdapterOutput = {
      chunks_for_llm: [],
      retrieval_quality: "failed",
      no_answer: true,
      handoff_required: true,
      kb_gap_detected: true,
      conflict_detected: false,
      policy_gap: false,
      citation_required: false,
      trace_chunks: [],
      error: { error_code: result.code, message_safe: safeError(result.code), retryable: result.retryable },
    };
    await writeUpstreamLog(supa, {
      conversation_id: input.conversation_id,
      request_id,
      status,
      httpStatus: result.httpStatus,
      latency_ms: latency,
      error_code: result.code,
      error_message_safe: safeError(result.code),
    });
    // Do not write rag_trace on hard KB failure (no retrieved chunks to log).
    return jsonNoCors({ ...output, request_id }, 200);
  }

  const output = shapeOutput(result.data, { intent: input.intent, risk_level });

  await writeUpstreamLog(supa, {
    conversation_id: input.conversation_id,
    request_id,
    status: "success",
    httpStatus: result.httpStatus,
    latency_ms: latency,
    retrieval_quality: output.retrieval_quality,
    no_answer: output.no_answer,
  });
  await writeRagTrace(supa, {
    conversation_id: input.conversation_id,
    message_id: input.message_id,
    redactedQuery: redacted,
    output,
  });

  return jsonNoCors({ ...output, request_id }, 200);
});
