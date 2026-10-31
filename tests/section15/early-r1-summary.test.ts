import {projectTicketSummary} from '../../src/components/console/handoff-summary.ts';
import {classifyHandoffIntent} from '../../supabase/functions/_shared/handoff-intent.ts';
const assert=(v:unknown,m:string)=>{if(!v)throw new Error(m);};
function fixture(){
 const request='更正：我唔係訂新服務，請取消先前要求，總結並轉真人客服。';
 return {schema_version:'c2-handoff-1.0.0',structured_package:{schema_version:'c2-handoff-1.0.0',conversation_id:'ticket',company_id:'tenant',generated_from_source_message_id:'new',current_customer_goal:request,transaction_state:{payment:'unknown'},handoff_context:{version:'c3-early-r1-context-1.0.0',conversation_id:'ticket',company_id:'tenant',current_request:{source_message_id:'new',content:request,interpretation_committed:false},memory_snapshot:{revision:4,source_message_id:'old',applicability:'prior_committed_snapshot',memory:{conversation_id:'ticket',company_id:'tenant',source_message_id:'old',memory_revision:4,current_goal:'Earlier booking',current_customer_facts:[{key:'count',value:0,authority:'customer',source_message_id:'old'},{key:'app',value:false,authority:'customer',source_message_id:'old'},{key:'availability',value:null,authority:'customer',source_message_id:'old'}]}},prior_turns:[{message_id:'old',role:'visitor',content:'Earlier booking'}],grounded_answer_history:[{company_id:'tenant',source_message_id:'old',assistant_message_id:'answer',tenant_id:'kb-tenant',question:'Earlier service price?',answer:'An earlier recorded quote; not the new service.',applicability:'historical_answer_not_current_authority',reusable_as_current:false}]}}};
}
Deno.test('early R1 consumer distinguishes latest raw correction, prior typed facts and historical KB',()=>{
 const e=fixture(),s=projectTicketSummary(e,'ticket','tenant'),j=JSON.stringify(s);
 assert(s?.[0].lines[0]===e.structured_package.current_customer_goal,'latest request lost');
 assert(j.includes('尚未套用') && j.includes('count：0') && j.includes('app：否') && j.includes('availability：未確認'),'typed history lost');
 assert(j.includes('歷史紀錄') && !s?.some(x=>x.title==='已核實產品資料'),'prior KB promoted');
 assert(!s?.some(x=>x.title==='客人提供的資料'),'prior facts became current');
 assert(classifyHandoffIntent(e.structured_package.current_customer_goal).explicit_request,'compound R1 lost');
});
for(const key of ['company_id','conversation_id'] as const) Deno.test('early R1 consumer rejects '+key+' drift',()=>{
 const e=fixture();e.structured_package.handoff_context[key]='foreign';
 assert(projectTicketSummary(e,'ticket','tenant')===null,'foreign context rendered');
});
Deno.test('early R1 consumer rejects snapshot source and revision masquerading',()=>{
 for(const field of ['source_message_id','memory_revision']){
  const e=fixture();(e.structured_package.handoff_context.memory_snapshot.memory as Record<string,unknown>)[field]='fake';
  assert(projectTicketSummary(e,'ticket','tenant')===null,'invalid snapshot rendered');
 }
 const e=fixture();e.structured_package.handoff_context.current_request.source_message_id='old';
 assert(projectTicketSummary(e,'ticket','tenant')===null,'prior source used as R1 source');
});
Deno.test('early R1 consumer keeps all prior turns and complete long correction text',()=>{
 const e=fixture(),request='新要求：'+'詳情。'.repeat(800)+'取消原訂單，改為回收並轉真人客服。';
 e.structured_package.current_customer_goal=request;e.structured_package.handoff_context.current_request.content=request;
 e.structured_package.handoff_context.prior_turns=Array.from({length:103},(_,i)=>({message_id:'m'+i,role:'visitor',content:'turn '+i}));
 const s=projectTicketSummary(e,'ticket','tenant');
 assert(s?.[0].lines[0]===request,'raw correction truncated');
 assert(s?.find(x=>x.title.startsWith('先前對話原文'))?.lines.length===103,'history denominator reduced');
});
Deno.test('legacy persisted Summary without early R1 context retains original consumer compatibility',()=>{
 const e=fixture();delete (e.structured_package as Record<string,unknown>).handoff_context;
 const s=projectTicketSummary(e,'ticket','tenant');assert(s?.[0].lines[0]===e.structured_package.current_customer_goal,'legacy envelope rejected');
 assert(!s?.some(x=>x.title==='最新要求的處理狀態'),'context invented');
});
