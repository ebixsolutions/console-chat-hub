import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {build} from 'esbuild';
const compiled=await build({stdin:{contents:"export * from './supabase/functions/_shared/commerce-semantic-frame.ts'; export * from './supabase/functions/_shared/vertex-generation-config.ts'; export {resolveCustomerRequestDecision} from './supabase/functions/_shared/commerce-state-authority.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {resolveCustomerRequestDecision,COMMERCE_SEMANTIC_PROVIDER_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_V2_SCHEMA,decodeCommerceSemanticWire,normalizeCommerceSemanticFrame,buildVertexGenerationConfig,vertexResponseSchemaDiagnostic}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
function nodes(value,path=[]){const kind=value===null?'null':Array.isArray(value)?'array':typeof value;return [{path,kind,...(kind==='string'?{text:value}:kind==='number'?{number:value}:kind==='boolean'?{boolean:value}:{})},...(['object','array'].includes(kind)?Object.entries(value).flatMap(([k,v])=>nodes(v,[...path,k])):[])];}
const wire=(delta={},operation='UPDATE_ITEM')=>({context_encoding:'semantic_paths_v2',operation,confidence:0.98,nodes:nodes(delta)});
const canonical=v=>normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(v));
// Independent check of the documented provider schema subset. This reproduces
// a source-contract mismatch, NOT the unavailable historical malformed node.
function providerAccepts(s,v){
 const type=s.type?.toLowerCase();
 if(s.anyOf)return s.anyOf.some(b=>providerAccepts(b,v));
 if(s.enum&&!s.enum.includes(v))return false;
 if(type==='object')return !!v&&typeof v==='object'&&!Array.isArray(v)&&(s.required??[]).every(k=>Object.hasOwn(v,k))&&Object.entries(s.properties??{}).every(([k,b])=>!Object.hasOwn(v,k)||providerAccepts(b,v[k]));
 if(type==='array')return Array.isArray(v)&&(!s.maxItems||v.length<=Number(s.maxItems))&&v.every(x=>providerAccepts(s.items,x));
 return typeof v===type;
}
test('provider-shaped fixtures establish required scalar pairing without loosening the decoder',()=>{
 const current=buildVertexGenerationConfig(4096,true,COMMERCE_SEMANTIC_PROVIDER_V2_SCHEMA,0,'gemini-2.5-flash').responseSchema.properties.nodes.items;
 const historical={type:'object',required:['path','kind'],properties:{path:{type:'array',items:{type:'string'},maxItems:6},kind:{type:'string',enum:['object','array','string','number','boolean','null']},text:{type:'string'},number:{type:'number'},boolean:{type:'boolean'}}};
 for(const [kind,field,value] of [['string','text','eight'],['number','number',0],['boolean','boolean',false]]){
  const malformed={path:['customer_facts','0','value'],kind};assert(providerAccepts(historical,malformed));assert(!providerAccepts(current,malformed));
  assert(providerAccepts(current,{...malformed,[field]:value}));
  const w=wire({customer_facts:[{key:'requirement',value}]});assert(w.nodes.every(n=>providerAccepts(current,n)));assert(canonical(w));
 }
 // Provider schemas cannot replace strict graph, canonical, or closed-field
 // validation. Unsupported extra fields remain rejected, never stripped.
 const w=wire();w.nodes.push({path:['intent'],kind:'string',text:'other',boolean:false});assert.equal(canonical(w),null);
});
for(const [stage,mutate] of [
 ['scalar_value',w=>w.nodes.push({path:['intent'],kind:'string'})],
 ['node_fields',w=>w.nodes.push({path:['PRIVATE-CUSTOMER'],kind:'null',text:'PRIVATE-SECRET'})],
 ['duplicate_path',w=>w.nodes.push({path:[],kind:'object'})],
 ['parent',w=>w.nodes.push({path:['PRIVATE-CUSTOMER','child'],kind:'null'})],
 ['canonical_vocabulary',w=>w.nodes=nodes({requested_facts:[17]})],
])test('wire rejection stage is bounded and redacted: '+stage,()=>{
 const w=wire();mutate(w);let diagnostic;assert.equal(decodeCommerceSemanticWire(w,(code,d)=>{assert.equal(code,'wire_context_nodes');diagnostic=d;}),null);
 assert.equal(diagnostic.stage,stage);assert.equal(diagnostic.container,'wire_nodes');assert(diagnostic.node_count>0&&diagnostic.node_count<=32769);
 assert(Object.keys(diagnostic).every(k=>['stage','container','node_index','node_count','field_class','reason'].includes(k)));assert(!JSON.stringify(diagnostic).includes('PRIVATE-'));
 if(stage==='canonical_vocabulary')assert.deepEqual({field_class:diagnostic.field_class,reason:diagnostic.reason},{field_class:'requested_facts',reason:'type'});
});
test('v239 failure repair: real Vertex request builder receives only one shallow typed-tree grammar, never the expanded Commerce schema',()=>{
 const config=buildVertexGenerationConfig(4096,true,COMMERCE_SEMANTIC_PROVIDER_V2_SCHEMA,0,'gemini-2.5-flash');
 assert.deepEqual(config.responseSchema.required,['context_encoding','operation','confidence','nodes']);
 assert.equal(config.responseMimeType,'application/json');assert.deepEqual(config.responseSchema.properties.context_encoding.enum,['semantic_paths_v2']);
 assert(!('entities' in config.responseSchema.properties));assert(!('customer_facts' in config.responseSchema.properties));
 const d=vertexResponseSchemaDiagnostic(COMMERCE_SEMANTIC_PROVIDER_V2_SCHEMA);assert.equal(d.objects,7);assert.equal(d.arrays,7);assert(d.schema_bytes<2000);assert.equal(d.transport,'semantic_paths_v2');
 // Structural regression budget, not a claim of live provider acceptance.
 assert(!/delta_json|value_json|additionalProperties/.test(JSON.stringify(config.responseSchema)));
 const alternatives=config.responseSchema.properties.nodes.items.anyOf;assert.equal(alternatives.length,6);
 for(const branch of alternatives){assert.deepEqual(branch.required,Object.keys(branch.properties));assert.equal(branch.properties.path.maxItems,'6');}
 assert.equal(config.thinkingConfig.thinkingBudget,0);
});

// Explicit v3 fixtures exercise the actual wire, not an unavailable historical
// provider payload. No production encoder is used to construct expected values.
const v3=(patch={})=>({context_encoding:'semantic_fields_v3',operation:'ASK_FACT',confidence:0.98,
 language:'zh-HK',intent:'product_information',topic:'unseen model Q9',customer_correction:false,additive:false,
 transaction_state:'unknown',payment_state:'unknown',booking_state:'unknown',fulfillment_state:'unknown',
 requested_facts:['price'],explicit_negations:[],customer_facts:[],referents:[],
 ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},entities:[],
 containers:[],strings:[],numbers:[],booleans:[],...patch});
const v3Entity=(patch={})=>({name:'unseen model Q9',kind:'physical_product',confidence:0.98,
 entity_ref:'',category_hint:null,sku:null,model:null,quantity:null,unit:null,
 capabilities:{requires_delivery:false,supports_pickup:false,requires_installation:false,requires_booking:false,
 requires_quote:false,requires_site_check:false,digital_fulfilment:false,recurring_billing:false,rental_return:false,customization:false},...patch});
const providerV3Accepts=new Ajv({strict:false}).compile(COMMERCE_SEMANTIC_PROVIDER_SCHEMA);
test('v3 constrains native semantic types/enums with no optional or union grammar branches',()=>{
 const config=buildVertexGenerationConfig(4096,true,COMMERCE_SEMANTIC_PROVIDER_SCHEMA,0,'gemini-2.5-flash');
 assert.deepEqual(config.responseSchema.properties.context_encoding.enum,['semantic_fields_v3']);
 assert(!('nodes' in config.responseSchema.properties));
 const inspect=s=>{assert(!s.anyOf);if(s.properties){assert.deepEqual(s.required,Object.keys(s.properties));assert.deepEqual(s.propertyOrdering,Object.keys(s.properties));Object.values(s.properties).forEach(inspect);}if(s.items)inspect(s.items);};
 inspect(config.responseSchema);
 for(const [collection,valueField] of [['containers','kind'],['strings','text'],['numbers','number'],['booleans','boolean']]){
  const item=config.responseSchema.properties[collection].items;
  assert.deepEqual(item.required,['path',valueField]);assert.equal(item.properties.path.minItems,'3');assert.equal(item.properties.path.maxItems,'6');
 }
 const d=vertexResponseSchemaDiagnostic(COMMERCE_SEMANTIC_PROVIDER_SCHEMA);
 assert.equal(d.transport,'semantic_fields_v3');assert.equal(d.objects,10);assert.equal(d.arrays,14);assert(d.schema_bytes<6000);
 // This is a deterministic compiler-shape budget, not Hosted Vertex acceptance.
 assert(providerV3Accepts(v3({entities:[v3Entity()]})),JSON.stringify(providerV3Accepts.errors));
 assert(canonical(v3({entities:[v3Entity()]})));
});
for(const [label,mutate,field_class,reason] of [
 ['missing entity confidence',w=>delete w.entities[0].confidence,'entity_confidence','required'],
 ['string entity confidence',w=>w.entities[0].confidence='0.98','entity_confidence','type'],
 ['unknown entity kind',w=>w.entities[0].kind='PRIVATE-INVALID-KIND','entity_kind','enum'],
 ['nonnullable entity reference',w=>w.entities[0].entity_ref=null,'entity_ref','type'],
 ['boolean quantity',w=>w.entities[0].quantity=false,'entity_quantity','type'],
 ['negative quantity',w=>w.entities[0].quantity=-1,'entity_quantity','range'],
 ['out of range confidence',w=>w.entities[0].confidence=2,'entity_confidence','range'],
 ['numeric requested fact',w=>w.requested_facts=[17],'requested_facts','type'],
 ['lifecycle alias',w=>w.payment_state='PRIVATE-NOT-PAID','payment_state','enum'],
 ['referent source alias',w=>w.referents=[{ref:'PRIVATE-SUBJECT',source:'PRIVATE-HISTORY',confidence:0.98}],'referent_source','enum'],
])test('v3 producer and strict decoder agree on rejection: '+label,()=>{
 const w=v3({entities:[v3Entity()]});mutate(w);
 assert.equal(providerV3Accepts(w),false,'the producer must constrain this error before decoding');
 let diagnostic;assert.equal(decodeCommerceSemanticWire(w,(code,d)=>{assert.equal(code,'wire_context_nodes');diagnostic=d;}),null);
 assert.equal(diagnostic.field_class,field_class);assert.equal(diagnostic.reason,reason);
 assert(!JSON.stringify(diagnostic).includes('PRIVATE-'));assert(!JSON.stringify(diagnostic).includes('0.98'));
});
test('v3 preserves independent entity associations, unknowns and explicit false/zero/null/empty values',()=>{
 const w=v3({operation:'UPDATE_ITEM',customer_correction:true,entities:[v3Entity({name:'first request'}),v3Entity({name:'second request',kind:'rental'})],
  customer_facts:[{key:'seats'},{key:'auto_renew'},{key:'date'},{key:'excluded_options'},{key:'extra_requirements'}],
  containers:[{path:['entities','0','attributes'],kind:'object'},{path:['entities','1','constraints'],kind:'object'},
   {path:['customer_facts','2','value'],kind:'null'},{path:['customer_facts','3','value'],kind:'array'},{path:['customer_facts','4','value'],kind:'object'}],
  strings:[{path:['entities','0','attributes','customer_label'],text:'first requirement'},{path:['entities','1','constraints','customer_label'],text:'second requirement'}],
  numbers:[{path:['customer_facts','0','value'],number:0}],booleans:[{path:['customer_facts','1','value'],boolean:false}]});
 assert(providerV3Accepts(w));const actual=canonical(w);assert(actual);
 assert.deepEqual(actual.customer_facts.map(f=>f.value),[0,false,null,[],{}]);
 assert.equal(actual.entities[0].attributes.customer_label,'first requirement');assert.equal(actual.entities[1].constraints.customer_label,'second requirement');
 assert.deepEqual(actual.entities[0].constraints,{});assert.deepEqual(actual.entities[1].attributes,{});
 assert.equal(actual.entities[0].quantity,null);assert.equal(actual.payment_state,'unknown');assert.equal(actual.customer_correction,true);
});
for(const [label,mutate] of [
 ['undeclared entity',w=>w.containers.push({path:['entities','1','attributes'],kind:'object'})],
 ['undeclared fact',w=>w.strings.push({path:['customer_facts','0','value'],text:'PRIVATE-VALUE'})],
 ['fixed entity identity overwrite',w=>w.strings.push({path:['entities','0','name'],text:'PRIVATE-OVERRIDE'})],
 ['other entity fixed identity overwrite',w=>{w.entities.push(v3Entity({name:'second'}));w.strings.push({path:['entities','1','entity_ref'],text:'PRIVATE-OVERRIDE'});}],
 ['frame root injection',w=>w.containers.push({path:[],kind:'object'})],
 ['duplicate path across typed arrays',w=>w.strings.push({path:['entities','0','attributes'],text:'PRIVATE-OVERRIDE'})],
 ['missing context parent',w=>w.strings.push({path:['entities','0','constraints','customer_key'],text:'PRIVATE-VALUE'})],
 ['sparse context array',w=>{w.customer_facts=[{key:'PRIVATE-FACT'}];w.containers.push({path:['customer_facts','0','value'],kind:'array'});w.numbers.push({path:['customer_facts','0','value','1'],number:0});}],
 ['prototype path',w=>w.strings.push({path:['entities','0','attributes','constructor'],text:'PRIVATE-VALUE'})],
 ['inactive scalar slot',w=>w.containers[0].text='PRIVATE-VALUE'],
 ['unknown fixed field',w=>w.PRIVATE_DYNAMIC_KEY='PRIVATE-VALUE'],
 ['untrusted capability',w=>w.entities[0].capabilities.PRIVATE_PROMISE=true],
 ['missing customer fact value',w=>w.customer_facts=[{key:'PRIVATE-FACT'}]],
])test('v3 rejects context/authority corruption without customer-data diagnostics: '+label,()=>{
 const w=v3({entities:[v3Entity()],containers:[{path:['entities','0','attributes'],kind:'object'}]});mutate(w);
 let diagnostic;assert.equal(decodeCommerceSemanticWire(w,(code,d)=>{assert.equal(code,'wire_context_nodes');diagnostic=d;}),null);
 assert(diagnostic);assert(!JSON.stringify(diagnostic).includes('PRIVATE-'));assert(!JSON.stringify(diagnostic).includes('PRIVATE_'));
 assert(Object.keys(diagnostic).every(k=>['stage','container','node_index','node_count','field_class','reason'].includes(k)));
});
for(const [business,delta] of [
 ['rooms',{customer_facts:[{key:'areas',value:{small:80,large:100,living:180,unit:'sq_ft'}},{key:'sunlight',value:'none'}],entities:[{name:'living room unit',entity_ref:'living',kind:'physical_product',quantity:1,unit:'unit',confidence:0.98,attributes:{width:70,height:55,unit:'cm'},constraints:{night_noise:false,budget:{amount:6000,unit:'HKD'}}}]}],
 ['subscription',{customer_correction:true,customer_facts:[{key:'seats',value:0},{key:'auto_renew',value:false},{key:'renewal_date',value:null}],entities:[{name:'analytics plan',kind:'subscription',confidence:0.98,constraints:{add_ons:[],maximum_users:0},capabilities:{recurring_billing:true}}]}],
 ['rental',{entities:[{name:'telescope rental',kind:'rental',confidence:0.98,entity_ref:'rental-1',quantity:2,unit:'days',constraints:{wheelchair_access:true,delivery:{required:false,arrival:null}}}],explicit_negations:['not purchased'],referents:[{ref:'rental-1',source:'current_turn',confidence:0.98}]}],
 ['service',{language:'en',intent:'booking_enquiry',topic:'onsite service',entities:[{name:'onsite support',kind:'service',confidence:0.98,constraints:{rooms:['training','meeting'],window:{width:70,height:55,unit:'cm'}}}],booking_state:'requested'}],
 ['merchant-policy',{intent:'merchant_policy',requested_facts:['current return policy'],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null}}],
])test('flat transport losslessly reconstructs complete canonical '+business+' without default facts',()=>{
 const actual=canonical(wire(delta));const expected=normalizeCommerceSemanticFrame({operation:'UPDATE_ITEM',confidence:0.98,...delta});
 assert(actual);assert.deepEqual(actual,expected);assert.equal(actual.customer_facts.length,delta.customer_facts?.length??0);
 assert.deepEqual(canonical({...wire(delta),nodes:nodes(delta).reverse()}),actual,'graph ordering cannot change meaning');
});
for(const operation of ['ADD_ITEM','SET_QUANTITY','UPDATE_ITEM','REMOVE_ITEM','CANCEL_ITEM','RESERVE','REQUEST_QUOTE','ASK_FACT','ASK_CALCULATION','CONFIRM','DEFER','NO_STATE_CHANGE'])test('full operation vocabulary preserved: '+operation,()=>{
 const result=canonical(wire({},operation));assert(result);assert.equal(result.operation,operation);assert.equal(result.customer_facts.length,0);assert.equal(result.entities.length,0);
});
for(const [name,mutate] of [
 ['missing-parent',w=>w.nodes.push({path:['a','b'],kind:'number',number:1})],
 ['duplicate-path',w=>w.nodes.push({path:[],kind:'object'})],
 ['scalar-type',w=>w.nodes.push({path:['intent'],kind:'number',number:'0'})],
 ['inactive-slot',w=>w.nodes.push({path:['topic'],kind:'null',number:0})],
 ['sparse-array',w=>w.nodes.push({path:['entities'],kind:'array'},{path:['entities','1'],kind:'object'})],
 ['huge-index',w=>w.nodes.push({path:['entities'],kind:'array'},{path:['entities','999999999'],kind:'object'})],
 ['prototype',w=>w.nodes.push({path:['__proto__'],kind:'object'})],
 ['normalized-prototype',w=>w.nodes=nodes({customer_facts:[{key:'safety',value:{' constructor ':false}}]})],
 ['unknown-root',w=>w.nodes.push({path:['source_message_id'],kind:'string',text:'forged'})],
 ['outer-alias',w=>w.extra='untrusted'],
 ['unknown-kind',w=>w.nodes[0].kind=undefined],
 ['normalized-collision',w=>w.nodes.push({path:['topic'],kind:'string',text:'one'},{path:[' topic '],kind:'string',text:'two'})],
 ['nested-commerce-alias',w=>w.nodes=nodes({entities:[{name:'support',kind:'service',confidence:0.98,attributes_json:'{}'}]})],
 ['authority-injection',w=>w.nodes=nodes({entities:[{name:'support',kind:'service',confidence:0.98,capabilities:{merchant_promise:true}}]})],
 ['string-context',w=>w.nodes=nodes({entities:[{name:'support',kind:'service',confidence:0.98,attributes:'{"width":70}'}]})],
 ['array-context',w=>w.nodes=nodes({entities:[{name:'support',kind:'service',confidence:0.98,constraints:[false]}]})],
 ['coerced-quantity',w=>w.nodes=nodes({entities:[{name:'support',kind:'service',confidence:0.98,quantity:false}]})],
 ['negative-quantity',w=>w.nodes=nodes({entities:[{name:'support',kind:'service',confidence:0.98,quantity:-1}]})],
 ['missing-entity-confidence',w=>w.nodes=nodes({entities:[{name:'support',kind:'service'}]})],
 ['entity-confidence-range',w=>w.nodes=nodes({entities:[{name:'support',kind:'service',confidence:2}]})],
 ['numeric-requested-fact',w=>w.nodes=nodes({requested_facts:[3]})],
 ['string-ambiguity',w=>w.nodes=nodes({ambiguity:{is_ambiguous:'false'}})],
 ['invalid-lifecycle-enum',w=>w.nodes=nodes({payment_state:'merchant_says_paid'})],
])test('flat transport fails closed before canonical mutation: '+name,()=>{
 const w=wire();mutate(w);let code;assert.equal(decodeCommerceSemanticWire(w,c=>code=c),null);assert.equal(code,'wire_context_nodes');
});
for(const delta of [
 {customer_facts:[{key:'count',value:'x'.repeat(301)}]},
 {entities:[{name:'service',kind:'service',confidence:0.9,constraints:Object.fromEntries(Array.from({length:41},(_,i)=>['k'+i,i]))}]},
 {entities:[{name:'rental',kind:'rental',confidence:0.9,attributes:{list:Array(13).fill(false)}}]},
 {entities:Array.from({length:13},()=>({name:'service',kind:'service',confidence:0.98}))},
])test('new transport still rejects original canonical bounds without truncation: '+Object.keys(delta)[0],()=>{assert.equal(canonical(wire(delta)),null);});

for(const [question,expected] of [
 ['How should I compare subscription arrangements? I do not need your current prices.','guidance'],
 ['How should I compare booking options? No need for policy details.','guidance'],
 ['How should we compare equipment? We do not need your stock information.','guidance'],
 ['請講解應比較的規格和取捨，不需要店舖售價或庫存。','guidance'],
 ['How should I compare options? I do not need prices, but what is your Singapore warranty?','mixed'],
 ['No need for policy details and check your stock.','merchant_facts'],
 ['不需要店舖售價，請查你們現時庫存。','merchant_facts'],
 ['What does your cancellation policy say about customers who do not need the service?','merchant_facts'],
 ['What are your current model X specifications?','merchant_facts'],
])test('shared decision preserves scoped factual refusal versus affirmative authority: '+question,()=>{
 const frame=canonical(wire({intent:'customer_guidance',requested_facts:[]},'ASK_FACT'));
 assert.equal(resolveCustomerRequestDecision(question,frame).kind,expected);
});

for (const [question,key,value] of [
 ['其實只會開八個分頁，預算要節省，仍然是桌上型和不打機。請按這個更正調整建議，哪些升級可以暫緩？','usage_scenario',{browser_tabs_open_simultaneously:8}],
 ['Actually we have six seats now. Which upgrades can wait?','seats',6],
 ['改為十二件，按新數量調整建議。','quantity',12],
 ['Only four participants now; revise the recommendation.','participants',4],
 ['Our required capacity is now 50 units; revise the procurement advice.','capacity',50],
]) test('declarative prior guidance continues with validated customer update: '+key,()=>{
 const history=[{role:'assistant',content:'Here are the general trade-offs.',metadata:{response_route:'customer_guidance'}}];
 const semantic={operation:'UPDATE_ITEM',intent:'customer_guidance',confidence:0.98,requested_facts:[],ambiguity:{is_ambiguous:false},customer_facts:[{key,value}]};
 const decision=resolveCustomerRequestDecision(question,semantic,history);
 assert.equal(decision.kind,'guidance');assert.equal(decision.continuation,true);
 assert.equal(resolveCustomerRequestDecision(question,{...semantic,operation:'CANCEL_ITEM'},history).continuation,false);
 assert.equal(resolveCustomerRequestDecision(question,{...semantic,ambiguity:{is_ambiguous:true}},history).continuation,false);
});
