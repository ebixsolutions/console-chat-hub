/** Source regressions only: never claims production acceptance or Quality95. */
import { deriveRequirementFacts, deriveCurrentRequirementSnapshot } from './conversation-runtime-state-core.ts';
import { customerBusinessText, isCurrentRequirementsRecap } from './commerce-state-authority.ts';
import { buildCanonicalConversationMemory } from './conversation-long-memory.ts';
import { createEmptyConversationCommerceState } from './commerce-state-contract.ts';
import { prepareConversationRecall } from './conversation-recall.ts';
import { recallFixture } from './conversation-recall.test.ts';
import { runCommerceStateRuntime } from './commerce-state-runtime.ts';
import { resolveCanonicalCommerceResolution } from './conversation-resolution-contract.ts';
import { projectTicketSummary } from '../../../src/components/console/handoff-summary.ts';
const assert=(v:unknown,m:string)=>{if(!v) throw Error(m)};
const recap='講返我而家嘅要求：商品數量、人手、市場同App需要。只用我提供過嘅資料，唔查商家政策。';
const history=[{id:'correction',role:'visitor',content:'更正：我而家有275件商品，唔係240件；人手仍然係3位同事，香港市場同暫時唔需要App都維持。只係更新我自己嘅資料。'},
{id:'original',role:'visitor',content:'我目前有240件商品、3位同事，主要做香港市場，暫時唔需要手機 App。'}];
const build=(rows=history,previous:any=null)=>buildCanonicalConversationMemory({conversation_id:'conversation',company_id:'company',source_message_id:rows[0].id,commerce_state_revision:2,commerce_state:createEmptyConversationCommerceState(),newest_first:rows,visitor_turn_count:rows.length,source_created_at:'2026-10-08T00:00:00Z',next_memory_revision:2,previous});
Deno.test('F13 latest corrected facts retain polarity and actual assertion lineage',()=>{
 const m=build();const f=Object.fromEntries(m.current_customer_facts.map(f=>[f.key,f]));
 assert(f.product_count.value===275 && f.staff_count.value===3 && f.current_market.value==='hong_kong' && f.app_interest.value===false,JSON.stringify(f));
 assert(f.product_count.source_message_id==='correction' && f.staff_count.source_message_id==='original','assertion provenance laundered');
 assert(!m.current_goal?.includes('240') && m.cancelled_or_superseded.some(f=>f.value===240),'old count remains active or lost from superseded history');
 const handoff=build([{id:'handoff',role:'visitor',content:'我想轉接真人，請將我已提供同更正過嘅資料交畀客服，唔好再問產品。'},...history],m);
 assert(JSON.stringify(handoff.current_customer_facts)===JSON.stringify(m.current_customer_facts),'handoff rewrote customer fact lineage');
});
Deno.test('F13 different quantities, negated-old-first, languages and zero are not fixture dispatch keys',()=>{
 for (const text of ['唔係19件商品，而家有37件商品；0位同事；目前新加坡市場；不需要手機App。','I currently have 37 products, 0 colleagues; current market Singapore. I do not need mobile app.']) {
  const s=deriveCurrentRequirementSnapshot([text]);
  assert(s.product_count===37 && s.staff_count===0 && s.app_interest===false && s.current_market==='singapore',JSON.stringify(s));
 }
 const s=deriveCurrentRequirementSnapshot(['我有2位員工','再加3位同事']); assert(s.staff_count===5,'additive staff double-counted');
 assert(deriveCurrentRequirementSnapshot(['我需要App']).app_interest===true,'positive mistaken for negative');
 assert(deriveCurrentRequirementSnapshot(['我有12件商品']).app_interest===null,'omission became false');
});
Deno.test('F13 recap excluded lookup is read-only, while a new merchant question still requires KB',async()=>{
 assert(isCurrentRequirementsRecap(recap),'explicit no-lookup turned into merchant lookup');
 assert(!isCurrentRequirementsRecap('Recap my needs, but check the current price'),'mixed merchant request swallowed');
 let writes=0;const state=createEmptyConversationCommerceState();
 const db:any={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{revision:2,state},error:null})})})}),rpc:async()=>{writes++;throw Error('read-only recap attempted write')}};
 const before=JSON.stringify(state);const outcome=await runCommerceStateRuntime(db,{conversation_id:'conversation',company_id:'company',source_message_id:'recap',text:recap,language:'zh-TW'});
 assert(outcome?.persist_result==='read_only' && outcome.reason==='read_only_current_requirements_recap' && writes===0 && before===JSON.stringify(state),'recap mutated Commerce');
 assert(resolveCanonicalCommerceResolution({outcome,authoritative_address_correction:false}).skip_memory_refresh,'recap would rebuild Memory');
 const facts=deriveRequirementFacts([{id:'recap',role:'visitor',content:recap},...history]);
 assert(facts.current.every(f=>f.source_message_id!=='recap'),'recap became fact provenance');
 const input=recallFixture(recap);const m=build();input.memory={...m,conversation_id:input.conversation_id,company_id:input.company_id,source_message_id:input.source_message_id,commerce_state_revision:input.commerce!.revision};
 input.commerce!.state=createEmptyConversationCommerceState();const rendered=prepareConversationRecall(input,'zh-TW');
 assert(rendered.decision.handled && rendered.reply?.includes('275') && rendered.reply.includes('人手: 3') && rendered.reply.includes('不需要') && !rendered.reply.includes('240'),JSON.stringify(rendered));
});
Deno.test('F14 persisted Summary renders false, zero, unknown and source-bound customer facts without promoting KB',()=>{
 const memory=build();const p:any={schema_version:'c2-handoff-1.0.0',conversation_id:'conversation',company_id:'company',current_customer_goal:memory.current_goal,current_customer_facts:[...memory.current_customer_facts,{key:'deposit',value:0,authority:'customer',source_message_id:'original'},{key:'availability',value:null,authority:'customer',source_message_id:'original'}]};
 const envelope={schema_version:p.schema_version,structured_package:p};const summary=projectTicketSummary(envelope,'conversation','company');
 const text=JSON.stringify(summary);assert(text.includes('275') && text.includes('人手：3') && text.includes('App 需要：否') && text.includes('deposit：0') && text.includes('availability：未確認') && !text.includes('240'),text);
 assert(!summary?.some(s=>s.title==='已核實產品資料'),'customer requirements promoted to KB');
 assert(projectTicketSummary(envelope,'conversation','wrong-company')===null,'cross-tenant Summary accepted');
});

Deno.test('F13 handoff controls are not new Commerce corrections; real mixed facts survive',async()=>{
 const control='我想轉接真人，請將我已提供同更正過嘅資料交畀客服，唔好再問產品。';
 assert(customerBusinessText(control)==='', 'control became customer data');
 assert(customerBusinessText('我想轉接真人；改為37件商品')==='改為37件商品','mixed correction lost');
 assert(customerBusinessText('請問真人客服政策？')==='請問真人客服政策？','merchant question stripped');
 let writes=0; const state=createEmptyConversationCommerceState();
 const db:any={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{revision:7,state},error:null})})})}),rpc:async()=>{writes++;throw Error('handoff mutated Commerce')}};
 const outcome=await runCommerceStateRuntime(db,{conversation_id:'conversation',company_id:'company',source_message_id:'handoff',text:control,language:'zh-TW'});
 assert(outcome?.persist_result==='read_only' && outcome.revision===7 && writes===0,'handoff mutated committed state');
});
