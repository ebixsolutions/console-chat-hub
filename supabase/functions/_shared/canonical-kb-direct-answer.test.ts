import { deriveCurrentGroundingTarget, selectCanonicalGrounding } from "./canonical-grounding.ts";
import { resolveCanonicalKbDirectAnswer } from "./canonical-kb-direct-answer.ts";
import { buildCitationMetadata } from "./citation-lineage.ts";
import type { KBDocumentCandidate } from "./deterministic-kb-client.ts";
import { renderBoundedNoCurrentEvidence } from "./current-fact-evidence.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const documentId = "4f446f53b7cf4dd58a85a84f4d39c39e";
const chunkId = "17d99f7de3dd43d6ae431ed0c128d0f0";
const content = "商品型號:CW-SUL90BA 商品圖片:28 成本:4620 銷售價:6980 特價:4908 品牌:PANASONIC 樂聲牌 描述:PANASONIC 樂聲 CW-SUL90BA 1.0匹Inverter LITE";
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
    regions: [], language: null, version: null, version_rank: null, updated_at: null, source_priority: null, claims: [] },
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
  assert(selection.ok && resolved?.kind === "product_record", "known_answer_dead_end");
  assert(resolved.reply.includes("產品資料") && resolved.reply.includes("未能確認即時庫存"), "stock_or_answer_error");
  assert(!/請提供|訂單編號/.test(resolved.reply), "unnecessary_reask");
  assert(citation?.citation_lineage.selected_document_id === documentId &&
    citation.citation_lineage.evidence_chunk_ids[0] === chunkId, "citation_lineage_missing");
  console.log("A1 reply:", resolved.reply, "lineage:", JSON.stringify(citation?.citation_lineage));
});

Deno.test("A2 price uses only explicit selling price, not cost or special price", () => {
  const { resolved, citation } = answer("CW-SUL90BA 售價幾多？");
  assert(resolved?.kind === "price" && resolved.reply.includes("6980"), "price_not_grounded");
  assert(!resolved.reply.includes("4620") && !resolved.reply.includes("4908"), "price_field_confusion");
  assert(citation?.citations[0].chunk_id === chunkId, "price_citation_missing");
  console.log("A2 reply:", resolved.reply);
  const missingPrice = { ...doc, chunks: [{ ...chunk, content: "商品型號:CW-SUL90BA" }],
    llm_context: { ...doc.llm_context, full_content_evidence: [{ ...doc.llm_context.full_content_evidence[0], content: "商品型號:CW-SUL90BA" }] } };
  const unknown = answer("CW-SUL90BA 售價幾多？", [missingPrice]);
  assert(unknown.resolved?.kind === "price_unknown" && unknown.resolved.reply.includes("冇可核實嘅售價") &&
    unknown.citation?.citations[0].chunk_id === chunkId, "invented_price_or_missing_lineage");
});

Deno.test("A3 nonexistent SKU stays honest UNKNOWN", () => {
  const result = answer("有沒有 NONEXISTENT-999999？", []);
  assert(result.resolved === null && result.citation === null, "fabricated_product");
  console.log("A3 reply:", renderBoundedNoCurrentEvidence("zh-TW"));
});

Deno.test("A4 paraphrased exact model uses the same canonical direct answer", () => {
  const result = answer("你哋有冇 CW-SUL90BA 呢款？");
  assert(result.resolved?.kind === "product_record" && result.citation?.citations[0].chunk_id === chunkId, "paraphrase_dead_end");
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
