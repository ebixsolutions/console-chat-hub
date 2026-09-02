import {
  extractGroundingBlock,
  parseGroundingVerifierDecision,
  validateExactFactGrounding,
} from "../../supabase/functions/_shared/llm-router.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("extractGroundingBlock only activates for KB grounded prompt", () => {
  const none = extractGroundingBlock("ordinary system prompt");
  assert(none === null, "ordinary generation must not activate grounding gate");

  const grounded = extractGroundingBlock([
    "Knowledge Base grounding rules:",
    "- Answer ONLY from the evidence below.",
    "Full Content Evidence:",
    "[Full Content Evidence 1] [chunk:chunk-1]",
    "Returns are accepted within 7 days.",
  ].join("\n"));
  assert(grounded !== null, "KB prompt should activate grounding gate");
  assert(grounded.chunk_ids.length === 1 && grounded.chunk_ids[0] === "chunk-1", "chunk lineage must be preserved");
  assert(grounded.evidence_text.includes("7 days"), "evidence content missing");
});

Deno.test("supported exact facts pass", () => {
  const result = validateExactFactGrounding(
    "Returns are accepted within 7 days and the appliance limit is 500 L.",
    "Returns are accepted within 7 days. Maximum appliance volume is 500 L.",
  );
  assert(result.ok, "supported exact facts should pass");
});

Deno.test("unsupported numeric fact fails closed", () => {
  const result = validateExactFactGrounding(
    "Returns are accepted within 30 days.",
    "Returns are accepted within 7 days.",
  );
  assert(!result.ok, "unsupported duration must fail");
  assert(result.unsupported_tokens.includes("30days"), "unsupported duration must be identified");
});

Deno.test("unsupported model identifier fails closed", () => {
  const result = validateExactFactGrounding(
    "This policy applies to model ABC-1234.",
    "This policy applies to model XYZ-9000.",
  );
  assert(!result.ok, "invented model identifier must fail");
});

Deno.test("internal chunk id leakage fails closed", () => {
  const result = validateExactFactGrounding(
    "Source chunk is chunk-123.",
    "Authoritative customer-facing fact.",
    ["chunk-123"],
  );
  assert(!result.ok && result.reason === "internal_chunk_id_leak", "chunk ids must never leak to customer output");
});

Deno.test("verifier decision requires grounded shape and allowed chunk ids", () => {
  const accepted = parseGroundingVerifierDecision(
    JSON.stringify({ grounded: true, unsupported_claims: [], evidence_chunk_ids: ["chunk-1"] }),
    ["chunk-1"],
  );
  assert(accepted?.grounded === true, "valid verifier decision should pass");

  const fakeId = parseGroundingVerifierDecision(
    JSON.stringify({ grounded: true, unsupported_claims: [], evidence_chunk_ids: ["fake"] }),
    ["chunk-1"],
  );
  assert(fakeId === null, "unknown evidence id must fail closed");

  const contradictory = parseGroundingVerifierDecision(
    JSON.stringify({ grounded: true, unsupported_claims: ["unsupported"], evidence_chunk_ids: ["chunk-1"] }),
    ["chunk-1"],
  );
  assert(contradictory === null, "contradictory verifier output must fail closed");
});

Deno.test("negative verifier decision must name unsupported claim", () => {
  const malformed = parseGroundingVerifierDecision(
    JSON.stringify({ grounded: false, unsupported_claims: [], evidence_chunk_ids: [] }),
    ["chunk-1"],
  );
  assert(malformed === null, "empty negative decision must fail closed");

  const validNegative = parseGroundingVerifierDecision(
    JSON.stringify({ grounded: false, unsupported_claims: ["30-day return period"], evidence_chunk_ids: [] }),
    ["chunk-1"],
  );
  assert(validNegative?.grounded === false, "well-formed negative decision must parse");
});
