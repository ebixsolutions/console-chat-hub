import { createEmptyConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { runCommerceStateRuntime, sourceBoundQuantityUnit, type CommerceRuntimeInput, type CommerceStateDbClient, type CommerceStateQueryResult } from "./commerce-state-runtime-base.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { evaluateB2BeforeCommit } from "./pre-send-conversion-supervisor.ts";
import { prepareConversationRecall, type ConversationRecallInput } from "./conversation-recall.ts";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const owner = { company_id: "company-a", conversation_id: "ticket-a" };
const capabilities = {requires_delivery:false,supports_pickup:false,requires_installation:false,requires_booking:false,
  requires_quote:false,requires_site_check:false,digital_fulfilment:false,recurring_billing:false,rental_return:false,customization:false};
function seed(subject = "Workspace", unit = "seats"): ConversationCommerceState {
  const state = createEmptyConversationCommerceState(); state.current_topic = "generic_product";
  state.entities.push({entity_id:"generic:subject",category:"generic_product",model:null,quantity:2,status:"tentative",
    attributes:{name:subject,product_name:subject,customer_subject_aliases:[subject],unit,quantity_basis:"customer_explicit"},
    constraints:{},provenance:{source_type:"customer",source_message_id:"prior-source",recorded_at:"2026-11-24T00:00:00Z"}});
  return state;
}
function input(subject = "Workspace", unit = "licences", text = `Change ${subject} to 3 ${unit}.`): CommerceRuntimeInput {
  const frame: CommerceSemanticFrame = {version:"commerce-semantic-1.0.0",language:"en",operation:"SET_QUANTITY",
    intent:"customer_context_update",topic:"generic_product",entities:[{entity_ref:"generic:subject",name:subject,kind:"service",
      category_hint:null,sku:null,model:null,quantity:3,unit,attributes:{},constraints:{},capabilities,confidence:.99}],
    referents:[{ref:"generic:subject",source:"persistent_state",confidence:.99}],customer_facts:[],requested_facts:[],
    customer_correction:true,additive:false,explicit_negations:[],transaction_state:"none",payment_state:"none",booking_state:"none",fulfillment_state:"none",
    ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},confidence:.99,
    demands:[{question:text,source_quote:text,subject_refs:[subject],source_type:"general",requested_facts:[],constraints:{},
      customer_correction:true,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}]};
  return {...owner,source_message_id:"current-source",text,language:"en",occurred_at:"2026-11-24T00:01:00Z",semantic_frame:frame};
}
function storage(state = seed()) {
  const live = {state:structuredClone(state),revision:1,writes:0,source:"prior-source",company:owner.company_id,conversation:owner.conversation_id,
    intercept:null as ((params:Record<string,unknown>)=>CommerceStateQueryResult|null)|null};
  const db:CommerceStateDbClient={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{company_id:live.company,
    conversation_id:live.conversation,source_message_id:live.source,revision:live.revision,state:structuredClone(live.state)},error:null})})})}),
    rpc:async(_name,params)=>{live.writes++;const intercepted=live.intercept?.(params);if(intercepted)return intercepted;
      if(params.p_company_id!==live.company||params.p_conversation_id!==live.conversation)return{data:{result:"scope_mismatch"},error:null};
      if(params.p_expected_revision!==live.revision)return{data:{result:"revision_conflict"},error:null};
      live.state=structuredClone(params.p_state as ConversationCommerceState);live.source=String(params.p_source_message_id);live.revision++;
      return{data:{result:"success",applied_revision:live.revision},error:null};}};
  return{live,db};
}

Deno.test("Task3C source unit replacement persists arbitrary literal units with a verified readback ACK",async()=>{
  for(const row of [{subject:"Workspace",before:"seats",after:"licences"},{subject:"Orientation",before:"sessions",after:"training slots"},
    {subject:"投影機",before:"部",after:"台"}]){
    const f=storage(seed(row.subject,row.before)),turn=input(row.subject,row.after,row.subject==="投影機"?"更正：投影機改為3台。":`Change ${row.subject} to 3 ${row.after}.`);
    turn.language=row.subject==="投影機"?"zh-TW":"en";
    const result=await runCommerceStateRuntime(f.db,turn),entity=f.live.state.entities[0];
    assert(result?.reason==="source_bound_quantity_unit_committed"&&result.persist_result==="success"&&result.reply?.includes(`3 ${row.after}`),JSON.stringify(result));
    assert(entity.quantity===3&&entity.attributes.unit===row.after&&entity.provenance.source_message_id===turn.source_message_id,JSON.stringify(entity));
    assert(f.live.writes===1&&f.live.revision===2,"Quantity and unit were not one atomic commit");
    assert(f.live.state.latest_corrections.some(value=>value.includes(`2 ${row.before} to 3 ${row.after}`)),JSON.stringify(f.live.state.latest_corrections));
    const gate=evaluateB2BeforeCommit({proposed_response:result.reply??"",persistence_kind:"ai_reply",snapshot:{...owner,source_message_id:turn.source_message_id,
      source_message_content:turn.text,commerce_state_revision:f.live.revision,commerce_state_source_message_id:turn.source_message_id,state:f.live.state},
      metadata:{response_route:result.route,commerce_authority:result.authority,commerce_reason:result.reason,commerce_state_revision:result.revision,
        commerce_state_persist_result:result.persist_result,commerce_state_persistence_classification:"COMMITTED",commerce_state_path:result.state_path}});
    assert(gate.decision==="allow",JSON.stringify(gate));
  }
});

Deno.test("Task3C quantity unit verifier rejects missing forged ambiguous foreign and wrong-number literals",()=>{
  const variants:Array<[string,(turn:CommerceRuntimeInput,state:ConversationCommerceState)=>void]>=[
    ["no reading",t=>{t.semantic_frame=null;}],["weak reading",t=>{t.semantic_frame!.confidence=.5;}],
    ["ambiguous",t=>{t.semantic_frame!.ambiguity.is_ambiguous=true;}],["additive conversion",t=>{t.semantic_frame!.additive=true;}],
    ["missing unit",t=>{t.semantic_frame!.entities[0].unit=null;}],["forged unit",t=>{t.semantic_frame!.entities[0].unit="boxes";}],
    ["empty evidence",t=>{t.semantic_frame!.demands![0].source_quote="";}],
    ["forged evidence",t=>{t.semantic_frame!.demands![0].source_quote="Change Workspace to 3 boxes.";}],
    ["wrong current number",t=>{t.text="Change Workspace to 30 licences.";t.semantic_frame!.demands![0].source_quote=t.text;}],
    ["fraction",t=>{t.text="Change Workspace to 3.5 licences.";t.semantic_frame!.demands![0].source_quote=t.text;}],
    ["multiplier",t=>{t.text="Change Workspace to 三十 licences.";t.semantic_frame!.demands![0].source_quote=t.text;}],
    ["competing current values",t=>{t.text="Change Workspace to 3 licences or 4 licences.";t.semantic_frame!.demands![0].source_quote=t.text;}],
    ["foreign clause",t=>{t.text="Keep Workspace unchanged; Catering requires 3 licences.";t.semantic_frame!.demands![0].source_quote=t.text;}],
    ["wrong target",t=>{t.semantic_frame!.entities[0].entity_ref="generic:other";}],
    ["unowned subject",t=>{t.semantic_frame!.entities[0].name="Catering";}],
    ["conflicting ref",t=>{t.semantic_frame!.referents[0].ref="generic:other";}],
    ["missing server source",t=>{t.source_message_id="";}],
    ["merchant provenance",(_t,s)=>{s.entities[0].provenance.source_type="system";}],
    ["missing prior source",(_t,s)=>{s.entities[0].provenance.source_message_id=null;}],
    ["inactive",(_t,s)=>{s.entities[0].status="cancelled";}],
    ["duplicate subject",(_t,s)=>{s.entities.push({...structuredClone(s.entities[0]),entity_id:"generic:duplicate"});}],
    ["other current subject in clause",(t,s)=>{s.entities.push({...structuredClone(s.entities[0]),entity_id:"generic:other",attributes:{product_name:"Catering",unit:"boxes"}});
      t.text="Change Workspace and Catering to 3 licences.";t.semantic_frame!.demands![0].source_quote=t.text;}],
  ];
  for(const[label,change]of variants){const t=input(),s=seed();change(t,s);assert(sourceBoundQuantityUnit(t,s)===null,label);}
});

Deno.test("Task3C a conflicting unproved unit cannot replace the prior canonical quantity or unit",async()=>{
  for(const kind of ["forged unit","missing quote","foreign count"]){
    const f=storage(seed("投影機","部")),turn=input("投影機","台","更正：投影機改為3台。");
    if(kind==="forged unit")turn.semantic_frame!.entities[0].unit="盒";
    if(kind==="missing quote")turn.semantic_frame!.demands![0].source_quote="";
    if(kind==="foreign count"){turn.text="投影機維持原數量；禮盒改為3台。";turn.semantic_frame!.demands![0].source_quote=turn.text;}
    const result=await runCommerceStateRuntime(f.db,turn),entity=f.live.state.entities[0];
    assert(entity.quantity===2&&entity.attributes.unit==="部",kind+": "+JSON.stringify(entity));
    assert(result?.reason!=="source_bound_quantity_unit_committed",kind+": "+JSON.stringify(result));
  }
});

Deno.test("Task3C failed CAS false dedup wrong revision and missing readback never acknowledge a unit update",async()=>{
  for(const kind of ["transport","conflict","false dedup","false success","wrong revision","altered readback"]){
    const f=storage(),turn=input();
    f.live.intercept=params=>{
      if(kind==="transport")return{data:null,error:{message:"isolated test failure"}};
      if(kind==="conflict")return{data:{result:"revision_conflict"},error:null};
      if(kind==="false dedup")return{data:{result:"source_message_already_applied",applied_revision:1},error:null};
      if(kind==="false success")return{data:{result:"success",applied_revision:2},error:null};
      f.live.state=structuredClone(params.p_state as ConversationCommerceState);f.live.source=turn.source_message_id;f.live.revision=2;
      if(kind==="wrong revision")return{data:{result:"success",applied_revision:9},error:null};
      f.live.state.entities[0].attributes.unit="forged after RPC";
      return{data:{result:"success",applied_revision:2},error:null};
    };
    const result=await runCommerceStateRuntime(f.db,turn);
    assert(result?.reason!=="source_bound_quantity_unit_committed"&&!result?.reply?.startsWith("Updated"),kind+": "+JSON.stringify(result));
  }
});

Deno.test("Task3C unit correction replay leaves the same committed source revision and bytes",async()=>{
  const f=storage(),turn=input();await runCommerceStateRuntime(f.db,turn);
  const before=JSON.stringify(f.live.state),writes=f.live.writes;
  const replay=await runCommerceStateRuntime(f.db,turn);
  assert(f.live.writes===writes&&f.live.revision===2&&JSON.stringify(f.live.state)===before,JSON.stringify({live:f.live,replay}));
  assert(replay?.reason!=="source_bound_quantity_unit_committed","Replay claimed a new commit");
});

Deno.test("Task3C a reading-owned unit-only correction retains distinct old and new units",async()=>{
  const f=storage(),turn=input("Workspace","licences","Workspace: 2 licences.");
  turn.semantic_frame!.entities[0].quantity=2;
  const result=await runCommerceStateRuntime(f.db,turn);
  assert(result?.reason==="source_bound_quantity_unit_committed"&&f.live.state.entities[0].quantity===2&&
    f.live.state.entities[0].attributes.unit==="licences",JSON.stringify(result));
  assert(f.live.state.latest_corrections.some(value=>value.includes("2 seats to 2 licences")),JSON.stringify(f.live.state.latest_corrections));
});

Deno.test("Task3C quantity unit correction keeps current merchant demands for the existing KB path",async()=>{
  const f=storage(seed("投影機","部")),turn=input("投影機","台","更正：投影機改為3台。另外，現價幾多？");
  turn.semantic_frame!.requested_facts=["price"];
  turn.semantic_frame!.demands=[{...turn.semantic_frame!.demands![0],question:"更正：投影機改為3台。",source_quote:"更正：投影機改為3台。"},
    {...turn.semantic_frame!.demands![0],question:"現價幾多？",source_quote:"現價幾多？",source_type:"product",requested_facts:["price"]}];
  const result=await runCommerceStateRuntime(f.db,turn);
  assert(f.live.state.entities[0].quantity===3&&f.live.state.entities[0].attributes.unit==="台",JSON.stringify(f.live.state));
  assert(result?.reason!=="source_bound_quantity_unit_committed"&&!result?.reply?.startsWith("Updated"),JSON.stringify(result));
});

Deno.test("Task3C CAS retry revalidates the current owner and does not borrow the old unit proof",async()=>{
  const f=storage(),turn=input();let first=true;
  f.live.intercept=()=>{if(!first)return null;first=false;f.live.revision=2;
    f.live.state.entities[0].provenance={source_type:"system",source_message_id:"different-owner-source"};f.live.state.entities[0].quantity=7;
    return{data:{result:"revision_conflict"},error:null};};
  const result=await runCommerceStateRuntime(f.db,turn);
  assert(f.live.state.entities[0].quantity===7&&f.live.state.entities[0].attributes.unit==="seats",JSON.stringify(f.live.state.entities));
  assert(result?.reason!=="source_bound_quantity_unit_committed",JSON.stringify(result));
});

Deno.test("Task3C quantity read displays exact canonical units and never supplies an absent unit",()=>{
  for(const unit of ["seats","licences","training slots","台",null]){
    const state=seed("Workspace",unit??"");state.entities[0].quantity=3;
    if(unit===null)delete state.entities[0].attributes.unit;
    const request:ConversationRecallInput={...owner,source_message_id:"read-source",question:"What is my current quantity for Workspace?",memory:null,
      commerce:{...owner,source_message_id:"prior-source",revision:1,state},referents:[{ref:"generic:subject",source:"persistent_state",confidence:.99}]};
    const result=prepareConversationRecall(request,"en");
    assert(result.reply?.includes(unit?`3 ${unit}`:"3"),JSON.stringify(result));
    assert(!result.reply?.includes("3 units")&&!result.reply?.includes("3 部"),JSON.stringify(result));
  }
});

Deno.test("Task3C unit mutation cannot consume a mismatched tenant snapshot",async()=>{
  const f=storage(),before=JSON.stringify(f.live.state);f.live.company="foreign-company";
  let refused=false;try{await runCommerceStateRuntime(f.db,input());}catch{refused=true;}
  assert(refused&&f.live.writes===0&&JSON.stringify(f.live.state)===before,"Foreign tenant state authorized a quantity/unit mutation");
});

Deno.test("Task3C contradictory typed negations cannot authorize a quantity or unit replacement",async()=>{
  for(const scope of ["frame","demand"]) for (const proposedUnit of ["licences","seats"]) {
    const f=storage(),turn=input("Workspace",proposedUnit),before=structuredClone(f.live.state.entities[0]);
    if(scope==="frame")turn.semantic_frame!.explicit_negations=[`Do not change Workspace to 3 ${proposedUnit}.`];
    else turn.semantic_frame!.demands![0].explicit_negations=[`Do not change Workspace to 3 ${proposedUnit}.`];
    const result=await runCommerceStateRuntime(f.db,turn);
    assert(f.live.state.entities[0].quantity===before.quantity&&f.live.state.entities[0].attributes.unit===before.attributes.unit&&
      result?.reason!=="source_bound_quantity_unit_committed",JSON.stringify({scope,result,entity:f.live.state.entities[0]}));
  }
});

Deno.test("Task3C source unit binding accepts an omitted optional quote using the server current source",async()=>{
  for (const omission of ["demands", "quote"]) {
  const f=storage(),turn=input();
  // Older sparse producers omit demands; the server-owned current text still
  // supplies the exact subject, numeral and unit. An explicitly empty quote
  // remains rejected in the negative contract above.
  if (omission === "demands") delete turn.semantic_frame!.demands;
  else delete (turn.semantic_frame!.demands![0] as unknown as Record<string,unknown>).source_quote;
  const result=await runCommerceStateRuntime(f.db,turn);
  assert(result?.reason==="source_bound_quantity_unit_committed"&&f.live.state.entities[0].quantity===3&&
    f.live.state.entities[0].attributes.unit==="licences",JSON.stringify(result));
  }
});

Deno.test("Task3C model transaction flags cannot turn a quantity-unit receipt into a transaction",async()=>{
  const f=storage(),turn=input();
  turn.semantic_frame!.transaction_state="confirmed";turn.semantic_frame!.payment_state="paid";
  turn.semantic_frame!.booking_state="booked";turn.semantic_frame!.fulfillment_state="fulfilled";
  const result=await runCommerceStateRuntime(f.db,turn);
  assert(f.live.state.conversion.order_status==="none"&&f.live.state.conversion.payment_status==="none"&&
    f.live.state.conversion.quotation_status==="none",JSON.stringify({result,state:f.live.state}));
  assert(!result?.reply||!/(?:paid|payment received|order confirmed|booking confirmed|completed delivery)/iu.test(result.reply),JSON.stringify(result));
});


Deno.test("Task3C an explicit current recall unit labels only the equal canonical quantity without persisting a unit",()=>{
  for (const row of [{subject:"Workspace",unit:"seats",question:"Do you remember my quantity for Workspace 2 seats?",language:"en"},
    {subject:"Orientation",unit:"licences",question:"Do you remember my quantity for Orientation 2 licences?",language:"en"},
    {subject:"投影機",unit:"台",question:"頭先投影機兩台你仲記唔記得？",language:"zh-TW"}]) {
    const state=seed(row.subject);delete state.entities[0].attributes.unit;const before=JSON.stringify(state);
    const request:ConversationRecallInput={...owner,source_message_id:"read-source",question:row.question,memory:null,
      commerce:{...owner,source_message_id:"prior-source",revision:1,state}};
    const result=prepareConversationRecall(request,row.language);
    assert(result.decision.handled&&result.reply?.includes(`2 ${row.unit}`),JSON.stringify(result));
    if(!result.decision.handled)throw new Error("missing decision");
    const evidence=result.decision.provenance.evidence.find(e=>e.fact_type==="quantity");
    assert(evidence?.value===2&&evidence.evidence_source_message_id==="prior-source"&&
      evidence.quantity_unit_source_kind==="current_customer_question"&&evidence.quantity_unit_source_message_id==="read-source",JSON.stringify(evidence));
    assert((result.metadata.recall_provenance as Array<Record<string,unknown>>).some(e=>e.quantity_unit_source_kind==="current_customer_question"&&
      e.source_message_id==="prior-source"&&e.quantity_unit_source_message_id==="read-source"),JSON.stringify(result.metadata));
    assert(JSON.stringify(state)===before,"The question unit became a persisted canonical fact");
    state.entities[0].attributes.unit="training slots";
    const saved=prepareConversationRecall(request,"en");
    assert(saved.reply?.includes("2 training slots")&&!saved.reply?.includes(`2 ${row.unit}`),JSON.stringify(saved));
  }
});

Deno.test("Task3C current recall display rejects absent conflicting background foreign and unsupported unit phrases",()=>{
  for(const question of [
    "What is my current quantity for Workspace?",
    "Do you remember my quantity for Workspace 3 seats?",
    "Do you remember my quantity for Workspace 2 seats or 3 licences?",
    "Do you remember my quantity for Workspace 2 seats or licences?",
    "Do you remember my quantity for Workspace 兩萬 seats?",
    "Do you remember my quantity for Workspace 2.5 seats?",
    "For 2 seats in another plan, what quantity did I choose for Workspace?",
    "For 2 seats in another plan what quantity did I choose for Workspace?",
    "For 2 people, how many licences did I choose for Workspace?",
    "Do you remember my quantity for Workspace 2 rooms?",
    "Do you remember my quantity for Workspace 2 training slots?",
    "Do you remember my quantity for Catering 2 seats?",
  ]) {
    const state=seed();delete state.entities[0].attributes.unit;const before=JSON.stringify(state);
    const request:ConversationRecallInput={...owner,source_message_id:"read-source",question,memory:null,
      commerce:{...owner,source_message_id:"prior-source",revision:1,state}};
    const result=prepareConversationRecall(request,"en");
    assert(!result.decision.handled||result.decision.provenance.evidence.every(e=>!e.quantity_unit),question+": "+JSON.stringify(result));
    assert(JSON.stringify(state)===before,question+": state mutated");
  }
  for(const variant of ["missing current source","foreign snapshot","other named entity","ambiguous current subject","inactive"]){
    const state=seed();delete state.entities[0].attributes.unit;
    const request:ConversationRecallInput={...owner,source_message_id:"read-source",question:"Do you remember my quantity for Workspace 2 seats?",memory:null,
      commerce:{...owner,source_message_id:"prior-source",revision:1,state}};
    if(variant==="missing current source")request.source_message_id="";
    if(variant==="foreign snapshot")request.commerce!.company_id="foreign";
    if(variant==="inactive")state.entities[0].status="cancelled";
    if(variant==="other named entity"){
      state.entities.push({...structuredClone(state.entities[0]),entity_id:"generic:other",attributes:{product_name:"Catering"}});
      request.question="Do you remember my quantity for Workspace 2 seats and Catering?";
    }
    if(variant==="ambiguous current subject")state.entities.push({...structuredClone(state.entities[0]),entity_id:"generic:other"});
    const result=prepareConversationRecall(request,"en");
    assert(!result.decision.handled||result.decision.provenance.evidence.every(e=>!e.quantity_unit),variant+": "+JSON.stringify(result));
  }
});


Deno.test("Task3C R9 accepted scoped current Reading labels arbitrary exact units without persisting",()=>{
  for(const unit of ["位","間","斤","kg","hours","rooms","training slots"]){
    const state=seed();delete state.entities[0].attributes.unit;const before=JSON.stringify(state);
    const question="Do you remember my quantity for Workspace 2 "+unit+"?";
    const frame=input("Workspace",unit,question).semantic_frame!;
    frame.operation="ASK_FACT";frame.intent="customer_fact_recall";frame.customer_correction=false;
    frame.entities[0].quantity=2;frame.demands![0].customer_correction=false;
    const request:ConversationRecallInput={...owner,source_message_id:"read-source",question,memory:null,
      commerce:{...owner,source_message_id:"prior-source",revision:1,state},
      quantity_reading:{...owner,source_message_id:"read-source",commerce_revision:1,frame}};
    const actual=prepareConversationRecall(request,"en");
    assert(actual.decision.handled&&actual.reply?.includes("2 "+unit),JSON.stringify(actual));
    assert(actual.decision.provenance.evidence.some(e=>e.quantity_unit===unit&&
      e.quantity_unit_source_message_id==="read-source"&&e.evidence_source_message_id==="prior-source"),JSON.stringify(actual));
    assert(JSON.stringify(state)===before,"read-only unit mutated state");
    for(const variant of ["missing","foreign","revision","source","wrong unit","wrong quantity","ambiguous","weak","wrong target","negation","quote","merchant","competing"]){
      const bad=structuredClone(request),reading=bad.quantity_reading!;
      if(variant==="missing")delete bad.quantity_reading;
      if(variant==="foreign")reading.company_id="foreign";
      if(variant==="revision")reading.commerce_revision=2;
      if(variant==="source")reading.source_message_id="foreign-source";
      if(variant==="wrong unit")reading.frame.entities[0].unit="unwritten";
      if(variant==="wrong quantity")reading.frame.entities[0].quantity=3;
      if(variant==="ambiguous")reading.frame.ambiguity.is_ambiguous=true;
      if(variant==="weak")reading.frame.confidence=.2;
      if(variant==="wrong target")reading.frame.entities[0].entity_ref="other";
      if(variant==="negation")reading.frame.explicit_negations=["not "+unit];
      if(variant==="quote")reading.frame.demands![0].source_quote="foreign quote";
      if(variant==="merchant")reading.frame.demands![0].source_type="product";
      if(variant==="competing")bad.commerce!.state.entities.push({...structuredClone(state.entities[0]),entity_id:"other"});
      const beforeBad=JSON.stringify(bad.commerce!.state);
      const result=prepareConversationRecall(bad,"en");
      assert(!result.decision.handled||result.decision.provenance.evidence.every(e=>!e.quantity_unit),variant+": "+JSON.stringify(result));
      assert(JSON.stringify(bad.commerce!.state)===beforeBad,"negative mutated state");
    }
  }
});
