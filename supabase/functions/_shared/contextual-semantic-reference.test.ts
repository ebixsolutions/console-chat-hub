import {projectContextualSemanticReferences} from "./contextual-semantic-reference.ts";
import {normalizeCommerceSemanticFrame} from "./commerce-semantic-frame.ts";
import {createEmptyConversationCommerceState} from "./commerce-state-contract.ts";

const assert=(condition:unknown,message:string)=>{if(!condition)throw Error(message)};
const company="3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",ticket="00000000-0000-4000-8000-000000000002";
const previous="00000000-0000-4000-8000-000000970010",current="00000000-0000-4000-8000-000000970011";
const goalId="contextual-goal:"+previous,itemId="contextual-item:"+goalId;
function state(materialized=false){
  const value=createEmptyConversationCommerceState();value.current_topic="Training sessions";
  value.customer_constraints.contextual_goal={version:"contextual-scope-1",goal_id:goalId,
    subject_label:"Training sessions",source_text:"Training sessions for 2 teams.",
    company_id:company,conversation_id:ticket,source_message_id:previous,recorded_revision:1,status:"active"};
  value.customer_constraints.contextual_scope_facts=[{goal_id:goalId,scope:"teams",count:2,source_text:"2 teams"}];
  if(materialized)value.entities=[{entity_id:itemId,category:"Training sessions",quantity:4,status:"researching",
    attributes:{product_name:"Training sessions",contextual_goal_id:goalId,subject_source_message_id:previous,
      subject_source_revision:1,scoped_customer_updates:[{scope:"teams#1",group_goal_id:goalId,
        scope_count_source:{goal_id:goalId},source_text:goalId}]},constraints:{},
    provenance:{source_type:"customer",source_message_id:current}}];
  return value;
}
const summary=(value=state(),revision=1)=>JSON.stringify({revision,state:value});
const project=(text:string,source=current,company_id=company,conversation_id=ticket)=>
  projectContextualSemanticReferences({summary:text,company_id,conversation_id,source_message_id:source});
function frame(ref:string){
  const value=normalizeCommerceSemanticFrame({operation:"UPDATE_ITEM",confidence:.99,intent:"scoped allocation",
    entities:[{entity_ref:ref,name:"Training sessions",kind:"service",quantity:null,unit:"slots",confidence:.99}],
    referents:[{ref,source:"persistent_state",confidence:.99}],demands:[],requested_facts:[]});
  if(!value)throw Error("invalid fixture frame");return value;
}
const goalRef=(projection:{summary:string|null})=>JSON.parse(projection.summary!).state.customer_constraints.contextual_goal.goal_id;

Deno.test("R4 opaque semantic references conceal raw identity and restore only normalized typed slots",async()=>{
  const original=summary(),projection=await project(original),ref=goalRef(projection);
  assert(/^contextual-ref-goal-[a-p]{64}$/u.test(ref),"opaque request reference missing");
  assert(!ref.includes(previous)&&!ref.includes(company)&&!ref.includes(ticket),"raw identifier escaped through token");
  const candidate=frame(ref);candidate.entities[0].attributes={source_text:ref};candidate.entities[0].name=ref;
  const restored=projection.restore(candidate)!;
  assert(restored.entities[0].entity_ref===goalId&&restored.referents[0].ref===goalId,"canonical reference not restored");
  assert(restored.entities[0].name===ref&&restored.entities[0].attributes.source_text===ref,"customer words were rewritten");
  assert(candidate.entities[0].entity_ref===ref,"provider frame mutated");
  assert(original===summary(),"canonical summary changed");
  assert(JSON.parse(projection.summary!).state.customer_constraints.contextual_scope_facts[0].goal_id===ref,"ledger link not projected");
});

Deno.test("R4 materialized reference uses verified source identity and leaves source quotes intact",async()=>{
  const projection=await project(summary(state(true),2)),parsed=JSON.parse(projection.summary!);
  const ref=parsed.state.entities[0].entity_id,goal=goalRef(projection);
  assert(/^contextual-ref-item-[a-p]{64}$/u.test(ref)&&ref!==goal,"item reference missing");
  assert(projection.restore(frame(ref))?.entities[0].entity_ref===itemId,"wrong item rebound");
  const attributes=parsed.state.entities[0].attributes;
  assert(attributes.contextual_goal_id===goal&&attributes.scoped_customer_updates[0].group_goal_id===goal,
    "typed group links differ");
  assert(attributes.scoped_customer_updates[0].scope_count_source.goal_id===goal,"count link differs");
  assert(attributes.scoped_customer_updates[0].source_text===goalId,"quoted source was encoded");
});

Deno.test("R4 opaque references reject stale, foreign, forged and non-persistent selectors",async()=>{
  const projection=await project(summary()),ref=goalRef(projection);
  for(const other of [await project(summary(),"next-source"),await project(summary(state(),2)),
    await project(summary(),current,"foreign-company"),await project(summary(),current,company,"foreign-ticket")]){
    assert(other.restore(frame(ref))===null,"stale or foreign reference accepted");
  }
  assert(projection.restore(frame(ref.slice(0,-1)+(ref.endsWith("a")?"b":"a")))===null,"forged token accepted");
  const wrong=frame(ref);wrong.referents[0].source="current_turn";
  assert(projection.restore(wrong)===null,"current words authorized prior identity");
  const absent=frame(ref);absent.referents=[];
  assert(projection.restore(absent)===null,"unbound entity token accepted");
  assert(projection.restore(frame(goalId))?.entities[0].entity_ref===goalId,"ordinary canonical ref was rewritten");
});

Deno.test("R4 opaque references require active source-bound receipt and complete projection budget",async()=>{
  for(const mutate of [
    (value:ReturnType<typeof state>)=>{(value.customer_constraints.contextual_goal as any).goal_id="contextual-goal:forged"},
    (value:ReturnType<typeof state>)=>{(value.customer_constraints.contextual_goal as any).recorded_revision=99},
    (value:ReturnType<typeof state>)=>{(value.customer_constraints.contextual_goal as any).status="cancelled"},
    (value:ReturnType<typeof state>)=>{value.current_topic="Catering"},
    (value:ReturnType<typeof state>)=>{value.entities[0].status="deferred"},
    (value:ReturnType<typeof state>)=>{value.entities[0].attributes.subject_source_message_id="foreign-source"},
    (value:ReturnType<typeof state>)=>{value.entities[0].attributes.subject_source_revision=2},
    (value:ReturnType<typeof state>)=>{value.entities[0].provenance.source_type="model" as any},
  ]){
    const value=state(true);mutate(value);const text=summary(value,2),projection=await project(text);
    assert(projection.summary===text,"invalid receipt supplied opaque authority");
    assert(projection.restore(frame("contextual-ref-goal-"+"a".repeat(64)))===null,"unbound token accepted");
  }
  const value=JSON.parse(summary());value.unrelated="x".repeat(11600-JSON.stringify(value).length);
  const text=JSON.stringify(value),projection=await project(text);
  assert(projection.summary===text,"reference table clipped existing context");
});
