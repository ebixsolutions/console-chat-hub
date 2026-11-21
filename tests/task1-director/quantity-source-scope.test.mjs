import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmptyConversationCommerceState} from '../../supabase/functions/_shared/commerce-state-contract.ts';
import {reduceTurn,buildCommerceEntityHints} from '../../supabase/functions/_shared/commerce-state-runtime-base.ts';
import {resolveIndustryContextualCandidate,resolveIndustryCustomerJourney} from '../../supabase/functions/_shared/industry-runtime-adapter.ts';

const domains=[
 ['air_conditioner','CW-SUL70BA','部'],
 ['beauty_service','Glow facial package','sessions'],
 ['subscription','Team Pro','seats'],
 ['booking','Hotel Harbour','nights'],
 ['retail','Trek Jacket','items'],
];
function fixture([category,name,unit]) {
 const state=createEmptyConversationCommerceState();state.current_topic=category;
 const id=category==='air_conditioner'?'air_conditioner:unscoped':'generic:'+category;
 state.entities=[{entity_id:id,category,model:name,quantity:1,status:'tentative',attributes:{product_name:name,name:category==='air_conditioner'?'冷氣':name,unit,quantity_basis:'customer_explicit'},constraints:{},provenance:{source_type:'customer',source_message_id:'original-requirement'}}];
 return {state,hints:[{entity_id:id,category,model:name,aliases:[name],attributes:{product_name:name,unit}}]};
}
function frame(f,{operation='UPDATE_ITEM',facts=[],quantity=6,topic='computer',additive=false}={}) {
 const e=f.state.entities[0];
 return {version:'commerce-semantic-1.0.0',language:'en',operation,intent:'other',topic,confidence:.98,
 ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},
 entities:[{entity_ref:e.entity_id,name:e.model,kind:e.category==='air_conditioner'?'physical_product':'service',category_hint:e.category,sku:null,model:e.model,quantity,unit:e.attributes.unit,attributes:{},constraints:{},capabilities:{},confidence:.96}],
 referents:[],customer_facts:facts,requested_facts:[],customer_correction:true,additive,explicit_negations:[],transaction_state:'none',payment_state:'none',booking_state:'none',fulfillment_state:'none'};
}
function apply(f,text,semantic_frame) {return reduceTurn(f.state,{text,semantic_frame,source_message_id:'current-customer-turn',conversation_id:'fixture-ticket',company_id:'fixture-company',language:'en'},f.hints);}

for(const domain of domains) {
 test('unrelated count cannot overwrite '+domain[0]+' under different typed frames',()=>{
  for(const options of [{facts:[{key:'browser_tabs',value:6}]},{facts:[{key:'browser_tabs',value:'6'}]},{facts:[]},{operation:'SET_QUANTITY',facts:[{key:'browser_tabs',value:6}]}]) {
   const f=fixture(domain);const after=apply(f,'now only 6 tabs',frame(f,options));
   assert.deepEqual(after.entities,f.state.entities,'entity and original provenance must remain intact');
   if(options.facts.length)assert.equal(after.customer_constraints.customer_reported_facts.browser_tabs.value,options.facts[0].value);
  }
 });
 test('source bound named and elliptical corrections retain '+domain[0],()=>{
  for(const text of ['make it 3 units',`Change ${domain[1]} to 3 ${domain[2]}`]) {
   const f=fixture(domain);const semantic=frame(f,{quantity:3,topic:domain[0],facts:[{key:'quantity',value:3}]});
   // A current entity can use a generic physical counter in an elliptical
   // utterance; that source count still needs the one compatible referent.
   if(text==='make it 3 units')semantic.entities[0].unit='units';
   const after=apply(f,text,semantic);assert.equal(after.entities[0].quantity,3,text);
   assert.equal(after.entities[0].provenance.source_message_id,'current-customer-turn');
  }
 });
 test('source bound additive update retains '+domain[0],()=>{
  const f=fixture(domain);const after=apply(f,`Add another 2 ${domain[2]} to ${domain[1]}`,frame(f,{quantity:2,topic:domain[0],additive:true,facts:[]}));
  assert.equal(after.entities[0].quantity,3);
 });
}
test('same turn product preservation and unrelated browser quantity keep original entity',()=>{
 const f=fixture(domains[0]);
 const after=apply(f,'冷氣數量不變，依家只開6個分頁',frame(f,{facts:[{key:'browser_tabs',value:6}]}));
 assert.deepEqual(after.entities,f.state.entities);
 assert.equal(after.customer_constraints.customer_reported_facts.browser_tabs.value,6);
});
test('a foreign current semantic topic cannot authorize an elliptical entity mutation',()=>{
 const f=fixture(domains[1]);assert.deepEqual(apply(f,'make it 3 units',frame(f,{quantity:3,topic:'computer'})).entities,f.state.entities);
});
test('a model proposed unit cannot turn unrelated lessons seats or nights into appliances',()=>{
 for(const unit of ['lessons','seats','nights','tabs']) {
  for(const text of [`now only 6 ${unit}`,`make it 6 ${unit}`]) {
   const f=fixture(domains[0]);delete f.state.entities[0].attributes.unit;
   const semantic=frame(f,{quantity:6,topic:'air_conditioner',facts:[]});semantic.entities[0].unit=unit;
   const after=apply(f,text,semantic);assert.deepEqual(after.entities,f.state.entities,text);
  }
 }
});
test('a quantity correction cannot become addition because the model proposes additive',()=>{
 const f=fixture(domains[0]);f.state.entities[0].quantity=3;
 const semantic=frame(f,{operation:'ADD_ITEM',quantity:3,topic:'air_conditioner',additive:true,facts:[]});
 const after=apply(f,'改做3部',semantic);assert.equal(after.entities[0].quantity,3);
});
test('a genuine additive request still uses the current quantity exactly once',()=>{
 const f=fixture(domains[0]);f.state.entities[0].quantity=3;
 const semantic=frame(f,{operation:'ADD_ITEM',quantity:2,topic:'air_conditioner',additive:true,facts:[]});
 const after=apply(f,'冷氣再加2部',semantic);assert.equal(after.entities[0].quantity,5);
});
test('generic units use the known target dimension for unnamed corrections',()=>{
 const f=fixture(domains[1]);
 const semantic=frame(f,{quantity:3,topic:'beauty_service',facts:[{key:'quantity',value:3}]});
 assert.equal(apply(f,'改做3堂',semantic).entities[0].quantity,3);
 for(const unit of ['seats','nights']) {
  const bad=frame(f,{quantity:6,topic:'beauty_service',facts:[]});bad.entities[0].unit=unit;
  assert.deepEqual(apply(f,`now only 6 ${unit}`,bad).entities,f.state.entities);
 }
});
test('new generic request after unrelated browser counts is source-bound without an appliance profile',()=>{
 const turns=[
 '早晨，我間書房大約95呎，想揀部窗口冷氣。見到樂聲 CW-SUL70BA，呢款係幾多匹，同埋有咩主要功能？',
 '更正，實際只係8個分頁，預算想慳啲。請比較 RAM、CPU、SSD 升級優先次序，邊啲可以暫緩？暫時唔使查店舖售價或庫存。',
 '再更正，依家只會開6個分頁，其他文書、視像會議同慳錢要求不變。',
 '我要為兩間睡房同一個客廳選購冷氣，即合共三部；這是測試資料。'
 ];
 const semantic=(i)=>({version:'commerce-semantic-1.0.0',language:'zh-TW',
  operation:i===0||i===3?'ADD_ITEM':'ASK_FACT',intent:i===1||i===2?'customer_guidance':'other',
  topic:i===1||i===2?'computer':'generic_item',confidence:.98,
  ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},
  entities:i===0||i===3?[{entity_ref:i===0?'generic:original-spec':'generic:fresh-need',
   name:'冷氣',kind:'physical_product',category_hint:'generic_item',sku:null,
   model:i===0?'CW-SUL70BA':null,quantity:i===0?null:3,unit:'部',attributes:{},constraints:{},capabilities:{},confidence:.96}]:[],
  referents:[],customer_facts:i===1?[{key:'browser_tabs',value:8}]:i===2?[{key:'browser_tabs',value:6}]:[],
  requested_facts:[],customer_correction:false,additive:false,explicit_negations:[],
  transaction_state:'none',payment_state:'none',booking_state:'none',fulfillment_state:'none'});
 let state=createEmptyConversationCommerceState();
 for(let i=0;i<turns.length;i++){
  state=reduceTurn(state,{text:turns[i],company_id:'fixture-company',conversation_id:'fixture-ticket',
   source_message_id:'source-'+i,language:'zh-TW',
   semantic_frame:semantic(i),
   history:turns.slice(0,i).map(content=>({role:'visitor',content}))},
   buildCommerceEntityHints(turns.slice(0,i+1).reverse()));
  assert.equal(state.current_industry,null,'no industry can be activated');
  const old=state.entities.find(e=>e.entity_id==='generic:original-spec');
  assert(old,'original product reference remains historical context');
  assert.equal(old.quantity,0,'unknown original number must not be invented as one');
  assert.equal(old.provenance.source_message_id,'source-0','browser counts cannot change original source');
  if(i===3){
   const fresh=state.entities.find(e=>e.entity_id==='generic:fresh-need');
   assert(fresh,'new request is distinct from old product specification');
   assert.equal(fresh.quantity,3,'new customer quantity is three, not six tabs');
   assert.equal(fresh.provenance.source_message_id,'source-3');
   assert.equal(fresh.model,null,'old model cannot be copied into a new need');
  }
 }
});

test('T06 original no-semantic-frame four-turn source survives browser corrections',()=>{
 const turns=[
  '早晨，我間書房大約95呎，想揀部窗口冷氣。見到樂聲 CW-SUL70BA，呢款係幾多匹，同埋有咩主要功能？',
  '更正，實際只係8個分頁，預算想慳啲。請比較 RAM、CPU、SSD 升級優先次序，邊啲可以暫緩？暫時唔使查店舖售價或庫存。',
  '再更正，依家只會開6個分頁，其他文書、視像會議同慳錢要求不變。',
  '我要為兩間睡房同一個客廳選購冷氣，即合共三部；這是測試資料。'
 ];
 let state=createEmptyConversationCommerceState();
 for(let index=0;index<turns.length;index++){
  state=reduceTurn(state,{text:turns[index],company_id:'fixture-company',conversation_id:'fixture-ticket',
   source_message_id:'noframe-'+index,language:'zh-TW',
   history:turns.slice(0,index).map(content=>({role:'visitor',content}))},
   buildCommerceEntityHints(turns.slice(0,index+1).reverse()));
  const original=state.entities.find(e=>e.model==='CW-SUL70BA');
  assert(original,'customer source-owned first model persists without a semantic frame, turn '+index);
  assert.equal(original.provenance.source_message_id,'noframe-0');
  assert.equal(original.quantity,0,'8/6 browser tabs must not become merchandise quantity');
  assert.equal(original.attributes.quantity_basis,'system_default');
  assert.equal(state.current_industry,null,'legacy profile cannot reactivate');
  if(index===3){
    const fresh=state.entities.filter(e=>e.entity_id!==original.entity_id&&e.provenance.source_message_id==='noframe-3');
    assert(fresh.length>0,'fresh three unit goal must be recorded');
    assert(fresh.some(e=>e.quantity===3),'explicit original customer total three, never six browser tabs');
    assert(fresh.every(e=>e.model!=='CW-SUL70BA'),'fresh subject cannot borrow historical SKU');
  }
 }
});
test('no selected profile returns only neutral scope clarification',()=>{
 const state=createEmptyConversationCommerceState();
 const candidate=resolveIndustryContextualCandidate({text:'房各一部',history:[],state,language:'zh-TW'});
 assert.equal(candidate.topic,'');assert.deepEqual(candidate.values,[]);assert.equal(candidate.context_sufficient,false);assert.equal(candidate.reply,'');
 assert.match(candidate.clarification,/幾間房/);assert.doesNotMatch(candidate.clarification,/冷氣|匹數/);
});
test('unsupported explicit profile never starts an appliance journey',()=>{
 const f=fixture(domains[0]);f.state.current_industry='beauty';
 assert.equal(resolveIndustryCustomerJourney({text:'冷氣點揀好？',state:f.state,language:'zh-TW'}),null);
});
test('neutral clarification cannot intercept a named service or its distribution',()=>{
 const f=fixture(domains[1]);
 for(const text of ['Glow facial package每間房各一份','每位客人一個Glow facial package','Two Glow facial package sessions for each room']) {
  assert.equal(resolveIndustryContextualCandidate({text,history:[],state:f.state,language:'zh-TW'}),null,text);
 }
});
test('legacy industry state cannot trigger an implicit room followup in Phase 1',()=>{
 const f=fixture(domains[0]);f.state.current_industry='home_appliance';
 const result=resolveIndustryCustomerJourney({text:'書房大約80平方呎',state:f.state,language:'zh-TW'});
 assert.equal(result,null,'Phase 1 has no appliance or other industry journey');
 assert.equal(f.state.entities[0].attributes.name,'冷氣','customer-owned name still persists');
});

// Same Task3C isolated source regressions. All semantic proposals are scripted;
// no model, KB, transaction or Hosted acceptance is inferred from these tests.
function cancelledRoomFixture() {
 const f=fixture(domains[0]);f.state.entities[0].quantity=2;f.state.current_industry='home_appliance';f.state.language='en';
 f.state.entities.push({...structuredClone(f.state.entities[0]),entity_id:'air_conditioner:living_room',quantity:1,status:'cancelled',
  attributes:{unit:'部',name:'客廳那部',customer_subject_aliases:['客廳'],quantity_basis:'customer_explicit'},
  provenance:{source_type:'customer',source_message_id:'cancelled-room-source'}});
 f.hints.push({entity_id:'air_conditioner:living_room',category:'air_conditioner',model:null,aliases:['air_conditioner']});
 f.state.conversion.tentative_entity_ids=['air_conditioner:unscoped'];f.state.conversion.cancelled_entity_ids=['air_conditioner:living_room'];
 return f;
}
test('polite named quantity update retains the inactive room and targets the one active quantity',()=>{
 for(const text of ['可以幫我將冷氣改做三部嗎？','將冷氣改3部']) {
  const f=cancelledRoomFixture(),s=frame(f,{operation:'SET_QUANTITY',quantity:3,topic:'air_conditioner',facts:[]});
  const after=apply(f,text,s);assert.equal(after.entities[0].quantity,3,text);assert.equal(after.entities[1].status,'cancelled',text);
  assert.equal(after.entities[1].provenance.source_message_id,'cancelled-room-source',text);
 }
});
test('polite anonymous quantity operations retain the original mutation grammar',()=>{
 for(const text of ['可唔可以幫我改做三部？','請幫我改做三部好嗎？','Can you make it 3 units?','Could you please change it to 3 units?']) {
  const f=cancelledRoomFixture(),after=apply(f,text,frame(f,{operation:'SET_QUANTITY',quantity:3,topic:'air_conditioner',facts:[]}));
  assert.equal(after.entities[0].quantity,3,text);assert.equal(after.entities[1].status,'cancelled',text);
 }
 for(const text of ['加多一部','可唔可以幫我再加一部？','Could you add another 1 unit?']) {
  const f=cancelledRoomFixture(),after=apply(f,text,frame(f,{operation:'ADD_ITEM',quantity:1,topic:'air_conditioner',additive:true,facts:[]}));
  assert.equal(after.entities[0].quantity,3,text);assert.equal(after.entities[1].status,'cancelled',text);
 }
});
test('pure quantity questions remain read only despite a scripted SET proposal',()=>{
 for(const text of ['我而家實際買幾多部冷氣？','冷氣而家係三部定兩部？','What is my current quantity?','Can you tell me how many units I wanted?']) {
  const f=cancelledRoomFixture();assert.deepEqual(apply(f,text,frame(f,{operation:'SET_QUANTITY',quantity:3,topic:'air_conditioner',facts:[]})),f.state,text);
 }
});
test('a named inactive scope cannot redirect its quantity to the active aggregate',()=>{
 const f=cancelledRoomFixture(),after=apply(f,'客廳冷氣改做三部',frame(f,{operation:'SET_QUANTITY',quantity:3,topic:'air_conditioner',facts:[]}));
 assert.equal(after.entities[0].quantity,2);assert.equal(after.entities[1].quantity,1);assert.equal(after.entities[1].status,'cancelled');
});
test('explicit restoration of the one named room retains its lawful existing path',()=>{
 for(const text of ['客廳那部恢復','客廳那部重新要','客廳嗰部要返']) {
  const f=cancelledRoomFixture(),s=frame(f,{operation:'NO_STATE_CHANGE',quantity:2,topic:'air_conditioner',facts:[]});s.entities=[];s.customer_correction=false;
  const after=apply(f,text,s);assert.equal(after.entities[0].quantity,2,text);assert.equal(after.entities[1].status,'tentative',text);
  assert.equal(after.entities[1].provenance.source_message_id,'current-customer-turn',text);
 }
});
test('a fresh multi-room purchase goal updates its aggregate without reviving the cancelled scope',()=>{
 const f=cancelledRoomFixture(),s=frame(f,{operation:'ADD_ITEM',quantity:3,topic:'air_conditioner',facts:[]});s.customer_correction=false;
 const after=apply(f,'我要為兩間睡房同一個客廳選購冷氣，即合共三部；這是測試資料。',s);
 if(after.entities[0].quantity!==3)console.log('D4_GENERIC_GOAL_DIAG|'+JSON.stringify({
   case_id:'fresh-multi-subject-goal',entities:after.entities.map(e=>({
    id:e.entity_id,qty:e.quantity,status:e.status,category:e.category,
    source:e.provenance?.source_message_id,display:e.attributes.product_name,name:e.attributes.name})),
   current_topic:after.current_topic,current_intent:after.current_intent,
   expected:3,source_attested:false}));
 assert.equal(after.entities[0].quantity,3);assert.equal(after.entities[1].status,'cancelled');
});
test('multiple active quantities are not made unambiguous by a generic category name',()=>{
 const f=cancelledRoomFixture();f.state.entities[1].status='tentative';
 const after=apply(f,'可以幫我將冷氣改做三部嗎？',frame(f,{operation:'SET_QUANTITY',quantity:3,topic:'air_conditioner',facts:[]}));
 assert.deepEqual(after.entities.map(e=>e.quantity),[2,1]);
});
test('same-target specification allocation uses the source count sum and never the attribute numbers',()=>{
 const f=cancelledRoomFixture();f.state.entities[0].quantity=3;
 const after=apply(f,'改做一部1匹，一部1.5匹。',null);
 assert.equal(after.entities[0].quantity,2);assert.equal(after.entities[1].status,'cancelled');
 assert.equal(after.entities[0].provenance.source_message_id,'current-customer-turn');
 for(const text of ['水泵改做一部1匹，一部1.5匹。','冷氣數量不變，水泵改做一部1匹，一部1.5匹。']) {
  const prior=cancelledRoomFixture();prior.state.entities[0].quantity=4;
  const proposal=frame(prior,{operation:'SET_QUANTITY',quantity:2,topic:'air_conditioner',facts:[]});
  assert.equal(apply(prior,text,proposal).entities[0].quantity,4,text);
 }
 const foreign=fixture(domains[1]);foreign.state.entities[0].quantity=4;
 assert.equal(apply(foreign,'改做一部1匹，一部1.5匹。',frame(foreign,{operation:'SET_QUANTITY',quantity:2,topic:'air_conditioner',facts:[]})).entities[0].quantity,4);
});
