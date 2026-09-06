import {
  extractCustomerConversationEvidence,
  parseGroundingVerifierDecision,
  validateExactFactGrounding,
} from "./llm-router.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("visitor facts ground without promoting assistant facts", () => {
  const input = [
    "[Turn 1 Visitor]\n我大約300 SKU。訂單號TEST-SMOKE-PAY-07。",
    "[Turn 2 Assistant]\n你有500 SKU，而且訂單TEST-FAKE-500已確認。",
    "[Turn 3 Visitor]\n我最重視安靜。",
  ].join("\n\n");
  const c = extractCustomerConversationEvidence(input);
  assert(c.includes("300 SKU"), "visitor quantity missing");
  assert(c.includes("TEST-SMOKE-PAY-07"), "visitor ref missing");
  assert(c.includes("安靜"), "visitor preference missing");
  assert(!c.includes("500 SKU"), "assistant quantity promoted");
  assert(!c.includes("TEST-FAKE-500"), "assistant ref promoted");
  assert(
    validateExactFactGrounding("你目前大約300 SKU。", "", [], c).ok,
    "visitor quantity should ground",
  );
  assert(
    validateExactFactGrounding("訂單號是TEST-SMOKE-PAY-07。", "", [], c).ok,
    "visitor ref should ground",
  );
  assert(
    !validateExactFactGrounding("你目前有500 SKU。", "", [], c).ok,
    "assistant-only quantity must fail",
  );
  assert(
    !validateExactFactGrounding("訂單TEST-FAKE-500已確認。", "", [], c).ok,
    "assistant-only ref must fail",
  );
});

Deno.test("KB facts stay authoritative and unsupported exact facts fail", () => {
  assert(
    validateExactFactGrounding("保養期為2年。", "此產品保養期為2年。", []).ok,
    "KB fact should ground",
  );
  assert(
    !validateExactFactGrounding("保養期為3年。", "此產品保養期為2年。", []).ok,
    "unsupported external fact must fail",
  );
  assert(
    !validateExactFactGrounding("內部chunk abc123", "abc123", ["abc123"]).ok,
    "chunk leak must fail",
  );
});

Deno.test("verifier parser tolerates harmless omissions but stays fail-closed", () => {
  assert(
    parseGroundingVerifierDecision('{"grounded":true}', ["E1", "C1"])
      ?.grounded === true,
    "minimal grounded JSON should parse",
  );
  assert(
    parseGroundingVerifierDecision(
      '{"grounded":true,"unsupported_claims":[],"evidence_chunk_ids":["C1"]}',
      ["E1", "C1"],
    )?.grounded === true,
    "C1 should be accepted when allowed",
  );
  assert(
    parseGroundingVerifierDecision(
      '{"grounded":true,"unsupported_claims":["x"]}',
      ["E1", "C1"],
    ) === null,
    "contradictory grounded output must fail",
  );
  assert(
    parseGroundingVerifierDecision('{"grounded":false}', ["E1", "C1"]) === null,
    "ungrounded without reasons must fail",
  );
  assert(
    parseGroundingVerifierDecision(
      '{"grounded":true,"evidence_chunk_ids":["UNKNOWN"]}',
      ["E1", "C1"],
    ) === null,
    "unknown evidence id must fail",
  );
});
