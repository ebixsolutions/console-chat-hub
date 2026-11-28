import {createEmptyConversationCommerceState} from './commerce-state-contract.ts';
import {reduceTurn} from './commerce-state-runtime-base.ts';
import {customerRequestedQuantity} from './customer-journey-orchestration.ts';
import {buildCanonicalConversationMemory,verifyCommittedLifecycleMemory} from './conversation-long-memory.ts';
import {resolveConversationRecall,renderConversationRecall} from './conversation-recall.ts';
const assert=(v:unknown,m:string)=>{if(!v)throw new Error(m)};
const scope={conversation_id:'conversation',company_id:'company',source_message_id:'source',language:'zh-TW' as const};
const base='我想換冷氣，兩間房同客廳，細房80呎、大房100呎、客廳180呎，全部窗口位，大房下午曬，原本都有窗口機。想先睇合適款式，未落單。';
const stateFor=(text:string)=>reduceTurn(createEmptyConversationCommerceState(),{...scope,text},[]);
const memoryFor=(state:ReturnType<typeof stateFor>,rows: Array<{id:string,role:string,content:string,metadata?:Record<string,unknown>}>=[])=>buildCanonicalConversationMemory({...scope,commerce_state:state,commerce_state_revision:1,next_memory_revision:1,newest_first:rows,visitor_turn_count:1,source_created_at:'2026-10-04T00:00:00Z'});
Deno.test('F0 room requirements never prove machine quantity or formal quotation',()=>{
 const s=stateFor(base); const e=s.entities[0]; const m=memoryFor(s);
 assert(s.entities.length===1 && e.quantity===1 && customerRequestedQuantity(e)===null,'default promoted to customer quantity');
 assert(m.active_entities[0].quantity===1 && m.active_entities[0].requested_quantity===null && m.current_goal?.includes('quantity not yet confirmed'),'memory promoted default');
 assert(!m.current_customer_facts.some(f=>f.key.endsWith(':quantity')),'quantity fact fabricated');
 assert(JSON.stringify(s.conversion).includes('"quotation_status":"none"') && s.conversion.order_status==='none' && s.conversion.payment_status==='none','research promoted transaction');
 const r=renderConversationRecall(resolveConversationRecall({...scope,question:'而家我哋傾過啲咩？幫我簡單總結。',memory:m,commerce:{...scope,revision:1,state:s}}),'zh-TW');
 assert(r?.includes('機數待確認') && !/冷氣機\s*1部|草擬中/.test(r),'recap fabricated count/quote');
 assert(r?.includes('大房 下午日照強') && !r.includes('細房 下午日照強'),'recap sunlight scope lost');
});
Deno.test('F0 explicit one machine and explicit each-space allocation remain distinct',()=>{
 const one=stateFor(base+'冷氣只換一部。');
 assert(customerRequestedQuantity(one.entities[0])===1,'explicit one lost');
 const each=stateFor(base+'三個空間各一部冷氣。');
 assert(customerRequestedQuantity(each.entities[0])===3,'explicit allocation lost');
});
Deno.test('F0 sunlight scope and corrected area remain durable; defer never revives',()=>{
 let s=stateFor(base);
 assert(JSON.stringify(s.entities[0].attributes.room_sunlight)==='{"large_bedroom":"strong_afternoon_sun"}' && s.entities[0].attributes.sunlight===undefined,'room sunlight generalized');
 s=reduceTurn(s,{...scope,source_message_id:'correct',text:'講返冷氣，大房頭先講錯，唔係100呎，應該係110呎。'},[]);
 assert((s.entities[0].attributes.room_sizes as Record<string,string>).large_bedroom==='110平方呎','latest area lost');
 const all=stateFor(base.replace('大房下午曬','全部房間下午曬'));
 assert(Object.keys(all.entities[0].attributes.room_sunlight as object).length===3,'explicit all-room scope lost');
 s.entities.push({entity_id:'refrigerator:unscoped',category:'refrigerator',quantity:1,status:'deferred',attributes:{quantity_basis:'system_default'},constraints:{max_width_mm:595},provenance:{source_type:'customer',source_message_id:'defer'}});
 const m=memoryFor(s);
 const scoped=renderConversationRecall(resolveConversationRecall({...scope,question:'總結冷氣要求',memory:m,commerce:{...scope,revision:1,state:s}}),'zh-TW');
 assert(!scoped?.includes('雪櫃') && s.entities[1].status==='deferred','scoped recap cross-entity contamination');
});
Deno.test('F4 delivered stock unknown remains pending with source and entity binding',()=>{
 const s=stateFor(base);s.entities[0].model='CW-SUL70BA';
 const m=memoryFor(s,[{id:'answer',role:'assistant',content:'CW-SUL70BA 現有資料未確認即時庫存數量。',metadata:{response_route:'canonical_kb_direct_answer',answer_kind:'stock_unknown',control_commit:'ai',source_message_id:'question'}},{id:'question',role:'visitor',content:'CW-SUL70BA 依家有幾多部現貨？'}]);
 const q=m.question_lifecycle?.find(q=>q.source_message_id==='question');
 assert(q?.status==='pending' && q.entity_id===s.entities[0].entity_id && q.resolution_source_message_id==='answer','unknown stock incorrectly resolved');
 assert(m.open_questions.some(q=>q.includes('live stock quantity')),'handoff stock obligation lost');
});

Deno.test('F0 lifecycle parity uses exact requested quantity while rejecting altered Memory',async()=>{
 const {verifyEntityLifecycleTransition,b2JourneyTransactionBoundary}=await import('./b2-journey-progress-contract.ts');
 const before=stateFor(base);
 before.entities.push({entity_id:'refrigerator:unscoped',category:'refrigerator',quantity:1,status:'researching',attributes:{quantity_basis:'system_default'},constraints:{max_width_mm:595},provenance:{source_type:'customer',source_message_id:'fridge'}});
 const text='雪櫃暫時唔換住，先搞冷氣。';
 const after=reduceTurn(before,{...scope,text},[]);
 const transition=verifyEntityLifecycleTransition(text,before,after,scope.source_message_id);
 assert(transition.valid,'lifecycle transition invalid');
 if(!transition.valid)throw Error('invalid transition');
 const receipt={contract:'entity-lifecycle-commit-v1' as const,company_id:scope.company_id,source_message_id:scope.source_message_id,source_text:text,previous_revision:0,committed_revision:1,plans:transition.plans,target_entity_ids:transition.targetIds,previous_state:before,committed_state:after,reply:'雪櫃已暫緩。',transaction_before:b2JourneyTransactionBoundary(before),transaction_after:b2JourneyTransactionBoundary(after)};
 const memory=memoryFor(after);const commerce={...scope,revision:1,state:after};
 assert(verifyCommittedLifecycleMemory({memory,receipt,commerce}),'legitimate unknown quantity parity rejected');
 const altered=structuredClone(memory);altered.active_entities[0].quantity=2;
 assert(!verifyCommittedLifecycleMemory({memory:altered,receipt,commerce}),'default promoted through lifecycle parity');
 assert(!verifyCommittedLifecycleMemory({memory,receipt,commerce:{...commerce,revision:2}}),'revision mismatch accepted');
});

Deno.test('F0 read-only recap retains canonical B2 quantity parity without inventing purchase count',async()=>{
 const {buildB2ReadOnlyRecapProof,evaluateB2BeforeCommit}=await import('./pre-send-conversion-supervisor.ts');
 const state=stateFor(base);const memory=memoryFor(state);
 const reply=renderConversationRecall(resolveConversationRecall({...scope,question:'而家我哋傾過啲咩？幫我簡單總結。',memory,commerce:{...scope,revision:1,state}}),'zh-TW');
 if(!reply)throw Error('missing recap');
 const proof=await buildB2ReadOnlyRecapProof({...scope,commerce_revision:1,commerce_state:state,memory_revision:1,memory_hash:'persisted-memory-hash',memory_source_message_id:scope.source_message_id,memory,reply});
 const metadata={response_route:'canonical_memory_recall',recall_fact_type:'summary',recap_read_only:true,commerce_state_revision:1,commerce_state_persist_result:'read_only',commerce_state_persistence_classification:'NO_SEMANTIC_CHANGE',conversation_memory_revision:1,recap_commerce_hash:proof.commerce_hash,recap_memory_hash:proof.memory_hash,recap_response_hash:proof.response_hash};
 const snapshot={...scope,commerce_state_revision:1,commerce_state_source_message_id:scope.source_message_id,state};
 const input={proposed_response:reply,persistence_kind:'ai_reply' as const,snapshot,metadata,trusted_read_only_recap:proof};
 assert(evaluateB2BeforeCommit(input).code==='B2_ALLOW_AUTHORITATIVE_READ_ONLY_RECAP','legitimate unconfirmed-count recap blocked');
 for(const change of [{company_id:'other'},{source_message_id:'other'},{commerce_revision:2},{memory_hash:'other'}])assert(evaluateB2BeforeCommit({...input,trusted_read_only_recap:{...proof,...change}}).decision!=='allow','forged binding accepted');
 const altered=structuredClone(memory);altered.active_entities[0].quantity=2;
 assert(evaluateB2BeforeCommit({...input,trusted_read_only_recap:{...proof,memory:altered}}).decision!=='allow','altered canonical quantity accepted');
 assert(evaluateB2BeforeCommit({...input,proposed_response:reply+' 訂單已確認。'}).decision!=='allow','false transaction accepted');
});
