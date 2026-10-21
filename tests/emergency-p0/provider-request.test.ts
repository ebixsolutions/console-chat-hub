import {isCurrentRequirementsRecap,isCustomerGuidanceRequest} from '../../supabase/functions/_shared/commerce-state-authority.ts';
import { buildVertexGenerationConfig, buildVertexEndpoint, normalizeVertexResponseSchema, safeVertexErrorDiagnostic } from '../../supabase/functions/_shared/vertex-generation-config.ts';
import {COMMERCE_SEMANTIC_COMPACT_WIRE_SCHEMA,COMMERCE_SEMANTIC_WIRE_SCHEMA,COMMERCE_SEMANTIC_DELTA_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS,decodeCommerceSemanticWire,normalizeCommerceSemanticFrame} from '../../supabase/functions/_shared/commerce-semantic-frame.ts';
import {classifyNonFactualConversation} from '../../supabase/functions/_shared/conversational-routing.ts';
import {classifyCanonicalConversationTurn} from '../../supabase/functions/_shared/conversation-semantic-contract.ts';
import {terminalRecoveryReply} from '../../supabase/functions/_shared/generation-terminal-guard.ts';
function assert(v:unknown,m='assertion'):asserts v {if(!v)throw Error(m)}
function throws(f:()=>unknown){let failed=false;try{f()}catch{failed=true}assert(failed,'invalid request accepted')}
Deno.test('documented Vertex serialization includes JSON schema, typed int64 bounds and valid model thinking controls',()=>{
 const cfg=buildVertexGenerationConfig(4096,true,COMMERCE_SEMANTIC_COMPACT_WIRE_SCHEMA,0,'gemini-2.5-flash');
 assert(cfg.responseMimeType==='application/json');assert((cfg.thinkingConfig as any).thinkingBudget===0);
 const legacy=normalizeVertexResponseSchema(COMMERCE_SEMANTIC_WIRE_SCHEMA) as any;
 assert(legacy.type==='OBJECT'&&legacy.properties.entities.maxItems==='12');
 assert(buildVertexEndpoint('isolated-project','global','gemini-2.5-flash').startsWith('https://aiplatform.googleapis.com/'));
 assert(buildVertexEndpoint('isolated-project','us-central1','gemini-2.5-flash').startsWith('https://us-central1-aiplatform.googleapis.com/'));
});
Deno.test('invalid schema/config/endpoint fails before provider; never changes provider or removes constraints',()=>{
 throws(()=>buildVertexGenerationConfig(0,true,undefined,0));throws(()=>buildVertexGenerationConfig(10,false,{type:'object'},0));
 throws(()=>buildVertexGenerationConfig(10,true,undefined,0,'gemini-2.5-pro'));throws(()=>buildVertexGenerationConfig(10,true,undefined,0,'gemini-2.0-flash'));
 throws(()=>buildVertexGenerationConfig(10,true,undefined,24577,'gemini-2.5-flash'));throws(()=>buildVertexGenerationConfig(10,true,undefined,1,'gemini-2.5-flash-lite'));
 throws(()=>normalizeVertexResponseSchema({type:['string','null']}));throws(()=>normalizeVertexResponseSchema({type:'array'}));
 throws(()=>normalizeVertexResponseSchema({type:'object',required:['missing'],properties:{}}));throws(()=>normalizeVertexResponseSchema({type:'string',additionalProperties:true}));
 throws(()=>buildVertexEndpoint('project','region/other','gemini'));throws(()=>buildVertexEndpoint('project','global','model?token=secret'));
});
Deno.test('provider diagnostics preserve only enumerated cause/status and safe field paths',()=>{
 const d=safeVertexErrorDiagnostic({error:{status:'INVALID_ARGUMENT',message:'responseSchema too complex Bearer PRIVATE-SECRET',details:[{fieldViolations:[{field:'generation_config.response_schema',description:'PRIVATE-SECRET'},{field:'PRIVATE-SECRET://evil'},{field:'generation_config.response_schema.properties.PRIVATE-SECRET'}]}]}});
 const s=JSON.stringify(d);assert(s.includes('schema_complexity'));assert(s.includes('INVALID_ARGUMENT'));assert(!s.includes('PRIVATE-SECRET'));assert(!s.includes('Bearer'));
 assert(safeVertexErrorDiagnostic({error:{message:'unknown private message'}}).provider_error_class==='unknown');
});
Deno.test('compact wire decoder retains canonical operation/constraints/false/zero/null and rejects collisions/overflow/malformed JSON',()=>{
 const delta={customer_correction:true,customer_facts:[{key:'auto_renew',value_json:'false'},{key:'seats',value_json:'0'},{key:'date',value_json:'null'}],entities:[{name:'unseen digital subscription',kind:'subscription',confidence:0.95,attributes_json:'{"languages":["en","zh-TW"]}',constraints_json:'{"maximum":{"amount":0,"unit":"seats"}}',capabilities:{recurring_billing:true}}]};
 const frame=normalizeCommerceSemanticFrame(decodeCommerceSemanticWire({operation:'UPDATE_ITEM',confidence:0.95,delta_json:JSON.stringify(delta)}));
 const facts=frame?.customer_facts; assert(facts); assert(facts[0].value===false&&facts[1].value===0&&facts[2].value===null);assert(frame?.entities[0].kind==='subscription');assert(frame.customer_correction);
 for(const value of [{operation:'ASK_FACT',confidence:0.9,delta_json:'{bad'},{operation:'ASK_FACT',confidence:0.9,delta_json:JSON.stringify({operation:'CONFIRM'})},{operation:'ASK_FACT',confidence:0.9,delta_json:'{}',entities:[]},{operation:'ASK_FACT',confidence:0.9,delta_json:JSON.stringify({unknown:true})},{operation:'ASK_FACT',confidence:0.9,delta_json:'x'.repeat(24001)}]) assert(decodeCommerceSemanticWire(value)===null);
 assert(!normalizeCommerceSemanticFrame(decodeCommerceSemanticWire({operation:'ADD_ITEM',confidence:0.9,delta_json:JSON.stringify({entities:Array(13).fill({name:'rental',kind:'rental',confidence:1})})})));
});
Deno.test('whole social grammar never erases mixed business, corrections, negations, memory, merchant or high-risk requirements',()=>{
 for(const t of ['Hello! How are you doing today?','你好，你係邊個？','你叫什麼名字？',"Hi, what's your role?"]){assert(classifyNonFactualConversation(t));assert(classifyCanonicalConversationTurn(t,[]).requires_new_kb_retrieval===false);}
 for(const t of ['Hi, price and stock please','你好，我想取消租賃','Hello, no automatic renewal','Thanks, book next Friday','你好，佢有冇現貨？','I meant the service, not that product','Hi, who are your suppliers?','Are you human and can you process my refund?','Hi, remind me what I asked','你好，你叫咩名，仲有運費係幾多？','Hi, I need a human now','Hi, I will hurt your staff','Hi '.repeat(1500)+'cancel the order'])assert(classifyNonFactualConversation(t)===null,t);
});
Deno.test('technical terminal response is distinct from external evidence unavailability in all supported response languages',()=>{
 for(const lang of ['en','zh-TW','zh-CN'] as const){const s=terminalRecoveryReply(lang);assert(/technical problem|系統|系统/.test(s));assert(!/verify|資料核實|资料核实/.test(s));}
});

Deno.test('general preparation/decision support never becomes retained-state recap or merchant evidence bypass',()=>{
 const frame=normalizeCommerceSemanticFrame({operation:'ASK_FACT',confidence:0.97,intent:'customer_guidance'})!;
 for(const text of ['幫我整理選機時應該考慮嘅取捨，同講下一步應補充咩資料嗎？','What should I measure before choosing, and what trade-offs should I consider?','你會先問我邊一個問題？']){assert(!isCurrentRequirementsRecap(text),text);assert(isCustomerGuidanceRequest(text,frame),text);}
 for(const text of ['Recap the ZX-731 booking.','Summarize the premium plan.','整理返 ZX-731 預約。','請總結呢張對話嘅需求，同我最新更正嘅客廳面積及預算；唔好查外部資料。'])assert(isCurrentRequirementsRecap(text),text);
 for(const text of ['What should I measure and what is the current price?','請整理選購取捨，推薦現貨型號','What trade-offs should I consider under your warranty policy?'])assert(!isCustomerGuidanceRequest(text,frame),text);
 assert(!isCustomerGuidanceRequest('What should I measure?',{...frame,requested_facts:['stock']}));assert(!isCustomerGuidanceRequest('What should I measure?',{...frame,ambiguity:{is_ambiguous:true}}));
});
Deno.test('semantic rejection diagnostics identify only fixed contract invariants without retaining provider contents',()=>{
 const wire=(delta:unknown)=>({operation:'ASK_FACT',confidence:0.97,delta_json:typeof delta==='string'?delta:JSON.stringify(delta)});
 const cases:[unknown,string][]=[
  [wire('{secret'), 'wire_delta_json'],[wire({correction:'PRIVATE-SECRET'}),'wire_delta_fields'],
  [wire({customer_facts:[{key:'budget',value_json:'PRIVATE-SECRET'}]}),'wire_value_json'],
  [wire({entities:[{name:'item',kind:'physical_product',constraints_json:'[]'}]}),'wire_entity_object'],
  [{operation:'ASK_FACT',confidence:2},'canonical_confidence'],[{operation:'WRONG',confidence:1},'canonical_operation'],
  [wire({entities:Array(13).fill({name:'item',kind:'physical_product'})}),'canonical_array_bounds'],
  [wire({customer_facts:[{key:'x'}]}),'canonical_fact'],
  [wire({entities:[{name:'item',kind:'PRIVATE-SECRET'}]}),'canonical_entity_kind'],
 ];
 for(const [input,expected] of cases){const reasons:string[]=[];const decoded=decodeCommerceSemanticWire(input,r=>reasons.push(r));const result=normalizeCommerceSemanticFrame(decoded,r=>reasons.push(r));assert(result===null);assert(reasons[0]===expected,JSON.stringify(reasons));assert(!JSON.stringify(reasons).includes('PRIVATE-SECRET'));}
});

Deno.test('advertised compact inner grammar cannot demand forbidden outer fields',()=>{
 const p=COMMERCE_SEMANTIC_DELTA_SCHEMA.properties;
 assert(!Object.hasOwn(p,'operation')&&!Object.hasOwn(p,'confidence'));
 assert(Object.hasOwn(p,'customer_correction')&&Object.hasOwn(p,'explicit_negations')&&Object.hasOwn(p,'transaction_state'));
 assert(!Object.hasOwn(p,'lifecycle')&&!Object.hasOwn(p,'correction')&&!Object.hasOwn(p,'negations'));
 assert(COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS.endsWith(JSON.stringify(COMMERCE_SEMANTIC_DELTA_SCHEMA)));
});
