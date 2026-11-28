/** Compound typed customer facts traverse the actual generic runtime/CAS.
 * This is native source evidence, not a provider/Hosted/database RLS claim. */
import {createEmptyConversationCommerceState, type ConversationCommerceState} from "../../supabase/functions/_shared/commerce-state-contract.ts";
import {readSourceBoundDimensionComparison, sourceBoundDimensionComparison, runCommerceStateRuntime, type CommerceStateDbClient, type CommerceRuntimeInput} from "../../supabase/functions/_shared/commerce-state-runtime-base.ts";
import type {CommerceSemanticFrame} from "../../supabase/functions/_shared/commerce-semantic-frame.ts";
import {resolveSemanticContextualCandidate, verifiedCurrentScopeFacts} from "../../supabase/functions/_shared/contextual-customer-update.ts";
import {reading as lifecycleReading, storage as lifecycleStorage} from "./fixtures/phase1-business-context.ts";
import {isCurrentRequirementsRecap} from "../../supabase/functions/_shared/commerce-state-authority.ts";
import {isSourceBoundOperationFailureRequest,resolveCurrentFactualRequest,type ResolveCurrentFactualRequestInput} from "../../supabase/functions/_shared/current-factual-request.ts";
import {planConversationService,renderServicePlanReply} from "../../supabase/functions/_shared/conversation-service-planner.ts";

function assert(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
const owner={company_id:"compound-company",conversation_id:"compound-ticket"};
const capabilities=()=>({requires_delivery:false,supports_pickup:false,requires_installation:false,requires_booking:false,
  requires_quote:false,requires_site_check:false,digital_fulfilment:false,recurring_billing:false,rental_return:false,customization:false});
function input(subject="Festival catering",detail="labelled vegetarian choices"):CommerceRuntimeInput {
  const text=`${subject} for 2 tables and 1 counter. Our preference is ${detail}. Please compare the planning trade-offs.`;
  const semantic_frame:CommerceSemanticFrame={version:"commerce-semantic-1.0.0",language:"en",operation:"UPDATE_ITEM",
    intent:"customer_guidance",topic:subject,entities:[],referents:[],requested_facts:[],customer_correction:false,
    additive:false,explicit_negations:[],transaction_state:"none",payment_state:"none",booking_state:"none",fulfillment_state:"none",
    ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},confidence:.99,
    customer_facts:[{key:"preference",value:detail},{key:"contextual_scope_counts",value:[
      {scope:"tables",count:2,source_text:"2 tables",subject_label:subject},
      {scope:"counter",count:1,source_text:"1 counter",subject_label:subject},
    ]}],demands:[{question:text,source_quote:text,subject_refs:[subject],source_type:"general",requested_facts:[],
      constraints:{},customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}]};
  return {...owner,source_message_id:"compound-source",text,language:"en",semantic_frame};
}
function store(language:"en"|null="en"){
  const initial=createEmptyConversationCommerceState();initial.language=language;
  const live={state:initial,revision:1,writes:0};
  const db:CommerceStateDbClient={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{...owner,revision:live.revision,state:structuredClone(live.state)},error:null})})})}),
    rpc:async(_name,args)=>{assert(args.p_company_id===owner.company_id && args.p_conversation_id===owner.conversation_id && args.p_expected_revision===live.revision,"owner/revision changed at actual CAS");
      live.state=structuredClone(args.p_state as ConversationCommerceState);live.revision++;live.writes++;
      return {data:{result:"success",applied_revision:live.revision},error:null};}};
  return {live,db};
}

for(const mode of ["two-scoped-entities","scoped-second-entity","object-value","null-value","string-value"] as const){
  Deno.test(`P1 full journey native negative: reserved scoped proposal ${mode} never falls through`,async()=>{
    const h=store(null),background=input();
    await runCommerceStateRuntime(h.db,background);
    const goal=h.live.state.customer_constraints.contextual_goal as Record<string,unknown>;
    const text="counter 1 trays, tables 1 trays each";
    const entity:CommerceSemanticFrame["entities"][number]={entity_ref:String(goal.goal_id),name:"Festival catering",kind:"service",
      category_hint:null,model:null,sku:null,quantity:null,unit:"trays",confidence:.99,capabilities:capabilities(),constraints:{},
      attributes:{scoped_customer_updates:[{scope:"counter",attribute:"quantity",value:1,unit:"trays",source_text:"counter 1 trays"},
        {scope:"tables",attribute:"quantity",value:1,unit:"trays",source_text:"tables 1 trays each",distributive:true,explicit_count:2}]}};
    const frame=structuredClone(background.semantic_frame!);
    Object.assign(frame,{language:"zh-TW",intent:"contextual_scoped_update",customer_facts:[],demands:[],entities:[entity],
      referents:[{ref:String(goal.goal_id),source:"persistent_state",confidence:.99}]});
    if(mode==="two-scoped-entities")frame.entities.push({...structuredClone(entity),entity_ref:"invented",name:"Unmentioned subject"});
    if(mode==="scoped-second-entity")frame.entities.unshift({...structuredClone(entity),entity_ref:"invented",name:"Unmentioned subject",attributes:{}});
    if(mode==="object-value")entity.attributes.scoped_customer_updates={scope:"counter",value:1};
    if(mode==="null-value")entity.attributes.scoped_customer_updates=null;
    if(mode==="string-value")entity.attributes.scoped_customer_updates="counter 1 trays";
    const before=JSON.stringify(h.live.state),revision=h.live.revision,writes=h.live.writes;
    const result=await runCommerceStateRuntime(h.db,{...owner,source_message_id:`reserved-${mode}`,text,language:"zh-TW",semantic_frame:frame});
    assert(h.live.writes===writes && h.live.revision===revision && JSON.stringify(h.live.state)===before,
      "Rejected scoped envelope changed even locale/revision: "+JSON.stringify(result));
    assert(result?.contextual_decision?.route==="targeted_clarification" && !result.trusted_journey_progress,
      "Rejected scoped envelope did not retain the clarification boundary: "+JSON.stringify(result));
  });
}
Deno.test("P1 full journey native control: ordinary multi-entity Reading is not reserved as scoped allocation",()=>{
  const turn=input(),frame=turn.semantic_frame!;
  frame.entities=["Catering","Equipment"].map((name,index)=>({entity_ref:`current:${index}`,name,kind:"service",category_hint:null,
    model:null,sku:null,quantity:1,unit:"kits",confidence:.99,capabilities:capabilities(),attributes:{},constraints:{}}));
  frame.customer_facts=[];frame.demands=[];frame.operation="ADD_ITEM";frame.intent="customer_requirements";
  assert(resolveSemanticContextualCandidate({text:"Add 1 Catering and 1 Equipment.",language:"en",
    state:createEmptyConversationCommerceState(),semantic_frame:frame})===null,"General multi-entity path was captured by scoped validation");
});

function lifecyclePair(base="Event equipment rental",addon="Workspace subscriptions") {
  const initial=createEmptyConversationCommerceState();initial.language="en";initial.current_topic=addon;
  initial.entities=[base,addon].map((name,index)=>({entity_id:`visible-${index}`,category:name,quantity:index?3:4,
    status:"researching" as const,attributes:{product_name:name,unit:index?"licences":"kits",quantity_basis:"customer_explicit"},
    constraints:{},provenance:{source_type:"customer" as const,source_message_id:`prior-visible-${index}`}}));
  return initial;
}
function visibleLifecycle(base="Event equipment rental",addon="Workspace subscriptions") {
  const h=lifecycleStorage("visible-lifecycle",lifecyclePair(base,addon),7);
  const frame=lifecycleReading("DEFER",addon);frame.intent="lifecycle";
  frame.referents=[{ref:addon,source:"persistent_state",confidence:.99}];
  const turn=h.turn(`Pause ${addon}. Focus on ${base}.`,frame,"current-visible-lifecycle");
  return {h,frame,turn};
}
for(const [base,addon] of [["Event equipment rental","Workspace subscriptions"],["Festival catering","Coffee service"],["Training programme","Support subscription"]]){
  Deno.test(`P1 full journey native: visible exact ${addon} lifecycle reference preserves ${base}`,async()=>{
    const {h,turn}=visibleLifecycle(base,addon),retained=JSON.stringify(h.live.state.entities[0]);
    const result=await h.ask(turn);
    assert(h.live.writes===1 && h.live.revision===8 && h.live.state.entities[1].status==="deferred" &&
      h.live.state.entities[1].provenance.source_message_id===turn.source_message_id &&
      JSON.stringify(h.live.state.entities[0])===retained && result?.trusted_lifecycle_commit?.target_entity_ids.length===1 &&
      result.trusted_lifecycle_commit.target_entity_ids[0]==="visible-1",JSON.stringify(result));
    assert(h.live.state.conversion.order_status==="none" && h.live.state.conversion.payment_status==="none","Lifecycle created transaction authority");
  });
}
for(const mode of ["wrong-ref","partial-name","duplicate-label","inactive-target","missing-provenance","merchant-provenance",
  "wrong-source","wrong-operation","weak-reading","duplicate-reference","conflicting-proposal-name","foreign-owner"] as const){
  Deno.test(`P1 full journey native negative: visible lifecycle ${mode} cannot mutate`,async()=>{
    const {h,frame,turn}=visibleLifecycle();
    if(mode==="wrong-ref")frame.referents[0].ref="Event equipment rental";
    if(mode==="partial-name")frame.referents[0].ref="Workspace";
    if(mode==="duplicate-label")h.live.state.entities.push({...structuredClone(h.live.state.entities[1]),entity_id:"duplicate-visible",category:"different-category"});
    if(mode==="inactive-target")h.live.state.entities[1].status="cancelled";
    if(mode==="missing-provenance")h.live.state.entities[1].provenance.source_message_id=" ";
    if(mode==="merchant-provenance")h.live.state.entities[1].provenance.source_type="kb";
    if(mode==="wrong-source")turn.text="Pause Unmentioned subscription. Focus on Event equipment rental.";
    if(mode==="wrong-operation")frame.operation="ASK_FACT";
    if(mode==="weak-reading")frame.confidence=.5;
    if(mode==="duplicate-reference")frame.referents.push({...frame.referents[0],ref:"visible-1"});
    if(mode==="conflicting-proposal-name")frame.entities=[{entity_ref:"Workspace subscriptions",name:"Event equipment rental",kind:"service",
      category_hint:null,model:null,sku:null,quantity:null,unit:null,confidence:.99,capabilities:capabilities(),attributes:{},constraints:{}}];
    if(mode==="foreign-owner")h.live.company_id="foreign-company";
    const before=JSON.stringify(h.live.state),revision=h.live.revision;
    let denied:unknown;
    const result=await h.ask(turn).catch(error=>{if(mode!=="foreign-owner")throw error;denied=error;return null;});
    if(mode==="foreign-owner")assert(denied instanceof Error && denied.message==="commerce_state_scope_mismatch",
      "Foreign snapshot did not fail its independent owner guard");
    assert(h.live.writes===0 && h.live.revision===revision && JSON.stringify(h.live.state)===before &&
      !result?.trusted_lifecycle_commit,"Unverified visible ref acquired mutation authority: "+JSON.stringify(result));
  });
}

for(const text of ["Please reply in English. Give me a recap of everything.","請用廣東話回覆：而家我有咩記低？",
  "Please answer in French: summarize my current requirements."]){
  Deno.test(`P1 full journey native: presentation clause preserves a complete recap ${text}`,()=>{
    assert(isCurrentRequirementsRecap(text),"A source-only presentation clause obscured the complete recap");
  });
}
for(const [mode,text] of [
  ["action-suffix","Please reply in English. Give me a recap of everything and cancel my order."],
  ["separate-action","Please reply in English. Give me a recap of everything. Cancel Workspace subscriptions."],
  ["action-prefix","Please reply in English and cancel Workspace subscriptions. Give me a recap of everything."],
  ["merchant-suffix","Please reply in English. Give me a recap of everything and check the current price."],
  ["quoted-recap",'Please reply in English. The customer said "Give me a recap of everything".'],
  ["quoted-action",'Please reply in English. Give me a recap of everything. "Cancel my order"'],
  ["multiple-presentation","Please reply in English. Please answer in French. Give me a recap of everything."],
  ["chinese-action","請用廣東話回覆：總結我嘅要求，同埋取消Workspace subscriptions。"],
  ["chinese-merchant","請用廣東話回覆：總結我嘅要求，同埋查現時價錢。"],
] as const){
  Deno.test(`P1 full journey native negative: presentation ${mode} retains the complete source obligation`,()=>{
    assert(!isCurrentRequirementsRecap(text),"Presentation stripping erased an independent source obligation");
  });
}

function dimensionRead(subject="Portable exhibition frame",axis="width",literal="598mm",limit=595) {
  const h=lifecycleStorage("dimension-read",lifecyclePair("Training presentation",subject),8);
  h.live.state.entities[1].constraints[`max_${axis}_mm`]=limit;
  const text=`Would ${subject} ${axis} ${literal} fit?`,frame=lifecycleReading("ASK_FACT",subject);
  frame.intent="compare supplied measurement with my current requirement";frame.requested_facts=[axis];
  frame.referents=[{ref:subject,source:"persistent_state",confidence:.99}];
  frame.demands=[{question:text,source_quote:text,subject_refs:[subject],source_type:"unknown",requested_facts:[axis],
    constraints:{},customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}];
  const turn=h.turn(text,frame,"customer-dimension-read");
  const snapshot={...h.owner,source_message_id:h.live.source,revision:h.live.revision,state:h.live.state};
  return {h,frame,turn,snapshot};
}

function operationFailure(model="EVENT-KT64",chinese=false):ResolveCurrentFactualRequestInput {
  const question=chinese?`${model} 開唔到機，點處理？`:`${model} is not working. What should I check?`;
  const frame=lifecycleReading("ASK_FACT",model);frame.intent="product_operation_failure";
  frame.language=chinese?"zh-TW":"en";
  frame.demands=[{question,source_quote:question,subject_refs:[model],source_type:"general",requested_facts:[],
    constraints:{},customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}];
  return {question,source_message_id:"current-operation-source",trusted_company_id:"operation-owner",semantic:frame};
}
for(const [model,chinese] of [["EVENT-KT64",false],["TRAINING-DP31",false],["WORKSPACE-PT22",true]] as const){
  Deno.test(`P1 full journey native: source-bound operating failure ${model} reaches diagnostic next step`,()=>{
    const input=operationFailure(model,chinese),before=JSON.stringify(input);
    assert(isSourceBoundOperationFailureRequest(input),"Complete customer diagnostic ask was not source bound");
    const factual=resolveCurrentFactualRequest(input);
    assert(!factual.kb_required && !factual.applicable && factual.demands.length===1 &&
      factual.demands[0].source_type==="general" && factual.source_message_id===input.source_message_id,
      "Diagnostic next step became a merchant lookup: "+JSON.stringify(factual));
    const plan=planConversationService({question:input.question,language:chinese?"zh-TW":"en",
      semantic_frame:input.semantic,factual_request:factual,
      request_decision:{kind:"other",continuation:false,general_request:null,merchant_request:null,latest_requirements:input.question},
      recall:{handled:false,reason:"NOT_A_RECALL_QUERY"},memory:null,commerce:null});
    const reply=renderServicePlanReply(plan,null);
    assert(plan.action==="customer_issue_next_step" && plan.issue_kind==="product_operation_failure" &&
      /indicator|error message|燈號|錯誤提示/u.test(reply??"") && reply?.includes(model),JSON.stringify({plan,reply}));
    assert(JSON.stringify(input)===before,"Diagnostic source proof mutated its input");
  });
}
for(const mode of ["missing-reading","missing-demand","weak-reading","missing-owner","missing-source","wrong-source-quote",
  "wrong-demand-question","wrong-subject","extra-demand","hidden-price","unknown-extra-clause","transaction","entity-proposal",
  "ambiguous","quoted-report","wrong-operation","fact-proposal","requested-price","requested-specification","requested-policy"] as const){
  Deno.test(`P1 full journey native negative: operating failure ${mode} has no diagnostic route exemption`,()=>{
    const input=operationFailure(),frame=input.semantic!,demand=frame.demands![0];
    if(mode==="missing-reading")input.semantic=null;
    if(mode==="missing-demand")frame.demands=[];
    if(mode==="weak-reading")frame.confidence=.5;
    if(mode==="missing-owner")input.trusted_company_id=" ";
    if(mode==="missing-source")input.source_message_id=" ";
    if(mode==="wrong-source-quote")demand.source_quote="EVENT-KT64 does not turn on. What should I do?";
    if(mode==="wrong-demand-question")demand.question="What is the current price?";
    if(mode==="wrong-subject")demand.subject_refs=["OTHER-KT99"];
    if(mode==="extra-demand")frame.demands!.push({...structuredClone(demand),source_type:"product",requested_facts:["price"]});
    if(mode==="hidden-price"){input.question+=" What is the current price?";demand.question=input.question;demand.source_quote=input.question;}
    if(mode==="unknown-extra-clause"){input.question+=" Its certification is guaranteed.";demand.question=input.question;demand.source_quote=input.question;}
    if(mode==="transaction")frame.transaction_state="confirmed";
    if(mode==="entity-proposal")frame.entities=[{entity_ref:"current:1",name:"EVENT-KT64",kind:"rental",category_hint:null,model:"EVENT-KT64",
      sku:null,quantity:1,unit:"kits",attributes:{},constraints:{},capabilities:capabilities(),confidence:.99}];
    if(mode==="ambiguous")demand.ambiguity.is_ambiguous=true;
    if(mode==="quoted-report"){input.question='"'+input.question+'"';demand.question=input.question;demand.source_quote=input.question;}
    if(mode==="wrong-operation")frame.operation="UPDATE_ITEM";
    if(mode==="fact-proposal")frame.customer_facts=[{key:"new requirement",value:"unverified"}];
    if(mode.startsWith("requested-")){const field=mode.slice("requested-".length);frame.requested_facts=[field];demand.requested_facts=[field];}
    assert(!isSourceBoundOperationFailureRequest(input),"Unproved or mixed source acquired diagnostic routing");
  });
}
for(const [subject,axis,literal,limit,converted] of [
  ["Portable exhibition frame","width","598mm",595,598],
  ["Training display","height","210cm",2000,2100],
  ["Service desk cabinet","depth","21inch",508,533.4],
] as const){
  Deno.test(`P1 full journey native: source-bound ${subject} comparison reads without any write`,async()=>{
    const f=dimensionRead(subject,axis,literal,limit),before=JSON.stringify(f.h.live.state);
    const result=await readSourceBoundDimensionComparison(f.h.db,f.turn);
    assert(result?.reply?.includes(String(converted)) && result.reply.includes(String(limit)) &&
      result.reason==="read_only_attribute_constraint_query_resolved" && result.persist_result==="read_only" &&
      result.state_path?.includes(`max_${axis}_mm`) && result.revision===8,JSON.stringify(result));
    assert(f.h.live.writes===0 && f.h.live.attempts===0 && JSON.stringify(f.h.live.state)===before,"Read probe invoked the writer");
  });
}
for(const mode of ["missing-reading","weak-reading","wrong-reference","extra-reference","wrong-source-quote","wrong-demand-question",
  "extra-requested-price","extra-demand","hidden-merchant-clause","action-clause","quoted-query","missing-measurement","wrong-axis",
  "foreign-owner","foreign-ticket","missing-committed-source","fractional-revision","missing-limit","inactive-subject","duplicate-subject",
  "merchant-owned-subject","blank-provenance","transaction","entity-proposal","fact-proposal"] as const){
  Deno.test(`P1 full journey native negative: dimension read ${mode} cannot suppress merchant routing`,()=>{
    const f=dimensionRead(),d=f.frame.demands![0];
    if(mode==="missing-reading")f.turn.semantic_frame=null;
    if(mode==="weak-reading")f.frame.confidence=.5;
    if(mode==="wrong-reference")f.frame.referents[0].ref="Training presentation";
    if(mode==="extra-reference")f.frame.referents.push({ref:"visible-0",source:"persistent_state",confidence:.99});
    if(mode==="wrong-source-quote")d.source_quote="Would Portable exhibition frame width 200mm fit?";
    if(mode==="wrong-demand-question")d.question="What is the current price?";
    if(mode==="extra-requested-price")f.frame.requested_facts.push("price");
    if(mode==="extra-demand")f.frame.demands!.push({...structuredClone(d),requested_facts:["price"]});
    if(mode==="hidden-merchant-clause"){f.turn.text+=" What is its current price?";d.question=f.turn.text;d.source_quote=f.turn.text;}
    if(mode==="action-clause"){f.turn.text+=" Cancel Training presentation.";d.question=f.turn.text;d.source_quote=f.turn.text;}
    if(mode==="quoted-query"){f.turn.text='"'+f.turn.text+'"';d.question=f.turn.text;d.source_quote=f.turn.text;}
    if(mode==="missing-measurement"){f.turn.text="What is the current width of Portable exhibition frame?";d.question=f.turn.text;d.source_quote=f.turn.text;}
    if(mode==="wrong-axis")f.frame.requested_facts=["height"];
    if(mode==="foreign-owner")f.snapshot.company_id="foreign-company";
    if(mode==="foreign-ticket")f.snapshot.conversation_id="foreign-ticket";
    if(mode==="missing-committed-source")f.snapshot.source_message_id=" ";
    if(mode==="fractional-revision")f.snapshot.revision=8.5;
    if(mode==="missing-limit")f.h.live.state.entities[1].constraints={};
    if(mode==="inactive-subject")f.h.live.state.entities[1].status="deferred";
    if(mode==="duplicate-subject")f.h.live.state.entities.push({...structuredClone(f.h.live.state.entities[1]),entity_id:"duplicate-read"});
    if(mode==="merchant-owned-subject")f.h.live.state.entities[1].provenance.source_type="kb";
    if(mode==="blank-provenance")f.h.live.state.entities[1].provenance.source_message_id=" ";
    if(mode==="transaction")f.frame.transaction_state="confirmed";
    if(mode==="entity-proposal")f.frame.entities=[{entity_ref:"visible-1",name:"Portable exhibition frame",kind:"rental",category_hint:null,
      model:null,sku:null,quantity:null,unit:null,attributes:{},constraints:{},confidence:.99,capabilities:capabilities()}];
    if(mode==="fact-proposal")f.frame.customer_facts=[{key:"preference",value:"new preference"}];
    assert(sourceBoundDimensionComparison(f.turn,f.snapshot)===null,"An unproved/mixed comparison suppressed normal demand processing");
    assert(f.h.live.writes===0 && f.h.live.attempts===0,"A pure proof check called persistence");
  });
}
Deno.test("P1 full journey native: later dimension readback changes revision and answer for consumer revalidation",()=>{
  const f=dimensionRead(),before=sourceBoundDimensionComparison(f.turn,f.snapshot);
  assert(before?.reply,"Initial source proof missing");
  const later=structuredClone(f.snapshot);later.revision++;later.state.entities[1].constraints.max_width_mm=700;
  const after=sourceBoundDimensionComparison(f.turn,later);
  assert(after?.reply && after.revision!==before.revision && after.reply!==before.reply && after.reply.includes("700"),
    "Later canonical readback cannot be distinguished from the original answer");
});
Deno.test("P1 full journey native negative: an embedded unit suffix cannot authorize a dimension comparison",()=>{
  const f=dimensionRead("Portable exhibition frame","width","598mmExtra",595);
  assert(sourceBoundDimensionComparison(f.turn,f.snapshot)===null,
    "Prefix-only mm parsing accepted a different complete written unit");
  assert(f.h.live.writes===0 && f.h.live.attempts===0,"Rejected measurement invoked persistence");
});
Deno.test("P1 full journey native negative: an incomplete inch suffix cannot authorize a dimension comparison",()=>{
  const f=dimensionRead("Portable exhibition frame","width","10inche",595);
  assert(sourceBoundDimensionComparison(f.turn,f.snapshot)===null,
    "An incomplete written inch unit acquired authoritative conversion");
  assert(f.h.live.writes===0 && f.h.live.attempts===0,"Rejected measurement invoked persistence");
});
for(const [subject,detail] of [["Festival catering","labelled vegetarian choices"],["Workspace subscriptions","manual renewal"],["Event equipment rental","one coordinated return"]]){
  Deno.test(`P1 full journey native: compound scope and preference coexist for ${subject}`,async()=>{
    const h=store(),turn=input(subject,detail),result=await runCommerceStateRuntime(h.db,turn);
    assert(result?.persist_result==="success" && result.route==="product_guidance" && h.live.writes===1 && h.live.revision===2,JSON.stringify(result));
    assert(h.live.state.entities.length===0,"Background audience count invented a product");
    const facts=h.live.state.customer_constraints.contextual_scope_facts as Array<Record<string,unknown>>;
    assert(facts.length===2 && facts.every(fact=>fact.company_id===owner.company_id && fact.conversation_id===owner.conversation_id &&
      fact.source_message_id===turn.source_message_id && fact.recorded_revision===2 && fact.subject_label===subject),JSON.stringify(facts));
    const before=JSON.stringify(h.live.state),revision=h.live.revision,writes=h.live.writes;
    await runCommerceStateRuntime(h.db,turn);
    assert(h.live.revision===revision && h.live.writes===writes && JSON.stringify(h.live.state)===before,"Replay rebound mixed scope provenance");
  });
}
for(const mode of ["missing-reading","duplicate-scope-fact","conflicting-scope-fact","duplicate-independent-key","injected-goal","injected-scope-receipt",
  "forged-count","forged-scope-quote","forged-demand","wrong-subject","duplicate-row","foreign-row-owner","wrong-operation","ambiguous"] as const){
  Deno.test(`P1 full journey native negative: mixed facts ${mode} cannot authorize a scope write`,async()=>{
    const h=store(),turn=input(),frame=turn.semantic_frame!;
    const rows=frame.customer_facts![1].value as Array<Record<string,unknown>>;
    if(mode==="missing-reading")turn.semantic_frame=null;
    if(mode==="duplicate-scope-fact")frame.customer_facts!.push(structuredClone(frame.customer_facts![1]));
    if(mode==="conflicting-scope-fact"){const another=structuredClone(frame.customer_facts![1]);(another.value as Array<Record<string,unknown>>)[0].count=7;frame.customer_facts!.push(another);}
    if(mode==="duplicate-independent-key")frame.customer_facts!.push({key:"preference",value:"different value"});
    if(mode==="injected-goal")frame.customer_facts!.push({key:"contextual_goal",value:{goal_id:"model-claimed-goal"}});
    if(mode==="injected-scope-receipt")frame.customer_facts!.push({key:"contextual_scope_facts",value:[]});
    if(mode==="forged-count")rows[0].count=8;
    if(mode==="forged-scope-quote")rows[0].source_text="8 tables";
    if(mode==="forged-demand")frame.demands![0].source_quote="The customer requested another event.";
    if(mode==="wrong-subject")rows[0].subject_label="Unmentioned subscription";
    if(mode==="duplicate-row")rows.push(structuredClone(rows[0]));
    if(mode==="foreign-row-owner")rows[0].company_id="foreign-company";
    if(mode==="wrong-operation")frame.operation="ASK_FACT";
    if(mode==="ambiguous")frame.ambiguity.is_ambiguous=true;
    const before=JSON.stringify(h.live.state),result=await runCommerceStateRuntime(h.db,turn);
    assert(h.live.writes===0 && h.live.revision===1 && JSON.stringify(h.live.state)===before && !result?.trusted_journey_progress,
      "Unverified compound input acquired canonical authority: "+JSON.stringify(result));
  });
}
for(const mode of ["missing-owner","missing-ticket","missing-source","invalid-revision"] as const){
  Deno.test(`P1 full journey native negative: mixed scope ${mode} has no source context`,()=>{
    const turn=input(),context={...owner,source_message_id:turn.source_message_id,state_revision:1};
    if(mode==="missing-owner")context.company_id="";
    if(mode==="missing-ticket")context.conversation_id="";
    if(mode==="missing-source")context.source_message_id="";
    if(mode==="invalid-revision")context.state_revision=1.5;
    assert(verifiedCurrentScopeFacts({text:turn.text,semantic_frame:turn.semantic_frame,state:createEmptyConversationCommerceState(),context})===null,
      "Unbound source context acquired a scope proof");
  });
}
