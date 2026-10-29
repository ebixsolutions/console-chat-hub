import { parseAggregationResponse } from "./kb-aggregation-response.ts";
import type { KBDocumentCandidate } from "./kb-client.ts";
import { selectCanonicalGrounding, deriveCurrentGroundingTarget } from "./canonical-grounding.ts";
import { resolveCanonicalKbDirectAnswer } from "./canonical-kb-direct-answer.ts";
import { buildCitationMetadata } from "./citation-lineage.ts";
import { bindRagApiResponse, bindRagServiceDocument, ORIGINAL_RAG_ACTIVATION } from "./preview-kb-query-embedding.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { evaluateB2BeforeCommit } from "./pre-send-conversion-supervisor.ts";

function assert(v: unknown, m: string): asserts v { if (!v) throw new Error(m); }
const product = "轻量冲锋衣";
const request = `${product} 几钱？`;
const documentId = "record-shape-test-only", chunkId = "record-shape-chunk-test-only";
// Source-format regression only: test prices below are synthetic and must
// NEVER be presented as the live product's real price. The "header: value"
// representation comes from the existing CSV/XLSX/JSON import serializers.
async function bindRow(body: string, overrides: Record<string, unknown> = {}, bound = true) {
  const wire = {success:true,context_found:true,selected_documents:[{
    document_id:documentId,title:"Row 4",source_type:"Product",document_score:0.03,
    authority:{tenant_id:"34",publication_state:"published",currentness:"unknown",...overrides},
    evidence:[{document_id:documentId,chunk_id:chunkId,chunk_type:"full_content",content:body,score:0.03}],
  }],citations:[]};
  const parsed = parseAggregationResponse(wire);
  assert(parsed.ok && parsed.contextFound, "actual production wire decoder rejected test row");
  const source = parsed.documents[0];
  const doc: KBDocumentCandidate = {...source,chunks:source.chunks.map(c=>({...c,doc_id:c.document_id,status:"unknown"}))};
  if (bound) {
    const {response} = await bindRagApiResponse(Response.json(wire), ORIGINAL_RAG_ACTIVATION);
    bindRagServiceDocument(response, doc);
    for (const chunk of doc.chunks) bindRagServiceDocument(response, chunk);
  }
  return doc;
}
function resolve(doc: KBDocumentCandidate) {
  const selection = selectCanonicalGrounding([doc], {requestText:request,currentTurnText:request,minScore:0.45,
    requirePublished:true,expectedTenantId:"34",expectedEntityIds:[],expectedTopicIds:[],requiresCurrentKb:true});
  return {selection,result:resolveCanonicalKbDirectAnswer({request,selection,language:"zh-TW"})};
}
for (const key of ["商品型號","商品型号","產品型號","产品型号","名稱","名称","name","title","product_name","Product-Name","productName","商品名稱","商品名称"]) {
  Deno.test(`Task1C imported record uses source identity column ${key}, not Row 4 title`, async () => {
    const {selection,result} = resolve(await bindRow(`${key}: ${product}\n價格: 599.50\n幣別: HKD\n顏色: 海軍藍`));
    assert(selection.ok && selection.document?.document_id === documentId, `source identity lost: ${key}`);
    assert(result?.kind === "listed_price_unverified" && result.reply.includes("HK$599.5"), `source price lost: ${key}`);
    assert(!result.price_fact && result.reply.includes("未核實係現價"), "invented current quote proof");
    const citations = buildCitationMetadata(result.evidence_chunks, documentId, {authorityDecision:selection.authority_decision,currentTarget:deriveCurrentGroundingTarget(request)});
    assert(citations?.citation_lineage.evidence_chunk_ids[0] === chunkId, "lineage lost");
    const b2 = evaluateB2BeforeCommit({proposed_response:result.reply,persistence_kind:"ai_reply",
      snapshot:{conversation_id:"example",company_id:"3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",source_message_id:"example",
        commerce_state_revision:0,commerce_state_source_message_id:null,state:createEmptyConversationCommerceState()},
      metadata:{...citations,response_route:"canonical_kb_direct_answer",answer_kind:result.kind,reference_authority:selection.authority_decision}});
    assert(b2.decision === "allow", `unchanged B2 denied source record: ${b2.code}`);
  });
}
Deno.test("Task1C a recorded amount without currency answers only the known portion", async () => {
  const {result} = resolve(await bindRow(`商品型號: ${product}\n銷售價: 599\n描述: 戶外外套`));
  assert(result?.kind === "listed_price_unverified" && result.reply.includes("599") && result.reply.includes("未註明幣別"), "known amount swallowed by missing currency");
  assert(!result.reply.includes("HK$") && !result.price_fact, "missing currency became HKD/current proof");
});
Deno.test("Task1C labelled, JSON and single-row markdown preserve the same atomic product", async () => {
  for (const body of [
    `工作表: 商品列表 ID: 4 商品型號: ${product} 商品圖片: 28 成本: 9 銷售價: HK$1,999 顏色: 藍 描述: 戶外外套`,
    JSON.stringify({product_name:product,selling_price:"HK$1,999",description:"戶外外套"}),
    `| product_name | selling_price |\n|---|---|\n|${product}| HK$1,999 |`,
  ]) {
    const {result} = resolve(await bindRow(body));
    assert(result?.kind === "listed_price_unverified" && result.reply.includes("HK$1,999"), "source format changed a bound field");
  }
});
Deno.test("Task1C ambiguous/multi-product/description-only identity stays rejected", async () => {
  for (const body of [
    `name: 別款外套\ndescription: 與${product}搭配\nprice: HK$599`,
    `name: ${product}\nprice: HK$599\nname: 別款外套\nprice: HK$999`,
    `name: ${product}\nname_2: 別款外套\nprice: HK$599`,
    `| name | price |\n|---|---|\n|${product}|HK$599|\n|別款外套|HK$999|`,
    JSON.stringify([{name:product,price:599},{name:"別款外套",price:999}]),
    JSON.stringify({name:"別款外套",related:{name:product,price:599}}),
    `{"name":"別款外套","name":"${product}","price":"HK$599"}`,
  ]) assert(resolve(await bindRow(body)).result === null, "ambiguous source became a selected product");
});
Deno.test("Task1C conflicts/costs/foreign amounts never become the HKD selling price", async () => {
  for (const fields of [
    "price: HK$599\nselling_price: HK$999", "price: 599\ncurrency: USD", "price: USD 599",
    "price: HK$599\nprice_2: HK$999", "price: HK$599\nprice_10: HK$999",
    "price: 599\ncurrency: HKD\ncurrency_2: USD", "price: HK$999,999,999,999,999",
    "price: $599", "cost_price: HK$599\nspecial_price: HK$499", "price: 12,99", "price: HK$599 SGD",
  ]) {
    const {result} = resolve(await bindRow(`name: ${product}\n${fields}`));
    const explicitUsd = fields === "price: 599\ncurrency: USD" || fields === "price: USD 599";
    assert(result?.kind === (explicitUsd ? "listed_price_unverified" : "price_unknown") &&
      !result.reply.includes("HK$599") && !result.price_fact && (!explicitUsd || result.reply.includes("USD 599")), "unsafe price extraction");
  }
});
Deno.test("Task1C actual wire binding and tenant/publication/currentness remain mandatory", async () => {
  const body = `name: ${product}\nprice: HK$599`;
  assert(resolve(await bindRow(body,{},false)).result === null, "unbound JSON minted service authority");
  for (const override of [{tenant_id:"other"},{publication_state:"draft"},{currentness:"historical"},{currentness:"superseded"},{currentness:"cancelled"}]) {
    let result;
    try { result = resolve(await bindRow(body,override)).result; }
    catch (error) {
      assert(error instanceof Error && error.message === "KB_TOOL_FAILURE" &&
        "reason" in error && ["KB_RAG_TENANT_CONFLICT","KB_RAG_AUTHORITY_CONFLICT"].includes(String(error.reason)),
        "unexpected binding error masked an authority test");
      result = null;
    }
    assert(result === null, `authority bypass ${JSON.stringify(override)}`);
  }
});

Deno.test("Task1C identity/value text embedded in description cannot mint fields", async () => {
  const forged = await bindRow(`description: A reference example name: ${product} price: HK$599`);
  assert(resolve(forged).result === null, "prose masqueraded as product columns");
});

Deno.test("Task1C source-column compatibility is not a product-name whitelist", async () => {
  for (const [name, question] of [["保溫隨行杯", "保溫隨行杯 幾錢？"], ["Cloud Linen Shirt", "How much is the Cloud Linen Shirt?"]]) {
    const doc = await bindRow(`product_name: ${name}\nselling_price: HK$188`);
    const selection = selectCanonicalGrounding([doc], {requestText:question,currentTurnText:question,minScore:0.45,
      requirePublished:true,expectedTenantId:"34",requiresCurrentKb:true});
    const answer = resolveCanonicalKbDirectAnswer({request:question,selection,language:"en"});
    assert(answer?.kind === "listed_price_unverified" && answer.reply.includes("HK$188") && !answer.price_fact, "cross-industry record lost");
  }
});
