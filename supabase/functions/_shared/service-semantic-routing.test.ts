import "./f13-llm-failure.test.ts";
import "./f13-f14-root-cause.test.ts";
import { normalizeCommerceSemanticFrame, type CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";
import { planConversationService, renderServicePlanReply, renderTargetedServiceQuestion } from "./conversation-service-planner.ts";
import { requiresSemanticKnowledge, scopedServiceKnowledgeQuery } from "./service-semantic-routing.ts";
import { DecisionContextLimitError, normalizeDecisionContext } from "./bounded-decision-context.ts";
import { semanticFrameToEntityHints } from "./commerce-semantic-adapter.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw Error(message); }

function constrainedQuery(constraints: Record<string, unknown>): string {
  const state = createEmptyConversationCommerceState();
  state.current_topic = "studio rental";
  state.entities = [{entity_id:"generic:studio", category:"studio rental", quantity:1,
    status:"researching", attributes:{product_name:"Atrium studio"}, constraints,
    provenance:{source_type:"customer",source_message_id:"prior"}}];
  return scopedServiceKnowledgeQuery("Which options fit my requirements?", null, state);
}

Deno.test("decision-relevant query distinctions survive boolean, field and array counterfactuals", () => {
  for (const [a,b] of [
    [{requires_stairs:false},{requires_stairs:true}],
    [{max_people:8},{minimum_hours:8}],
    [{equipment:["wheelchair ramp"]},{equipment:["soundproof booth"]}],
  ]) assert(constrainedQuery(a) !== constrainedQuery(b), "Decision-relevant query context collapsed");
});

Deno.test("new merchant fact request is not swallowed by handled historical recall", () => {
  const plan = planConversationService({question:"Recap my previous options and check current eligibility",
    semantic_frame:frame("studio rental"),language:"en",recall:{handled:true,fact_type:"summary"},memory:null,commerce:null});
  assert(plan.action === "published_kb_lookup" && plan.knowledge_state === "lookup_required", "read-only recall swallowed new fact request");
});

Deno.test("query keeps field paths, units, operators, false, zero, null and arrays as data", () => {
  const requirements={capacity:{operator:"at_least",value:8,unit:"people"},duration:{operator:"at_most",value:8,unit:"hours"},
    requires_stairs:false,deposit:0,availability:null,equipment:["wheelchair ramp","soundproof booth"]};
  const c=JSON.parse(constrainedQuery(requirements));
  assert(c.question==="Which options fit my requirements?", "actual question lost");
  assert(JSON.stringify(c.prior[0].constraints)===JSON.stringify(normalizeDecisionContext(requirements)), "typed decision context altered");
  assert(c.prior[0].constraints.requires_stairs===false && c.prior[0].constraints.deposit===0 && c.prior[0].constraints.availability===null, "unknown/false/zero conflated");
});

Deno.test("semantic proposal normalization and adapter preserve bounded nested requirements", () => {
  const semantic=frame("document digitization service");
  semantic.entities=[{entity_ref:"generic:archive",name:"Archive service",kind:"service",category_hint:"document digitization service",
    sku:null,model:null,quantity:1,unit:"box",attributes:{format:["TIFF","PDF"]},
    constraints:{resolution:{operator:"minimum",value:400,unit:"dpi"},colour:false},
    capabilities:{requires_delivery:false,supports_pickup:false,requires_installation:false,requires_booking:false,requires_quote:true,requires_site_check:false,digital_fulfilment:true,recurring_billing:false,rental_return:false,customization:false},confidence:.9}];
  const validated=normalizeCommerceSemanticFrame(semantic);
  assert(validated, "valid bounded proposal rejected");
  const hints=semanticFrameToEntityHints(validated);
  assert(JSON.stringify(hints[0].constraints)===JSON.stringify(validated.entities[0].constraints), "adapter dropped typed restrictions");
  const c=JSON.parse(scopedServiceKnowledgeQuery("Can it meet these requirements?",validated,null));
  assert(c.current[0].constraints.resolution.unit==="dpi" && c.current[0].constraints.colour===false, "semantic projection dropped unit or negation");
});

Deno.test("latest same-subject correction retains other active requirements without stale alternatives", () => {
  const state=createEmptyConversationCommerceState();state.current_topic="studio rental";
  state.entities=[{entity_id:"generic:studio",category:"studio rental",quantity:1,status:"researching",attributes:{product_name:"Atrium studio"},
    constraints:{requires_stairs:true,max_people:8,fee:{value:50,unit:"HKD",operator:"maximum"}},provenance:{source_type:"customer",source_message_id:"old"}}];
  const semantic=frame("studio rental");semantic.entities=[{...frameEntity(),constraints:{requires_stairs:false,fee:{value:0}}}];
  const c=JSON.parse(scopedServiceKnowledgeQuery("No stairs, and the deposit must be zero",semantic,state));
  assert(c.prior.length===0 && c.current[0].constraints.requires_stairs===false && c.current[0].constraints.max_people===8, "latest correction lost retained scope");
  assert(c.current[0].constraints.fee.value===0 && c.current[0].constraints.fee.unit==="HKD", "partial correction lost unit");
});

function frameEntity(): CommerceSemanticFrame["entities"][number] {
  return {entity_ref:"generic:studio",name:"Atrium studio",kind:"rental",category_hint:"studio rental",sku:null,model:null,quantity:null,unit:null,
    attributes:{},constraints:{},capabilities:{requires_delivery:false,supports_pickup:false,requires_installation:false,requires_booking:false,requires_quote:false,requires_site_check:false,digital_fulfilment:false,recurring_billing:false,rental_return:true,customization:false},confidence:.9};
}

Deno.test("mutually exclusive isolated KB options match retained conditions, not query hashes", () => {
  // Local read-only semantic oracle, not a production retrieval or quality score.
  const docs=[{id:"accessible-short",stairs:false,people:8,hours:2,equipment:["wheelchair ramp"]},
    {id:"upstairs-long",stairs:true,people:4,hours:8,equipment:["soundproof booth"]}];
  const retrieve=(constraints:Record<string,unknown>) => {
    const q=JSON.parse(constrainedQuery(constraints)).prior[0].constraints;
    return docs.filter(d => (q.requires_stairs===undefined || d.stairs===q.requires_stairs) &&
      (q.max_people===undefined || d.people<=q.max_people) && (q.minimum_hours===undefined || d.hours>=q.minimum_hours) &&
      (q.equipment===undefined || q.equipment.every((item:string)=>d.equipment.includes(item)))).map(d=>d.id);
  };
  assert(JSON.stringify(retrieve({requires_stairs:false,equipment:["wheelchair ramp"]}))==='["accessible-short"]', "inapplicable stairs option selected");
  assert(JSON.stringify(retrieve({minimum_hours:8,equipment:["soundproof booth"]}))==='["upstairs-long"]', "duration or equipment ignored");
  assert(retrieve({requires_stairs:false,minimum_hours:8}).length===0, "incompatible requirements became a false match");
});

Deno.test("equivalent object order is stable, secrets excluded and state immutable", () => {
  const a=constrainedQuery({minimum_hours:8,requires_stairs:false});
  const b=constrainedQuery({requires_stairs:false,minimum_hours:8});assert(a===b,"object ordering changed semantic query");
  const c=constrainedQuery({requires_stairs:false,api_token:"PRIVATE_SENTINEL",customer_email:"PRIVATE_CONTACT"});
  assert(!c.includes("PRIVATE_SENTINEL")&&!c.includes("PRIVATE_CONTACT"),"private context leaked");
  const data={requirement:{unit:"mm",value:0},equipment:["no sharp edges"]};const before=JSON.stringify(data);
  normalizeDecisionContext(data);assert(JSON.stringify(data)===before,"serializer mutated state");
});

Deno.test("bounded context refuses excess rather than silently removing current question or negation", () => {
  for (const constraints of [{a:{b:{c:{d:false}}}},{equipment:Array(13).fill("item")},{requirement:"x".repeat(301)}]) {
    let rejected=false;try { constrainedQuery(constraints); } catch(e) { rejected=e instanceof DecisionContextLimitError; }
    assert(rejected,"oversized context silently truncated");
  }
  const semantic=frame("studio rental");semantic.explicit_negations=["no stairs"];
  const q=JSON.parse(scopedServiceKnowledgeQuery("Which fits?",semantic,null));assert(q.explicit_negations.includes("no stairs"),"explicit negation lost");
  const state=createEmptyConversationCommerceState();state.current_topic="studio rental";
  const plan=planConversationService({question:"x".repeat(1100)+" NO STAIRS",semantic_frame:semantic,commerce:state,memory:null,language:"en",recall:{handled:false}});
  assert(plan.knowledge_state==="tool_failure"&&plan.kb_query===null,"partial query mistaken for valid lookup");
  const reply=renderServicePlanReply(plan,null);assert(reply&&!/no match|no data|handed off/i.test(reply),"overflow misreported as retrieval no-match or completed handoff");
});

Deno.test("read-only recap stays local; new lookup outranks old formatting or incomplete calculation", () => {
  const base={language:"en" as const,memory:null,commerce:null,recall:{handled:true,fact_type:"summary"}};
  assert(planConversationService({...base,question:"Recap the previous choices"}).action==="direct_answer","pure recap forced into KB");
  for (const question of ["Shorten the recap and check current eligibility","Give me a checklist and check current availability"]) {
    const plan=planConversationService({...base,question,semantic_frame:frame("studio rental"),calculation_status:"missing_quantity"});
    assert(plan.knowledge_state==="lookup_required","format/calculation shortcut swallowed merchant query");
  }
  assert(planConversationService({...base,question:"Human please",semantic_frame:frame("studio rental"),explicit_handoff:true}).action==="explicit_handoff","lookup blocked R1");
});
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

Deno.test("explicit unique referent excludes another active option in the same category", () => {
  const state=createEmptyConversationCommerceState();state.current_topic="studio rental";
  state.entities=[{entity_id:"generic:studio",category:"studio rental",quantity:1,status:"researching",attributes:{product_name:"Atrium studio"},constraints:{max_people:8},provenance:{source_type:"customer",source_message_id:"prior"}},
    {entity_id:"generic:other",category:"studio rental",quantity:1,status:"researching",attributes:{product_name:"OTHER-ACTIVE-STUDIO"},constraints:{max_people:40},provenance:{source_type:"customer",source_message_id:"other"}}];
  const semantic=frame("studio rental");semantic.referents=[{ref:"generic:studio",source:"prior_turn",confidence:.9}];
  const query=scopedServiceKnowledgeQuery("Will that one fit?",semantic,state);
  assert(query.includes("Atrium studio")&&!query.includes("OTHER-ACTIVE-STUDIO"),"category overrode resolved referent");
  semantic.entities=[frameEntity()];state.entities[0].status="cancelled";
  assert(!scopedServiceKnowledgeQuery("Other options?",semantic,state).includes("Atrium studio"),"semantic proposal resurrected cancelled subject");
});

Deno.test("normalized credential keys are excluded while false remains a requirement",()=>{
 const result=normalizeDecisionContext({"ｔｏｋｅｎ":"sensitive",requires_stairs:false});
 assert(!JSON.stringify(result).includes("sensitive") && result.requires_stairs===false,"normalized private key leaked or requirement lost");
});

Deno.test("persisted entity unit and explicit quantity survive an unspecified follow-up without promoting defaults",()=>{
 const state=createEmptyConversationCommerceState();state.current_topic="studio rental";
 state.entities=[{entity_id:"generic:studio",category:"studio rental",quantity:8,status:"researching",attributes:{product_name:"Atrium studio",unit:"people",quantity_basis:"customer_explicit"},constraints:{requires_stairs:false},provenance:{source_type:"customer",source_message_id:"old"}}];
 const prior=JSON.parse(scopedServiceKnowledgeQuery("Which option fits?",null,state)).prior[0];
 assert(prior.unit==="people"&&prior.quantity===8,"persisted unit/explicit quantity dropped");
 const semantic=frame("studio rental");semantic.entities=[frameEntity()];
 const current=JSON.parse(scopedServiceKnowledgeQuery("Which option fits?",semantic,state)).current[0];
 assert(current.unit==="people"&&current.quantity===8,"unspecified follow-up lost supplied unit/quantity");
 state.entities[0].attributes.quantity_basis="system_default";
 assert(JSON.parse(scopedServiceKnowledgeQuery("Which option fits?",null,state)).prior[0].quantity===null,"system default promoted to customer requirement");
 semantic.entities[0].quantity=4;semantic.entities[0].unit="people";
 assert(JSON.parse(scopedServiceKnowledgeQuery("Actually four people",semantic,state)).current[0].quantity===4,"explicit latest quantity correction lost");
});

Deno.test("query overflow cannot enter any earlier local shortcut in the real generator call chain",async()=>{
 const caller=await Deno.readTextFile(new URL("../generate-reply/index.ts",import.meta.url));
 const guards=[...caller.matchAll(/_c3ServicePlan\.knowledge_state !== "lookup_required"/g)];
 assert(guards.length===7,"unexpected local shortcut inventory");
 for(const guard of guards)assert(caller.slice(guard.index!,guard.index!+230).includes('_c3ServicePlan.safe_assumptions.includes("query_context_limit")'),"local shortcut can swallow explicit context overflow");
 assert(caller.includes('_c3Resolution.bypass_service_plan && !_c3ServicePlan.safe_assumptions.includes("query_context_limit")'),"canonical acknowledgment can swallow the truthful overflow response");
});

Deno.test("customer-owned non-questions reach their B2 context commit before product clarification", () => {
  const source = Deno.readTextFileSync(new URL("../generate-reply/index.ts", import.meta.url));
  const context = source.indexOf('_canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE"');
  const planned = source.indexOf("const _c3PlannedReply");
  assert(context > source.indexOf("refreshConversationLongMemory(") && context < planned, "customer context preempted by product clarification");
  const branch = source.slice(context, planned);
  assert(branch.includes('_c3ServicePlan.knowledge_state !== "lookup_required"') && branch.includes('safe_assumptions.includes("query_context_limit")') && branch.includes("requiresCurrentMerchantEvidence(_effectiveNaturalCustomerIntent)"), "merchant fact or overflow bypass");
  assert(branch.includes("commitAiReplyWithControlGate(") && !/\.insert\(|\.rpc\(/.test(branch), "customer context bypassed B2");
});
