import { resolveCurrentFactualRequest, assertFactualQueryBudget, type FactualRequestHistoryRow } from "./current-factual-request.ts";
import { renderUnverifiedFactualNextStep } from "./factual-request-context.ts";
import { scopedServiceKnowledgeQuery } from "./service-semantic-routing.ts";
import { buildCanonicalRetrievalQuery } from "./conversation-runtime-state-core.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import type { CommerceSemanticDemand, CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { decodeCommerceSemanticWire, recoverSourceQuotedReadOnlyFactualFrame, rebindSourceQuotedReadOnlyDemand, COMMERCE_SEMANTIC_SYSTEM_PROMPT } from "./commerce-semantic-frame.ts";
import { DecisionContextLimitError } from "./bounded-decision-context.ts";
import { planConversationService, renderServicePlanReply } from "./conversation-service-planner.ts";
import { applyCustomerRequestDecision, resolveCustomerRequestDecision } from "./commerce-state-authority.ts";

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

function demand(question: string, source_type: CommerceSemanticDemand["source_type"],
  requested_facts: string[], subject_refs: string[] = []): CommerceSemanticDemand {
  return {question, source_quote: question, subject_refs, source_type, requested_facts, constraints: {},
    customer_correction: false, explicit_negations: [],
    ambiguity: {is_ambiguous: false, reasons: [], clarification_question: null}};
}
function demanded(...demands: CommerceSemanticDemand[]): CommerceSemanticFrame {
  return {...frame(demands.flatMap(item => item.requested_facts), null), demands};
}

function staleFollowup(question: string, oldSubject = "AX-QZ81", sourceType: CommerceSemanticDemand["source_type"] = "product") {
  const item = demand(question, sourceType, sourceType === "policy" ? ["return conditions"] : ["price"], [oldSubject]);
  item.question = `What is the price of ${oldSubject}?`;
  const semantic = demanded(item);
  semantic.referents = [{ref: oldSubject, source: "prior_turn", confidence: .98}];
  return semantic;
}

for (const [question, latestSubject, priorSubject, latestText] of [
  ["幾錢？", "轻量化户外冲锋衣", "AX-QZ81", "轻量化户外冲锋衣 功能"],
  ["几钱？", "輕量化戶外衝鋒衣", "AX-QZ81", "輕量化戶外衝鋒衣 功能"],
  ["How much?", "Harbor field pack", "AX-QZ81", "Harbor field pack features?"],
  ["How much?", "BR-998", "Harbor field pack", "BR-998 features?"],
]) {
  Deno.test(`semantic stale subject cannot overrule the latest literal customer focus: ${question}/${latestSubject}`, () => {
    const semantic = staleFollowup(question, priorSubject);
    const history = [
      {id: "latest-answer", role: "assistant", content: "Technical recovery: the previous attempt failed."},
      {id: "latest-customer", role: "visitor", content: latestText},
      {id: "old-customer", role: "visitor", content: `${priorSubject} price?`},
    ];
    const before = JSON.stringify({semantic, history});
    const result = resolveCurrentFactualRequest({question, source_message_id: "current", semantic, history});
    equal(result.subject, latestSubject); equal(result.subject_source_message_ids, ["latest-customer"]);
    equal(result.resolution, "follow_up"); equal(result.requested_facts, ["price"]);
    assert(!result.needs_subject_clarification && result.query?.includes(latestSubject), JSON.stringify(result));
    assert(!JSON.stringify([result.query, result.answer_request, result.context_turns, result.demands]).includes(priorSubject), "stale subject survived the common request projection");
    equal(JSON.stringify({semantic, history}), before, "source rows or model proposal were mutated");
  });
}

Deno.test("source-bound focus repairs an omitted ref with a stale expanded semantic question", () => {
  const question = "How much?", semantic = staleFollowup(question);
  semantic.demands![0].subject_refs = []; semantic.referents = [];
  const result = resolveCurrentFactualRequest({question, source_message_id: "current", semantic,
    history: [{id: "latest", role: "visitor", content: "Harbor field pack features?"}, ...previous]});
  equal(result.subject, "Harbor field pack"); equal(result.subject_source_message_ids, ["latest"]);
  assert(!result.query?.includes("AX-QZ81") && !result.needs_subject_clarification, JSON.stringify(result));
});

Deno.test("a linked policy follow-up uses the same latest customer focus", () => {
  const question = "佢嘅退貨條件係點？", semantic = staleFollowup(question, "AX-QZ81", "policy");
  semantic.demands![0].question = "What are the return conditions for AX-QZ81?";
  const result = resolveCurrentFactualRequest({question, semantic,
    history: [{id: "new-service", role: "visitor", content: "Harbor field pack features?"}, ...previous]});
  equal(result.subject, "Harbor field pack"); equal(result.demands[0].source_type, "policy");
  equal(result.requested_facts, ["return conditions"]);
  assert(result.query?.includes("merchant_rules_and_subject_exceptions") && !result.query.includes("AX-QZ81"), JSON.stringify(result));
});

Deno.test("a policy facet is not a replacement product identity", () => {
  const question = "退貨政策呢？", semantic = staleFollowup(question, "AX-QZ81", "policy");
  semantic.demands![0].question = "What is AX-QZ81's return policy?";
  const result = resolveCurrentFactualRequest({question, semantic,
    history: [{id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous]});
  equal(result.subject, "Harbor field pack"); equal(result.subject_source_message_ids, ["new-product"]);
  assert(!result.query?.includes("AX-QZ81"), JSON.stringify(result));
});

Deno.test("correct subject refs cannot retain a contradictory old expanded question", () => {
  const question = "How much?", semantic = staleFollowup(question);
  semantic.demands![0].subject_refs = ["Harbor field pack"];
  semantic.referents = [{ref: "Harbor field pack", source: "prior_turn", confidence: .98}];
  const result = resolveCurrentFactualRequest({question, semantic,
    history: [{id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous]});
  equal(result.subject, "Harbor field pack");
  assert(!result.query?.includes("AX-QZ81") && !result.needs_subject_clarification, JSON.stringify(result));
});

Deno.test("a new named subject in another current clause outranks an old model for an elliptical demand", () => {
  const product = demand("Harbor field pack features?", "product", ["features"], ["Harbor field pack"]);
  const price = staleFollowup("How much?").demands![0];
  const semantic = demanded(product, price);
  semantic.referents = [{ref: "AX-QZ81", source: "prior_turn", confidence: .98}];
  const result = resolveCurrentFactualRequest({question: `${product.source_quote} ${price.source_quote}`, source_message_id: "current", semantic, history: previous});
  equal(result.demands.map(item => item.subjects), [["Harbor field pack"], ["Harbor field pack"]]);
  equal(result.subject_source_message_ids, ["current"]);
  assert(result.query?.includes("features") && result.query.includes("price") && !result.query.includes("AX-QZ81"), JSON.stringify(result));
});

Deno.test("an independent policy clause does not pollute the product focus of another demand", () => {
  const product = demand("Harbor field pack features?", "product", ["features"], ["Harbor field pack"]);
  const policy = demand("What is the general return policy?", "policy", ["return conditions"]);
  const price = staleFollowup("How much?").demands![0];
  const semantic = demanded(product, policy, price);
  const result = resolveCurrentFactualRequest({question: [product, policy, price].map(item => item.source_quote).join(" "), source_message_id: "current", semantic, history: previous});
  equal(result.demands.map(item => item.subjects), [["Harbor field pack"], [], ["Harbor field pack"]]);
  assert(result.query?.includes("return conditions") && result.query.includes("price") && !result.query.includes("AX-QZ81"), JSON.stringify(result));
});

Deno.test("a current correction excludes only the negated identity, preserving the positively named replacement", () => {
  const question = "Not AX-QZ81, BR-998 price?", semantic = demanded(demand(question, "product", ["price"], ["BR-998"]));
  const result = resolveCurrentFactualRequest({question, source_message_id: "current", semantic, history: previous});
  equal(result.subject, "BR-998"); equal(result.subject_source_message_ids, ["current"]);
  assert(!result.needs_subject_clarification && result.answer_request?.includes("Not AX-QZ81"), JSON.stringify(result));
});

Deno.test("the next follow-up retains the positive product from a previous not-A-but-B correction", () => {
  const question = "How much?", semantic = staleFollowup(question, "BR-998");
  const result = resolveCurrentFactualRequest({question, semantic, history: [
    {id: "correction", role: "visitor", content: "Not AX-QZ81, BR-998 price?"}, ...previous,
  ]});
  equal(result.subject, "BR-998"); equal(result.subject_source_message_ids, ["correction"]);
  assert(!result.needs_subject_clarification, JSON.stringify(result));
});

Deno.test("source-bound customer requirement updates preserve focus without treating unknown rows as continuations", () => {
  const question = "How much?", history = [
    {id: "requirement-update", role: "visitor", content: "只買1件，送九龍"},
    {id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous,
  ];
  const memory = {current_customer_facts: [{key: "delivery", value: "九龍", authority: "customer", source_message_id: "requirement-update"}]} as unknown as NonNullable<Parameters<typeof resolveCurrentFactualRequest>[0]["memory"]>;
  const result = resolveCurrentFactualRequest({question, semantic: staleFollowup(question), history, memory});
  equal(result.subject, "Harbor field pack"); equal(result.subject_source_message_ids, ["new-product"]);
  const unproven = resolveCurrentFactualRequest({question, semantic: staleFollowup(question), history});
  assert(unproven.needs_subject_clarification && unproven.query === "", "unknown row was silently skipped");
});

for (const control of ["Thanks", "用英文回答", "Please simplify that"]) {
  Deno.test(`pure control/formatting preserves the latest subject: ${control}`, () => {
    const question = "How much?";
    const result = resolveCurrentFactualRequest({question, source_message_id: "current", semantic: staleFollowup(question), history: [
      {id: "control", role: "visitor", content: control},
      {id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous,
    ]});
    equal(result.subject, "Harbor field pack"); equal(result.subject_source_message_ids, ["new-product"]);
  });
}

for (const boundary of ["How is the weather?", "換個話題", "Compare AX-QZ81 and BR-998"]) {
  Deno.test(`confident semantic ref cannot cross an unknown or ambiguous latest focus: ${boundary}`, () => {
    const question = "How much?";
    const result = resolveCurrentFactualRequest({question, semantic: staleFollowup(question), history: [
      {id: "boundary", role: "visitor", content: boundary}, ...previous,
    ]});
    assert(result.needs_subject_clarification && result.subject === null && result.query === "", JSON.stringify(result));
    equal(result.subject_source_message_ids, []);
  });
}

Deno.test("a poisoned elliptical Memory anchor cannot reset focus to its inferred old subject", () => {
  const question = "How much?", semantic = staleFollowup(question);
  const history = [
    {id: "bad-price", role: "visitor", content: "幾錢？"},
    {id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous,
  ];
  const memory = {factual_read_anchors: [{source_message_id: "bad-price", created_at: "2026-10-30T03:48:41Z",
    customer_text: "幾錢？", subjects: ["AX-QZ81"], subject_source_message_ids: ["old-customer-source"], requested_facts: ["price"]}]} as unknown as NonNullable<Parameters<typeof resolveCurrentFactualRequest>[0]["memory"]>;
  const result = resolveCurrentFactualRequest({question, semantic, history, memory});
  equal(result.subject, "Harbor field pack"); equal(result.subject_source_message_ids, ["new-product"]);
  assert(!JSON.stringify([result.query, result.context_turns, result.answer_request]).includes("AX-QZ81"), JSON.stringify(result));
});

Deno.test("literal Memory anchor names require the same original customer source", () => {
  const question = "How much?", history = [
    {id: "new-service", role: "visitor", content: "Tell me about the Atlas Circle offer"}, ...previous,
  ];
  const anchor = {source_message_id: "new-service", created_at: "2026-10-30T03:48:41Z",
    customer_text: history[0].content, subjects: ["Atlas Circle"], subject_source_message_ids: ["new-service"], requested_facts: ["service scope"]};
  const memory = {factual_read_anchors: [anchor]} as unknown as NonNullable<Parameters<typeof resolveCurrentFactualRequest>[0]["memory"]>;
  const result = resolveCurrentFactualRequest({question, semantic: staleFollowup(question), history, memory});
  equal(result.subject, "Atlas Circle"); equal(result.subject_source_message_ids, ["new-service"]);
  const forged = resolveCurrentFactualRequest({question, semantic: staleFollowup(question), history,
    memory: {...memory, factual_read_anchors: [{...anchor, source_message_id: "different-source"}]}});
  assert(forged.subject !== "AX-QZ81", "unverified anchor caused fallback to the stale product");
});

for (const field of ["constraints", "explicit_negations", "customer_correction", "requested_facts"] as const) {
  Deno.test(`stale subject conditions are not silently transferred to the new product: ${field}`, () => {
    const question = "How much?", semantic = staleFollowup(question), item = semantic.demands![0];
    if (field === "constraints") item.constraints = {room_area: {value: 300, unit: "square feet"}};
    if (field === "explicit_negations") item.explicit_negations = ["no stairs for AX-QZ81"];
    if (field === "customer_correction") item.customer_correction = true;
    if (field === "requested_facts") item.requested_facts = ["price of AX-QZ81"];
    const result = resolveCurrentFactualRequest({question, semantic, history: [
      {id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous,
    ]});
    assert(result.needs_subject_clarification && result.query === "" && result.subject === null, JSON.stringify(result));
    assert(result.original_question === question && result.demands.length === 1, "unresolved demand was discarded");
  });
}

Deno.test("explicit named return and comparison still select their stated historical products", () => {
  for (const question of ["Back to AX-QZ81, how much?", "Compare AX-QZ81 and BR-998 prices"]) {
    const semantic = staleFollowup(question);
    if (question.startsWith("Compare")) semantic.demands![0].subject_refs.push("BR-998");
    const result = resolveCurrentFactualRequest({question, source_message_id: "current", semantic, history: [
      {id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous,
    ]});
    equal(result.subjects, question.startsWith("Compare") ? ["AX-QZ81", "BR-998"] : ["AX-QZ81"]);
    assert(!result.needs_subject_clarification && !result.query?.includes("Harbor"), JSON.stringify(result));
  }
});

Deno.test("separate Chinese product names are not collapsed into a combined catalogue label", () => {
  const question = "輕量化戶外衝鋒衣和純棉外套幾錢？";
  const semantic = demanded(demand(question, "product", ["price"], ["輕量化戶外衝鋒衣", "純棉外套"]));
  const result = resolveCurrentFactualRequest({question, source_message_id: "current", semantic});
  equal(result.subjects, ["輕量化戶外衝鋒衣", "純棉外套"]); equal(result.subject, null);
  assert(!result.needs_subject_clarification && result.demands[0].subjects.length === 2, JSON.stringify(result));
});

for (const question of ["Can it arrive earlier?", "How much for the first order?", "Original price?"]) {
  Deno.test(`ordinary modifiers are not historical product selectors or product names: ${question}`, () => {
    const result = resolveCurrentFactualRequest({question, semantic: staleFollowup(question), history: [
      {id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous,
    ]});
    equal(result.subject, "Harbor field pack"); equal(result.subject_source_message_ids, ["new-product"]);
    assert(!result.needs_subject_clarification && !result.query?.includes("AX-QZ81"), JSON.stringify(result));
  });
}

Deno.test("an explicit ordinal return retains its source-bound earlier product", () => {
  const question = "Return to the first model, price?";
  const result = resolveCurrentFactualRequest({question, semantic: staleFollowup(question), history: [
    {id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous,
  ]});
  equal(result.subject, "AX-QZ81"); equal(result.subject_source_message_ids, ["old-customer-source"]);
  assert(!result.needs_subject_clarification, JSON.stringify(result));
});

Deno.test("both requested facets are not permission to revive an older product", () => {
  const question = "Are delivery and installation both included?", semantic = staleFollowup(question);
  semantic.demands![0].requested_facts = ["delivery inclusion", "installation inclusion"];
  const result = resolveCurrentFactualRequest({question, semantic, history: [
    {id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous,
  ]});
  equal(result.subject, "Harbor field pack"); equal(result.subject_source_message_ids, ["new-product"]);
  assert(result.query?.includes("delivery inclusion") && result.query.includes("installation inclusion") && !result.query.includes("AX-QZ81"), JSON.stringify(result));
});

Deno.test("an explicit two-product comparison preserves both source-bound subjects", () => {
  const question = "Compare both products' prices", semantic = demanded(demand(question, "product", ["price"], ["AX-QZ81", "BR-998"]));
  const result = resolveCurrentFactualRequest({question, semantic, history: [
    {id: "new-product", role: "visitor", content: "Harbor field pack features?"}, ...previous,
  ]});
  equal(result.subjects, ["AX-QZ81", "BR-998"]);
  assert(!result.needs_subject_clarification && !result.query?.includes("Harbor"), JSON.stringify(result));
});

Deno.test("semantic category stock discovery does not invent a product from its interrogative phrase", () => {
  const question = "What products are in stock?", semantic = demanded(demand(question, "product", ["available products"]));
  const result = resolveCurrentFactualRequest({question, semantic, history: previous});
  equal(result.subjects, []); equal(result.resolution, "none");
  assert(!result.needs_subject_clarification && result.query?.includes(question) && !result.query.includes("AX-QZ81"), JSON.stringify(result));
});

Deno.test("Task2 query bounds check UTF-8 bytes as well as characters",()=>{
  for(const text of ["x".repeat(1001),"中".repeat(700)]) {
    let rejected=false;try{assertFactualQueryBudget(text);}catch(error){rejected=error instanceof DecisionContextLimitError;}
    assert(rejected,"oversized retrieval query was not rejected");
  }
  equal(assertFactualQueryBudget("中".repeat(600)),"中".repeat(600));
});
for(const ambiguous of [false,true])for(const overlap of ["whole_quote","negation"]){
  Deno.test(`Task2 transaction isolation includes ambiguous private scope and every query field: ${ambiguous}/${overlap}`,()=>{
    const order="訂單 AB-12345 出貨未？",product="AX-QZ81 有咩功能？",question=order+"另外 "+product;
    const transaction=demand(order,"transaction",["shipment_status"],["AB-12345"]);
    transaction.ambiguity={is_ambiguous:ambiguous,reasons:ambiguous?["order unconfirmed"]:[],clarification_question:null};
    const kb=demand(overlap==="whole_quote"?question:product,"product",["features"],["AX-QZ81"]);
    if(overlap==="negation")kb.explicit_negations=["not order AB-12345"];
    const result=resolveCurrentFactualRequest({question,source_message_id:"customer-current",semantic:demanded(transaction,kb)});
    assert(!result.query?.includes("AB-12345"),"private order locator entered KB projection");
    assert(result.missing_evidence.some(item=>item.demand_id==="demand-2"&&item.reason==="transaction_scope_overlap"),"overlap not retained as unresolved");
    equal(result.demands.length,2);assert(result.answer_request?.includes("AB-12345"),"complete answer context was lost");
  });
}
Deno.test("Task2 clear policy remains retrievable beside an ambiguous product demand",()=>{
  const product=demand("嗰部幾錢？","product",["price"]);product.ambiguity={is_ambiguous:true,reasons:["which product"],clarification_question:"Which product?"};
  const policy=demand("一般退貨政策係點？","policy",["return_conditions"]);
  const result=resolveCurrentFactualRequest({question:product.question+policy.question,semantic:demanded(product,policy)});
  const query=JSON.parse(result.query!);equal(query.questions.length,1);equal(query.questions[0].source_type,"policy");
  equal(result.demands.length,2);assert(result.missing_evidence.some(item=>item.demand_id==="demand-1"),"ambiguous part disappeared");
});

for (const [question, facts] of [
  ["會唔會好嘈？", ["operating noise and quiet-mode capability"]],
  ["夜晚喺睡房開住得唔得？", ["bedroom suitability and night operation"]],
  ["What is included if it breaks later?", ["warranty coverage and exclusions"]],
] as Array<[string, string[]]>) {
  Deno.test(`source-bound semantic referent resolves arbitrary factual wording: ${question}`, () => {
    const semantic = demanded(demand(question, "product", facts, ["AX-QZ81"]));
    semantic.referents = [{ref: "AX-QZ81", source: "prior_turn", confidence: .95}];
    const result = resolveCurrentFactualRequest({question, source_message_id: "current-read", history: previous, semantic});
    equal(result.subject, "AX-QZ81"); equal(result.resolution, "follow_up");
    equal(result.subject_source_message_ids, ["old-customer-source"]);
    equal(result.requested_facts, facts);
    assert(result.kb_required && !result.needs_subject_clarification && result.query?.includes("AX-QZ81"), JSON.stringify(result));
    assert(result.answer_request?.includes(question.normalize("NFKC")) && !JSON.stringify(result).includes("9999"), "full request or source boundary lost");
  });
}

Deno.test("legacy semantic dependency is no longer limited to literal price/stock facets", () => {
  const semantic = frame(["operating noise"], "AX-QZ81");
  semantic.referents = [{ref: "AX-QZ81", source: "prior_turn", confidence: .9}];
  const result = resolveCurrentFactualRequest({question: "會唔會好嘈？", history: previous, semantic});
  equal(result.subject, "AX-QZ81"); equal(result.subject_source_message_id, "old-customer-source");
  assert(result.query?.includes("AX-QZ81") && !result.needs_subject_clarification, JSON.stringify(result));
});

Deno.test("invented semantic reference and retained ID without actual customer source stay unresolved", () => {
  const question = "會唔會好嘈？";
  const semantic = demanded(demand(question, "product", ["operating noise"], ["GHOST-88"]));
  semantic.referents = [{ref: "GHOST-88", source: "persistent_state", confidence: .99}];
  const commerce = createEmptyConversationCommerceState();
  commerce.entities = [{entity_id: "ghost", category: "product", model: "GHOST-88", quantity: 1, status: "researching",
    attributes: {}, constraints: {}, provenance: {source_type: "customer", source_message_id: "missing-source"}}];
  const before = JSON.stringify({semantic, commerce});
  const result = resolveCurrentFactualRequest({question, semantic, commerce,
    history: [{id: "assistant-source", role: "assistant", content: "GHOST-88 is our best product."}]});
  assert(result.needs_subject_clarification && result.subject === null, JSON.stringify(result));
  equal(result.subject_source_message_ids, []);
  assert(!result.query?.includes("GHOST-88"), "model/assistant name became a source-bound query subject");
  equal(JSON.stringify({semantic, commerce}), before, "read mutated input or created an entity");
});

Deno.test("an ambiguous topic-switch reference is not silently bound to the old subject", () => {
  const question = "換個話題，會唔會好嘈？";
  const semantic = demanded(demand(question, "product", ["noise"], ["AX-QZ81"]));
  semantic.referents = [{ref: "AX-QZ81", source: "prior_turn", confidence: .9}];
  semantic.demands![0].ambiguity = {is_ambiguous: true, reasons: ["new topic has no identified subject"], clarification_question: "Which item?"};
  const result = resolveCurrentFactualRequest({question, history: previous, semantic});
  assert(result.needs_subject_clarification && result.subject === null && !result.query?.includes("AX-QZ81"), JSON.stringify(result));
});

Deno.test("structured mixed order, product, offer and policy needs remain one complete request", () => {
  const order = "Check my order AB-12345 progress";
  const product = "AX-QZ81 幾錢、有冇折";
  const policy = "訂購後一般多久可以送貨";
  const question = `${order}; ${product}; ${policy}？`;
  const semantic = demanded(
    demand(order, "transaction", ["current fulfillment status"], ["AB-12345"]),
    demand(product, "product", ["price", "discount eligibility and conditions"], ["AX-QZ81"]),
    demand(policy, "policy", ["delivery lead time", "delivery conditions and exclusions"]),
  );
  const result = resolveCurrentFactualRequest({question, source_message_id: "mixed-current", semantic});
  equal(result.demands.length, 3); equal(result.original_question, question);
  assert(result.kb_required && result.transaction_required && result.applicable, JSON.stringify(result));
  equal(result.demands.map(item => item.source_type), ["transaction", "product", "policy"]);
  equal(result.subjects, ["AX-QZ81"]); equal(result.demands[2].subjects, []);
  assert(result.requested_facts.includes("discount eligibility and conditions"), "discount demand lost to legacy price classifier");
  assert(result.answer_request?.includes("AB-12345") && result.answer_request.includes("有冇折") && result.answer_request.includes("一般多久"), "answer contract dropped a subquestion");
  assert(result.query?.includes("有冇折") && result.query.includes("一般多久") && !result.query.includes("AB-12345"), "retrieval projection mixed private transaction with KB facts");
  equal(result.missing_evidence, [{demand_id: "demand-1", reason: "live_transaction_unavailable"}]);
  const plan = planConversationService({question, factual_request: result, semantic_frame: semantic,
    language: "en", memory: null, commerce: null, recall: {handled: false}});
  equal(plan.action, "published_kb_lookup"); equal(plan.kb_query, result.query);
  assert(plan.safe_assumptions.includes("no_live_account_or_order_state"), "mixed answer lost transaction evidence limitation");
});

Deno.test("canonical transaction demand preserves safe intake without requiring order/status keywords", () => {
  const question = "嗰件而家去到邊呀？";
  const semantic = demanded(demand(question, "transaction", ["current parcel location"]));
  const request = resolveCurrentFactualRequest({question, semantic});
  assert(request.transaction_required && !request.kb_required && request.query === null, JSON.stringify(request));
  const plan = planConversationService({question, factual_request: request, semantic_frame: semantic,
    language: "en", memory: null, commerce: null, recall: {handled: false}});
  equal(plan.action, "customer_issue_next_step"); equal(plan.issue_kind, "order_status_lookup");
  const reply = renderServicePlanReply(plan, null);
  assert(reply?.includes("cannot read the live order status") && !/has shipped|has arrived/i.test(reply), String(reply));
});

Deno.test("compound source types outrank whole-turn legacy order early return", () => {
  const order = "Check my order progress", product = "AX-QZ81 stock?";
  const question = `${order}; ${product}`;
  const semantic = demanded(demand(order, "transaction", ["order progress"]), demand(product, "product", ["stock"], ["AX-QZ81"]));
  const request = resolveCurrentFactualRequest({question, semantic});
  const plan = planConversationService({question, factual_request: request, semantic_frame: semantic,
    language: "en", memory: null, commerce: null, recall: {handled: false}});
  assert(request.kb_required && request.transaction_required && plan.knowledge_state === "lookup_required", JSON.stringify({request, plan}));
});

Deno.test("demand constraints preserve corrections, units, false and zero without leaking another scope", () => {
  const product = demand("AX-QZ81 適合300呎廳嗎？", "product", ["suitability"], ["AX-QZ81"]);
  product.constraints = {room_area: {value: 300, unit: "square feet"}, requires_stairs: false, additional_budget: 0};
  product.customer_correction = true; product.explicit_negations = ["do not assume stairs"];
  const policy = demand("另外一般送貨要幾耐？", "policy", ["delivery time"]);
  const semantic = demanded(product, policy), before = JSON.stringify(semantic);
  const question = `${product.source_quote} ${policy.source_quote}`;
  const result = resolveCurrentFactualRequest({question, source_message_id: "correction-source", semantic});
  equal(result.demands[0].constraints, {additional_budget: 0, requires_stairs: false, room_area: {unit: "square feet", value: 300}});
  equal(result.demands[1].constraints, {}); equal(result.demands[0].subject_source_message_ids, ["correction-source"]);
  assert(result.demands[0].customer_correction && result.query?.includes("square feet") && result.query.includes("do not assume stairs"), JSON.stringify(result));
  equal(JSON.stringify(semantic), before, "canonical read changed semantic proposal");
});

Deno.test("an ambiguous subquestion remains open without erasing another applicable policy request", () => {
  const product = demand("嗰個要幾錢？", "product", ["price"], ["AX-QZ81", "BR-998"]);
  product.ambiguity = {is_ambiguous: true, reasons: ["two plausible products"], clarification_question: "Which product?"};
  const policy = demand("一般退貨條件呢？", "policy", ["return conditions"]);
  const question = `${product.source_quote} ${policy.source_quote}`;
  const semantic = demanded(product, policy); semantic.ambiguity = {...product.ambiguity};
  const result = resolveCurrentFactualRequest({question, history: previous, semantic});
  assert(result.kb_required && !result.needs_subject_clarification && result.demands[0].ambiguity.is_ambiguous, JSON.stringify(result));
  equal(result.demands[0].subjects, []); equal(result.unresolved_demand_ids, ["demand-1"]);
  const plan = planConversationService({question, factual_request: result, semantic_frame: semantic,
    language: "en", memory: null, commerce: null, recall: {handled: false}});
  equal(plan.knowledge_state, "lookup_required");
  assert(result.answer_request?.includes("嗰個要幾錢") && result.answer_request.includes("一般退貨"), "partial scope dropped original demand");
});

Deno.test("invented source quote cannot authorize a KB or transaction read", () => {
  const semantic = demanded(demand("AX-QZ81 price?", "product", ["price"], ["AX-QZ81"]));
  const result = resolveCurrentFactualRequest({question: "Thanks", semantic});
  assert(!result.applicable && !result.kb_required && !result.transaction_required && result.query === null, JSON.stringify(result));
  assert(result.missing_evidence.some(item => item.reason === "source_quote_unbound"), "invalid semantic source was hidden");
});

Deno.test("canonical general guidance and explicit human control retain their original boundaries", () => {
  const question = "What should I consider before choosing?";
  const semantic = demanded(demand(question, "general", ["selection considerations"]));
  const request = resolveCurrentFactualRequest({question, semantic});
  assert(!request.kb_required && request.query === null && !request.transaction_required, JSON.stringify(request));
  const handoff = planConversationService({question, factual_request: request, semantic_frame: semantic,
    explicit_handoff: true, language: "en", memory: null, commerce: null, recall: {handled: false}});
  equal(handoff.action, "explicit_handoff");
});

Deno.test("a broad product request does not invent a requirement to name a model", () => {
  const question = "What options do you carry for a small room?";
  const semantic = demanded(demand(question, "product", ["available product options for customer requirements"]));
  const result = resolveCurrentFactualRequest({question, semantic});
  assert(result.kb_required && !result.needs_subject_clarification && result.subject === null, JSON.stringify(result));
  assert(result.query?.includes("small room"), "broad product request was not preserved");
});

Deno.test("a verified historical reference beyond row 74 survives later unrelated subjects and cancellations", () => {
  const question = "返去最初嗰款，夜晚開住會唔會影響休息？";
  const semantic = demanded(demand(question, "product", ["night operation and noise"], ["AX-QZ81"]));
  semantic.referents = [{ref: "AX-QZ81", source: "prior_turn", confidence: .96}];
  const history: FactualRequestHistoryRow[] = [
    {id: "unrelated-cancellation", role: "visitor", content: "取消 BR-998"},
    ...Array.from({length: 74}, (_, index) => ({id: `intervening-${index}`, role: "visitor", content: `OTHER-${index + 100} 有咩功能？`})),
    {id: "original-source", role: "visitor", content: "AX-QZ81 介紹一下"},
  ];
  const result = resolveCurrentFactualRequest({question, semantic, history});
  equal(result.subject, "AX-QZ81"); equal(result.subject_source_message_ids, ["original-source"]);
  assert(!result.needs_subject_clarification && !result.query?.includes("OTHER-"), JSON.stringify(result));
});

for (const correction of ["取消 AX-QZ81", "Actually I meant BR-998, not AX-QZ81."]) {
  Deno.test(`latest same-subject cancellation/replacement invalidates an older referent: ${correction}`, () => {
    const question = "夜晚會唔會好嘈？";
    const semantic = demanded(demand(question, "product", ["night noise"], ["AX-QZ81"]));
    semantic.referents = [{ref: "AX-QZ81", source: "prior_turn", confidence: .9}];
    const result = resolveCurrentFactualRequest({question, semantic,
      history: [{id: "correction", role: "visitor", content: correction}, {id: "original", role: "visitor", content: "AX-QZ81 介紹一下"}]});
    assert(result.needs_subject_clarification && result.subject === null && !result.query?.includes("AX-QZ81"), JSON.stringify(result));
  });
}

Deno.test("latest same-subject requirements replace old values and retain the declared unit", () => {
  const question = "咁而家啱唔啱用？";
  const semantic = demanded(demand(question, "product", ["suitability for corrected room area"], ["AX-QZ81"]));
  semantic.demands![0].constraints = {room_area: {value: 350}};
  semantic.referents = [{ref: "AX-QZ81", source: "prior_turn", confidence: .9}];
  const commerce = createEmptyConversationCommerceState();
  commerce.entities = [{entity_id: "retained", category: "aircon", model: "AX-QZ81", quantity: 1, status: "researching",
    attributes: {}, constraints: {room_area: {value: 300, unit: "square feet"}, requires_stairs: false},
    provenance: {source_type: "customer", source_message_id: "original"}}];
  const result = resolveCurrentFactualRequest({question, semantic, commerce, history: [
    {id: "latest-correction", role: "visitor", content: "AX-QZ81 嗰個廳更正係350呎，唔係300呎"},
    {id: "original", role: "visitor", content: "AX-QZ81 放300呎廳，不用行樓梯"},
  ]});
  equal(result.subject_source_message_ids, ["latest-correction"]);
  equal(result.demands[0].constraints, {requires_stairs: false, room_area: {unit: "square feet", value: 350}});
  assert(!result.query?.includes('"value":300'), "superseded area reached retrieval");
});

Deno.test("an explicitly negated current subject cannot be recovered from older history", () => {
  const question = "唔係 AX-QZ81，我問另一款夜晚嘈唔嘈？";
  const semantic = demanded(demand(question, "product", ["night noise"], ["AX-QZ81"]));
  semantic.referents = [{ref: "AX-QZ81", source: "prior_turn", confidence: .9}];
  const result = resolveCurrentFactualRequest({question, semantic, history: previous});
  assert(result.subject === null && result.needs_subject_clarification, JSON.stringify(result));
});

Deno.test("source-validated demands outrank a legacy guidance label without losing unfamiliar facts", () => {
  const question = "Help me choose which arrangement fits; 能唔能做到我要求嘅靜音程度？";
  const semantic = demanded(
    demand("Help me choose which arrangement fits", "general", ["decision criteria"]),
    demand("能唔能做到我要求嘅靜音程度？", "product", ["specified acoustic performance"], ["AX-QZ81"]),
  );
  semantic.intent = "customer_guidance";
  semantic.referents = [{ref: "AX-QZ81", source: "prior_turn", confidence: .9}];
  const decision = resolveCustomerRequestDecision(question, semantic);
  equal(decision.kind, "mixed");
  const applied = applyCustomerRequestDecision(semantic, decision);
  assert(applied.requested_facts.includes("specified acoustic performance") && applied.demands?.length === 2, "legacy guidance erased canonical needs");
  const request = resolveCurrentFactualRequest({question, semantic: applied, request_decision: decision, history: previous});
  assert(request.kb_required && request.answer_request?.includes("Help me choose"), JSON.stringify(request));
});

Deno.test("the request decision marks product plus private transaction as mixed", () => {
  const question = "嗰件而家去到邊；AX-QZ81 可唔可以收窄到我個窗位？";
  const semantic = demanded(demand("嗰件而家去到邊", "transaction", ["shipment location"]),
    demand("AX-QZ81 可唔可以收窄到我個窗位？", "product", ["installation dimensions"], ["AX-QZ81"]));
  const decision = resolveCustomerRequestDecision(question, semantic);
  equal(decision.kind, "mixed");
  assert(decision.merchant_request?.includes("AX-QZ81") && !decision.merchant_request.includes("去到邊"), JSON.stringify(decision));
  equal(applyCustomerRequestDecision(semantic, decision).demands?.length, 2);
});

for (const declined of ["不要價錢", "Do not check price"]) {
  Deno.test(`explicitly declined lookup remains excluded from semantic scope: ${declined}`, () => {
    const active = "只查 AX-QZ81 庫存";
    const question = `${declined}；${active}`;
    const semantic = demanded(demand(declined, "product", ["price"]), demand(active, "product", ["stock"], ["AX-QZ81"]));
    const decision = resolveCustomerRequestDecision(question, semantic);
    equal(decision.kind, "merchant_facts");
    const applied = applyCustomerRequestDecision(semantic, decision);
    equal(applied.requested_facts, ["stock"]); equal(applied.demands?.length, 1);
    assert(applied.explicit_negations.includes(declined), "declined requirement disappeared");
    const request = resolveCurrentFactualRequest({question, semantic});
    equal(request.requested_facts, ["stock"]);
    assert(!request.query?.includes('"price"') && request.answer_request?.includes(declined), JSON.stringify(request));
  });
}

Deno.test("negative product constraints are not mistaken for an explicit declined lookup", () => {
  const question = "Don't want a noisy product; what options can you supply?";
  const item = demand(question, "product", ["available quiet options"]); item.constraints = {noisy: false};
  const semantic = demanded(item), decision = resolveCustomerRequestDecision(question, semantic);
  equal(decision.kind, "merchant_facts"); equal(decision.semantic_demands?.length, 1);
  assert(resolveCurrentFactualRequest({question, semantic}).kb_required, "negative product condition erased actual lookup");
});

Deno.test("a wholly declined canonical lookup cannot re-enter the legacy KB route", () => {
  const question = "Do not check price";
  const semantic = demanded(demand(question, "product", ["price"]));
  const decision = resolveCustomerRequestDecision(question, semantic);
  const applied = applyCustomerRequestDecision(semantic, decision);
  const result = resolveCurrentFactualRequest({question, semantic: applied, request_decision: decision});
  assert(!result.kb_required && result.query === null && result.demands.length === 0, JSON.stringify(result));
});

Deno.test("a partial semantic quote cannot evade an explicit negative lookup instruction", () => {
  const question = "Do not check price; explain general selection considerations.";
  const semantic = demanded(demand("price", "product", ["price"]),
    demand("explain general selection considerations", "general", ["selection considerations"]));
  const decision = resolveCustomerRequestDecision(question, semantic);
  equal(decision.kind, "guidance");
  const result = resolveCurrentFactualRequest({question, semantic});
  assert(!result.kb_required && result.query === null, JSON.stringify(result));
});

Deno.test("Task3A source-bound semantic facts correct a wrong facet without enumerating customer phrasing", () => {
  for (const [question, bad, expected] of [
    ["P001-BL-M 有冇貨？", "price", "stock"],
    ["P001-BL-L 库存多少？", "price", "stock"],
    ["Is P001-WH-M in stock?", "price", "stock"],
    ["P001-WH-M 幾錢？", "stock", "price"],
  ]) {
    const semantic=demanded(demand(question,"product",[bad],[question.match(/P001-[A-Z]+-[A-Z]+/u)![0]]));
    const result=resolveCurrentFactualRequest({question,source_message_id:"current",semantic});
    equal(result.requested_facts,[expected]);
    equal(result.demands[0].requested_facts,[expected]);
    assert(result.query?.includes('"' + expected + '"'),"quoted facet absent from KB request");
    assert(!result.query?.includes('"' + bad + '"'),"contradictory model fact reached KB");
  }
});
Deno.test("Task3A two product variants retain independent demand facets and cannot cross-bind",()=>{
  const a=demand("P001-BL-M 有冇貨？","product",["price"],["P001-BL-M"]);
  const b=demand("P001-WH-M 有咩功能？","product",["stock"],["P001-WH-M"]);
  const question=a.source_quote+" "+b.source_quote;
  const result=resolveCurrentFactualRequest({question,source_message_id:"current",semantic:demanded(a,b)});
  equal(result.demands.map(d=>d.subjects),[["P001-BL-M"],["P001-WH-M"]]);
  equal(result.demands.map(d=>d.requested_facts),[["stock"],["features"]]);
  assert(result.query?.includes("P001-BL-M") && result.query.includes("P001-WH-M"),"SKU separation lost");
});
Deno.test("Task3A open semantic meaning remains available even when no lexical stock/price match exists",()=>{
  const q="P001-BL-L 買晒未？",semantic=demanded(demand(q,"product",["stock"],["P001-BL-L"]));
  const result=resolveCurrentFactualRequest({question:q,source_message_id:"current",semantic});
  equal(result.requested_facts,["stock"]);
  assert(result.query?.includes("P001-BL-L"),"no semantic KB read for unfamiliar dialectal form");
  const service="Can the subscription support staged seat activation?";
  const other=resolveCurrentFactualRequest({question:service,semantic:demanded(demand(service,"product",["staged seat activation"]))});
  equal(other.requested_facts,["staged seat activation"]);
});

Deno.test("Task3A does not preserve an incorrect LLM-expanded price question after an explicit stock quote",()=>{
  for(const [question,incorrectFacet,expectedFacet] of [
    ["P001-BL-M 有冇貨？","price","stock"],
    ["P001-BL-L 库存多少？","price","stock"],
    ["Is P001-WH-M in stock?","price","stock"],
    ["P001-WH-M 幾錢？","stock","price"],
  ]){
    const sku=/P001-[A-Z]+-[A-Z]+/u.exec(question)![0];
    const item=demand(question,"product",[incorrectFacet],[sku]);
    item.question="What is the "+incorrectFacet+" of "+sku+"?";
    const result=resolveCurrentFactualRequest({question,source_message_id:"current",semantic:demanded(item)});
    const kb=JSON.parse(result.query!);
    equal(result.demands[0].question,question.normalize("NFKC"),"expanded question must use the canonical source-bound customer quote");
    equal(kb.questions[0].question,question.normalize("NFKC"),"old incorrect semantic question cannot reach KB retrieval");
    equal(kb.questions[0].requested_facts,[expectedFacet]);
    assert(!result.query?.includes("What is the "+incorrectFacet),"contradictory model question survived");
    equal(result.demands[0].subjects,[sku]);
  }
});
Deno.test("Task3A rebuilds a dependent stock query with the verified recent SKU, not an invented price question",()=>{
  const quote="有冇貨？",sku="P001-BL-M";
  const item=demand(quote,"product",["price"],[sku]);
  item.question="What is the price of "+sku+"?";
  const semantic=demanded(item);
  semantic.referents=[{ref:sku,source:"prior_turn",confidence:.97}];
  const result=resolveCurrentFactualRequest({question:quote,source_message_id:"current",semantic,
    history:[{id:"recent-product",role:"visitor",content:sku+" 功能？"}]});
  const kb=JSON.parse(result.query!);
  equal(result.subject,sku);
  equal(result.subject_source_message_ids,["recent-product"]);
  equal(result.requested_facts,["stock"]);
  equal(kb.questions[0].question,sku+" "+quote.normalize("NFKC"));
  assert(!result.query?.includes("price"),"stale model fact carried into the follow-up query");
});


Deno.test("Task3C: refused grounding gives the current stock question a bounded next step, no fabricated stock or handoff", () => {
  const request = resolveCurrentFactualRequest({question:"CW-SUL70BA 有冇貨？",semantic:frame(["price"])});
  const answer = renderUnverifiedFactualNextStep(request,"zh-TW");
  assert(!!answer && answer.includes("CW-SUL70BA") && answer.includes("即時現貨"),JSON.stringify(answer));
  assert(!/已轉交|有現貨|已核實有貨|售價為|HK\$[0-9]/u.test(answer),"unverified fact promoted");
  assert(!answer.includes("再次提供型號"),"known subject re-asked");
});
Deno.test("Task3C: current price and stock stay separate from recorded figures in three languages", () => {
  const request=resolveCurrentFactualRequest({question:"Harbor field pack price and stock?",semantic:frame(["features"])});
  for(const lang of ["zh-TW","zh-CN","en"] as const){
    const reply=renderUnverifiedFactualNextStep(request,lang);
    assert(!!reply && reply.includes("Harbor field pack"),JSON.stringify(reply));
    assert(!/\b(?:paid|confirmed order|in stock)\b|已付款|已轉交|已转接/iu.test(reply),"unverified lifecycle claim");
  }
});
Deno.test("Task3C: no source-owned current fact, ambiguous product, or private transaction gets no fabricated answer", () => {
  assert(renderUnverifiedFactualNextStep(undefined,"zh-TW")===null,"absence invented");
  const ambiguous=resolveCurrentFactualRequest({question:"Compare AX-QZ81 and BR-998 price and stock",semantic:frame()});
  assert(renderUnverifiedFactualNextStep(ambiguous,"en")===null,"multiple products conflated");
  const order=resolveCurrentFactualRequest({question:"Check my order status, reference AB-12345",semantic:frame()});
  assert(renderUnverifiedFactualNextStep(order,"en")===null,"private order status guessed");
});



Deno.test("Task3C: missing warranty, delivery, refund, booking, subscription and entitlement use specific truthful language",()=>{
 const original=resolveCurrentFactualRequest({question:"CW-SUL70BA 有冇貨？",semantic:frame(["stock"])});
 assert(original.applicable&&original.subject==="CW-SUL70BA","source subject missing");
 const samples:[
  string,string,string
 ][]=[
  ["warranty","保養條款","warranty terms"],
  ["delivery eligibility and schedule","送貨安排","delivery terms"],
  ["refund","退換貨／退款條款","return or refund terms"],
  ["booking availability","預約安排","booking availability"],
  ["subscription renewal","訂閱條款","subscription terms"],
  ["membership entitlement","會員權益","membership entitlement"],
  ["features","產品／服務功能","product or service features"],
 ];
 for(const [fact,zh,en] of samples){
   const request={...original,requested_facts:[fact]};
   const traditional=renderUnverifiedFactualNextStep(request,"zh-TW");
   const english=renderUnverifiedFactualNextStep(request,"en");
   assert(!!traditional&&traditional.includes("CW-SUL70BA")&&traditional.includes(zh),JSON.stringify({fact,traditional}));
   if(fact==="booking availability") assert(!traditional.includes("即時現貨")&&!traditional.includes("即時售價"),
     "appointment availability was conflated with sellable inventory");
   assert(!!english&&english.includes(en)&&english.includes("no transfer has been made"),JSON.stringify({fact,english}));
   assert(!/已轉交|已退款|已預約|已核實|已付款|HK\$[0-9]/u.test(traditional),"unknown business state promoted");
 }
});

// Task3C v3.1 test-plan projection only: verifies source-bound new KB target,
// not a successful network request or paid dispatch receipt.
Deno.test("Task3C v3.1 T05 accepted exact model replaces the near-model candidate for the next KB request",()=>{
 const question="係，就係 CW-SUL70BA，我再睇清楚喇。佢有獨立抽濕功能嗎？";
 const item=demand(question,"product",["independent dehumidification feature"],["CW-SUL70BA"]);
 item.customer_correction=true;
 const originalHistory=[
   {id:"t04-customer",role:"visitor",content:"我上網見到 CWSUL70C，嗰部係咪就係你講嗰部？"},
   {id:"t01-customer",role:"visitor",content:"細房候選係 CW-SUL70BA，有冇變頻？"},
 ];
 const before=JSON.stringify({item,originalHistory});
 const resolved=resolveCurrentFactualRequest({question,source_message_id:"t05-customer",semantic:demanded(item),history:originalHistory});
 assert(resolved.kb_required&&!resolved.needs_subject_clarification&&resolved.query,"T05 confirmed subject was not eligible for fresh factual retrieval");
 const wire=JSON.parse(resolved.query!);
 equal(wire.questions.length,1);
 equal(wire.questions[0].subjects,["CW-SUL70BA"]);
 assert(wire.questions[0].question.includes("獨立抽濕")&&wire.questions[0].requested_facts.includes("independent dehumidification feature"),
   "new requested feature did not reach query projection");
 assert(!JSON.stringify(wire).includes("CWSUL70C"),"unconfirmed near-model leaked into new KB request");
 equal(JSON.stringify({item,originalHistory}),before,"T05 source changed during read resolution");
});
Deno.test("Task3C v3.1 T14 new delivery location/lift/weekend conditions produce a new source-bound KB query",()=>{
 const question="唔去門市喇，送去長沙灣，屋企有lift。最好星期六，唔得星期日都可以。";
 const item=demand(question,"policy",["delivery eligibility and schedule"],["CW-SUL70BA"]);
 item.constraints={district:"長沙灣",elevator:true,preferred_day:"Saturday",fallback_day:"Sunday",pickup:false};
 const semantic=demanded(item);
 semantic.referents=[{ref:"CW-SUL70BA",source:"prior_turn",confidence:0.99}];
 const history=[{id:"t13-customer",role:"visitor",content:"CW-SUL70BA 來源話有2件存貨，星期六之前可以攞到嗎？"}];
 const result=resolveCurrentFactualRequest({question,source_message_id:"t14-customer",semantic,history});
 assert(result.kb_required&&result.query&&!result.needs_subject_clarification,
   "T14 new decision-relevant delivery terms did not produce a KB read target");
 const wire=JSON.parse(result.query!);
 equal(wire.questions.length,1);
 assert(wire.questions[0].question.includes("長沙灣")&&wire.questions[0].question.includes("星期六")&&wire.questions[0].question.includes("星期日"),
   "latest new district/weekend preference dropped from query");
 assert(wire.questions[0].constraints?.elevator===true&&wire.questions[0].constraints?.pickup===false&&
   wire.questions[0].constraints?.fallback_day==="Sunday","delivery conditions/pickup negation missing");
 assert(!JSON.stringify(wire).includes("2件存貨"),"old stock snapshot promoted into new delivery query");
});
Deno.test("Task3C v3.1 T16-A recap-only customer request cannot itself authorize a new paid KB lookup",()=>{
 const question="可唔可以幫我整理已講清楚同仲未核實嘅資料？";
 const result=resolveCurrentFactualRequest({question,semantic:frame(["summary"],null),
   request_decision:{kind:"guidance",continuation:false,general_request:question,merchant_request:null,latest_requirements:question}});
 assert(!result.kb_required&&result.query===null&&result.transaction_required===false,
   "read-only recap was incorrectly promoted to a paid KB query");
});


Deno.test("Task3: grounded AI recommendation stays a read target for elliptical price and stock, never cached merchant facts",()=>{
 const company="demo-company",subject="Harbor Trail Jacket",doc="published-document";
 const prior:FactualRequestHistoryRow[]=[
  {id:"grounded-ai",role:"assistant",content:"We recommend Harbor Trail Jacket for walking.",metadata:{
   control_commit:"ai",b2_expected_company_id:company,b2_source_message_id:"prior-visitor",
   source_message_id:"prior-visitor",rag_api_status:"success",factual_request_subject:subject,
   reference_authority:{decision:"USE_CURRENT_KB",selected_source_id:doc,
    selected_authority_class:"PUBLISHED_KB_SERVICE",provenance:{source_type:"Product",tenant_id:"34"}},
   citation_lineage:{selected_document_id:doc,selected_document_ids:[doc],evidence_chunk_ids:["chunk-1"],
    source_bindings:[{selected_document_id:doc,evidence_chunk_ids:["chunk-1"],
     current_target:{entity_ids:[subject]}}]}}},
  {id:"prior-visitor",role:"visitor",content:"Can you recommend a jacket?"}];
 // New held-out paraphrases are semantic-test inputs, NOT a lexicon or
 // proof that any paid KB request was dispatched.
 for(const [question,facet] of [
  ["How much?","price"],["In stock?","stock"],
  ["¿Sigue disponible?","availability"],
  ["而家仲買得到嗎？","availability"],
  ["現在可以訂購嗎？","purchase availability"],
  ["Is there anything left for delivery?","remaining stock"],
  ["Est-ce encore disponible ?","availability"],
  ["今すぐ注文できますか？","purchase availability"],
 ] as const){
  const result=resolveCurrentFactualRequest({question,source_message_id:"now",trusted_company_id:company,
   history:prior,semantic:demanded(demand(question,"product",[facet],[]))});
  assert(result.subject===subject&&result.subject_source_message_id==="grounded-ai",JSON.stringify(result));
  const retrieval=JSON.parse(result.query!);
  equal(retrieval.questions[0].subjects,[subject]);
  assert(retrieval.questions[0].requested_facts.includes(facet),"new KB query lost the requested facet");
 }
 for(const error of ["company","source","citation","human"]){
  const history=structuredClone(prior),meta=history[0].metadata as Record<string,any>;
  if(error==="source")meta.source_message_id="other-visitor";
  if(error==="citation")meta.citation_lineage.selected_document_ids=["unrelated-document"];
  if(error==="human")history.unshift({id:"agent",role:"agent",content:"I have taken over."});
  const x=resolveCurrentFactualRequest({question:"How much?",source_message_id:"now",
   trusted_company_id:error==="company"?"other-company":company,history,
   semantic:demanded(demand("How much?","product",["price"],[]))});
  assert(x.subject!==subject,"cross-scope historical assistant content trusted: "+error);
 }
});

Deno.test("Task3 P0-1 multilingual semantic re-query never revives a cited product for a non-factual or switched request",()=>{
 const company="merchant-company",subject="Harbor Trail Jacket",doc="published-product";
 const cited:FactualRequestHistoryRow[]=[
  {id:"cited-ai",role:"assistant",content:"We recommend Harbor Trail Jacket for walking.",metadata:{
   control_commit:"ai",b2_expected_company_id:company,b2_source_message_id:"customer-before",
   source_message_id:"customer-before",rag_api_status:"success",factual_request_subject:subject,
   reference_authority:{decision:"USE_CURRENT_KB",selected_source_id:doc,selected_authority_class:"PUBLISHED_KB_SERVICE",
    provenance:{source_type:"Product",tenant_id:"34"}},
   citation_lineage:{selected_document_id:doc,selected_document_ids:[doc],evidence_chunk_ids:["chunk"],
    source_bindings:[{selected_document_id:doc,evidence_chunk_ids:["chunk"],
      current_target:{entity_ids:[subject]}}]}}},
  {id:"customer-before",role:"visitor",content:"Can you recommend a jacket?"}
 ];
 const nonFact="¿Sigue disponible?";
 const framed=demanded(demand(nonFact,"product",["availability"],[]));
 framed.operation="CONVERSATION_MEMORY";
 const negative=resolveCurrentFactualRequest({question:nonFact,source_message_id:"now",
   trusted_company_id:company,history:cited,semantic:framed});
 assert(negative.subject!==subject,"a non-factual semantic operation resurrected a merchant subject");
 const switched="Another topic: is that consultancy available?";
 const changed=resolveCurrentFactualRequest({question:switched,source_message_id:"now",
   trusted_company_id:company,history:cited,semantic:demanded(demand(switched,"product",["availability"],[]))});
 assert(changed.subject!==subject,"explicit topic switch inherited a previous cited product");
});


Deno.test("Task3C cross-industry open-ended fact rejection identifies the actual customer question without inventing an answer",()=>{
  const existing=resolveCurrentFactualRequest({question:"CW-SUL70BA 有冇貨？",semantic:frame(["stock"])});
  assert(existing.applicable&&existing.subject==="CW-SUL70BA"&&existing.demands.length===1,"setup not source-bound");
  const query="佢連續運作六小時時嘅恆溫噪音會達到幾多分貝？";
  const request={...existing,question:query,original_question:query,requested_facts:["continuous operating acoustic rating"],
    demands:[{...existing.demands[0],source_quote:query,question:query,requested_facts:["continuous operating acoustic rating"]}]};
  for(const language of ["zh-TW","zh-CN","en"] as const){
    const reply=renderUnverifiedFactualNextStep(request,language);
    assert(!!reply&&reply.includes("continuous operating acoustic rating")&&reply.includes("CW-SUL70BA"),"open-domain question fell into generic no-answer: "+language);
    assert(!/已核實|已確認|has been transferred|已轉交|已转接|HK\$[0-9]|[0-9]+\s*(?:dB|分貝)/u.test(reply),"unsupported fact or action promoted");
    if(language==="en") assert(!/(?:completed|processed|executed|done|finished).{0,24}(?:action|request|operation|process|booking|reservation)/iu.test(reply),"B2 treats negated completed action as a completion claim");
  }
  const policyQuestion="Is there weekend cancellation coverage for this service?";
  const policy={...request,subject:null,subjects:[],question:policyQuestion,original_question:policyQuestion,
    requested_facts:["weekend cancellation coverage"],demands:[{...request.demands[0],source_type:"policy" as const,
      source_quote:policyQuestion,question:policyQuestion,subjects:[],requested_facts:["weekend cancellation coverage"]}]};
  const policyReply=renderUnverifiedFactualNextStep(policy,"en");
  assert(!!policyReply&&policyReply.includes("weekend cancellation coverage")&&!policyReply.includes("CW-SUL70BA"),"merchant-wide policy reused old product");
  const sensitive={...request,question:"Order #123456 status?",original_question:"Order #123456 status?",
    demands:[{...request.demands[0],source_quote:"Order #123456 status?"}]};
  assert(renderUnverifiedFactualNextStep(sensitive,"en")===null,"sensitive/private source locator repeated");
  assert(renderUnverifiedFactualNextStep({...request,transaction_required:true},"en")===null,"transaction outcome implied from KB");
  assert(renderUnverifiedFactualNextStep({...request,demands:[...request.demands,...request.demands]},"en")===null,
    "multiple independent unanswered demands collapsed into one false-complete response");
});


// P0-0: the genuine Hosted v270 failure was entity_confidence REQUIRED after a
// successful v5 model response. The original decoder must continue rejecting
// that wire. Only a separately complete, single source-quoted read-only demand
// may be projected into a FRESH authenticated KB read; never a state update.
function task3V5MalformedEntity(question: string, mode: "ASK_FACT" | "UPDATE_ITEM" = "ASK_FACT",
  extra: Record<string,unknown> = {}): Record<string,unknown> {
  const sem = {demands:[{question,source_quote:question,subject_refs:[],
      source_type:"product",requested_facts:["merchant model selection and rated capacity"],constraints:{},
      customer_correction:false,explicit_negations:[],
      ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}],
    entities:[{name:"current customer model candidate",kind:"physical_product"}],...extra};
  const walk = (value:unknown,path:string[]=[]):Array<Record<string,unknown>> => {
    const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    return [{path,kind,...(kind === "string" ? {text:value} :
      kind === "number" ? {number:value} : kind === "boolean" ? {boolean:value} : {})},
      ...(["object","array"].includes(kind)
        ? Object.entries(value as object).flatMap(([k,v])=>walk(v,[...path,k])) : [])];
  };
  const nodes=walk(sem).filter(node=>(node.path as string[]).length>0);
  return {context_encoding:"semantic_values_v5",operation:mode,confidence:0.96,
    containers:nodes.filter(n=>["object","array","null"].includes(n.kind)).map(n=>({path:n.path,kind:n.kind})),
    strings:nodes.filter(n=>n.kind==="string").map(n=>({path:n.path,text:n.text})),
    numbers:nodes.filter(n=>n.kind==="number").map(n=>({path:n.path,number:n.number})),
    booleans:nodes.filter(n=>n.kind==="boolean").map(n=>({path:n.path,boolean:n.boolean}))};
}

Deno.test("Task3A P0-0 generic v5 missing optional entity confidence permits only a new read of the full customer question",()=>{
 for(const q of ["大金2匹有咩型號？","What 2 HP air conditioner models are offered?",
   "有沒有適合兩位的預約服務項目？","Quels sont les modèles disponibles ?"]){
  const proposed=task3V5MalformedEntity(q);
  let diagnostic: any, code: unknown;
  const rejected=decodeCommerceSemanticWire(proposed,(r,d)=>{code=r;diagnostic=d;});
  assert(rejected===null&&code==="wire_context_nodes"&&
    diagnostic?.field_class==="entity_confidence"&&diagnostic?.reason==="required",
    "the existing strict decoder must still reject the model's invalid entity");
  const recovered=recoverSourceQuotedReadOnlyFactualFrame(proposed,q,diagnostic);
  assert(!!recovered&&recovered.operation==="ASK_FACT"&&recovered.entities.length===0 &&
    (recovered.customer_facts?.length ?? 0)===0&&recovered.demands?.length===1,
    "read-only recovery changed state or lost the exact demand");
  const actual=resolveCurrentFactualRequest({question:q,semantic:recovered,source_message_id:"source-current",
    trusted_company_id:"company-actual",history:[]});
  assert(actual.kb_required&&!!actual.query&&actual.query.includes(q.normalize("NFKC")) &&
    actual.demands.length===1,"source-quoted factual demand did not reach the original KB query builder");
  assert(recovered.demands![0].source_quote===q.normalize("NFKC"),"source quoted demand was changed");
 }
});
Deno.test("Task3A P0-0 v5 read-only recovery rejects missing clauses, mutation, contradiction, ambiguous and private action",()=>{
 const q="大金2匹有咩型號？";
 const baseline=task3V5MalformedEntity(q);
 let diagnostic: any;
 decodeCommerceSemanticWire(baseline,(_r,d)=>{diagnostic=d;});
 const admit=(wire:Record<string,unknown>,source=q)=>
   recoverSourceQuotedReadOnlyFactualFrame(wire,source,diagnostic);
 assert(admit(baseline)!==null,"known original diagnostic did not enable bounded recovery");
 assert(admit(baseline,q+"另外收費呢？")===null,"source quote did not cover all independently requested clauses");
 assert(admit(task3V5MalformedEntity(q,"UPDATE_ITEM"))===null,"state mutation accepted as read only");
 assert(admit(task3V5MalformedEntity(q,"ASK_FACT",{customer_facts:[{key:"quantity",value:2}]}))===null,"new customer state silently lost");
 assert(admit(task3V5MalformedEntity(q,"ASK_FACT",{customer_correction:true}))===null,"correction silently ignored");
 assert(admit(task3V5MalformedEntity(q,"ASK_FACT",{transaction_state:"confirmed"}))===null,"transaction confirmation ignored");
 assert(admit(task3V5MalformedEntity(q,"ASK_FACT",{explicit_negations:["do not book"]}))===null,"negation silently dropped");
 assert(admit(task3V5MalformedEntity(q,"ASK_FACT",{demands:[{question:q,source_quote:q,subject_refs:[],source_type:"transaction",
   requested_facts:["order status"],constraints:{},customer_correction:false,explicit_negations:[],
   ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}]}))===null,"private transaction routed to merchant KB");
 assert(admit(task3V5MalformedEntity(q,"ASK_FACT",{demands:[]}))===null,"missing customer demand inferred");
 const ambiguous=task3V5MalformedEntity(q,"ASK_FACT",{ambiguity:{is_ambiguous:true,reasons:["unclear"],clarification_question:"Which one?"}});
 assert(admit(ambiguous)===null,"model uncertainty dropped to force a KB call");
});

Deno.test("Task3A source-only semantic contract: open-domain factual questions prefer full sourced demands over dummy entities",()=>{
 const prompt=COMMERCE_SEMANTIC_SYSTEM_PROMPT;
 assert(prompt.includes("do not create or repeat optional entities")&&prompt.includes("Source quote must be an exact contiguous substring"),
  "semantic provider has no guidance to prevent the observed malformed entity / paraphrased source quote");
 assert(prompt.includes("independently answerable requests"),"general multi-clause demand preservation was lost");
});


Deno.test("Task3A generic source-quote mismatch only rebuilds a complete read from authentic multilingual customer text",()=>{
 for(const [customer,model] of [
  ["我想買衫，有冇介紹","我想買衫，有冇介紹？"],
  ["大金2匹有咩型號","大金2匹有咩型號？"],
  ["Could you recommend a rental option","Could you recommend a rental option?"],
  ["Quels modèles sont proposés ?","Quels modèles sont proposés?"]
 ]){
  const semantic=frame(["published merchant options"],null);semantic.operation="ASK_FACT";semantic.intent="recommend_options";
  semantic.demands=[demand(model,"product",["published merchant options"],["old-unbound-SKU"])];
  const original=structuredClone(semantic);
  const safe=rebindSourceQuotedReadOnlyDemand(semantic,customer);
  assert(!!safe&&safe.operation==="ASK_FACT"&&safe.demands?.length===1,"safe read was not projected");
  equal(safe.demands[0].source_quote,customer.normalize("NFKC"));
  equal(safe.demands[0].question,customer.normalize("NFKC"));
  equal(safe.demands[0].subject_refs,[]);equal(safe.entities,[]);equal(safe.referents,[]);
  const current=resolveCurrentFactualRequest({question:customer,semantic:safe,source_message_id:"new-source",
   trusted_company_id:"own-company",history:[]});
  assert(current.kb_required&&!!current.query&&current.query.includes(customer.normalize("NFKC"))&&
   !current.query.includes("old-unbound-SKU"),"stale subject reached retrieval");
  equal(semantic,original,"semantic frame was mutated");
 }
});
Deno.test("Task3A generic source-quote recovery fails closed on mixed, uncertain and stateful cases",()=>{
 const source="我想買衫，有冇介紹";
 const build=()=>{const v=frame(["product options"],null);v.operation="ASK_FACT";
   v.demands=[demand(source+"?","product",["product options"],[])];return v;};
 const check=(edit:(v:CommerceSemanticFrame)=>void,q=source)=>{const v=build();edit(v);return rebindSourceQuotedReadOnlyDemand(v,q);};
 assert(rebindSourceQuotedReadOnlyDemand(build(),source)!==null,"equivalent punctuation must remain eligible for a safe factual read");
 assert(check(v=>{v.demands![0].source_quote="PRIVATE-INVENTED-CUSTOMER-CLAUSE";})===null,
   "invented model source quote was silently replaced by customer text");
 assert(check(v=>{v.demands![0].source_quote="我想买衣服，有推荐吗";})===null,
   "unproved cross-language paraphrase became source authority");
 assert(check(v=>v.demands!.push(demand("refund policy","policy",["refund"])))===null,"independent demand lost");
 assert(check(v=>v.customer_facts=[{key:"quantity",value:2}])===null,"customer-owned fact lost");
 assert(check(v=>v.customer_correction=true)===null,"correction lost");
 assert(check(v=>v.explicit_negations=["do not buy"])===null,"negation lost");
 assert(check(v=>v.transaction_state="confirmed")===null,"order promoted");
 assert(check(v=>v.payment_state="paid")===null,"payment promoted");
 assert(check(v=>v.booking_state="booked")===null,"booking promoted");
 assert(check(v=>v.demands![0].source_type="transaction")===null,"private transaction forwarded");
 assert(check(v=>v.demands![0].constraints={district:"Kowloon"})===null,"scope constraints dropped");
 assert(check(v=>v.ambiguity.is_ambiguous=true)===null,"ambiguous demand promoted");
 assert(check(v=>v.confidence=.2)===null,"low-confidence demand promoted");
 assert(check(v=>{},"請取消上一個訂單，想買衫")===null,"cancel intent ignored");
 assert(check(v=>{},"我想買衫；另一件查退款")===null,"multiple sentences collapsed");
 const exact=build();exact.demands![0].source_quote=source;
 assert(rebindSourceQuotedReadOnlyDemand(exact,source)===null,"already correct source quote rewritten");
});


Deno.test("Task3A/3B/3C generic category discovery never requires an already-known SKU before KB",()=>{
 for(const [question,facet,intent] of [
  ["大金2匹有咩型號？","available 2HP product models","ask_product_facts"],
  ["Which rental plans do you currently offer?","available rental plans","explore_options"],
  ["推薦適合家庭用嘅空氣淨化產品","recommended catalogue choices","recommend_options"],
  ["Quels modèles sont proposés ?","offered models","explore_options"],
  ["What subscription packages can I choose?","available subscription packages","explore_options"],
 ] as const){
  const proposal=demanded(demand(question,"product",[facet],["model-suggested-without-source"]));
  proposal.intent=intent;proposal.demands![0].ambiguity={is_ambiguous:true,reasons:["no specific SKU"],clarification_question:"Which SKU?"};
  const result=resolveCurrentFactualRequest({question,source_message_id:"current",
    trusted_company_id:"merchant",semantic:proposal,history:[]});
  assert(result.kb_required&&!result.needs_subject_clarification&&result.subject===null &&
   result.demands.length===1&&!result.demands[0].ambiguity.is_ambiguous,JSON.stringify(result));
  const query=JSON.parse(result.query!);
  assert(query.questions.length===1&&query.questions[0].question===question.normalize("NFKC") &&
   query.questions[0].subjects.length===0&&!result.query!.includes("model-suggested-without-source"),
   "merchant discovery incorrectly demands model/forwards invented SKU");
 }
});
Deno.test("Task3A/3B/3C B2-scoped clarification carries an original unresolved option request to NEW KB read",()=>{
 const company="own-tenant", original="大金2匹有咩型號？";
 const clarification=(visitorId:string):FactualRequestHistoryRow=>({
   id:"reply-"+visitorId,role:"assistant",content:"Which current product or model?",
   metadata:{response_route:"product_referent_clarification",
      product_referent_candidates:[],control_commit:"ai",b2_expected_company_id:company,
      b2_source_message_id:visitorId,source_message_id:visitorId},
 });
 const originalVisitor:FactualRequestHistoryRow={id:"customer-original",role:"visitor",content:original};
 const read=(question:string,history:FactualRequestHistoryRow[],tenant=company,semantic=frame(["product options"],null))=>
   resolveCurrentFactualRequest({question,source_message_id:"current",trusted_company_id:tenant,
     semantic,history});
 const initial=read("現行產品",[clarification("customer-original"),originalVisitor]);
 assert(initial.kb_required&&initial.resolution==="follow_up"&&!initial.needs_subject_clarification &&
  initial.query?.includes(original.normalize("NFKC"))&&initial.query.includes("現行產品"),
  JSON.stringify(initial));
 const plan=planConversationService({question:initial.answer_request!,factual_request:initial,
  semantic_frame:frame(["product options"]),language:"zh-TW",memory:null,commerce:null,recall:{handled:false}});
 assert(plan.knowledge_state==="lookup_required"&&plan.kb_query===initial.query,
  "a resolved clarification failed to trigger the actual new KB adapter route");
 const history=[clarification("customer-intermediate"),{id:"customer-intermediate",role:"visitor",content:"現行產品"},
  clarification("customer-original"),originalVisitor];
 const second=read("上面已經講咗係大金",history);
 assert(second.kb_required&&!second.needs_subject_clarification &&
  second.query?.includes(original.normalize("NFKC")) &&
  !second.query.includes("Which current product or model"),
  "clarification loop failed to restore original user-owned question");
 for(const variant of ["現行產品","Current offerings","只查現有款式"]){
  const a=read(variant,[clarification("customer-original"),originalVisitor]);
  assert(a.kb_required&&!a.needs_subject_clarification,"cross-language non-mutating clarification lost the source");
 }
 // Only B2-committed same-tenant assistant receipts, linked to an actual
 // visitor source, can reopen historical reads. Other origins stay closed.
 for(const mutation of ["tenant","source","control","human","topic","transaction"]){
  const rows=structuredClone([clarification("customer-original"),originalVisitor]);
  if(mutation==="tenant")(rows[0].metadata as Record<string,any>).b2_expected_company_id="other";
  if(mutation==="source")(rows[0].metadata as Record<string,any>).b2_source_message_id="wrong";
  if(mutation==="control")(rows[0].metadata as Record<string,any>).control_commit="human";
  if(mutation==="human")rows.unshift({id:"agent",role:"agent",content:"I took over"});
  const q=mutation==="topic"?"Different topic: the return policy":mutation==="transaction"?"Cancel that booking":"現行產品";
  const a=read(q,rows);
  assert(a.interpretation_source!=="semantic_demands"||a.context_turns.length===0 ||
      !a.context_turns.includes(original.normalize("NFKC")),
      "invalid or different-source clarification inherited old query: "+mutation);
 }
});
Deno.test("Task3A/3B/3C protected specific subjects, mixed transactions and uncertain comparative selections",()=>{
 for(const [question,subject] of [
  ["AX-QZ81 有咩型號？","AX-QZ81"],
  ["Compare AX-QZ81 and BR-998 available models","AX-QZ81"],
 ] as const){
  const sem=demanded(demand(question,"product",["models"],[subject]));sem.intent="explore_options";
  const r=resolveCurrentFactualRequest({question,source_message_id:"current",semantic:sem});
  assert(!(r.kb_required&&r.subjects.length===0&&!r.needs_subject_clarification),
    "exact item/comparison identity was silently converted to category discovery");
 }
 const q="Where is order AB-12345 and what products are available?";
 const trans=demand(q,"transaction",["order status"],["AB-12345"]);
 const other=demand(q,"product",["available products"],[]);
 const mixed=demanded(trans,other);mixed.intent="explore_options";
 const out=resolveCurrentFactualRequest({question:q,semantic:mixed});
 assert(out.transaction_required && !out.query?.includes("AB-12345"),
  "a live transaction identifier entered discovery KB");
});
