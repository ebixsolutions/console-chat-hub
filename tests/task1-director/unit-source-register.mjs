import path from 'node:path';
import {createHash} from 'node:crypto';
export const UNIT_SOURCE_IDS=['forged-unit','wrong-typed-entity','mixed-current-price','foreign-snapshot'];
const emit=row=>console.log('UNIT_SOURCE_RESULT|'+Buffer.from(JSON.stringify(row),'utf8').toString('base64'));
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
function wire({text,subject,entityId,category,language,operation='ASK_FACT',unit=null,quantity=null,facts=null}){
 const update=operation==='SET_QUANTITY';
 const frame={language,intent:update?'customer_context_update':'customer_fact_recall',topic:category,
  entities:update?[{entity_ref:entityId,name:subject,kind:'unknown',category_hint:null,sku:null,model:null,
   quantity,unit,attributes:{},constraints:{},capabilities:capabilities(),confidence:.99}]:[],
  referents:[{ref:entityId,source:'persistent_state',confidence:.99}],customer_facts:[],
  requested_facts:facts??(update?[]:['current_quantity']),customer_correction:update,additive:false,explicit_negations:[],
  transaction_state:'none',payment_state:'none',booking_state:'none',fulfillment_state:'none',ambiguity:ambiguity()};
 return{context_encoding:'semantic_demands_v8',operation,confidence:.99,
  demands:[{question:text,source_quote:text,subject_refs:[subject],source_type:'general',
   requested_facts:facts??(update?[]:['current_quantity']),constraints:{containers:[],strings:[],numbers:[],booleans:[]},
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

export function registerUnitSourceCases({test,assert,fixture,uuid,root}){
 for(const[index,id]of UNIT_SOURCE_IDS.entries())test('UNIT-SOURCE '+id,async()=>{
  const subject='投影機',entityId='generic:投影機',unit='部',quantity=2,category='generic_product';
  const text=id==='mixed-current-price'?'更正：投影機改為3台。另外，現價幾多？':'更正：投影機改為3台。';
  const payload=wire({text,subject,entityId:id==='wrong-typed-entity'?'generic:unknown':entityId,category,language:'zh-TW',
   operation:'SET_QUANTITY',unit:id==='forged-unit'?'boxes':'台',quantity:3,facts:id==='mixed-current-price'?['price']:[]});
  const f=fixture(text,{originalPreview:true,fullChain:true,captureEvidence:true,source:uuid(979001+index*10),semantic:payload,
   originalRagResponse:noKb(),verifierGrounded:false,verifierIds:[],verifierResolution:'unsupported',answer:'現時未有已核實的售價。'});
  const seeding=seed(f,{root,uuid,id:979000+index*10,subject,unit,quantity,sourceText:'我需要2部投影機。',category});
  if(id==='foreign-snapshot')f.tables.conversation_commerce_state[0].company_id=uuid(979999);
  let response,error=null;const checks=[];const check=(name,condition,actual)=>checks.push({name,status:condition?'PASS':'FAIL',actual});
  try{
   response=await f.run();const state=f.tables.conversation_commerce_state[0]?.state,item=state?.entities.find(e=>e.entity_id===entityId);
   const replies=f.commits??[];
   check('no_unproved_unit_ack',replies.every(row=>row.metadata.commerce_reason!=='source_bound_quantity_unit_committed'),replies);
   if(id==='mixed-current-price'){
    check('source_quantity_and_unit_persist',item?.quantity===3&&item.attributes.unit==='台'&&item.provenance.source_message_id===uuid(979001+index*10),item);
    check('merchant_request_kept',f.requests.filter(row=>row.url.includes('context-search')).length===1,f.requests.filter(row=>row.url.includes('context-search')));
    check('no_invented_price',replies.every(row=>!/(?:HKD|HK\$|\$)\s*\d/u.test(row.content)),replies);
   }else{
    check('original_quantity_and_unit_preserved',item?.quantity===2&&item.attributes.unit==='部',item);
    check('no_false_customer_source',item?.provenance.source_message_id===seeding.source.id,item?.provenance);
   }
   check('no_transaction_promotion',state?.conversion.order_status==='none'&&state?.conversion.payment_status==='none',state?.conversion);
   assert.equal(checks.filter(row=>row.status==='FAIL').length,0,JSON.stringify(checks.filter(row=>row.status==='FAIL')));
  }catch(e){error=e;throw e;}finally{emit({id,status:error?'FAIL':'PASS',error:error?String(error.message):null,checks,
   source:text,payload,seed:seeding,first:snapshot(f,response),hosted:'NOT_RUN',real_model:'NOT_RUN',real_kb:'NOT_RUN'});}
 });
}
