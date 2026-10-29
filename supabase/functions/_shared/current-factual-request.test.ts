import { resolveCurrentFactualRequest, type FactualRequestHistoryRow } from "./current-factual-request.ts";
import { scopedServiceKnowledgeQuery } from "./service-semantic-routing.ts";
import { buildCanonicalRetrievalQuery } from "./conversation-runtime-state-core.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import type { CommerceSemanticDemand, CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
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
