import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const compiled=await build({stdin:{contents:"export * from './supabase/functions/_shared/commerce-semantic-frame.ts'; export * from './supabase/functions/_shared/vertex-generation-config.ts';",resolveDir:process.cwd()},bundle:true,write:false,platform:'node',format:'esm'});
const {COMMERCE_SEMANTIC_PROVIDER_SCHEMA,decodeCommerceSemanticWire,normalizeCommerceSemanticFrame,buildVertexGenerationConfig,vertexResponseSchemaDiagnostic}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
function nodes(value,path=[]){const kind=value===null?'null':Array.isArray(value)?'array':typeof value;return [{path,kind,...(kind==='string'?{text:value}:kind==='number'?{number:value}:kind==='boolean'?{boolean:value}:{})},...(['object','array'].includes(kind)?Object.entries(value).flatMap(([k,v])=>nodes(v,[...path,k])):[])];}
const wire=(delta={},operation='UPDATE_ITEM')=>({context_encoding:'semantic_paths_v2',operation,confidence:0.98,nodes:nodes(delta)});
const canonical=v=>normalizeCommerceSemanticFrame(decodeCommerceSemanticWire(v));
test('v239 failure repair: real Vertex request builder receives only one shallow typed-tree grammar, never the expanded Commerce schema',()=>{
 const config=buildVertexGenerationConfig(4096,true,COMMERCE_SEMANTIC_PROVIDER_SCHEMA,0,'gemini-2.5-flash');
 assert.deepEqual(config.responseSchema.required,['context_encoding','operation','confidence','nodes']);
 assert.equal(config.responseMimeType,'application/json');assert.deepEqual(config.responseSchema.properties.context_encoding.enum,['semantic_paths_v2']);
 assert(!('entities' in config.responseSchema.properties));assert(!('customer_facts' in config.responseSchema.properties));
 const d=vertexResponseSchemaDiagnostic(COMMERCE_SEMANTIC_PROVIDER_SCHEMA);assert.equal(d.objects,2);assert.equal(d.arrays,2);assert(d.schema_bytes<1100);assert.equal(d.transport,'semantic_paths_v2');
 // Structural regression budget, not a claim of live provider acceptance.
 assert(!/delta_json|value_json|additionalProperties|anyOf/.test(JSON.stringify(config.responseSchema)));
 assert.equal(config.thinkingConfig.thinkingBudget,0);
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
])test('flat transport fails closed before canonical mutation: '+name,()=>{
 const w=wire();mutate(w);let code;assert.equal(decodeCommerceSemanticWire(w,c=>code=c),null);assert.equal(code,'wire_context_nodes');
});
for(const delta of [
 {customer_facts:[{key:'count',value:'x'.repeat(301)}]},
 {entities:[{name:'service',kind:'service',confidence:0.9,constraints:Object.fromEntries(Array.from({length:41},(_,i)=>['k'+i,i]))}]},
 {entities:[{name:'rental',kind:'rental',confidence:0.9,attributes:{list:Array(13).fill(false)}}]},
 {entities:Array.from({length:13},()=>({name:'service',kind:'service',confidence:0.98}))},
])test('new transport still rejects original canonical bounds without truncation: '+Object.keys(delta)[0],()=>{assert.equal(canonical(wire(delta)),null);});
