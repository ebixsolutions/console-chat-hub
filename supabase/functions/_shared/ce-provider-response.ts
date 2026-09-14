/**
 * Canonical CE provider-output boundary shared by manual and automatic paths.
 *
 * Gemini accounts reasoning tokens inside maxOutputTokens. B3's larger
 * conversion-reality bundle caused otherwise valid constrained JSON to be
 * truncated at the former 2,600-token ceiling. Keep one governed budget for
 * both callers and fail closed unless a complete object satisfies the CE
 * contract.
 */
import {
  describeEvaluatorRejection,
  type EvaluatorOutput,
  validateEvaluatorOutput,
} from "./ce-contract.ts";
import { parseJsonObjectLoose, parseVertexResponse } from "./vertex-parse.ts";

export const CE_EVALUATOR_MAX_TOKENS = 4096;

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
