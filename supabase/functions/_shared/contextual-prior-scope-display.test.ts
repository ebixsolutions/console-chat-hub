import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { normalizeCommerceSemanticFrame, type CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import {
  contextualUpdateEvents, resolveContextualCustomerUpdate, resolveSemanticContextualCandidate,
  verifiedCurrentScopeFacts, type ContextualSourceContext, type ScopedCustomerValue,
  type SourceBoundContextualGoal, type SourceBoundScopeFact,
} from "./contextual-customer-update.ts";
import { reduceCommerceState } from "./commerce-state-reducer.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function baseFrame(language: "en" | "zh-TW", subject: string): CommerceSemanticFrame {
  return { version: "commerce-semantic-1.0.0", language, operation: "UPDATE_ITEM",
    intent: "customer_guidance", topic: subject, entities: [], referents: [],
    requested_facts: [], customer_correction: false, additive: false, explicit_negations: [],
    transaction_state: "none", payment_state: "none", booking_state: "none", fulfillment_state: "none",
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null }, confidence: 0.99 };
}

/** Unit-level committed snapshot; the separate runtime suite exercises CAS/readback. */
function inheritedAllocation(language: "en" | "zh-TW" = "en") {
  const english = language === "en", subject = english ? "Training sessions" : "冷氣";
  const scope = english ? "teams" : "房", priorQuote = english ? "2 teams" : "兩間房";
  const text = english
    ? "Training sessions for 2 teams. Note PRIVATE_NOTE_DO_NOT_ECHO."
    : "冷氣，兩間房，先了解選擇。備註 PRIVATE_NOTE_DO_NOT_ECHO。";
  const firstFrame = baseFrame(language, subject);
  firstFrame.customer_facts = [{ key: "contextual_scope_counts", value: [
    { scope, count: 2, source_text: priorQuote, subject_label: subject },
  ] }];
  firstFrame.demands = [{ question: text, source_quote: text, subject_refs: [subject], source_type: "general",
    requested_facts: [], constraints: {}, customer_correction: false, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  const context: ContextualSourceContext = { company_id: "company", conversation_id: "ticket",
    source_message_id: "source-t1", state_revision: 0 };
  const decodedFirst = normalizeCommerceSemanticFrame(firstFrame);
  assert(decodedFirst, "The source-only scope producer must satisfy the existing contract");
  const state = createEmptyConversationCommerceState();
  const verified = verifiedCurrentScopeFacts({ text, state, semantic_frame: decodedFirst, context });
  assert(verified, "The source-only counted scope must independently verify");
  state.current_topic = subject;
  state.customer_constraints.contextual_goal = { ...verified.goal, recorded_revision: 1 };
  state.customer_constraints.contextual_scope_facts = verified.facts.map(fact => ({ ...fact, recorded_revision: 1 }));
  const unit = english ? "slots" : "部", each = english ? 2 : 1;
  const currentQuote = english ? "teams 2 slots each" : "房各一部";
  const singletonQuote = english ? "lobby 1 slots" : "廳一部";
  const frame = baseFrame(language, subject); frame.intent = "scoped allocation";
  frame.entities = [{ entity_ref: verified.goal.goal_id, name: subject,
    kind: english ? "service" : "physical_product", category_hint: subject, sku: null, model: null,
    quantity: null, unit, attributes: { scoped_customer_updates: [
      { scope: english ? "lobby" : "廳", source_text: singletonQuote, unit, value: 1, attribute: "quantity", action: "set" },
      { scope, source_text: currentQuote, unit, value: each, scope_count: null,
        per_scope_quantity: each, attribute: "quantity", action: "set" },
    ] }, constraints: {}, capabilities: { requires_delivery: false, supports_pickup: false,
      requires_installation: false, requires_booking: false, requires_quote: false, requires_site_check: false,
      digital_fulfilment: false, recurring_billing: false, rental_return: false, customization: false }, confidence: 0.99 }];
  frame.referents = [{ ref: verified.goal.goal_id, source: "persistent_state", confidence: 0.99 }];
  const decoded = normalizeCommerceSemanticFrame(frame);
  assert(decoded, "The allocation producer must satisfy the existing contract");
  return { text: singletonQuote + (english ? ", " : "，") + currentQuote, language, state,
    semantic_frame: decoded, context: { ...context, source_message_id: "source-t2", state_revision: 1 } };
}

Deno.test("Prior scope display preserves both Chinese source quotes and canonical receipt bytes", () => {
  const input = inheritedAllocation("zh-TW"), before = JSON.stringify(input.state);
  const candidate = resolveSemanticContextualCandidate(input);
  assert(candidate?.context_sufficient && candidate.aggregate_quantity === 3, JSON.stringify(candidate));
  assert(candidate.reply.includes("廳一部") && candidate.reply.includes("房各一部（兩間房）"), candidate.reply);
  assert(!candidate.reply.includes("客廳") && !candidate.reply.includes("三部") &&
    !candidate.reply.includes("#") && !candidate.reply.includes("PRIVATE_NOTE_DO_NOT_ECHO"), candidate.reply);
  const members = candidate.values.filter(row => row.group_scope === "房");
  assert(members.length === 2 && members[0].scope === "房#1" && members[1].scope === "房#2" &&
    members.every(row => row.source_text === "房各一部" && row.scope_count_source?.source_text === "兩間房" &&
      row.scope_count_source.source_message_id === "source-t1" && row.scope_count_source.source_revision === 1), JSON.stringify(members));
  assert(JSON.stringify(input.state) === before, "Display mutated the committed snapshot");
  const next = reduceCommerceState(input.state, contextualUpdateEvents(
    resolveContextualCustomerUpdate({ state: input.state, candidate }), input.state, "source-t2", null, 2));
  const rows = next.entities[0].attributes.scoped_customer_updates as ScopedCustomerValue[];
  assert(rows.filter(row => row.group_scope === "房").every(row => row.source_text === "房各一部" &&
    row.source_message_id === "source-t2" && row.source_revision === 2 &&
    row.scope_count_source?.source_text === "兩間房"), JSON.stringify(rows));
  assert(JSON.stringify(next.customer_constraints) === JSON.stringify(input.state.customer_constraints),
    "Display rewrote the scope-count source ledger");
});

Deno.test("Prior scope display supports English source-count quotes without unrelated prior text", () => {
  const input = inheritedAllocation(), candidate = resolveSemanticContextualCandidate(input);
  assert(candidate?.context_sufficient && candidate.aggregate_quantity === 5 &&
    candidate.reply.includes("teams 2 slots each (2 teams)") && candidate.reply.includes("lobby 1 slots"), JSON.stringify(candidate));
  assert(!candidate.reply.includes("PRIVATE_NOTE_DO_NOT_ECHO") && !candidate.reply.includes("teams#"), candidate.reply);
  assert(candidate.values.filter(row => row.group_scope === "teams").every(row =>
    row.source_text === "teams 2 slots each" && row.scope_count_source?.source_text === "2 teams"), JSON.stringify(candidate.values));
});

Deno.test("Current-turn counted allocations do not append a prior count receipt", () => {
  const input = inheritedAllocation(), quote = "2 teams with 2 slots each";
  input.text = "lobby 1 slots, " + quote;
  const rows = input.semantic_frame.entities[0].attributes.scoped_customer_updates as Record<string, unknown>[];
  rows[1].source_text = quote; rows[1].scope_count = 2;
  const candidate = resolveSemanticContextualCandidate(input);
  assert(candidate?.context_sufficient && candidate.reply.includes(quote) &&
    !candidate.reply.includes("(2 teams)") &&
    candidate.values.filter(row => row.group_scope === "teams").every(row => !row.scope_count_source), JSON.stringify(candidate));
});

Deno.test("Prior scope display follows the verified corrected count and preserves its source", () => {
  const input = inheritedAllocation(), text = "Training sessions for 3 teams. Please correct the scope count.";
  const frame = baseFrame("en", "Training sessions"); frame.customer_correction = true;
  frame.customer_facts = [{ key: "contextual_scope_counts", value: [
    { scope: "teams", count: 3, source_text: "3 teams", subject_label: "Training sessions" },
  ] }];
  frame.demands = [{ question: text, source_quote: text, subject_refs: ["Training sessions"], source_type: "general",
    requested_facts: [], constraints: {}, customer_correction: true, explicit_negations: [],
    ambiguity: { is_ambiguous: false, reasons: [], clarification_question: null } }];
  const verified = verifiedCurrentScopeFacts({ text, state: input.state, semantic_frame: frame,
    context: { ...input.context, source_message_id: "source-correction" } });
  assert(verified, "A source-quoted correction must verify before it is displayed");
  input.state.customer_constraints.contextual_scope_facts = verified.facts.map(fact => ({ ...fact, recorded_revision: 2 }));
  input.context.state_revision = 2;
  const before = JSON.stringify(input.state), candidate = resolveSemanticContextualCandidate(input);
  assert(candidate?.context_sufficient && candidate.aggregate_quantity === 7 &&
    candidate.reply.includes("teams 2 slots each (3 teams)") && !candidate.reply.includes("(2 teams)"), JSON.stringify(candidate));
  assert(candidate.values.filter(row => row.group_scope === "teams").every(row =>
    row.scope_count_source?.source_message_id === "source-correction" && row.scope_count_source.source_revision === 2),
    JSON.stringify(candidate.values));
  assert(JSON.stringify(input.state) === before, "Display altered correction provenance");
});

Deno.test("Prior scope display never exposes stale foreign or unverified count receipts", () => {
  const mutate: Array<(input: ReturnType<typeof inheritedAllocation>) => void> = [
    input => { input.context.state_revision = 0; },
    input => { input.context.company_id = "other-company"; },
    input => { input.context.conversation_id = "other-ticket"; },
    input => { (input.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[0].recorded_revision = 2; },
    input => { (input.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[0].company_id = "other-company"; },
    input => { (input.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[0].conversation_id = "other-ticket"; },
    input => { (input.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[0].goal_id = "contextual-goal:foreign"; },
    input => { (input.state.customer_constraints.contextual_goal as SourceBoundContextualGoal).status = "cancelled"; },
    input => { (input.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[0].source_text = "3 teams"; },
    input => { (input.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[0].source_text = "2 teams PRIVATE_NOTE_DO_NOT_ECHO"; },
    input => { (input.state.customer_constraints.contextual_scope_facts as SourceBoundScopeFact[])[0].source_message_id = input.context.source_message_id; },
  ];
  for (const change of mutate) {
    const input = inheritedAllocation(); change(input); const before = JSON.stringify(input.state);
    const candidate = resolveSemanticContextualCandidate(input);
    assert(!candidate?.context_sufficient && !candidate?.values.length, JSON.stringify(candidate));
    assert(!candidate?.reply.includes("teams 2 slots each") && !candidate?.reply.includes("2 teams") &&
      !candidate?.reply.includes("3 teams") && !candidate?.reply.includes("PRIVATE_NOTE_DO_NOT_ECHO"), JSON.stringify(candidate));
    assert(JSON.stringify(input.state) === before, "Rejected display proposal changed canonical state");
  }
});
