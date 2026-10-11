import {withMockAccounting} from "../../../tests/model-accounting/provider-fixture.ts";
/** Isolated runtime regression, provider transport intercepted. Not production acceptance/Quality95. */
import { shouldRefreshCanonicalMemory } from './conversation-resolution-contract.ts';
import { isCurrentRequirementsRecap, customerBusinessText } from './commerce-state-authority.ts';
import { classifyHandoffIntent as routeHandoff } from './conversation-intelligence.ts';
import { classifyHandoffIntent } from './handoff-intent.ts';
import { buildCanonicalConversationMemory, refreshConversationLongMemory } from './conversation-long-memory.ts';
import { createEmptyConversationCommerceState } from './commerce-state-contract.ts';
import { prepareConversationRecall } from './conversation-recall.ts';
import { recallFixture } from './conversation-recall.test.ts';
import { runCommerceStateRuntime } from './commerce-state-runtime.ts';
import { interpretCommerceSemantics, buildPersistentCommerceStateSummary } from './commerce-semantic-interpreter.ts';
import { normalizeCommerceSemanticFrame } from './commerce-semantic-frame.ts';
import { projectTicketSummary } from '../../../src/components/console/handoff-summary.ts';
const assert=(x:unknown,m:string)=>{if(!x)throw Error(m)};
const original='我們想整理網店的需求：現有240件商品，由3位同事負責，客群集中在香港。目前不需要手機App。以上是我提供的背景，請先記住，不用查商家的資料。';
const correction='剛才商品數字寫錯了，請改成275件，240件已經不是現況。人手仍是3位同事，市場仍在香港，也仍然不需要App。這次只更正我們自己的要求。';
const recap='請替我整理目前已說過的需求，列出商品數目、同事人數、服務市場，以及是否要App。只覆述我自己的資料，不要新增或更改任何要求。';
const mixed='補充一點：我们先用網頁版，不需要手機App。請安排真人客服接手，將商品數量、人手、香港市場及剛才更正後的資料一併交給他，不要把舊數字當成現況。';
const rows=(text:string,id:string)=>({role:'visitor',content:text,id});
const build=(h:any[],previous:any=null,delta:any[]=[])=>buildCanonicalConversationMemory({previous,conversation_id:'conversation',company_id:'company',source_message_id:h[0].id,commerce_state_revision:2,commerce_state:createEmptyConversationCommerceState(),newest_first:h,visitor_turn_count:h.length,source_created_at:'2026-10-08T00:00:00Z',next_memory_revision:(previous?.memory_revision??0)+1,customer_fact_delta:delta});
Deno.test('actual saved F13 and mixed R1 failures: initial facts, correction, complete immutable recap and source-bound handoff snapshot',async()=>{
 assert(!isCurrentRequirementsRecap(original),'new background mistaken for recap');
 assert(isCurrentRequirementsRecap(recap),'negative mutation instruction mistaken for new fact');
 assert(routeHandoff(mixed).explicit_request && classifyHandoffIntent(mixed).explicit_request,'mixed explicit request lost');
 let memory=build([rows(original,'original')]);
 assert(memory.current_customer_facts.some(f=>f.key==='product_count'&&f.value===240),'initial background not recoverable');
 memory=build([rows(correction,'correction'),rows(original,'original')],memory);
 const f=Object.fromEntries(memory.current_customer_facts.map(f=>[f.key,f]));
 assert(f.product_count.value===275 && f.staff_count.value===3 && f.app_interest.value===false && f.current_market.value==='hong_kong',JSON.stringify(f));
 assert(f.product_count.source_message_id==='correction'&&f.staff_count.source_message_id==='original','unchanged facts relabelled');
 const state=createEmptyConversationCommerceState(),before=JSON.stringify(memory);let writes=0;
 const db:any={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{revision:2,state},error:null})})})}),rpc:async()=>{writes++;throw Error('recap state mutation')}};
 const out=await runCommerceStateRuntime(db,{conversation_id:'conversation',company_id:'company',source_message_id:'recap',text:recap,language:'zh-TW'});
 assert(out?.reason==='read_only_current_requirements_recap'&&writes===0,'recap persisted Commerce');
 assert(!shouldRefreshCanonicalMemory({outcome:out,explicit_handoff:false,customer_owned_delta:true,semantic_fact_delta:false}),'lexical needs/correction hint overrode read-only Memory intent');
 const input=recallFixture(recap);input.memory={...memory,conversation_id:input.conversation_id,company_id:input.company_id,source_message_id:input.source_message_id,commerce_state_revision:input.commerce!.revision};input.commerce!.state=state;
 const reply=prepareConversationRecall(input,'zh-TW');
 assert(reply.decision.handled&&reply.reply?.includes('275')&&reply.reply.includes('人手: 3')&&reply.reply.includes('香港')&&reply.reply.includes('不需要')&&!reply.reply.includes('240'),JSON.stringify(reply));
 assert(JSON.stringify(memory)===before,'recap resolver changed Memory/hash inputs');
 memory=build([rows(mixed,'mixed'),rows(recap,'recap'),rows(correction,'correction'),rows(original,'original')],memory);
 assert(memory.current_customer_facts.some(f=>f.key==='preferred_interface'&&f.value==='web'&&f.source_message_id==='mixed'),'web requirement lost');
 assert(!JSON.stringify(memory.latest_corrections).includes('交給他')&&!JSON.stringify(memory.cancelled_or_superseded).includes('cancelled item'),'control pollution');
 const packageValue={schema_version:'c2-handoff-1.0.0',structured_package:{schema_version:'c2-handoff-1.0.0',conversation_id:'conversation',company_id:'company',current_customer_goal:memory.current_goal,current_customer_facts:memory.current_customer_facts}};
 const ui=JSON.stringify(projectTicketSummary(packageValue,'conversation','company'));
 assert(ui.includes('網頁版')&&ui.includes('275')&&ui.includes('App 需要：否')&&!ui.includes('product_count')&&!ui.includes('240'),ui);
});
Deno.test('canonical R1 cross-industry mixed requests preserve business data; negative/reference/conditional controls remain non-R1',()=>{
 for(const subject of ['預約按摩','每月訂閱','SaaS 席位','租用儀器','網店','配送服務']) {
  for(const text of [`${subject}需要4位使用者，不需要App，請安排真人客服接手。`,`${subject}不需要付款，並請安排真人客服接手。`,`${subject}不需要App請安排真人客服接手。`,`I need ${subject} for 4 users but please transfer me to a human agent`]) {
   assert(classifyHandoffIntent(text).explicit_request,text);
   const business=customerBusinessText(text);assert(business.includes(subject)&&!classifyHandoffIntent(business).explicit_request,business);
  }
 }
 for(const text of ['不需要真人客服接手','不需要App但不要安排真人接手','不要安排真人客服接手','如果之後需要，再安排真人客服接手','你剛才說請安排真人客服接手','真人客服是否提供預約服務？','I do not want a human agent','If this fails please transfer me to a human agent','You said please transfer me to a human agent','Is a human agent available?']) assert(!routeHandoff(text).explicit_request && !classifyHandoffIntent(text).explicit_request,text);
});
Deno.test('120-turn Memory retains corrected requirements and novel cross-topic facts without attributing old facts to recap',()=>{
 const h=[rows(correction,'correction'),...Array.from({length:120},(_,i)=>rows(`收到，多謝。${i}`,'noise'+i)),rows(original,'original')];
 const memory=build(h,null,[{key:'subscription_seats',value:{amount:0,unit:'seats'},authority:'customer',source_message_id:'correction'},{key:'booking_date',value:null,authority:'customer',source_message_id:'correction'},{key:'auto_renew',value:false,authority:'customer',source_message_id:'correction'}]);
 assert(memory.current_customer_facts.some(f=>f.key==='product_count'&&f.value===275),'long context correction lost');
 assert(memory.current_customer_facts.some(f=>f.key==='auto_renew'&&f.value===false)&&memory.current_customer_facts.some(f=>f.key==='booking_date'&&f.value===null),'false/null lost');
 assert(memory.cancelled_or_superseded.some(f=>f.key==='product_count'&&f.value===240),'history lost');
 const after=build([rows(recap,'recap'),...h],memory);
 assert(after.current_customer_facts.every(f=>f.source_message_id!=='recap'),'recap laundered provenance');
});
Deno.test('compact semantic transport uses bounded complete-delta budget, current-turn delta and rejects truncation/overflow before state authority',async()=>{
 const names=['LLM_PROVIDER','LLM_MODEL_EVALUATION','ANTHROPIC_API_KEY','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SUPABASE_SECRET_KEY'];const saved=names.map(n=>Deno.env.get(n));const fetchBefore=globalThis.fetch;
 try {
  Deno.env.set('LLM_PROVIDER','anthropic');Deno.env.set('LLM_MODEL_EVALUATION','isolated-test-model');Deno.env.set('ANTHROPIC_API_KEY','isolated-fake-key');Deno.env.set('SUPABASE_URL','http://accounting.mock');Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','mock-service-key');Deno.env.set('SUPABASE_SECRET_KEY','mock-service-key');
  let calls=0;
  globalThis.fetch=withMockAccounting(async(_url,init)=>{
   calls++;const request=JSON.parse(String(init?.body));assert(request.max_tokens===4096,'budget changed');assert(request.system.includes('Omit unchanged/default fields'),'full snapshot still required');
   return new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify({operation:'NO_STATE_CHANGE',confidence:0.96,customer_facts:[{key:'auto_renew',value:false},{key:'seats',value:{amount:0,unit:'users'}},{key:'appointment_date',value:null}]})}],stop_reason:'end_turn',usage:{output_tokens:100}}));
  });
  const input={company_id:'isolated-company',conversation_id:'isolated-conversation',source_message_id:'isolated-source',latest:'No automatic renewal; zero users; appointment date is unknown.',history:Array.from({length:120},(_,i)=>({role:'visitor',content:`Past topic ${i}`}))};
  const result=await interpretCommerceSemantics(input);assert(result.frame?.customer_facts?.[0].value===false&&result.frame.customer_facts[2].value===null&&calls===1,JSON.stringify(result));
  globalThis.fetch=withMockAccounting(async()=>new Response(JSON.stringify({content:[{type:'text',text:'{"operation":"NO_STATE_CHANGE","confidence":0.9}'}],stop_reason:'max_tokens',usage:{output_tokens:1783}})));
  const truncated=await interpretCommerceSemantics(input);assert(!truncated.frame&&truncated.failure_stage==='truncated','truncated valid-looking JSON accepted');
  globalThis.fetch=async()=>{throw Error('oversized input reached model')};
  const oversized=await interpretCommerceSemantics({...input,latest:'x'.repeat(1601)});assert(oversized.failure_code==='SEMANTIC_INPUT_LIMIT','input silently clipped');
  assert(!normalizeCommerceSemanticFrame({operation:'ADD_ITEM',confidence:0.9,entities:Array(13).fill({name:'service',kind:'service'})}),'partial oversized entity delta accepted');
  assert(!normalizeCommerceSemanticFrame({operation:'NO_STATE_CHANGE',confidence:0.9,customer_facts:[{key:'renew',value:undefined}]}),'undefined became a fact');
 }finally {globalThis.fetch=fetchBefore;names.forEach((n,i)=>saved[i]===undefined?Deno.env.delete(n):Deno.env.set(n,saved[i]!));}
});
Deno.test('novel customer fact corrections retain old values as history; active-fact overflow fails closed',()=>{
 const first=build([rows('We need a subscription.','first')],null,[{key:'renewal',value:false,authority:'customer',source_message_id:'first'}]);
 const next=build([rows('Correction: automatic renewal is now requested.','change')],first,[{key:'renewal',value:true,authority:'customer',source_message_id:'change'}]);
 assert(next.current_customer_facts.some(f=>f.key==='renewal'&&f.value===true&&f.source_message_id==='change'),'new value/source not retained');
 assert(next.cancelled_or_superseded.some(f=>f.key==='superseded_renewal'&&f.value===false&&f.source_message_id==='first'),'old false revived or lineage lost');
 let rejected=false;try{build([rows('New background','limit')],null,Array.from({length:41},(_,i)=>({key:`field_${i}`,value:i,authority:'customer',source_message_id:'limit'})))}catch{rejected=true}
 assert(rejected,'fact limit silently dropped an active customer requirement');
});

Deno.test('semantic current-turn delta sees source-bound canonical background facts, not only empty Commerce',()=>{
 const summary=buildPersistentCommerceStateSummary({revision:2,state:createEmptyConversationCommerceState()},{memory:{current_customer_facts:[{key:"subscription_seats",value:{amount:0,unit:"users"},source_message_id:"actual-first"},{key:"auto_renew",value:false,source_message_id:"actual-correction"},{key:"appointment_date",value:null,source_message_id:"actual-first"}]}});
 const x=JSON.parse(summary!);assert(x.current_customer_facts[1].value===false&&x.current_customer_facts[2].value===null&&x.current_customer_facts[0].value.unit==="users",String(summary));
 assert(x.current_customer_facts[1].source_message_id==="actual-correction",'snapshot source lineage lost');
});
