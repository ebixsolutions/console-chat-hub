/**
 * Dependency-free parsing helpers for Vertex AI generateContent responses and
 * for recovering a JSON object from model text.
 *
 * Kept separate from llm-router.ts so the parsing contract is deterministically
 * testable with `deno test` without pulling provider SDKs into the test graph.
 *
 * Root incompatibilities this module exists to absorb (Gemini vs. the previous
 * Anthropic-shaped parser):
 *   - candidates[0].content.parts may contain reasoning parts marked
 *     `thought: true`; concatenating them corrupts the JSON payload.
 *   - the JSON payload may arrive fenced (```json ... ```) or wrapped in prose.
 *   - usage lives in usageMetadata, and thinking tokens are reported separately
 *     in thoughtsTokenCount, so output tokens must sum both.
 *   - a response can be complete-but-empty (SAFETY / RECITATION / MAX_TOKENS or
 *     promptFeedback.blockReason) and must fail closed rather than parse.
 */

export interface VertexParsed {
  text: string;
  input_tokens: number;
  output_tokens: number;
  finish_reason: string | null;
  block_reason: string | null;
}

interface VertexBody {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Parse a Vertex `:generateContent` body into router-neutral fields. */
export function parseVertexResponse(body: unknown): VertexParsed {
  const obj = (body ?? {}) as VertexBody;
  const candidate = Array.isArray(obj.candidates) ? obj.candidates[0] : undefined;
  const parts = candidate?.content?.parts;
  const text = Array.isArray(parts)
    ? parts
      .filter((p) => p?.thought !== true && typeof p?.text === "string")
      .map((p) => p!.text as string)
      .join("")
      .trim()
    : "";
  const usage = obj.usageMetadata;
  return {
    text,
    input_tokens: num(usage?.promptTokenCount),
    output_tokens: num(usage?.candidatesTokenCount) + num(usage?.thoughtsTokenCount),
    finish_reason: typeof candidate?.finishReason === "string" ? candidate.finishReason : null,
    block_reason: typeof obj.promptFeedback?.blockReason === "string"
      ? obj.promptFeedback.blockReason
      : null,
  };
}

/**
 * Recover the first complete top-level JSON object from model text.
 * Handles code fences, leading/trailing prose and nested braces inside strings.
 * Returns null when no balanced object exists (truncated output fails closed).
 */
export function extractJsonObjectText(raw: string): string | null {
  if (typeof raw !== "string") return null;
  // Drop fences of any language tag without touching brace balance.
  const cleaned = raw.replace(/```[a-zA-Z0-9_-]*\s*/g, "").replace(/```/g, "");
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

/** Strict-shape JSON object parse with fence/prose tolerance. */
export function parseJsonObjectLoose(raw: string): Record<string, unknown> | null {
  const candidateTexts: string[] = [];
  if (typeof raw === "string") {
    const direct = raw.replace(/```[a-zA-Z0-9_-]*\s*/g, "").replace(/```/g, "").trim();
    if (direct) candidateTexts.push(direct);
    const extracted = extractJsonObjectText(raw);
    if (extracted && extracted !== direct) candidateTexts.push(extracted);
  }
  for (const text of candidateTexts) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}
