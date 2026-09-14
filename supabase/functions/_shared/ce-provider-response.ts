/**
 * Canonical CE provider-output boundary shared by manual and automatic paths.
 *
 * Gemini accounts reasoning tokens inside maxOutputTokens. CE evaluation is a
 * deterministic scoring task, so its canonical policy disables Gemini 2.5
 * Flash thinking and bounds every generated text field. Automatic and manual
 * callers consume the same policy object and strict validation remains
 * fail-closed.
 */
import {
  describeEvaluatorRejection,
  type EvaluatorOutput,
  validateEvaluatorOutput,
} from "./ce-contract.ts";
import { EVALUATOR_RESPONSE_SCHEMA } from "./ce-contract.ts";
import { parseJsonObjectLoose, parseVertexResponse } from "./vertex-parse.ts";

export const CE_EVALUATOR_MAX_TOKENS = 4096;
export const CE_EVALUATOR_THINKING_BUDGET = 0;
export const CE_JUSTIFICATION_MAX_CHARS = 800;
export const CE_EVIDENCE_MAX_CHARS = 500;
export const CE_CORRECTION_MAX_CHARS = 800;

const CE_PROVIDER_BASE_POLICY = Object.freeze({
  maxTokens: CE_EVALUATOR_MAX_TOKENS,
  thinkingBudget: CE_EVALUATOR_THINKING_BUDGET,
  responseFormat: "json" as const,
});

/** One canonical structured provider policy for automatic and manual CE. */
export function ceEvaluatorProviderPolicy() {
  return {
    ...CE_PROVIDER_BASE_POLICY,
    responseSchema: EVALUATOR_RESPONSE_SCHEMA,
  };
}

/** Signals use the same generation controls but have their own output shape. */
export function ceSignalsProviderPolicy() {
  return { ...CE_PROVIDER_BASE_POLICY };
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseText(value: unknown): JsonObject | null {
  return typeof value === "string" ? parseJsonObjectLoose(value) : null;
}

/**
 * Normalize only documented, lossless provider containers. This deliberately
 * does not repair incomplete JSON, synthesize fields, or reinterpret refusals.
 */
export function normalizeCeProviderResponse(raw: unknown): JsonObject | null {
  const directText = parseText(raw);
  if (directText) return directText;
  if (!isObject(raw)) return null;

  // The canonical object may carry harmless provider metadata alongside the
  // required CE fields; strict field validation remains downstream.
  if ("score" in raw || "justification" in raw || "evidence" in raw) return raw;

  for (const key of ["parsed", "output", "result", "response", "json"] as const) {
    const value = raw[key];
    if (isObject(value)) return value;
    const parsed = parseText(value);
    if (parsed) return parsed;
  }

  // OpenAI/Anthropic-style content blocks. Thought/reasoning blocks never enter
  // the candidate JSON text.
  if (Array.isArray(raw.content)) {
    const text = raw.content
      .filter((block) => isObject(block) && block.thought !== true && block.type !== "thinking")
      .map((block) => {
        if (!isObject(block)) return "";
        return typeof block.text === "string"
          ? block.text
          : isObject(block.text) && typeof block.text.value === "string"
            ? block.text.value
            : "";
      })
      .join("");
    const parsed = parseText(text);
    if (parsed) return parsed;
  }

  // Raw Vertex response, used by deterministic adapter tests and future router
  // integrations. MAX_TOKENS/SAFETY/empty responses remain invalid.
  if (Array.isArray(raw.candidates) || isObject(raw.promptFeedback)) {
    const vertex = parseVertexResponse(raw);
    if (vertex.block_reason || vertex.finish_reason === "MAX_TOKENS" || !vertex.text) return null;
    return parseText(vertex.text);
  }

  return null;
}

export type CeProviderValidation =
  { ok: true; value: EvaluatorOutput; raw: JsonObject } | { ok: false; reason: string };

export function validateCeProviderResponse(
  raw: unknown,
  knownChunkIds: ReadonlySet<string>,
): CeProviderValidation {
  const parsed = normalizeCeProviderResponse(raw);
  const value = validateEvaluatorOutput(parsed, knownChunkIds);
  return value
    ? { ok: true, value, raw: parsed! }
    : { ok: false, reason: describeEvaluatorRejection(parsed) };
}
