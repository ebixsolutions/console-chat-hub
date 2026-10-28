import { deriveCurrentGroundingTarget, selectCanonicalGrounding } from "./canonical-grounding.ts";
import { currentKbSellingPrice, resolveCanonicalKbDirectAnswer } from "./canonical-kb-direct-answer.ts";
import { buildCitationMetadata } from "./citation-lineage.ts";
import type { KBDocumentCandidate } from "./deterministic-kb-client.ts";
import { renderBoundedNoCurrentEvidence } from "./current-fact-evidence.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { evaluateB2BeforeCommit, type B2KbPriceProof } from "./pre-send-conversion-supervisor.ts";
import { bindRagApiResponse, bindRagServiceDocument, ORIGINAL_RAG_ACTIVATION } from "./preview-kb-query-embedding.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const documentId = "4f446f53b7cf4dd58a85a84f4d39c39e";
const chunkId = "17d99f7de3dd43d6ae431ed0c128d0f0";
// Exact Full Content returned by the live tenant 34 Knowledge search for the
// selected published document/chunk, including the intervening export fields.
const content = "工作表：商品設定_20260813 162932 ID: 7945 狀態: 開啟 商品型號: CW-SUL90BA 商品圖片: 28 成本: 4620 銷售價: 6980 特價: 4908 匹數 (多聯分體式): 29 品牌: PANASONIC 樂聲牌 附加項目: 否 新增日期: 46247 標籤: 32 描述: PANASONIC 樂聲 CW-SUL90BA 1.0匹Inverter LITE變頻式淨冷窗口機，採用香港專利左出風設計、R32製冷劑及四合一抗菌過濾網，製冷能力8,870BTU/h，設左右自動送風、睡眠模式及1.5L/h抽濕功能，菲律賓製造，獲香港1級能源標籤並提供3年全機及5年壓縮機保用。 功能: 變頻 淨冷 匹數: 1匹 氣體: 36 風數: 37";
const chunk: KBDocumentCandidate["chunks"][number] = {
  document_id: documentId, doc_id: documentId, chunk_id: chunkId,
  content, title: "PANASONIC 樂聲 CW-SUL90BA", score: 0.93,
  chunk_type: "full_content", source_type: "product", status: "published",
};
const doc: KBDocumentCandidate = {
  document_id: documentId, title: "PANASONIC 樂聲 CW-SUL90BA", source_type: "product", document_score: 0.93,
  chunks: [chunk], citations: [], meta: {
    document_score: 0.93, highest_chunk_score: 0.93, second_highest_chunk_score: 0,
    returned_summary_count: 0, returned_full_content_count: 1,
    dropped_without_document_id: 0, dropped_without_content: 0,
  },
  llm_context: { selected_document_id: documentId, orientation_summary: null,
    full_content_evidence: [{ document_id: documentId, chunk_id: chunkId, content, score: 0.93, source_type: "product" }] },
  authority: { tenant_id: "34", publication_state: "published", currentness: "current", entity_ids: ["CW-SUL90BA"],
    regions: ["hong_kong"], language: null, version: null, version_rank: null, updated_at: null, source_priority: null, claims: [] },
};

function answer(request: string, documents: KBDocumentCandidate[] = [doc], tenant = "34") {
  const target = deriveCurrentGroundingTarget(request);
  const selection = selectCanonicalGrounding(documents, {
    minScore: 0.45, requirePublished: true, requestText: request,
    currentTurnText: request, expectedTenantId: tenant,
    expectedEntityIds: target.entity_ids, expectedTopicIds: target.topic_ids,
    requiresCurrentKb: true,
  });
  const resolved = resolveCanonicalKbDirectAnswer({ request, selection, language: "zh-TW" });
  const citation = resolved && selection.ok ? buildCitationMetadata(
    resolved.evidence_chunks, selection.document?.document_id ?? null,
    { authorityDecision: selection.authority_decision, currentTarget: target },
  ) : null;
  return { selection, resolved, citation };
}

async function serviceReference(source: KBDocumentCandidate = doc) {
  // Exercise the real aggregation validator and its out-of-band document AND
  // chunk bindings. Merely changing an authority enum cannot mint provenance.
  const document = {...source, authority:{...source.authority!,currentness:"unknown" as const},
    chunks:source.chunks.map(c=>({...c,status:"unknown" as const}))};
  const {response} = await bindRagApiResponse(Response.json({success:true,context_found:true,
    selected_documents:[{document_id:document.document_id,title:document.title,source_type:document.source_type,
      document_score:document.document_score,authority:document.authority,
      evidence:document.chunks.map(({status:_status,...c})=>c)}],citations:[]}),ORIGINAL_RAG_ACTIVATION);
  bindRagServiceDocument(response,document);
  for (const c of document.chunks) bindRagServiceDocument(response,c);
  return answer("CW-SUL90BA 售價幾多？",[document]);
}

Deno.test("A1 exact known product answers record existence, no stock and exact citation", () => {
  const { selection, resolved, citation } = answer("有沒有 PANASONIC 樂聲 CW-SUL90BA");
  assert(selection.ok && resolved?.kind === "price", "known_answer_dead_end");
  assert(resolved.reply.includes("PANASONIC") && resolved.reply.includes("1.0匹") &&
    resolved.reply.includes("HK$6,980") && resolved.reply.includes("未確認即時庫存"), "customer_value_or_stock_error");
  assert(!/我搵到|成本|特價|4620|4908/.test(resolved.reply), "retrieval_centric_or_internal_price");
  assert(resolved.reply.includes("PANASONIC 樂聲牌 CW-SUL90BA") &&
    !resolved.reply.includes("附加項目"), "brand_field_boundary_failed");
  assert(resolved.kind === "price" && resolved.price_fact?.value === 6980, "summary_price_proof_missing");
  assert(!/請提供|訂單編號/.test(resolved.reply), "unnecessary_reask");
  assert(citation?.citation_lineage.selected_document_id === documentId &&
    citation.citation_lineage.evidence_chunk_ids[0] === chunkId, "citation_lineage_missing");
  console.log("A1 reply:", resolved.reply, "lineage:", JSON.stringify(citation?.citation_lineage));
});

Deno.test("Task1 price fields preserve complete amounts and reject foreign, ambiguous or conflicting values", () => {
  for (const [source, expected] of [
    ["銷售價: HK$129,980", 129980],
    ["銷售價: 6,980.50 HKD", 6980.5],
    ["銷售價: 99.50", 99.5],
    ["銷售價: HK$0.50", 0.5],
    ["銷售價: 6980 | selling price: HKD 6,980", 6980],
    ["商品型號:CW-SUL90BA銷售價:6980售價:6980", 6980],
    ["銷售價: 6980 SGD", null],
    ["銷售價: 6980 新幣", null],
    ["銷售價: USD 6980", null],
    ["銷售價: 6980 USD", null],
    ["銷售價: HK$6980 SGD", null],
    ["銷售價: 129,98", null],
    ["銷售價: 6980.999", null],
    ["銷售價: 6980-7980", null],
    ["銷售價: 6980 | 售價: 5680", null],
    ["銷售價: 5680 | 售價: 6980", null],
    ["銷售價: 6980 | 售價: 未提供", null],
    ["銷售價: 6980 | 售價: 6980 SGD", null],
    ["cost price: 4620 | special price: 4908", null],
    ["商品型號: CW-SUL70BA 銷售價: 5680 | 商品型號: CW-SUL90BA 銷售價: 5680", null],
  ] as const) {
    assert(currentKbSellingPrice(source) === expected, JSON.stringify({source, expected, actual:currentKbSellingPrice(source)}));
  }
});

Deno.test("Task1 price parsing stays source-bound through citation, B2 and unknown-currentness replies", async () => {
  const request = "CW-SUL90BA 售價幾多？";
  const snapshot = { conversation_id:"example", company_id:"3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    source_message_id:"example-source", commerce_state_revision:0,
    commerce_state_source_message_id:null, state:createEmptyConversationCommerceState() };
  for (const [fields, expected] of [
    [["銷售價: HK$129,980"], 129980],
    [["銷售價: 99.50 HKD"], 99.5],
    [["銷售價: 6980 SGD"], null],
    [["銷售價: 6980 | 售價: 5680"], null],
    [["銷售價: 6980", "售價: 5680"], null],
    [["銷售價: 6980", "售價: 6980 SGD"], null],
    [["銷售價: 6980", "售價: 未提供"], null],
    [["銷售價: 6980 | 商品型號: OTHER-123 銷售價: 6980"], null],
  ] as const) {
    const chunks = fields.map((field, i) => ({...chunk, chunk_id:`${chunkId}-${i}`, content:`商品型號: CW-SUL90BA | ${field}`}));
    const fixture: KBDocumentCandidate = {...doc, chunks, llm_context:{...doc.llm_context,
      full_content_evidence:chunks.map(c=>({document_id:c.document_id,chunk_id:c.chunk_id!,content:c.content,score:c.score,source_type:c.source_type}))}};
    const {selection, resolved, citation} = answer(request,[fixture]);
    if (selection.ok && selection.authority_decision.decision === "CONFLICT_UNRESOLVED") {
      assert(expected === null && resolved === null && citation === null, "authority conflict bypassed");
      continue;
    }
    assert(selection.ok && resolved && citation, "selected source missing:" + JSON.stringify({fields,selection,resolved,citation}));
    assert(resolved.kind === (expected === null ? "price_unknown" : "price"), JSON.stringify({fields,resolved}));
    assert((resolved.price_fact?.value ?? null) === expected, "wrong current-price proof");
    if (expected !== null) {
      const fact = resolved.price_fact!;
      const proof: B2KbPriceProof = {field:"selling_price",value:fact.value,currency:"HKD",model:fact.model,
        document_id:fact.document_id,chunk_id:fact.chunk_id,tenant_id:"34",company_id:snapshot.company_id,
        currentness:"current",authority_decision:"USE_CURRENT_KB",request,full_content:fact.full_content};
      const {request:_request,full_content:_content,company_id:_company,...publicProof} = proof;
      const meta = {...citation,response_route:"canonical_kb_direct_answer",answer_kind:resolved.kind,
        kb_fact_proof:publicProof,reference_authority:selection.authority_decision};
      const verdict = evaluateB2BeforeCommit({proposed_response:resolved.reply,persistence_kind:"ai_reply",
        snapshot,metadata:meta,trusted_kb_price_proof:proof});
      assert(verdict.code === "B2_ALLOW_CURRENT_KB_SELLING_PRICE",JSON.stringify(verdict));
      for (const badField of [`${expected} SGD`, `${expected} | 售價: ${expected + 1}`]) {
        const forged = {...proof,full_content:`商品型號: CW-SUL90BA | 銷售價: ${badField}`};
        const rejected = evaluateB2BeforeCommit({proposed_response:resolved.reply,persistence_kind:"ai_reply",
          snapshot,metadata:meta,trusted_kb_price_proof:forged});
        assert(rejected.decision === "block" && rejected.code === "CURRENT_KB_PRICE_FACT_MISMATCH",JSON.stringify(rejected));
      }
    } else assert(!/HK\$/.test(resolved.reply), "invalid monetary evidence rendered");
    const {selection:referenceSelection,resolved:recorded,citation:recordedCitation} = await serviceReference(fixture);
    assert(recorded?.kind === (expected === null ? "price_unknown" : "listed_price_unverified"),JSON.stringify({fields,recorded}));
    assert(!recorded.price_fact, "unknown currentness promoted into current-price proof");
    assert(recordedCitation?.citation_lineage.evidence_state === "unknown", "source citation missing or promoted to current");
    assert(referenceSelection.ok,"service selection missing");
    for (const language of ["zh-TW","zh-CN","en"] as const) {
      const localized = resolveCanonicalKbDirectAnswer({request,selection:referenceSelection,language})!;
      const verdict = evaluateB2BeforeCommit({proposed_response:localized.reply,persistence_kind:"ai_reply",snapshot,
        metadata:{...recordedCitation,response_route:"canonical_kb_direct_answer",answer_kind:localized.kind,
          reference_authority:referenceSelection.authority_decision}});
      assert(verdict.decision === "allow",JSON.stringify({fields,language,verdict}));
    }
    if (expected !== null) assert(recorded.reply.includes(`HK$${expected.toLocaleString("en-US")}`) &&
      recorded.reply.includes("未核實係現價"), "source-recorded amount or qualification lost");
  }
});

Deno.test("field parser accepts label delimiters and safely adjacent fields", () => {
  const variants = [
    "商品型號:CW-SUL90BA 品牌:PANASONIC 樂聲牌 銷售價:6980 描述:CW-SUL90BA 1.0匹 Inverter LITE",
    "商品型号：CW-SUL90BA 品牌：PANASONIC 樂聲牌 销售价：6980 描述：CW-SUL90BA 1.0匹 Inverter LITE",
    "商品型號 = CW-SUL90BA 品牌 = PANASONIC 樂聲牌 銷售價 = 6980 描述 = CW-SUL90BA 1.0匹 Inverter LITE",
    "商品型號:CW-SUL90BA\n品牌:PANASONIC 樂聲牌\n銷售價:6980\n描述:CW-SUL90BA 1.0匹 Inverter LITE",
    "商品型號:CW-SUL90BA\t品牌:PANASONIC 樂聲牌\t銷售價:6980\t描述:CW-SUL90BA 1.0匹 Inverter LITE",
    "商品型號:CW-SUL90BA | 品牌:PANASONIC 樂聲牌; 銷售價:6980 | 描述:CW-SUL90BA 1.0匹 Inverter LITE",
    "product model=CW-SUL90BA brand=PANASONIC 樂聲牌 selling price=6980 description=CW-SUL90BA 1.0匹 Inverter LITE",
    "商品型號:CW-SUL90BA品牌:PANASONIC 樂聲牌銷售價:6980描述:CW-SUL90BA 1.0匹 Inverter LITE",
  ];
  for (const variant of variants) {
    const source = { ...doc, chunks: [{ ...chunk, content: variant }],
      llm_context: { ...doc.llm_context, full_content_evidence: [{ ...doc.llm_context.full_content_evidence[0], content: variant }] } };
    const { resolved } = answer("有沒有 PANASONIC 樂聲 CW-SUL90BA", [source]);
    assert(resolved?.reply.includes("PANASONIC 樂聲牌 CW-SUL90BA") &&
      resolved.reply.includes("HK$6,980") && resolved.reply.includes("1.0匹") &&
      !/4620|4908|附加項目|selling price/.test(resolved.reply), `field_variant_failed: ${variant}; actual=${resolved?.reply}`);
  }
});

Deno.test("missing or malformed brand never guessed; next field cannot leak", () => {
  for (const variant of [
    "商品型號:CW-SUL90BA 銷售價:6980 描述:CW-SUL90BA 1.0匹",
    "商品型號:CW-SUL90BA 品牌 PANASONIC 樂聲牌 銷售價:6980 描述:CW-SUL90BA 1.0匹",
    "商品型號:CW-SUL90BA 品牌: 附加項目: 否 銷售價:6980 描述:CW-SUL90BA 1.0匹",
  ]) {
    const source = { ...doc, chunks: [{ ...chunk, content: variant }],
      llm_context: { ...doc.llm_context, full_content_evidence: [{ ...doc.llm_context.full_content_evidence[0], content: variant }] } };
    const { resolved } = answer("有沒有 CW-SUL90BA", [source]);
    assert(resolved && !/PANASONIC|附加項目|樂聲牌/.test(resolved.reply), `guessed_brand: ${variant}`);
  }
});

Deno.test("A2 price uses only explicit selling price, not cost or special price", () => {
  const { resolved, citation } = answer("CW-SUL90BA 售價幾多？");
  assert(resolved?.kind === "price" && resolved.reply.includes("HK$6,980"), "price_not_grounded");
  assert(!resolved.reply.includes("4620") && !resolved.reply.includes("4908"), "price_field_confusion");
  assert(citation?.citations[0].chunk_id === chunkId, "price_citation_missing");
  console.log("A2 reply:", resolved.reply);
  const missingPrice = { ...doc, chunks: [{ ...chunk, content: "商品型號:CW-SUL90BA" }],
    llm_context: { ...doc.llm_context, full_content_evidence: [{ ...doc.llm_context.full_content_evidence[0], content: "商品型號:CW-SUL90BA" }] } };
  const unknown = answer("CW-SUL90BA 售價幾多？", [missingPrice]);
  assert(unknown.resolved?.kind === "price_unknown" && unknown.resolved.reply.includes("冇可核實嘅售價") &&
    unknown.citation?.citations[0].chunk_id === chunkId, "invented_price_or_missing_lineage");
  const foreignCurrency = { ...doc,
    chunks: [{ ...chunk, content: content.replace("銷售價: 6980", "銷售價: SGD 6980") }],
    llm_context: { ...doc.llm_context, full_content_evidence: [{ ...doc.llm_context.full_content_evidence[0],
      content: content.replace("銷售價: 6980", "銷售價: SGD 6980") }] } };
  assert(answer("CW-SUL90BA 售價幾多？", [foreignCurrency]).resolved?.kind === "price_unknown", "currency_fabrication");
});

Deno.test("A3 nonexistent SKU stays honest UNKNOWN", () => {
  const result = answer("有沒有 NONEXISTENT-999999？", []);
  assert(result.resolved === null && result.citation === null, "fabricated_product");
  console.log("A3 reply:", renderBoundedNoCurrentEvidence("zh-TW"));
});

Deno.test("A4 paraphrased exact model uses the same canonical direct answer", () => {
  const result = answer("你哋有冇 CW-SUL90BA 呢款？");
  assert(result.resolved?.kind === "price" && result.citation?.citations[0].chunk_id === chunkId, "paraphrase_dead_end");
  console.log("A4 reply:", result.resolved.reply);
});

Deno.test("A5 tenant mismatch yields no answer and no lineage", () => {
  const result = answer("有沒有 PANASONIC 樂聲 CW-SUL90BA", [doc], "other-tenant");
  assert(result.resolved === null && result.citation === null, "cross_tenant_leak");
  console.log("A5 reply: none; tenant mismatch blocks direct answer");
});

Deno.test("Unsupported specification and policy never become direct facts", () => {
  assert(answer("CW-SUL90BA 嘅尺寸係幾多？").resolved === null, "invented_specification");
  assert(answer("CW-SUL90BA 嘅退貨政策係咩？").resolved === null, "invented_policy");
  const historical = { ...doc, authority: { ...doc.authority!, currentness: "historical" as const } };
  assert(answer("有沒有 PANASONIC 樂聲 CW-SUL90BA", [historical]).resolved === null, "historical_used_as_current");
});

Deno.test("selected A1/A2 Full Content and actual citation pass B2 without a Commerce quote", () => {
  for (const request of ["有沒有 PANASONIC 樂聲 CW-SUL90BA", "CW-SUL90BA 售價幾多？"]) {
    const { selection, resolved, citation } = answer(request);
    assert(selection.ok && resolved?.price_fact && citation, "grounded_price_missing");
    const fact = resolved.price_fact;
    const proof: B2KbPriceProof = { field: "selling_price", value: fact.value,
      currency: fact.currency, model: fact.model, document_id: fact.document_id,
      chunk_id: fact.chunk_id, tenant_id: "34",
      company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
      currentness: "current", authority_decision: "USE_CURRENT_KB",
      request, full_content: fact.full_content };
    const { request: _request, full_content: _content, company_id: _company, ...publicProof } = proof;
    const verdict = evaluateB2BeforeCommit({ proposed_response: resolved.reply,
      persistence_kind: "ai_reply", trusted_kb_price_proof: proof,
      snapshot: { conversation_id: "example-conversation", company_id: proof.company_id,
        source_message_id: "example-source", commerce_state_revision: 0,
        commerce_state_source_message_id: null, state: createEmptyConversationCommerceState() },
      metadata: { ...citation, response_route: "canonical_kb_direct_answer",
        answer_kind: resolved.kind, kb_fact_proof: publicProof,
        reference_authority: selection.authority_decision } });
    assert(verdict.decision === "allow" && verdict.code === "B2_ALLOW_CURRENT_KB_SELLING_PRICE", JSON.stringify(verdict));
    console.log("grounded B2:", request, verdict.code);
  }
});

Deno.test("Phase1 generic labelled facts survive unknown stock with exact source-bound handoff facts", () => {
  for (const [model, name, grams] of [["TEA-R21", "茉莉花茶", 200], ["SHIRT-X82", "棉質襯衣", 315]] as const) {
    const source = `商品型號: ${model} | 描述: ${name} | 重量: ${grams} g`;
    const fixture: KBDocumentCandidate = {...doc, title:`${name} ${model}`, authority:{...doc.authority!,entity_ids:[model]},
      chunks:[{...chunk,content:source,title:`${name} ${model}`}], llm_context:{...doc.llm_context,full_content_evidence:[{...doc.llm_context.full_content_evidence[0],content:source}]}};
    for (const question of [`${model} 嘅重量係幾多？有冇現貨？`, `${model} 的重量是多少？庫存有多少？`]) {
      const {resolved,selection} = answer(question,[fixture]);
      assert(resolved && resolved.reply.includes(`${grams} g`) && /庫存|库存/.test(resolved.reply), JSON.stringify({question,resolved,selection}));
      assert(resolved.structured_facts?.some(f=>f.field==='weight' && f.value===`${grams} g` && f.model===model && f.document_id===documentId && f.chunk_id===chunkId), "answered field lost before Summary");
      assert(resolved.unresolved_fact_fields?.includes("stock"), "mixed answer lost typed unresolved stock field");
      assert(!/已查|已安排|已落單|[?？]/.test(resolved.reply), "invented action or irrelevant missing field");
    }
    const changedSource=source.replace(`${grams} g`,`${grams+17} g`);
    const changed: KBDocumentCandidate = {...fixture,chunks:[{...fixture.chunks[0],content:changedSource}],llm_context:{...fixture.llm_context,full_content_evidence:[{...fixture.llm_context.full_content_evidence[0],content:changedSource}]}};
    assert(answer(`${model} 嘅重量係幾多？`,[changed]).resolved?.reply.includes(`${grams+17} g`),"answer ignored changed evidence");
    assert(answer(`${model} 嘅尺寸係幾多？`,[fixture]).resolved===null,"missing specification fabricated");
    const en = resolveCanonicalKbDirectAnswer({request:`${model} 嘅重量係幾多？`,selection:answer(`${model} 嘅重量係幾多？`,[fixture]).selection,language:'en'});
    assert(en?.reply.includes('weight') && !en.reply.includes('重量'),'internal localized field passed into English reply');
  }
});


Deno.test("Task1: authenticated published unknown-currentness product price is a bounded source reference, never a current quote", async () => {
  const {selection:unknown} = await serviceReference();
  assert(unknown.ok && unknown.document !== null && unknown.chunks.every(c=>c.status==="unknown"), "authenticated_reference_missing");
  const serviceWithUnknownChunkStatus = unknown;
  const publishedServiceReply = resolveCanonicalKbDirectAnswer({
    request:"CW-SUL90BA 售價幾多？",selection:serviceWithUnknownChunkStatus,language:"zh-TW"
  });
  assert(publishedServiceReply?.kind==="listed_price_unverified" &&
    publishedServiceReply.reply.includes("HK$6,980") &&
    !publishedServiceReply.price_fact,
    "actual_service_unknown_status_must_be_a_qualified_record_only");
  const noServiceAuthority = {...serviceWithUnknownChunkStatus,
    authority_decision:{...serviceWithUnknownChunkStatus.authority_decision,
      selected_authority_class:"HISTORICAL" as const}};
  assert(resolveCanonicalKbDirectAnswer({request:"CW-SUL90BA 售價幾多？",
    selection:noServiceAuthority,language:"zh-TW"})===null,
    "status_unknown_without_authenticated_service_must_be_denied");
  const selected = resolveCanonicalKbDirectAnswer({
    request:"CW-SUL90BA 售價幾多？",selection:unknown,language:"zh-TW"
  });
  assert(selected?.kind === "listed_price_unverified" && selected.reply.includes("HK$6,980"), "reference_price_missing");
  assert(!selected.price_fact && selected.evidence_chunks.length === 1 &&
    selected.evidence_chunks[0].document_id === documentId &&
    selected.evidence_chunks[0].chunk_id === chunkId, "reference_promoted_to_current_or_lineage_missing");
  assert(/未核實係現價/.test(selected.reply) && !/4620|4908/.test(selected.reply), "currentness_or_cost_leak");
  const target = deriveCurrentGroundingTarget("CW-SUL90BA 售價幾多？");
  const citation = buildCitationMetadata(selected.evidence_chunks,documentId,{
    authorityDecision:unknown.authority_decision,currentTarget:target});
  assert(citation?.citation_lineage.selected_document_id===documentId &&
    citation.citation_lineage.evidence_chunk_ids[0]===chunkId, "reference_citation_missing");
  const meta = { ...citation, reference_authority: unknown.authority_decision,
    response_route:"canonical_kb_direct_answer",answer_kind:selected.kind };
  const snapshot = { conversation_id:"example", company_id:"3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    source_message_id:"example-source",commerce_state_revision:0,
    commerce_state_source_message_id:null,state:createEmptyConversationCommerceState() };
  const b2 = evaluateB2BeforeCommit({ proposed_response:selected.reply,
    persistence_kind:"ai_reply",snapshot,metadata:meta });
  assert(b2.decision==="allow", "non-current_source_reference_B2:"+JSON.stringify(b2));
  const forgedCurrent = evaluateB2BeforeCommit({ proposed_response:"CW-SUL90BA 現時售價 HK$6,980 已確認。",
    persistence_kind:"ai_reply",snapshot,metadata:meta });
  assert(forgedCurrent.decision==="block", "B2_must_still_block_unverified_current_price");

  assert(resolveCanonicalKbDirectAnswer({request:"CW-SUL90BA 有冇現貨？",selection:unknown,language:"zh-TW"})===null,
    "unknown_currentness_must_not_authorize_stock");
  const historical={...unknown,authority_decision:{...unknown.authority_decision,
    selected_authority_class:"HISTORICAL" as const,
    provenance:{...unknown.authority_decision.provenance,currentness:"historical" as const}}};
  assert(resolveCanonicalKbDirectAnswer({request:"CW-SUL90BA 售價幾多？",selection:historical,language:"zh-TW"})===null,
    "historical_must_never_be_published_current_or_reference");
  const noPrice = "商品型號: CW-SUL90BA | 描述: CW-SUL90BA 已發布產品";
  const noPriceSelection = {...unknown,
    document:{...unknown.document,chunks:[{...chunk,content:noPrice}],
      llm_context:{...unknown.document.llm_context,full_content_evidence:[{...unknown.evidence[0],content:noPrice}]}},
    chunks:[{...chunk,content:noPrice}], evidence:[{...unknown.evidence[0],content:noPrice}]};
  const noQuote=resolveCanonicalKbDirectAnswer({request:"CW-SUL90BA 售價幾多？",
    selection:noPriceSelection,language:"zh-TW"});
  assert(noQuote?.kind==="price_unknown" && !/HK\$|\b6980\b/.test(noQuote.reply),
    "missing_price_must_not_fabricate");
});


Deno.test("Task1 cross-industry named product price is evidence-bound, with no invented model or B2 current quote", async () => {
  const customerName = "轻量冲锋衣";
  const fullContent = "商品名称: 轻量冲锋衣 | 销售价: HK$1,299 | 颜色: 海军蓝 | 备注: 来源记录";
  const named: KBDocumentCandidate = {
    ...doc, title: customerName, document_score: 0.03,
    chunks: [{ ...chunk, content: fullContent, score: 0.03, status: "unknown" }],
    llm_context: { ...doc.llm_context, full_content_evidence: [
      { ...doc.llm_context.full_content_evidence[0], content: fullContent, score: 0.03 },
    ] },
    authority: { ...doc.authority!, currentness: "unknown", entity_ids: [] },
  };
  const { response } = await bindRagApiResponse(Response.json({
    success: true, context_found: true,
    selected_documents: [{ document_id: documentId, title: customerName,
      source_type: "product", document_score: 0.03, authority: named.authority,
      evidence: named.chunks.map(({ status: _status, ...row }) => row) }],
    citations: [],
  }), ORIGINAL_RAG_ACTIVATION);
  bindRagServiceDocument(response, named);
  for (const item of named.chunks) bindRagServiceDocument(response, item);
  const request = "轻量冲锋衣 几钱？";
  const answerNamed = answer(request, [named]);
  assert(answerNamed.selection.ok && answerNamed.selection.document?.document_id === documentId &&
    answerNamed.resolved?.kind === "listed_price_unverified" &&
    answerNamed.resolved.reply.includes("HK$1,299") &&
    answerNamed.resolved.reply.includes("未核實係現價") &&
    !answerNamed.resolved.price_fact,
    "exact source-recorded name price must be a qualified reference");
  assert(answerNamed.citation?.citation_lineage.selected_document_id === documentId &&
    answerNamed.citation?.citation_lineage.evidence_chunk_ids.includes(chunkId),
    "named source citation lineage missing");
  const snapshot = { conversation_id:"example", company_id:"3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    source_message_id:"example", commerce_state_revision:0,
    commerce_state_source_message_id:null,state:createEmptyConversationCommerceState() };
  const allowed = evaluateB2BeforeCommit({
    proposed_response:answerNamed.resolved.reply,persistence_kind:"ai_reply",snapshot,
    metadata: { ...answerNamed.citation, response_route:"canonical_kb_direct_answer",
      answer_kind:"listed_price_unverified",reference_authority:answerNamed.selection.authority_decision },
  });
  assert(allowed.decision === "allow", "B2 rejected an explicitly noncurrent source record");
  const forged = evaluateB2BeforeCommit({proposed_response:"轻量冲锋衣 現時售價 HK$1,299 已確認。",
    persistence_kind:"ai_reply", snapshot,metadata:{ ...answerNamed.citation,answer_kind:"listed_price_unverified",
      reference_authority:answerNamed.selection.authority_decision }});
  assert(forged.decision === "block", "B2 accidentally allowed a name-only current price");
  for (const [name, contentValue] of [
    ["不同商品", fullContent], ["冲锋衣", fullContent],
    [customerName, fullContent.replace(customerName,"輕量外套")],
    [customerName, fullContent.replace("HK$1,299","USD 1,299")],
  ]) {
    const fixture = { ...named, title:name,
      chunks:named.chunks.map(c=>({...c,content:contentValue})),
      llm_context:{...named.llm_context,full_content_evidence:named.llm_context.full_content_evidence.map(e=>({...e,content:contentValue}))},
    };
    const observed = answer(request,[fixture]);
    if (name !== customerName || !contentValue.includes(customerName))
      assert(observed.resolved === null, "unrelated product identity accepted");
    else assert(observed.resolved?.kind === "price_unknown" && !/HK\$1,299/.test(observed.resolved.reply),
      "foreign-currency amount silently promoted to HKD");
  }
});
