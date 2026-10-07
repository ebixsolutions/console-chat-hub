import { normalizeCommerceSemanticFrame, type CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { planConversationService, renderServicePlanReply, renderTargetedServiceQuestion } from "./conversation-service-planner.ts";
import { requiresSemanticKnowledge, scopedServiceKnowledgeQuery } from "./service-semantic-routing.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function frame(topic: string, intent = "explore_options"): CommerceSemanticFrame {
  const parsed = normalizeCommerceSemanticFrame({
    version: "commerce-semantic-1.0.0", language: "en", operation: "ASK_FACT", intent, topic,
    entities: [], referents: [], customer_correction: false, additive: false, explicit_negations: [],
    requested_facts: ["published options", "eligibility"], transaction_state: "none", payment_state: "none",
    booking_state: "none", fulfillment_state: "none", ambiguity: {is_ambiguous: false, reasons: [], clarification_question: null}, confidence: .9,
  });
  assert(parsed, "canonical semantic frame rejected"); return parsed;
}

Deno.test("generic service planning uses category evidence before demanding a model across commerce kinds", () => {
  for (const topic of ["portable art scanner", "instrument tuning service", "studio rental", "archive subscription", "downloadable pattern"]) {
    const semantic = frame(topic);
    const plan = planConversationService({question: `Help me choose ${topic}`, semantic_frame: semantic,
      language: "en", recall: {handled: false, reason: "NOT_A_RECALL_QUERY"}, memory: null, commerce: null});
    assert(plan.action === "published_kb_lookup" && plan.knowledge_state === "lookup_required", topic);
    assert(plan.kb_query?.includes(topic) && plan.kb_query.includes("eligibility"), "semantic concepts not forwarded");
    assert(renderServicePlanReply(plan, null) === null, "fixed prose bypassed actual retrieval");
  }
});

Deno.test("topic return re-queries corrected active requirements without unrelated or cancelled entities", () => {
  const state = createEmptyConversationCommerceState();
  state.current_topic = "studio rental";
  state.entities = [
    {entity_id:"generic:studio", category:"studio rental", quantity:1, status:"researching", attributes:{product_name:"Atrium studio"}, constraints:{capacity:8}, provenance:{source_type:"customer",source_message_id:"corrected"}},
    {entity_id:"generic:scanner", category:"scanner", quantity:1, status:"researching", attributes:{product_name:"OTHER-SCANNER"}, constraints:{}, provenance:{source_type:"customer",source_message_id:"other"}},
    {entity_id:"generic:old-studio", category:"studio rental", quantity:1, status:"cancelled", attributes:{product_name:"CANCELLED-STUDIO"}, constraints:{capacity:20}, provenance:{source_type:"customer",source_message_id:"cancelled"}},
  ];
  const before = JSON.stringify(state);
  const semantic = frame("studio rental");
  const query = scopedServiceKnowledgeQuery("Back to the studio: what options fit?", semantic, state);
  assert(query.includes("Atrium studio") && query.includes("8"), "corrected active scope omitted");
  assert(!query.includes("OTHER-SCANNER") && !query.includes("CANCELLED-STUDIO") && !query.includes("20"), "cross-topic or inactive requirements leaked");
  assert(JSON.stringify(state) === before, "read planner mutated authoritative state");
});

Deno.test("uncertain semantic references ask once and cannot trigger a read or confirmation", () => {
  for (const confidence of [.4, .9]) {
    const semantic = frame("membership"); semantic.confidence = confidence;
    semantic.ambiguity = {is_ambiguous:true,reasons:["two plausible memberships"],clarification_question:"Which membership?"};
    assert(!requiresSemanticKnowledge(semantic), "ambiguity authorized a lookup");
    const plan = planConversationService({question:"That one",semantic_frame:semantic,language:"en",recall:{handled:false},memory:null,commerce:null});
    assert(plan.action === "targeted_clarification" && plan.kb_query === null, "uncertain reference routed as fact");
    const reply = renderServicePlanReply(plan,null) ?? renderTargetedServiceQuestion(plan,"en");
    assert(reply.includes("?") && !/booked|paid|confirmed|delivered/i.test(reply), "clarification promoted transaction state");
  }
});
