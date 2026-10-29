import test from 'node:test';
import {transformSync as task1Transpile} from 'esbuild';
import {readFileSync as task1SourceRead} from 'node:fs';
import assert from 'node:assert/strict';
import {resolveCustomerRequestDecision,isBareCommerceSubjectMention} from '../../supabase/functions/_shared/commerce-state-authority.ts';
import {createEmptyConversationCommerceState} from '../../supabase/functions/_shared/commerce-state-contract.ts';
import {reduceTurn, isReadOnlyCommerceQuestion} from '../../supabase/functions/_shared/commerce-state-runtime-base.ts';
import {sourceBoundMixedCustomerFactEvents, semanticFrameToStateEvents} from '../../supabase/functions/_shared/commerce-semantic-adapter.ts';
import {buildCanonicalConversationMemory,buildBoundedConversationContext} from '../../supabase/functions/_shared/conversation-long-memory.ts';

const CID='00000000-0000-4000-8000-000000000001';
const TID='00000000-0000-4000-8000-000000000002';
const SRC='00000000-0000-4000-8000-000000000003';
const q='仍然係八個分頁，預算想節省，桌上型、文書同視像通話，不打機。請按呢個用途比較記憶體、處理器同儲存空間，邊啲升級可以暫緩？暫時唔使查店舖售價或庫存。';
const semantic = ({operation='ASK_FACT',intent='customer_guidance',requested_facts=['selection_tradeoffs'],customer_facts=[],confidence=.98,ambiguity=false,entities=[],additive=false,customer_correction=false}={}) => ({
  version:'commerce-semantic-1.0.0',language:'zh-TW',operation,intent,topic:null,
  requested_facts,customer_facts,entities,confidence,additive,customer_correction,
  ambiguity:{is_ambiguous:ambiguity,reasons:[],clarification_question:null},
  referents:[],explicit_negations:[],transaction_state:'none',payment_state:'none',booking_state:'none',fulfillment_state:'none'
});
const state=()=>{
  const s=createEmptyConversationCommerceState();
  s.customer_constraints.customer_reported_facts={usage_scenario:{value:{
    browser_tabs_open_simultaneously:20,word_processing:true,video_calls:true,gaming:false
  },provenance:{source_type:'customer',source_message_id:'prior'}}};
  return s;
};
const frame=semantic({customer_facts:[{key:'usage_scenario',value:{browser_tabs_open_simultaneously:8}},{key:'budget_constraint',value:'節省'}]});
const reducer=(text,frame,prior=state(),sid=SRC)=>reduceTurn(prior,{text,semantic_frame:frame,source_message_id:sid,conversation_id:CID,company_id:TID,language:'zh-TW'},[]);

for(const [industry,question] of [
 ['computer',q],
 ['computer simplified','请按办公用途比较内存、处理器和储存，哪些升级可以暂缓？不用查店铺售价。'],
 ['SaaS','請按小團隊用途比較訂閱功能、服務支援和加購項目，邊啲可以暫緩？'],
 ['service','請按預約需要比較幾個服務方案，邊啲項目可延後？'],
 ['rental','請根據租用目的比較日租及月租的取捨，邊啲升級可以暫緩？'],
 ['B2B','請按採購用途比較批量採購的條件與風險，哪些安排可以暫緩？'],
 ['English','Please compare the trade-offs of renting versus subscribing based on our needs. Which upgrades could wait?'],
 ['English without question','Based on our situation, compare the pros and cons of the service plans and prioritize what can wait.'],
 ['generic equipment','請按我哋需求比較各方案嘅功能取捨，邊啲可暫緩？'],
]) test('cross-domain advisory decision: '+industry,()=>{
  const d=resolveCustomerRequestDecision(question,semantic());
  assert.equal(d.kind,'guidance',JSON.stringify(d));
  assert.equal(d.merchant_request,null);
});
for(const [intent,question,expected] of [
 ['pricing','請查你哋目前服務方案嘅售價。','merchant_facts'],
 ['availability','Please check your current inventory for model ABC123.','merchant_facts'],
 ['model spec','請提供 ABC123 現行產品規格。','merchant_facts'],
 ['policy','Please check your cancellation policy for my booking.','merchant_facts'],
 ['mixed','請按我的用途比較方案取捨，但請查你哋新加坡的退款政策。','mixed'],
 ['no paid false-positive','How should I compare booking options? No need for policy details.','guidance'],
 ['declined lookup','No need for policy details and check your stock.','merchant_facts'],
]) test('merchant authority not bypassed: '+intent,()=>{
  assert.equal(resolveCustomerRequestDecision(question,semantic()).kind,expected);
});

// Hosted C3-6-TABS-CROSS-TOPIC-REGRESSION: general advisory versus current merchant facts.
// Root scope is the speech act, never a computer/SKU phrase, a hard-coded
// recommendation, or provider intent labels. Keep original merchant negatives.
for (const [name,text,expected] of [
  ['hosted six-tabs priority','我再補充一下，依家通常只會開大概 6 個網頁分頁，主要仍然係文書、視像會議，唔打機，而且想慳啲。咁 RAM、CPU 同 SSD 應該邊樣優先？邊樣可以暫時唔升級？','guidance'],
  ['service priority','現有三種上門服務安排，按我時間限制，邊樣應該優先，邊樣可以暫時唔做？','guidance'],
  ['rental priority','租用工具係短期用途，哪一項升級最重要，哪一項可以延後？','guidance'],
  ['SaaS priority','我哋預算有限，邊個加購功能優先，邊樣可以暫緩？','guidance'],
  ['English priority','For a small team, which feature should we prioritize first and which can wait?','guidance'],
  ['TW priority','目前以基本文書為主，哪一項應先升級，哪一項可以延後？','guidance'],
  ['must verify current merchant stock','按我的用途邊樣優先？但請查你哋目前實際庫存。','mixed'],
  ['must verify merchant price','Which upgrade can wait? Please check your current prices.','mixed'],
  ['must verify exact service policy','按我哋需求邊樣優先？另請查你哋目前退款政策。','mixed'],
  ['pure actual merchant facts','你哋目前邊款型號有現貨？','merchant_facts'],
  ['pure merchant policy','請查你哋目前取消服務的政策。','merchant_facts'],
]) test('hosted C3 generic priority speech act '+name,()=>{
  const frame=semantic({operation:'ASK_FACT',intent:'customer_guidance',
    requested_facts:['selection_priorities','upgrade_tradeoffs'],customer_facts:[],confidence:.96});
  const history=[
    {role:'assistant',content:'冷氣機窗口尺寸仍需核實',metadata:{response_route:'canonical_memory_clarification'}},
    {role:'visitor',content:'CW-SUL70BA 功能？'},
    {role:'assistant',content:'之前按8個分頁比較升級取捨',metadata:{response_route:'customer_guidance'}},
    {role:'visitor',content:'更正，依家開8個網頁分頁，想慳錢，邊啲升級可以暫緩？'},
  ];
  const result=resolveCustomerRequestDecision(text,frame,history);
  assert.equal(result.kind,expected,JSON.stringify({name,result}));
  if(expected==='guidance') {
    assert.equal(result.merchant_request,null,'no paid KB authority for general priorities');
    assert.notEqual(result.general_request,null,'retain useful general customer question');
  }
  if(expected==='mixed') {
    assert.notEqual(result.merchant_request,null,'explicit merchant facet must stay grounded');
    assert.notEqual(result.general_request,null,'retain general facet rather than terminal fallback');
  }
});
test('hosted C3 routing preserves guidance through actual generator and planner to bounded no-KB answer',()=>{
  const generate=task1SourceRead('supabase/functions/generate-reply/index.ts','utf8');
  const planner=task1SourceRead('supabase/functions/_shared/conversation-service-planner.ts','utf8');
  assert.match(generate,/_customerGuidance = _customerRequestDecision.kind === "guidance"/);
  assert.match(generate,/_g1SkipKB = _pr5GreetingOrTrivial \|\| Boolean\(_priorGroundedTransform\) \|\| _customerGuidance/);
  assert.match(planner,/const resolvedMerchantRead = input\.factual_request\?\.applicable === true &&\s*!input\.factual_request\.needs_subject_clarification;/);
  assert.match(planner,/const semanticMerchantRead = requestDecision\.kind!=="guidance" &&\s*\(requiresSemanticKnowledge\(input\.semantic_frame\) \|\| resolvedMerchantRead\);/,
    'guidance stays outside both semantic and resolved factual KB reads');
});

test('source-bound mixed ASK_FACT commits only current customer numeric and string fields via Commerce reducer',()=>{
  assert.equal(isReadOnlyCommerceQuestion(q,frame),true,'factual question must not authorize buying items');
  const events=sourceBoundMixedCustomerFactEvents(frame,state(),q,SRC);
  assert.equal(events.length,1);
  assert.equal(events[0].type,'SET_CUSTOMER_CONSTRAINT');
  const next=reducer(q,frame);
  const merged=next.customer_constraints.customer_reported_facts;
  assert.equal(merged.usage_scenario.value.browser_tabs_open_simultaneously,8);
  assert.equal(merged.usage_scenario.value.word_processing,true);
  assert.equal(merged.usage_scenario.value.video_calls,true);
  assert.equal(merged.usage_scenario.value.gaming,false);
  assert.equal(merged.budget_constraint.value,'節省');
  assert.equal(merged.usage_scenario.provenance.source_message_id,SRC);
  assert.equal(next.entities.length,0);
  assert.equal(next.conversion.order_status,'none');
  assert.equal(next.conversion.payment_status,'none');
  assert.equal(next.delivery.confirmed,false);
  const repeated=reducer(q,frame,next,SRC);
  assert.deepEqual(repeated,next,'same-source reduction must not alter a committed state projection');
});

test('direct UPDATE_ITEM also deep-merges typed nested customer facts rather than erasing false/zero',()=>{
  const p=state();
  const update=semantic({operation:'UPDATE_ITEM',requested_facts:[],customer_facts:[{key:'usage_scenario',value:{browser_tabs_open_simultaneously:8}}]});
  const ev=semanticFrameToStateEvents(update,p,[],SRC);
  const row=ev.find(e=>e.type==='SET_CUSTOMER_CONSTRAINT'&&e.key==='customer_reported_facts');
  assert(row);
  assert.equal(row.value.usage_scenario.value.video_calls,true);
  assert.equal(row.value.usage_scenario.value.gaming,false);
  assert.equal(row.value.usage_scenario.value.browser_tabs_open_simultaneously,8);
});

test('new canonical Commerce facts feed the same Memory and active constraints without restoring obsolete values',()=>{
  const next=reducer(q,frame);
  const m=buildCanonicalConversationMemory({conversation_id:CID,company_id:TID,source_message_id:SRC,
    commerce_state_revision:3,commerce_state:next,newest_first:[{id:SRC,role:'visitor',content:q,created_at:'2026-10-25T00:00:00Z'}],
    visitor_turn_count:3,source_created_at:'2026-10-25T00:00:00Z',next_memory_revision:9,
    customer_fact_delta:frame.customer_facts.map(f=>({...f,authority:'customer',source_message_id:SRC}))});
  assert.equal(m.current_customer_facts.find(f=>f.key==='usage_scenario')?.value?.browser_tabs_open_simultaneously,8);
  assert(!m.active_constraints.some(x=>x.startsWith('customer_reported_facts:')),
    'typed customer facts must not be JSON-serialized into customer-visible service constraints');
  assert(m.current_customer_facts.some(f=>f.key==='usage_scenario' && f.value.browser_tabs_open_simultaneously===8));
  assert(!buildBoundedConversationContext(m,[{id:SRC,role:'visitor',content:q}]).block.includes('customer_reported_facts:{'));
  assert(buildBoundedConversationContext(m,[{id:SRC,role:'visitor',content:q}]).block.includes('8'));
});

for(const [name,text,patch] of [
 ['question-only','目前產品有 8 個處理器嗎？', {customer_facts:[{key:'usage_scenario',value:{browser_tabs_open_simultaneously:8}}]}],
 ['unobserved number','我而家係桌上型，想比較新服務。',{customer_facts:[{key:'usage_scenario',value:{browser_tabs_open_simultaneously:8}}]}],
 ['historical','以前有 8 個分頁，但目前仍然係 20 個分頁，我想比較。',{customer_facts:[{key:'usage_scenario',value:{browser_tabs_open_simultaneously:8}}]}],
 ['false source','請按目前用途比較，但不用查庫存。',{customer_facts:[{key:'payment',value:'paid'}]}],
 ['ambiguous numeric binding','我目前有 6 位同事和 8 台設備，想比較升級。',{customer_facts:[{key:'staff_count',value:8}]}],
]) test('missing or unbound literal evidence cannot promote state: '+name,()=>{
  const f=semantic(patch);
  const result=sourceBoundMixedCustomerFactEvents(f,state(),text,SRC);
  assert.equal(result.length,0,JSON.stringify(result));
});
for(const [name,patch] of [
 ['low confidence',{confidence:.60}],['ambiguous',{ambiguity:true}],['transaction intent',{operation:'CONFIRM'}],
 ['model no-state-change',{operation:'NO_STATE_CHANGE'}],['proposal-only',{customer_facts:[]}]
]) test('unsafe semantic frame cannot commit customer state: '+name,()=>{
  const f=semantic({...{customer_facts:frame.customer_facts},...patch});
  assert.deepEqual(sourceBoundMixedCustomerFactEvents(f,state(),q,SRC),[]);
});
test('no merchant price, stock or warranty is created by source-bound customer updates',()=>{
  const f=semantic({customer_facts:[{key:'customer_budget',value:5000},{key:'merchant_price',value:9000}]});
  const input='我而家預算 5000，想比較方案，但唔需要查最新售價。';
  const row=reducer(input,f);
  assert.equal(row.customer_constraints.customer_reported_facts.customer_budget.value,5000);
  assert.equal(row.customer_constraints.customer_reported_facts.merchant_price,undefined);
  assert.equal(row.quotes.length,0);
  assert.equal(row.conversion.order_status,'none');
});

test("Task 1 bounded C4 caller and provider retry source contracts",()=>{
 const kb=task1SourceRead("supabase/functions/kb-search-proxy/index.ts","utf8");
 const assist=task1SourceRead("supabase/functions/agent-assist/index.ts","utf8");
 const router=task1SourceRead("supabase/functions/_shared/llm-router.ts","utf8");
 const crm=task1SourceRead("src/components/console/CRMPanel.tsx","utf8");
 const panel=task1SourceRead("src/components/console/AgentToolPanel.tsx","utf8");
 assert.match(kb,/const boundedSinglePass = isBoundedKBRequest\(body\)/);
 assert.match(crm,/extended_search_confirmed:!boundedKbSearch/,'extension requires UI confirmed opt-in');
 assert.match(kb,/const expansions = boundedSinglePass \? \[\] : await diagnostic\.run/);
 assert.match(kb,/deterministicOnly: boundedSinglePass/);
 assert.match(kb,/bounded_relevance_not_verified/);
 assert.match(assist,/maxProviderAttempts:boundedModelAttempts/);
 assert.match(router,/attempt <= allowedAttempts/);
 assert.doesNotMatch(router,/attempt < MAX_ATTEMPTS/);
 assert.match(crm,/bounded_single_pass:boundedKbSearch/);
 assert.match(crm,/const \[boundedKbSearch, setBoundedKbSearch\] = useState\(true\)/,'KB default must not trigger paid expansion');
 assert.match(crm,/setShowExtendedKbNotice\(true\)/,'expanded search requires explicit operator confirmation');
 assert.match(crm,/setBoundedKbSearch\(false\);setShowExtendedKbNotice\(false\)/);
 assert.match(crm,/setBoundedKbSearch\(true\);/,'ticket changes must restore bounded default');
 assert.match(crm,/draftText,boundedKbSearch\]\);/,'mode change invalidates stale KB results');

 assert.match(panel,/bounded_mode:boundedToolMode/);
});

test('Task1 Mac UA: legacy and absent confirmation requests remain one verified KB lookup', async () => {
 const source = task1SourceRead('supabase/functions/kb-search-proxy/index.ts','utf8');
 const begin=source.indexOf('export function isBoundedKBRequest(');
 const end=source.indexOf('function isUuid(',begin);
 assert(begin>=0 && end>begin,'source-backed proxy budget helper must be present');
 const built=task1Transpile(source.slice(begin,end),{loader:'ts',format:'esm'}).code;
 const {isBoundedKBRequest}=await import('data:text/javascript;base64,'+Buffer.from(built).toString('base64'));
 for(const [name,input,expected] of [
  ['legacy false without confirmation',{bounded_single_pass:false},true],
  ['old unspecified client',{},true],
  ['null body',null,true],
  ['bounded true',{bounded_single_pass:true},true],
  ['spurious flag without explicit off',{extended_search_confirmed:true},true],
  ['operator confirms explicit expanded mode',{bounded_single_pass:false,extended_search_confirmed:true},false],
 ]) assert.equal(isBoundedKBRequest(input),expected,name);
});

test('Task1 C4: original bounded full-content relevance accepts supported Chinese enumeration, never unrelated refund facts', async () => {
 const source = task1SourceRead('supabase/functions/kb-search-proxy/index.ts','utf8');
 const begin = source.indexOf('function normalizeComparable(');
 const end = source.indexOf('type MembershipRow',begin);
 assert(begin >= 0 && end > begin,'actual KB runtime scorer must be found');
 const transpiled = task1Transpile(source.slice(begin,end)+'\nexport {lexicalSupport};',{loader:'ts',format:'esm'}).code;
 const {lexicalSupport} = await import('data:text/javascript;base64,'+Buffer.from(transpiled).toString('base64'));
 const evidence='「四電一腦」生產者責任計劃 受管制電器之免費除舊服務須知。適用貨品：空調機、洗衣機、雪櫃、電視機、電腦、列印機、掃描器及顯示器。';
 assert(lexicalSupport('「四電一腦」包括哪些電器及電腦類別？',evidence)>=0.6,'genuine full-content category match');
 for(const unsupported of [
   '「四電一腦」包括哪些退款安排？',
   '「四電一腦」包括哪些退款及取消政策？',
   '「四電一腦」包括哪些貨物保養年期？',
 ]) assert(lexicalSupport(unsupported,evidence)<0.6,'unrelated merchant claims remain excluded: '+unsupported);
 assert.equal(lexicalSupport('「其他計劃」包括哪些退款安排？',evidence)<0.6,true);
});

test('Task1 C4 Helper traceability preserves source IDs for every displayed full-content excerpt', () => {
  const backend=task1SourceRead('supabase/functions/agent-assist/index.ts','utf8');
  const panel=task1SourceRead('src/components/console/AgentToolPanel.tsx','utf8');
  assert.match(backend,/document_id:i\.document_id/);
  assert.match(backend,/chunk_id:i\.chunk_id/);
  assert.match(panel,/data-document-id=\{e\.document_id \?\? undefined\}/);
  assert.match(panel,/data-chunk-id=\{e\.chunk_id \?\? undefined\}/);
  assert.match(panel,/Source identifiers unavailable — verify citation lineage before use/);
});

test('C3 cross-topic numeric correction: user-owned tab count must not mutate an unrelated active product or leak typed JSON',()=>{
 const turn='再更正，依家只會開6個分頁，其他文書、視像會議同慳錢要求不變。';
 const old=createEmptyConversationCommerceState();
 old.current_topic='air_conditioner';old.current_intent='select_product';
 old.entities=[{entity_id:'air_conditioner:unscoped',category:'air_conditioner',brand:null,model:'CW-SUL70BA',quantity:1,status:'tentative',
  attributes:{product_name:'CW-SUL70BA',quantity_basis:'system_default',installation_type:'window_unit'},
  constraints:{},provenance:{source_type:'customer',source_message_id:'prior-ac'}}];
 old.customer_constraints.customer_reported_facts={
  open_web_pages:{value:8,provenance:{source_type:'customer',source_message_id:'old-computer'}},
  budget_constraint:{value:'想慳啲',provenance:{source_type:'customer',source_message_id:'old-computer'}}
 };
 const ambiguousProviderEntity={
   entity_ref:'air_conditioner:unscoped',name:'CW-SUL70BA',kind:'physical_product',
   category_hint:'air_conditioner',sku:null,model:'CW-SUL70BA',quantity:6,unit:'部',
   attributes:{},constraints:{},capabilities:{},confidence:.96
 };
 const update=semantic({operation:'UPDATE_ITEM',intent:'other',requested_facts:[],
  customer_correction:true,entities:[ambiguousProviderEntity],
  customer_facts:[{key:'open_web_pages',value:6}]});
 const priorHistory=[
  {role:'assistant',content:'CW-SUL70BA 有待確認適用資料。',metadata:{response_route:'canonical_kb_direct_answer'}},
  {role:'visitor',content:'CW-SUL70BA 功能？'},
  {role:'assistant',content:'以8個分頁比較 RAM、CPU、SSD',metadata:{response_route:'customer_guidance'}},
  {role:'visitor',content:'更正，實際只係8個分頁，請比較 RAM、CPU、SSD 升級優先次序，邊啲可以暫緩？'},
 ];
 const decision=resolveCustomerRequestDecision(turn,update,priorHistory);
 assert.equal(decision.kind,'guidance','the most recent unrelated product answer must not steal a customer-fact correction');
 assert.equal(decision.continuation,true);
 assert.equal(decision.merchant_request,null);
 const hints=[{entity_id:'air_conditioner:unscoped',category:'air_conditioner',model:'CW-SUL70BA',
  aliases:['CW-SUL70BA'],attributes:{product_name:'CW-SUL70BA'},constraints:{}}];
 const reduced=reduceTurn(old,{text:turn,semantic_frame:update,source_message_id:SRC,
   conversation_id:CID,company_id:TID,language:'zh-TW'},hints);
 assert.equal(reduced.entities[0].quantity,1,'browser tabs cannot become air conditioner quantity');
 assert.equal(reduced.entities[0].attributes.quantity_basis,'system_default');
 assert.equal(reduced.customer_constraints.customer_reported_facts.open_web_pages.value,6);
 assert.equal(reduced.customer_constraints.customer_reported_facts.open_web_pages.provenance.source_message_id,SRC);
 const memory=buildCanonicalConversationMemory({conversation_id:CID,company_id:TID,source_message_id:SRC,
   commerce_state_revision:3,commerce_state:reduced,
   request_decision:decision,customer_fact_delta:update.customer_facts.map(f=>({...f,authority:'customer',source_message_id:SRC})),
   newest_first:[{id:SRC,role:'visitor',content:turn,created_at:'2026-10-27T03:41:17Z'},
      ...priorHistory.map((h,i)=>({id:'prior-'+i,...h}))],
   visitor_turn_count:13,source_created_at:'2026-10-27T03:41:17Z',next_memory_revision:17});
 assert.match(memory.current_goal??'',/6個分頁/,'current goal must be source-bound current computer context');
 assert.doesNotMatch(memory.current_goal??'',/CW-SUL70BA|air conditioner/i);
 assert.notEqual(memory.current_topic,'air_conditioner','current topic cannot be an unrelated old entity');
 assert(!memory.active_constraints.some(x=>x.includes('customer_reported_facts')||x.includes('"provenance"')));
 assert.equal(memory.current_customer_facts.find(f=>f.key==='open_web_pages')?.value,6);
});
test('C4 Knowledge Helper action is grounded and human reviewed rather than auto-sent',()=>{
 const panel=task1SourceRead('src/components/console/AgentToolPanel.tsx','utf8');
 const inbox=task1SourceRead('src/routes/_authenticated/console.conversations.index.tsx','utf8');
 assert.match(panel,/helperEvidenceDraft && \(/);
 assert.match(panel,/visibleResult\.data\.status === "available"/);
 assert.match(panel,/e\.chunk_type === "full_content"/);
 assert.match(panel,/e\.document_id/);
 assert.match(panel,/e\.chunk_id/);
 assert.match(panel,/onClick=\{\(\) => useResult\(helperEvidenceDraft\)\}/);
 assert.match(panel,/resultSnapshot\.current\?\.draft===latestInputs\.current\.draft/);
 assert.match(inbox,/setUseConfirmOpen\(true\)/);
 assert.match(inbox,/setPendingUseText\(text\)/);
});

test('Task1: bare commerce subject is never ADD_ITEM with fabricated default quantity',()=>{
  for(const name of ['轻量冲锋衣','轻量化户外冲锋衣','SaaS 訂閱方案','剪髮服務','CW-SUL70BA']){
    const entity={entity_ref:name,name,kind:'physical_product',category_hint:null,sku:null,model:null,
      quantity:1,unit:null,attributes:{},constraints:{},capabilities:{},confidence:0.97};
    const proposal=semantic({operation:'ADD_ITEM',intent:'explore_options',requested_facts:[],entities:[entity]});
    assert.equal(isBareCommerceSubjectMention(name,proposal),true,name);
    const before=createEmptyConversationCommerceState();
    assert.deepEqual(reducer(name,proposal,before),before,'no default item or quantity: '+name);
    for(const realAction of ['我要買一件'+name,'请查'+name+'售价','取消'+name,'Buy '+name])
      assert.equal(isBareCommerceSubjectMention(realAction,proposal),false,'keep legitimate action or fact request');
  }
});

test("Task1 source guards: published-reference price cannot become a verified current-price claim",()=>{
 const source=task1SourceRead("supabase/functions/_shared/canonical-kb-direct-answer.ts","utf8");
 assert.match(source,/publishedReferenceOnly/);
 assert.match(source,/selected_authority_class === "PUBLISHED_KB_SERVICE"/);
 assert.match(source,/priceCandidates/);
 assert.match(source,/consistentPrice/);
 assert.match(source,/return evidence\("listed_price_unverified"/);
 assert.match(source,/if \(publishedReferenceOnly \|\| nameTarget\) \{/);
 assert.match(source,/const priceFact = currentVerified && !nameTarget && priceEvidence/);
 assert.match(source,/chunk.status === "published" \|\| publishedReferenceOnly && chunk.status === "unknown"/);
 const b2=task1SourceRead("supabase/functions/_shared/pre-send-conversion-supervisor.ts","utf8");
 assert.match(b2,/evaluateCurrentKbSellingPrice\(input, draft\)/);
 assert.match(b2,/CURRENT_KB_PRICE_PROOF_MISSING/);
});

// Same Task1C native regression suite, executed by the existing isolated final gate.
import './event-driven-widget.test.mjs';


test('Task1C source-recorded price is resolved before the secondary retrieval-score gate',()=>{
 const code=task1SourceRead('supabase/functions/generate-reply/index.ts','utf8');
 const resolve=code.indexOf('_canonicalKbDirectAnswer = resolveCanonicalKbDirectAnswer({');
 const gate=code.indexOf('if (!_sourceRecordedPriceReady && !hasUsableFullContentEvidence(usableChunks, minScore))');
 assert(resolve>0 && gate>resolve,'exact named price must not dead-end before renderer');
 assert.match(code,/const _sourceRecordedPriceReady = !_mixedRequest && !isHighRisk &&/);
 assert.match(code,/_canonicalKbDirectAnswer\?\.kind === "listed_price_unverified"/);
 assert.match(code,/!_priorGroundedTransform/);
});


test('Task1C catalogue source answers share safe consumer wiring and real fresh-query followup',()=>{
 const handler=task1SourceRead('supabase/functions/generate-reply/index.ts','utf8');
 const assist=task1SourceRead('supabase/functions/agent-assist/index.ts','utf8');
 assert.match(handler,/resolveCatalogueVariantFollowup\(_h1LastMsg/);
 assert.match(handler,/_currentFactualRequest = resolveCurrentFactualRequest\(\{\s*question: _catalogueFollowup\?\.request \?\? _h1LastMsg,/,
   'source-bound catalogue variants enter the same current request resolver');
 assert.match(handler,/const userQuery = \(_currentFactualRequest\?\.applicable\s*\? _currentFactualRequest\.query\s*: _catalogueFollowup\?\.request \|\| _c3ServicePlan\.kb_query \|\| _productKbContract\?\.query \|\| _semanticRetrieval\.query\) \?\? "";/,
   'the current resolved question owns retrieval; catalogue and planner remain fallback paths');
 assert.match(handler,/_catalogueQuestion && !_explicitHandoffRequested && !_deferR1ForE1/);
 assert.match(handler,/catalogue_requested_facts:_catalogueQuestion\.requested_facts/);
 assert.match(handler,/commitAiReplyWithControlGate/);
 assert.match(handler,/recorded_kb_facts:\s*\(_canonicalKbDirectAnswer\.recorded_facts/);
 assert.match(assist,/toolType==="suggest_reply"/);
 assert.match(assist,/draft_only:true/);
 assert.match(assist,/recorded_product_facts: catalogueAnswer\?\.recorded_facts/);
});
