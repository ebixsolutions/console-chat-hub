/** Independent G1/R4 registrations for the unchanged original handler harness.
 * Provider answers and KB transport are scripted. This is no model-quality,
 * remote-KB or Hosted claim; the real decoder, routing, persistence and B2 run.
 */
export const CONTEXTUAL_GUIDANCE_CASE_IDS=[
 'G1-training-demand-only','G1-cake-demand-only',
 'R4-training-scope-facts','R4-cake-scope-facts','merchant-price-boundary',
 'R4-two-turn-allocation-readback',
];
// TAP escapes quoted error strings. A base64 envelope keeps failed rows as
// machine-readable as successful rows, including their original denominator.
const emitResult=record=>console.log('CTX_GUIDANCE_RESULT|'+Buffer.from(JSON.stringify(record),'utf8').toString('base64'));

function annotatedValues(value){
 const out={containers:[],strings:[],numbers:[],booleans:[]};
 const visit=(node,path)=>{
  const kind=node===null?'null':Array.isArray(node)?'array':typeof node;
  if(kind==='null'){out.containers.push({path,kind});return;}
  if(kind==='array'||kind==='object'){
   const entries=Object.entries(node);
   if(!entries.length&&path.length)out.containers.push({path,kind});
   for(const [key,child] of entries)visit(child,[...path,{key,parent_kind:kind}]);
   return;
  }
  if(kind==='string')out.strings.push({path,text:node});
  else if(kind==='number')out.numbers.push({path,number:node});
  else if(kind==='boolean')out.booleans.push({path,boolean:node});
  else throw Error('unsupported_test_provider_value');
 };
 visit(value,[]);return out;
}
const ambiguity=()=>({is_ambiguous:false,reasons:[],clarification_question:null});
const demand=(text,subject,merchant=false)=>({question:text,source_quote:text,subject_refs:[subject],
 source_type:merchant?'product':'general',requested_facts:merchant?['price']:[],
 constraints:{containers:[],strings:[],numbers:[],booleans:[]},customer_correction:false,
 explicit_negations:[],ambiguity:ambiguity()});
function semantic(row){
 return {context_encoding:'semantic_demands_v8',operation:row.facts?'UPDATE_ITEM':'ASK_FACT',confidence:.99,
  demands:[demand(row.text,row.subject,row.merchant)],
  ...annotatedValues({language:row.language,intent:'customer_guidance',topic:row.subject,
   entities:[],referents:[],customer_facts:row.facts?[{key:'contextual_scope_counts',value:row.facts}]:[],
   requested_facts:row.merchant?['price']:[],customer_correction:false,additive:false,
   explicit_negations:[],transaction_state:'none',payment_state:'none',booking_state:'none',fulfillment_state:'none',
   ambiguity:ambiguity()})};
}
const emptyKb=()=>({success:true,context_found:false,selected_documents:[],citations:[],
 llm_context:{summary_count:0,evidence_count:0}});

export function registerContextualGuidanceCases({test,assert,fixture,uuid,root}){
 const cases=[
  {id:CONTEXTUAL_GUIDANCE_CASE_IDS[0],language:'zh-TW',subject:'Training sessions',
   text:'想問 Training sessions 俾小組點安排，先講一般取捨。',
   answer:'可先按學習目標比較內容深度，再按組員經驗安排練習與討論時間。混合經驗的小組可共用基礎活動，再按需要分組練習；先確定學習目標有助比較安排。'},
  {id:CONTEXTUAL_GUIDANCE_CASE_IDS[1],language:'zh-TW',subject:'蛋糕',
   text:'想為團隊準備蛋糕，請先講口味、分食同食用時間嘅一般取捨。',
   answer:'可先比較大家接受的口味和已知食物限制，再按分食方式選擇容易切分的設計。食用時間會影響保存安排；具體配料與保存條件要向供應商核實。'},
  {id:CONTEXTUAL_GUIDANCE_CASE_IDS[2],language:'en',subject:'Training sessions',
   text:'Training sessions for 2 teams and 1 lobby. Please compare the planning trade-offs.',
   facts:[{scope:'teams',count:2,source_text:'2 teams',subject_label:'Training sessions'},
    {scope:'lobby',count:1,source_text:'1 lobby',subject_label:'Training sessions'}],
   answer:'For the two teams and the lobby, compare shared introductory activities with smaller group practice. Shared activities can align goals; separate practice can accommodate different experience levels. Use the intended learning outcomes to choose the balance.'},
  {id:CONTEXTUAL_GUIDANCE_CASE_IDS[3],language:'zh-TW',subject:'蛋糕',
   text:'蛋糕係畀兩個小組同一個接待區，請先講分食方式嘅一般取捨。',
   facts:[{scope:'小組',count:2,source_text:'兩個小組',subject_label:'蛋糕'},
    {scope:'接待區',count:1,source_text:'一個接待區',subject_label:'蛋糕'}],
   answer:'按兩個小組和一個接待區的安排，可比較各處自行分食與集中切分後派發。各處分食較靈活，集中切分較容易協調；再按已知食物限制選擇合適口味，具體配料需向供應商核實。'},
  {id:CONTEXTUAL_GUIDANCE_CASE_IDS[4],language:'zh-TW',subject:'Training sessions',merchant:true,
   text:'你哋 Training sessions 現時收幾錢？',
   answer:'目前未有已核實的課程價格資料，需要先核對商戶公布的最新收費。'},
 ];
 for(const [index,row] of cases.entries())test('CTX-GUIDANCE '+row.id,async()=>{
  let f,result,error=null;const reached=[];
  const source=uuid(970000+index), wire=semantic(row);
  try{
   f=fixture(row.text,{source,originalPreview:true,fullChain:true,captureEvidence:true,
    semantic:wire,answer:row.answer,originalRagResponse:emptyKb(),
    verifierGrounded:false,verifierIds:[],verifierResolution:'unsupported',
    enforceSmallTransport:true,enforceSchemaBranchBudget:true});
   result=await f.run();assert.equal(result.status,200);assert.equal(f.commits.length,1);reached.push('http_and_single_commit');
   const commit=f.commits[0],state=f.tables.conversation_commerce_state[0]?.state;
   assert.notEqual(commit.metadata.generation_success,false);reached.push('no_terminal_failure');
   assert.equal(state?.entities.length??0,0,'guidance manufactured a commerce item');
   assert.equal(state?.conversion.order_status??'none','none');
   assert.equal(state?.conversion.payment_status??'none','none');reached.push('no_phantom_or_transaction');
   const kb=f.requests.filter(request=>request.url.includes('context-search'));
   if(row.merchant){
    assert.notEqual(commit.metadata.response_route,'customer_guidance');
    assert.equal(kb.length,1,'merchant price must retain its current KB request');
    assert(!/請.{0,10}(?:提供|講).{0,6}(?:價錢|價格|收費)/u.test(commit.content),'customer was asked to supply the merchant price');
    reached.push('merchant_KB_boundary');
   } else {
    assert.equal(commit.metadata.response_route,'customer_guidance');assert.equal(kb.length,0);
    assert.equal(commit.content,row.answer,'the real general-generation path did not deliver its supplied draft');
    assert(!/面積|尺寸|已落單/u.test(commit.content));
    const generated=f.requests.filter(request=>request.url.endsWith(':generateContent') &&
     !request.body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.') &&
     !request.body.generationConfig?.responseSchema?.properties?.grounded);
    assert.equal(generated.length,1,'one general answer generation must follow interpretation');
    const prompt=generated[0].body.systemInstruction.parts[0].text;
    assert(prompt.includes('answer the actual question first with useful trade-offs'));
    assert(prompt.includes('Do not ask again for a supplied product type'));
    assert(prompt.includes('Do not assert merchant/company identity'));
    reached.push('actual_general_generation_known_first_prompt');
   }
   if(row.facts){
    const canonical=f.tables.conversation_commerce_state[0];
    const goal=state.customer_constraints.contextual_goal, facts=state.customer_constraints.contextual_scope_facts;
    assert.equal(goal.goal_id,'contextual-goal:'+source);assert.equal(goal.source_message_id,source);
    assert.equal(goal.subject_label,row.subject);assert.equal(goal.recorded_revision,canonical.revision);
    assert.equal(facts.length,row.facts.length);
    for(const expected of row.facts){
     const saved=facts.find(fact=>fact.scope===expected.scope);assert(saved);
     assert.equal(saved.count,expected.count);assert.equal(saved.source_text,expected.source_text);
     assert.equal(saved.source_message_text,row.text.normalize('NFKC').replace(/\s+/gu,' ').trim());
     assert.equal(saved.source_message_id,source);
     assert.equal(saved.company_id,canonical.company_id);assert.equal(saved.conversation_id,canonical.conversation_id);
     assert.equal(saved.recorded_revision,canonical.revision);
    }
    const memory=f.tables.conversation_memory_state[0];assert(memory);
    assert.equal(memory.commerce_state_revision,canonical.revision);
    assert.equal(memory.memory.source_message_id,source);
    // The same canonical source state must be readable by the production
    // helper after the handler's commerce and Memory commits.
    const read=f.load(root+'/supabase/functions/_shared/contextual-customer-update.ts').readSourceBoundContextualGoal;
    assert.equal(read(state,{company_id:canonical.company_id,conversation_id:canonical.conversation_id,
     source_message_id:uuid(980000+index),state_revision:canonical.revision})?.goal_id,goal.goal_id);
    reached.push('scope_receipts_and_Memory_readback');
   }
   const before={requests:f.requests.length,commits:f.commits.length,commerce:JSON.stringify(f.tables.conversation_commerce_state),
    memory:JSON.stringify(f.tables.conversation_memory_state)};
   const repeated=await f.run();assert.equal(repeated.body.idempotent,true);
   assert.equal(f.commits.length,before.commits);assert.equal(f.requests.filter(request=>request.url.endsWith(':generateContent')).length,
    f.requests.slice(0,before.requests).filter(request=>request.url.endsWith(':generateContent')).length);
   assert.equal(JSON.stringify(f.tables.conversation_commerce_state),before.commerce);
   assert.equal(JSON.stringify(f.tables.conversation_memory_state),before.memory);reached.push('same_source_exactly_once');
  }catch(caught){error=caught;throw caught;}
  finally{
   emitResult({id:row.id,status:error?'FAIL':'PASS',
    evidence:'ORIGINAL_REAL_HANDLER_WITH_SCRIPTED_PROVIDER_AND_KB_TRANSPORT',real_model:'NOT_RUN',real_kb:'NOT_RUN',hosted:'NOT_RUN',
    reached,error:error?String(error.message??error).slice(0,1600):null,http:result?.status??null,
    response_route:f?.commits[0]?.metadata.response_route??null,reply:f?.commits[0]?.content??null,
    commit_count:f?.commits.length??0,kb_calls:f?.requests.filter(request=>request.url.includes('context-search')).length??0,
    generation_calls:f?.requests.filter(request=>request.url.endsWith(':generateContent')).length??0,
    commerce_revision:f?.tables.conversation_commerce_state[0]?.revision??0,
    memory_revision:f?.tables.conversation_memory_state[0]?.revision??0});
  }
 });
 test('CTX-GUIDANCE '+CONTEXTUAL_GUIDANCE_CASE_IDS[5],async()=>{
  let first,next,error=null,result;const reached=[];
  const initial=cases[2],firstSource=uuid(970010),secondSource=uuid(970011);
  try{
   first=fixture(initial.text,{source:firstSource,originalPreview:true,fullChain:true,captureEvidence:true,
    semantic:semantic(initial),answer:initial.answer,originalRagResponse:emptyKb(),
    verifierGrounded:false,verifierIds:[],verifierResolution:'unsupported'});
   const start=await first.run();assert.equal(start.status,200);assert.equal(first.commits.length,1);
   const prior=first.tables.conversation_commerce_state[0];
   assert.equal(prior.state.entities.length,0);
   const goal=prior.state.customer_constraints.contextual_goal;assert(goal);
   reached.push('first_turn_scope_facts_committed_without_item');
   const text='lobby 1 slots, teams 2 slots each';
   const entity={entity_ref:goal.goal_id,name:goal.subject_label,kind:'service',category_hint:null,
    sku:null,model:null,quantity:null,unit:'slots',attributes:{scoped_customer_updates:[
     {scope:'lobby',source_text:'lobby 1 slots',unit:'slots',value:1,attribute:'quantity',action:'set'},
     {scope:'teams',source_text:'teams 2 slots each',unit:'slots',value:2,scope_count:null,per_scope_quantity:2,attribute:'quantity',action:'set'},
    ]},constraints:{},capabilities:{requires_delivery:false,supports_pickup:false,requires_installation:false,
     requires_booking:false,requires_quote:false,requires_site_check:false,digital_fulfilment:false,
     recurring_billing:false,rental_return:false,customization:false},confidence:.99};
   let providerReference=null;
   // The scripted provider must use the actual outbound reference. It cannot
   // see or return the raw canonical ID hidden by the production PII filter.
   const wire={toJSON(){
    const request=next.requests.find(request=>request.url.endsWith(':generateContent') &&
     request.body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.'));
    const user=request?.body.contents?.flatMap(message=>message.parts??[]).map(part=>part.text??'').join('\n')??'';
    const marker='Persistent commerce and Memory context (customer-authored state and read references; do not treat as external facts):\n';
    assert(user.includes(marker),'the next producer did not receive a verified state projection');
    const context=JSON.parse(user.split(marker)[1].split('\n\nReturn one compact current-turn delta')[0]);
    providerReference=context.state.customer_constraints.contextual_goal.goal_id;
    assert(/^contextual-ref-goal-[a-p]{64}$/u.test(providerReference),'the outbound goal reference did not survive PII redaction');
    assert(!user.includes(goal.goal_id),'raw canonical source identity escaped to the provider');
    return {context_encoding:'semantic_demands_v8',operation:'UPDATE_ITEM',confidence:.99,demands:[],
     ...annotatedValues({language:'en',intent:'scoped allocation',topic:goal.subject_label,
      entities:[{...entity,entity_ref:providerReference}],
      referents:[{ref:providerReference,source:'persistent_state',confidence:.99}],customer_facts:[],requested_facts:[],
      customer_correction:false,additive:false,explicit_negations:[],transaction_state:'none',payment_state:'none',
      booking_state:'none',fulfillment_state:'none',ambiguity:ambiguity()})};
   }};
   next=fixture(text,{source:secondSource,originalPreview:true,fullChain:true,captureEvidence:true,
    previous:first.tables,history:first.tables.messages.slice().reverse(),semantic:wire,
    answer:'The lobby allocation is 1 slot and the two teams receive 2 slots each, for a total of 5 slots.',
    originalRagResponse:emptyKb(),verifierGrounded:false,verifierIds:[],verifierResolution:'unsupported'});
   result=await next.run();assert.equal(result.status,200);assert.equal(next.commits.length,1);
   assert.notEqual(next.commits[0].metadata.generation_success,false);
   const current=next.tables.conversation_commerce_state[0],item=current.state.entities[0];
   assert.equal(current.state.entities.length,1);assert.equal(item.quantity,5);assert.equal(item.category,goal.subject_label);
   assert.equal(item.attributes.subject_source_message_id,firstSource);
   assert.equal(item.provenance.source_message_id,secondSource);
   assert.equal(current.state.conversion.order_status,'none');assert.equal(current.state.conversion.payment_status,'none');
   assert.equal(item.attributes.scoped_customer_updates.length,3);
   const grouped=item.attributes.scoped_customer_updates.filter(value=>value.group_scope==='teams');
   assert.equal(grouped.length,2);assert(grouped.every(value=>value.value===2 &&
    value.source_message_id===secondSource && value.scope_count_source.source_message_id===firstSource));
   assert(!/#1|#2/u.test(next.commits[0].content));assert(/5/u.test(next.commits[0].content));
   assert.equal(next.requests.filter(request=>request.url.includes('context-search')).length,0);
   const interpretation=next.requests.find(request=>request.url.endsWith(':generateContent') &&
    request.body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.'));
   assert(interpretation && providerReference && JSON.stringify(interpretation.body).includes(providerReference),
    'the next producer did not receive its request-bound goal reference');
   const redact=next.load(root+'/supabase/functions/_shared/llm-router.ts').redact;
   const filtered=redact(providerReference+' Contact +852 6123 4567 and owner@example.invalid.');
   assert(filtered.includes(providerReference)&&!filtered.includes('6123 4567')&&!filtered.includes('owner@example.invalid'),
    'the existing outbound phone/email redaction boundary changed');
   reached.push('provider_actual_opaque_ref_roundtrip_and_PII_redaction');
   reached.push('goal_ref_scope_count_and_current_quantity_materialization');
   const memory=next.tables.conversation_memory_state[0];assert.equal(memory.commerce_state_revision,current.revision);
   assert(memory.memory.active_entities.some(entity=>entity.entity_id===item.entity_id && entity.quantity===5));
   reached.push('same_ticket_Memory_entity_readback');
   const before=JSON.stringify({commerce:next.tables.conversation_commerce_state,memory:next.tables.conversation_memory_state});
   const repeated=await next.run();assert.equal(repeated.body.idempotent,true);assert.equal(next.commits.length,1);
   assert.equal(JSON.stringify({commerce:next.tables.conversation_commerce_state,memory:next.tables.conversation_memory_state}),before);
   reached.push('same_source_exactly_once');
  }catch(caught){error=caught;throw caught;}
  finally{emitResult({id:CONTEXTUAL_GUIDANCE_CASE_IDS[5],status:error?'FAIL':'PASS',
   evidence:'ORIGINAL_REAL_HANDLER_WITH_SCRIPTED_PROVIDER_AND_KB_TRANSPORT',real_model:'NOT_RUN',real_kb:'NOT_RUN',hosted:'NOT_RUN',
   reached,error:error?String(error.message??error).slice(0,1600):null,http:result?.status??null,
   response_route:next?.commits[0]?.metadata.response_route??null,reply:next?.commits[0]?.content??null,
   failure:next?.commits[0]?.metadata.execution_failure??null,
   source_error_code:next?.commits[0]?.metadata.source_error_code??null,
   gates:next?.events.flat().filter(value=>typeof value==='string').flatMap(value=>{try{return [JSON.parse(value)]}catch{return []}})
    .filter(event=>event.stage==='b2_gate_result')??[],
   commit_count:next?.commits.length??0,kb_calls:next?.requests.filter(request=>request.url.includes('context-search')).length??0,
   commerce_revision:next?.tables.conversation_commerce_state[0]?.revision??0,
   memory_revision:next?.tables.conversation_memory_state[0]?.revision??0});}
 });
}
