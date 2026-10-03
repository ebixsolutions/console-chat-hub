import { deriveCurrentGroundingTarget, selectCanonicalGrounding } from "./canonical-grounding.ts";
import { resolveCanonicalKbDirectAnswer } from "./canonical-kb-direct-answer.ts";
import { buildCitationMetadata } from "./citation-lineage.ts";
import type { KBDocumentCandidate } from "./deterministic-kb-client.ts";
import { renderBoundedNoCurrentEvidence } from "./current-fact-evidence.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { evaluateB2BeforeCommit, type B2KbPriceProof } from "./pre-send-conversion-supervisor.ts";

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
