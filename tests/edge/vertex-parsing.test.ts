/**
 * Deterministic contract tests for the Vertex response / evaluator parsing path.
 * Run with: deno test tests/edge/vertex-parsing.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractJsonObjectText,
  parseJsonObjectLoose,
  parseVertexResponse,
} from "../../supabase/functions/_shared/vertex-parse.ts";
import {
  describeEvaluatorRejection,
  validateEvaluatorOutput,
} from "../../supabase/functions/_shared/ce-contract.ts";

const payload = {
  score: 82.456,
  justification: "The reply matched the cited policy and stayed within scope for the customer request.",
  grounding_refs: ["chunk-1", "ghost-9"],
  evidence: ["we can refund within 14 days"],
  recommended_correction: "",
};

Deno.test("vertex: candidates/parts shape yields text and summed usage", () => {
  const parsed = parseVertexResponse({
    candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: '{"a":1}' }] },
    }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, thoughtsTokenCount: 200 },
  });
  assertEquals(parsed.text, '{"a":1}');
  assertEquals(parsed.input_tokens, 100);
  assertEquals(parsed.output_tokens, 240);
  assertEquals(parsed.finish_reason, "STOP");
});

Deno.test("vertex: thought parts are excluded from text", () => {
  const parsed = parseVertexResponse({
    candidates: [{
      content: {
        parts: [
          { text: "Let me weigh the evidence...", thought: true },
          { text: '{"score":50}' },
        ],
      },
    }],
  });
  assertEquals(parsed.text, '{"score":50}');
});

Deno.test("vertex: empty/blocked response has no text and reports reasons", () => {
  const blocked = parseVertexResponse({
    candidates: [{ finishReason: "SAFETY", content: { parts: [] } }],
    promptFeedback: { blockReason: "SAFETY" },
  });
  assertEquals(blocked.text, "");
  assertEquals(blocked.finish_reason, "SAFETY");
  assertEquals(blocked.block_reason, "SAFETY");

  const empty = parseVertexResponse({});
  assertEquals(empty.text, "");
  assertEquals(empty.output_tokens, 0);
  assertEquals(empty.finish_reason, null);
});

Deno.test("vertex: truncation is visible via finish reason", () => {
  const parsed = parseVertexResponse({
    candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: '{"score":5' }] } }],
  });
  assertEquals(parsed.finish_reason, "MAX_TOKENS");
});

Deno.test("json: fenced output parses", () => {
  assertEquals(parseJsonObjectLoose('```json\n{"score":10}\n```'), { score: 10 });
  assertEquals(parseJsonObjectLoose('```\n{"score":10}\n```'), { score: 10 });
});

Deno.test("json: extra prose around the object parses", () => {
  const raw = 'Sure! Here is my assessment:\n```json\n{"score":10,"note":"a } brace in a string"}\n```\nLet me know.';
  assertEquals(parseJsonObjectLoose(raw), { score: 10, note: "a } brace in a string" });
  assertEquals(
    extractJsonObjectText('noise {"a":{"b":1}} tail'),
    '{"a":{"b":1}}',
  );
});

Deno.test("json: malformed and truncated output fails closed", () => {
  assertEquals(parseJsonObjectLoose('{"score": 10'), null);
  assertEquals(parseJsonObjectLoose("not json at all"), null);
  assertEquals(parseJsonObjectLoose("[1,2,3]"), null);
  assertEquals(extractJsonObjectText('{"a":1'), null);
});

Deno.test("evaluator: numeric score normalizes to 2dp, unknown refs dropped", () => {
  const out = validateEvaluatorOutput(payload, new Set(["chunk-1"]));
  assertEquals(out?.score, 82.46);
  assertEquals(out?.grounding_refs, ["chunk-1"]);
});

Deno.test("evaluator: null recommended_correction is treated as empty", () => {
  const out = validateEvaluatorOutput(
    { ...payload, recommended_correction: null },
    new Set(["chunk-1"]),
  );
  assertEquals(out?.recommended_correction, "");
});

Deno.test("evaluator: string score fails closed with a shape reason", () => {
  const bad = { ...payload, score: "82" };
  assertEquals(validateEvaluatorOutput(bad, new Set(["chunk-1"])), null);
  assertEquals(describeEvaluatorRejection(bad), "score_not_number");
  assertEquals(describeEvaluatorRejection(null), "not_json_object");
  assertEquals(
    describeEvaluatorRejection({ ...payload, evidence: [] }),
    "evidence_count",
  );
});
