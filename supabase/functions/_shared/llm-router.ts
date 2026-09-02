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
 *   grounding gate     KB-grounded generation is verified before caller persistence
 */

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";
import { getSupabaseAdminKey } from "./supabase-admin-key.ts";
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
    getSupabaseAdminKey(),
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
    log(call.tag, { event: "usage_log_failed", detail: (e as Error).name });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  buildRequest: () => Promise<ProviderRequest>;
  parseResponse: (body: unknown) => ParsedProviderResponse;
}

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
    buildRequest: () => Promise.resolve({
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
            ...(jsonOutput ? { responseMimeType: "application/json" } : {}),
            ...(jsonOutput && responseSchema ? { responseSchema } : {}),
          },
        }),
      };
    },
    parseResponse: (body) => {
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

interface ParsedGroundingBlock {
  evidence_text: string;
  chunk_ids: string[];
}

interface GroundingVerifierDecision {
  grounded: boolean;
  unsupported_claims: string[];
  evidence_chunk_ids: string[];
}

const EXACT_FACT_TOKEN_RE = /(?:[$€£¥]|HKD|USD|EUR|GBP|JPY|TWD|NTD|RMB|CNY)?\s*\d+(?:[.,]\d+)?(?:\s*(?:%|percent|days?|hours?|minutes?|years?|months?|kg|g|lb|lbs|mm|cm|m|km|ml|l|公升|毫升|公斤|克|天|日|小時|小时|分鐘|分钟|年|月))?|\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*\d)[A-Z0-9-]{4,}\b/giu;

function canonicalExactToken(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s,]/g, "").trim();
}

export function extractGroundingBlock(system: string): ParsedGroundingBlock | null {
  if (!system.includes("Knowledge Base grounding rules:")) return null;
  const marker = "Full Content Evidence:\n";
  const markerIndex = system.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const raw = system.slice(markerIndex + marker.length).trim();
  if (!raw || /^none\b/i.test(raw)) return null;
  const ids = [...raw.matchAll(/\[chunk:([^\]\s]+)\]/g)]
    .map((match) => (match[1] ?? "").trim())
    .filter(Boolean);
  return {
    evidence_text: raw.slice(0, 6000),
    chunk_ids: [...new Set(ids)],
  };
}

export function buildVerifierEvidenceAliases(
  grounding: ParsedGroundingBlock,
): { evidence_text: string; allowed_ids: string[] } {
  let next = 0;
  const allowed: string[] = [];
  const aliased = grounding.evidence_text.replace(
    /\[chunk:([^\]\s]+)\]/g,
    () => {
      next += 1;
      const alias = `E${next}`;
      allowed.push(alias);
      return `[chunk:${alias}]`;
    },
  );
  return { evidence_text: aliased, allowed_ids: allowed };
}

export function validateExactFactGrounding(
  answer: string,
  evidenceText: string,
  protectedChunkIds: string[] = [],
): { ok: true } | { ok: false; reason: string; unsupported_tokens: string[] } {
  const answerNorm = answer.normalize("NFKC");
  for (const id of protectedChunkIds) {
    if (id && answerNorm.includes(id)) {
      return { ok: false, reason: "internal_chunk_id_leak", unsupported_tokens: [id] };
    }
  }
  const evidenceNorm = canonicalExactToken(evidenceText);
  const unsupported = new Set<string>();
  for (const match of answer.matchAll(EXACT_FACT_TOKEN_RE)) {
    const token = canonicalExactToken(match[0] ?? "");
    if (!token || /^\d$/.test(token)) continue;
    if (!evidenceNorm.includes(token)) unsupported.add(token);
  }
  return unsupported.size === 0
    ? { ok: true }
    : {
        ok: false,
        reason: "unsupported_exact_fact",
        unsupported_tokens: [...unsupported],
      };
}

export function parseGroundingVerifierDecision(
  raw: string,
  allowedChunkIds: string[],
): GroundingVerifierDecision | null {
  const parsed = parseJsonObjectLoose(raw);
  if (!parsed || typeof parsed.grounded !== "boolean") return null;
  if (!Array.isArray(parsed.unsupported_claims) || !Array.isArray(parsed.evidence_chunk_ids)) return null;
  const unsupported = parsed.unsupported_claims
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  if (unsupported.length !== parsed.unsupported_claims.length) return null;
  const ids = parsed.evidence_chunk_ids
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  if (ids.length !== parsed.evidence_chunk_ids.length) return null;
  const allowed = new Set(allowedChunkIds.filter(Boolean));
  if (ids.some((id) => !allowed.has(id))) return null;
  if (parsed.grounded && unsupported.length > 0) return null;
  if (!parsed.grounded && unsupported.length === 0) return null;
  if (parsed.grounded && allowed.size > 0 && ids.length === 0) return null;
  return {
    grounded: parsed.grounded,
    unsupported_claims: unsupported,
    evidence_chunk_ids: [...new Set(ids)],
  };
}

async function verifyGroundedGeneration(
  call: LlmCall,
  provider: ProviderId,
  answer: string,
  grounding: ParsedGroundingBlock,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const exact = validateExactFactGrounding(answer, grounding.evidence_text, grounding.chunk_ids);
  if (!exact.ok) {
    log(call.tag, {
      event: "grounding_exact_fact_rejected",
      request_id: call.operationId,
      reason: exact.reason,
      unsupported_token_count: exact.unsupported_tokens.length,
    });
    return { ok: false, reason: exact.reason };
  }

  const verifierEvidence = buildVerifierEvidenceAliases(grounding);
  const evaluationModel = (Deno.env.get(MODEL_ENV.evaluation) ?? "").trim();
  if (!evaluationModel) {
    log(call.tag, {
      event: "grounding_verifier_config_missing",
      request_id: call.operationId,
    });
    return { ok: false, reason: "verifier_model_missing" };
  }

  const verifierSystem = [
    "You are a strict factual-grounding verifier.",
    "Judge ONLY whether every factual claim in the proposed answer is entailed by the supplied evidence.",
    "Do not use outside knowledge, assumptions, the customer request, or prior conversation as factual evidence.",
    "Politeness, conversational transitions, and non-factual wording do not need evidence.",
    "Any unsupported product fact, policy fact, price, date, duration, dimension, eligibility condition, jurisdiction claim, procedure, limit, availability statement, or categorical factual statement makes grounded=false.",
    "evidence_chunk_ids may contain only supplied E1/E2/E3 aliases that materially support the answer.",
    "Return JSON only with grounded, unsupported_claims, evidence_chunk_ids.",
  ].join("\n");
  const verifierUser = [
    "Evidence:",
    verifierEvidence.evidence_text,
    "",
    "Proposed answer:",
    answer.slice(0, 3000),
  ].join("\n");

  let verifierAdapter: ProviderAdapter;
  if (provider === "vertex") {
    const sa = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
    const projectId = Deno.env.get("GOOGLE_PROJECT_ID");
    const region = Deno.env.get("GOOGLE_REGION");
    if (!sa?.trim() || !projectId?.trim() || !region?.trim()) {
      return { ok: false, reason: "verifier_provider_config_missing" };
    }
    verifierAdapter = vertexAdapter(
      sa,
      projectId.trim(),
      region.trim(),
      evaluationModel,
      redact(verifierSystem),
      redact(verifierUser),
      512,
      true,
      {
        type: "OBJECT",
        properties: {
          grounded: { type: "BOOLEAN" },
          unsupported_claims: { type: "ARRAY", items: { type: "STRING" } },
          evidence_chunk_ids: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["grounded", "unsupported_claims", "evidence_chunk_ids"],
      },
    );
  } else {
    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key?.trim()) return { ok: false, reason: "verifier_provider_config_missing" };
    verifierAdapter = anthropicAdapter(
      key,
      evaluationModel,
      redact(verifierSystem),
      redact(verifierUser),
      512,
    );
  }

  const verifierCall: LlmCall = {
    purpose: "evaluation",
    system: verifierSystem,
    user: verifierUser,
    maxTokens: 512,
    operationId: `${call.operationId}:grounding-verifier`,
    companyId: call.companyId,
    conversationId: call.conversationId,
    tag: `${call.tag}-grounding-verifier`,
    responseFormat: "json",
  };
  const verifierUsage: LlmUsage = {
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
    attempts: 0,
  };
  const verifierStarted = Date.now();
  let lastStatus = 0;

  for (let attempt = 1; attempt <= 2; attempt++) {
    verifierUsage.attempts = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const req = await verifierAdapter.buildRequest();
      const res = await fetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
        signal: controller.signal,
      });
      lastStatus = res.status;
      if (res.status === 429 || res.status >= 500) {
        if (attempt < 2) {
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        break;
      }
      if (!res.ok) break;

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        break;
      }
      const parsed = verifierAdapter.parseResponse(body);
      verifierUsage.input_tokens = parsed.input_tokens;
      verifierUsage.output_tokens = parsed.output_tokens;
      verifierUsage.latency_ms = Date.now() - verifierStarted;
      if (!parsed.text || parsed.finish_reason === "MAX_TOKENS") break;

      const decision = parseGroundingVerifierDecision(parsed.text, verifierEvidence.allowed_ids);
      if (!decision) {
        await recordUsage(
          verifierCall,
          verifierAdapter.id,
          verifierAdapter.model,
          "failed",
          res.status,
          verifierUsage,
          "GROUNDING_VERIFIER_INVALID_OUTPUT",
        );
        return { ok: false, reason: "verifier_invalid_output" };
      }

      await recordUsage(
        verifierCall,
        verifierAdapter.id,
        verifierAdapter.model,
        decision.grounded ? "success" : "failed",
        res.status,
        verifierUsage,
        decision.grounded ? undefined : "GROUNDING_UNSUPPORTED_CLAIMS",
      );
      if (!decision.grounded) {
        log(call.tag, {
          event: "grounding_semantic_rejected",
          request_id: call.operationId,
          unsupported_claim_count: decision.unsupported_claims.length,
        });
        return { ok: false, reason: "unsupported_semantic_claim" };
      }
      return { ok: true };
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      if (!aborted && attempt < 2) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  verifierUsage.latency_ms = Date.now() - verifierStarted;
  await recordUsage(
    verifierCall,
    verifierAdapter.id,
    verifierAdapter.model,
    "failed",
    lastStatus,
    verifierUsage,
    "GROUNDING_VERIFIER_UNAVAILABLE",
  );
  return { ok: false, reason: "verifier_unavailable" };
}

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

      const grounding =
        call.purpose === "generation" && call.responseFormat !== "json"
          ? extractGroundingBlock(call.system)
          : null;
      if (grounding) {
        const groundingDecision = await verifyGroundedGeneration(
          call,
          provider,
          parsed.text,
          grounding,
          timeoutMs,
        );
        if (!groundingDecision.ok) {
          lastCode = "LLM_INVALID_OUTPUT";
          usage.latency_ms = Date.now() - started;
          log(call.tag, {
            event: "grounding_rejected",
            request_id: requestId,
            provider: adapter.id,
            attempt,
            reason: groundingDecision.reason,
          });
          await recordUsage(
            call,
            adapter.id,
            adapter.model,
            "failed",
            res.status,
            usage,
            "LLM_OUTPUT_UNGROUNDED",
          );
          return {
            ok: false,
            code: "LLM_INVALID_OUTPUT",
            status: res.status,
            request_id: requestId,
            usage,
          };
        }
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
        grounding_verified: grounding !== null,
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

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  return parseJsonObjectLoose(raw);
}

export function toCeErrorCode(code: LlmFailureCode): string {
  switch (code) {
    case "LLM_TIMEOUT": return "CE_PROVIDER_TIMEOUT";
    case "LLM_NETWORK": return "CE_PROVIDER_NETWORK_ERROR";
    case "LLM_NON_2XX": return "CE_PROVIDER_NON_2XX";
    case "LLM_INVALID_OUTPUT": return "CE_PROVIDER_INVALID_OUTPUT";
    case "LLM_INPUT_BLOCKED": return "CE_PROVIDER_INVALID_OUTPUT";
    case "LLM_CONFIG_MISSING": return "CE_PROVIDER_CONFIG_ERROR";
  }
}
