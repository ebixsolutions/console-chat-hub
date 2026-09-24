import {
  deriveCurrentGroundingTarget,
  selectCanonicalGrounding,
} from "./canonical-grounding.ts";
import { resolveCanonicalKbDirectAnswer } from "./canonical-kb-direct-answer.ts";
import { buildCitationMetadata } from "./citation-lineage.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import {
  planConversationService,
  renderServicePlanReply,
} from "./conversation-service-planner.ts";
import {
  arbitrateAnaphoricProductFollowUp,
  classifyNaturalCustomerIntent,
  renderNaturalNoCurrentEvidence,
  requiresCurrentMerchantEvidence,
} from "./natural-customer-response.ts";
import {
  type B2KbPriceProof,
  evaluateB2BeforeCommit,
} from "./pre-send-conversion-supervisor.ts";
import type { KBDocumentCandidate } from "./deterministic-kb-client.ts";

const assert: (condition: unknown, detail: string) => asserts condition = (
  condition,
  detail,
) => {
  if (!condition) throw new Error(detail);
};

Deno.test("W9 multi-intent product facts retain every compatible facet", () => {
  const question =
    "細房我見到 CW-SUL70BA，佢有咩功能、係幾多匹？80呎用落夠唔夠？";
  const { intent, selection, answer, citation } = routeAndAnswer(question);
  assert(intent.kind === "product_factual_query", JSON.stringify(intent));
  assert(
    intent.facts.join(",") === "features,horsepower,suitability",
    JSON.stringify(intent.facts),
  );
  assert(selection.ok && answer && citation, "missing_grounded_composite");
  assert(
    answer.reply ===
      "現行產品資料列出 PANASONIC 樂聲牌 CW-SUL70BA：3/4匹Inverter LITE變頻式淨冷窗口機；功能：變頻 淨冷。 PANASONIC 樂聲牌 CW-SUL70BA 嘅匹數係 3/4匹。 產品資料售價為 HK$5,680。 現有產品資料未有直接列出適用面積，所以未能確認80呎房夠唔夠用；亦要睇日照等條件。",
    answer.reply,
  );
  assert(
    answer.price_fact?.value === 5680 &&
      answer.price_fact.model === "CW-SUL70BA",
    "price_proof_lost",
  );
  assert(
    citation.citation_lineage.selected_document_id === documentId &&
      citation.citation_lineage.evidence_chunk_ids[0] === chunkId,
    "lineage_lost",
  );
  assert(
    !/3750|4038|現貨|有貨|80呎房(?:適合|夠用。)/.test(answer.reply),
    `unsafe_composite:${answer.reply}`,
  );
  console.log(
    `W13-T6|published_kb_lookup|canonical_kb_direct_answer|${answer.reply}`,
  );
});

Deno.test("W9 multi-intent unsupported facets fail safe instead of disappearing", () => {
  const sparseContent = content
    .replace(
      "3/4匹Inverter LITE變頻式淨冷窗口機",
      "Inverter LITE變頻式淨冷窗口機",
    )
    .replace(" 匹數: 3/4匹", " 匹數: 未提供");
  const sparse = {
    ...document,
    chunks: [{ ...chunk, content: sparseContent }],
    llm_context: {
      ...document.llm_context,
      full_content_evidence: [{
        ...document.llm_context.full_content_evidence[0],
        content: sparseContent,
      }],
    },
  };
  const { answer } = routeAndAnswer(
    "CW-SUL70BA 有咩功能、幾多匹，同埋80呎適唔適合？",
    "zh-TW",
    [sparse],
  );
  assert(answer, "sparse_composite_missing");
  assert(
    /功能：變頻 淨冷/.test(answer.reply) &&
      /未有列出.*可核實匹數/.test(answer.reply) &&
      /未有直接列出適用面積/.test(answer.reply),
    answer.reply,
  );
  assert(!/3\/4匹/.test(answer.reply), `invented_horsepower:${answer.reply}`);
});

Deno.test("W15 T7 anaphoric current-price follow-up binds model, KB lineage and B2", () => {
  const customer = "咁呢部而家賣幾錢？";
  const arbitration = arbitrateAnaphoricProductFollowUp(customer, [{
    role: "visitor",
    content: "細房我見到 CW-SUL70BA，佢有咩功能、係幾多匹？80呎用落夠唔夠？",
  }]);
  assert(arbitration.kind === "resolved", JSON.stringify(arbitration));
  const { intent, selection, answer, citation } = routeAndAnswer(
    arbitration.grounded_question,
  );
  assert(
    intent.kind === "product_factual_query" &&
      intent.product === "CW-SUL70BA" && intent.fact === "price",
    JSON.stringify(intent),
  );
  assert(
    selection.ok && answer && citation && answer.price_fact,
    "T7:grounded_answer_missing",
  );
  assert(
    answer.reply ===
      "目前產品資料列出 CW-SUL70BA 售價為 HK$5,680；實際結帳價請再確認。",
    answer.reply,
  );
  const fact = answer.price_fact;
  const proof: B2KbPriceProof = {
    field: "selling_price",
    value: fact.value,
    currency: "HKD",
    model: fact.model,
    document_id: fact.document_id,
    chunk_id: fact.chunk_id,
    tenant_id: "34",
    company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    currentness: "current",
    authority_decision: "USE_CURRENT_KB",
    request: arbitration.grounded_question,
    full_content: fact.full_content,
  };
  const {
    request: _request,
    full_content: _content,
    company_id: _company,
    ...publicProof
  } = proof;
  const verdict = evaluateB2BeforeCommit({
    proposed_response: answer.reply,
    persistence_kind: "ai_reply",
    trusted_kb_price_proof: proof,
    snapshot: {
      conversation_id: "fixture-conversation",
      company_id: proof.company_id,
      source_message_id: "fixture-source",
      commerce_state_revision: 5,
      commerce_state_source_message_id: "fixture-quantity-turn",
      state: createEmptyConversationCommerceState(),
    },
    metadata: {
      ...citation,
      response_route: "canonical_kb_direct_answer",
      answer_kind: answer.kind,
      kb_fact_proof: publicProof,
      reference_authority: selection.authority_decision,
    },
  });
  assert(
    verdict.decision === "allow" &&
      verdict.code === "B2_ALLOW_CURRENT_KB_SELLING_PRICE",
    JSON.stringify(verdict),
  );
  console.log(
    `W15-T7|CURRENT_KB_REQUIRED|canonical_kb_direct_answer|${verdict.code}|${answer.reply}`,
  );
});

// Full Content displayed by the tenant-scoped Knowledge panel for this model.
// IDs below are fixture IDs: the test proves citation binding, not a live chunk ID.
const content =
  "工作表：商品設定_20260813 162932 ID: 7944 狀態: 開啟 商品型號: CW-SUL70BA 商品圖片: 39 成本: 3750 銷售價: 5680 特價: 4038 匹數 (多聯分體式): 29 品牌: PANASONIC 樂聲牌 附加項目: 否 新增日期: 46247 標籤: 32 描述: PANASONIC 樂聲 CW-SUL70BA 3/4匹Inverter LITE變頻式淨冷窗口機，採用香港專利左出風設計、R32製冷劑及四合一抗菌過濾網，製冷能力7,400BTU/h，設左右自動送風、睡眠模式及獨立抽濕，獲香港1級能源標籤，提供3年全機及5年壓縮機保用。 功能: 變頻 淨冷 匹數: 3/4匹 氣體: 36 風數: 42";
const documentId = "fixture-cw-sul70ba-document";
const chunkId = "fixture-cw-sul70ba-chunk";
const chunk: KBDocumentCandidate["chunks"][number] = {
  document_id: documentId,
  doc_id: documentId,
  chunk_id: chunkId,
  content,
  title: "PANASONIC 樂聲 CW-SUL70BA",
  score: 0.99,
  chunk_type: "full_content",
  source_type: "product",
  status: "published",
};
const document: KBDocumentCandidate = {
  document_id: documentId,
  title: "PANASONIC 樂聲 CW-SUL70BA",
  source_type: "product",
  document_score: 0.99,
  chunks: [chunk],
  citations: [],
  meta: {
    document_score: 0.99,
    highest_chunk_score: 0.99,
    second_highest_chunk_score: 0,
    returned_summary_count: 0,
    returned_full_content_count: 1,
    dropped_without_document_id: 0,
    dropped_without_content: 0,
  },
  llm_context: {
    selected_document_id: documentId,
    orientation_summary: null,
    full_content_evidence: [{
      document_id: documentId,
      chunk_id: chunkId,
      content,
      score: 0.99,
      source_type: "product",
    }],
  },
  authority: {
    tenant_id: "34",
    publication_state: "published",
    currentness: "current",
    entity_ids: ["CW-SUL70BA"],
    regions: ["hong_kong"],
    language: null,
    version: null,
    version_rank: null,
    updated_at: null,
    source_priority: null,
    claims: [],
  },
};

function routeAndAnswer(
  question: string,
  language: "zh-TW" | "en" = "zh-TW",
  documents: KBDocumentCandidate[] = [document],
) {
  const intent = classifyNaturalCustomerIntent(question);
  const recall = {
    handled: false,
    reason: "CURRENT_KB_REQUIRED" as const,
    detail: "EXACT_PRODUCT_FACT_QUERY",
  };
  const plan = planConversationService({
    question,
    language,
    recall,
    memory: null,
    commerce: null,
  });
  const target = deriveCurrentGroundingTarget(question);
  const selection = selectCanonicalGrounding(documents, {
    minScore: 0.45,
    requirePublished: true,
    requestText: question,
    currentTurnText: question,
    expectedTenantId: "34",
    expectedEntityIds: target.entity_ids,
    expectedTopicIds: target.topic_ids,
    requiresCurrentKb: true,
  });
  const answer = resolveCanonicalKbDirectAnswer({
    request: question,
    selection,
    language,
  });
  const citation = answer && selection.ok
    ? buildCitationMetadata(
      answer.evidence_chunks,
      selection.document?.document_id ?? null,
      {
        authorityDecision: selection.authority_decision,
        currentTarget: target,
      },
    )
    : null;
  return { intent, plan, selection, answer, citation };
}

for (
  const [id, question, language] of [
    ["P1", "PANASONIC 樂聲 CW-SUL70BA 功能 80呎房夠用嗎？", "zh-TW"],
    ["P2", "CW-SUL70BA 有咩功能？", "zh-TW"],
    ["P3", "CW-SUL70BA 係幾多匹？", "zh-TW"],
    ["P4", "Is CW-SUL70BA suitable for an 80 sq ft room?", "en"],
  ] as const
) {
  Deno.test(`${id} exact factual product routes to current KB and grounded answer`, async () => {
    const { intent, plan, selection, answer, citation } = routeAndAnswer(
      question,
      language,
    );
    assert(
      intent.kind === "product_factual_query" &&
        requiresCurrentMerchantEvidence(intent),
      `${id}:intent:${JSON.stringify(intent)}`,
    );
    assert(
      plan.action === "published_kb_lookup" &&
        plan.knowledge_state === "lookup_required",
      `${id}:route:${plan.action}`,
    );
    assert(selection.ok && answer && citation, `${id}:grounded_answer_missing`);
    assert(
      answer.reply.includes("CW-SUL70BA") &&
        answer.reply.includes(language === "en" ? "3/4 HP" : "3/4匹"),
      `${id}:known_facts:${answer.reply}`,
    );
    if (id === "P4") {
      assert(
        answer.reply.startsWith("PANASONIC CW-SUL70BA") &&
          !/[\p{Script=Han}]/u.test(answer.reply),
        `P4:english_brand:${answer.reply}`,
      );
    }
    if (id === "P2") {
      assert(
        answer.reply.includes("功能：變頻 淨冷"),
        `P2:features:${answer.reply}`,
      );
    }
    assert(
      citation.citation_lineage.selected_document_id === documentId &&
        citation.citation_lineage.evidence_chunk_ids[0] === chunkId,
      `${id}:citation`,
    );
    assert(
      !/(?:3750|4038|有現貨|in stock|80呎房夠用。|suitable for an 80 sq ft room\.)/i
        .test(answer.reply),
      `${id}:unsafe_claim:${answer.reply}`,
    );
    if (id === "P1" || id === "P4") {
      assert(
        answer.reply.includes("5,680") &&
          /未有直接列出適用面積|does not directly state a suitable room area/i
            .test(answer.reply),
        `${id}:partial_answer:${answer.reply}`,
      );
      const fact = answer.price_fact;
      assert(fact?.value === 5680, `${id}:price_fact`);
      const proof: B2KbPriceProof = {
        field: "selling_price",
        value: fact.value,
        currency: "HKD",
        model: fact.model,
        document_id: fact.document_id,
        chunk_id: fact.chunk_id,
        tenant_id: "34",
        company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
        currentness: "current",
        authority_decision: "USE_CURRENT_KB",
        request: question,
        full_content: fact.full_content,
      };
      const {
        request: _request,
        full_content: _content,
        company_id: _company,
        ...publicProof
      } = proof;
      const verdict = evaluateB2BeforeCommit({
        proposed_response: answer.reply,
        persistence_kind: "ai_reply",
        trusted_kb_price_proof: proof,
        snapshot: {
          conversation_id: "fixture-conversation",
          company_id: proof.company_id,
          source_message_id: "fixture-source",
          commerce_state_revision: 0,
          commerce_state_source_message_id: null,
          state: createEmptyConversationCommerceState(),
        },
        metadata: {
          ...citation,
          response_route: "canonical_kb_direct_answer",
          answer_kind: answer.kind,
          kb_fact_proof: publicProof,
          reference_authority: selection.authority_decision,
        },
      });
      assert(
        verdict.decision === "allow" &&
          verdict.code === "B2_ALLOW_CURRENT_KB_SELLING_PRICE",
        `${id}:B2:${JSON.stringify(verdict)}`,
      );
    }
    console.log(
      `${id}|${plan.action}|canonical_kb_direct_answer|${answer.reply}`,
    );
  });
}

for (
  const [id, question, language] of [
    ["E1", "Is CW-SUL70BA suitable for an 80 sq ft room?", "en"],
    ["E2", "What features does CW-SUL70BA have?", "en"],
    ["E3", "What horsepower is CW-SUL70BA?", "en"],
    ["E4", "CW-SUL70BA 有咩功能？", "zh-TW"],
    ["E5", "CW-SUL70BA suitable for 80呎嗎？", "zh-TW"],
    ["E6", "Is CW-SUL70BA suitable for an 80 sq ft room?", "en"],
  ] as const
) {
  Deno.test(`${id} evidence-preserving customer-language rendering`, () => {
    const { answer, citation } = routeAndAnswer(question, language);
    assert(answer && citation, `${id}:missing_grounded_answer`);
    assert(answer.reply.includes("CW-SUL70BA"), `${id}:model_changed`);
    if (language === "en") {
      assert(
        !/[\p{Script=Han}]/u.test(answer.reply),
        `${id}:mixed_description:${answer.reply}`,
      );
      assert(
        answer.reply.includes("PANASONIC CW-SUL70BA"),
        `${id}:canonical_brand:${answer.reply}`,
      );
      assert(
        answer.reply.includes("3/4 HP") &&
          (id === "E3" || answer.reply.includes("Inverter LITE")),
        `${id}:fact_lost:${answer.reply}`,
      );
    }
    if (id === "E1" || id === "E5" || id === "E6") {
      assert(
        /does not directly state a suitable room area|未有直接列出適用面積/u
          .test(answer.reply) &&
          answer.reply.includes(language === "en" ? "80 sq ft" : "80呎") &&
          answer.reply.includes("HK$5,680"),
        `${id}:unknown_or_number_changed:${answer.reply}`,
      );
    }
    if (id === "E2") {
      assert(
        /cooling-only|inverter/iu.test(answer.reply),
        `${id}:features_missing`,
      );
    }
    if (id === "E4") {
      assert(answer.reply.includes("功能：變頻 淨冷"), `${id}:zh_regression`);
    }
    assert(
      citation.citation_lineage.evidence_chunk_ids[0] === chunkId,
      `${id}:lineage`,
    );
    console.log(`${id}|canonical_kb_direct_answer|${answer.reply}`);
  });
}

Deno.test("English brand identity keeps only grounded Latin prefix across brands", () => {
  for (
    const [field, expected] of [
      ["PANASONIC 樂聲牌", "PANASONIC CW-SUL70BA"],
      ["ACME 未知地區別名", "ACME CW-SUL70BA"],
      ["未知地區別名", "CW-SUL70BA"],
      ["ACME & SONS 本地名稱", "ACME & SONS CW-SUL70BA"],
    ] as const
  ) {
    const variant = content.replace("品牌: PANASONIC 樂聲牌", `品牌: ${field}`);
    const source = {
      ...document,
      chunks: [{ ...chunk, content: variant }],
      llm_context: {
        ...document.llm_context,
        full_content_evidence: [{
          ...document.llm_context.full_content_evidence[0],
          content: variant,
        }],
      },
    };
    const english = routeAndAnswer(
      "Is CW-SUL70BA suitable for an 80 sq ft room?",
      "en",
      [source],
    );
    const chinese = routeAndAnswer("CW-SUL70BA 適合80呎嗎？", "zh-TW", [
      source,
    ]);
    assert(
      english.answer?.reply.startsWith(expected) &&
        !/[\p{Script=Han}]/u.test(english.answer.reply) &&
        english.answer.reply.includes("3/4 HP") &&
        english.answer.reply.includes("HK$5,680") &&
        english.answer.reply.includes("80 sq ft") &&
        english.citation?.citation_lineage.evidence_chunk_ids[0] === chunkId,
      `english_brand_or_evidence:${field}:${english.answer?.reply}`,
    );
    assert(
      chinese.answer?.reply.startsWith(`${field} CW-SUL70BA`) &&
        chinese.answer.reply.includes("3/4匹") &&
        chinese.answer.reply.includes("HK$5,680"),
      `chinese_brand_changed:${field}:${chinese.answer?.reply}`,
    );
  }
});

Deno.test("E7/E8 variant descriptions are bounded by evidence and cannot promote internal prices", () => {
  const variant = content.replaceAll("CW-SUL70BA", "ZX-AB12345")
    .replaceAll("PANASONIC 樂聲", "ACME")
    .replaceAll("3/4匹", "1.5匹").replace("5680", "7290");
  const replacement = {
    ...document,
    title: "ACME ZX-AB12345",
    chunks: [{ ...chunk, title: "ACME ZX-AB12345", content: variant }],
    llm_context: {
      ...document.llm_context,
      full_content_evidence: [{
        ...document.llm_context.full_content_evidence[0],
        content: variant,
      }],
    },
    authority: { ...document.authority!, entity_ids: ["ZX-AB12345"] },
  };
  const alt = routeAndAnswer(
    "Is ZX-AB12345 suitable for an 80 sq ft room?",
    "en",
    [replacement],
  );
  assert(
    alt.answer?.reply.includes("1.5 HP") &&
      alt.answer.reply.includes("HK$7,290") &&
      alt.answer.reply.includes("80 sq ft") &&
      !/3750|4038|變頻|淨冷|窗口機/.test(alt.answer.reply),
    `E7:numeric_or_language_change:${alt.answer?.reply}`,
  );
  const unknownDescription = variant.replace(
    "1.5匹Inverter LITE變頻式淨冷窗口機",
    "1.5匹未識別技術",
  );
  const unknown = {
    ...replacement,
    chunks: [{ ...replacement.chunks[0], content: unknownDescription }],
    llm_context: {
      ...replacement.llm_context,
      full_content_evidence: [{
        ...replacement.llm_context.full_content_evidence[0],
        content: unknownDescription,
      }],
    },
  };
  const bounded = routeAndAnswer(
    "Is ZX-AB12345 suitable for an 80 sq ft room?",
    "en",
    [unknown],
  );
  assert(
    bounded.answer?.reply.includes("80 sq ft") &&
      !/1.5 HP|未識別|技術|3750|4038/.test(bounded.answer.reply),
    `E8:unverified_translation:${bounded.answer?.reply}`,
  );
  console.log(`E7|${alt.answer?.reply}`);
  console.log(`E8|${bounded.answer?.reply}`);
});

Deno.test("P5 actual product malfunction remains a support case", () => {
  const question = "CW-SUL70BA 開唔到機，點處理？";
  const intent = classifyNaturalCustomerIntent(question);
  const plan = planConversationService({
    question,
    language: "zh-TW",
    recall: { handled: false, reason: "NOT_A_RECALL_QUERY" },
    memory: null,
    commerce: null,
  });
  assert(
    intent.kind === "none" && !requiresCurrentMerchantEvidence(intent),
    `P5:intent:${JSON.stringify(intent)}`,
  );
  assert(
    plan.action === "customer_issue_next_step" &&
      plan.issue_kind === "product_operation_failure",
    `P5:${JSON.stringify(plan)}`,
  );
  const reply = renderServicePlanReply(plan, null);
  assert(
    reply?.includes("CW-SUL70BA") && reply.includes("開唔到機") &&
      /燈號|錯誤提示/.test(reply) &&
      !/賣家|交付內容|訂單|提供.*型號|已完成|已確認/.test(reply),
    `P5:reply:${reply}`,
  );
  console.log(`P5|${plan.action}|${plan.issue_kind}|${reply}`);
});

Deno.test("operating failure remains a shared symptom clarification without a model re-ask", () => {
  for (
    const [question, language, model] of [
      ["ABC-12345 won't turn on. What should I do?", "en", "ABC-12345"],
      ["ABC-12345 无法开机，怎么办？", "zh-CN", "ABC-12345"],
      ["部機開唔到機，點處理？", "zh-TW", null],
    ] as const
  ) {
    const plan = planConversationService({
      question,
      language,
      recall: { handled: false, reason: "NOT_A_RECALL_QUERY" },
      memory: null,
      commerce: null,
    });
    const reply = renderServicePlanReply(plan, null) ?? "";
    assert(
      plan.issue_kind === "product_operation_failure" &&
        (model === null || reply.includes(model)) &&
        !/product model|提供.*型號|交付內容|third-party seller/.test(reply),
      `${question}:${reply}`,
    );
  }
});

Deno.test("P6 nonexistent exact model gets honest unknown without a model re-ask", () => {
  const question = "NONEXISTENT-999999 有咩功能？";
  const { intent, plan, selection, answer } = routeAndAnswer(
    question,
    "zh-TW",
    [],
  );
  assert(
    intent.kind === "product_factual_query" &&
      plan.action === "published_kb_lookup",
    `P6:route:${JSON.stringify(intent)}`,
  );
  assert(
    selection.ok && selection.document === null &&
      selection.evidence.length === 0 && answer === null,
    "P6:invented_evidence",
  );
  const reply = renderNaturalNoCurrentEvidence(intent, "zh-TW") ?? "";
  assert(
    reply.includes("NONEXISTENT-999999") && /搵唔到|唔會估/.test(reply),
    `P6:unknown:${reply}`,
  );
  assert(
    !/請提供型號|指定型號|你有型號|現貨|售價/.test(reply),
    `P6:reask:${reply}`,
  );
  console.log(`P6|published_kb_lookup|kb_no_current_evidence|${reply}`);
});

Deno.test("product-factual route bypasses the generic memory and clarification shortcuts", async () => {
  const source = await Deno.readTextFile(
    new URL("../generate-reply/index.ts", import.meta.url),
  );
  assert(
    /_effectiveNaturalCustomerIntent\.kind === "product_factual_query"\s*\|\|\s*!_c3Recall\.decision\.handled/
      .test(
        source,
      ),
    "recall_preempted",
  );
  assert(
    /const _conversationMemoryReply =\s*!requiresCurrentMerchantEvidence\(\s*_effectiveNaturalCustomerIntent,?\s*\)/
      .test(
        source,
      ),
    "memory_preempted",
  );
  assert(
    /!requiresCurrentMerchantEvidence\(\s*_effectiveNaturalCustomerIntent,?\s*\)\s*&&\s*_turnClassification\.should_clarify_before_kb/
      .test(
        source,
      ),
    "generic_clarification_preempted",
  );
});
