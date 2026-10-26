import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEmptyConversationCommerceState} from '../../supabase/functions/_shared/commerce-state-contract.ts';
import {reduceTurn,buildCommerceEntityHints} from '../../supabase/functions/_shared/commerce-state-runtime-base.ts';
import {resolveIndustryCustomerJourney} from '../../supabase/functions/_shared/industry-runtime-adapter.ts';
import {buildCanonicalConversationMemory} from '../../supabase/functions/_shared/conversation-long-memory.ts';

const oldSource='00000000-0000-4000-8000-000000000111';
const newSource='00000000-0000-4000-8000-000000000222';
const guidance='我而家只開 8 個分頁，主要做文書同視像通話，唔打機，預算想慳啲。請直接比較 RAM、CPU 同 SSD 嘅取捨，話我知邊啲升級可以暫緩，唔使查店舖售價同庫存。';
function state(){
 const s=createEmptyConversationCommerceState();
 s.current_topic='air_conditioner';
 s.current_intent='replace_existing_appliance';
 s.entities.push({entity_id:'air_conditioner:unscoped',category:'air_conditioner',quantity:1,status:'researching',
  attributes:{quantity_basis:'system_default',room_sizes:{small_bedroom:'80平方呎',large_bedroom:'100平方呎',living_room:'180平方呎'},
  customer_goal:{category:'air_conditioner',objective:'replace_existing_appliance',journey_stage:'sizing_guidance',collected:['space_plan','room_sizes'],missing:['installation_type','sunlight'],source_message_id:oldSource}},
  constraints:{},provenance:{source_type:'customer',source_message_id:oldSource,recorded_at:'2026-10-22T06:14:44Z'}});
 return s;
}
function frame(topic='computer'){
 return {version:'commerce-semantic-1.0.0',language:'zh-TW',operation:'ASK_FACT',intent:'customer_guidance',topic,confidence:.98,
 ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},entities:[],referents:[],customer_facts:[],requested_facts:['selection_tradeoffs'],
 customer_correction:false,additive:false,explicit_negations:[],transaction_state:'none',payment_state:'none',booking_state:'none',fulfillment_state:'none'};
}
const priorHistory=['Hello，屋企想換冷氣，兩間睡房加個客廳，應該點揀好？','細房約80呎，大房100呎，客廳就180呎。'];
function reduce(text,topic='computer'){
 return reduceTurn(state(),{text,company_id:'fixture-company',conversation_id:'fixture-conversation',source_message_id:newSource,
 language:'zh-TW',occurred_at:'2026-10-26T00:15:35Z',history:[],semantic_frame:frame(topic)},buildCommerceEntityHints(priorHistory));
}
test('real v250 regression: one computer guidance turn cannot rewrite existing AC entity or provenance',()=>{
 const before=state();const after=reduce(guidance);
 assert.deepEqual(after.entities,before.entities);
 assert.equal(after.current_topic,before.current_topic);
 assert.equal(after.current_intent,before.current_intent);
 assert.equal(after.conversion.order_status,'none');
 assert.equal(after.conversion.payment_status,'none');
});
for(const [topic,text] of [
 ['computer',guidance],
 ['subscription','請按預算比較升級 SaaS 方案與座位數。'],
 ['service','Please compare our service plan upgrades.'],
 ['rental','我想升級租車套餐，幫我比較安排。'],
]) test('current-turn topic overrules an unrelated historical appliance: '+topic,()=>{
 assert.equal(resolveIndustryCustomerJourney({text,state:state(),language:'zh-TW',semantic_frame:frame(topic)}),null);
});
test('an unconfirmed default appliance quantity cannot be inferred from browser tabs',()=>{
 const next=reduce(guidance);
 assert.equal(next.entities[0].attributes.quantity_basis,'system_default');
 assert.equal(next.entities[0].provenance.source_message_id,oldSource);
});
test('legitimate explicit return to AC remains permitted without duplicating entities',()=>{
 const text='講返冷氣，細房80平方呎，大房100平方呎，客廳180平方呎。';
 const next=reduce(text,'air_conditioner');
 assert.equal(next.entities.length,1);
 assert.equal(next.entities[0].category,'air_conditioner');
 assert.equal(resolveIndustryCustomerJourney({text,state:state(),language:'zh-TW',semantic_frame:frame('air_conditioner')})?.category,'air_conditioner');
});

test('latest cross-topic guidance overrides stale AC goal in Memory and handoff projection',()=>{
 const current=reduce(guidance);
 const decision={kind:'guidance',continuation:false,general_request:'請直接比較 RAM、CPU 同 SSD 嘅取捨',merchant_request:null,latest_requirements:guidance};
 const memory=buildCanonicalConversationMemory({
  conversation_id:'00000000-0000-4000-8000-000000000001',
  company_id:'00000000-0000-4000-8000-000000000002',
  source_message_id:newSource,
  source_created_at:'2026-10-26T00:15:35Z',
  commerce_state_revision:3,commerce_state:current,
  newest_first:[{id:newSource,role:'visitor',content:guidance,created_at:'2026-10-26T00:15:35Z'}],
  visitor_turn_count:3,next_memory_revision:9,request_decision:decision,
 });
 assert(memory.current_goal?.includes('RAM') && memory.current_goal?.includes('8'));
 assert(!memory.current_goal?.startsWith('air conditioner:'));
 assert.equal(memory.handoff_relevant_state.current_goal,memory.current_goal);
 assert(memory.current_topic?.includes('RAM'));
 assert.notEqual(memory.current_topic,'air_conditioner');
 assert.equal(current.entities.length,1);
 assert.equal(current.entities[0].provenance.source_message_id,oldSource);
});
