import {
  extractCustomerConversationEvidence,
  createModelTurnBudget,
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

Deno.test("W2 G4 exact monetary grounding preserves marker/list and refuses changed amounts/currencies", () => {
  const truth: Array<[string,string,boolean]> = [
    ["台幣 (NTD) 910 / 1,280 / 2,170 元/月", "NT$910", true],
    ["台幣 (NTD) 910 / 1,280 / 2,170 元/月", "NT$1,280", true],
    ["台幣 (NTD) 910 / 1,280 / 2,170 元/月", "TWD 2,170", true],
    ["台幣 (NTD) 910 / 1,280 / 2,170 元/月", "HK$1,280", false],
    ["台幣 (NTD) 910 / 1,280 / 2,170 元/月", "NT$1,290", false],
    ["NT$910", "NT$91", false],
    ["1,910 元", "910 元", false],
    ["NT$910", "HK$910", false],
    ["NT$910", "US$910", false],
    ["$79", "US$79", false],
    ["NT$910", "TWD 910", true],
    ["NT$910", "每月 910 元", true],
    ["NT$1,280", "NT$1280", true],
    ["NT$910.50", "NT$910.5", true],
    ["12 個月 NT$9,100", "NT$910", false],
    ["NT$910，HK$750", "HK$910", false],
    ["NT$910，HK$750", "HK$750", true],
  ];
  for (const [source, answer, allowed] of truth)
    assert(validateExactFactGrounding(answer, source).ok === allowed,
      `amount and currency authority mismatch: ${source} → ${answer}`);
});

Deno.test("Task3C T06 request-scoped budget admits three attempts, rejects fourth",()=>{
 const b=createModelTurnBudget(3),other=createModelTurnBudget(3);
 assert(b.reserve()&&b.reserve()&&b.reserve(),"three legal slots");
 assert(b.used===3&&!b.reserve()&&b.used===3,"fourth provider dispatch blocked");
 assert(other.reserve()&&other.used===1,"separate visitor budget isolation");
 for(const invalid of [0,5,1.5,Infinity]){let denied=false;try{createModelTurnBudget(invalid)}catch{denied=true}assert(denied,"unapproved budget cannot be accepted");}
});
Deno.test("T06 contradictory reviewer remains fail-closed, positive claim-free reply is valid",()=>{
 assert(parseGroundingVerifierDecision('{"grounded":true,"unsupported_claims":[],"evidence_chunk_ids":[],"question_resolution":"partial"}',["E1","C1"])?.grounded===true,"claim-free verdict");
 assert(parseGroundingVerifierDecision('{"grounded":false,"unsupported_claims":[]}',["E1","C1"])===null,"do not coerce negative verdict");
 assert(parseGroundingVerifierDecision('{"grounded":true,"unsupported_claims":["invented current price"],"evidence_chunk_ids":["E1"]}',["E1","C1"])===null,"invented claim cannot pass");
});

// Same source-level bound for ordinary visitors and authorized Preview.
// Actual paid test-run scope remains separate and cannot be expanded by tests.
Deno.test("Task3C shared four-call model budget never admits a fifth",()=>{
  const ordinary=createModelTurnBudget();
  const preview=createModelTurnBudget();
  for(const turn of [ordinary,preview]){
    assert(turn.limit===4,"both entrypoints use the same model budget");
    for(let i=0;i<4;i++)assert(turn.reserve(),"allowed physical dispatch");
    assert(!turn.reserve()&&turn.used===4,"fifth paid dispatch denied");
  }
  const narrower=createModelTurnBudget(3);
  assert(narrower.reserve()&&narrower.reserve()&&narrower.reserve()&&!narrower.reserve(),
    "lower bound remains valid for independently authorized scopes");
});
