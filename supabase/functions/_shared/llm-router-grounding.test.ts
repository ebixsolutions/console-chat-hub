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

// Source-grounded internal merchant fields do not grant visitor disclosure.
for(const [id,source,answer,expected] of [
 ['internal-currency-prose','Internal cost: HKD 3210. Selling price: HKD 4560.','Internal cost is HKD 3,210.',false],
 ['internal-relabelled-price','Internal cost: HKD 3210. Selling price: HKD 4560.','The recorded price is HKD 3,210.',false],
 ['public-sale','Internal cost: HKD 3210. Selling price: HKD 4560.','The recorded selling price is HKD 4,560.',true],
 ['same-number-safe','Internal cost: HKD 4560. Selling price: HKD 4560.','The recorded selling price is HKD 4,560.',true],
 ['same-number-private-label','Internal cost: HKD 4560. Selling price: HKD 4560.','Internal cost is HKD 4,560.',false],
 ['public-cost-question-word','Plan cost: HKD 4560.','It costs HKD 4,560.',true],
 ['public-unit-cost-word','Unit cost: HKD 4560.','The unit cost is HKD 4,560.',true],
 ['public-cost-question-as-context','Selling price: HKD 4560.','It costs HKD 4,560.',true],
 ['internal-price-no-public-substring','Internal price: HKD 3210.','The price is HKD 3,210.',false],
 ['json-field','{"cost_price":"HKD 3210","selling_price":"HKD 4560"}','The recorded price is HKD 3,210.',false],
 ['json-sale','{"cost_price":"HKD 3210","selling_price":"HKD 4560"}','The recorded selling price is HKD 4,560.',true],
 ['markdown-column','| cost_price | selling_price |\n| --- | --- |\n| HKD 3210 | HKD 4560 |','The recorded price is HKD 3,210.',false],
 ['markdown-key-value','| cost_price | HKD 3210 |\n| selling_price | HKD 4560 |','The recorded price is HKD 3,210.',false],
 ['chinese-private','成本價：HKD 3210；售價：HKD 4560','成本為 HKD 3,210。',false],
 ['chinese-public','成本價：HKD 3210；售價：HKD 4560','記錄售價為 HKD 4,560。',true],
 ['ordinary-number','Internal cost: HKD 3. Selling price: HKD 5.','The recorded selling price is HKD 5.',true],
 ['cost-zero','cost_price: HKD 0\nselling_price: HKD 50','Internal cost is HKD 0.',false],
 ['typed-json-escaped-newlines',JSON.stringify([{id:'E1',full_content:'product_model: AX-QZ81\ncost_price: HKD 3210\nselling_price: HKD 4560'}]),'Internal cost is HKD 3,210.',false],
 ['typed-json-table',JSON.stringify([{id:'E1',full_content:'| cost_price | selling_price |\n| --- | --- |\n| HKD 3210 | HKD 4560 |'}]),'The recorded price is HKD 3,210.',false],
 ['camelcase-field','internalCost: HKD 3210\nsellingPrice: HKD 4560','The recorded price is HKD 3,210.',false],
 ['cny-cost','cost_price: CNY 3210\nselling_price: CNY 4560','The recorded price is CNY 3210.',false],
] as Array<[string,string,string,boolean]>) Deno.test('Task3C private-field output authority: '+id,()=>{
 const result=validateExactFactGrounding(answer,source,[],'How much does it cost?');
 assert(result.ok === expected, JSON.stringify(result));
  if(!expected) assert(!result.ok && result.reason === 'internal_cost_field_disclosure', 'private field rejection reason');
});

// The local Assist verifier receives these serialized envelopes. Equal retail
// and internal values remain distinguishable by their decoded semantic labels.
for (const [label, answer, expected] of [
  ["suggestion newline private", JSON.stringify({suggestions:[{content:"Record:\ninternal_cost: HKD 4,560.",tone_label:"Informative"}]}), false],
  ["suggestion newline retail", JSON.stringify({suggestions:[{content:"Record:\nselling_price: HKD 4,560.",tone_label:"Informative"}]}), true],
  ["suggestion quoted private", JSON.stringify({suggestions:[{content:'Record: "internal_cost": "HKD 4560"',tone_label:"Informative"}]}), false],
  ["policy summary private", JSON.stringify({status:"compliant",summary:"Record:\ninternal_cost: HKD 4,560.",issues:[]}), false],
  ["policy issue private", JSON.stringify({status:"warning",summary:"Review required.",issues:[{excerpt:"Record:\ninternal_cost: HKD 4,560.",policy_label:"Evidence 1",severity:"warning"}]}), false],
  ["policy retail", JSON.stringify({status:"compliant",summary:"Recorded selling price: HKD 4,560.",issues:[]}), true],
  ["root JSON string", JSON.stringify("Record:\ninternal_cost: HKD 4,560."), false],
  ["scalar property label", JSON.stringify({internal_cost:"HKD4560"}), false],
  ["numeric property label", JSON.stringify({internal_cost:4560}), false],
  ["array property label", JSON.stringify({internal_cost:["HKD4560"]}), false],
  ["retail property label", JSON.stringify({selling_price:"HKD 4560"}), true],
  ["public cost phrase", JSON.stringify({suggestions:[{content:"It costs HKD 4,560.",tone_label:"Informative"}]}), true],
] as const) Deno.test("Task3C cost guard decodes answer JSON: " + label, () => {
  const result = validateExactFactGrounding(answer, "Internal cost: HKD 4560. Selling price: HKD 4560.");
  assert(result.ok === expected, label + ": " + JSON.stringify(result));
  if (!expected) assert(!result.ok && result.reason === "internal_cost_field_disclosure", label + ": wrong rejection reason");
});
