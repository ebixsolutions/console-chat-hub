import { deriveCurrentGroundingTarget, selectCanonicalGrounding } from "./canonical-grounding.ts";
import { resolveCanonicalKbDirectAnswer } from "./canonical-kb-direct-answer.ts";
import { buildCitationMetadata } from "./citation-lineage.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { planConversationService, renderServicePlanReply } from "./conversation-service-planner.ts";
import {
  classifyNaturalCustomerIntent, renderNaturalNoCurrentEvidence,
  requiresCurrentMerchantEvidence,
} from "./natural-customer-response.ts";
import { evaluateB2BeforeCommit, type B2KbPriceProof } from "./pre-send-conversion-supervisor.ts";
import type { KBDocumentCandidate } from "./deterministic-kb-client.ts";

const assert = (condition: unknown, detail: string): asserts condition => {
  if (!condition) throw new Error(detail);
};

// Full Content displayed by the tenant-scoped Knowledge panel for this model.
// IDs below are fixture IDs: the test proves citation binding, not a live chunk ID.
const content = "工作表：商品設定_20260813 162932 ID: 7944 狀態: 開啟 商品型號: CW-SUL70BA 商品圖片: 39 成本: 3750 銷售價: 5680 特價: 4038 匹數 (多聯分體式): 29 品牌: PANASONIC 樂聲牌 附加項目: 否 新增日期: 46247 標籤: 32 描述: PANASONIC 樂聲 CW-SUL70BA 3/4匹Inverter LITE變頻式淨冷窗口機，採用香港專利左出風設計、R32製冷劑及四合一抗菌過濾網，製冷能力7,400BTU/h，設左右自動送風、睡眠模式及獨立抽濕，獲香港1級能源標籤，提供3年全機及5年壓縮機保用。 功能: 變頻 淨冷 匹數: 3/4匹 氣體: 36 風數: 42";
const documentId = "fixture-cw-sul70ba-document";
const chunkId = "fixture-cw-sul70ba-chunk";
const chunk: KBDocumentCandidate["chunks"][number] = {
  document_id: documentId, doc_id: documentId, chunk_id: chunkId,
  content, title: "PANASONIC 樂聲 CW-SUL70BA", score: 0.99,
  chunk_type: "full_content", source_type: "product", status: "published",
};
const document: KBDocumentCandidate = {
  document_id: documentId, title: "PANASONIC 樂聲 CW-SUL70BA", source_type: "product", document_score: 0.99,
  chunks: [chunk], citations: [], meta: {
    document_score: 0.99, highest_chunk_score: 0.99, second_highest_chunk_score: 0,
    returned_summary_count: 0, returned_full_content_count: 1,
    dropped_without_document_id: 0, dropped_without_content: 0,
  },
  llm_context: { selected_document_id: documentId, orientation_summary: null,
    full_content_evidence: [{ document_id: documentId, chunk_id: chunkId, content, score: 0.99, source_type: "product" }] },
  authority: { tenant_id: "34", publication_state: "published", currentness: "current", entity_ids: ["CW-SUL70BA"],
    regions: ["hong_kong"], language: null, version: null, version_rank: null, updated_at: null, source_priority: null, claims: [] },
};

function routeAndAnswer(question: string, language: "zh-TW" | "en" = "zh-TW", documents: KBDocumentCandidate[] = [document]) {
  const intent = classifyNaturalCustomerIntent(question);
  const recall = { handled: false, reason: "CURRENT_KB_REQUIRED" as const, detail: "EXACT_PRODUCT_FACT_QUERY" };
  const plan = planConversationService({ question, language, recall, memory: null, commerce: null });
  const target = deriveCurrentGroundingTarget(question);
  const selection = selectCanonicalGrounding(documents, {
    minScore: 0.45, requirePublished: true, requestText: question,
    currentTurnText: question, expectedTenantId: "34",
    expectedEntityIds: target.entity_ids, expectedTopicIds: target.topic_ids,
    requiresCurrentKb: true,
  });
  const answer = resolveCanonicalKbDirectAnswer({ request: question, selection, language });
  const citation = answer && selection.ok ? buildCitationMetadata(answer.evidence_chunks, selection.document?.document_id ?? null,
    { authorityDecision: selection.authority_decision, currentTarget: target }) : null;
  return { intent, plan, selection, answer, citation };
}

for (const [id, question, language] of [
  ["P1", "PANASONIC 樂聲 CW-SUL70BA 功能 80呎房夠用嗎？", "zh-TW"],
  ["P2", "CW-SUL70BA 有咩功能？", "zh-TW"],
  ["P3", "CW-SUL70BA 係幾多匹？", "zh-TW"],
  ["P4", "Is CW-SUL70BA suitable for an 80 sq ft room?", "en"],
] as const) {
  Deno.test(`${id} exact factual product routes to current KB and grounded answer`, async () => {
    const { intent, plan, selection, answer, citation } = routeAndAnswer(question, language);
    assert(intent.kind === "product_factual_query" && requiresCurrentMerchantEvidence(intent), `${id}:intent:${JSON.stringify(intent)}`);
    assert(plan.action === "published_kb_lookup" && plan.knowledge_state === "lookup_required", `${id}:route:${plan.action}`);
    assert(selection.ok && answer && citation, `${id}:grounded_answer_missing`);
    assert(answer.reply.includes("CW-SUL70BA") && answer.reply.includes("3/4匹"), `${id}:known_facts:${answer.reply}`);
    if (id === "P2") assert(answer.reply.includes("功能：變頻 淨冷"), `P2:features:${answer.reply}`);
    assert(citation.citation_lineage.selected_document_id === documentId &&
      citation.citation_lineage.evidence_chunk_ids[0] === chunkId, `${id}:citation`);
    assert(!/(?:3750|4038|有現貨|in stock|80呎房夠用。|suitable for an 80 sq ft room\.)/i.test(answer.reply), `${id}:unsafe_claim:${answer.reply}`);
    if (id === "P1" || id === "P4") {
      assert(answer.reply.includes("5,680") && /未有直接列出適用面積|does not directly state a suitable room area/i.test(answer.reply), `${id}:partial_answer:${answer.reply}`);
      const fact = answer.price_fact;
      assert(fact?.value === 5680, `${id}:price_fact`);
      const proof: B2KbPriceProof = { field: "selling_price", value: fact.value, currency: "HKD", model: fact.model,
        document_id: fact.document_id, chunk_id: fact.chunk_id, tenant_id: "34",
        company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493", currentness: "current",
        authority_decision: "USE_CURRENT_KB", request: question, full_content: fact.full_content };
      const { request: _request, full_content: _content, company_id: _company, ...publicProof } = proof;
      const verdict = evaluateB2BeforeCommit({ proposed_response: answer.reply,
        persistence_kind: "ai_reply", trusted_kb_price_proof: proof,
        snapshot: { conversation_id: "fixture-conversation", company_id: proof.company_id,
          source_message_id: "fixture-source", commerce_state_revision: 0,
          commerce_state_source_message_id: null, state: createEmptyConversationCommerceState() },
        metadata: { ...citation, response_route: "canonical_kb_direct_answer",
          answer_kind: answer.kind, kb_fact_proof: publicProof,
          reference_authority: selection.authority_decision } });
      assert(verdict.decision === "allow" && verdict.code === "B2_ALLOW_CURRENT_KB_SELLING_PRICE", `${id}:B2:${JSON.stringify(verdict)}`);
    }
    console.log(`${id}|${plan.action}|canonical_kb_direct_answer|${answer.reply}`);
  });
}

Deno.test("P5 actual product malfunction remains a support case", () => {
  const question = "CW-SUL70BA 開唔到機，點處理？";
  const intent = classifyNaturalCustomerIntent(question);
  const plan = planConversationService({ question, language: "zh-TW",
    recall: { handled: false, reason: "NOT_A_RECALL_QUERY" }, memory: null, commerce: null });
  assert(intent.kind === "none" && !requiresCurrentMerchantEvidence(intent), `P5:intent:${JSON.stringify(intent)}`);
  assert(plan.action === "customer_issue_next_step" && plan.issue_kind === "marketplace_or_product_support", `P5:${JSON.stringify(plan)}`);
  const reply = renderServicePlanReply(plan, null);
  assert(reply && !/已完成|已確認訂單/.test(reply), `P5:reply:${reply}`);
  console.log(`P5|${plan.action}|${plan.issue_kind}|${reply}`);
});

Deno.test("P6 nonexistent exact model gets honest unknown without a model re-ask", () => {
  const question = "NONEXISTENT-999999 有咩功能？";
  const { intent, plan, selection, answer } = routeAndAnswer(question, "zh-TW", []);
  assert(intent.kind === "product_factual_query" && plan.action === "published_kb_lookup", `P6:route:${JSON.stringify(intent)}`);
  assert(selection.document === null && selection.evidence.length === 0 && answer === null, "P6:invented_evidence");
  const reply = renderNaturalNoCurrentEvidence(intent, "zh-TW") ?? "";
  assert(reply.includes("NONEXISTENT-999999") && /搵唔到|唔會估/.test(reply), `P6:unknown:${reply}`);
  assert(!/請提供型號|指定型號|你有型號|現貨|售價/.test(reply), `P6:reask:${reply}`);
  console.log(`P6|published_kb_lookup|kb_no_current_evidence|${reply}`);
});

Deno.test("product-factual route bypasses the generic memory and clarification shortcuts", async () => {
  const source = await Deno.readTextFile(new URL("../generate-reply/index.ts", import.meta.url));
  assert(source.includes('(_naturalCustomerIntent.kind === "product_factual_query" || !_c3Recall.decision.handled)'), "recall_preempted");
  assert(source.includes('const _conversationMemoryReply = !requiresCurrentMerchantEvidence(_naturalCustomerIntent)'), "memory_preempted");
  assert(source.includes('!requiresCurrentMerchantEvidence(_naturalCustomerIntent) &&\n    _turnClassification.should_clarify_before_kb'), "generic_clarification_preempted");
});
