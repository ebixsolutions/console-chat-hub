/**
 * Governed model router — the single provider call site for Edge Functions.
 *
 * No Edge Function may build its own provider request. Everything a governed
 * call must do happens here and cannot be skipped by a caller:
 *
 *   provider registry  LLM_PROVIDER selects vertex (default target) or anthropic (rollback)
 *   model registry     model ids come from platform configuration, never literals
 *   redaction          outbound text is PII-redacted before it leaves the process
 *   injection guard    known override markers are refused, not forwarded
 *   timeout            per-attempt abort
 *   retry              bounded exponential backoff on retryable classes only
 *   usage logging      tokens and latency written to upstream_call_log
 *   observability      one structured line per attempt, correlated by request_id
 *   safe errors        stable codes out, provider text never surfaced to callers
 */

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";
import { GoogleAuth } from "npm:google-auth-library@9.15.0";
import { parseJsonObjectLoose, parseVertexResponse } from "./vertex-parse.ts";

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
  /**
   * When "json" the provider is asked for a bare JSON object. Vertex enforces
   * this with responseMimeType; Anthropic keeps its prompt-driven behaviour so
   * rollback semantics are unchanged.
   */
  responseFormat?: "json" | "text";
  /**
   * Optional Vertex response schema (OpenAPI subset). Ignored by providers that
   * do not support constrained decoding, so rollback stays behaviour-preserving.
   */
  responseSchema?: Record<string, unknown>;
}

type ProviderId = "vertex" | "anthropic";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;
const DEFAULT_TIMEOUT_MS = 30000;
const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

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

function resolveProvider(): ProviderId {
  const raw = (Deno.env.get("LLM_PROVIDER") ?? "").trim().toLowerCase();
  // Only these two are supported; anything else is a configuration error and is
  // reported as such rather than silently falling back to another provider.
  return raw === "anthropic" ? "anthropic" : raw === "vertex" ? "vertex" : ("" as ProviderId);
}

async function recordUsage(
  call: LlmCall,
  provider: string,
  model: string,
  outcome: "success" | "failed" | "timeout" | "blocked",
  httpStatus: number,
  usage: LlmUsage,
  code?: string,
): Promise<void> {
  try {
    // Nothing here carries prompt text, system text, credentials or provider
    // output. Only identifiers, counts and timings are persisted, so the log can
    // never become a second copy of customer data.
    await serviceClient().from("upstream_call_log").insert({
      conversation_id: call.conversationId,
      company_id: call.companyId,
      upstream_service: "llm",
      request_payload: {
        request_id: call.operationId,
        purpose: call.purpose,
        provider,
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

/* --------------------- shared generation output budget --------------------- */

/**
 * Single bounded, configurable output-token budget for every
 * `purpose: "generation"` caller (widget/AI reply orchestration, legacy reply
 * path, escalation policy assessment).
 *
 * Rationale: the structured/orchestrated generation output routinely exceeds
 * 500 output tokens, and a provider MAX_TOKENS finish is intentionally treated
 * as LLM_INVALID_OUTPUT (fail-closed) — so an undersized budget turns healthy
 * KB-grounded answers into unnecessary human handoffs. The budget therefore
 * defaults high enough for the current structured contract, stays operator
 * configurable, and is clamped to a sane min/max so a bad configuration value
 * can never restore the truncation failure or request an unbounded budget.
 */
export const GENERATION_MAX_TOKENS_DEFAULT = 2048;
export const GENERATION_MAX_TOKENS_MIN = 768;
export const GENERATION_MAX_TOKENS_MAX = 8192;

export function resolveGenerationMaxTokens(): number {
  const raw = (Deno.env.get("LLM_MAX_OUTPUT_TOKENS_GENERATION") ?? "").trim();
  const parsed = Number.parseInt(raw, 10);
  const candidate = Number.isFinite(parsed) && parsed > 0
    ? parsed
    : GENERATION_MAX_TOKENS_DEFAULT;
  return Math.max(
    GENERATION_MAX_TOKENS_MIN,
    Math.min(GENERATION_MAX_TOKENS_MAX, candidate),
  );
}


interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface ParsedProviderResponse {
  text: string;
  input_tokens: number;
  output_tokens: number;
  finish_reason?: string | null;
  block_reason?: string | null;
}

interface ProviderAdapter {
  id: ProviderId;
  model: string;
  /** Built per attempt so short-lived credentials can be refreshed. */
  buildRequest: () => Promise<ProviderRequest>;
  parseResponse: (body: unknown) => ParsedProviderResponse;
}

/* -------------------------------- anthropic ------------------------------- */

function anthropicAdapter(
  apiKey: string,
  model: string,
  safeSystem: string,
  safeUser: string,
  maxTokens: number,
): ProviderAdapter {
  return {
    id: "anthropic",
    model,
    buildRequest: () =>
      Promise.resolve({
        url: ANTHROPIC_ENDPOINT,
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system: safeSystem,
          messages: [{ role: "user", content: safeUser }],
        }),
      }),
    parseResponse: (body) => {
      const obj = body as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = Array.isArray(obj.content)
        ? obj.content
          .filter((b) => b?.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string).join("").trim()
        : "";
      return {
        text,
        input_tokens: Number(obj.usage?.input_tokens ?? 0),
        output_tokens: Number(obj.usage?.output_tokens ?? 0),
        finish_reason: null,
        block_reason: null,
      };
    },
  };
}

/* --------------------------------- vertex --------------------------------- */

/**
 * Service-account OAuth token for Vertex AI. The credential JSON is parsed in
 * process only and never logged, returned or persisted.
 */
async function vertexAccessToken(serviceAccountJson: string): Promise<string> {
  const credentials = JSON.parse(serviceAccountJson) as Record<string, unknown>;
  const auth = new GoogleAuth({ credentials, scopes: [VERTEX_SCOPE] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const value = typeof token === "string" ? token : token?.token;
  if (!value) throw new Error("vertex_token_unavailable");
  return value;
}

function vertexAdapter(
  serviceAccountJson: string,
  projectId: string,
  region: string,
  model: string,
  safeSystem: string,
  safeUser: string,
  maxTokens: number,
  jsonOutput: boolean,
  responseSchema: Record<string, unknown> | undefined,
): ProviderAdapter {
  const url =
    `https://${region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${region}/publishers/google/models/${model}:generateContent`;

  return {
    id: "vertex",
    model,
    buildRequest: async () => {
      const accessToken = await vertexAccessToken(serviceAccountJson);
      return {
        url,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: safeSystem }] },
          contents: [{ role: "user", parts: [{ text: safeUser }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature: 0,
            // Gemini honours a response mime type; callers that require a JSON
            // object get one without fences or prose. A response schema pins
            // field names and primitive types, which prompt text alone does
            // not (Gemini otherwise renames keys and stringifies numbers).
            ...(jsonOutput ? { responseMimeType: "application/json" } : {}),
            ...(jsonOutput && responseSchema ? { responseSchema } : {}),
          },
        }),
      };
    },
    parseResponse: (body) => {
      // Thought parts are dropped and thinking tokens are counted; see
      // _shared/vertex-parse.ts for the full incompatibility list.
      const parsed = parseVertexResponse(body);
      return {
        text: parsed.text,
        input_tokens: parsed.input_tokens,
        output_tokens: parsed.output_tokens,
        finish_reason: parsed.finish_reason,
        block_reason: parsed.block_reason,
      };
    },
  };
}


/* --------------------------------- router --------------------------------- */

export async function callModel(call: LlmCall): Promise<LlmResult> {
  const started = Date.now();
  const usage: LlmUsage = {
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
    attempts: 0,
  };
  const requestId = call.operationId;

  const provider = resolveProvider();
  const model = Deno.env.get(MODEL_ENV[call.purpose]);
  const timeoutMs = Number(
    Deno.env.get("LLM_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS,
  );

  const nonEmpty = (v: string | undefined) => !!v && v.trim().length > 0;

  const configMissing = async (providerLabel: string, modelLabel: string) => {
    usage.latency_ms = Date.now() - started;
    log(call.tag, {
      event: "config_missing",
      request_id: requestId,
      provider: providerLabel,
      purpose: call.purpose,
    });
    await recordUsage(
      call,
      providerLabel,
      modelLabel,
      "failed",
      0,
      usage,
      "LLM_CONFIG_MISSING",
    );
    return {
      ok: false as const,
      code: "LLM_CONFIG_MISSING" as const,
      request_id: requestId,
      usage,
    };
  };

  if (provider !== "vertex" && provider !== "anthropic") {
    return await configMissing("unset", model ?? "unset");
  }
  if (!nonEmpty(model)) {
    return await configMissing(provider, "unset");
  }

  let adapter: ProviderAdapter;
  if (provider === "vertex") {
    const sa = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
    const projectId = Deno.env.get("GOOGLE_PROJECT_ID");
    const region = Deno.env.get("GOOGLE_REGION");
    if (!nonEmpty(sa) || !nonEmpty(projectId) || !nonEmpty(region)) {
      return await configMissing(provider, model!);
    }
    if (looksLikeInjection(call.user)) {
      usage.latency_ms = Date.now() - started;
      log(call.tag, { event: "input_blocked", request_id: requestId });
      await recordUsage(
        call,
        provider,
        model!,
        "blocked",
        0,
        usage,
        "LLM_INPUT_BLOCKED",
      );
      return {
        ok: false,
        code: "LLM_INPUT_BLOCKED",
        request_id: requestId,
        usage,
      };
    }
    adapter = vertexAdapter(
      sa!,
      projectId!.trim(),
      region!.trim(),
      model!.trim(),
      redact(call.system),
      redact(call.user),
      call.maxTokens,
      call.responseFormat === "json",
      call.responseSchema,
    );
  } else {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!nonEmpty(key)) {
      return await configMissing(provider, model!);
    }
    if (looksLikeInjection(call.user)) {
      usage.latency_ms = Date.now() - started;
      log(call.tag, { event: "input_blocked", request_id: requestId });
      await recordUsage(
        call,
        provider,
        model!,
        "blocked",
        0,
        usage,
        "LLM_INPUT_BLOCKED",
      );
      return {
        ok: false,
        code: "LLM_INPUT_BLOCKED",
        request_id: requestId,
        usage,
      };
    }
    adapter = anthropicAdapter(
      key!,
      model!.trim(),
      redact(call.system),
      redact(call.user),
      call.maxTokens,
    );
  }

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
        const req = await adapter.buildRequest();
        res = await fetch(req.url, {
          method: "POST",
          headers: req.headers,
          body: req.body,
          signal: controller.signal,
        });
      } catch (e) {
        const aborted = e instanceof Error && e.name === "AbortError";
        lastCode = aborted ? "LLM_TIMEOUT" : "LLM_NETWORK";
        log(call.tag, {
          event: "attempt_failed",
          request_id: requestId,
          provider: adapter.id,
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
          provider: adapter.id,
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
        // Covers 401/403/404 and every other fatal status. Provider body is
        // never read into logs or results.
        lastCode = "LLM_NON_2XX";
        lastStatus = res.status;
        log(call.tag, {
          event: "attempt_fatal",
          request_id: requestId,
          provider: adapter.id,
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
          provider: adapter.id,
          attempt,
        });
        break;
      }

      const parsed = adapter.parseResponse(body);
      usage.input_tokens = parsed.input_tokens;
      usage.output_tokens = parsed.output_tokens;

      if (!parsed.text) {
        // Complete-but-empty responses (safety block, recitation, truncation)
        // fail closed, with the provider's own reason recorded for diagnosis.
        lastCode = "LLM_INVALID_OUTPUT";
        log(call.tag, {
          event: "empty_output",
          request_id: requestId,
          provider: adapter.id,
          attempt,
          finish_reason: parsed.finish_reason ?? null,
          block_reason: parsed.block_reason ?? null,
        });
        break;
      }

      if (parsed.finish_reason === "MAX_TOKENS") {
        // Truncated output can never be a complete JSON object.
        lastCode = "LLM_INVALID_OUTPUT";
        log(call.tag, {
          event: "truncated_output",
          request_id: requestId,
          provider: adapter.id,
          attempt,
          output_tokens: parsed.output_tokens,
        });
        break;
      }

      usage.latency_ms = Date.now() - started;
      log(call.tag, {
        event: "success",
        request_id: requestId,
        provider: adapter.id,
        attempt,
        model: adapter.model,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ms: usage.latency_ms,
      });
      await recordUsage(
        call,
        adapter.id,
        adapter.model,
        "success",
        res.status,
        usage,
      );
      return {
        ok: true,
        text: parsed.text,
        model: adapter.model,
        usage,
        request_id: requestId,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  usage.latency_ms = Date.now() - started;
  log(call.tag, {
    event: "exhausted",
    request_id: requestId,
    provider: adapter.id,
    code: lastCode,
    attempts: usage.attempts,
  });
  await recordUsage(
    call,
    adapter.id,
    adapter.model,
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

/**
 * Strip fences/prose and parse a JSON object. Malformed or truncated output
 * returns null so callers fail closed.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  return parseJsonObjectLoose(raw);
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
