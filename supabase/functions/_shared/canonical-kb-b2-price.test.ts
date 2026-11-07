import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import {
  type B2KbPriceProof,
  evaluateB2BeforeCommit,
  executeB2PersistenceGate,
} from "./pre-send-conversion-supervisor.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const company = "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493";
const conversation = "11111111-1111-4111-8111-111111111111";
const source = "22222222-2222-4222-8222-222222222222";
const document = "4f446f53b7cf4dd58a85a84f4d39c39e";
const chunk = "17d99f7de3dd43d6ae431ed0c128d0f0";
const fullContent = "商品型號:CW-SUL90BA 成本:4620 銷售價:6980 特價:4908 品牌:PANASONIC 樂聲牌 描述:CW-SUL90BA 1.0匹 Inverter LITE";
const reply = "目前產品資料列出 CW-SUL90BA 售價為 HK$6,980；實際結帳價請再確認。";
const price: B2KbPriceProof = {
  field: "selling_price", value: 6980, currency: "HKD", model: "CW-SUL90BA",
  document_id: document, chunk_id: chunk, tenant_id: "34", company_id: company,
  currentness: "current", authority_decision: "USE_CURRENT_KB",
  request: "CW-SUL90BA 售價幾多？", full_content: fullContent,
};
const { request: _request, full_content: _content, company_id: _company, ...publicProof } = price;
const metadata = {
  response_route: "canonical_kb_direct_answer", answer_kind: "price",
  kb_fact_proof: publicProof,
  reference_authority: { decision: "USE_CURRENT_KB", selected_source_id: document,
    provenance: { tenant_id: "34", currentness: "current", region: "hong_kong" } },
  citation_lineage: { selected_document_id: document, evidence_chunk_ids: [chunk],
    evidence_count: 1, authority_decision: "USE_CURRENT_KB", evidence_state: "current",
    current_target: { entity_ids: ["sul90ba"] } },
  citations: [{ document_id: document, chunk_id: chunk, chunk_type: "full_content",
    authority_decision: "USE_CURRENT_KB", evidence_state: "current" }],
};
const snapshot = { conversation_id: conversation, company_id: company,
  source_message_id: source, commerce_state_revision: 0,
  commerce_state_source_message_id: null, state: createEmptyConversationCommerceState() };
function evaluate(response = reply, overrides: {
  proof?: B2KbPriceProof | null;
  metadata?: Record<string, unknown>;
  company_id?: string;
} = {}) {
  return evaluateB2BeforeCommit({ proposed_response: response, persistence_kind: "ai_reply",
    snapshot: { ...snapshot, company_id: overrides.company_id ?? company },
    metadata: overrides.metadata ?? metadata,
    trusted_kb_price_proof: overrides.proof === undefined ? price : overrides.proof });
}

Deno.test("B2 current KB selling price admits exact server proof without Commerce quote", () => {
  const result = evaluate();
  assert(result.decision === "allow" && result.code === "B2_ALLOW_CURRENT_KB_SELLING_PRICE", JSON.stringify(result));
  const summary = evaluate("有，PANASONIC 樂聲牌 CW-SUL90BA，1.0匹 Inverter LITE。產品資料售價為 HK$6,980。現有資料未確認即時庫存。");
  assert(summary.decision === "allow" && summary.code === result.code, JSON.stringify(summary));
  console.log("A1/A2 B2:", result.code);
});

Deno.test("B2 blocks fabricated, mismatched, historical and cross-tenant KB price", () => {
  const cases: Array<[string, ReturnType<typeof evaluate>, string]> = [
    ["no trusted proof", evaluate(reply, { proof: null }), "CURRENT_KB_PRICE_PROOF_MISSING"],
    ["cost as price", evaluate(reply.replace("6,980", "4,620")), "CURRENT_KB_PRICE_RESPONSE_MISMATCH"],
    ["special price", evaluate(reply.replace("6,980", "4,908")), "CURRENT_KB_PRICE_RESPONSE_MISMATCH"],
    ["extra price", evaluate(reply + " 特價 HK$4,908。"), "CURRENT_KB_PRICE_RESPONSE_MISMATCH"],
    ["different product", evaluate(reply, { proof: { ...price, model: "WRONG-123" } }), "CURRENT_KB_PRICE_LINEAGE_INVALID"],
    ["historical", evaluate(reply, { proof: { ...price, currentness: "historical" as "current" } }), "CURRENT_KB_PRICE_LINEAGE_INVALID"],
    ["other tenant", evaluate(reply, { company_id: "different-company" }), "CURRENT_KB_PRICE_LINEAGE_INVALID"],
    ["missing citation", evaluate(reply, { metadata: { ...metadata, citations: [] } }), "CURRENT_KB_PRICE_LINEAGE_INVALID"],
    ["wrong chunk", evaluate(reply, { metadata: { ...metadata, citation_lineage: { ...metadata.citation_lineage, evidence_chunk_ids: ["other-chunk"] } } }), "CURRENT_KB_PRICE_LINEAGE_INVALID"],
    ["bad amount in evidence", evaluate(reply, { proof: { ...price, full_content: fullContent.replace("銷售價:6980", "銷售價:4620") } }), "CURRENT_KB_PRICE_FACT_MISMATCH"],
  ];
  for (const [name, result, code] of cases) {
    assert(result.decision === "block" && result.code === code, `${name}: ${JSON.stringify(result)}`);
    console.log(name, result.code);
  }
  const arbitrary = evaluateB2BeforeCommit({ proposed_response: reply, persistence_kind: "ai_reply", snapshot });
  assert(arbitrary.decision === "block" && arbitrary.code === "CURRENT_QUOTE_NOT_PROVEN", "model_generated_price_bypassed");
});

Deno.test("B2 persistence invokes callback only after current KB proof and exact snapshot reread", async () => {
  const client = { from: (table: string) => ({
    select(_columns: string) { return this; },
    eq(_column: string, _value: string) { return this; },
    async maybeSingle() {
      if (table === "conversations") return { data: { id: conversation, company_id: company }, error: null };
      if (table === "messages") return { data: { id: source, conversation_id: conversation, role: "visitor" }, error: null };
      return { data: null, error: null };
    },
  }) };
  let commits = 0;
  const args = { client, conversation_id: conversation, source_message_id: source,
    proposed_response: reply, persistence_kind: "ai_reply" as const,
    metadata, trusted_kb_price_proof: price,
    commit: async () => { commits++; return "persisted"; } };
  const allowed = await executeB2PersistenceGate(args);
  assert(allowed.committed && allowed.decision.code === "B2_ALLOW_CURRENT_KB_SELLING_PRICE" && commits === 1, "B2 did not commit after proof");
  const blocked = await executeB2PersistenceGate({ ...args, trusted_kb_price_proof: null });
  assert(!blocked.committed && blocked.decision.code === "CURRENT_KB_PRICE_PROOF_MISSING" && commits === 1, "B2 callback ran without proof");
});
