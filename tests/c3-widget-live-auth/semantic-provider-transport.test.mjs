import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Ajv from 'ajv';
import {build} from 'esbuild';
const compiled=await build({stdin:{contents:"export * from './supabase/functions/_shared/commerce-semantic-frame.ts'; export * from './supabase/functions/_shared/vertex-generation-config.ts'; export {resolveCustomerRequestDecision} from './supabase/functions/_shared/commerce-state-authority.ts'; export {sourceOwnedOptionWording,resolveCurrentFactualRequest} from './supabase/functions/_shared/current-factual-request.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {resolveCustomerRequestDecision,resolveCurrentFactualRequest,COMMERCE_SEMANTIC_PROVIDER_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_V2_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_V3_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_V4_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_V5_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_V6_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_V7_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V5,COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V6,COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V7,COMMERCE_SEMANTIC_SYSTEM_PROMPT,decodeCommerceSemanticWire,normalizeCommerceSemanticFrame,recoverSourceOwnedOptionAfterEntityTypeFailure,sourceOwnedOptionWording,buildVertexGenerationConfig,vertexResponseSchemaDiagnostic}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
function nodes(value,path=[]){const kind=value===null?'null':Array.isArray(value)?'array':typeof value;return [{path,kind,...(kind==='string'?{text:value}:kind==='number'?{number:value}:kind==='boolean'?{boolean:value}:{})},...(['object','array'].includes(kind)?Object.entries(value).flatMap(([k,v])=>nodes(v,[...path,k])):[])];}
const wire=(delta={},operation='UPDATE_ITEM')=>({context_encoding:'semantic_paths_v2',operation,confidence:0.98,nodes:nodes(delta)});
const canonical=v=>normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(v));
// Independent native proposals are encoded only for fixture construction. The
// production decoder is checked against their full canonical meaning below.
function v4(delta={},operation='UPDATE_ITEM') {
 const list=nodes({demands:[],...delta});
 return {context_encoding:'semantic_values_v4',operation,confidence:0.98,
  containers:list.filter(n=>['object','array','null'].includes(n.kind)).map(({path,kind})=>({path,kind})),
  strings:list.filter(n=>n.kind==='string').map(({path,text})=>({path,text})),
  numbers:list.filter(n=>n.kind==='number').map(({path,number})=>({path,number})),
  booleans:list.filter(n=>n.kind==='boolean').map(({path,boolean})=>({path,boolean}))};
}
function v5(delta={},operation='UPDATE_ITEM') {
 const fixture=v4(delta,operation);
 return {...fixture,context_encoding:'semantic_values_v5',containers:fixture.containers.filter(node=>node.path.length)};
}
const demand=(patch={})=>({question:'What is the current price of model Q9?',source_quote:'Q9 price?',subject_refs:['Q9'],
 source_type:'product',requested_facts:['price'],constraints:{},customer_correction:false,explicit_negations:[],
 ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},...patch});
const providerV4Accepts=new Ajv({strict:false}).compile(COMMERCE_SEMANTIC_PROVIDER_V4_SCHEMA);
const providerV5Accepts=new Ajv({strict:false}).compile(COMMERCE_SEMANTIC_PROVIDER_V5_SCHEMA);
const valueTransports=[['v4',v4,providerV4Accepts,COMMERCE_SEMANTIC_PROVIDER_V4_SCHEMA],['v5',v5,providerV5Accepts,COMMERCE_SEMANTIC_PROVIDER_V5_SCHEMA]];
for(const [version,encode,accepts,schema] of valueTransports)test(version+' keeps provider grammar small and typed while semantic vocabulary is validated independently',()=>{
 const config=buildVertexGenerationConfig(4096,true,schema,0,'gemini-2.5-flash');
 assert.deepEqual(config.responseSchema.properties.context_encoding.enum,['semantic_values_'+version]);
 assert.deepEqual(config.responseSchema.required,['context_encoding','operation','confidence','containers','strings','numbers','booleans']);
 assert(!('entities' in config.responseSchema.properties));assert(!('demands' in config.responseSchema.properties));
 const inspect=s=>{assert(!s.anyOf);if(s.properties){assert.deepEqual(s.required,Object.keys(s.properties));assert.deepEqual(s.propertyOrdering,Object.keys(s.properties));Object.values(s.properties).forEach(inspect);}if(s.items)inspect(s.items);};
 inspect(config.responseSchema);
 const current=vertexResponseSchemaDiagnostic(schema),rejected=vertexResponseSchemaDiagnostic(COMMERCE_SEMANTIC_PROVIDER_V3_SCHEMA);
 assert.equal(current.transport,'semantic_values_'+version);
 assert.equal(current.objects,5);assert.equal(current.arrays,8);assert.equal(current.enum_values,16);assert(current.schema_bytes<1600);
 assert(current.schema_bytes<rejected.schema_bytes/3);assert(!/anyOf|additionalProperties|delta_json|value_json/.test(JSON.stringify(config.responseSchema)));
 assert.equal(config.thinkingConfig.thinkingBudget,0);
 // Offline compiler shape is not evidence of Hosted provider acceptance.
 for(const collection of ['containers','strings','numbers','booleans'])assert.equal(config.responseSchema.properties[collection].items.properties.path.minItems,version==='v5'?'1':undefined);
 const fixture=encode({demands:[demand()],requested_facts:['price']},'ASK_FACT');
 assert(accepts(fixture),JSON.stringify(accepts.errors));assert(canonical(fixture));
});
for(const [version,encode,accepts] of valueTransports)test(version+' preserves every independent product, live transaction and policy clause and exact typed constraints',()=>{
 const delta={customer_correction:true,customer_facts:[{key:'users',value:0},{key:'renewal',value:false},{key:'date',value:null}],
  demands:[demand({customer_correction:true,constraints:{renewal:false,capacity:{amount:0,unit:'users'},excluded:[],date:null}}),
   demand({question:'Where is my order 12354?',source_quote:'Where is my order 12354?',subject_refs:['12354'],source_type:'transaction',requested_facts:['delivery_progress']}),
   demand({question:'What is the return policy?',source_quote:'What is the return policy?',subject_refs:[],source_type:'policy',requested_facts:['return_policy']})],
  requested_facts:['price','return_policy'],payment_state:'unknown'};
 const fixture=encode(delta);assert(accepts(fixture));
 const actual=canonical(fixture);assert(actual);assert.deepEqual(actual,normalizeCommerceSemanticFrame({operation:'UPDATE_ITEM',confidence:0.98,...delta}));
 assert.deepEqual(actual.demands.map(d=>d.source_type),['product','transaction','policy']);
 assert.deepEqual(actual.demands[0].constraints,{capacity:{amount:0,unit:'users'},date:null,excluded:[],renewal:false});
 assert.deepEqual(actual.demands[1].requested_facts,['delivery_progress']);assert.deepEqual(actual.demands[2].subject_refs,[]);
 assert.deepEqual(canonical({...fixture,containers:fixture.containers.toReversed(),strings:fixture.strings.toReversed()}),actual);
});
for(const [version,encode] of valueTransports)for(const [label,delta] of [
 ['invalid lifecycle enum',{payment_state:'PRIVATE-STATUS'}],
 ['coerced quantity',{entities:[{name:'Q9',kind:'physical_product',confidence:0.98,quantity:false}]}],
 ['invalid entity kind',{entities:[{name:'Q9',kind:'PRIVATE-KIND',confidence:0.98}]}],
 ['missing entity confidence',{entities:[{name:'Q9',kind:'physical_product'}]}],
 ['unknown demand type',{demands:[demand({source_type:'PRIVATE-ROUTE'})]}],
 ['invented provenance field',{demands:[{...demand(),source_message_id:'PRIVATE-ID'}]}],
 ['coerced demand reference',{demands:[demand({subject_refs:[17]})]}],
 ['stringified demand context',{demands:[demand({constraints:'{"budget":0}'})]}],
 ['oversized demand array',{demands:Array(13).fill(demand())}],
 ['oversized demand quote',{demands:[demand({source_quote:'x'.repeat(1601)})]}],
 ['NFKC-expanded demand quote',{demands:[demand({source_quote:'㍿'.repeat(401)})]}],
 ['NFKC-expanded subject reference',{demands:[demand({subject_refs:['㍿'.repeat(41)]})]}],
 ['unbounded demand context',{demands:[demand({constraints:{a:{b:{c:{value:0}}}}})]}],
])test(version+' retains strict canonical vocabulary and limits: '+label,()=>{
 let diagnostic;
 const decoded=decodeCommerceSemanticWire(encode(delta),(_code,d)=>{diagnostic=d;});
 const result=normalizeCommerceSemanticFrame(decoded,(_code,d)=>{diagnostic??=d;});
 assert.equal(result,null);assert(!JSON.stringify(diagnostic??{}).includes('PRIVATE-'));
});
for(const [version,encode,accepts] of valueTransports)test(version+' rejects cross-collection path overwrites, undeclared parents, missing demand list and absent typed scalar',()=>{
 const duplicate=encode({customer_facts:[{key:'seats',value:0}]});duplicate.booleans.push({path:['customer_facts','0','value'],boolean:false});assert.equal(canonical(duplicate),null);
 const missingParent=encode();missingParent.strings.push({path:['demands','0','question'],text:'PRIVATE-VALUE'});assert.equal(canonical(missingParent),null);
 const noDemands=encode();noDemands.containers=noDemands.containers.filter(n=>n.path[0]!=='demands');assert.equal(canonical(noDemands),null);
 const noValue=encode();noValue.numbers.push({path:['topic']});assert.equal(accepts(noValue),false);assert.equal(canonical(noValue),null);
 const noClauses=encode({requested_facts:['price']},'ASK_FACT');assert.equal(canonical(noClauses),null);
});
test('v4 missing/nonobject root remains a root-class failure; synthetic fixtures are not the captured V1 response',()=>{
 const delta={language:'en',intent:'product_information',topic:'Q9',customer_correction:false,additive:false,requested_facts:[]};
 const absent=v4({...delta,explicit_negations:[]});absent.containers=absent.containers.filter(node=>node.path.length);
 const nonobject=v4(delta);nonobject.containers.find(node=>!node.path.length).kind='array';
 for(const fixture of [absent,nonobject]){
  assert(providerV4Accepts(fixture));let diagnostic;
  assert.equal(decodeCommerceSemanticWire(fixture,(code,d)=>{assert.equal(code,'wire_context_nodes');diagnostic=d;}),null);
  assert.deepEqual(diagnostic,{container:'wire_nodes',stage:'root',node_count:8});
 }
});
test('v5 rejects provider roots of every type while the server root supplies no semantic fields',()=>{
 for(const [collection,node] of [['containers',{kind:'object'}],['containers',{kind:'array'}],['containers',{kind:'null'}],['strings',{text:'PRIVATE-VALUE'}],['numbers',{number:0}],['booleans',{boolean:false}]]){
  const fixture=v5();fixture[collection].push({path:[],...node});
  assert.equal(providerV5Accepts(fixture),false);assert.equal(canonical(fixture),null);
 }
 const fixture=v5();fixture.containers=[];assert(providerV5Accepts(fixture));
 let diagnostic;assert.equal(decodeCommerceSemanticWire(fixture,(_code,d)=>{diagnostic=d;}),null);
 assert.equal(diagnostic.field_class,'demands');assert.equal(diagnostic.reason,'required');assert.equal(diagnostic.node_count,1);
});
test('v5 counts the implicit root in the unchanged 32768-node bound',()=>{
 for(const [providerCount,stage,count] of [[32767,'duplicate_path',32768],[32768,'envelope',32769]]){
  const fixture=v5();fixture.containers=Array.from({length:providerCount},()=>({path:['demands'],kind:'array'}));let diagnostic;
  assert.equal(decodeCommerceSemanticWire(fixture,(_code,d)=>{diagnostic=d;}),null);
  assert.equal(diagnostic.stage,stage);assert.equal(diagnostic.node_count,count);
 }
});
test('v5 guidance includes a complete source-bound current-turn demand without merchant facts',()=>{
 const marker='no merchant facts are supplied: ';
 const example=JSON.parse(COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V5.slice(COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V5.indexOf(marker)+marker.length));
 assert(providerV5Accepts(example),JSON.stringify(providerV5Accepts.errors));
 // This retained fixture validates the historical V5 instruction/decoder pair;
 // the active provider instruction is separately verified for V6 below.
 const frame=canonical(example);assert(frame);
 assert.deepEqual(frame.demands,[demand({question:'What is the price of product Q9?',source_quote:'What is the price of product Q9?'})]);
 assert.deepEqual(frame.entities,[]);assert.deepEqual(frame.customer_facts,[]);
});
test('v5 malformed entity confidence: first-turn option lookup uses exact customer text, not entity state',()=>{
 const original='Hi，想換細房窗口冷氣，80呎又西斜，預算唔多，但驚買細咗唔夠凍。有冇慳電嘅變頻款可以睇？';
 const subscription='有冇啲適合小團隊嘅訂閱方案可以睇？';
 const fact='published merchant options matching customer criteria';
 assert.equal(sourceOwnedOptionWording(original),true);
 assert.equal(sourceOwnedOptionWording(subscription),true);
 for(const bad of ['0.95',null,false,{value:0.95}]){
  const w=v5({entities:[{name:'PRIVATE-UNBOUND-ENTITY',kind:'physical_product',confidence:bad}],
   demands:[demand({question:'PRIVATE-UNTRUSTED',source_quote:'PRIVATE-UNTRUSTED'})]},'ASK_FACT');
  let reason,diagnostic;
  assert.equal(decodeCommerceSemanticWire(w,(code,d)=>{reason=code;diagnostic=d;}),null);
  assert.equal(reason,'wire_context_nodes');
  assert.equal(diagnostic.field_class,'entity_confidence');
  assert.equal(diagnostic.reason,'type');
  for(const text of [original,subscription]){
   const recovered=recoverSourceOwnedOptionAfterEntityTypeFailure(w,text,diagnostic,sourceOwnedOptionWording(text),true);
   assert(recovered,JSON.stringify(diagnostic));
   assert.equal(recovered.operation,'ASK_FACT');
   assert.equal(recovered.entities.length,0);
   assert.equal(recovered.referents.length,0);
   assert.equal(recovered.customer_facts.length,0);
   assert.deepEqual(recovered.requested_facts,[fact]);
   assert.equal(recovered.demands.length,1);
   // The canonical semantic layer NFKC-normalizes punctuation while retaining
   // complete customer conditions; the original Visitor text remains persisted.
   const normalized=text.normalize("NFKC").trim();
   assert.equal(recovered.demands[0].source_quote,normalized);
   assert.equal(recovered.demands[0].question,normalized);
   assert.deepEqual(recovered.demands[0].subject_refs,[]);
   assert.deepEqual(recovered.demands[0].requested_facts,[fact]);
   assert.equal(recovered.demands[0].source_type,'product');
   assert(!JSON.stringify(recovered).includes('PRIVATE-'));
  }
  assert.equal(recoverSourceOwnedOptionAfterEntityTypeFailure(w,original,diagnostic,true,false),null);
  assert.equal(recoverSourceOwnedOptionAfterEntityTypeFailure(w,original,diagnostic,false,true),null);
  assert.equal(recoverSourceOwnedOptionAfterEntityTypeFailure({...w,operation:'UPDATE_ITEM'},original,diagnostic,true,true),null);
  for(const text of ['請取消訂單，有冇款可以睇？','請退款，有冇方案可以睇？',
     '有冇啲方案可以睇？另外幾錢？']){
   assert.equal(recoverSourceOwnedOptionAfterEntityTypeFailure(w,text,diagnostic,
     sourceOwnedOptionWording(text),true),null);
  }
 }
 const good=v5({entities:[{name:'specific named service',kind:'service',confidence:0.95}],demands:[demand()]},'ASK_FACT');
 assert(normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(good)));
 assert.equal(recoverSourceOwnedOptionAfterEntityTypeFailure(good,original,
   {container:'wire_nodes',stage:'canonical_vocabulary',node_count:3,field_class:'entity_confidence',reason:'range'},true,true),null);
});

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
const providerV3Accepts=new Ajv({strict:false}).compile(COMMERCE_SEMANTIC_PROVIDER_V3_SCHEMA);
test('v3 constrains native semantic types/enums with no optional or union grammar branches',()=>{
 const config=buildVertexGenerationConfig(4096,true,COMMERCE_SEMANTIC_PROVIDER_V3_SCHEMA,0,'gemini-2.5-flash');
 assert.deepEqual(config.responseSchema.properties.context_encoding.enum,['semantic_fields_v3']);
 assert(!('nodes' in config.responseSchema.properties));
 const inspect=s=>{assert(!s.anyOf);if(s.properties){assert.deepEqual(s.required,Object.keys(s.properties));assert.deepEqual(s.propertyOrdering,Object.keys(s.properties));Object.values(s.properties).forEach(inspect);}if(s.items)inspect(s.items);};
 inspect(config.responseSchema);
 for(const [collection,valueField] of [['containers','kind'],['strings','text'],['numbers','number'],['booleans','boolean']]){
  const item=config.responseSchema.properties[collection].items;
  assert.deepEqual(item.required,['path',valueField]);assert.equal(item.properties.path.minItems,'3');assert.equal(item.properties.path.maxItems,'6');
 }
 const d=vertexResponseSchemaDiagnostic(COMMERCE_SEMANTIC_PROVIDER_V3_SCHEMA);
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

// Same Task3C B-T01 repair. These independently authored fixtures exercise the
// provider/decoder contract, not a reconstructed historical model response or
// fresh Hosted business holdout. The unavailable B-T01 raw remains unavailable.
function v6(delta={},operation='ASK_FACT') {
 const {demands=[],...other}=delta;
 const list=[...nodes(other).filter(n=>n.path.length),
  ...demands.flatMap((d,index)=>nodes(d.constraints,['demands',String(index),'constraints']))];
 return {context_encoding:'semantic_demands_v6',operation,confidence:0.98,
  demands:demands.map(({constraints,...fixed})=>structuredClone(fixed)),
  containers:list.filter(n=>['object','array','null'].includes(n.kind)).map(({path,kind})=>({path,kind})),
  strings:list.filter(n=>n.kind==='string').map(({path,text})=>({path,text})),
  numbers:list.filter(n=>n.kind==='number').map(({path,number})=>({path,number})),
  booleans:list.filter(n=>n.kind==='boolean').map(({path,boolean})=>({path,boolean}))};
}
let acceptsV6;
function providerV6Accepts(value) {
 assert(COMMERCE_SEMANTIC_PROVIDER_V6_SCHEMA,'V6 schema export is required');
 acceptsV6??=new Ajv({strict:false}).compile(COMMERCE_SEMANTIC_PROVIDER_V6_SCHEMA);
 return acceptsV6(value);
}
const v6DemandFields=['question','source_quote','subject_refs','source_type','requested_facts',
 'customer_correction','explicit_negations','ambiguity'];
test('v6 active provider owns every fixed demand field while constraints retain typed native values',()=>{
 assert.notEqual(COMMERCE_SEMANTIC_PROVIDER_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_V6_SCHEMA);
 const config=buildVertexGenerationConfig(4096,true,COMMERCE_SEMANTIC_PROVIDER_V6_SCHEMA,0,'gemini-2.5-flash');
 assert.deepEqual(config.responseSchema.required,['context_encoding','operation','confidence','demands','containers','strings','numbers','booleans']);
 assert.deepEqual(config.responseSchema.properties.context_encoding.enum,['semantic_demands_v6']);
 const fixed=config.responseSchema.properties.demands.items;
 assert.deepEqual(fixed.required,v6DemandFields);
 assert.deepEqual(Object.keys(fixed.properties),v6DemandFields);
 assert.deepEqual(fixed.properties.source_type.enum,['product','policy','transaction','general','unknown']);
 assert.deepEqual(fixed.properties.ambiguity.required,['is_ambiguous','reasons','clarification_question']);
 assert(!Object.hasOwn(fixed.properties,'constraints'));
 const inspect=s=>{assert(!s.anyOf);if(s.properties){assert.deepEqual(s.required,Object.keys(s.properties));assert.deepEqual(s.propertyOrdering,Object.keys(s.properties));Object.values(s.properties).forEach(inspect);}if(s.items)inspect(s.items);};
 inspect(config.responseSchema);
 const diagnostic=vertexResponseSchemaDiagnostic(COMMERCE_SEMANTIC_PROVIDER_V6_SCHEMA);
 assert.equal(diagnostic.transport,'semantic_demands_v6');
 assert(diagnostic.schema_bytes<vertexResponseSchemaDiagnostic(COMMERCE_SEMANTIC_PROVIDER_V3_SCHEMA).schema_bytes);
 assert(!/anyOf|additionalProperties|delta_json|value_json/.test(JSON.stringify(config.responseSchema)));
 assert.equal(config.thinkingConfig.thinkingBudget,0);
 // Grammar structure alone is not evidence of real provider acceptance.
 const raw=v6({demands:[demand({constraints:{budget:{amount:0,currency:null},renewal:false,excluded:[]}})]});
 assert(providerV6Accepts(raw));assert(canonical(raw));
});
test('v6 prompt and active schema describe one transport without a second native demand vocabulary',()=>{
 assert(!COMMERCE_SEMANTIC_SYSTEM_PROMPT.includes(COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V6));assert(COMMERCE_SEMANTIC_SYSTEM_PROMPT.includes(COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V7));
 assert(!COMMERCE_SEMANTIC_SYSTEM_PROMPT.includes(COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V5));
 assert(!COMMERCE_SEMANTIC_SYSTEM_PROMPT.includes('semantic_values_v4'));
 assert(!COMMERCE_SEMANTIC_SYSTEM_PROMPT.includes('Declare exactly one object root at path []'));
 assert(COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V6.includes('semantic_demands_v6'));
 assert(COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V6.includes('constraints'));
});
for(const [business,delta] of [
 ['Cantonese option requirements',{language:'zh-HK',intent:'product_information',
  demands:[demand({question:'有冇慳電嘅變頻窗口款可以睇？',source_quote:'80呎又西斜，預算唔多',subject_refs:[],
   requested_facts:['published inverter window options'],constraints:{room:{area:80,unit:'sq_ft'},west_facing:true,budget:'limited'}})]}],
 ['simplified subscription correction',{language:'zh-CN',intent:'product_information',customer_correction:true,
  entities:[{name:'团队标准方案',kind:'subscription',confidence:0.96,constraints:{seats:6,auto_renew:false}}],
  demands:[demand({question:'团队标准方案有哪些功能？',source_quote:'其实只需六个席位，不要自动续订',subject_refs:['团队标准方案'],
   requested_facts:['features'],customer_correction:true,explicit_negations:['不要自动续订'],constraints:{seats:6,auto_renew:false,deferred_add_ons:['analytics']}})]}],
 ['traditional service and rental constraints',{language:'zh-TW',intent:'merchant_policy',
  demands:[demand({question:'租用望遠鏡兩天的歸還規則？',source_quote:'租用兩天，先不預約配送',subject_refs:['望遠鏡'],
   source_type:'policy',requested_facts:['rental return rules'],explicit_negations:['先不預約配送'],
   constraints:{duration:{amount:2,unit:'days'},delivery:false,return_date:null,access:[]}})]}],
 ['English mixed transaction and merchant policy',{language:'en',intent:'order_and_policy',
  demands:[demand({question:'Where is my order 12354?',source_quote:'Where is my order 12354?',subject_refs:['12354'],
   source_type:'transaction',requested_facts:['delivery_progress'],constraints:{}}),
   demand({question:'What are your return rules for Q9?',source_quote:'What are your return rules for Q9?',subject_refs:['Q9'],
    source_type:'policy',requested_facts:['return_policy'],constraints:{opened:false}}),
   demand({question:'How should I compare return options?',source_quote:'How should I compare return options?',subject_refs:[],
    source_type:'general',requested_facts:['general tradeoffs'],constraints:{}})]}],
 ['code-switch multiple entities and unanswered clause',{language:'zh-HK',customer_correction:true,
  entities:[{name:'Atlas plan',kind:'subscription',confidence:0.94,constraints:{users:6}},{name:'Orion cover',kind:'service',confidence:0.96,constraints:{users:0}}],
  demands:[demand({question:'Atlas plan for six users, no add-on?',source_quote:'Atlas plan 改六個人，no add-on',subject_refs:['Atlas plan'],
   requested_facts:['subscription features'],constraints:{users:6,add_ons:[]},customer_correction:true,explicit_negations:['no add-on']}),
   demand({question:'Orion cover applies to which location?',source_quote:'Orion cover 嗰邊點？',subject_refs:['Orion cover'],
    requested_facts:['service eligibility'],constraints:{users:0,date:null},
    ambiguity:{is_ambiguous:true,reasons:['location_not_supplied'],clarification_question:'Which service location?'}})]}],
])test('v6 preserves complete independent semantics without defaults or lost clauses: '+business,()=>{
 const input=v6(delta,'UPDATE_ITEM');
 assert(providerV6Accepts(input));
 const actual=canonical(input),expected=normalizeCommerceSemanticFrame({operation:'UPDATE_ITEM',confidence:0.98,...delta});
 assert(actual);assert(expected);assert.deepEqual(actual,expected);
 assert.equal(actual.demands.length,delta.demands.length);
 assert.deepEqual(canonical({...input,containers:input.containers.toReversed(),strings:input.strings.toReversed(),
  numbers:input.numbers.toReversed(),booleans:input.booleans.toReversed()}),actual,'context graph ordering cannot change meaning');
});
for(const field of v6DemandFields)test('v6 missing native demand field cannot be guessed: '+field,()=>{
 const raw=v6({demands:[demand()]});delete raw.demands[0][field];
 assert.equal(providerV6Accepts(raw),false);
 assert.equal(canonical(raw),null);
});
for(const [label,mutate] of [
 ['native demand is a string',w=>w.demands[0]='PRIVATE-JSON-IN-STRING'],
 ['native demands absent',w=>delete w.demands],
 ['native demands wrong type',w=>w.demands={}],
 ['numeric question',w=>w.demands[0].question=17],
 ['boolean source quote',w=>w.demands[0].source_quote=false],
 ['numeric subject reference',w=>w.demands[0].subject_refs=[17]],
 ['unknown source type',w=>w.demands[0].source_type='PRIVATE-ROUTE'],
 ['numeric requested fact',w=>w.demands[0].requested_facts=[17]],
 ['string correction flag',w=>w.demands[0].customer_correction='false'],
 ['boolean explicit negation',w=>w.demands[0].explicit_negations=[false]],
 ['nonobject ambiguity',w=>w.demands[0].ambiguity=false],
 ['string ambiguity flag',w=>w.demands[0].ambiguity.is_ambiguous='false'],
 ['numeric ambiguity reason',w=>w.demands[0].ambiguity.reasons=[17]],
 ['numeric clarification question',w=>w.demands[0].ambiguity.clarification_question=17],
])test('v6 typed demand producer and strict decoder reject without coercion: '+label,()=>{
 const raw=v6({demands:[demand()]});mutate(raw);
 assert.equal(providerV6Accepts(raw),false);
 let diagnostic;assert.equal(decodeCommerceSemanticWire(raw,(_code,d)=>{diagnostic=d;}),null);
 assert(!JSON.stringify(diagnostic??{}).includes('PRIVATE-'));
});
for(const [label,mutate] of [
 ['unknown direct demand field',w=>w.demands[0].PRIVATE_EXTRA='PRIVATE-VALUE'],
 ['invented message provenance',w=>w.demands[0].source_message_id='PRIVATE-SOURCE-ID'],
 ['question alias',w=>w.demands[0].query='PRIVATE-VALUE'],
 ['unknown ambiguity field',w=>w.demands[0].ambiguity.PRIVATE_EXTRA='PRIVATE-VALUE'],
 ['direct native constraints',w=>w.demands[0].constraints={PRIVATE_DYNAMIC:'PRIVATE-VALUE'}],
 ['unknown envelope field',w=>w.PRIVATE_EXTRA='PRIVATE-VALUE'],
])test('v6 rejects unknown fixed keys rather than stripping them: '+label,()=>{
 const raw=v6({demands:[demand()]});mutate(raw);
 let diagnostic;assert.equal(decodeCommerceSemanticWire(raw,(code,d)=>{assert.equal(code,'wire_context_nodes');diagnostic=d;}),null);
 assert(diagnostic);assert(!JSON.stringify(diagnostic).includes('PRIVATE'));
 assert.equal(recoverSourceOwnedOptionAfterEntityTypeFailure(raw,'有冇啲適合小團隊嘅訂閱方案可以睇？',diagnostic,true,true),null);
});
for(const [label,mutate] of [
 ['native demands list overwrite',w=>w.containers.push({path:['demands'],kind:'array'})],
 ['native demand object overwrite',w=>w.containers.push({path:['demands','0'],kind:'object'})],
 ['native question overwrite',w=>w.strings.push({path:['demands','0','question'],text:'PRIVATE-OVERRIDE'})],
 ['native source quote overwrite',w=>w.strings.push({path:['demands','0','source_quote'],text:'PRIVATE-OVERRIDE'})],
 ['native source type overwrite',w=>w.strings.push({path:['demands','0','source_type'],text:'general'})],
 ['native correction overwrite',w=>w.booleans.push({path:['demands','0','customer_correction'],boolean:true})],
 ['native requested fact overwrite',w=>w.strings.push({path:['demands','0','requested_facts','0'],text:'PRIVATE-OVERRIDE'})],
 ['native ambiguity overwrite',w=>w.booleans.push({path:['demands','0','ambiguity','is_ambiguous'],boolean:true})],
 ['undeclared demand',w=>w.containers.push({path:['demands','1','constraints'],kind:'object'})],
 ['noncanonical demand index',w=>w.containers[0].path[1]='00'],
 ['huge demand index',w=>w.containers[0].path[1]='999999999'],
 ['missing constraints root',w=>w.containers=[]],
 ['constraints root null',w=>w.containers[0].kind='null'],
 ['constraints root array',w=>w.containers[0].kind='array'],
 ['constraints root string',w=>{w.containers=[];w.strings.push({path:['demands','0','constraints'],text:'{}'});}],
 ['duplicate constraints root',w=>w.containers.push({...w.containers[0]})],
 ['cross-collection duplicate context leaf',w=>{w.numbers.push({path:['demands','0','constraints','users'],number:0});w.booleans.push({path:['demands','0','constraints','users'],boolean:false});}],
 ['missing nested context parent',w=>w.strings.push({path:['demands','0','constraints','location','area'],text:'PRIVATE-VALUE'})],
 ['sparse context array',w=>{w.containers.push({path:['demands','0','constraints','excluded'],kind:'array'});w.strings.push({path:['demands','0','constraints','excluded','1'],text:'PRIVATE-VALUE'});}],
 ['prototype context path',w=>w.strings.push({path:['demands','0','constraints','constructor'],text:'PRIVATE-VALUE'})],
 ['frame root injection',w=>w.containers.push({path:[],kind:'object'})],
 ['inactive scalar slot',w=>w.containers[0].text='PRIVATE-VALUE'],
])test('v6 fences dynamic context from native demand authority and rejects damaged graphs: '+label,()=>{
 const raw=v6({demands:[demand()]});mutate(raw);
 let diagnostic;assert.equal(decodeCommerceSemanticWire(raw,(code,d)=>{assert.equal(code,'wire_context_nodes');diagnostic=d;}),null);
 assert(diagnostic);assert(!JSON.stringify(diagnostic).includes('PRIVATE'));
 assert.equal(recoverSourceOwnedOptionAfterEntityTypeFailure(raw,'有冇啲適合小團隊嘅訂閱方案可以睇？',diagnostic,true,true),null);
});
for(const [label,delta] of [
 ['13 demands',{demands:Array.from({length:13},()=>demand())}],
 ['empty source quote',{demands:[demand({source_quote:'  '})]}],
 ['oversized source quote',{demands:[demand({source_quote:'x'.repeat(1601)})]}],
 ['NFKC-expanded quote',{demands:[demand({source_quote:'㍿'.repeat(401)})]}],
 ['13 subject references',{demands:[demand({subject_refs:Array.from({length:13},(_,i)=>'Q'+i)})]}],
 ['21 requested facts',{demands:[demand({requested_facts:Array(21).fill('feature')})]}],
 ['21 explicit negations',{demands:[demand({explicit_negations:Array(21).fill('no extra')})]}],
 ['13 ambiguity reasons',{demands:[demand({ambiguity:{is_ambiguous:true,reasons:Array(13).fill('missing'),clarification_question:null}})]}],
 ['oversized dynamic text',{demands:[demand({constraints:{description:'x'.repeat(301)}})]}],
 ['excess dynamic depth',{demands:[demand({constraints:{one:{two:{three:{value:0}}}}})]}],
 ['41 dynamic fields',{demands:[demand({constraints:Object.fromEntries(Array.from({length:41},(_,i)=>['key'+i,i]))})]}],
 ['13 dynamic array items',{demands:[demand({constraints:{excluded:Array(13).fill(false)}})]}],
 ['first malformed clause cannot disappear beside a valid clause',{demands:[demand({source_quote:''}),demand({question:'What is the return policy?',source_type:'policy'})]}],
])test('v6 retains canonical bounds and rejects the complete proposal without truncation: '+label,()=>{
 assert.equal(canonical(v6(delta)),null);
});
test('v6 keeps numeric entity confidence strict and the prior source-owned recovery narrowly bounded',()=>{
 const latest='有冇啲適合小團隊嘅訂閱方案可以睇？';
 for(const confidence of ['0.95',null,false,{value:0.95}]){
  const raw=v6({entities:[{name:'PRIVATE-UNBOUND',kind:'subscription',confidence}],
   demands:[demand({question:latest,source_quote:latest,subject_refs:[],requested_facts:['published options'],constraints:{}})]});
  let diagnostic;assert.equal(decodeCommerceSemanticWire(raw,(_code,d)=>{diagnostic=d;}),null);
  assert.equal(diagnostic.field_class,'entity_confidence');assert.equal(diagnostic.reason,'type');
  const recovered=recoverSourceOwnedOptionAfterEntityTypeFailure(raw,latest,diagnostic,true,true);
  assert(recovered);assert.equal(recovered.entities.length,0);assert.equal(recovered.customer_facts.length,0);
  assert.equal(recovered.demands.length,1);assert.equal(recovered.demands[0].source_quote,latest.normalize('NFKC'));
  assert(!JSON.stringify(recovered).includes('PRIVATE-'));
  assert.equal(recoverSourceOwnedOptionAfterEntityTypeFailure(raw,latest,diagnostic,true,false),null);
  assert.equal(recoverSourceOwnedOptionAfterEntityTypeFailure({...raw,operation:'CANCEL_ITEM'},latest,diagnostic,true,true),null);
 }
 const raw=v6({entities:[{name:'Atlas plan',kind:'subscription',confidence:0.95}],demands:[demand()]});
 assert.equal(canonical(raw).entities[0].confidence,0.95);
});
test('v6 demand source identity stays server bound and unquoted clauses never enter the KB projection',()=>{
 const latest='What is the current price of Q9?';
 const valid=demand({question:latest,source_quote:latest});
 const good=canonical(v6({demands:[valid]}));assert(good);
 const request=resolveCurrentFactualRequest({question:latest,source_message_id:'test-current-visitor',semantic:good});
 assert.equal(request.source_message_id,'test-current-visitor');
 assert.equal(request.demands[0].source_quote,latest);
 assert.deepEqual(request.demands[0].subject_source_message_ids,['test-current-visitor']);
 const invalid=demand({question:'PRIVATE-UNBOUND requested price',source_quote:'PRIVATE-UNBOUND customer source',subject_refs:['PRIVATE-UNBOUND']});
 const mixed=canonical(v6({demands:[valid,invalid]}));assert(mixed);
 const filtered=resolveCurrentFactualRequest({question:latest,source_message_id:'test-current-visitor',semantic:mixed});
 assert.equal(filtered.demands.length,2,'the failed clause remains visible as unresolved');
 assert(filtered.missing_evidence.some(item=>item.reason==='source_quote_unbound'));
 assert(!String(filtered.query).includes('PRIVATE-UNBOUND'));
 assert(String(filtered.query).includes('Q9'));
});

// Exercise the actual interpreter and actual SHA-256 helper. Only the provider
// boundary is replaced; a test cannot dispatch a model, database or KB request.
let diagnosticInterpreterPromise;
const diagnosticInterpreter=()=>diagnosticInterpreterPromise??=(async()=>{
 const built=await build({stdin:{contents:"export * from './supabase/functions/_shared/commerce-semantic-interpreter.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'isolated-diagnostic-provider',setup(b){
  b.onResolve({filter:/^\.\/llm-router\.ts$/},()=>({path:'isolated-diagnostic-model',namespace:'provider'}));
  b.onLoad({filter:/.*/,namespace:'provider'},()=>({contents:"export const callModel=(...args)=>{if(typeof globalThis.__semanticTransportModel!=='function')throw new Error('provider dispatch forbidden in semantic transport tests');return globalThis.__semanticTransportModel(...args);};"}));
 }}]});
 return import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
})();
function assertDiagnosticReceipt(receipt,body,origin,state){
 assert.deepEqual(receipt,{capture_origin:origin,capture_state:state,
  sha256:createHash('sha256').update(body,'utf8').digest('hex'),
  bytes:Buffer.byteLength(body,'utf8'),body:state==='CAPTURED'?body:null});
}
test('semantic failure capture retains the complete original UTF8 bytes and hash without normalizing the body',async()=>{
 const {captureSemanticDiagnosticText}=await diagnosticInterpreter();
 assert.equal(typeof captureSemanticDiagnosticText,'function');
 const raw='  香港 Q9\n🙂 e\u0301 ㍿\r\n"quoted"\t80 / 100 / 180 sq ft; false, 0, null, [], {}  ';
 for(const origin of ['SEMANTIC_ROUTER_INPUT','SEMANTIC_MODEL_TEXT']){
  assertDiagnosticReceipt(await captureSemanticDiagnosticText(raw,origin),raw,origin,'CAPTURED');
  assertDiagnosticReceipt(await captureSemanticDiagnosticText('',origin),'',origin,'CAPTURED');
 }
});
test('semantic failure capture counts UTF8 bytes at the exact bound and withholds the whole oversized body',async()=>{
 const {captureSemanticDiagnosticText}=await diagnosticInterpreter();
 const exact='資'.repeat(21_845)+'x';
 assert.equal(Buffer.byteLength(exact,'utf8'),65_536);assert(exact.length<65_536);
 assertDiagnosticReceipt(await captureSemanticDiagnosticText(exact,'SEMANTIC_MODEL_TEXT'),exact,'SEMANTIC_MODEL_TEXT','CAPTURED');
 for(const raw of [exact+'y','🙂'.repeat(16_385),'x'.repeat(65_537)]){
  const receipt=await captureSemanticDiagnosticText(raw,'SEMANTIC_MODEL_TEXT');
  assertDiagnosticReceipt(receipt,raw,'SEMANTIC_MODEL_TEXT','WITHHELD_OVERSIZED');
  assert.equal(receipt.body,null,'a prefix must not masquerade as a complete model response');
  assert(!JSON.stringify(receipt).includes(raw.slice(0,64)));
 }
});
for(const [label,raw] of [
 ['email','Please send to synthetic.person@example.invalid'],
 ['international HK phone','The callback number is +852 6123 4567.'],
 ['local HK phone','The callback number is 91234567.'],
 ['HK landline','The contact number is +852 2123 4567.'],
 ['US international phone','The contact number is +1 202 555 0123.'],
 ['UK international phone','The contact number is +44 20 7946 0958.'],
 ['Bearer credential','Authorization: Bearer synthetic-token-for-test-only'],
 ['JWT-shaped credential','eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.dGVzdA'],
 ['private key block','-----BEGIN PRIVATE KEY-----\nsynthetic-test-only\n-----END PRIVATE KEY-----'],
 ['API credential prefix','sk-syntheticCredentialForTestOnly'],
 ['provider credential prefix','AIzaSyntheticCredentialForTestsOnly'],
 ['password literal',JSON.stringify({password:'synthetic-opaque-test-value'})],
 ['client secret literal',JSON.stringify({client_secret:'synthetic-opaque-test-value'})],
 ['secret-bearing typed path',JSON.stringify(v6({demands:[demand({constraints:{api_key:'synthetic-opaque-test-value'}})]}))],
])test('semantic failure capture withholds the entire sensitive body: '+label,async()=>{
 const {captureSemanticDiagnosticText}=await diagnosticInterpreter();
 for(const origin of ['SEMANTIC_ROUTER_INPUT','SEMANTIC_MODEL_TEXT']){
  const receipt=await captureSemanticDiagnosticText(raw,origin);
  assertDiagnosticReceipt(receipt,raw,origin,'WITHHELD_SENSITIVE');
  assert.equal(receipt.body,null);assert(!JSON.stringify(receipt).includes(raw));
 }
});

const diagnosticLatest='What is the current price of Q9?';
const diagnosticInput=(latest=diagnosticLatest)=>({company_id:'isolated-company',conversation_id:'isolated-ticket',
 source_message_id:'isolated-current-visitor',latest,persistent_state_summary:'{}'});
function rejectedDemandResponse(latest=diagnosticLatest){
 const response=v6({demands:[demand({question:latest,source_quote:latest})]});
 response.demands[0].PRIVATE_UNKNOWN_FIELD='PRIVATE-CONTRACT-MARKER';
 return JSON.stringify(response);
}
function expectedDiagnosticRequest(request){
 return JSON.stringify({purpose:request.purpose,tag:request.tag,system:request.system,user:request.user,response_format:request.responseFormat,
  response_schema:request.responseSchema,max_tokens:request.maxTokens,
  max_provider_attempts:request.maxProviderAttempts,thinking_budget:request.thinkingBudget});
}
for(const [label,raw,stage,outcome] of [
 ['malformed JSON','{"PRIVATE-CONTRACT-MARKER":','semantic_json','NOT_RUN'],
 ['unknown direct demand field',rejectedDemandResponse(),'semantic_contract','NOT_APPLICABLE'],
 ['unbound customer quotation',JSON.stringify(v6({demands:[demand({question:diagnosticLatest,source_quote:'PRIVATE-CONTRACT-MARKER'})]})),'semantic_source_binding','NOT_RUN'],
])test('semantic failure evidence binds exact request and response with fixed recovery outcomes: '+label,async()=>{
 const {interpretCommerceSemantics}=await diagnosticInterpreter();
 const previous=globalThis.__semanticTransportModel;
 let calls=0,request;
 globalThis.__semanticTransportModel=async input=>{calls++;request=input;return {ok:true,request_id:'isolated-router-request',text:raw};};
 try {
  const result=await interpretCommerceSemantics(diagnosticInput());
  assert.equal(calls,1);assert.equal(request.maxProviderAttempts,1);
  assert.equal(request.operationId,'commerce-semantic:isolated-current-visitor');
  assert.equal(result.frame,null);assert.equal(result.failure_code,'LLM_INVALID_OUTPUT');assert.equal(result.failure_stage,stage);
  const {failure_evidence:evidence,...publicResult}=result;
  assert.equal(evidence.contract,'c3-semantic-failure-evidence-v1');
  assert.equal(evidence.source_message_id,'isolated-current-visitor');assert.equal(evidence.request_id,'isolated-router-request');
  assert.deepEqual(evidence.recovery_outcomes,{source_quoted_read_only:outcome,source_owned_option:outcome,missing_demand_option:outcome});
  assertDiagnosticReceipt(evidence.request,expectedDiagnosticRequest(request),'SEMANTIC_ROUTER_INPUT','CAPTURED');
  assertDiagnosticReceipt(evidence.response,raw,'SEMANTIC_MODEL_TEXT','CAPTURED');
  const snapshot=JSON.parse(evidence.request.body);
  assert.equal(snapshot.system,COMMERCE_SEMANTIC_SYSTEM_PROMPT);assert.deepEqual(snapshot.response_schema,COMMERCE_SEMANTIC_PROVIDER_SCHEMA);
  assert(snapshot.user.includes(diagnosticLatest));assert(!JSON.stringify(publicResult).includes('PRIVATE-CONTRACT-MARKER'));
 }finally{previous===undefined?delete globalThis.__semanticTransportModel:globalThis.__semanticTransportModel=previous;}
});
test('semantic failure evidence withholds the full router input for sensitive customer text while retaining exact hash and source',async()=>{
 const {interpretCommerceSemantics}=await diagnosticInterpreter();
 const latest=diagnosticLatest+' Contact synthetic.person@example.invalid';
 const raw=rejectedDemandResponse();
 const previous=globalThis.__semanticTransportModel;let request,calls=0;
 globalThis.__semanticTransportModel=async input=>{calls++;request=input;return {ok:true,request_id:'isolated-sensitive-request',text:raw};};
 try{
  const result=await interpretCommerceSemantics(diagnosticInput(latest));assert.equal(calls,1);
  const {failure_evidence:evidence,...publicResult}=result;
  assert.equal(evidence.source_message_id,'isolated-current-visitor');assert.equal(evidence.request_id,'isolated-sensitive-request');
  assertDiagnosticReceipt(evidence.request,expectedDiagnosticRequest(request),'SEMANTIC_ROUTER_INPUT','WITHHELD_SENSITIVE');
  assertDiagnosticReceipt(evidence.response,raw,'SEMANTIC_MODEL_TEXT','CAPTURED');
  assert(!JSON.stringify(result).includes('synthetic.person@example.invalid'));
  assert(!JSON.stringify(publicResult).includes('PRIVATE-CONTRACT-MARKER'));
 }finally{previous===undefined?delete globalThis.__semanticTransportModel:globalThis.__semanticTransportModel=previous;}
});
test('semantic failure evidence does not attach input or model bodies to a successful semantic result',async()=>{
 const {interpretCommerceSemantics}=await diagnosticInterpreter();
 const previous=globalThis.__semanticTransportModel;let calls=0;
 const raw=JSON.stringify(v6({demands:[demand({question:diagnosticLatest,source_quote:diagnosticLatest})]}));
 globalThis.__semanticTransportModel=async()=>{calls++;return {ok:true,request_id:'isolated-valid-request',text:raw};};
 try{
  const result=await interpretCommerceSemantics(diagnosticInput());assert.equal(calls,1);
  assert.equal(result.failure_code,null);assert(result.frame);assert(!Object.hasOwn(result,'failure_evidence'));
 }finally{previous===undefined?delete globalThis.__semanticTransportModel:globalThis.__semanticTransportModel=previous;}
});


// Same P0-1 B-T02: real V7 module schema and decoder; no new model/KB calls.
// Prior V6 missing-root FAIL remains a negative, not an accepted repair.
function v7(delta={},operation='ASK_FACT'){
 const {demands=[],...rest}=delta;
 const local=ctx=>{const ns=nodes(ctx).filter(x=>x.path.length);return {
  containers:ns.filter(x=>['object','array','null'].includes(x.kind)).map(({path,kind})=>({path,kind})),
  strings:ns.filter(x=>x.kind==='string').map(({path,text})=>({path,text})),
  numbers:ns.filter(x=>x.kind==='number').map(({path,number})=>({path,number})),
  booleans:ns.filter(x=>x.kind==='boolean').map(({path,boolean})=>({path,boolean}))}};
 return {context_encoding:'semantic_demands_v7',operation,confidence:.98,
  demands:demands.map(({constraints,...fixed})=>({...structuredClone(fixed),constraints:local(constraints)})),
  ...local(rest)};
}
const acceptsV7=new Ajv({strict:false}).compile(COMMERCE_SEMANTIC_PROVIDER_V7_SCHEMA);
test('v7 active provider has explicit required constraints owned by each demand',()=>{
 assert.equal(COMMERCE_SEMANTIC_PROVIDER_SCHEMA,COMMERCE_SEMANTIC_PROVIDER_V7_SCHEMA);
 const s=buildVertexGenerationConfig(4096,true,COMMERCE_SEMANTIC_PROVIDER_SCHEMA,0,'gemini-2.5-flash').responseSchema;
 assert.deepEqual(s.properties.context_encoding.enum,['semantic_demands_v7']);
 assert.deepEqual(s.properties.demands.items.required,[...v6DemandFields,'constraints']);
 assert.deepEqual(s.properties.demands.items.properties.constraints.required,['containers','strings','numbers','booleans']);
 assert.equal(vertexResponseSchemaDiagnostic(COMMERCE_SEMANTIC_PROVIDER_SCHEMA).transport,'semantic_demands_v7');
});
for(const n of [0,1,2,12])test('v7 '+n+' demands preserve explicit empty contexts, not omitted fields',()=>{
 const w=v7({demands:Array.from({length:n},()=>demand())});assert(acceptsV7(w),JSON.stringify(acceptsV7.errors));
 const result=canonical(w);assert(result);assert.equal(result.demands.length,n);
 result.demands.forEach(x=>assert.deepEqual(x.constraints,{}));
 if(n){const bad=structuredClone(w);delete bad.demands[0].constraints;assert(!acceptsV7(bad));assert.equal(canonical(bad),null);
 const bad2=structuredClone(w);delete bad2.demands[0].constraints.containers;assert(!acceptsV7(bad2));assert.equal(canonical(bad2),null);}
});
test('v7 independent product/general/transaction constraints, booleans, zero, null',()=>{
 const w=v7({customer_correction:true,explicit_negations:['not paid'],demands:[
  demand({question:'Which plan?',source_quote:'Which plan?',constraints:{seats:0,auto_renew:false,area:{amount:80,unit:'sq_ft'},exclusions:[],date:null}}),
  demand({question:'What should I consider?',source_quote:'consider?',source_type:'general',constraints:{guests:2}}),
  demand({question:'Where is my order?',source_quote:'my order?',source_type:'transaction',constraints:{}})]});
 assert(acceptsV7(w));const f=canonical(w);assert(f);assert.equal(f.demands.length,3);
 assert.deepEqual(f.demands[0].constraints,{area:{amount:80,unit:'sq_ft'},auto_renew:false,date:null,exclusions:[],seats:0});
 assert.deepEqual(f.demands[1].constraints,{guests:2});assert.deepEqual(f.demands[2].constraints,{});
 assert.deepEqual(f.explicit_negations,['not paid']);
});
test('v7 rejects cross-demand path injection and corrupt/duplicated/local roots',()=>{
 const w=v7({demands:[demand(),demand({source_type:'general',constraints:{team:5}})]});
 for(const apply of [
  x=>x.containers.push({path:['demands'],kind:'array'}),
  x=>x.demands[0].constraints.containers.push({path:[],kind:'object'}),
  x=>x.demands[0].constraints.strings.push({path:['missing','child'],text:'forged'}),
  x=>x.demands[0].constraints.containers.push({path:['__proto__'],kind:'object'}),
  x=>x.demands[0].constraints.containers.push({path:['a'],kind:'object'},{path:['a'],kind:'object'}),
  x=>x.demands[0].constraints.injected=true,
  x=>x.demands[1].constraints.numbers.push({path:['team'],number:5})
 ]){const bad=structuredClone(w);apply(bad);assert.equal(canonical(bad),null);}
});
test('historical V6 B-T02 two-demand missing constraints roots remains FAIL',()=>{
 const w=v6({demands:[demand(),demand({source_type:'general'})]});w.containers=[];
 let diagnostic;assert.equal(decodeCommerceSemanticWire(w,(_,d)=>{diagnostic=d}),null);
 assert.equal(diagnostic.field_class,'demand_constraints');assert.equal(diagnostic.reason,'required');
 assert.equal(canonical({...w,context_encoding:'semantic_demands_v7'}),null);
});
