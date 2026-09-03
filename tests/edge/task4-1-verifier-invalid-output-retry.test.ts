const source = await Deno.readTextFile(new URL("../../supabase/functions/_shared/llm-router.ts", import.meta.url));

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

Deno.test("malformed verifier output retries once on identical evidence path", () => {
  const start = source.indexOf("const decision = parseGroundingVerifierDecision");
  assert(start >= 0, "decision parser missing");
  const block = source.slice(start, start + 2200);
  assert(block.includes("GROUNDING_VERIFIER_INVALID_OUTPUT"), "invalid-output audit missing");
  assert(block.includes("grounding_verifier_invalid_output_retry"), "invalid-output retry event missing");
  assert(block.includes("if (attempt < 2)"), "retry bound missing");
  assert(block.includes("continue;"), "retry does not continue same verifier loop");
  assert(block.includes('reason: "verifier_invalid_output"'), "exhausted invalid-output fail-closed missing");
});

Deno.test("valid grounded=false remains immediate semantic rejection", () => {
  const decisionStart = source.indexOf("const decision = parseGroundingVerifierDecision");
  const rejectStart = source.indexOf("if (!decision.grounded)", decisionStart);
  assert(decisionStart >= 0 && rejectStart > decisionStart, "grounded=false branch missing");
  const block = source.slice(decisionStart, rejectStart + 1200);
  assert(block.includes("GROUNDING_UNSUPPORTED_CLAIMS"), "unsupported-claims audit missing");
  const rejectBlock = source.slice(rejectStart, rejectStart + 1200);
  assert(rejectBlock.includes('reason: "unsupported_semantic_claim"'), "semantic fail-closed missing");
  assert(!rejectBlock.includes("grounding_verifier_invalid_output_retry"), "grounded=false must not use malformed-output retry");
});

Deno.test("exact-fact rejection remains before semantic verifier", () => {
  const exact = source.indexOf("validateExactFactGrounding(answer");
  const verifier = source.indexOf("const verifierEvidence = buildVerifierEvidenceAliases");
  assert(exact >= 0 && verifier > exact, "exact-fact gate must precede semantic verifier");
  const block = source.slice(exact, verifier);
  assert(block.includes("grounding_exact_fact_rejected"), "exact-fact rejection log missing");
  assert(block.includes("return { ok: false"), "exact-fact gate no longer fail-closed");
});
