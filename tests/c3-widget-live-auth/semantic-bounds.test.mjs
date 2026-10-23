import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {build} from 'esbuild';
const out=await build({stdin:{contents:`export * from './supabase/functions/_shared/commerce-semantic-frame.ts'; export * from './supabase/functions/_shared/bounded-decision-context.ts';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {COMMERCE_SEMANTIC_NATIVE_SCHEMA,COMMERCE_SEMANTIC_TYPED_SCHEMA,normalizeCommerceSemanticFrame,decodeCommerceSemanticWire,normalizeDecisionContext}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const validate=new Ajv({strict:false}).compile(COMMERCE_SEMANTIC_NATIVE_SCHEMA);
const entity=(attributes={},constraints={})=>({name:'requested service',kind:'service',confidence:0.97,attributes,constraints});
const frame=e=>({operation:'UPDATE_ITEM',confidence:0.97,entities:[e]});

for(const [code,value,actual,limit] of [
 ['depth',{measurement:{wrapper:{amount:{value:80}}}},4,3],
 ['fields',Object.fromEntries(Array.from({length:41},(_,i)=>['field'+i,i])),41,40],
 ['items',{dimensions:Array(13).fill(0)},13,12],
 ['leaves',Object.fromEntries(Array.from({length:9},(_,i)=>['group'+i,Array(12).fill(false)])),97,96],
 ['text_length',{requirement:'x'.repeat(301)},301,300],
 ['key_length',{['k'.repeat(81)]:0},81,80],
]) for(const container of ['attributes','constraints']) test(`semantic ${container}: ${code} rejects with safe actual/limit; no partial business state`,()=>{
 let reason,diagnostic;const proposal=frame(entity());proposal.entities[0][container]=value;
 assert.equal(normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(proposal),(r,d)=>{reason=r;diagnostic=d;}),null);
 assert.equal(reason,'canonical_entity_bounds');
 assert.equal(diagnostic.container,container);assert.equal(diagnostic.entity_index,0);
 assert.equal(diagnostic.violation.code,code);assert.equal(diagnostic.violation.actual,actual);assert.equal(diagnostic.violation.limit,limit);
 assert.deepEqual(Object.keys(diagnostic.violation).sort(),['actual','code','data_type','depth','limit']);
 assert(!JSON.stringify(diagnostic).includes('requirement'));assert(!JSON.stringify(diagnostic).includes('measurement'));
 if(code!=='leaves')assert.equal(validate(proposal),false,'producer grammar advertised a value canonical rejects');
});

test('background measurements use native named facts; legal multientity frames preserve false/zero/null/units and correction',()=>{
 // These are deterministic legal encodings of the observed 80/100/180 turn,
 // not a claim that an unretained failed provider payload was reproduced.
 const p={operation:'UPDATE_ITEM',confidence:0.98,customer_correction:true,
  customer_facts:[['small_room',80],['large_room',100],['living_room',180]].map(([key,amount])=>({key,value:{amount,unit:'sq_ft'}})),
  explicit_negations:['no afternoon sun'],entities:[
   {...entity({sun_exposure:false},{deposit:0,date:null}),name:'studio rental',kind:'rental'},
   {...entity({seats:0},{renewal:false,term:{amount:12,unit:'months'}}),name:'support subscription',kind:'subscription'},
   {...entity({opening:{width:70,height:55,unit:'cm'}},{room:null}),name:'installation service',kind:'service'}]};
 assert(validate(p),JSON.stringify(validate.errors));
 const result=normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(p));assert(result);
 assert.equal(result.customer_correction,true);assert.deepEqual(result.customer_facts,p.customer_facts);
 assert.equal(result.entities[0].attributes.sun_exposure,false);assert.equal(result.entities[0].constraints.deposit,0);assert.equal(result.entities[0].constraints.date,null);
 assert.equal(result.entities[2].attributes.opening.unit,'cm');assert.equal(result.entities[2].constraints.room,null);
});

test('bounded limits keep exact legal edge values, no text truncation or scalar deletion',()=>{
 const v={text:'x'.repeat(300),zero:0,no:false,unknown:null,measurement:{amount:80,unit:'sq_ft'},values:Array(12).fill(0)};
 assert.deepEqual(normalizeDecisionContext(v),v);assert(validate(frame(entity(v))));assert(normalizeCommerceSemanticFrame(frame(entity(v))));
});

test('diagnostics cannot leak customer values, secrets, field names or an unredacted provider object',()=>{
 const raw={private_customer_key:'Bearer '+('s'.repeat(400))};let diagnostic;
 normalizeCommerceSemanticFrame(frame(entity({},raw)),(_,d)=>{diagnostic=d;});
 assert.equal(diagnostic.container,'constraints');assert.equal(diagnostic.violation.code,'text_length');
 assert(!JSON.stringify(diagnostic).includes('private_customer_key'));assert(!JSON.stringify(diagnostic).includes('Bearer'));assert(!JSON.stringify(diagnostic).includes('ssss'));
});

test('actual interpreter carries safe canonical bounds diagnostics, preserves native facts, and never retries rejected output',async()=>{
 const compiled=await build({stdin:{contents:`export {interpretCommerceSemantics} from './supabase/functions/_shared/commerce-semantic-interpreter.ts';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'isolated-semantic-provider-only',setup(b){b.onResolve({filter:/^\.\/llm-router\.ts$/},()=>({path:'isolated-call-model',namespace:'provider'}));b.onLoad({filter:/.*/,namespace:'provider'},()=>({contents:'export const callModel = (...args) => globalThis.__semanticBoundsModel(...args);'}));}}]});
 const {interpretCommerceSemantics}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
 const previous=globalThis.__semanticBoundsModel;
 try {
  for(const latest of ['細房約80呎，大房100呎，客廳就180呎。','小房约80平方英尺，大房100，客厅180。','The small room is 80 sq ft, the larger room 100, and the lounge 180.']) {
   let calls=0;
   globalThis.__semanticBoundsModel=async input=>{calls++;assert(input.system.includes('80 characters per key'));assert(input.system.includes('96 scalar leaves'));assert.equal(input.responseFormat,'json');assert.deepEqual(input.responseSchema,COMMERCE_SEMANTIC_TYPED_SCHEMA);
    return {ok:true,request_id:'isolated-source',text:JSON.stringify(frame(entity({rooms:{one:{measurement:{amount:80}}}})))};};
   const input={company_id:'isolated-company',conversation_id:'isolated-conversation',source_message_id:'isolated-source',latest,persistent_state_summary:'{}'};
   const rejected=await interpretCommerceSemantics(input);assert.equal(calls,1);assert.equal(rejected.frame,null);assert.equal(rejected.contract_rejection,'canonical_entity_bounds');assert.equal(rejected.contract_diagnostic.container,'attributes');assert.equal(rejected.contract_diagnostic.violation.code,'depth');assert.equal(rejected.contract_diagnostic.violation.actual,4);assert.equal(rejected.failure.stage,'canonical_validation');
   globalThis.__semanticBoundsModel=async()=>({ok:true,request_id:'isolated-source',text:JSON.stringify({operation:'UPDATE_ITEM',confidence:0.98,customer_facts:[{key:'small_room_area',value:{amount:80,unit:'sq_ft'}},{key:'large_room_area',value:{amount:100,unit:'sq_ft'}},{key:'lounge_area',value:{amount:180,unit:'sq_ft'}}]})});
   const valid=await interpretCommerceSemantics(input);assert.equal(valid.failure_code,null);assert.equal(valid.frame.customer_facts[0].value.amount,80);assert.equal(valid.frame.customer_facts[2].value.unit,'sq_ft');
  }
 }finally {previous===undefined?delete globalThis.__semanticBoundsModel:globalThis.__semanticBoundsModel=previous;}
});

function nodes(value,path=[]) {
 const kind=value===null?'null':Array.isArray(value)?'array':typeof value;
 return [{path,kind,...(kind==='string'?{text:value}:kind==='number'?{number:value}:kind==='boolean'?{boolean:value}:{})},
  ...((kind==='object'||kind==='array')?Object.entries(value).flatMap(([k,v])=>nodes(v,[...path,k])):[])];
}
const typed=(value={})=>({context_encoding:'typed_paths_v1',operation:'UPDATE_ITEM',confidence:0.98,...value});
test('Hosted d268773f: provider transport has no combinatorial optional frame/entity/capability fields; node scalar exclusivity stays strict',()=>{
 const inspect=s=>{
  if(s.properties){
   const keys=Object.keys(s.properties),optional=keys.filter(k=>!s.required?.includes(k));
   assert.deepEqual(s.propertyOrdering,keys);
   if(keys.includes('path')&&keys.includes('kind'))assert.deepEqual(optional,['text','number','boolean']);
   else assert.deepEqual(optional,[],'optional commerce field grammar branches would regress Vertex400');
   Object.values(s.properties).forEach(inspect);
  }
  if(s.items)inspect(s.items);
 };
 inspect(COMMERCE_SEMANTIC_TYPED_SCHEMA);
 const before=structuredClone(COMMERCE_SEMANTIC_TYPED_SCHEMA);
 before.required=['context_encoding','operation','confidence'];
 assert(Object.keys(before.properties).filter(k=>!before.required.includes(k)).length>3,'retained previous transport shape must reproduce the branch-budget failure');
});
test('required neutral transport fields produce identical canonical meaning; explicit false/zero/null facts are never transport defaults',()=>{
 const supplied=typed({customer_correction:true,customer_facts:[{key:'seats',value_nodes:nodes(0)},{key:'auto_renew',value_nodes:nodes(false)},{key:'requested_date',value_nodes:nodes(null)}],entities:[{name:'subscription',kind:'subscription',confidence:0.97,attributes_nodes:nodes({seats:0,auto_renew:false,date:null})}]});
 const fill=(schema,value,key)=>{
  if(value===undefined){if(schema.nullable)return null;if(schema.type==='array')return ['attributes_nodes','constraints_nodes'].includes(key)?nodes({}):[];if(schema.enum)return schema.enum.includes('unknown')?'unknown':schema.enum[0];if(schema.type==='boolean')return false;if(schema.type==='string')return key==='language'?'und':key==='intent'?'unknown':'';}
  if(schema.properties){const out={...value};for(const k of schema.required??[])out[k]=fill(schema.properties[k],out[k],k);return out;}
  return schema.items&&Array.isArray(value)?value.map(v=>fill(schema.items,v)):value;
 };
 const complete=fill(COMMERCE_SEMANTIC_TYPED_SCHEMA,supplied);
 const a=normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(supplied));
 const b=normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(complete));
 assert(a);assert.deepEqual(b,a);assert.deepEqual(b.customer_facts.map(f=>f.value),[0,false,null]);
 const invalid=structuredClone(complete);invalid.customer_facts[1].value_nodes[0].number=0;
 assert.equal(decodeCommerceSemanticWire(invalid),null,'inactive scalar slots must still reject, never be silently removed');
});
test('typed provider schema serializes through the real Vertex generation-config builder without dynamic-key/schema escape fields',async()=>{
 const c=await build({stdin:{contents:"export {buildVertexGenerationConfig} from './supabase/functions/_shared/vertex-generation-config.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
 const {buildVertexGenerationConfig}=await import('data:text/javascript;base64,'+Buffer.from(c.outputFiles[0].text).toString('base64'));
 const cfg=buildVertexGenerationConfig(4096,true,COMMERCE_SEMANTIC_TYPED_SCHEMA,0,'gemini-2.5-flash');
 assert.equal(cfg.responseMimeType,'application/json');assert.equal(cfg.responseSchema.type,'OBJECT');
 assert.equal(cfg.responseSchema.properties.entities.items.properties.attributes_nodes.items.properties.path.maxItems,'3');
 assert.equal(cfg.responseSchema.properties.customer_facts.items.properties.value_nodes.items.properties.path.maxItems,'2');
 assert(!/additionalProperties|delta_json|value_json|attributes_json/.test(JSON.stringify(cfg.responseSchema)));
});
for(const value of [false,0,null,{},[],{amount:80,unit:'sq_ft'},{rooms:[80,100,180],unit:'sq_ft'},{dimensions:{width:70,height:55},unit:'cm',room:null}])test('typed paths losslessly preserve customer fact '+JSON.stringify(value),()=>{
 const f=normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(typed({customer_facts:[{key:'customer_measurement',value_nodes:nodes(value).reverse()}]})));
 assert(f);assert.deepEqual(f.customer_facts[0].value,value);
});
for(const name of ['subscription','rental','service'])test('generic typed contexts retain multientity source/negation/correction/units: '+name,()=>{
 const attributes={quantity:{amount:0,unit:'seats'},renewal:false,requested_date:null,source:'current_customer_turn'};
 const frame=normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(typed({customer_correction:true,explicit_negations:['not paid'],entities:[{name,kind:name,confidence:0.99,attributes_nodes:nodes(attributes),constraints_nodes:nodes({measurement:{width:70,height:55,unit:'cm'},room:null})}]})));
 assert(frame);assert.deepEqual(frame.entities[0].attributes,attributes);assert.equal(frame.entities[0].constraints.room,null);assert.equal(frame.customer_correction,true);assert.deepEqual(frame.explicit_negations,['not paid']);
});
for(const bad of [
 [{path:[],kind:'object'},{path:['a','b','c','d'],kind:'number',number:80}],
 [{path:[],kind:'object'},{path:['a','b'],kind:'number',number:80}],
 [{path:[],kind:'object'},{path:['a'],kind:'boolean',boolean:'false'}],
 [{path:[],kind:'object'},{path:['a'],kind:'null',number:0}],
 [{path:[],kind:'object'},{path:['a'],kind:'number',number:1},{path:['a'],kind:'number',number:2}],
 [{path:[],kind:'array'},{path:['1'],kind:'number',number:80}],
 [{path:[],kind:'object'},{path:['__proto__'],kind:'object'}],
 [{path:[],kind:'object'},{path:['a'],kind:'number',number:1},{path:[' a '],kind:'number',number:2}],
])test('malformed typed graph is wholly rejected without guessing/truncation: '+JSON.stringify(bad),()=>{
 let reason;assert.equal(decodeCommerceSemanticWire(typed({entities:[{name:'generic',kind:'service',confidence:0.9,attributes_nodes:bad}]}),r=>reason=r),null);assert.equal(reason,'wire_context_nodes');
});
test('provider typed transport does not loosen canonical field/leaf/text limits or accept mixed aliases',()=>{
 for(const attributes of [Object.fromEntries(Array.from({length:41},(_,i)=>['f'+i,i])),{text:'x'.repeat(301)},Object.fromEntries(Array.from({length:9},(_,i)=>['g'+i,Array(12).fill(0)]))]) {
  let reason;const result=normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(typed({entities:[{name:'generic',kind:'service',confidence:0.9,attributes_nodes:nodes(attributes)}]})),r=>reason=r);
  assert.equal(result,null);assert.equal(reason,'canonical_entity_bounds');
 }
 assert.equal(decodeCommerceSemanticWire(typed({entities:[{name:'generic',kind:'service',confidence:0.9,attributes_nodes:nodes({ok:true}),attributes:{ok:true}}]})),null);
});
