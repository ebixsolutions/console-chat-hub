import {isCurrentRequirementsRecap,isCustomerGuidanceRequest} from '../../supabase/functions/_shared/commerce-state-authority.ts';
import { buildVertexGenerationConfig, buildVertexEndpoint, normalizeVertexResponseSchema, safeVertexErrorDiagnostic } from '../../supabase/functions/_shared/vertex-generation-config.ts';
import {COMMERCE_SEMANTIC_COMPACT_WIRE_SCHEMA,COMMERCE_SEMANTIC_WIRE_SCHEMA,COMMERCE_SEMANTIC_DELTA_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS,COMMERCE_SEMANTIC_NATIVE_INSTRUCTIONS,COMMERCE_SEMANTIC_NATIVE_SCHEMA,decodeCommerceSemanticWire,normalizeCommerceSemanticFrame} from '../../supabase/functions/_shared/commerce-semantic-frame.ts';
import {classifyNonFactualConversation} from '../../supabase/functions/_shared/conversational-routing.ts';
import {classifyCanonicalConversationTurn} from '../../supabase/functions/_shared/conversation-semantic-contract.ts';
import {terminalRecoveryReply} from '../../supabase/functions/_shared/generation-terminal-guard.ts';
function assert(v:unknown,m='assertion'):asserts v {if(!v)throw Error(m)}
function throws(f:()=>unknown){let failed=false;try{f()}catch{failed=true}assert(failed,'invalid request accepted')}
Deno.test('Hosted 21745026 native JSON avoids the second-document escape boundary; malformed legacy output remains rejected',()=>{
 const malformed={operation:'UPDATE_ITEM',confidence:0.97,delta_json:'{"customer_correction":true,"customer_facts":[{"key":"budget","value":{"amount":5000,"unit":"HKD"}}'};
 const reasons:string[]=[];assert(decodeCommerceSemanticWire(malformed,r=>reasons.push(r))===null);assert(reasons[0]==='wire_delta_json');
 const native={operation:'UPDATE_ITEM',confidence:0.97,customer_correction:true,customer_facts:[{key:'budget',value:{amount:5000,unit:'HKD'}},{key:'auto_renew',value:false},{key:'seats',value:0},{key:'date',value:null}]};
 const f=normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(JSON.parse(JSON.stringify(native))))!;assert(f?.customer_correction);assert(f.customer_facts?.[0].value && typeof f.customer_facts[0].value==='object');assert(f.customer_facts?.[1].value===false&&f.customer_facts[2].value===0&&f.customer_facts[3].value===null);
 const cfg=buildVertexGenerationConfig(4096,true,undefined,0,'gemini-2.5-flash');assert(cfg.responseMimeType==='application/json');assert(!Object.hasOwn(cfg,'responseSchema'));assert((cfg.thinkingConfig as any).thinkingBudget===0);
 assert(COMMERCE_SEMANTIC_NATIVE_INSTRUCTIONS.endsWith(JSON.stringify(COMMERCE_SEMANTIC_NATIVE_SCHEMA)));
 for(const alias of ['correction','lifecycle','negations','unknown'])assert(decodeCommerceSemanticWire({...native,[alias]:'PRIVATE-SECRET'})===null);
 assert(!normalizeCommerceSemanticFrame({...native,confidence:2}));assert(!normalizeCommerceSemanticFrame({...native,operation:'INVALID'}));assert(!normalizeCommerceSemanticFrame({...native,customer_facts:Array(17).fill({key:'x',value:1})}));
});
Deno.test('customer priority rankings do not request merchant facts; affirmative mixed requests retain grounding',()=>{
 const frame={intent:'customer_guidance',confidence:0.97,requested_facts:[] as string[],ambiguity:{is_ambiguous:false}};
 for(const q of ['夜間安靜比初期價錢更重要。請解釋如何取捨，暫時不查產品或報價。','Quiet operation matters more than upfront price. What trade-offs should I consider?','I prioritize accessibility over price. How should I choose a rental service?','更正：預算HK$5,000。安全比價錢更重要，請解釋選購取捨。'])assert(isCustomerGuidanceRequest(q,frame),q);
 for(const q of ['安靜比價錢更重要，但請查最新價錢。','Quiet operation matters more than upfront price, but what is your current price?','I prioritize accessibility over price. What is your warranty policy?','請比較A及B的價錢，並講解取捨。'])assert(!isCustomerGuidanceRequest(q,frame),q);
 assert(isCustomerGuidanceRequest('安靜比價錢更重要，請解釋取捨。',{...frame,requested_facts:['current_price']}),'model target cannot turn a customer priority into a merchant claim');
 assert(!isCustomerGuidanceRequest('請查最新價錢，並解釋取捨。',{...frame,requested_facts:[]}), 'actual merchant request still requires evidence even when frame omits target');
});
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
 assert(isCustomerGuidanceRequest('What should I measure?',{...frame,requested_facts:['stock']}),'model target alone cannot authorize merchant lookup');assert(isCustomerGuidanceRequest('What should I measure?',{...frame,ambiguity:{is_ambiguous:true}}),'ambiguity allows general measurement guidance without assigning unknown facts');
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

Deno.test('Hosted 80b1afec general advice routing is independent of a valid free-form model label',()=>{
 const frame={intent:'ASK_FACT',confidence:0.97,requested_facts:[] as string[],ambiguity:{is_ambiguous:false}};
 const question='你好，我想換冷氣給家中兩位長者使用。客廳180平方呎，預算HK$6,000，重視夜間安靜及省電。未選型號，請解釋選購時應如何取捨，並告訴我要量度哪些現場尺寸；暫時不用查外部產品或報價。';
 for(const intent of ['customer_guidance','ask_fact','explore_options','customer_context_update'])assert(isCustomerGuidanceRequest(question,{...frame,intent}));
 assert(isCustomerGuidanceRequest('What should I measure and what selection criteria should I consider?',{...frame,requested_facts:['selection_tradeoffs','site_measurements']}));
 assert(isCustomerGuidanceRequest(question,{...frame,requested_facts:['installation_dimensions']}));
 assert(isCustomerGuidanceRequest('What should I measure?',{...frame,requested_facts:['stock']}),'model target alone cannot authorize merchant lookup');
 assert(isCustomerGuidanceRequest('What should I measure?',{...frame,requested_facts:['unknown_fact']}));
 assert(!isCustomerGuidanceRequest('What should I measure, and what stock do you currently have?',{...frame,requested_facts:[]}));
 for(const text of ['What should I measure and what is the current price?','不用查外部產品，但你們有現貨嗎？請說明選購取捨。','What trade-offs should I consider under your warranty policy?'])assert(!isCustomerGuidanceRequest(text,frame));
 assert(!isCustomerGuidanceRequest(question,{...frame,confidence:0.2}));assert(isCustomerGuidanceRequest(question,{...frame,ambiguity:{is_ambiguous:true}}),'ambiguity constrains state binding, not safe guidance');assert(!isCustomerGuidanceRequest(question,null));
});

Deno.test('Hosted efec7018 correction advice recognizes explicit no-lookup instructions without merchant admission',()=>{
 const frame={intent:'customer_context_update',confidence:0.97,requested_facts:['installation_dimensions','selection_steps'],ambiguity:{is_ambiguous:false}};
 const correction='更正一下：客廳其實是150平方呎，預算改為HK$5,000；兩位長者和夜間安靜、省電的優先次序不變。請以這些最新資料說明量度及選購的下一步，不需要查型號或報價。';
 assert(isCustomerGuidanceRequest(correction,frame),'the actual second-turn wording must remain general advice');
 for(const negative of ['不需要查','不需查','無需查','无需查','唔需要查','不用查'])assert(isCustomerGuidanceRequest('請說明選購取捨；'+negative+'型號或報價。',frame),negative);
 for(const text of ['請說明選購取捨；不需要查型號，但請查報價。','請說明選購取捨；不需要查型號及請查保養。','請推薦現貨，不需要查型號。','請說明選購取捨，現在價錢幾多？'])assert(!isCustomerGuidanceRequest(text,frame),text);
 assert(!isCustomerGuidanceRequest(correction,{...frame,confidence:0.2}));assert(isCustomerGuidanceRequest(correction,{...frame,ambiguity:{is_ambiguous:true}}));
 assert(!isCustomerGuidanceRequest(correction+'但請查最新價錢。',{...frame,requested_facts:[],ambiguity:{is_ambiguous:true}}));assert(!isCustomerGuidanceRequest(correction,null));
});

Deno.test('Hosted a6626087 compact prompt uses one encoding layer and canonical typed values; malformed legacy fields stay rejected',()=>{
 const delta={intent:'customer_guidance',entities:[{name:'洗衣機',kind:'physical_product',confidence:0.97,constraints:{max_depth:{amount:560,unit:'mm'}}}],customer_facts:[{key:'priority',value:'quiet operation'},{key:'family_size',value:3},{key:'auto_renew',value:false},{key:'seats',value:0},{key:'date',value:null}]};
 const wire={operation:'ADD_ITEM',confidence:0.97,delta_json:JSON.stringify(delta)};
 const frame=normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(wire))!;assert(frame);assert(frame.customer_facts);assert(frame.customer_facts[0].value==='quiet operation');assert(frame.customer_facts[2].value===false);assert(frame.customer_facts[3].value===0);assert(frame.customer_facts[4].value===null);assert((frame.entities[0].constraints.max_depth as any).amount===560);
 const props=COMMERCE_SEMANTIC_DELTA_SCHEMA.properties;assert('value' in props.customer_facts.items.properties);assert(!('value_json' in props.customer_facts.items.properties));
 assert(COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS.includes('Do not add a second JSON encoding layer'));
 for(const facts of [[{key:'priority',value_json:'quiet operation'}],[{key:'size',value_json:560}],[{key:'size',value:560,value_json:'560'}]])assert(decodeCommerceSemanticWire({...wire,delta_json:JSON.stringify({customer_facts:facts})})===null);
 assert(decodeCommerceSemanticWire({...wire,delta_json:JSON.stringify({entities:[{name:'item',kind:'physical_product',attributes:{a:1},attributes_json:'{"a":2}'}]})})===null);
 assert(!normalizeCommerceSemanticFrame(decodeCommerceSemanticWire({...wire,delta_json:JSON.stringify({customer_facts:[{key:'too_deep',value:{a:{b:{c:{d:1}}}}}]})})));
});

Deno.test('Hosted 4df129e5 onsite observation advice remains general across natural phrasing',()=>{
 const frame={intent:'ask_fact',confidence:0.97,requested_facts:['onsite_conditions'],ambiguity:{is_ambiguous:false}};
 const question='如果長者對晚上風聲特別敏感，我去現場量度時應先記低哪幾項環境情況，才方便之後跟安裝師傅討論？請沿用最新面積及預算，暫時不用查商戶產品。';
 for(const text of [question,'現場測量時應留意哪些環境資料？不用查產品。','现场测量时要先记录哪些环境资料？不用查产品。'])assert(isCustomerGuidanceRequest(text,frame),text);
 for(const text of [question+'但請查現貨。',question+'請推薦型號。',question+'請確認你們的保養政策。'])assert(!isCustomerGuidanceRequest(text,frame),text);
 assert(isCustomerGuidanceRequest(question,{...frame,ambiguity:{is_ambiguous:true}}),'ambiguity constrains state binding, not safe guidance');assert(!isCustomerGuidanceRequest(question,{...frame,confidence:0.2}));assert(!isCustomerGuidanceRequest(question,null));
});
