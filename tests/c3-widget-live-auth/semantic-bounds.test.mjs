import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import {build} from 'esbuild';
const out=await build({stdin:{contents:`export * from './supabase/functions/_shared/commerce-semantic-frame.ts'; export * from './supabase/functions/_shared/bounded-decision-context.ts';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {COMMERCE_SEMANTIC_NATIVE_SCHEMA,normalizeCommerceSemanticFrame,decodeCommerceSemanticWire,normalizeDecisionContext}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
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
   globalThis.__semanticBoundsModel=async input=>{calls++;assert(input.system.includes('80 characters per key'));assert(input.system.includes('96 scalar leaves'));assert.equal(input.responseFormat,'json');assert.equal(input.responseSchema,undefined);
    return {ok:true,request_id:'isolated-source',text:JSON.stringify(frame(entity({rooms:{one:{measurement:{amount:80}}}})))};};
   const input={company_id:'isolated-company',conversation_id:'isolated-conversation',source_message_id:'isolated-source',latest,persistent_state_summary:'{}'};
   const rejected=await interpretCommerceSemantics(input);assert.equal(calls,1);assert.equal(rejected.frame,null);assert.equal(rejected.contract_rejection,'canonical_entity_bounds');assert.equal(rejected.contract_diagnostic.container,'attributes');assert.equal(rejected.contract_diagnostic.violation.code,'depth');assert.equal(rejected.contract_diagnostic.violation.actual,4);assert.equal(rejected.failure.stage,'canonical_validation');
   globalThis.__semanticBoundsModel=async()=>({ok:true,request_id:'isolated-source',text:JSON.stringify({operation:'UPDATE_ITEM',confidence:0.98,customer_facts:[{key:'small_room_area',value:{amount:80,unit:'sq_ft'}},{key:'large_room_area',value:{amount:100,unit:'sq_ft'}},{key:'lounge_area',value:{amount:180,unit:'sq_ft'}}]})});
   const valid=await interpretCommerceSemantics(input);assert.equal(valid.failure_code,null);assert.equal(valid.frame.customer_facts[0].value.amount,80);assert.equal(valid.frame.customer_facts[2].value.unit,'sq_ft');
  }
 }finally {previous===undefined?delete globalThis.__semanticBoundsModel:globalThis.__semanticBoundsModel=previous;}
});
