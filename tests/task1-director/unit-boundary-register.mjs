import path from 'node:path';
import {createHash} from 'node:crypto';
export const UNIT_BOUNDARY_IDS=['literal-unit-change','read-seats','read-licences','read-training-slots'];
const emit=row=>console.log('UNIT_BOUNDARY_RESULT|'+Buffer.from(JSON.stringify(row),'utf8').toString('base64'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const ambiguity=()=>({is_ambiguous:false,reasons:[],clarification_question:null});
const capabilities=()=>({requires_delivery:false,supports_pickup:false,requires_installation:false,requires_booking:false,requires_quote:false,requires_site_check:false,digital_fulfilment:false,recurring_billing:false,rental_return:false,customization:false});
function annotatedValues(value){
 const out={containers:[],strings:[],numbers:[],booleans:[]};
 function visit(node,path){
  const kind=node===null?'null':Array.isArray(node)?'array':typeof node;
  if(kind==='null'){out.containers.push({path,kind});return;}
  if(kind==='array'||kind==='object'){
   const entries=Object.entries(node);if(!entries.length&&path.length)out.containers.push({path,kind});
   for(const[key,child]of entries)visit(child,[...path,{key,parent_kind:kind}]);return;
  }
  if(kind==='string')out.strings.push({path,text:node});
  else if(kind==='number')out.numbers.push({path,number:node});
  else if(kind==='boolean')out.booleans.push({path,boolean:node});
  else throw Error('invalid_probe_wire_value');
 }
 visit(value,[]);return out;
}
function wire({text,subject,entityId,category,language,operation='ASK_FACT',unit=null,quantity=null}){
 const update=operation==='SET_QUANTITY';
 const frame={language,intent:update?'customer_context_update':'customer_fact_recall',topic:category,
  entities:update?[{entity_ref:entityId,name:subject,kind:'unknown',category_hint:null,sku:null,model:null,
   quantity,unit,attributes:{},constraints:{},capabilities:capabilities(),confidence:.99}]:[],
  referents:[{ref:entityId,source:'persistent_state',confidence:.99}],customer_facts:[],
  requested_facts:update?[]:['current_quantity'],customer_correction:update,additive:false,explicit_negations:[],
  transaction_state:'none',payment_state:'none',booking_state:'none',fulfillment_state:'none',ambiguity:ambiguity()};
 return{context_encoding:'semantic_demands_v8',operation,confidence:.99,
  demands:[{question:text,source_quote:text,subject_refs:[subject],source_type:'general',
   requested_facts:update?[]:['current_quantity'],constraints:{containers:[],strings:[],numbers:[],booleans:[]},
   customer_correction:update,explicit_negations:[],ambiguity:ambiguity()}],...annotatedValues(frame)};
}
const noKb=()=>({success:true,context_found:false,selected_documents:[],citations:[],llm_context:{summary_count:0,evidence_count:0}});
const parsedEvents=f=>f.events.flat().filter(x=>typeof x==='string').flatMap(x=>{try{return[JSON.parse(x)]}catch{return[]}});
function snapshot(f,response){
 return{response,commits:structuredClone(f.commits),commerce:structuredClone(f.tables.conversation_commerce_state),
  memory:structuredClone(f.tables.conversation_memory_state),commerce_events:structuredClone(f.tables.conversation_commerce_state_event),
  b2:parsedEvents(f).filter(x=>x.stage==='b2_gate_result'),events:structuredClone(f.events),
  requests:f.requests.map(x=>({url:x.url,method:x.method,body:x.body})),
  kb_calls:f.requests.filter(x=>x.url.includes('context-search')).length,
  provider_calls:f.requests.filter(x=>x.url.endsWith(':generateContent')).length};
}
function seed(f,{root,uuid,id,subject,unit,quantity,sourceText,category}){
 const company=f.tables.conversations[0].company_id,ticket=f.tables.conversations[0].id,source=uuid(id);
 const current=f.tables.messages[0];
 const sourceTime=new Date(Date.parse(current.created_at)-1000).toISOString();
 const old={id:source,conversation_id:ticket,role:'visitor',content:sourceText,is_recalled:false,metadata:{},created_at:sourceTime};
 f.tables.messages.push(old);
 const {createEmptyConversationCommerceState}=f.load(path.join(root,'supabase/functions/_shared/commerce-state-contract.ts'));
 const {buildCanonicalConversationMemory}=f.load(path.join(root,'supabase/functions/_shared/conversation-long-memory.ts'));
 const state=createEmptyConversationCommerceState(),entityId='generic:'+subject.toLowerCase().replace(/\s+/g,'-');
 state.current_topic=category;
 state.entities.push({entity_id:entityId,category,brand:null,model:null,quantity,status:'tentative',
  attributes:{product_name:subject,name:subject,customer_subject_aliases:[subject],unit,quantity_basis:'customer_explicit'},
  constraints:{},provenance:{source_type:'customer',source_message_id:source,recorded_at:sourceTime}});
 const row={conversation_id:ticket,company_id:company,source_message_id:source,revision:1,state};
 f.tables.conversation_commerce_state=[row];f.tables.conversation_commerce_state_event=[{...structuredClone(row),applied_revision:1}];
 const memory=buildCanonicalConversationMemory({company_id:company,conversation_id:ticket,source_message_id:source,
  commerce_state_revision:1,commerce_state:state,newest_first:[old],visitor_turn_count:1,source_created_at:sourceTime,next_memory_revision:1});
 f.tables.conversation_memory_state=[{conversation_id:ticket,company_id:company,source_message_id:source,revision:1,
  commerce_state_revision:1,memory,memory_hash:hash(JSON.stringify(memory)),markdown_projection:'Source-owned isolated quantity fixture.'}];
 f.tables.conversation_memory_state_event=[];
 return{row:structuredClone(row),source:old,entityId};
}

export function registerUnitBoundaryCases({test,assert,fixture,uuid,root}){
 const cases=[{id:UNIT_BOUNDARY_IDS[0],subject:'投影機',unit:'部',quantity:2,sourceText:'我需要2部投影機。',category:'generic_product',language:'zh-TW',text:'更正：投影機改為3台。',newUnit:'台',newQuantity:3},
  {id:UNIT_BOUNDARY_IDS[1],subject:'Workshop',unit:'seats',quantity:3,sourceText:'I need 3 seats for Workshop.',category:'service',language:'en',text:'What is my current quantity for Workshop?'},
  {id:UNIT_BOUNDARY_IDS[2],subject:'Workspace',unit:'licences',quantity:3,sourceText:'I need 3 licences for Workspace.',category:'subscription',language:'en',text:'What is my current quantity for Workspace?'},
  {id:UNIT_BOUNDARY_IDS[3],subject:'Orientation',unit:'training slots',quantity:3,sourceText:'I need 3 training slots for Orientation.',category:'service',language:'en',text:'What is my current quantity for Orientation?'}];
 for(const[index,row]of cases.entries())test('UNIT-BOUNDARY '+row.id,async()=>{
  let f,follow,response,followResponse,seeding,error=null,payload=null;const checks=[];
  const check=(name,condition,actual)=>checks.push({name,status:condition?'PASS':'FAIL',actual});
  const options={originalPreview:true,fullChain:true,captureEvidence:true,originalRagResponse:noKb(),
   verifierGrounded:false,verifierIds:[],verifierResolution:'unsupported'};
  try{
   const entityId='generic:'+row.subject.toLowerCase().replace(/\s+/g,'-');
   payload=wire({...row,entityId,operation:row.newUnit?'SET_QUANTITY':'ASK_FACT',unit:row.newUnit??row.unit,quantity:row.newQuantity??row.quantity});
   f=fixture(row.text,{...options,source:uuid(973001+index*20),semantic:payload,
    answer:row.newUnit?'已記低投影機數量為3台。':`Your current ${row.subject} quantity is ${row.quantity} ${row.unit}.`});
   seeding=seed(f,{...row,root,uuid,id:973000+index*20});
   const before=JSON.stringify(f.tables.conversation_commerce_state[0].state);
   response=await f.run();
   const state=f.tables.conversation_commerce_state[0]?.state,item=state?.entities.find(e=>e.entity_id===entityId),reply=f.commits[0];
   check('http_200',response.status===200,response.status);check('one_real_B2_commit',f.commits.length===1&&reply?.metadata.b2_commit_source==='commit_ai_reply_tx',{count:f.commits.length,metadata:reply?.metadata});
   check('no_terminal_failure',reply?.metadata.generation_success!==false&&reply?.metadata.response_route!=='terminal_failure_recovery',reply?.metadata.response_route);
   check('no_unnecessary_customer_fact_KB_request',f.requests.filter(x=>x.url.includes('context-search')).length===0,f.requests.filter(x=>x.url.includes('context-search')).length);
   check('no_transaction',state?.conversion.order_status==='none'&&state?.conversion.payment_status==='none',state?.conversion);
   if(row.newUnit){
    check('quantity_written_from_current_source',item?.quantity===row.newQuantity&&item?.provenance.source_message_id===uuid(973001+index*20),item);
    check('current_literal_unit_retained',item?.attributes.unit===row.newUnit,item?.attributes.unit);
    check('reply_preserves_current_literal_unit',typeof reply?.content==='string'&&/3\s*台/u.test(reply.content)&&!/3\s*部/u.test(reply.content),reply?.content);
    // Continue only from actual committed source/revision, never an assumed
    // successful response. A failed reply is retained in this record.
    if(item?.quantity===row.newQuantity&&item.provenance.source_message_id===uuid(973001+index*20)){
     const text='目前投影機數量係幾多？';
     follow=fixture(text,{...options,source:uuid(973002+index*20),previous:f.tables,history:f.tables.messages.slice().reverse(),
      semantic:wire({...row,text,entityId,operation:'ASK_FACT'}),answer:'目前投影機數量係3台。'});
     followResponse=await follow.run();
     check('followup_read_has_literal_unit',followResponse.status===200&&follow.commits.length===1&&/3\s*台/u.test(follow.commits[0].content)&&!/3\s*部/u.test(follow.commits[0].content),follow.commits[0]?.content);
     check('followup_no_semantic_mutation',JSON.stringify(follow.tables.conversation_commerce_state[0].state)===JSON.stringify(state),follow.tables.conversation_commerce_state[0].state.entities);
    }else checks.push({name:'followup_read_has_literal_unit',status:'NOT_REACHED',reason:'No verified committed current source quantity'});
   }else{
    check('read_only_state_exact',JSON.stringify(state)===before,{before_sha256:hash(before),after_sha256:hash(JSON.stringify(state))});
    check('literal_number_and_unit_answered',typeof reply?.content==='string'&&reply.content.includes(`${row.quantity} ${row.unit}`),reply?.content);
    check('actual_B2_allowed',parsedEvents(f).some(e=>e.stage==='b2_gate_result'&&e.gate_decision==='allow'),parsedEvents(f).filter(e=>e.stage==='b2_gate_result'));
   }
   assert.equal(checks.filter(c=>c.status==='FAIL').length,0,JSON.stringify(checks.filter(c=>c.status==='FAIL')));
  }catch(e){error=e;throw e;}
  finally{emit({id:row.id,status:error?'FAIL':'PASS',error:error?String(error.message):null,checks,source_case:row,seed:seeding,canonical_frame_payload:payload,
   first:f?snapshot(f,response):null,followup:follow?snapshot(follow,followResponse):null,
   evidence:'COMPLETE_ORIGINAL_HANDLER_ISOLATED_TRANSPORT_SCRIPTED_PROVIDER',hosted:'NOT_RUN',real_model:'NOT_RUN',real_kb:'NOT_RUN'});}
 });
}
