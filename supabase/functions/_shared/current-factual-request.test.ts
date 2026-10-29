import { resolveCurrentFactualRequest, type FactualRequestHistoryRow } from "./current-factual-request.ts";
import { scopedServiceKnowledgeQuery } from "./service-semantic-routing.ts";
import { buildCanonicalRetrievalQuery } from "./conversation-runtime-state-core.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { DecisionContextLimitError } from "./bounded-decision-context.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function equal(actual: unknown, expected: unknown, message = "values differ") {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
function frame(facts = ["price"], topic: string | null = "unrelated prior topic"): CommerceSemanticFrame {
  return {version: "commerce-semantic-1.0.0", language: "zh-TW", operation: "ASK_FACT", intent: "ask_product_facts", topic,
    entities: [], referents: [], customer_correction: false, additive: false, explicit_negations: [], requested_facts: facts,
    transaction_state: "none", payment_state: "none", booking_state: "none", fulfillment_state: "none",
    ambiguity: {is_ambiguous: false, reasons: [], clarification_question: null}, confidence: .9};
}
const previous: FactualRequestHistoryRow[] = [
  {role: "assistant", content: "Source record has features and a prior recorded price of 9999.", metadata: {response_route: "canonical_kb_direct_answer"}},
  {id: "old-customer-source", role: "visitor", content: "AX-QZ81 有咩功能？"},
  {role: "visitor", content: "BR-998 庫存是多少？"},
];

for (const [question, facet] of [["幾錢？", "price"], ["几钱？", "price"], ["How much?", "price"],
  ["有冇貨？", "stock"], ["有貨嗎？", "stock"], ["In stock?", "stock"],
  ["功能呢？", "features"], ["Features?", "features"]]) {
  Deno.test(`current request inherits one recent subject for ${question}`, () => {
    const result = resolveCurrentFactualRequest({question, history: previous, semantic: frame(["price"])});
    assert(result.applicable && !result.needs_subject_clarification, JSON.stringify(result));
    equal(result.subject, "AX-QZ81"); equal(result.requested_facts, [facet]); equal(result.resolution, "follow_up");
    equal(result.subject_source_message_id, "old-customer-source");
    assert(result.query?.includes("AX-QZ81") && !/BR-998|9999|SKU\/staff|App, Push|unrelated prior topic/u.test(result.query), "old facts/topic polluted retrieval");
    if (facet !== "features") assert(!result.query?.includes("有咩功能"), "prior requested facet became current query");
  });
}

for (const question of ["另外，轻量冲锋衣 几钱？", "改問轻量冲锋衣幾錢？", "Actually, I mean Harbor field pack price?"]) {
  Deno.test(`explicit named product outranks old model and semantic topic: ${question}`, () => {
    const result = resolveCurrentFactualRequest({question, history: previous, semantic: frame(["features"], "AX-QZ81")});
    equal(result.subject, question.includes("Harbor") ? "Harbor field pack" : "轻量冲锋衣");
    equal(result.requested_facts, ["price"]); equal(result.resolution, "explicit");
    assert(!result.query?.includes("AX-QZ81") && result.context_turns.length === 0, JSON.stringify(result));
  });
}

Deno.test("stock question replaces semantic price without dropping original wording", () => {
  const question = "轻量冲锋衣 有冇貨？";
  const result = resolveCurrentFactualRequest({question, history: previous, semantic: frame(["price"])});
  equal(result.subject, "轻量冲锋衣"); equal(result.requested_facts, ["stock"]);
  assert(result.query?.includes("有冇貨") && !result.query.includes("price"), JSON.stringify(result));
});

Deno.test("explicit model comparison retains all subjects and current facets", () => {
  const result = resolveCurrentFactualRequest({question: "Compare AX-QZ81 and BR-998 price and stock, excluding delivery fees", history: previous, semantic: frame()});
  equal(result.subject, null); equal(result.subjects, ["AX-QZ81", "BR-998"]);
  equal(result.requested_facts, ["price", "stock"]); equal(result.resolution, "explicit");
  assert(!result.needs_subject_clarification && result.answer_request?.includes("excluding delivery fees"), JSON.stringify(result));
});

Deno.test("declined price remains in customer text but not requested facets", () => {
  const question = "不要價錢，只查庫存";
  const result = resolveCurrentFactualRequest({question, history: previous, semantic: frame(["price", "stock"])});
  equal(result.subject, "AX-QZ81"); equal(result.requested_facts, ["stock"]);
  assert(result.answer_request?.includes("不要價錢") && result.answer_request.includes("只查庫存"), "negation removed from full request");
});

Deno.test("explicit negative product condition is not discarded as a declined lookup", () => {
  const result = resolveCurrentFactualRequest({question: "AX-QZ81 features: is it not waterproof?", semantic: frame(["price"])});
  equal(result.requested_facts, ["features"]); equal(result.subject, "AX-QZ81");
  assert(result.answer_request?.includes("not waterproof"), "negative condition lost");
});

for (const question of ["退貨政策是甚麼？", "退貨政策？", "What is the return policy?"]) {
  Deno.test(`self-contained policy request does not require a product: ${question}`, () => {
    const result = resolveCurrentFactualRequest({question, history: previous, semantic: frame(["policy"], "AX-QZ81")});
    assert(result.applicable && !result.needs_subject_clarification && result.resolution === "explicit", JSON.stringify(result));
    assert(!result.query?.includes("AX-QZ81"), "old product leaked into unrelated policy request");
  });
}

for (const [question, history] of [
  ["幾錢？", []],
  ["幾錢？", [{role: "visitor", content: "Compare AX-QZ81 with BR-998"}]],
  ["幾錢？", [{role: "visitor", content: "換個話題"}, ...previous]],
  ["幾錢？", [{role: "visitor", content: "How is the weather?"}, ...previous]],
  ["換個話題，幾錢？", previous],
] as Array<[string, FactualRequestHistoryRow[]]>) {
  Deno.test(`missing/ambiguous/topic boundary cannot revive prior subject: ${question} / ${history[0]?.content ?? "empty"}`, () => {
    const result = resolveCurrentFactualRequest({question, history, semantic: frame()});
    assert(result.applicable && result.needs_subject_clarification, JSON.stringify(result));
    equal(result.subject, null); assert(!result.query?.includes("AX-QZ81"), "unresolved query silently chose old model");
  });
}

Deno.test("inactive retained subject cannot be revived by a bare factual follow-up", () => {
  const commerce = createEmptyConversationCommerceState(); commerce.current_topic = "product";
  commerce.entities = [{entity_id: "generic:old", category: "product", model: "AX-QZ81", quantity: 1, status: "cancelled", attributes: {}, constraints: {}, provenance: {source_type: "customer", source_message_id: "old"}}];
  const result = resolveCurrentFactualRequest({question: "幾錢？", history: previous, commerce, semantic: frame()});
  assert(result.needs_subject_clarification && result.subject === null, JSON.stringify(result));
});

Deno.test("named history preserves customer variant without inheriting old facet", () => {
  const result = resolveCurrentFactualRequest({question: "有冇貨？", history: [{id: "variant", role: "visitor", content: "Harbor field pack color: navy size: XL price?"}]});
  equal(result.subject, "Harbor field pack"); equal(result.requested_facts, ["stock"]);
  assert(result.answer_request?.includes("navy") && result.answer_request.includes("XL") && !result.answer_request.includes("price"), JSON.stringify(result));
});

Deno.test("bare follow-up chains keep the same customer-owned source, not assistant facts", () => {
  const result = resolveCurrentFactualRequest({question: "有冇貨？", history: [{role: "visitor", content: "幾錢？"}, ...previous]});
  equal(result.subject, "AX-QZ81"); equal(result.subject_source_message_id, "old-customer-source");
  assert(!result.query?.includes("9999"), "assistant price became authority");
});

Deno.test("current explicit subject can disambiguate an uncertain semantic read without altering frame", () => {
  const semantic = frame(["features"]); semantic.ambiguity.is_ambiguous = true;
  const before = JSON.stringify(semantic);
  const result = resolveCurrentFactualRequest({question: "BR-998 price?", history: previous, semantic});
  equal(result.subject, "BR-998"); equal(result.requested_facts, ["price"]);
  equal(JSON.stringify(semantic), before, "read resolver changed writer proposal");
});

Deno.test("guidance, recap, formatting and private order enquiries do not become KB reads", () => {
  for (const question of ["Summarize our conversation", "Translate the last answer", "Check my order status, reference AB-12345"]) {
    const result = resolveCurrentFactualRequest({question, history: previous, semantic: frame()});
    assert(!result.applicable && result.query === null && result.answer_request === null, JSON.stringify(result));
  }
  const question = "What should I compare before choosing a product?";
  const result = resolveCurrentFactualRequest({question, semantic: frame(), request_decision: {kind: "guidance", continuation: false,
    general_request: question, merchant_request: null, latest_requirements: question}});
  assert(!result.applicable && result.merchant_request === null, JSON.stringify(result));
});

Deno.test("mixed request preserves merchant scope and original full question", () => {
  const question = "Explain general buying criteria, and check BR-998 stock";
  const result = resolveCurrentFactualRequest({question, semantic: frame(), request_decision: {kind: "mixed", continuation: false,
    general_request: "Explain general buying criteria", merchant_request: "check BR-998 stock", latest_requirements: question}});
  equal(result.question, question); equal(result.subject, "BR-998"); equal(result.requested_facts, ["stock"]);
  equal(result.merchant_request, "check BR-998 stock");
  assert(!result.query?.includes("general buying criteria"), "guidance contaminated factual retrieval");
});

Deno.test("one resolved contract is reused even if legacy caller inputs disagree", () => {
  const request = resolveCurrentFactualRequest({question: "Harbor field pack stock?", semantic: frame(["price"])});
  equal(scopedServiceKnowledgeQuery("AX-QZ81 price?", frame(), null, [], request), request.query);
});

Deno.test("bounded customer requirements retain false, zero and units and exclude unrelated/private state", () => {
  const commerce = createEmptyConversationCommerceState(); commerce.current_topic = "equipment";
  commerce.entities = [
    {entity_id: "generic:current", category: "equipment", model: "AX-QZ81", quantity: 1, status: "researching", attributes: {},
      constraints: {requires_stairs: false, deposit: {value: 0, unit: "CNY"}, api_token: "PRIVATE_SENTINEL"}, provenance: {source_type: "customer", source_message_id: "current"}},
    {entity_id: "generic:other", category: "equipment", model: "BR-998", quantity: 9, status: "researching", attributes: {},
      constraints: {unrelated: "OTHER_CONSTRAINT"}, provenance: {source_type: "customer", source_message_id: "other"}},
  ];
  const before = JSON.stringify(commerce);
  const result = resolveCurrentFactualRequest({question: "AX-QZ81 price?", commerce, semantic: frame(["stock"], "BR-998")});
  const parsed = JSON.parse(result.query!);
  equal(parsed.requested_facts, ["price"]); equal(parsed.prior[0].constraints.requires_stairs, false);
  equal(parsed.prior[0].constraints.deposit, {unit: "CNY", value: 0});
  assert(!result.query?.includes("BR-998") && !result.query?.includes("PRIVATE_SENTINEL") && !result.query?.includes("OTHER_CONSTRAINT"), "irrelevant/private context entered query");
  equal(JSON.stringify(commerce), before, "read resolver mutated Commerce");
});

Deno.test("query overflow preserves existing explicit bounded-context failure", () => {
  let rejected = false;
  try { resolveCurrentFactualRequest({question: "AX-QZ81 stock? " + "x".repeat(1100)}); }
  catch (error) { rejected = error instanceof DecisionContextLimitError; }
  assert(rejected, "oversized current request silently truncated");
});

Deno.test("legacy canonical retrieval shares current subject/facet and adds no SaaS vocabulary", () => {
  const result = buildCanonicalRetrievalQuery("幾錢？", previous.map(row => ({...row, id: row.id ?? undefined})));
  equal(result.query, "AX-QZ81 幾錢?"); equal(result.mode, "contextual");
  assert(!/staff|App|Push|CRM|member tiers|AI SEO/u.test(result.query), result.query);
  const changed = buildCanonicalRetrievalQuery("另外，轻量冲锋衣 几钱？", previous.map(row => ({...row, id: row.id ?? undefined})));
  assert(!changed.query.includes("AX-QZ81"), changed.query); equal(changed.context_turns, []);
});

function citedSubjectHistory(question: string, subject: string, source = "grounded-customer"): FactualRequestHistoryRow[] {
  return [
    {role: "assistant", content: "Prior source answer with HISTORICAL_VALUE_NOT_CURRENT.", metadata: {
      source_message_id: source, factual_request_subject: subject,
      citations: [{document_id: "prior-document", label: `Source for "${subject}"`}],
      citation_lineage: {selected_document_id: "prior-document", evidence_chunk_ids: ["prior-chunk"]},
    }},
    {id: source, role: "visitor", content: question},
  ];
}

Deno.test("definition subject stops at the question boundary while preserving complete instructions", () => {
  const question = "什麼是四電一腦？請根據現行知識庫資料解釋。";
  const result = resolveCurrentFactualRequest({question, semantic: frame(["definition of 四電一腦"], null)});
  equal(result.subject, "四電一腦"); equal(result.resolution, "explicit");
  assert(result.answer_request?.includes("請根據現行知識庫資料解釋"), "customer instruction was discarded");
});

for (const question of ["What is the meaning of this recycling scheme?", "你頭先講嗰個計劃係乜？",
  "你頭先講嗰個計劃包括啲乜？", "咁佢涵蓋邊幾類電器？", "咁佢包括邊幾類電器？"]) {
  Deno.test(`generic factual pronoun uses the established source-bound locator: ${question}`, () => {
    const history = citedSubjectHistory("香港四電一腦回收計劃係點運作？", "四電一腦");
    const result = resolveCurrentFactualRequest({question, history, semantic: frame(["features"], "features")});
    equal(result.subject, "四電一腦"); equal(result.resolution, "follow_up");
    equal(result.subject_source_message_id, "grounded-customer");
    assert(!result.needs_subject_clarification && result.query?.includes("四電一腦"), JSON.stringify(result));
    assert(!JSON.stringify(result).includes("HISTORICAL_VALUE_NOT_CURRENT"), "old answer became request evidence");
  });
}

for (const first of ["Could you explain Harbor Care?", "I would like to know what Harbor Care includes.", "Harbor Care 有啲咩服務？"]) {
  Deno.test(`natural service follow-up reuses the grounded locating name: ${first}`, () => {
    const result = resolveCurrentFactualRequest({question: "What does it include?",
      history: citedSubjectHistory(first, "Harbor Care"), semantic: frame(["included service scope"], null)});
    equal(result.subject, "Harbor Care"); equal(result.resolution, "follow_up");
    assert(result.query?.includes("Harbor Care") && !result.needs_subject_clarification, JSON.stringify(result));
    assert(!JSON.stringify(result).includes("HISTORICAL_VALUE_NOT_CURRENT"), "prior source answer was promoted");
  });
}

Deno.test("generic source-bound correction stays the nearest follow-up subject", () => {
  const history = [...citedSubjectHistory("Actually I meant Atlas Cover, not Harbor Care.", "Atlas Cover", "correction"),
    ...citedSubjectHistory("Could you explain Harbor Care?", "Harbor Care", "older")];
  const result = resolveCurrentFactualRequest({question: "What does it include?", history,
    semantic: frame(["included service scope"], null)});
  equal(result.subject, "Atlas Cover"); equal(result.subject_source_message_id, "correction");
  assert(!result.query?.includes("Harbor Care"), "older subject was revived");
});

Deno.test("unmatched source metadata cannot supply a locating name for a free-form prior question", () => {
  const history = citedSubjectHistory("Could you explain Harbor Care?", "Harbor Care");
  history[1].id = "different-customer";
  const result = resolveCurrentFactualRequest({question: "What does it include?", history,
    semantic: frame(["included service scope"], null)});
  assert(result.subject === null && result.needs_subject_clarification, JSON.stringify(result));
});

Deno.test("customer-owned dimension correction is not a merchant factual request", () => {
  const question = "Correction: the width is 75, not 70; keep the height and unit as before. Please give general preparation guidance.";
  const semantic = frame([], null); semantic.operation = "UPDATE_ITEM"; semantic.intent = "customer_guidance";
  semantic.customer_correction = true;
  semantic.customer_facts = [{key: "site_dimensions", value: {width: 75, height: 55, unit: "cm"}}];
  const result = resolveCurrentFactualRequest({question, semantic});
  assert(!result.applicable && result.query === null && result.answer_request === null, JSON.stringify(result));
});

Deno.test("assessment of a customer draft does not request an unspecified product", () => {
  const result = resolveCurrentFactualRequest({question: "Please assess my subscription cancellation draft."});
  assert(!result.applicable && !result.needs_subject_clarification && result.query === null, JSON.stringify(result));
});

for (const question of ["咁佢包括邊幾類電器？", "What does it include?"]) {
  Deno.test(`manual generic pronoun without source context needs a subject: ${question}`, () => {
    const result = resolveCurrentFactualRequest({question});
    assert(result.applicable && result.needs_subject_clarification && result.subject === null, JSON.stringify(result));
  });
}
