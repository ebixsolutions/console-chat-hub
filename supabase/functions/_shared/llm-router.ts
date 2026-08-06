/**
 * Governed model router — the single provider call site for Edge Functions.
 *
 * No Edge Function may build its own provider request. Everything a governed
 * call must do happens here and cannot be skipped by a caller:
 *
 *   model registry   model ids come from platform configuration, never literals
 *   redaction        outbound text is PII-redacted before it leaves the process
 *   injection guard  known override markers are refused, not forwarded
 *   timeout          per-attempt abort
 *   retry            bounded exponential backoff on retryable classes only
 *   usage logging    tokens and latency written to upstream_call_log
 *   observability    one structured line per attempt, correlated by request_id
 *   safe errors      stable codes out, provider text never surfaced to callers
 */

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";

export type LlmFailureCode =
  | "LLM_CONFIG_MISSING"
  | "LLM_INPUT_BLOCKED"
  | "LLM_TIMEOUT"
  | "LLM_NETWORK"
  | "LLM_NON_2XX"
  | "LLM_INVALID_OUTPUT";

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  attempts: number;
}

export type LlmResult =
  | {
    ok: true;
    text: string;
    model: string;
    usage: LlmUsage;
    request_id: string;
  }
  | {
    ok: false;
    code: LlmFailureCode;
    status?: number;
    request_id: string;
    usage: LlmUsage;
  };

export type ModelPurpose = "evaluation" | "assist" | "generation";

export interface LlmCall {
  purpose: ModelPurpose;
  system: string;
  user: string;
  maxTokens: number;
  /** Correlation id shared by every call in one logical operation. */
  operationId: string;
  /** Written to upstream_call_log so spend is attributable to a tenant. */
  companyId: string | null;
  conversationId: string | null;
  tag: string;
}

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;
const DEFAULT_TIMEOUT_MS = 30000;

/** Model ids are configuration, never literals in call sites. */
const MODEL_ENV: Record<ModelPurpose, string> = {
  evaluation: "LLM_MODEL_EVALUATION",
  assist: "LLM_MODEL_ASSIST",
  generation: "LLM_MODEL_GENERATION",
};

const REDACTIONS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[EMAIL]"],
  [/\+?\d[\d\s\-()]{6,}\d/g, "[PHONE]"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "[CARD]"],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "[UUID]",
  ],
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[SECRET]"],
  [/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, "[SECRET]"],
];

const INJECTION_RE =
  /(ignore\s+(all\s+|the\s+)?(previous|above)\s+(instructions|prompts)|system\s+prompt|developer\s+prompt|you\s+are\s+now|jailbreak)/i;

/** Redact outbound text. Exported so callers can redact what they persist too. */
export function redact(input: string): string {
  let out = input;
  for (const [re, repl] of REDACTIONS) out = out.replace(re, repl);
  return out;
}

export function looksLikeInjection(input: string): boolean {
  return INJECTION_RE.test(input);
}

function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function log(tag: string, fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      component: "llm-router",
      tag,
      ts: new Date().toISOString(),
      ...fields,
    }),
  );
}

async function recordUsage(
  call: LlmCall,
  model: string,
  outcome: "success" | "failed" | "timeout" | "blocked",
  httpStatus: number,
  usage: LlmUsage,
  code?: string,
): Promise<void> {
  try {
    // Nothing here carries prompt text, system text or provider output. Only
    // identifiers, counts and timings are persisted, so the log can never
    // become a second copy of customer data.
    await serviceClient().from("upstream_call_log").insert({
      conversation_id: call.conversationId,
      company_id: call.companyId,
      upstream_service: "llm",
      request_payload: {
        request_id: call.operationId,
        purpose: call.purpose,
        model,
        company_id: call.companyId,
        outcome,
        error_code: code ?? null,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        attempts: usage.attempts,
      },
      response_status: httpStatus,
      response_latency_ms: usage.latency_ms,
      error_message: code ?? null,
    });
  } catch (e) {
    // Logging must never fail the caller, and the failure itself must not leak
    // anything: only the error class name is emitted.
    log(call.tag, { event: "usage_log_failed", detail: (e as Error).name });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function callModel(call: LlmCall): Promise<LlmResult> {
  const started = Date.now();
  const usage: LlmUsage = {
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
    attempts: 0,
  };
  const requestId = call.operationId;

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  const model = Deno.env.get(MODEL_ENV[call.purpose]);
  const timeoutMs = Number(
    Deno.env.get("LLM_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
  );

  if (!key || key.trim().length === 0 || !model || model.trim().length === 0) {
    usage.latency_ms = Date.now() - started;
    log(call.tag, {
      event: "config_missing",
      request_id: requestId,
      purpose: call.purpose,
    });
    await recordUsage(
      call,
      model ?? "unset",
      "failed",
      0,
      usage,
      "LLM_CONFIG_MISSING",
    );
    return {
      ok: false,
      code: "LLM_CONFIG_MISSING",
      request_id: requestId,
      usage,
    };
  }

  if (looksLikeInjection(call.user)) {
    usage.latency_ms = Date.now() - started;
    log(call.tag, { event: "input_blocked", request_id: requestId });
    await recordUsage(call, model, "blocked", 0, usage, "LLM_INPUT_BLOCKED");
    return {
      ok: false,
      code: "LLM_INPUT_BLOCKED",
      request_id: requestId,
      usage,
    };
  }

  const safeUser = redact(call.user);
  const safeSystem = redact(call.system);

  let lastCode: LlmFailureCode = "LLM_NETWORK";
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    usage.attempts = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const attemptStart = Date.now();

    try {
      let res: Response;
      try {
        res = await fetch(ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": API_VERSION,
          },
          body: JSON.stringify({
            model,
            max_tokens: call.maxTokens,
            system: safeSystem,
            messages: [{ role: "user", content: safeUser }],
          }),
          signal: controller.signal,
        });
      } catch (e) {
        const aborted = e instanceof Error && e.name === "AbortError";
        lastCode = aborted ? "LLM_TIMEOUT" : "LLM_NETWORK";
        log(call.tag, {
          event: "attempt_failed",
          request_id: requestId,
          attempt,
          code: lastCode,
          ms: Date.now() - attemptStart,
        });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        break;
      }

      if (res.status === 429 || res.status >= 500) {
        lastCode = "LLM_NON_2XX";
        lastStatus = res.status;
        log(call.tag, {
          event: "attempt_retryable",
          request_id: requestId,
          attempt,
          status: res.status,
        });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        break;
      }
      if (!res.ok) {
        lastCode = "LLM_NON_2XX";
        lastStatus = res.status;
        log(call.tag, {
          event: "attempt_fatal",
          request_id: requestId,
          attempt,
          status: res.status,
        });
        break;
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        lastCode = "LLM_INVALID_OUTPUT";
        log(call.tag, {
          event: "parse_failed",
          request_id: requestId,
          attempt,
        });
        break;
      }

      const obj = body as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      usage.input_tokens = Number(obj.usage?.input_tokens ?? 0);
      usage.output_tokens = Number(obj.usage?.output_tokens ?? 0);

      const text = Array.isArray(obj.content)
        ? obj.content.filter((b) =>
          b?.type === "text" && typeof b.text === "string"
        )
          .map((b) => b.text as string).join("").trim()
        : "";

      if (!text) {
        lastCode = "LLM_INVALID_OUTPUT";
        log(call.tag, {
          event: "empty_output",
          request_id: requestId,
          attempt,
        });
        break;
      }

      usage.latency_ms = Date.now() - started;
      log(call.tag, {
        event: "success",
        request_id: requestId,
        attempt,
        model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ms: usage.latency_ms,
      });
      await recordUsage(call, model, "success", res.status, usage);
      return { ok: true, text, model, usage, request_id: requestId };
    } finally {
      clearTimeout(timer);
    }
  }

  usage.latency_ms = Date.now() - started;
  log(call.tag, {
    event: "exhausted",
    request_id: requestId,
    code: lastCode,
    attempts: usage.attempts,
  });
  await recordUsage(
    call,
    model,
    lastCode === "LLM_TIMEOUT" ? "timeout" : "failed",
    lastStatus ?? 0,
    usage,
    lastCode,
  );
  return {
    ok: false,
    code: lastCode,
    status: lastStatus,
    request_id: requestId,
    usage,
  };
}

/** Strip optional fences and parse a JSON object. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const cleaned = raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Map a router failure onto the CE attempt error vocabulary. */
export function toCeErrorCode(code: LlmFailureCode): string {
  switch (code) {
    case "LLM_TIMEOUT":
      return "CE_PROVIDER_TIMEOUT";
    case "LLM_NETWORK":
      return "CE_PROVIDER_NETWORK_ERROR";
    case "LLM_NON_2XX":
      return "CE_PROVIDER_NON_2XX";
    case "LLM_INVALID_OUTPUT":
      return "CE_PROVIDER_INVALID_OUTPUT";
    case "LLM_INPUT_BLOCKED":
      return "CE_PROVIDER_INVALID_OUTPUT";
    case "LLM_CONFIG_MISSING":
      return "CE_PROVIDER_CONFIG_ERROR";
  }
}
