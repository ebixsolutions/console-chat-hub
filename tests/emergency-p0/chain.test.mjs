/** Legal isolated transport. Entire generate-reply handler and local import
 * graph run unchanged; only external SDK/auth/HTTP boundaries are isolated.
 * This suite is source runtime evidence, never Hosted acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex');
const root=path.resolve(new URL('../..',import.meta.url).pathname);
const sdkRequire=createRequire(path.resolve(process.env.C3_CONSOLE_SDK_ROOT || root,'package.json'));
const sdk=sdkRequire('@supabase/supabase-js');
assert.equal(sdkRequire('@supabase/supabase-js/package.json').version,'2.45.0');
// Cache compilation only; each fixture still executes a fresh complete module graph.
const compiledCode=new Map();
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const company=uuid(1),ticket=uuid(2),source=uuid(3);
function typedContextNodes(value,at=[]) {
 const kind=value===null?'null':Array.isArray(value)?'array':typeof value;
 return [{path:at,kind,...(kind==='string'?{text:value}:kind==='number'?{number:value}:kind==='boolean'?{boolean:value}:{})},
  ...((kind==='object'||kind==='array')?Object.entries(value).flatMap(([k,v])=>typedContextNodes(v,[...at,k])):[])];
}
// Retained fixtures exercise decoder compatibility; new demand cases use the active v5 transport.
const providerWire=(delta,operation='UPDATE_ITEM')=>({context_encoding:'semantic_paths_v2',operation,confidence:.98,nodes:typedContextNodes(delta)});
const providerWireV5=(delta,operation='UPDATE_ITEM')=>{
 const nodes=typedContextNodes(delta).filter(node=>node.path.length);
 return {context_encoding:'semantic_values_v5',operation,confidence:.98,
  containers:nodes.filter(n=>['object','array','null'].includes(n.kind)).map(({path,kind})=>({path,kind})),
  strings:nodes.filter(n=>n.kind==='string').map(({path,text})=>({path,text})),
  numbers:nodes.filter(n=>n.kind==='number').map(({path,number})=>({path,number})),
  booleans:nodes.filter(n=>n.kind==='boolean').map(({path,boolean})=>({path,boolean}))};
};
const recoveredSemanticCase=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/task1c-semantic-recovery.json'),'utf8'));
const retainedCatalogueCase=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/task1c-catalogue-retained-state.json'),'utf8'));

function catalogueRetainedSeed(short='轻量冲锋衣',full='轻量化户外冲锋衣') {
 const sample=JSON.parse(JSON.stringify(retainedCatalogueCase).replaceAll('轻量化户外冲锋衣',full).replaceAll('轻量冲锋衣',short));
 const company='3d6e17b5-ec79-4f75-aa7f-eaa824ff8493';
 const memory={...sample.memory.memory,company_id:company,conversation_id:ticket};
 const previous={conversation_commerce_state:[{...sample.commerce,company_id:company,conversation_id:ticket}],conversation_memory_state:[],conversation_commerce_state_event:[],conversation_memory_state_event:[]};
 const history=sample.commerce.state.entities.map((entity,i)=>({id:entity.provenance.source_message_id,conversation_id:ticket,role:'visitor',content:entity.attributes.product_name,created_at:`2026-10-13T00:00:0${i}.000Z`,is_recalled:false,metadata:{}}));
 history.unshift({id:sample.memory.source_message_id,conversation_id:ticket,role:'visitor',content:memory.current_goal,created_at:'2026-10-13T00:01:00.000Z',is_recalled:false,metadata:{}});
 return {previous,memory,history};
}

function catalogueRagFixture({name='轻量化户外冲锋衣',spu='P002',sku='P002-NV-XL',price=2100,stock=5}={}) {
 // User-supplied product column transcription plus explicit synthetic wire
 // authority. No claim that the original Hosted RAG response was retained.
 const content=`spu_code: ${spu}\nspu_name: ${name}\nsku_code: ${sku}\nspec_color: 藏青色\nspec_size: XL\nprice: ${price}.0 CNY\nstock: ${stock}\ndescription: 防水透氣面料，適合登山及日常通勤。`;
 return {success:true,context_found:true,selected_documents:[{document_id:'isolated-catalogue-document',title:'Row 4',source_type:'Product',document_score:0.03,
  authority:{tenant_id:'34',publication_state:'published',currentness:'unknown'},
  evidence:[{document_id:'isolated-catalogue-document',chunk_id:'isolated-catalogue-chunk',chunk_type:'full_content',content,score:0.03}]}],citations:[]};
}

function catalogueGateEvents(f) {
 return f.events.flat().filter(x=>typeof x==='string').flatMap(x=>{try{return [JSON.parse(x)]}catch{return []}}).filter(x=>x.stage==='b2_gate_result');
}

async function assertCatalogueReply(f,{source,name='轻量化户外冲锋衣',sku='P002-NV-XL',price=2100,stock=5,priceRequested=true,confirmation=true,expectPending=confirmation}={}) {
 const priorCommerce=structuredClone(f.tables.conversation_commerce_state[0]);
 const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits.length,1);
 const reply=f.commits[0],meta=reply.metadata;
 assert.equal(meta.response_route,'canonical_kb_direct_answer',JSON.stringify({route:meta.response_route,failure:meta.execution_failure,gates:catalogueGateEvents(f),
  scope:meta.kb_request_contract,trace:meta.current_grounding_target,grounding:f.events.filter(e=>/named_product_identity|grounding_selection|authority_reason/iu.test(JSON.stringify(e)))}));
 assert.notEqual(meta.generation_success,false);assert.notEqual(meta.degraded,true);
 assert(reply.content.includes(name)&&reply.content.includes(sku),'source-owned product identity missing');
 if(priceRequested)assert(reply.content.includes('CNY '+price.toLocaleString('en-US')),'recorded source amount/currency missing');
 assert(new RegExp('(?:quantity:|數量：|数量：)\\s*'+stock+'(?:[。.]|\\s)').test(reply.content),'recorded stock missing');
 assert.equal(meta.identity_confirmation_required,confirmation);
 assert.equal(meta.unresolved_fact_fields.includes('product_identity'),confirmation);
 if(confirmation){
  assert.equal(meta.catalogue_options.length,1);const option=meta.catalogue_options[0];
  assert.equal(option.sku,sku);assert.equal(option.product_name,name);assert.equal(option.document_id,'isolated-catalogue-document');assert.equal(option.chunk_id,'isolated-catalogue-chunk');
  assert.equal(option.reference_authority.decision,'USE_CURRENT_KB');assert.equal(option.reference_authority.selected_source_id,option.document_id);
  assert.deepEqual(Object.keys(option).sort(),['chunk_id','document_id','product_name','reference_authority','sku','spu','variants'],'follow-up target must carry no amount/stock authority');
  assert.equal(meta.catalogue_requested_facts.price,priceRequested);
 }
 assert.deepEqual(meta.authoritative_kb_facts,[],'recorded source fields became current merchant facts');assert(!meta.kb_fact_proof,'recorded amount became a verified quotation');
 assert.equal(meta.b2_source_message_id,source);assert.equal(meta.b2_expected_company_id,'3d6e17b5-ec79-4f75-aa7f-eaa824ff8493');
 assert.equal(meta.b2_commit_source,'commit_ai_reply_tx');assert.match(meta.b2_response_hash,/^[a-f0-9]{64}$/);
 assert.equal(meta.citation_lineage.selected_document_id,'isolated-catalogue-document');assert.deepEqual(meta.citation_lineage.evidence_chunk_ids,['isolated-catalogue-chunk']);
 assert(meta.recorded_kb_facts.some(x=>x.field==='stock_quantity'&&x.value===stock));
 if(priceRequested){assert(meta.recorded_kb_facts.some(x=>x.field==='price_amount'&&x.value===price));assert(meta.recorded_kb_facts.some(x=>x.field==='price_currency'&&x.value==='CNY'));}
 for(const fact of meta.recorded_kb_facts){assert.equal(fact.source_message_id,source);assert.equal(fact.tenant_id,'34');assert.equal(fact.currentness,'unverified');assert.equal(fact.document_id,'isolated-catalogue-document');assert.equal(fact.chunk_id,'isolated-catalogue-chunk');}
 const gates=catalogueGateEvents(f);assert(gates.some(x=>x.source_message_id===source&&x.gate_decision==='allow'&&x.gate_code==='B2_ALLOW'&&x.commit_attempted===true));assert(!gates.some(x=>x.gate_decision!=='allow'));
 assert.equal(f.requests.filter(x=>x.url.includes('context-search')).length,1,'each customer fact request needs one fresh scoped retrieval');
 const models=f.requests.filter(x=>x.url.endsWith(':generateContent'));assert.equal(models.length,1,'deterministic recorded facts must not cause extra generation/verifier calls');assert(models[0].body.systemInstruction.parts[0].text.includes('multilingual commerce semantic interpreter'));
 assert.deepEqual(f.tables.conversation_commerce_state[0].state.quotes,[],'recorded facts mutated canonical quote authority');
 assert.deepEqual(f.tables.conversation_commerce_state[0],priorCommerce,'catalogue read changed retained customer entities, requirements or commerce revision');
 const memory=f.tables.conversation_memory_state[0].memory;
 assert(![...memory.current_customer_facts,...memory.historical_facts].some(x=>x.authority==='current_kb'||x.value?.currentness==='current'),'recorded amount/stock promoted to current Memory');
 assert(!memory.current_customer_facts.some(x=>/price|stock|sku|product_identity/.test(x.key)&&x.source_message_id===source),'KB fields became customer-authoritative identity/price');
 if(expectPending)assert(memory.question_lifecycle.some(x=>x.source_message_id===source&&x.status==='pending'),'unverified availability/identity must remain unresolved');
 if(confirmation)assert(memory.question_lifecycle.some(x=>x.source_message_id===source&&x.resolution==='catalogue source price or product/variant confirmation pending'));
 const counts={requests:f.requests.length,commits:f.commits.length};const duplicate=await f.run();assert.equal(duplicate.body.idempotent,true);assert.equal(f.commits.length,counts.commits);assert.equal(f.requests.filter(x=>x.url.includes('context-search')).length,1,'duplicate message requeried KB');assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')).length,1,'duplicate message redispatched model');
 return {reply,r};
}

for(const [question,requested,priceRequested,id] of [['轻量冲锋衣 几钱？','price',true,2100],['轻量冲锋衣 有冇貨？','stock',false,2101]])test('Task1C v258 retained-state catalogue replay: '+requested,async()=>{
 const f=fixture(question,{...catalogueRetainedSeed(),originalPreview:true,fullChain:true,source:uuid(id),originalRagResponse:catalogueRagFixture(),semantic:providerWire({language:'zh-TW',intent:'other',requested_facts:[requested]},'ASK_FACT')});
 await assertCatalogueReply(f,{source:uuid(id),priceRequested});
});
test('Task1C v258 retained-state catalogue replay: sequential price then stock then exact SKU requeries changed stock',async()=>{
 const first=fixture('轻量冲锋衣 几钱？',{...catalogueRetainedSeed(),originalPreview:true,fullChain:true,source:uuid(2110),originalRagResponse:catalogueRagFixture(),semantic:providerWire({language:'zh-TW',intent:'other',requested_facts:['price']},'ASK_FACT')});
 await assertCatalogueReply(first,{source:uuid(2110)});
 const stock=fixture('轻量冲锋衣 有冇貨？',{originalPreview:true,fullChain:true,source:uuid(2111),previous:first.tables,history:first.tables.messages.slice().reverse(),originalRagResponse:catalogueRagFixture(),semantic:providerWire({language:'zh-TW',intent:'other',requested_facts:['stock']},'ASK_FACT')});
 await assertCatalogueReply(stock,{source:uuid(2111),priceRequested:false});
 assert.deepEqual(stock.commits[0].metadata.catalogue_requested_facts,{price:false,stock:true,specification:false});
 const chosen=fixture('P002-NV-XL',{originalPreview:true,fullChain:true,source:uuid(2112),previous:stock.tables,history:stock.tables.messages.slice().reverse(),originalRagResponse:catalogueRagFixture({price:2350,stock:4}),semantic:providerWire({language:'zh-TW',intent:'other',requested_facts:[]},'NO_STATE_CHANGE')});
 await assertCatalogueReply(chosen,{source:uuid(2112),priceRequested:false,stock:4,confirmation:false,expectPending:true});
 const request=chosen.requests.find(x=>x.url.includes('context-search'));
 assert.equal(request.body.query,'P002-NV-XL stock?');assert.equal(chosen.commits[0].metadata.kb_retrieval_request,request.body.query);
 assert(!chosen.commits[0].metadata.recorded_kb_facts.some(x=>x.field==='stock_quantity'&&x.value===5),'prior recorded stock reused as fresh evidence');
 assert.equal(chosen.tables.conversation_commerce_state[0].revision,14);
});
test('Task1C v258 retained-state catalogue replay: exact SKU after price candidate requeries changed price',async()=>{
 const first=fixture('轻量冲锋衣 几钱？',{...catalogueRetainedSeed(),originalPreview:true,fullChain:true,source:uuid(2120),originalRagResponse:catalogueRagFixture(),semantic:providerWire({language:'zh-TW',intent:'other',requested_facts:['price']},'ASK_FACT')});
 await assertCatalogueReply(first,{source:uuid(2120)});
 const chosen=fixture('P002-NV-XL',{originalPreview:true,fullChain:true,source:uuid(2121),previous:first.tables,history:first.tables.messages.slice().reverse(),originalRagResponse:catalogueRagFixture({price:2350,stock:4}),semantic:providerWire({language:'zh-TW',intent:'other',requested_facts:[]},'NO_STATE_CHANGE')});
 await assertCatalogueReply(chosen,{source:uuid(2121),price:2350,stock:4,confirmation:false});
 const request=chosen.requests.find(x=>x.url.includes('context-search'));
 assert.equal(request.body.query,'P002-NV-XL price?');assert.equal(chosen.commits[0].metadata.kb_retrieval_request,request.body.query);
 assert(!chosen.commits[0].metadata.recorded_kb_facts.some(x=>x.field==='price_amount'&&x.value===2100),'prior recorded price reused as fresh evidence');
});
test('Task1C v258 retained-state catalogue replay: English alternate abbreviated product uses the same source-bound path',async()=>{
 const name='Harbor Summit Jacket',sku='HJ310-NV-XL';
 const f=fixture('What is the price of Harbor Jacket?',{...catalogueRetainedSeed('Harbor Jacket',name),originalPreview:true,fullChain:true,source:uuid(2130),originalRagResponse:catalogueRagFixture({name,spu:'HJ310',sku,price:1290,stock:7}),semantic:providerWire({language:'en',intent:'other',requested_facts:['price']},'ASK_FACT')});
 await assertCatalogueReply(f,{source:uuid(2130),name,sku,price:1290,stock:7});
 // Existing language continuity can retain Chinese after the prior Chinese
 // turns. This case proves English request/name matching, not a locale change.
 assert.match(f.commits[0].content,/similarly named published source record|名稱相近嘅已發布商品記錄/i);
 assert.match(f.commits[0].content,/intended product is still unconfirmed|商品對應仍未確認/i);
});
for(const malformed of [false,true])test('Task1C cd602ad2 persisted context through real semantic decoder and B2: '+(malformed?'reject malformed fixture':'valid provider-shaped continuation'),async()=>{
 const semantic=providerWire({intent:'other',customer_correction:true,customer_facts:[{key:'browser_tabs',value:{minimum_exclusive:20}},{key:'gaming',value:false}],requested_facts:[]});
 if(malformed)delete semantic.nodes.find(n=>n.kind==='number').number;
 const memory={...structuredClone(recoveredSemanticCase.memory),conversation_id:ticket};
 const previous={conversation_commerce_state:[{conversation_id:ticket,company_id:memory.company_id,revision:recoveredSemanticCase.commerce_revision,state:recoveredSemanticCase.commerce}],conversation_memory_state:[],conversation_commerce_state_event:[],conversation_memory_state_event:[]};
 const answer='你仍然要桌上型，重點是多分頁、文書及視像通話。可先比較多工時的記憶體餘量、儲存速度、螢幕與通話設備；不打機時可按實際工作量分配預算。店舖型號及售價仍需另行核實。';
 // The real ticket has earlier Visitor turns as well as Memory. Include those
 // retained utterances; an empty message history would not replay this input.
 const history=[{id:'e86e6352-c554-403c-aebc-35f26530e70d',role:'visitor',content:memory.current_goal,created_at:'2026-10-14T00:00:00.000Z'},
  {id:memory.source_message_id,role:'visitor',content:'答你剛才的澄清：我要桌上型電腦。更正一下，主要會同時開好多瀏覽器分頁，但不打機；之前提到的上網、文書及視像通話仍然需要。請按最新用途給一般規格比較建議，不用查任何店舖型號、庫存或售價。',created_at:'2026-10-14T00:01:00.000Z'}].map(m=>({...m,conversation_id:ticket,is_recalled:false,metadata:{}}));
 const f=fixture(recoveredSemanticCase.visitor,{source:recoveredSemanticCase.provenance.visitor_id,originalPreview:true,fullChain:true,previous,history,memory,semantic,answer,enforceSmallTransport:true,enforceSchemaBranchBudget:true});const result=await f.run();
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.commits.length,1);assert(!f.requests.some(r=>r.url.includes('context-search')));
 if(malformed){assert.equal(f.commits[0].metadata.source_error_code,'LLM_INVALID_OUTPUT');assert.equal(f.tables.conversation_memory_state[0].revision,3);assert(JSON.stringify(f.events).includes('scalar_value'));assert(!JSON.stringify(f.events).includes('browser_tabs'));}
 else{assert.equal(f.commits[0].content,answer);assert.equal(f.commits[0].metadata.response_route,'customer_guidance');const m=f.tables.conversation_memory_state[0];assert.equal(m.revision,4);assert.equal(m.memory.current_customer_facts.find(v=>v.key==='gaming').value,false);const prompt=f.requests.find(r=>r.body?.systemInstruction?.parts?.[0]?.text?.includes('[EFFECTIVE_CUSTOMER_REQUIREMENTS]'));assert(prompt);assert(JSON.stringify(prompt.body).includes('二十多個瀏覽器分頁'));}
 const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
});
for(const [industry,initial,clarification,latest,key,value,answer] of [
 ['retail','How should I compare a chair for home working?','How much space do you have?','One square metre; half the day I stand.','available_area',{amount:1,unit:'square metre'},'With one square metre and time spent standing, compare adjustability, seated comfort and the space needed to move between positions.'],
 ['saas','How should we choose collaboration software?','How many people need access?','Eight, and we do not want automatic renewal.','auto_renew',false,'For eight people, compare permission management, onboarding and renewal control. Verify any particular plan terms separately.'],
 ['booking','How should I compare service booking options?','What access and timing do you need?','Morning visits, with no stairs.','stairs',false,'Compare morning availability, accessible entry and rescheduling flexibility; actual provider availability needs confirmation.'],
 ['b2b','How should we compare packaging equipment?','What floor space is available?','Zero for an additional unit.','extra_floor_space',0,'With no extra floor space, compare options that fit the existing footprint and workflow, then verify vendor dimensions and capacity.'],
])test('Task1C provider wire clarification and latest effective state: '+industry,async()=>{
 const first=fixture(initial,{fullChain:true,originalPreview:true,semantic:providerWire({intent:'customer_guidance'},'ASK_FACT'),answer:clarification});await first.run();
 const next=fixture(latest,{source:uuid(440),fullChain:true,originalPreview:true,previous:first.tables,history:first.tables.messages,semantic:providerWire({intent:'other',customer_facts:[{key,value}]}),answer});const r=await next.run();assert.equal(r.status,200);assert.equal(next.commits[0]?.content,answer);assert.equal(next.commits[0].metadata.response_route,'customer_guidance');assert.deepEqual(next.tables.conversation_memory_state[0].memory.current_customer_facts.find(x=>x.key===key)?.value,value);assert(!next.requests.some(r=>r.url.includes('context-search')));
 const prompt=next.requests.find(r=>r.body?.systemInstruction?.parts?.[0]?.text?.includes('[EFFECTIVE_CUSTOMER_REQUIREMENTS]'));assert(prompt);for(const part of [initial,latest])assert(JSON.stringify(prompt.body).includes(part));assert.equal(next.commits[0].metadata.b2_commit_source,'commit_ai_reply_tx');
});
for(const text of [
 '我想選一部適合屋企日常使用的電腦，主要上網、文書同視像通話。應該先比較哪些規格？暫時不用查店舖庫存或售價。',
 'Which specifications should I compare for everyday home use?',
])test('Hosted 95fd1e95 general specification criteria reach guidance without KB: '+text,async()=>{
 const answer='可先比較日常多工所需的記憶體、儲存空間、螢幕與視像通話設備，再按預算及攜帶需要取捨。具體型號的規格仍需核實。';
 const f=fixture(text,{fullChain:true,originalPreview:true,answer,semantic:providerWire({intent:'customer_guidance',requested_facts:['specification comparison criteria']},'ASK_FACT')});
 const r=await f.run();assert.equal(r.status,200);assert.equal(f.commits[0]?.content,answer);assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance');assert(!f.requests.some(x=>x.url.includes('context-search')));assert.equal(f.commits.length,1);
 const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
});
function fixture(text,options={}) {
 const company=options.company ?? (options.originalPreview?'3d6e17b5-ec79-4f75-aa7f-eaa824ff8493':uuid(1)),source=options.source??uuid(3);
 const requests=[],logs=[],commits=[],events=[]; let handler,mode=options.mode || 'ok',foreign=false;
 const conversation={id:ticket,company_id:company,status:options.human?'human_control':'open',assigned_agent_id:null,metadata_source:{}};
 const priorTimes=(options.history??[]).map(row=>Date.parse(row.created_at)).filter(Number.isFinite);
 const sourceTime=options.source_created_at??new Date(Math.max(Date.parse('2026-10-14T01:00:00.000Z'),...priorTimes.map(value=>value+1000))).toISOString();
 const visitor={id:source,conversation_id:ticket,role:'visitor',content:text,is_recalled:false,created_at:sourceTime,metadata:{}};
 const tables={ce_evaluation_state:[],handoff_event:[],conversation_commerce_state_event:[],company:[{id:company,is_active:true}],conversations:[conversation],messages:[visitor],conversation_commerce_state:[],conversation_memory_state:[],conversation_memory_state_event:[],c3_memory_reply_lifecycle_receipt:[]};
 let generationIndex=0, previewInitialization;
 const claimReaders=[];
 if(options.previous)for(const name of ['conversation_commerce_state','conversation_memory_state','conversation_commerce_state_event','conversation_memory_state_event'])tables[name]=structuredClone(options.previous[name]);
 if(options.history)tables.messages.push(...structuredClone(options.history));
 if(options.retainedMemory)tables.conversation_memory_state.push({conversation_id:ticket,company_id:company,revision:7,memory:{current_customer_facts:[{key:'subscription_seats',value:17,source_message_id:uuid(30)}]}});
 if(options.memory)tables.conversation_memory_state.push({conversation_id:ticket,company_id:company,revision:options.memory.memory_revision,source_message_id:options.memory.source_message_id,memory:options.memory});
 const env={SUPABASE_URL:'http://isolated.invalid',SUPABASE_SECRET_KEY:'isolated-fake-key',ENABLE_KB_ADAPTER:'true',LLM_PROVIDER:'vertex',LLM_MODEL_EVALUATION:'gemini-2.5-flash',LLM_MODEL_GENERATION:'gemini-2.5-flash',GOOGLE_PROJECT_ID:'isolated-project',GOOGLE_REGION:'us-central1',GOOGLE_SERVICE_ACCOUNT_JSON:'{}',LLM_TIMEOUT_MS:'50',...(options.fullChain?{KB_SINGAPORE_TENANT_MAP_JSON:JSON.stringify({[company]:'34'}),KB_SINGAPORE_TENANT_API_KEYS_JSON:JSON.stringify({'34':'isolated-kb-fixture'})}:{}),...(options.env??{})};
 const network=async (input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input)); const method=init.method||'GET';
  const body=init.body?JSON.parse(String(init.body)):null;
  requests.push({url:url.href,method,body});
  if(url.hostname==='us-central1-aiplatform.googleapis.com') {
   if(url.pathname.endsWith(':countTokens'))return Response.json({totalTokens:120});
   assert(url.pathname.endsWith('/gemini-2.5-flash:generateContent'));
   if(body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.'))assert.equal(body.generationConfig.thinkingConfig?.thinkingBudget,company==='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'&&!options.originalPreview?1024:0);
   if(options.fullChain && !body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.')) {
    const verifier=body.generationConfig.responseSchema?.properties?.grounded;
    const isRepair=body.systemInstruction?.parts?.[0]?.text?.includes('previous draft was NOT delivered');
    const text=verifier?JSON.stringify({grounded:options.verifierGrounded??true,unsupported_claims:options.verifierGrounded===false?['unsupported merchant claim']:[],evidence_chunk_ids:options.verifierIds??['E1'],...(options.omitQuestionResolution?{}:{question_resolution:options.verifierResolution??'supported'}),...(options.verifierDemandResolutions!==undefined?{demand_resolutions:options.verifierDemandResolutions}:{})}):isRepair&&options.repairAnswer?options.repairAnswer:options.answers?.[generationIndex++]??options.answer??'CW-SUL70BA 的能源效益資料請參閱官方能源標籤；目前文件未列出能源級別，我不會估計。';
    if(!verifier && options.humanAfterFirstDraft && generationIndex===1)conversation.status='human_control';
    if(!verifier && options.newSourceAfterFirstDraft && generationIndex===1)tables.messages.unshift({...visitor,id:uuid(999),content:'A newer customer question',created_at:'2026-10-14T01:00:01.000Z'});
    return Response.json({candidates:[{content:{parts:[{text}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:30}});
   }
   assert.equal(body.generationConfig.responseMimeType,'application/json');
   const semanticSchema=body.generationConfig.responseSchema;
   assert.deepEqual(semanticSchema.properties.context_encoding.enum,['semantic_values_v5']);
   for(const [list,field] of [['containers','kind'],['strings','text'],['numbers','number'],['booleans','boolean']]){
    const item=semanticSchema.properties[list].items;
    assert.deepEqual(Object.keys(item.properties),['path',field]);assert.deepEqual(item.required,['path',field]);
    assert.equal(item.properties.path.maxItems,'6');
   }
   assert(!JSON.stringify(semanticSchema).includes('"anyOf"'),'typed transport must not reintroduce union branch growth');
   assert(body.systemInstruction.parts[0].text.includes('Follow the supplied typed transport schema'));
   assert(body.systemInstruction.parts[0].text.includes('Wire contract: context_encoding=semantic_values_v5'));
   assert(!body.systemInstruction.parts[0].text.includes('Wire contract: context_encoding=semantic_paths_v2'));
   if(options.enforceSmallTransport){
    assert(Buffer.byteLength(JSON.stringify(semanticSchema))<2000);
    assert.deepEqual(Object.keys(semanticSchema.properties),['context_encoding','operation','confidence','containers','strings','numbers','booleans']);
   }
   if(options.enforceSchemaBranchBudget){
    const inspect=s=>{if(s.properties){assert.deepEqual(s.required,Object.keys(s.properties),'typed transport objects have no optional field branches');Object.values(s.properties).forEach(inspect);}if(s.items)inspect(s.items);assert.equal(s.anyOf,undefined);};
    inspect(body.generationConfig.responseSchema);
   }
   if(mode==='400')return Response.json({error:{status:'INVALID_ARGUMENT',message:'response schema too complex; PRIVATE-SECRET user@example.invalid',details:[{fieldViolations:[{field:'generation_config.response_schema',description:'PRIVATE-SECRET'}]}]}},{status:400});
   if(mode==='timeout')return await new Promise((resolve,reject)=>{if(init.signal?.aborted)return reject(new DOMException('isolated','AbortError'));init.signal?.addEventListener('abort',()=>reject(new DOMException('isolated','AbortError')),{once:true})});
   if(mode==='malformed')return Response.json({candidates:[{content:{parts:[{text:'{broken'}]},finishReason:'STOP'}]});
   const semantic=options.semantic || {operation:'ASK_FACT',confidence:0.96,delta_json:JSON.stringify({intent:'merchant_policy',requested_facts:['published policy']})};
   return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(semantic)}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:30}});
  }
  if(options.fullChain && url.origin==='https://py.ebixmall.com') {
   if(options.originalRagResponse)return Response.json(options.originalRagResponse);
   if(options.kbNoMatch)return Response.json({success:true,context_found:false,selected_documents:[],citations:[]});
   if(options.kbHttp)return new Response('PRIVATE-SECRET',{status:503});
   if(options.kbBadJson)return new Response('{private');
   return Response.json({success:true,context_found:true,selected_documents:[{document_id:'isolated-energy-document',title:'CW-SUL70BA',source_type:'product',document_score:0.95,authority:{tenant_id:'34',publication_state:'published',currentness:'current',entity_ids:['CW-SUL70BA']},summary:null,evidence:[{chunk_id:'isolated-energy-chunk',chunk_type:'full_content',score:0.95,content:'CW-SUL70BA: 能源效益資料請參閱官方能源標籤。此測試文件沒有列出能源級別。'}]}]});
  }
  assert.equal(url.origin,'http://isolated.invalid' ,'live network escaped isolated transport');
  if(url.pathname.startsWith('/rest/v1/rpc/')) {
   const rpc=url.pathname.split('/').at(-1);
   if(options.fullChain && rpc==='upsert_conversation_commerce_state_v1') {
    const prior=tables.conversation_commerce_state[0];assert.equal(body.p_company_id,company);assert.equal(body.p_expected_revision,prior?.revision??0);
    const row={conversation_id:ticket,company_id:company,source_message_id:source,revision:(prior?.revision??0)+1,state:body.p_state};tables.conversation_commerce_state=[row];tables.conversation_commerce_state_event.push({...row,applied_revision:row.revision});return Response.json({result:'success',applied_revision:row.revision});
   }
   if(options.fullChain && rpc==='c3_commit_conversation_memory_tx') {
    assert.equal(body.p_company_id,company);assert.equal(body.p_expected_memory_revision,tables.conversation_memory_state[0]?.revision??0);const row={conversation_id:ticket,company_id:company,source_message_id:source,revision:body.p_expected_memory_revision+1,commerce_state_revision:body.p_expected_commerce_revision,memory:body.p_memory,markdown_projection:body.p_markdown_projection,memory_hash:'a'.repeat(64)};tables.conversation_memory_state=[row];tables.conversation_memory_state_event.push({...row,applied_revision:row.revision});return Response.json({result:'success',current_revision:row.revision});
   }
   if(options.fullChain && rpc==='c3_finalize_memory_reply_tx') {
    const prior=tables.conversation_memory_state[0];assert.equal(prior.revision,body.p_expected_memory_revision);assert.equal(prior.memory_hash,body.p_expected_memory_hash);
    const answer=tables.messages.find(x=>x.id===body.p_reply_message_id);assert(answer);
    const row={...prior,revision:prior.revision+1,memory:body.p_memory,markdown_projection:body.p_markdown_projection,memory_hash:hash(JSON.stringify(body.p_memory))};
    tables.conversation_memory_state=[row];tables.c3_memory_reply_lifecycle_receipt.push({conversation_id:ticket,company_id:company,source_message_id:source,reply_message_id:answer.id,parent_revision:prior.revision,parent_hash:prior.memory_hash,applied_revision:row.revision,commerce_state_revision:prior.commerce_state_revision,memory_hash:row.memory_hash,markdown_hash:hash(row.markdown_projection),reply_content_hash:hash(answer.content)});return Response.json({result:'success'});
   }
   if(rpc==='c3_uat_execution_status')return options.rpcMissing ? Response.json({code:'PGRST202',message:'PRIVATE-SECRET'},{status:404}) : Response.json({ready:true,remote_ready:options.fullChain===true && !options.remoteDenied,allowed_conversations:[ticket]});
   if(rpc==='c3_uat_reserve_dispatch' && body.p_provider==='singapore-kb' && options.remoteDenied)return Response.json({code:'P0001',message:'UAT_REMOTE_BOUND_UNVERIFIED'},{status:400});
   if(rpc==='c3_uat_reserve_dispatch')return options.rpcMissing ? Response.json({code:'PGRST202',message:'PRIVATE-SECRET'},{status:404}) : Response.json({dispatch:true,run_id:env.C3_TEMP_UAT_RUN_ID,identity:body.p_identity,state:'reserved',expires_epoch:Date.now()/1000+60});
   if(rpc==='c3_uat_finalize_dispatch')return Response.json({state:body.p_state});
   if(['explicit_handoff_tx','required_escalation_handoff_tx'].includes(rpc))return Response.json({result:'success'});
   if(rpc==='commit_ai_reply_tx') {
    assert.equal(body.p_conversation_id,ticket);assert.equal(body.p_source_message_id,source);
    assert.equal(body.p_metadata.b2_expected_company_id,company);
    if(conversation.status==='human_control')return Response.json({result:'human_control'});
    if(options.newSourceAfterFirstDraft && generationIndex>=1)return Response.json({result:'superseded_source'});
    if(options.rpcResult)return Response.json({result:options.rpcResult});
    if(foreign)return Response.json({result:'tenant_mismatch'});
    if(commits.length)return Response.json(body.p_content===commits[0].content?{result:'idempotent',message_id:commits[0].id}:{result:'response_substitution'});
    const reply={id:options.source?uuid(Number(source.slice(-6))+1000):uuid(10),conversation_id:ticket,role:'assistant',content:body.p_content,is_recalled:false,created_at:new Date(Date.parse(visitor.created_at)+1).toISOString(),metadata:{...body.p_metadata,source_message_id:source,control_commit:'ai'}};
    commits.push(reply);tables.messages.push(reply);return Response.json({result:'success',message_id:reply.id});
   }
   throw Error('unhandled isolated RPC '+rpc);
  }
  const table=url.pathname.split('/').at(-1);
  if(table==='upstream_call_log'&&method==='POST'){logs.push(body);return new Response(null,{status:201});}
  if(method==='DELETE')return new Response(null,{status:204});
  assert(method==='GET'||method==='HEAD'||(table==='messages'&&method==='PATCH'),'unexpected mutation '+table);
  assert(table in tables,'unhandled isolated table '+table);
  let rows=tables[table];
  for(const [field,value] of url.searchParams){
   const get=r=>field.includes('->>')?r[field.split('->>')[0]]?.[field.split('->>')[1]]:r[field];
   if(value.startsWith('eq.')) rows=rows.filter(r=>(field==='metadata'?JSON.stringify(get(r)):String(get(r)))===value.slice(3));
   if(value==='is.null')rows=rows.filter(r=>get(r)===null);
   if(value.startsWith('neq.')) rows=rows.filter(r=>String(r[field])!==value.slice(4));
   if(value.startsWith('in.(')) {const wanted=value.slice(4,-1).split(',').map(v=>v.replace(/^"|"$/g,''));rows=rows.filter(r=>wanted.includes(String(get(r))));}
   if(value.startsWith('lte.')) rows=rows.filter(r=>String(get(r))<=value.slice(4));
   if(value.startsWith('lt.')) rows=rows.filter(r=>String(get(r))<value.slice(3));
   if(value.startsWith('ilike.')) {const needle=value.slice(6).replace(/^%|%$/g,'').replace(/\\([_%\\])/g,'$1').toLowerCase();rows=rows.filter(r=>String(get(r)).toLowerCase().includes(needle));}
   if(field==='or') {
    const boundary=value.match(/^\(created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.(lt|lte)\.([^)]+)\)\)$/);
    if(boundary) rows=rows.filter(r=>r.created_at<boundary[1]||r.created_at===boundary[2]&&(boundary[3]==='lte'?r.id<=boundary[4]:r.id<boundary[4]));
   }
  }
  const ordering=url.searchParams.get('order');
  if(ordering)rows=[...rows].sort((a,b)=>{for(const part of ordering.split(',')){const [key,direction]=part.split('.');const result=String(a[key]??'').localeCompare(String(b[key]??''));if(result)return direction==='desc'?-result:result;}return 0;});
  const limit=url.searchParams.get('limit');if(limit)rows=rows.slice(0,Number(limit));
  if(foreign&&table==='company')rows=[];
  if(foreign&&table==='messages'&&url.searchParams.get('id')===`eq.${source}`)rows=[];
  if(method==='PATCH'){
   assert.equal(table,'messages');assert.equal(url.searchParams.get('id'),'eq.'+source);
   assert.equal(url.searchParams.get('conversation_id'),'eq.'+ticket);
   assert.equal(url.searchParams.get('role'),'eq.visitor');assert.equal(url.searchParams.get('is_recalled'),'eq.false');
   assert(url.searchParams.has('metadata'),'claim must compare the entire prior metadata');
   assert.deepEqual(Object.keys(body),['metadata']);assert(body.metadata.original_preview_draft_repair);
   if(options.claimFails)return Response.json({message:'isolated CAS unavailable'},{status:503});
   for(const row of rows)row.metadata=structuredClone(body.metadata);
   if(options.humanAfterRepairClaim)conversation.status='human_control';
   if(options.newSourceAfterRepairClaim)tables.messages.unshift({...visitor,id:uuid(999),content:'new source',created_at:'2026-10-14T01:00:01.000Z'});
  }
  const headers=new Headers(init.headers);const object=headers.get('accept')?.includes('pgrst.object');
  if(method==='HEAD') return new Response(null,{headers:{'content-range':`0-0/${rows.length}`}});
  const response=Response.json(object?(rows[0]??null):rows,{headers:{'content-range':`0-${Math.max(0,rows.length-1)}/${rows.length}`}});
  if(options.overlapClaims&&method==='GET'&&table==='messages'&&url.searchParams.get('select')==='metadata')await new Promise(resolve=>{claimReaders.push(resolve);if(claimReaders.length===2)for(const release of claimReaders)release();});
  return response;
 };
 let injectedFailure=false;
 const modules=new Map(), deno={env:{get:k=>{if(k==='ENABLE_KB_ADAPTER' && options.unexpectedFailure && !injectedFailure){injectedFailure=true;throw options.unexpectedFailure;}return env[k]}},serve:h=>{handler=h}};
 function load(file){
  if(modules.has(file))return modules.get(file);
  let code=compiledCode.get(file);
  if(!code){const sourceCode=fs.readFileSync(file,'utf8');code=ts.transpileModule(sourceCode,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;compiledCode.set(file,code);}
  const module={exports:{}};modules.set(file,module.exports);
  const require=spec=>{
   if(spec.startsWith('.'))return load(path.resolve(path.dirname(file),spec));
   if(spec==='npm:google-auth-library@9.15.0')return {GoogleAuth:class {async getClient(){return {getAccessToken:async()=>({token:'isolated-fake-token'})}}}};
   if(spec==='npm:@supabase/supabase-js@2.45.0'||spec==='https://esm.sh/@supabase/supabase-js@2.45.0')return {...sdk,createClient:(u,k,opts)=>sdk.createClient(u,k,{...opts,auth:{autoRefreshToken:false,persistSession:false},global:{fetch:network}})};
   throw Error('unapproved external import '+spec);
  };
  new Function('require','module','exports','Deno','fetch','console',code)(require,module,module.exports,deno,network,{log:(...v)=>events.push(v),info:(...v)=>events.push(v),warn:(...v)=>events.push(v),error:(...v)=>events.push(v.map(x=>x instanceof Error?{name:x.name,message:x.message}:x))});
  modules.set(file,module.exports);return module.exports;
 }
 load(path.join(root,'supabase/functions/generate-reply/index.ts'));
 return {run:async()=>{
  if(options.originalPreview){
   previewInitialization ??= (async()=>{
   const original=load(path.join(root,'supabase/functions/_shared/original-widget-preview.ts'));
   env.ORIGINAL_WIDGET_PREVIEW_AUTHORIZATION=original.ORIGINAL_PREVIEW_AUTHORIZATION;env.SUPABASE_SERVICE_ROLE_KEY='isolated-service-jwt';
   const account=original.ORIGINAL_PREVIEW_ACCOUNTS.find(a=>a.company===company);assert(account);
   const actor=options.originalRagResponse?'3bdf936e-b543-41d8-9fff-fa020a85f3f6':uuid(70),channel=account.channel,session=uuid(71);
   if(options.originalRagResponse)env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION=JSON.stringify({version:4,bindings:[{actor_id:actor,company_id:company,channel_id:channel,tenant_id:'34',endpoint:'https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search',provider:'singapore-kb',purpose:'kb_embedding',remote_mode:'query_embedding_rag_authority_v1',allow_remote_embedding:true,rag_api_contract:'singapore_rag_aggregation_v1',accepted_remote_risk:'authenticated_tenant_rag_filter_unversioned_v1'}]});
   conversation.channel_config_id=channel;conversation.visitor_session_id=session;
   conversation.metadata_source={source:'widget_live_test',widget_live_test:true,test_mode:true,exclude_training:true,execution_class:'authenticated_admin_preview',owner_user_id:actor,scope_mode:'canonical'};
   conversation.metadata_source.original_preview_authority=await original.signOriginalPreview({id:actor,email:account.email,email_confirmed_at:'2026-01-01'},company,channel,ticket,session);
   tables.company_membership=[{user_id:actor,company_id:company,role:'admin',is_active:true}];tables.channel_config=[{id:channel,company_id:company,is_active:true,channel_type:'web_widget'}];
   tables.visitor_session=[{id:session,channel_config_id:channel,visitor_fingerprint:'widget-live-test:'+actor,visitor_metadata:{source:'widget_live_test',test_mode:true,exclude_training:true,owner_user_id:actor,scope_mode:'canonical'}}];
   })();await previewInitialization;
  }
  const response=await handler(new Request('http://isolated.invalid/functions/v1/generate-reply',{method:'POST',headers:options.originalPreview?{Authorization:'Bearer isolated-service-jwt'}:{},body:JSON.stringify({conversation_id:ticket,source_message_id:source})}));return {status:response.status,body:await response.json()};},requests,logs,commits,events,tables,env,load,setMode:v=>{mode=v},setForeign:()=>{foreign=true}};
}
const social=['hi how are you',"what's your name",'who are you?','Hey, how have you been?','hello and how are you doing today?','早晨！你今日好唔好？','你好，你是誰？','你叫咩名？','Are you a real person?','Are you an AI assistant?','What can you help me with?','Hi，你係真人嗎？','thank you','明白啦'];
test('Director natural-language counterexample executes complete handler without semantic or KB dispatch',async()=>{
 const f=fixture('hi hi how do you do',{mode:'400',retainedMemory:true});const before=JSON.stringify(f.tables.conversation_memory_state);
 const r=await f.run();assert.equal(r.body.response_route,'natural_small_talk',JSON.stringify(r));assert.equal(r.body.degraded,undefined);assert.equal(f.commits.length,1);assert.equal(JSON.stringify(f.tables.conversation_memory_state),before);assert.equal(f.requests.filter(x=>x.url.includes('aiplatform')).length,0);assert.equal(f.logs.length,0);
});
for(const text of social)test('full handler social/identity no provider: '+text,async()=>{
 const f=fixture(text);const result=await f.run();assert.equal(result.status,200);assert.equal(f.commits.length,1);
 assert.equal(f.requests.filter(r=>r.url.includes('aiplatform')).length,0);assert.equal(f.logs.length,0);
 assert(!f.requests.some(r=>/commerce.*rpc|rag|context-search/.test(r.url)));
 assert(!result.body.degraded);assert.equal(f.commits[0].metadata.transaction_mutation,'NONE');
 if(/name|who|誰|名|person|真人/.test(text))assert.match(result.body.reply,/AI/);
 assert.notEqual(result.body.response_route,'terminal_failure_recovery');
 const replay=await f.run();assert.equal(f.commits.length,1);assert(replay.body.idempotent||replay.body.skipped||replay.status>=400,JSON.stringify(replay));
});
for(const mode of ['400','malformed','timeout'])test('full handler provider '+mode+' terminal persists honest degraded response exactly once',async()=>{
 const f=fixture('Hi, what is the published delivery policy?',{mode});const r=await f.run();
 assert.equal(r.status,200);assert.equal(r.body.degraded,true);assert.equal(r.body.generation_success,false);assert.match(r.body.reply,/problem/);
 assert.doesNotMatch(r.body.reply,/verify|knowledge|KB/i);assert.equal(f.commits.length,1);assert.equal(f.commits[0].metadata.source_error_code,mode==='400'?'LLM_NON_2XX':mode==='timeout'?'LLM_TIMEOUT':'LLM_INVALID_OUTPUT');
 assert.equal(f.commits[0].metadata.execution_failure.source_message_id,source);assert.equal(f.commits[0].metadata.retryable,mode==='timeout');
 if(mode==='malformed')assert(JSON.stringify(f.events).includes('semantic_json'));
 else assert(f.logs.some(x=>x.request_payload.error_code===(mode==='400'?'LLM_NON_2XX':'LLM_TIMEOUT')));
 assert(!JSON.stringify(f.logs).includes('PRIVATE-SECRET'));if(mode==='400')assert.equal(f.logs[0].request_payload.provider_diagnostic.provider_error_class,'schema_complexity');
 assert(!f.requests.some(x=>/rag|context-search|rpc\/.*(?:memory|commerce)/.test(x.url)));
 await f.run();assert.equal(f.commits.length,1);
});
test('wrong source/Tenant and human-control deny before provider or reply',async()=>{
 const f=fixture('hello');f.setForeign();assert.equal((await f.run()).status,400);assert.equal(f.commits.length,0);assert(!f.requests.some(x=>x.url.includes('aiplatform')));
 const h=fixture('hello',{human:true});assert.equal((await h.run()).body.skipped,'human_handling');assert.equal(h.commits.length,0);
});
test('simultaneous exact-source requests invoke existing B2 and idempotent RPC, one isolated persisted reply',async()=>{
 const f=fixture('Hi! Who are you?');const r=await Promise.all([f.run(),f.run()]);assert(r.every(x=>x.status===200));assert.equal(f.commits.length,1);
 assert.equal(f.commits[0].metadata.b2_gate_contract,'executeB2PersistenceGate:allow_after_revalidation');assert.match(f.commits[0].metadata.b2_response_hash,/^[a-f0-9]{64}$/);
});
for(const result of ['human_control','superseded_source','tenant_mismatch','stale_authorized_revision'])test('actual commit boundary preserves '+result,async()=>{
 const f=fixture("what's your role?",{rpcResult:result});const r=await f.run();assert.equal(f.commits.length,0);assert(r.body.skipped===result||r.status>=400);
});
for(const text of ['Hi, do you have telescope XQ-500 in stock?','你好，請問最新運費？','hello，星期六可唔可以預約？','Hi, add 3 subscription seats','Good morning, actually I meant the rental, not the subscription','Thanks, cancel only the service and defer the rental','明白，我需要無障礙通道，唔需要自動續期','And what about that earlier option?'])test('mixed/business turn retains semantic provider path: '+text,async()=>{
 const f=fixture(text,{mode:'400'});const r=await f.run();assert.equal(f.requests.filter(r=>r.url.includes('aiplatform')).length,1);assert.equal(r.body.degraded,true);
});
test('actual interpreter + Vertex compact request + canonical decoder supports unseen services with complete context',async()=>{
 const semantic={operation:'UPDATE_ITEM',confidence:0.96,delta_json:JSON.stringify({language:'mixed',intent:'correct_subscription',customer_correction:true,customer_facts:[{key:'auto_renew',value_json:'false'},{key:'seats',value_json:'{"amount":0,"unit":"users"}'},{key:'booking_date',value_json:'null'}],entities:[{name:'orbital telescope rental',kind:'rental',confidence:0.98,entity_ref:'rental-1',constraints_json:'{"wheelchair_access":true}',capabilities:{requires_booking:true}}],referents:[{ref:'rental-1',source:'persistent_state',confidence:0.98}],explicit_negations:['not paid'],requested_facts:['accessible booking options']})};
 const f=fixture('unused',{semantic});const interpreter=f.load(path.join(root,'supabase/functions/_shared/commerce-semantic-interpreter.ts'));
 const result=await interpreter.interpretCommerceSemantics({company_id:company,conversation_id:ticket,source_message_id:source,latest:'Actually zero users, no auto renewal, defer payment; accessible rental options?',persistent_state_summary:JSON.stringify({current_customer_facts:[{key:'auto_renew',value:true}]}),history:Array.from({length:120},(_,i)=>({role:'visitor',content:'Earlier service '+(119-i)}))});
 assert.equal(result.failure_code,null);assert.equal(result.frame.customer_facts[0].value,false);assert.equal(result.frame.customer_facts[1].value.unit,'users');assert.equal(result.frame.customer_facts[2].value,null);assert.equal(result.frame.entities[0].constraints.wheelchair_access,true);assert.equal(result.frame.referents[0].ref,'rental-1');assert.deepEqual(result.frame.requested_facts,['accessible booking options']);
 const req=f.requests.find(r=>r.url.includes('aiplatform'));assert(req.body.contents[0].parts[0].text.includes('current_customer_facts'));assert(req.body.contents[0].parts[0].text.includes('Earlier service 119'));
});
test('request validation denies malformed config before auth/provider and keeps diagnostics secret-free',async()=>{
 const f=fixture('unused'),router=f.load(path.join(root,'supabase/functions/_shared/llm-router.ts'));
 const call={purpose:'evaluation',system:'isolated',user:'service request',companyId:company,conversationId:ticket,operationId:'isolated',tag:'isolated',maxTokens:0,responseFormat:'json',thinkingBudget:0};
 const r=await router.callModel(call);assert.equal(r.ok,false);assert.equal(r.usage.attempts,0);assert.equal(r.code,'LLM_CONFIG_MISSING');assert(!f.requests.some(x=>x.url.includes('aiplatform')));
});
test('social identity with retained long business memory keeps its values/revision unchanged',async()=>{
 const f=fixture('Hello, are you a bot?',{retainedMemory:true});const retained=JSON.stringify(f.tables.conversation_memory_state);
 const result=await f.run();assert.equal(result.body.response_route,'natural_ai_identity');assert.equal(result.body.degraded,undefined);assert.equal(JSON.stringify(f.tables.conversation_memory_state),retained);
 assert(!f.requests.some(r=>r.method==='POST'&&/memory|commerce/.test(r.url)));assert.equal(f.commits[0].metadata.transaction_mutation,'NONE');
});
for(const text of ['Hi, please connect me to a human now','你好，請轉真人客服','唔該，我而家要真人跟進','Please correct the subscription and connect me to a human'])test('complete handler explicit R1 outranks semantic/provider: '+text,async()=>{
 const f=fixture(text,{mode:'400'});const r=await f.run();assert.equal(r.body.escalation_rule,'R1',JSON.stringify(r));assert.equal(r.body.handoff_persisted,true,JSON.stringify(r));assert(!f.requests.some(r=>r.url.includes('aiplatform')));
});
for(const [text,rule] of [['我要殺死你。請轉真人客服','E2'],['請轉真人客服，我想核實保險賠償責任','E1']])test('complete handler activated safety '+rule+' keeps precedence',async()=>{
 const f=fixture(text,{mode:'400'});Object.assign(f.env,{ESC_ENABLE_REQUIRED_RULES_LIVE:'true',ESC_ENABLE_E2:'true',ESC_ENABLE_E1:'true'});const r=await f.run();assert.equal(r.body.escalation_rule,rule,JSON.stringify(r));assert(!f.requests.some(r=>r.url.includes('aiplatform')));
});
test('actual interpreter rejects wrong company and inactive synthetic guard before provider',async()=>{
 const f=fixture('unused'),interpret=f.load(path.join(root,'supabase/functions/_shared/commerce-semantic-interpreter.ts')).interpretCommerceSemantics;
 for(const id of [uuid(88)]){
  const result=await interpret({company_id:id,conversation_id:ticket,source_message_id:source,latest:'Check current delivery options',persistent_state_summary:'{}'});
  assert.equal(result.frame,null);assert.equal(result.failure_code,'DISPATCH_COMPANY_UNPROVEN');
 }
 // Ownership is proven before the run guard. A missing run must be tested
 // against a real same-company ticket, separately from the foreign-company case.
 const c3=fixture('unused',{company:'4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'});
 const scopedInterpret=c3.load(path.join(root,'supabase/functions/_shared/commerce-semantic-interpreter.ts')).interpretCommerceSemantics;
 const denied=await scopedInterpret({company_id:'4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec',conversation_id:ticket,source_message_id:source,latest:'Check current delivery options',persistent_state_summary:'{}'});assert.equal(denied.failure_code,'UAT_AUTHORIZATION_ABSENT');assert.equal(denied.failure.retryable,false);
 assert(!c3.requests.some(r=>r.url.includes('aiplatform')));
 assert(!f.requests.some(r=>r.url.includes('aiplatform')));
});
test('actual interpreter recovers from an isolated 400 using same call path and preserves typed semantic delta',async()=>{
 const f=fixture('unused',{mode:'400',semantic:{operation:'DEFER',confidence:0.98,delta_json:JSON.stringify({intent:'defer_rental',entities:[{name:'conference equipment',kind:'rental',confidence:0.98}],explicit_negations:['not paid']})}}),interpret=f.load(path.join(root,'supabase/functions/_shared/commerce-semantic-interpreter.ts')).interpretCommerceSemantics;
 const input={company_id:company,conversation_id:ticket,source_message_id:source,latest:'Defer the rental; not paid yet',persistent_state_summary:'{}'};
 assert.equal((await interpret(input)).failure_code,'LLM_NON_2XX');f.setMode('ok');const result=await interpret(input);assert.equal(result.failure_code,null);assert.equal(result.frame.operation,'DEFER');assert.deepEqual(result.frame.explicit_negations,['not paid']);assert.equal(f.logs.length,2);assert.equal(f.logs[0].request_payload.outcome,'failed');assert.equal(f.logs[1].request_payload.outcome,'success');
});

// Canonical endpoint compatibility at the actual protected provider caller.
// Isolated transport only; existing admission/reservation/usage rules stay active.
function endpointGuardFixture(region) {
 const f=fixture('unused'),guard=f.load(path.join(root,'supabase/functions/_shared/uat-execution-contract.ts'));
 const vertex=f.load(path.join(root,'supabase/functions/_shared/vertex-generation-config.ts'));
 Object.assign(f.env,{C3_TEMP_UAT_RUN_ID:uuid(90),C3_TEMP_UAT_SOURCE_REVISION:guard.UAT_REVISION,GOOGLE_REGION:region});
 const request=JSON.stringify({contents:[{role:'user',parts:[{text:'Change booking A to Saturday; booking B remains Friday.'}]}],generationConfig:vertex.buildVertexGenerationConfig(4096,true,{type:'object',properties:{operation:{type:'string'},confidence:{type:'number'},delta_json:{type:'string'}},required:['operation','confidence','delta_json']},guard.UAT_THINKING,'gemini-2.5-flash')});
 const meta={companyId:guard.UAT_COMPANY,conversationId:ticket,operationId:'commerce-semantic:'+source,provider:'vertex',purpose:'evaluation',slot:'evaluation',attempt:1,request};
 const events=[];let dispatches=0,deny=false;
 const db={rpc:async(name,args)=>{events.push(name);return deny?{data:null,error:{code:'UAT_REMOTE_BOUND_UNVERIFIED'}}:{error:null,data:name==='c3_uat_reserve_dispatch'?{run_id:f.env.C3_TEMP_UAT_RUN_ID,identity:args.p_identity,state:'reserved',expires_epoch:Date.now()/1000+300,dispatch:true}:{state:args.p_state}};}};
 const transport=async u=>{events.push(String(u).endsWith(':countTokens')?'countTokens':'provider');if(String(u).endsWith(':countTokens'))return Response.json({totalTokens:120});dispatches++;return Response.json({usageMetadata:{promptTokenCount:120,candidatesTokenCount:20,thoughtsTokenCount:0}});};
 const url=vertex.buildVertexEndpoint(f.env.GOOGLE_PROJECT_ID,region,'gemini-2.5-flash');
 return {f,url,meta,events,dispatches:()=>dispatches,deny:()=>deny=true,run:(u=url,m=meta)=>guard.uatFetch(db,m,u,{method:'POST',body:request},transport)};
}
test('protected Vertex caller accepts the same canonical regional and global endpoint as the request builder',async()=>{
 for(const region of ['us-central1','global']){const f=endpointGuardFixture(region);await f.run();assert.equal(f.dispatches(),1);assert.deepEqual(f.events,['c3_uat_reserve_dispatch','countTokens','c3_uat_finalize_dispatch','c3_uat_reserve_dispatch','provider','c3_uat_finalize_dispatch']);}
});
test('canonical endpoint compatibility retains exact project, region, model, scheme and purpose denial',async()=>{
 const f=endpointGuardFixture('global');
 for(const url of [f.url.replace('aiplatform.googleapis.com','global-aiplatform.googleapis.com'),f.url.replace('isolated-project','foreign-project'),f.url.replace('/locations/global/','/locations/us-central1/'),f.url.replace('gemini-2.5-flash:','gemini-2.5-pro:'),f.url.replace('https:','http:'),f.url+'?override=true',f.url+'#override'])await assert.rejects(f.run(url),e=>e.code==='UAT_PROVIDER_DENIED');
 for(const override of [{provider:'anthropic'},{purpose:'unknown'}])await assert.rejects(f.run(f.url,{...f.meta,...override}),e=>e.code==='UAT_PROVIDER_DENIED');
 assert.equal(f.dispatches(),0);assert.deepEqual(f.events,[]);
});
test('global endpoint compatibility never bypasses the original remote-bound database admission',async()=>{
 const f=endpointGuardFixture('global');f.deny();await assert.rejects(f.run(),e=>e.code==='UAT_ADMISSION_DENIED');assert.equal(f.dispatches(),0);assert.deepEqual(f.events,['c3_uat_reserve_dispatch']);
});

// Combinations exercise the bounded speech-act grammar through the real handler.
// Public regression inputs are not fresh Quality95 holdouts.
test('whole-turn social grammar generalizes repetitions, orthography and supported languages',async()=>{
 const acts=['how do you do?','How are you feeling today?','how have you been keeping lately?','how are things going?','how is your day going?','你好嗎？','您最近過得怎麼樣？','近排點呀？','你今日好唔好？','how are u doing?'];
 for(const act of acts)for(const opening of ['', 'Hi hi! ', 'HELLO\tHEY\n']) {
  const f=fixture(opening+act,{mode:'400'}),r=await f.run();assert.equal(r.body.response_route,'natural_small_talk',opening+act);assert.equal(f.commits.length,1);assert.equal(f.logs.length,0);assert.equal(f.requests.filter(x=>/aiplatform|rag|context-search/.test(x.url)).length,0);assert.equal(f.commits[0].metadata.transaction_mutation,'NONE');
 }
 const f=fixture(Array(20).fill('hi').join(' ')+' how do you do?');assert.equal((await f.run()).body.response_route,'natural_small_talk');
});
test('minimal business, quotation, translation, negation and reference contrasts retain the complete semantic input',async()=>{
 for(const text of ['Hi, how do you do refunds?',"What does ‘how do you do’ mean?",'Please translate "how do you do" into Cantonese.','Hi hi, change my booking to Saturday, but keep the other one.','你好，最近過得怎麼樣這句英文點講？','Hi, not Saturday; keep Friday for the second booking.','How are you doing the cancellation?','How do you do? The subscription is deferred, not cancelled.','Hi, what about the earlier option?','點樣','One person needs a Saturday booking.','Do not connect me to a person. Check the refund policy.','If this fails, connect me to someone.','What does "please connect me to a person" mean?','Hi, I am angry. Just tell me the return policy.']) {
  const f=fixture(text,{mode:'400'}),r=await f.run();const req=f.requests.find(x=>x.url.includes('aiplatform'));assert(req,text);assert(req.body.contents[0].parts[0].text.includes(text.normalize("NFKC")),JSON.stringify(req.body.contents[0].parts[0].text));assert.equal(r.body.response_route,'terminal_failure_recovery');assert.equal(r.body.generation_success,false);assert.equal(f.commits.length,1);assert(!f.requests.some(x=>/explicit_handoff_tx|required_escalation_handoff_tx|rag|context-search/.test(x.url)));assert.doesNotMatch(r.body.reply,/booking.*(?:changed|updated)|refund.*completed/i);
 }
});
test('canonical nonempty multi-entity memory and pending corrections survive social interruption and return to context',async()=>{
 const seed=fixture('unused');const memoryModule=seed.load(path.join(root,'supabase/functions/_shared/conversation-long-memory.ts'));
 const memory=memoryModule.buildCanonicalConversationMemory({conversation_id:ticket,company_id:company,source_message_id:uuid(30),commerce_state_revision:null,commerce_state:null,newest_first:[{id:uuid(30),role:'visitor',content:'Change only booking A to Saturday; keep booking B Friday. Defer the rental and cancel the add-on.',created_at:'2026-10-13T01:00:00Z'}],visitor_turn_count:120,source_created_at:'2026-10-13T01:00:00Z',next_memory_revision:7});
 Object.assign(memory,{current_goal:'Change booking A only',latest_corrections:['booking A Saturday; booking B Friday'],customer_preferences:['no auto renewal'],cancelled_or_superseded:[{key:'addon',value:'cancelled',authority:'customer',source_message_id:uuid(30),entity_id:null,region:null}],pending_actions:['rental deferred','booking A change not committed'],open_questions:['current rental policy']});
 assert.equal(memoryModule.isCanonicalConversationMemory(memory),true);const f=fixture('hi hi how do you do',{memory,mode:'400'}),before=JSON.stringify(f.tables.conversation_memory_state);assert.equal((await f.run()).body.response_route,'natural_small_talk');assert.equal(JSON.stringify(f.tables.conversation_memory_state),before);assert(!f.requests.some(x=>x.method==='POST'&&/memory|commerce/.test(x.url)));assert.equal(f.logs.length,0);
 const follow=fixture('Hi, what about the earlier rental option?',{memory,mode:'400'});const r=await follow.run();assert.equal(r.body.generation_success,false);assert(follow.requests.some(x=>x.url.includes('aiplatform')));assert.equal(JSON.stringify(follow.tables.conversation_memory_state[0].memory),JSON.stringify(memory));
 const rebuilt=memoryModule.buildCanonicalConversationMemory({previous:memory,conversation_id:ticket,company_id:company,source_message_id:source,commerce_state_revision:null,commerce_state:null,newest_first:[{id:source,role:'visitor',content:'hi hi how do you do',created_at:'2026-10-14T01:00:00Z'}],visitor_turn_count:121,source_created_at:'2026-10-14T01:00:00Z',next_memory_revision:8});assert.equal(rebuilt.current_goal,memory.current_goal);assert.deepEqual(rebuilt.latest_corrections,memory.latest_corrections);assert.deepEqual(rebuilt.cancelled_or_superseded,memory.cancelled_or_superseded);
});
test('new social grammar preserves R1, safety, control, revision and concurrent source persistence',async()=>{
 const r1=fixture('Hi, I do not want to repeat myself. Please connect me to a person.',{mode:'400'});assert.equal((await r1.run()).body.escalation_rule,'R1');assert(r1.requests.some(x=>/explicit_handoff_tx/.test(x.url)));assert.equal(r1.logs.length,0);
 const h=fixture('how do you do?',{human:true});assert.equal((await h.run()).body.skipped,'human_handling');assert.equal(h.commits.length,0);assert.equal(h.logs.length,0);
 const foreign=fixture('how do you do?');foreign.setForeign();assert.equal((await foreign.run()).status,400);assert.equal(foreign.commits.length,0);
 for(const result of ['superseded_source','stale_authorized_revision']){const f=fixture('how do you do?',{rpcResult:result});const r=await f.run();assert(r.body.skipped===result||r.status>=400);assert.equal(f.commits.length,0);}
 const f=fixture('Hi hi how do you do?');await Promise.all([f.run(),f.run()]);assert.equal(f.commits.length,1);assert.equal(f.logs.length,0);assert.equal(f.commits[0].metadata.b2_expected_company_id,company);
});
test('Widget renders actual social, clarification and technical recovery metadata without inventing resolution',async()=>{
 const f=fixture('how do you do?');await f.run();const status=f.load(path.join(root,'src/lib/widget-response-status.ts')).widgetResponseStatus;assert.equal(status(f.commits[0].metadata),'conversation');
 for(const mode of ['400','timeout','malformed']){const failed=fixture('Hi, how do you do refunds?',{mode});await failed.run();assert.equal(status(failed.commits[0].metadata),'technical recovery');assert.equal(failed.commits[0].metadata.generation_success,false);}
 assert.equal(status({response_route:'product_referent_clarification'}),'clarification');assert.equal(status({grounded:true}),'grounded');assert.equal(status({}),'response');assert.equal(status({grounded:true,degraded:true}),'technical recovery');
 assert(fs.readFileSync(path.join(root,'src/routes/_authenticated/console.widget-preview.tsx'),'utf8').includes('widgetResponseStatus(row.metadata)'));
});

const syntheticCompany='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec';
const enabledRun={C3_TEMP_UAT_RUN_ID:uuid(90),C3_TEMP_UAT_SOURCE_REVISION:'c3-3322877-bounded-uat-r2'};
for(const options of [{code:'UAT_AUTHORIZATION_ABSENT'},{env:{...enabledRun,C3_TEMP_UAT_SOURCE_REVISION:'wrong'},code:'UAT_SOURCE_OR_RUN_DENIED'},{env:enabledRun,rpcMissing:true,code:'UAT_DEPENDENCY_MISSING'}])test('actual synthetic business handler fails closed with exact nonretryable '+options.code,async()=>{
 const f=fixture('請查CW-SUL70BA是否有能源效益資料，唔好估級別。',{...options,company:syntheticCompany,retainedMemory:true});const before=JSON.stringify(f.tables.conversation_memory_state);const r=await f.run();
 assert.equal(r.body.generation_success,false);assert.equal(f.commits.length,1);const diagnostic=f.commits[0].metadata.execution_failure;assert.equal(diagnostic.code,options.code);assert.equal(diagnostic.stage,'admission');assert.equal(diagnostic.retryable,false);assert.equal(diagnostic.source_message_id,source);assert.equal(diagnostic.request_id,'commerce-semantic:'+source);assert.equal(f.requests.filter(x=>/aiplatform|context-search/.test(x.url)).length,0);assert.equal(JSON.stringify(f.tables.conversation_memory_state),before);assert.doesNotMatch(r.body.reply,/再試|try again|沒有資料|no match/);assert(!JSON.stringify([f.events,f.logs,r]).includes('PRIVATE-SECRET'));
});
test('actual synthetic interpreter positive executes status + countTokens + reserve + Vertex + finalize + canonical decode',async()=>{
 const f=fixture('unused',{company:syntheticCompany,env:enabledRun,semantic:{operation:'DEFER',confidence:0.98,delta_json:JSON.stringify({intent:'defer_service',entities:[{name:'photography session',kind:'service',confidence:0.98}],explicit_negations:['not cancelled']})}});
 const interpret=f.load(path.join(root,'supabase/functions/_shared/commerce-semantic-interpreter.ts')).interpretCommerceSemantics;
 const r=await interpret({company_id:syntheticCompany,conversation_id:ticket,source_message_id:source,latest:'Defer the photography session; do not cancel it',persistent_state_summary:'{}'});
 assert.equal(r.failure_code,null);assert.equal(r.frame.operation,'DEFER');assert.deepEqual(r.frame.explicit_negations,['not cancelled']);assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')).length,1);assert(f.requests.some(x=>x.url.includes('c3_uat_execution_status')));assert(f.requests.some(x=>x.url.includes('c3_uat_reserve_dispatch')));assert(f.requests.some(x=>x.url.includes('c3_uat_finalize_dispatch')));assert.equal(f.logs.at(-1).request_payload.outcome,'success');
});
for(const text of ['what your name','whats ur name?','有人吗？','有人嗎？','你喺唔喺度？','anybody there?','u there?'])test('actual synthetic identity/presence remains local without activated model: '+text,async()=>{
 const f=fixture(text,{company:syntheticCompany,retainedMemory:true});const before=JSON.stringify(f.tables.conversation_memory_state);const r=await f.run();assert.equal(r.body.degraded,undefined);assert.match(r.body.reply,/AI/);assert.equal(f.commits.length,1);assert.equal(f.requests.filter(x=>/aiplatform|context-search/.test(x.url)).length,0);assert.equal(JSON.stringify(f.tables.conversation_memory_state),before);assert.doesNotMatch(r.body.reply,/human.*online|真人.*在線|已轉交/);
});
test('presence after an unresolved failure acknowledges actual context without asserting handoff or resolution',async()=>{
 const f=fixture('有人吗？',{company:syntheticCompany});f.tables.messages.unshift({id:uuid(60),role:'assistant',conversation_id:ticket,content:'Earlier failed reply',is_recalled:false,created_at:'2026-10-13T01:00:00Z',metadata:{generation_success:false,degraded:true,response_route:'terminal_failure_recovery'}});const r=await f.run();assert.equal(r.body.response_route,'natural_presence');assert.match(r.body.reply,/仍未解[決决]/);assert.match(r.body.reply,/尚未[轉转]交/);assert(!f.requests.some(x=>/handoff_tx|aiplatform/.test(x.url)));
});
for(const text of ['what your name on the invoice','not your name; the product name','有人嗎？我要改為三件，取消加購','What does "anyone there" mean?','Hi, the account name is wrong'])test('minimal social contrast preserves business or quoted meaning: '+text,async()=>{
 const f=fixture(text,{company:syntheticCompany});const r=await f.run();assert.equal(r.body.generation_success,false);assert.equal(f.commits[0].metadata.execution_failure.code,'UAT_AUTHORIZATION_ABSENT');
});
test('synthetic explicit R1 and human-control do not depend on the missing model lease',async()=>{
 const f=fixture('Please connect me to a human now',{company:syntheticCompany});const r=await f.run();assert.equal(r.body.escalation_rule,'R1');assert.equal(r.body.handoff_persisted,true);assert(!f.requests.some(x=>/aiplatform/.test(x.url)));
 const h=fixture('what your name',{company:syntheticCompany,human:true});assert.equal((await h.run()).body.skipped,'human_handling');assert.equal(h.commits.length,0);
});
test('actual synthetic full business chain retains stage outcomes',async()=>{
 const f=fixture('請查CW-SUL70BA是否有能源效益資料，唔好估級別。',{company:syntheticCompany,env:enabledRun,fullChain:true});f.tables.conversation_commerce_state.push({conversation_id:ticket,company_id:syntheticCompany,revision:0,source_message_id:null,state:f.load(path.join(root,'supabase/functions/_shared/commerce-state-contract.ts')).createEmptyConversationCommerceState()});const r=await f.run();
 assert.equal(r.body.generation_success,undefined,JSON.stringify({r,events:f.events.slice(-5),requests:f.requests.slice(-4)}));
 assert(f.requests.some(x=>x.url.includes('context-search')),JSON.stringify({r,events:f.events.slice(-5),requests:f.requests.slice(-4)}));
 assert(JSON.stringify(f.commits[0]?.metadata ?? {}).includes('isolated-energy-chunk'),JSON.stringify({r,events:f.events.slice(-5),metadata:f.commits[0]?.metadata}));
 assert.notEqual(r.body.response_route,'terminal_failure_recovery',JSON.stringify(r));
});

for(const [options,stage,success] of [[{remoteDenied:true},'admission',false],[{kbNoMatch:true},'kb_no_match',true],[{kbHttp:true},'provider_http',false],[{kbBadJson:true},'decode',false]])test('actual synthetic KB adapter preserves '+stage+' separately from empty knowledge',async()=>{
 const f=fixture('unused',{company:syntheticCompany,env:enabledRun,fullChain:true,...options});const kb=f.load(path.join(root,'supabase/functions/_shared/kb-client.ts'));
 const r=await kb.fetchKBRag({query:'CW-SUL70BA energy label',top_k:5},{mode:'canonical',aiCompanyId:syntheticCompany,singaporeTenantId:'34'},kb.resolveKBEndpoint(),{uatContext:{conversationId:ticket,operationId:'kb:isolated'}});
 assert.equal(r.success,success,JSON.stringify(r));assert.equal(r.failure.stage,stage);if(options.remoteDenied){assert.equal(r.failure.code,'UAT_REMOTE_BOUND_UNVERIFIED');assert.equal(r.failure.retryable,false);assert(!f.requests.some(x=>x.url.includes('py.ebixmall.com')))}assert(!JSON.stringify(r).includes('PRIVATE-SECRET'));
});

test('malformed server service-account JSON is config failure, no provider retry and no secret logging',async()=>{
 const f=fixture('Check the published policy',{env:{GOOGLE_SERVICE_ACCOUNT_JSON:'PRIVATE-SECRET'}});const r=await f.run();assert.equal(r.body.generation_success,false);assert.equal(f.commits[0].metadata.execution_failure.code,'LLM_CONFIG_MISSING');assert.equal(f.commits[0].metadata.execution_failure.stage,'config');assert.equal(f.commits[0].metadata.retryable,false);assert(!f.requests.some(x=>x.url.includes('aiplatform')));assert(!JSON.stringify([f.logs,f.events,r]).includes('PRIVATE-SECRET'));
});

test('proposed no-RAG business QA entry executes actual synthetic handler, semantic Provider, source-bound calculation and reply persistence',async()=>{
 const text='用假設數字試算3個軟件席位：單價每位 HKD 80；設定費整單 HKD 40。只作數學試算，不查現行價，不執行任何交易。';
 const f=fixture(text,{company:syntheticCompany,env:enabledRun,fullChain:true,semantic:{operation:'ASK_CALCULATION',confidence:0.98,delta_json:JSON.stringify({intent:'customer_only_calculation',requested_facts:[]})}});const r=await f.run();assert.equal(r.body.response_route,'c3_historical_conditional_calculation');assert.match(r.body.reply,/HK\$ 280/);assert.equal(f.commits.length,1);assert.equal(f.commits[0].metadata.source_message_id,source);assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')).length,1);assert(!f.requests.some(x=>x.url.includes('context-search')));assert.notEqual(r.body.generation_success,false);assert.doesNotMatch(r.body.reply,/已付款|已啟用|已落單/);
});

for(const [error,code,stage,retryable] of [
 [Object.assign(new Error('PRIVATE-SECRET'),{code:'UAT_TIMEOUT_OUTCOME_UNKNOWN'}),'UAT_TIMEOUT_OUTCOME_UNKNOWN','timeout',false],
 [Object.assign(new Error('PRIVATE-SECRET'),{code:'UAT_AUTHORIZATION_ABSENT'}),'UAT_AUTHORIZATION_ABSENT','admission',false],
 [new DOMException('PRIVATE-SECRET','AbortError'),'LLM_TIMEOUT','timeout',true],
 [new Error('PRIVATE-SECRET'),'SEMANTIC_INTERPRETER_UNAVAILABLE','unexpected',false],
])test('outer handler failure retains '+code+' through guarded persistence without secret or invented resolution',async()=>{
 const f=fixture('Check the published policy',{unexpectedFailure:error});const r=await f.run();
 assert.equal(r.body.generation_success,false);assert.equal(f.commits.length,1);
 const failure=f.commits[0].metadata.execution_failure;assert.equal(failure.code,code);assert.equal(failure.stage,stage);assert.equal(failure.retryable,retryable);assert.equal(failure.source_message_id,source);
 assert.equal(r.body.failure.code,code);assert.equal(f.commits[0].metadata.transaction_mutation,'NONE');
 assert(!f.requests.some(x=>/aiplatform|context-search|handoff_tx/.test(x.url)));assert(!JSON.stringify([r,f.events,f.logs,f.commits]).includes('PRIVATE-SECRET'));
});
for(const result of ['human_control','superseded_source','tenant_mismatch','stale_authorized_revision'])test('outer failure recovery still rejects changed control '+result,async()=>{
 const f=fixture('Check the published policy',{unexpectedFailure:new DOMException('isolated','AbortError'),rpcResult:result});const r=await f.run();assert.equal(f.commits.length,0);assert(r.body.skipped===result||r.status>=400,JSON.stringify(r));assert(!f.requests.some(x=>/aiplatform|context-search/.test(x.url)));
});
for(const [options,stage] of [[{remoteDenied:true},'admission'],[{kbHttp:true},'provider_http'],[{kbBadJson:true},'decode']])test('complete business handler never turns KB '+stage+' into successful grounded resolution',async()=>{
 const f=fixture('請查CW-SUL70BA是否有能源效益資料，唔好估級別。',{company:syntheticCompany,env:{...enabledRun,ESC_ENABLE_S0:'false'},fullChain:true,...options});
 f.tables.conversation_commerce_state.push({conversation_id:ticket,company_id:syntheticCompany,revision:0,source_message_id:null,state:f.load(path.join(root,'supabase/functions/_shared/commerce-state-contract.ts')).createEmptyConversationCommerceState()});
 const r=await f.run();assert.equal(f.commits.length,1,JSON.stringify(r));const metadata=f.commits[0].metadata;assert.equal(metadata.generation_success,false);assert.equal(metadata.execution_failure.stage,stage);assert.notEqual(metadata.grounded,true);assert.equal(metadata.degraded,true);assert(!JSON.stringify([r,metadata,f.events]).includes('PRIVATE-SECRET'));assert(!f.requests.some(x=>/handoff_tx/.test(x.url)));
});

// Real Hosted P0 texts; provider outputs below are deterministic contract
// reproductions, not recovered model output or Hosted PASS.
const hostedP0 = [
 {id:'34c6be92-c1aa-468d-b0bc-10cad66508ad',text:'你好，我想換一部冷氣俾屋企兩位長者用。客廳180平方呎，預算HK$6,000，最重視夜晚安靜同慳電。未揀型號亦未落單；可否先幫我梳理選購取捨，同講應準備咩現場尺寸？暫時唔使查外部產品、報價或存貨。',product:'冷氣',facts:{room_area:{amount:180,unit:'平方呎'},budget:{amount:6000,unit:'HKD'}}},
 {id:'cefb3207-3fa2-4eed-bdbc-a090ee280493',text:'你好，我想買一部洗衣機俾三人家庭用，擺機位置闊600毫米、深560毫米，平時最在意洗衣時嘈音。你可以先幫我整理選機時應該考慮嘅取捨，同講下一步應補充咩資料嗎？',product:'洗衣機',facts:{household:3,width:{amount:600,unit:'mm'},depth:{amount:560,unit:'mm'}}},
 {id:'ed269091-dbed-45e6-9c6e-f2ef254a6b40',text:'我想買一部洗衣機，三人家庭使用，放機位置闊600毫米、深560毫米，預算HK$4,500。日常衣物比較多，對洗衣時嘈音特別在意。你會先問我邊一個問題？',product:'洗衣機',facts:{household:3,width:{amount:600,unit:'mm'},depth:{amount:560,unit:'mm'},budget:{amount:4500,unit:'HKD'}}},
];
const wireDelta=(delta,operation='ASK_FACT')=>({operation,confidence:0.97,delta_json:JSON.stringify(delta)});
for(const c of hostedP0)test('Hosted P0 deterministic whole handler reaches meaningful generation: '+c.id,async()=>{
 const answer='先量度擺放位置和出入通道，並確認門或窗開啟需要的空間。安靜與慳電都重要；你最常使用的時段是甚麼？';
 const f=fixture(c.text,{fullChain:true,answer,semantic:wireDelta({intent:'customer_guidance',entities:[{name:c.product,kind:'physical_product',confidence:0.97}],customer_facts:Object.entries(c.facts).map(([key,value])=>({key,value_json:JSON.stringify(value)})),requested_facts:[]})});
 const r=await f.run();
 assert.notEqual(r.body.generation_success,false,JSON.stringify({r,events:f.events.slice(-6),requests:f.requests.map(x=>x.url)}));
 assert.notEqual(r.body.response_route,'terminal_failure_recovery');
 assert(!/暫時未記低/.test(r.body.reply??''),JSON.stringify(r));
 assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits[0]?.content,answer,JSON.stringify({r,events:f.events.slice(-5)}));
 assert(f.requests.filter(x=>x.url.endsWith(':generateContent')).length>=2);
 assert(!f.requests.some(x=>x.url.includes('context-search')));
 const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
 assert.equal(f.commits.length,1);assert(f.tables.conversation_memory_state[0]?.memory.current_customer_facts.length>=Object.keys(c.facts).length);
});
for(const alias of ['lifecycle','correction','negations'])test('prompt/decoder incompatibility '+alias+' fails closed with fixed secret-free diagnostic',async()=>{
 const f=fixture('unused',{semantic:wireDelta({[alias]:'PRIVATE-SECRET user@example.invalid'})});
 const r=await f.load(path.join(root,'supabase/functions/_shared/commerce-semantic-interpreter.ts')).interpretCommerceSemantics({company_id:company,conversation_id:ticket,source_message_id:source,latest:'Please correct my requirements',persistent_state_summary:'{}'});
 assert.equal(r.frame,null);assert.equal(r.contract_rejection,'wire_delta_fields');assert(!JSON.stringify(r).includes('PRIVATE-SECRET'));
 const request=f.requests.find(x=>x.url.includes('aiplatform')).body.systemInstruction.parts[0].text;
 assert(request.includes('customer_correction'));assert(request.includes('semantic_values_v5'));assert(request.includes('customer_facts'));assert(request.includes('strict canonical vocabulary still applies'));assert(request.includes('containers'));assert(request.includes('numbers'));assert(!request.includes('only delta_json is JSON-encoded'));assert(!request.includes('customer_facts, lifecycle, correction, negations'));
});

test('Hosted Frankie correction then same-ticket Summary retains latest canonical Memory and passes unchanged B2',async()=>{
 const c=hostedP0[0];
 const initial=fixture(c.text,{fullChain:true,semantic:wireDelta({intent:'customer_guidance',entities:[{name:c.product,kind:'physical_product',confidence:0.97}],customer_facts:Object.entries(c.facts).map(([key,value])=>({key,value_json:JSON.stringify(value)})),requested_facts:[]})});await initial.run();
 const text='更正一下：客廳其實係150平方呎，預算改為HK$5,000。請記住最新資料，並用你理解嘅內容回覆我。';
 const f=fixture(text,{source:uuid(101),fullChain:true,previous:initial.tables,history:initial.tables.messages,semantic:wireDelta({customer_correction:true,customer_facts:[{key:'room_area',value_json:'{"amount":150,"unit":"平方呎"}'},{key:'budget',value_json:'{"amount":5000,"unit":"HKD"}'}],requested_facts:[]},'UPDATE_ITEM')});
 const r=await f.run();assert.notEqual(r.body.generation_success,false,JSON.stringify({r,events:f.events.slice(-5)}));assert.equal(f.commits.length,1);
 const memory=f.tables.conversation_memory_state[0].memory;
 assert.equal(memory.current_customer_facts.find(x=>x.key==='room_area').value.amount,150);assert.equal(memory.current_customer_facts.find(x=>x.key==='budget').value.amount,5000);
 assert(memory.latest_corrections.length>0);assert(memory.cancelled_or_superseded.length>0);
 const summary=fixture('請總結呢張對話嘅需求，同我最新更正嘅客廳面積及預算；唔好查外部資料。',{source:uuid(102),fullChain:true,previous:f.tables,history:f.tables.messages});
 const beforeSummary=JSON.stringify(summary.tables.conversation_memory_state);const sr=await summary.run();assert.equal(JSON.stringify(summary.tables.conversation_memory_state),beforeSummary);assert.equal(sr.status,200,JSON.stringify({sr,events:summary.events.slice(-5)}));assert.equal(typeof sr.body.reply,'string',JSON.stringify({sr,events:summary.events.slice(-5)}));assert.equal(summary.commits.length,1);assert.match(sr.body.reply,/150/);assert.match(sr.body.reply,/5[,.]?000/);assert(!summary.requests.some(x=>/aiplatform|context-search/.test(x.url)));
});

test('malformed compact output cannot commit customer state or hide a canonical rejection',async()=>{
 const f=fixture('更正一下：預算改為HK$5,000。',{fullChain:true,semantic:wireDelta({correction:true})});const r=await f.run();
 assert.equal(r.body.generation_success,false);assert.equal(f.tables.conversation_memory_state.length,0);assert.equal(f.tables.conversation_commerce_state.length,0);assert(!f.requests.some(x=>/c3_commit_conversation_memory_tx|upsert_conversation_commerce_state_v1/.test(x.url)));
 assert(JSON.stringify(f.events).includes('wire_delta_fields'));assert.equal(f.commits.length,1);await f.run();assert.equal(f.commits.length,1);
});

// New real Hosted failure receipt: ORIGINAL_PREVIEW_PROVIDER_DENIED during
// published_kb_lookup for this non-factual question. Valid model alternatives
// below reproduce the brittle routing class; raw Hosted model output was not retained.
for(const [intent,requested_facts] of [['ask_fact',[]],['explore_options',['selection_tradeoffs','site_measurements']],['customer_guidance',['installation_dimensions']]])test('Hosted 80b1afec full handler never sends general advice to KB: '+intent,async()=>{
 const text='你好，我想換冷氣給家中兩位長者使用。客廳180平方呎，預算HK$6,000，重視夜間安靜及省電。未選型號，請解釋選購時應如何取捨，並告訴我要量度哪些現場尺寸；暫時不用查外部產品或報價。';
 const answer='先量度安裝位置、出入通道及門窗開啟空間。夜間安靜與省電都重要，實際型號的聲量和耗電資料仍需核實。你們主要在甚麼時段使用冷氣？';
 const f=fixture(text,{fullChain:true,answer,semantic:wireDelta({intent,requested_facts,entities:[{name:'冷氣',kind:'physical_product',confidence:0.97}],customer_facts:[{key:'room_area',value_json:JSON.stringify({amount:180,unit:'平方呎'})},{key:'budget',value_json:JSON.stringify({amount:6000,unit:'HKD'})}]})});
 const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits[0]?.content,answer);assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance');assert(!f.requests.some(x=>x.url.includes('context-search')));assert(f.requests.filter(x=>x.url.endsWith(':generateContent')).length>=2);assert.equal(f.commits.length,1);
 const diagnostic=f.events.flat().filter(e=>typeof e==='string').map(e=>{try{return JSON.parse(e)}catch{return null}}).find(e=>e?.event==='customer_guidance_routing');assert.equal(diagnostic?.guidance_selected,true);assert(!JSON.stringify(diagnostic).includes(text));
 const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
});

// Actual Hosted efec7018: canonical semantic success, two requested targets,
// guidance_selected=false, then persisted execution-unavailable reply. Raw
// provider delta was not retained; these are valid deterministic reproductions.
for(const requested_facts of [['installation_dimensions','selection_steps'],['model_selection','onsite_checks']])test('Hosted efec7018 same-ticket correction advice generates a real-provider-path answer without KB: '+requested_facts.join(','),async()=>{
 const c=hostedP0[0];
 const initial=fixture(c.text,{fullChain:true,semantic:wireDelta({intent:'customer_guidance',entities:[{name:c.product,kind:'physical_product',confidence:0.97}],customer_facts:Object.entries(c.facts).map(([key,value])=>({key,value_json:JSON.stringify(value)})),requested_facts:[]})});await initial.run();
 const text='更正一下：客廳其實是150平方呎，預算改為HK$5,000；兩位長者和夜間安靜、省電的優先次序不變。請以這些最新資料說明量度及選購的下一步，不需要查型號或報價。';
 const answer='按最新客廳150平方呎及HK$5,000預算，先量度安裝位置和出入通道，記下兩位長者夜間使用的需要；實際型號的噪音和耗電資料仍需核實。';
 const f=fixture(text,{source:uuid(111),fullChain:true,answer,previous:initial.tables,history:initial.tables.messages,semantic:wireDelta({intent:'customer_context_update',customer_correction:true,customer_facts:[{key:'room_area',value_json:'{"amount":150,"unit":"平方呎"}'},{key:'budget',value_json:'{"amount":5000,"unit":"HKD"}'}],requested_facts},'UPDATE_ITEM')});
 const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits[0]?.content,answer,JSON.stringify({r,metadata:f.commits[0]?.metadata,state:f.tables.conversation_commerce_state,memory:f.tables.conversation_memory_state,events:f.events}));assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance');assert(!f.requests.some(x=>x.url.includes('context-search')));assert(f.requests.filter(x=>x.url.endsWith(':generateContent')).length>=2);assert.equal(f.commits.length,1);
 const memory=f.tables.conversation_memory_state[0].memory;assert.equal(memory.current_customer_facts.find(x=>x.key==='room_area').value.amount,150);assert.equal(memory.current_customer_facts.find(x=>x.key==='budget').value.amount,5000);assert(memory.latest_corrections.length>0);assert(memory.cancelled_or_superseded.length>0);assert(!memory.current_customer_facts.some(x=>x.key==='corrected_delivery_address'));
 const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
});

test('Hosted a6626087 Authe free-form prompt follows native compact grammar through actual handler and B2',async()=>{
 const text='你好，我想買一部洗衣機俾三人家庭用，擺機位置闊600毫米、深560毫米，平時最在意洗衣時嘈音。你可以先幫我整理選機時應該考慮嘅取捨，同講下一步應補充咩資料嗎？';
 const answer='三人家庭可以先考慮每次衣量、洗衣時段及可用空間的取捨。請量度門位和喉管所需空間；具體型號能否放進600毫米闊、560毫米深的位置仍須核對資料。你們主要在哪個時段洗衣？';
 const f=fixture(text,{fullChain:true,answer,semantic:wireDelta({intent:'customer_guidance',entities:[{name:'洗衣機',kind:'physical_product',confidence:0.97,constraints:{width:{amount:600,unit:'mm'},depth:{amount:560,unit:'mm'}}}],customer_facts:[{key:'family_size',value:3},{key:'priority',value:'quiet operation'}],requested_facts:[]})});
 const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits[0]?.content,answer,JSON.stringify({r,events:f.events}));assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance');assert(!f.requests.some(x=>x.url.includes('context-search')));assert(f.requests.filter(x=>x.url.endsWith(':generateContent')).length>=2);assert.equal(f.commits.length,1);const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
});

// Actual Hosted 4df129e5: valid semantic interpretation, guidance_selected=false,
// then execution unavailable. Model label/target below are safe reproductions;
// the raw Hosted delta was not retained.
test('Hosted 4df129e5 third-turn onsite observations generate through B2 without merchant lookup',async()=>{
 const initial=fixture('客廳180平方呎，預算HK$6,000，兩位長者重視安靜及省電。',{fullChain:true,semantic:wireDelta({intent:'customer_guidance',customer_facts:[{key:'room_area',value:{amount:180,unit:'平方呎'}},{key:'budget',value:{amount:6000,unit:'HKD'}}]})});await initial.run();
 const corrected=fixture('更正客廳150平方呎，預算HK$5,000；請說明選購取捨，不需要查型號或報價。',{source:uuid(121),fullChain:true,previous:initial.tables,history:initial.tables.messages,answer:'按最新150平方呎及HK$5,000預算，先量度現場位置。',semantic:wireDelta({intent:'customer_context_update',customer_correction:true,customer_facts:[{key:'room_area',value:{amount:150,unit:'平方呎'}},{key:'budget',value:{amount:5000,unit:'HKD'}}]},'UPDATE_ITEM')});await corrected.run();
 const text='如果長者對晚上風聲特別敏感，我去現場量度時應先記低哪幾項環境情況，才方便之後跟安裝師傅討論？請沿用最新面積及預算，暫時不用查商戶產品。';
 const answer='沿用最新150平方呎及HK$5,000預算，先記下夜間使用時段、休息位置與風口方向，再記下門窗和室外機位置。具體型號噪音及安裝可行性仍須核實。';
 const f=fixture(text,{source:uuid(122),fullChain:true,previous:corrected.tables,history:corrected.tables.messages,answer,semantic:wireDelta({intent:'ask_fact',requested_facts:['onsite_conditions']})});
 const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits[0]?.content,answer);assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance');assert(!f.requests.some(x=>x.url.includes('context-search')));assert(f.requests.some(x=>x.url.endsWith(':generateContent')));assert.equal(f.commits.length,1);
 const memory=f.tables.conversation_memory_state[0].memory;assert.equal(memory.current_customer_facts.find(x=>x.key==='room_area').value.amount,150);assert.equal(memory.current_customer_facts.find(x=>x.key==='budget').value.amount,5000);await f.run();assert.equal(f.commits.length,1);
});

for(const variant of ['valid-repair','still-invalid','merchant-claim','human-control','superseded-source','ordinary'])test('B2 known-context draft repair is bounded, revalidated and Preview-scoped: '+variant,async()=>{
 const text='我想選洗衣機，請解釋選機時應該考慮的取捨，暫時不用查型號。';
 const invalid='What product type do you need?';
 const answer='可先比較每次衣量、夜間使用時段和現場空間的取捨，並量度門位及喉管空間。具體型號的容量、噪音和適用性仍需核實。';
 const f=fixture(text,{fullChain:true,originalPreview:variant!=='ordinary',humanAfterFirstDraft:variant==='human-control',newSourceAfterFirstDraft:variant==='superseded-source',answers:[invalid,variant==='still-invalid'?invalid:variant==='merchant-claim'?'訂單已確認。':answer],semantic:wireDelta({intent:'customer_guidance',entities:[{name:'洗衣機',kind:'physical_product',confidence:0.97}],requested_facts:[]},'ADD_ITEM')});
 const r=await f.run();const modelCalls=f.requests.filter(x=>x.url.endsWith(':generateContent'));
 const repairCalls=modelCalls.filter(x=>x.body.systemInstruction?.parts?.[0]?.text?.includes('previous draft was NOT delivered'));
 assert.equal(repairCalls.length,['valid-repair','still-invalid','merchant-claim'].includes(variant)?1:0,JSON.stringify({r,events:f.events}));
 assert(!f.commits.some(x=>x.content===invalid),'B2-rejected first or second draft must never persist');
 if(variant==='valid-repair'){
  assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits.length,1);assert.equal(f.commits[0].content,answer);assert.equal(f.commits[0].metadata.b2_gate_contract,'executeB2PersistenceGate:allow_after_revalidation');
  assert.equal(modelCalls.length,3);await f.run();assert.equal(f.commits.length,1);assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')).length,3,'idempotent replay must not dispatch again');
 }else if(['human-control','superseded-source'].includes(variant)){assert.equal(f.commits.length,0);assert.equal(modelCalls.length,2);}
 else {assert(!f.commits.some(x=>x.content===answer||x.content==='訂單已確認。'));assert(modelCalls.length<=3);}
 assert(!f.requests.some(x=>x.url.includes('context-search')));
});

for(const text of ['Hello，屋企想換冷氣，兩間睡房加個客廳，應該點揀好？','公司要換視像會議服務，十位同事分兩地，應該點樣選擇？','租用工具之前，應從哪些方面比較？','另外個廳下晝西斜幾勁，揀機時要點考慮？'])test('historical selection speech act uses current generic generation: '+text,async()=>{
 const answer='先按實際使用情況比較選擇，再記下現場限制和優先需要；具體服務條款及產品資料仍須核實。';
 const f=fixture(text,{fullChain:true,answer,semantic:wireDelta({intent:'ask_fact',requested_facts:['selection_criteria']})});
 const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits[0]?.content,answer);assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance');assert(!f.requests.some(x=>x.url.includes('context-search')));
});

for(const repairCompany of ['3d6e17b5-ec79-4f75-aa7f-eaa824ff8493','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'])test('simultaneous rejected Preview drafts reserve at most one repair across overlapping handlers: '+repairCompany,async()=>{
 const text='我想選洗衣機，請解釋選機時應該考慮的取捨，暫時不用查型號。';
 const f=fixture(text,{fullChain:true,originalPreview:true,overlapClaims:true,company:repairCompany,answer:'What product type do you need?',repairAnswer:'可先比較每次衣量、使用時段及現場空間，再量度門位及喉管空間。具體規格仍需核實。',semantic:wireDelta({intent:'customer_guidance',entities:[{name:'洗衣機',kind:'physical_product',confidence:0.97}],requested_facts:[]},'ADD_ITEM')});
 const results=await Promise.all([f.run(),f.run()]);
 const repairs=()=>f.requests.filter(x=>x.url.endsWith(':generateContent')&&x.body.systemInstruction?.parts?.[0]?.text?.includes('previous draft was NOT delivered'));
 assert.equal(f.requests.filter(x=>x.method==='PATCH'&&x.url.includes('/messages?')).length,2,'both overlapping handlers must race on the same prior metadata, not run sequentially');
 assert.equal(repairs().length,1,JSON.stringify({results,repairs:repairs().length}));assert.equal(f.commits.length,1);assert.equal(f.commits[0].metadata.b2_known_context_repaired,true,JSON.stringify({results,commits:f.commits,events:f.events.slice(-15)}));
 await f.run();assert.equal(repairs().length,1);assert.equal(f.commits.length,1);
});

for(const boundary of ['humanAfterRepairClaim','newSourceAfterRepairClaim','claimFails'])test('reserved draft respects current control/source and unavailable CAS: '+boundary,async()=>{
 const f=fixture('請說明洗衣機選機取捨，暫時不用查型號。',{fullChain:true,originalPreview:true,[boundary]:true,answer:'What product type do you need?',repairAnswer:'先量度門位。',semantic:wireDelta({intent:'customer_guidance',entities:[{name:'洗衣機',kind:'physical_product',confidence:0.97}],requested_facts:[]},'ADD_ITEM')});
 await f.run();assert.equal(f.requests.filter(x=>x.body?.systemInstruction?.parts?.[0]?.text?.includes('previous draft was NOT delivered')).length,0);assert.equal(f.commits.length,0);
 if(boundary!=='claimFails'){const before=f.requests.filter(x=>x.url.endsWith(':generateContent')).length;await f.run();assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')).length,before,'reserved unknown/stale outcome must not dispatch again');}
});

test('a failed repaired draft remains durably reserved across replay',async()=>{
 const f=fixture('請說明洗衣機選機取捨，暫時不用查型號。',{fullChain:true,originalPreview:true,answers:['What product type do you need?','What product type do you need?'],semantic:wireDelta({intent:'customer_guidance',entities:[{name:'洗衣機',kind:'physical_product',confidence:0.97}],requested_facts:[]},'ADD_ITEM')});
 const first=await f.run();const before=f.requests.filter(x=>x.url.endsWith(':generateContent')).length;assert.equal(before,3);assert.equal(f.commits.length,1);assert.equal(f.commits[0].metadata.degraded,true,'a rejected repair is a failure receipt, never an AI answer');
 // Exercise real B2 rejection -> response clone -> terminal persistence. The
 // closed inner code must survive without customer values or supervisor paths.
 const meta=f.commits[0].metadata;
 assert.equal(meta.response_route,'terminal_failure_recovery');assert.equal(meta.source_error_code,'B2_SUPERVISION_BLOCKED');assert.equal(meta.retryable,false);assert.equal(meta.generation_success,false);
 assert.deepEqual(meta.execution_failure,{code:'B2_SUPERVISION_BLOCKED',stage:'canonical_validation',retryable:false,source_message_id:source,http_status:409,b2_code:'KNOWN_CONTEXT_RECONFIRMATION'});
 assert.deepEqual(first.body.failure,meta.execution_failure);assert.equal(first.body.retryable,false);
 assert.deepEqual(catalogueGateEvents(f).map(x=>[x.gate_decision,x.gate_code,x.commit_attempted]),[['block','KNOWN_CONTEXT_RECONFIRMATION',false],['block','KNOWN_CONTEXT_RECONFIRMATION',false],['allow','B2_ALLOW',true]]);
 assert.doesNotMatch(JSON.stringify({diagnostic:meta.execution_failure,code:meta.source_error_code,reply:f.commits[0].content}),/What product type do you need|洗衣機|entities\[|attributes\.|customer_facts|detail|reason|SEMANTIC_INTERPRETER_UNAVAILABLE/);
 const r=await f.run();assert.equal(r.status,200);assert.equal(r.body.idempotent,true);assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')).length,before);assert.equal(f.commits.length,1);
});

test('bounded repair can still ask a genuinely unprovided purposeful clarification',async()=>{
 const answer='可以先按每次衣量、使用時段和空間限制比較取捨，具體型號的資料仍須核實。你通常會在甚麼時段洗衣？';
 const f=fixture('請說明洗衣機選機取捨，暫時不用查型號。',{fullChain:true,originalPreview:true,answers:['What product type do you need?',answer],semantic:wireDelta({intent:'customer_guidance',entities:[{name:'洗衣機',kind:'physical_product',confidence:0.97}],requested_facts:[]},'ADD_ITEM')});
 await f.run();assert.equal(f.commits.length,1);assert.equal(f.commits[0].content,answer);assert.equal(f.commits[0].metadata.b2_gate_contract,'executeB2PersistenceGate:allow_after_revalidation');const prompt=f.requests.find(x=>x.body?.systemInstruction?.parts?.[0]?.text?.includes('previous draft was NOT delivered')).body.systemInstruction.parts[0].text;assert(prompt.includes('one purposeful clarification is allowed'));assert(prompt.includes('missing-slot name is not a supplied value'));
});

// Current Hosted 21745026 proves wire_delta_json rejection, not the precise
// retained provider bytes (those were not retained). Native objects below are
// deterministic transport/handler reproductions, never Hosted evidence.
for(const actorCompany of ['3d6e17b5-ec79-4f75-aa7f-eaa824ff8493','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'])test('native semantic multi-turn correction/Memory/Summary preserves original Preview authority '+actorCompany,async()=>{
 const initial=fixture('你好，我想換冷氣給家中兩位長者使用。客廳180平方呎，預算HK$6,000，重視夜間安靜及省電。未選型號，請解釋選購時應如何取捨，並告訴我要量度哪些現場尺寸；暫時不用查外部產品或報價。',{company:actorCompany,originalPreview:true,fullChain:true,answer:'先比較夜間低速聲量、使用時段與能源效益，再量度安裝位置、門窗、電源及去水路線；未有現場條件不能保證匹數。',semantic:{operation:'ASK_FACT',confidence:0.97,intent:'customer_guidance',customer_facts:[{key:'room_area',value:{amount:180,unit:'平方呎'}},{key:'budget',value:{amount:6000,unit:'HKD'}}],entities:[{name:'冷氣',kind:'physical_product',confidence:0.97}],requested_facts:[]}});
 const first=await initial.run();assert.equal(first.status,200);assert.notEqual(first.body.generation_success,false,JSON.stringify({first,events:initial.events.slice(-12)}));assert.equal(initial.commits.length,1);assert(initial.tables.conversation_commerce_state[0]?.state.entities.some(e=>e.attributes.room_sizes?.living_room==='180平方呎'),JSON.stringify({initial:initial.tables.conversation_commerce_state,events:initial.events.slice(-8)}));
 const correction=fixture('更正：客廳實際150平方呎，總預算改為HK$5,000；夜間安靜比初期價錢更重要。仍不查型號、價格或庫存。請按最新資料解釋省電與安靜如何取捨，並提醒我尚欠哪些現場條件。',{company:actorCompany,source:uuid(141),originalPreview:true,fullChain:true,previous:initial.tables,history:initial.tables.messages,answer:'以你最新150平方呎及HK$5,000要求，先比較夜間低速聲量，再看同等用途的能源效益；現場仍要確認安裝位置、日照、通風和去水，不能只按面積保證匹數。',semantic:{operation:'UPDATE_ITEM',confidence:0.97,intent:'customer_guidance',customer_correction:true,customer_facts:[{key:'room_area',value:{amount:150,unit:'平方呎'}},{key:'budget',value:{amount:5000,unit:'HKD'}},{key:'priority',value:'夜間安靜'}],requested_facts:[]}});
 const second=await correction.run();assert.equal(second.status,200);assert.notEqual(second.body.generation_success,false,JSON.stringify({second,commerce:correction.tables.conversation_commerce_state,memory:correction.tables.conversation_memory_state,events:correction.events.slice(-15)}));assert.equal(correction.commits.length,1);assert.match(correction.commits[0].content,/150/);assert.match(correction.commits[0].content,/5[,.]?000/);assert.equal(correction.commits[0].metadata.response_route,'customer_guidance');
 const memory=correction.tables.conversation_memory_state[0].memory;assert.equal(memory.current_customer_facts.find(x=>x.key==='room_area').value.amount,150);assert.equal(memory.current_customer_facts.find(x=>x.key==='budget').value.amount,5000);assert(memory.latest_corrections.length>0);assert(memory.cancelled_or_superseded.length>0);
 const before=correction.requests.length;const replay=await correction.run();assert.equal(replay.body.idempotent,true);assert.equal(correction.commits.length,1);assert.equal(correction.requests.slice(before).filter(x=>x.url.endsWith(':generateContent')).length,0);
 const summary=fixture('請總結同一張票的最新面積及預算，唔好查外部資料。',{company:actorCompany,source:uuid(142),originalPreview:true,fullChain:true,previous:correction.tables,history:correction.tables.messages});const sr=await summary.run();assert.equal(sr.status,200);assert.match(sr.body.reply,/150/);assert.match(sr.body.reply,/5[,.]?000/);assert(!summary.requests.some(x=>/aiplatform|context-search/.test(x.url)));
 assert(!initial.requests.concat(correction.requests).some(x=>x.url.includes('context-search')));
});
test('Hosted wire_delta_json failure remains closed with no state mutation and no paid repair attempt',async()=>{
 const f=fixture('更正：客廳實際150平方呎，預算HK$5,000。',{originalPreview:true,fullChain:true,semantic:{operation:'UPDATE_ITEM',confidence:0.97,delta_json:'{"customer_facts":['}});const r=await f.run();assert.equal(r.body.generation_success,false);assert(JSON.stringify(f.events).includes('wire_delta_json'));assert.equal(f.tables.conversation_commerce_state.length,0);assert.equal(f.tables.conversation_memory_state.length,0);assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')).length,1);assert.equal(f.commits.length,1);await f.run();assert.equal(f.commits.length,1);
});

for (const company of ['3d6e17b5-ec79-4f75-aa7f-eaa824ff8493','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec']) test('Hosted 180b0d7e guidance uses one non-conflicting concise draft through unchanged B2: '+company,async()=>{
 const text='客廳180平方呎，預算HK$6,000，兩位長者重視夜晚安靜與省電；請先解釋取捨及現場量度項目，不需要查產品。';
 const answer='按你提供的180平方呎及HK$6,000預算，可先比較夜間低速聲量、使用時段與能源效益。現場記下門窗尺寸、安裝位置、電源及去水路線；實際匹數和安裝可行性仍須核實。';
 const f=fixture(text,{company,originalPreview:true,fullChain:true,answer,semantic:{operation:'ASK_FACT',confidence:0.97,intent:'customer_guidance',customer_facts:[{key:'room_area',value:{amount:180,unit:'平方呎'}},{key:'budget',value:{amount:6000,unit:'HKD'}}],entities:[{name:'冷氣',kind:'physical_product',confidence:0.97}],requested_facts:['measurement_checklist']}});
 const r=await f.run(); assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits.length,1);assert.equal(f.commits[0].content,answer);assert.equal(f.commits[0].metadata.b2_gate_contract,'executeB2PersistenceGate:allow_after_revalidation');
 const calls=f.requests.filter(x=>x.url.endsWith(':generateContent'));assert.equal(calls.length,2,'normal draft must not depend on paid repair');
 const request=calls[1].body,system=request.systemInstruction.parts.map(p=>p.text).join('\n');assert(!system.includes('[C3 SERVICE PLAN — DATA, NOT CUSTOMER-FACING INSTRUCTIONS]'));assert(system.includes('Do not ask again for a supplied'));assert.equal(request.generationConfig.thinkingConfig.thinkingBudget,0);
 assert(!f.requests.some(x=>x.url.includes('context-search')));await f.run();assert.equal(f.commits.length,1);assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')).length,2);
});

for(const company of ['3d6e17b5-ec79-4f75-aa7f-eaa824ff8493','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'])for(const wording of ['explain how to prioritise simple training versus detailed permissions','tell me how to balance a short learning curve against detailed permissions'])test('Hosted 982e91d1 mixed correction keeps the actual advice question ahead of update-only recap: '+company+' '+wording,async()=>{
 const first=fixture('We run an online shop with 12 staff and HK$1,000 monthly budget. Explain selection trade-offs without looking up vendor plans.',{company,originalPreview:true,fullChain:true,answer:'Balance a short learning curve with appropriate team permissions.',semantic:{operation:'ASK_FACT',confidence:0.97,intent:'customer_guidance',customer_facts:[{key:'staff_count',value:12},{key:'budget',value:{amount:1000,unit:'HKD'}}],requested_facts:[]}});await first.run();
 const text='Correction: we now have 8 staff, the monthly budget is HK$800, and automatic renewal must be off. Without looking up vendor plans, '+wording+'.';const answer='For your updated team of 8 and HK$800 monthly budget, prioritise simple everyday workflows, then separate sensitive access by role. Keep automatic renewal off as requested; these are selection criteria, not verified vendor capabilities.';
 const f=fixture(text,{company,originalPreview:true,fullChain:true,source:uuid(161),previous:first.tables,history:first.tables.messages,answer,semantic:{operation:'UPDATE_ITEM',confidence:0.97,intent:'customer_context_update',customer_correction:true,customer_facts:[{key:'staff_count',value:8},{key:'budget',value:{amount:800,unit:'HKD'}},{key:'automatic_renewal',value:false}],requested_facts:['training_priority','permission_tradeoffs']}});
 const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits[0]?.content,answer);assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance');assert(f.requests.some(x=>x.url.endsWith(':generateContent')));assert(!f.requests.some(x=>x.url.includes('context-search')));const facts=f.tables.conversation_memory_state[0].memory.current_customer_facts;assert.equal(facts.find(x=>x.key==='staff_count').value,8);assert.equal(facts.find(x=>x.key==='automatic_renewal').value,false);assert.equal(facts.find(x=>x.key==='budget').value.amount,800);
});

for(const company of ['3d6e17b5-ec79-4f75-aa7f-eaa824ff8493','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'])test('Hosted ef60ad6d customer-only Summary uses strict ordinary B2 without an ineligible portfolio exemption: '+company,async()=>{
 const first=fixture('We run an online shop with 12 staff and HK$1,000 monthly budget. Explain trade-offs without looking up vendor plans.',{company,originalPreview:true,fullChain:true,answer:'Balance simple training with appropriate permissions.',semantic:{operation:'ASK_FACT',confidence:0.97,intent:'customer_guidance',customer_facts:[{key:'team_size',value:{amount:12,unit:'person'}},{key:'monthly_budget',value:{amount:1000,unit:'HKD'}}],requested_facts:[]}});await first.run();
 const updated=fixture('Correction: 8 staff, HK$800 per month, automatic renewal off. Explain how to balance training and permissions without looking up vendor plans.',{company,originalPreview:true,fullChain:true,source:uuid(171),previous:first.tables,history:first.tables.messages,answer:'For 8 staff and HK$800 per month, start with simple training and separate sensitive permissions; leave automatic renewal off.',semantic:{operation:'UPDATE_ITEM',confidence:0.97,intent:'customer_guidance',customer_correction:true,customer_facts:[{key:'team_size',value:{amount:8,unit:'person'}},{key:'monthly_budget',value:{amount:800,unit:'HKD'}},{key:'automatic_renewal',value:false}],requested_facts:[]}});await updated.run();
 const before=JSON.stringify(updated.tables.conversation_commerce_state[0]);const f=fixture('Please summarise our current requirements in this ticket.',{company,originalPreview:true,fullChain:true,source:uuid(172),previous:updated.tables,history:updated.tables.messages});const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits.length,1);assert.equal(f.commits[0].metadata.response_route,'commerce_state_answer',JSON.stringify({r,events:f.events,metadata:f.commits[0].metadata}));assert.equal(f.commits[0].metadata.recap_read_only,undefined);assert.equal(f.commits[0].metadata.b2_gate_contract,'executeB2PersistenceGate:allow_after_revalidation');assert.match(f.commits[0].content,/800/);assert.match(f.commits[0].content,/8/);assert.equal(JSON.stringify(f.tables.conversation_commerce_state[0]),before);assert(!f.requests.some(x=>/aiplatform|context-search/.test(x.url)));
});

for(const company of ['3d6e17b5-ec79-4f75-aa7f-eaa824ff8493','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'])test('Hosted 180b0d7e exact no-research wording must not deterministically pause the customer requirement: '+company,async()=>{
 const text='你好，屋企有兩位長者，客廳180平方呎，預算HK$6,000。想換冷氣，最重視夜晚安靜同慳電。未揀型號，請先講選購取捨及要量度哪些現場尺寸，暫時唔使查外部產品或報價。';
 const f=fixture(text,{company,originalPreview:true,fullChain:true,answer:'按180平方呎及HK$6,000預算，先比較夜間安靜與能源效益，再量度門窗、安裝位置、電源及去水路線，實際適用性仍需核實。',semantic:{operation:'ASK_FACT',confidence:0.97,intent:'customer_guidance',customer_facts:[{key:'room_area',value:{amount:180,unit:'平方呎'}},{key:'budget',value:{amount:6000,unit:'HKD'}}],entities:[{name:'冷氣',kind:'physical_product',confidence:0.97}],requested_facts:[]}});const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert(f.tables.conversation_commerce_state[0].state.entities.every(e=>e.status!=='deferred'&&e.status!=='cancelled'),'no-research must not pause/cancel the product');
});

for(const text of ['想換冷氣，兩間睡房加個客廳，應該點揀好？','想换空调，两间卧室和一个客厅，应该怎么选择？','I want to replace the air conditioning in two bedrooms and a living room. How should I choose?'])for(const ambiguous of [false,true])for(const target of ['','suitable_capacity','model_selection_guidance'])test('Frankie 59b8/56d9/8870 guidance speech act is stable across valid equivalent frames: '+JSON.stringify({text,ambiguous,target}),async()=>{
 const f=fixture(text,{originalPreview:true,fullChain:true,answer:'Compare the intended usage, measured space, comfort priorities and installation constraints. Please provide the area of each room before a specific sizing decision; no model recommendation is verified.',semantic:{operation:'ASK_FACT',confidence:0.96,intent:'customer_guidance',requested_facts:target?[target]:[],ambiguity:{is_ambiguous:ambiguous,reason:ambiguous?'Room sizes are not yet known':null}}});const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance',JSON.stringify(f.events));assert(!f.requests.some(x=>x.url.includes('context-search')));
});
for(const text of ['我想问订单状况','我想查吓張訂單而家去到邊','What is the status of my order?'])test('Frankie f017 personal order enquiry uses truthful order intake, never product KB: '+text,async()=>{
 const f=fixture(text,{originalPreview:true,fullChain:true,semantic:{operation:'ASK_FACT',confidence:0.97,intent:'order_status',requested_facts:['order_status']}});const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert(f.commits.length===1);assert.match(f.commits[0].content,/參考編號|参考编号|reference number/i);assert.match(f.commits[0].content,/未能|無法|无法|cannot/i);assert(!f.requests.some(x=>x.url.includes('context-search')));assert(!f.commits[0].metadata.degraded);
});

test('Frankie 4123 paired window dimensions persist as one source-bound observation and ask only missing room scope',async()=>{
 let previous;let history=[];let n=210;for(const text of ['想換冷氣，兩間睡房加個客廳，應該點揀好？','細房約80呎，大房100呎，客廳就180呎。','三個位都係窗口位，而家原本用緊嘅都係窗口機。','全屋都沒有西斜']){const f=fixture(text,{originalPreview:true,fullChain:true,source:uuid(n++),previous,history,answer:'可先比較舒適度、使用時段與安裝條件；產品適用性仍須核實。',semantic:{operation:'ASK_FACT',confidence:0.97,intent:'customer_guidance',requested_facts:[]}});await f.run();previous=f.tables;history=f.tables.messages;}
 const f=fixture('大約 70 (W) x 55 (H) cm',{originalPreview:true,fullChain:true,source:uuid(220),previous,history,semantic:{operation:'NO_STATE_CHANGE',confidence:0.97,intent:'customer_context_update',requested_facts:[]}});const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));const ac=f.tables.conversation_commerce_state[0].state.entities.find(e=>e.category==='air_conditioner');assert.equal(ac.attributes.window_opening_observation.width_mm,700);assert.equal(ac.attributes.window_opening_observation.height_mm,550);assert.equal(ac.attributes.window_opening_observation.source_message_id,uuid(220));assert.equal(ac.attributes.window_opening_observation.scope,null);assert.equal(ac.attributes.room_window_openings,undefined);assert.match(f.commits[0]?.content,/700/);assert.match(f.commits[0]?.content,/550/);assert.match(f.commits[0]?.content,/邊間房|哪个房间|Which room/);assert(!f.requests.some(x=>x.url.includes('context-search')));assert(!f.commits[0]?.metadata.degraded);
 const scoped=fixture('係細房嗰個窗口。',{originalPreview:true,fullChain:true,source:uuid(221),previous:f.tables,history:f.tables.messages,semantic:{operation:'NO_STATE_CHANGE',confidence:0.97,intent:'customer_context_update',requested_facts:[]}});await scoped.run();const after=scoped.tables.conversation_commerce_state[0].state.entities.find(e=>e.category==='air_conditioner');assert.equal(after.attributes.room_window_openings.small_bedroom.width_mm,700);assert.equal(after.attributes.room_window_openings.small_bedroom.source_message_id,uuid(220));assert.equal(after.attributes.room_window_openings.living_room,undefined);assert.match(scoped.commits[0]?.content,/細房/);assert(!scoped.commits[0]?.metadata.degraded);
});

for(const op of ['ASK_FACT','NO_STATE_CHANGE'])for(const ambiguous of [false,true])test('Frankie general guidance keeps existing history and same-ticket state with alternate semantic operation '+op+' ambiguity '+ambiguous,async()=>{
 const first=fixture('想換冷氣，兩間睡房加個客廳，應該點揀好？',{originalPreview:true,fullChain:true,answer:'先考慮使用時間、房間面積及安裝條件。',semantic:{operation:'ASK_FACT',confidence:0.97,intent:'customer_guidance',requested_facts:[]}});await first.run();
 const f=fixture('想換冷氣，兩間睡房加個客廳，應該點揀好？',{originalPreview:true,fullChain:true,source:uuid(230),previous:first.tables,history:first.tables.messages,answer:'可以先比較舒適度、耗電與安裝條件；具體匹數及型號仍須核實。',semantic:{operation:op,confidence:0.96,intent:'ask_for_advice',requested_facts:['cooling_requirements'],ambiguity:{is_ambiguous:ambiguous,reason:ambiguous?'Room measurements not known':null}}});await f.run();assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance');assert(!f.requests.some(x=>x.url.includes('context-search')));assert.equal(f.tables.conversation_commerce_state[0].company_id,first.tables.conversation_commerce_state[0].company_id);
});

for(const [business,latest,values] of [
 ['rooms','細房約80呎，大房100呎，客廳就180呎。',{small_room:{amount:80,unit:'sq_ft'},large_room:{amount:100,unit:'sq_ft'},living_room:{amount:180,unit:'sq_ft'}}],
 ['service','The meeting room is 80 sq ft, the training room 100, and the lobby 180.',{meeting_room:{amount:80,unit:'sq_ft'},training_room:{amount:100,unit:'sq_ft'},lobby:{amount:180,unit:'sq_ft'}}],
 ['subscription','更正：訂閱席位是0，不自動續期，租賃日期未定。',{subscription_seats:0,auto_renew:false,rental_date:null}],
])test('actual complete handler sends constrained typed schema, decodes '+business+' and preserves source-bound Memory without paid repair',async()=>{
 const semantic={context_encoding:'typed_paths_v1',operation:'NO_STATE_CHANGE',confidence:0.98,intent:'customer_context_update',customer_correction:business==='subscription',customer_facts:Object.entries(values).map(([key,value])=>({key,value_nodes:typedContextNodes(value)}))};
 const f=fixture(latest,{originalPreview:true,fullChain:true,semantic});const r=await f.run();
 assert.equal(r.status,200,JSON.stringify(r));
 const requests=f.requests.filter(x=>x.url.endsWith(':generateContent')&&x.body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.'));
 assert.equal(requests.length,1);const config=requests[0].body.generationConfig;
 assert.equal(config.responseMimeType,'application/json');assert.deepEqual(config.responseSchema.properties.context_encoding.enum,['semantic_values_v5']);
 for(const list of ['containers','strings','numbers','booleans'])assert.equal(config.responseSchema.properties[list].items.properties.path.maxItems,'6');
 assert(!JSON.stringify(f.events).includes('canonical_entity_bounds'));assert(!f.requests.some(x=>x.body?.systemInstruction?.parts?.[0]?.text?.includes('previous draft was NOT delivered')));
 const memory=f.tables.conversation_memory_state.at(-1)?.memory;assert(memory,JSON.stringify({r,events:f.events.slice(-8)}));
 for(const [key,value] of Object.entries(values)){const fact=memory.current_customer_facts.find(x=>x.key===key);assert(fact,JSON.stringify(memory));assert.deepEqual(fact.value,value);assert.equal(fact.source_message_id,source);}
});

test('actual complete handler retains original depth4 failure as rejection; schema does not relax canonical or dispatch a repair',async()=>{
 const f=fixture('Customer provides new measurements',{originalPreview:true,fullChain:true,semantic:{operation:'UPDATE_ITEM',confidence:0.98,entities:[{name:'generic rental',kind:'rental',confidence:0.98,attributes:{room:{measurement:{area:{amount:80}}}}}]}});
 await f.run();assert(JSON.stringify(f.events).includes('canonical_entity_bounds'));assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')).length,1);assert.equal(f.commits.length,1);assert.equal(f.commits[0].metadata.generation_success,false);assert.equal(f.commits[0].metadata.degraded,true);assert.equal(f.tables.conversation_memory_state.length,0);
});

test('typed semantic same-ticket area/correction/Summary uses latest Memory without erasing prior facts or repeated goal intake',async()=>{
 const seed=fixture('想換冷氣，兩間睡房加個客廳，應該點揀好？',{originalPreview:true,fullChain:true,answer:'先比較每個房間的使用時間、面積及安裝限制。',semantic:{context_encoding:'typed_paths_v1',operation:'ASK_FACT',confidence:0.98,intent:'customer_guidance',requested_facts:[]}});await seed.run();
 const first=fixture('細房約80呎，大房100呎，客廳就180呎。',{originalPreview:true,fullChain:true,source:uuid(410),previous:seed.tables,history:seed.tables.messages,semantic:{context_encoding:'typed_paths_v1',operation:'NO_STATE_CHANGE',confidence:0.98,intent:'customer_context_update',customer_facts:[['small_room_area',80],['large_room_area',100],['living_room_area',180]].map(([key,amount])=>({key,value_nodes:typedContextNodes({amount,unit:'sq_ft'})}))}});const area=await first.run();assert.equal(area.status,200);assert.equal(first.commits[0].metadata.degraded,undefined,JSON.stringify(area));assert.doesNotMatch(area.body.reply,/你今次最想完成哪一件事|你这次最想完成哪一件事|What would you most like to complete now/);
 const corrected=fixture('更正：細房改為90平方呎，其餘不變。',{originalPreview:true,fullChain:true,source:uuid(411),previous:first.tables,history:first.tables.messages,semantic:{context_encoding:'typed_paths_v1',operation:'UPDATE_ITEM',confidence:0.98,intent:'customer_context_update',customer_correction:true,customer_facts:[{key:'small_room_area',value_nodes:typedContextNodes({amount:90,unit:'sq_ft'})}]}});await corrected.run();
 const facts=corrected.tables.conversation_memory_state.at(-1).memory.current_customer_facts;assert.equal(facts.find(x=>x.key==='small_room_area').value.amount,90);assert.equal(facts.find(x=>x.key==='large_room_area').value.amount,100);assert.equal(facts.find(x=>x.key==='living_room_area').value.amount,180);assert.equal(facts.find(x=>x.key==='small_room_area').source_message_id,uuid(411));
 const summary=fixture('請總結我最新需要，先唔使查產品。',{originalPreview:true,fullChain:true,source:uuid(412),previous:corrected.tables,history:corrected.tables.messages,semantic:{context_encoding:'typed_paths_v1',operation:'ASK_FACT',confidence:0.98,intent:'requirements_recap',requested_facts:[]}});const r=await summary.run();assert.equal(r.status,200,JSON.stringify(r));assert.match(r.body.reply,/90/);assert.match(r.body.reply,/100/);assert.match(r.body.reply,/180/);assert.doesNotMatch(r.body.reply,/(^|\D)80(?:\D|$)/);assert(!summary.requests.some(x=>x.url.includes('context-search')));assert.equal(summary.commits.length,1);const replay=await summary.run();assert.equal(replay.body.idempotent,true);assert.equal(summary.commits.length,1);assert.equal(summary.requests.filter(x=>x.url.includes('aiplatform')).length,0);
});
test('Director raw original RAG JSON runs complete Preview generation and guarded persistence without fabricated version',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const answer='這份「四電一腦」生產者責任計劃資料列出空調機、洗衣機、雪櫃、電視機、電腦、列印機、掃描器及顯示器，並說明相同種類及數量舊電器的除舊服務。';
 const f=fixture(sample.query,{originalPreview:true,fullChain:true,originalRagResponse:sample,answer,semantic:wireDelta({intent:'merchant_policy',requested_facts:['四電一腦'],entities:[]})});
 const r=await f.run();assert.equal(r.status,200,JSON.stringify({r,events:f.events.slice(-6)}));assert.equal(f.commits.length,1,JSON.stringify(r));assert.equal(f.commits[0].content,answer,JSON.stringify({r,metadata:f.commits[0].metadata,events:f.events}));assert.notEqual(r.body.response_route,'terminal_failure_recovery');
 assert(f.requests.some(q=>q.url.includes('/rag/context-search')));assert(f.requests.some(q=>q.url.endsWith(':generateContent')&&!q.body.systemInstruction?.parts?.[0]?.text?.includes('commerce semantic interpreter')));
 assert.equal(f.commits[0].metadata.reference_authority.provenance.currentness,'unknown');assert.equal(f.commits[0].metadata.reference_authority.provenance.version,null);assert.equal(f.commits[0].metadata.citations[0].relevance,'low');assert.equal(f.commits[0].metadata.citation_lineage.evidence_state,'unknown');
});

test('Hosted d268773f branch regression: constrained semantic request reaches original RAG and guarded delivery in one attempt',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const f=fixture('什麼是四電一腦？',{originalPreview:true,fullChain:true,enforceSchemaBranchBudget:true,originalRagResponse:sample,
  semantic:{context_encoding:'typed_paths_v1',operation:'ASK_FACT',confidence:0.98,intent:'merchant_policy',requested_facts:['四電一腦'],entities:[]},
  answer:'這份「四電一腦」生產者責任計劃資料列出空調機、洗衣機、雪櫃、電視機、電腦、列印機、掃描器及顯示器，並說明相同種類及數量舊電器的除舊服務。'});
 const r=await f.run();assert.equal(r.status,200);assert.equal(f.commits.length,1);assert.equal(f.commits[0].metadata.degraded,undefined);
 assert.equal(f.requests.filter(x=>x.url.includes('context-search')).length,1);
 assert.equal(f.requests.filter(x=>x.body?.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.')).length,1);
 assert.match(f.commits[0].content,/四電一腦/);assert.equal(f.commits[0].metadata.reference_authority.provenance.currentness,'unknown');
 assert.equal(f.commits[0].metadata.citations[0].relevance,'low');
 assert(f.requests.some(x=>x.url.endsWith(':generateContent')&&!x.body.systemInstruction?.parts?.[0]?.text?.includes('commerce semantic interpreter')));
 const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
});

test('v239 actual failure class: shallow provider transport -> canonical merchant request -> original RAG -> B2 -> one persisted answer',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const answer='這份「四電一腦」生產者責任計劃資料列出空調機、洗衣機、雪櫃、電視機、電腦、列印機、掃描器及顯示器，並說明相同種類及數量舊電器的除舊服務。';
 const f=fixture('請根據知識庫解釋四電一腦及舊電器回收安排',{originalPreview:true,fullChain:true,enforceSmallTransport:true,originalRagResponse:sample,answer,
  semantic:providerWire({intent:'merchant_policy',requested_facts:['四電一腦','舊電器回收安排']},'ASK_FACT')});
 const r=await f.run();assert.equal(r.status,200);assert.equal(f.commits.length,1);assert.equal(f.commits[0].content,answer);assert(!f.commits[0].metadata.degraded);
 assert.equal(f.requests.filter(x=>x.url.includes('context-search')).length,1);assert.equal(f.commits[0].metadata.reference_authority.provenance.currentness,'unknown');
 assert.equal(f.commits[0].metadata.b2_gate_contract,'executeB2PersistenceGate:allow_after_revalidation');
 const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
});

for(const question of ['什麼是四電一腦？請根據現行知識庫資料解釋。','什麼是四電一腦？'])test('v240 two Hosted wrong_topic failures: descriptive ASK_FACT reaches evidence prompt, citations and exactly-once B2 commit: '+question,async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const answer='這份「四電一腦」資料列出空調機、洗衣機、雪櫃、電視機、電腦、列印機、掃描器及顯示器。';
 const f=fixture(question,{originalPreview:true,fullChain:true,enforceSmallTransport:true,originalRagResponse:sample,answer,
  semantic:providerWire({intent:'customer_guidance',requested_facts:['definition of 四電一腦']},'ASK_FACT')});
 const r=await f.run();assert.equal(r.status,200);assert.equal(f.commits.length,1);assert.equal(f.commits[0].content,answer,JSON.stringify(f.commits[0].metadata));
 assert.equal(f.requests.filter(x=>x.url.includes('context-search')).length,1);
 const generation=f.requests.filter(x=>x.url.endsWith(':generateContent')&&!x.body.systemInstruction?.parts?.[0]?.text?.includes('commerce semantic interpreter'));
 assert(generation.some(x=>(x.body.systemInstruction?.parts??[]).concat(...(x.body.contents??[]).map(c=>c.parts??[])).some(p=>p.text?.includes(sample.selected_documents[0].evidence[0].content.replace('3480-9091','[PHONE]')))),'selected full-content evidence enters final generation');
 assert.equal(f.commits[0].metadata.reference_authority.provenance.currentness,'unknown');assert.equal(f.commits[0].metadata.reference_authority.provenance.version,null);
 assert.equal(f.commits[0].metadata.citations[0].document_id,sample.selected_documents[0].document_id);
 assert.equal(f.commits[0].metadata.b2_gate_contract,'executeB2PersistenceGate:allow_after_revalidation');
 const dispatches=()=>f.requests.filter(x=>x.url.includes('context-search')||x.url.includes('aiplatform')).length;const beforeReplay=dispatches();const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);assert.equal(dispatches(),beforeReplay);
});

for(const question of ['什麼是四電一腦？','四電一腦係咩？','可以解釋一下四電一腦嗎？','什麼是四電一腦？請根據現行知識庫資料解釋。','What is the meaning of this recycling scheme?','你頭先講嗰個計劃係乜？','免費除舊服務係咩？','除舊服務須知包括甚麼？'])test('17:00 Hosted regression: natural factual authority survives empty NO_STATE_CHANGE frame after a cited answer: '+question,async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const answer='資料列出空調機、洗衣機、雪櫃、電視機、電腦、列印機、掃描器及顯示器，並提供相同種類及數量舊電器的除舊服務。';
 const seed=fixture(sample.query,{originalPreview:true,fullChain:true,originalRagResponse:sample,answer,semantic:providerWire({intent:'customer_guidance',requested_facts:['definition of 四電一腦']},'ASK_FACT')});await seed.run();
 const f=fixture(question,{originalPreview:true,fullChain:true,previous:seed.tables,history:seed.tables.messages,source:uuid(850),originalRagResponse:sample,answer,
  semantic:providerWire({intent:'customer_guidance',requested_facts:[]},'NO_STATE_CHANGE')});
 const r=await f.run();assert.equal(r.status,200);assert.equal(f.commits[0]?.content,answer,JSON.stringify(f.commits[0]?.metadata));assert.equal(f.requests.filter(x=>x.url.includes('context-search')).length,1,'fresh legal retrieval, not stale citation reuse');
 assert.equal(f.commits[0].metadata.b2_gate_contract,'executeB2PersistenceGate:allow_after_revalidation');assert.equal(f.commits[0].metadata.citation_lineage.selected_document_id,sample.selected_documents[0].document_id);
 const before=f.requests.filter(x=>x.url.includes('context-search')).length;await f.run();assert.equal(f.commits.length,1);assert.equal(f.requests.filter(x=>x.url.includes('context-search')).length,before);
});

for(const question of ['What is cloud tenancy?','可以解釋一下訂閱席位嗎？','保單審核係咩？'])test('generic unknown factual subject gets legal retrieval and honest no-match, never borrowed unrelated citation: '+question,async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const f=fixture(question,{originalPreview:true,fullChain:true,originalRagResponse:sample,semantic:providerWire({intent:'customer_guidance',requested_facts:[]},'NO_STATE_CHANGE')});
 await f.run();assert.equal(f.requests.filter(x=>x.url.includes('context-search')).length,1);assert.equal(f.commits[0].metadata.response_route,'kb_no_current_evidence');assert.equal(f.commits[0].metadata.citations.length,0);
});
test('uncertain factual referent requires clarification and cannot silently borrow prior source',async()=>{
 const f=fixture('可以解釋嗰兩個入面嗰個嗎？',{originalPreview:true,fullChain:true,semantic:providerWire({intent:'customer_guidance',requested_facts:[],ambiguity:{is_ambiguous:true,reasons:['two plausible subjects'],clarification_question:'Which of the two subjects?'}},'NO_STATE_CHANGE')});
 await f.run();assert(!f.requests.some(x=>x.url.includes('context-search')));assert(f.commits.length===1);assert.notEqual(f.commits[0].metadata.knowledge_state,'lookup_required');
});
for(const [industry,values] of [
 ['subscription',{subscription_seats:0,auto_renew:false,renewal_date:null}],
 ['service',{site_dimensions:{width:70,height:55,unit:'cm'},room:null,west_sun:false}],
 ['rental',{rental_quantity:{amount:2,unit:'units'},rental_date:null,delivery_required:false}],
])test('complete handler receives new transport, preserves '+industry+' typed facts, latest correction and same-ticket Summary',async()=>{
 const question={subscription:'I need a subscription with 0 seats, no automatic renewal and no renewal date yet. Please give general planning guidance without checking plans or prices.',service:'The site opening is 70 W by 55 H cm, room not yet confirmed, and there is no west sun. Please explain how to prepare without checking products.',rental:'I need 2 rental units, date not decided and no delivery required. Please explain how to plan the rental without checking products or prices.'}[industry];
 const answer={subscription:'You specified zero seats, no automatic renewal and an undecided renewal date. First decide which people actually need access before committing to a plan.',service:'Your opening is 70 cm wide by 55 cm high, with no west sun. Confirm which room this opening belongs to before deciding on installation needs.',rental:'You need two rental units, with the date undecided and no delivery required. Confirm the use dates before committing to the rental.'}[industry];
 const f=fixture(question,{originalPreview:true,fullChain:true,enforceSmallTransport:true,answer,
  semantic:providerWire({intent:'customer_guidance',customer_facts:Object.entries(values).map(([key,value])=>({key,value})),...(industry==='rental'?{entities:[{name:'rental unit',kind:'rental',confidence:0.98,quantity:2}]}:{})})});
 const r=await f.run();assert.equal(r.status,200);assert.equal(f.commits.length,1);assert(!f.commits[0].metadata.degraded,JSON.stringify({r,events:f.events.slice(-6),metadata:f.commits[0].metadata}));
 const facts=f.tables.conversation_memory_state.at(-1).memory.current_customer_facts;
 for(const [key,value] of Object.entries(values)){const fact=facts.find(x=>x.key===key);assert(fact);assert.deepEqual(fact.value,value);assert.equal(fact.source_message_id,source);}
 assert.equal(f.requests.filter(x=>x.body?.systemInstruction?.parts?.[0]?.text?.includes('commerce semantic interpreter')).length,1);
 const key=Object.keys(values)[0],newValue={subscription:5,service:{width:75,height:55,unit:'cm'},rental:{amount:3,unit:'units'}}[industry];
 const correctionText={subscription:'Correction from 0 subscription seats to 5 subscription seats. How should I prepare?',service:'Correction: the width is 75, not 70; keep the height and unit as before. Please give general preparation guidance.',rental:'Correction from 2 rental units to 3 rental units. How should I prepare?'}[industry];
 const corrected=fixture(correctionText,{originalPreview:true,fullChain:true,enforceSmallTransport:true,previous:f.tables,history:f.tables.messages,source:uuid(810),
  answer:{subscription:'For planning, use 5 subscription seats with no automatic renewal. Decide the renewal date before committing.',service:'Use the corrected 75 cm width and 55 cm height for planning. Record surrounding obstructions and access before deciding on installation.',rental:'For planning, use 3 rental units without delivery. Confirm the dates before committing.'}[industry],
  semantic:providerWire({intent:'customer_guidance',customer_correction:true,customer_facts:[{key,value:newValue}],...(industry==='rental'?{entities:[{name:'rental unit',kind:'rental',confidence:0.98,quantity:3}]}:{})})});
 const cr=await corrected.run();assert.equal(cr.status,200);assert(!corrected.commits[0].metadata.degraded,JSON.stringify({cr,events:corrected.events.slice(-6)}));
 const latest=corrected.tables.conversation_memory_state.at(-1).memory.current_customer_facts;
 for(const [k,value] of Object.entries({...values,[key]:newValue})){const fact=latest.find(x=>x.key===k);assert(fact);assert.deepEqual(fact.value,value);if(k===key)assert.equal(fact.source_message_id,uuid(810));}
 const summary=fixture('Please summarize my latest requirements without looking up products.',{originalPreview:true,fullChain:true,enforceSmallTransport:true,previous:corrected.tables,history:corrected.tables.messages,source:uuid(811),semantic:providerWire({intent:'requirements_recap',requested_facts:[]},'ASK_FACT')});
 const sr=await summary.run();assert.equal(sr.status,200);assert(!summary.commits[0].metadata.degraded,JSON.stringify({sr,metadata:summary.commits[0].metadata,events:summary.events.slice(-8),state:summary.tables.conversation_commerce_state[0]}));assert(summary.commits[0].content.includes(industry==='service'?'75':industry==='subscription'?'5':'3'));assert(!summary.requests.some(x=>x.url.includes('context-search')));
 const replay=await summary.run();assert.equal(replay.body.idempotent,true);assert.equal(summary.commits.length,1);
});
for(const mutate of [w=>w.nodes.push({path:['unknown_merchant_authority'],kind:'boolean',boolean:true}),w=>w.nodes.push({path:['entities','0'],kind:'object'})])test('malformed new provider tree cannot create canonical Memory or bypass B2',async()=>{
 const semantic=providerWire({});mutate(semantic);
 const f=fixture('Update this requirement',{originalPreview:true,fullChain:true,enforceSmallTransport:true,semantic});await f.run();
 assert.equal(f.tables.conversation_memory_state.length,0);assert(f.commits.every(x=>x.metadata.degraded===true));
 assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')).length,1);assert(!f.requests.some(x=>x.url.includes('context-search')));
});

// Actual ASK_FACT failure class; isolated transport is not Hosted acceptance.
test('same-ticket ASK_FACT binds the antecedent in retrieval and the bounded generation prompt',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const seed=fixture('四電一腦係咩？',{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:'「四電一腦」是生產者責任計劃下的受管制電器，包括空調機、洗衣機及電腦。',semantic:providerWire({intent:'other',requested_facts:['definition of 四電一腦']},'ASK_FACT')});await seed.run();
 const unrelated=structuredClone(sample.selected_documents[0]);unrelated.document_id='d9eb561203e94f66a0d275fdd811b4aa';unrelated.title='Unrelated subscription';unrelated.source_type='Product';unrelated.document_score=0.99;unrelated.summary.chunk_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';unrelated.summary.content='Unrelated subscription features include reporting and team seats.';unrelated.evidence[0]={...unrelated.evidence[0],chunk_id:'43495117c6d64b369ee2e0e58311152a',score:0.99,content:unrelated.summary.content};
 const candidates={...sample,selected_documents:[unrelated,...sample.selected_documents],citations:[{document_id:unrelated.document_id,label:unrelated.title,source_type:'Product',relevance:'medium'},...sample.citations]};
 const f=fixture('你頭先講嗰個計劃包括啲乜？',{originalPreview:true,fullChain:true,previous:seed.tables,history:[...seed.tables.messages].reverse(),source:uuid(880),originalRagResponse:candidates,answer:'這份資料列出空調機、洗衣機、雪櫃、電視機、電腦、列印機、掃描器及顯示器。',semantic:providerWire({intent:'other',topic:'features',requested_facts:['features']},'ASK_FACT')});
 await f.run();
 const retrieval=f.requests.find(x=>x.url.includes('context-search'));assert(retrieval,'fresh retrieval required');assert(JSON.stringify(retrieval.body).includes('四電一腦'),'resolved subject survives valid ASK_FACT');
 const generation=f.requests.find(x=>x.url.endsWith(':generateContent')&&!x.body.generationConfig.responseSchema);assert(generation,JSON.stringify({commits:f.commits,events:f.events.slice(-7)}));
 const requestBlock=generation.body.systemInstruction.parts[0].text.split('[CURRENT_FACTUAL_REQUEST]\n')[1];assert(requestBlock,'reference must survive bounded Memory envelope');
 const resolved=JSON.parse(requestBlock.split('\n')[0]);assert.equal(resolved.subject,'四電一腦');assert.deepEqual(resolved.requested_facts,['features']);
 assert.equal(resolved.original_question,'你頭先講嗰個計劃包括啲乜？');assert.equal(resolved.resolved_question,'四電一腦 你頭先講嗰個計劃包括啲乜?');
 assert.equal(f.commits[0]?.metadata.citation_lineage.selected_document_id,sample.selected_documents[0].document_id);
 const dispatches=()=>f.requests.filter(x=>x.url.includes("context-search")||x.url.includes("aiplatform")).length;const before=dispatches();await f.run();assert.equal(f.commits.length,1);assert.equal(dispatches(),before);
});

for (const [subject,question,followup] of [
 ['Harbor Care','What is Harbor Care?','What does that plan include?'],
 ['租用保障','租用保障係咩？','嗰個包括啲乜？'],
 ['Atlas warranty','What is Atlas warranty?','What does that policy cover?'],
]) test('generic source-bound factual follow-up uses fresh matching evidence: '+subject,async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8').replaceAll('四電一腦',subject));
 const doc=sample.selected_documents[0];doc.evidence[0].content=subject+' includes inspection and collection. The version date is not supplied.';doc.summary.content=doc.evidence[0].content;sample.llm_context.combined_text=doc.evidence[0].content;
 const seed=fixture(question,{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:subject+' includes inspection and collection.',semantic:providerWire({intent:'other',requested_facts:[subject]},'ASK_FACT')});await seed.run();
 const f=fixture(followup,{originalPreview:true,fullChain:true,previous:seed.tables,history:[...seed.tables.messages].reverse(),source:uuid(881),originalRagResponse:sample,answer:subject+' includes inspection and collection.',semantic:providerWire({intent:'other',topic:'features',requested_facts:['features']},'ASK_FACT')});await f.run();
 assert(JSON.stringify(f.requests.find(x=>x.url.includes('context-search'))?.body).includes(subject),JSON.stringify({seed:seed.commits,reply:f.commits,events:f.events.slice(-3),query:f.requests.find(x=>x.url.includes('context-search'))?.body}));assert.equal(f.commits[0]?.metadata.citation_lineage.selected_document_id,sample.selected_documents[0].document_id,JSON.stringify(f.commits[0]?.metadata));
});

test('a blanket no-data draft cannot pass even an all-positive isolated verifier',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const seed=fixture('四電一腦係咩？',{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:'「四電一腦」包括空調機、洗衣機及電腦。',semantic:providerWire({intent:'other',requested_facts:['definition of 四電一腦']},'ASK_FACT')});await seed.run();
 const bad='很抱歉，我目前沒有關於「生產者責任計劃」的詳細資料。';
 const f=fixture('你頭先講嗰個計劃包括啲乜？',{originalPreview:true,fullChain:true,previous:seed.tables,history:[...seed.tables.messages].reverse(),source:uuid(882),originalRagResponse:sample,answer:bad,semantic:providerWire({intent:'other',requested_facts:['features']},'ASK_FACT')});await f.run();assert.notEqual(f.commits[0]?.content,bad);assert.equal(f.commits[0]?.metadata.source_error_code,'LLM_GROUNDING_REJECTED');assert(!f.commits[0].content.includes('哪一點'));assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')&&!x.body.generationConfig.responseSchema).length,1,'no extra generation attempt');
});

// Pure reference/quality checks share the production implementation, no provider.
test('reference resolver respects nearest correction, topic boundaries, missing lineage and repeated follow-ups',()=>{
 const f=fixture('unused');const m=f.load(path.join(root,'supabase/functions/_shared/conversation-semantic-contract.ts'));
 const prior=(subject,id='previous')=>[{role:'assistant',content:subject+' includes inspection and collection.',metadata:{source_message_id:id,citation_lineage:{selected_document_id:'document',evidence_chunk_ids:['chunk']}}},{id,role:'visitor',content:'What is '+subject+'?'}];
 const q='What does that plan include?';
 assert.equal(m.resolveFactualFollowup(q,prior('Harbor Care'))?.subject,'Harbor Care');
 assert.equal(m.resolveFactualFollowup('Actually I meant Atlas warranty',prior('Harbor Care')),null);
 assert.equal(m.resolveFactualFollowup('Different topic: What is Atlas warranty?',prior('Harbor Care')),null);
 assert.equal(m.resolveFactualFollowup('Which of those plans?',prior('Harbor Care')),null);
 assert.equal(m.resolveFactualFollowup(q,[{id:'new',role:'visitor',content:'Cancel that request.'},...prior('Harbor Care')]),null);
 assert.equal(m.resolveFactualFollowup(q,[{role:'assistant',content:'An uncited answer'},...prior('Harbor Care')]),null);
 assert.equal(m.resolveFactualFollowup(q,[{role:'assistant',content:'Wrong source',metadata:{source_message_id:'different',citation_lineage:{selected_document_id:'document',evidence_chunk_ids:['chunk']}}},{id:'previous',role:'visitor',content:'What is Harbor Care?'}]),null);
 const corrected=prior('Atlas warranty','corrected');corrected[1].content='Actually I meant Atlas warranty';assert.equal(m.resolveFactualFollowup(q,corrected)?.subject,'Atlas warranty');
 const repeated=[{role:'assistant',content:'It includes inspection.',metadata:{source_message_id:'followup',citation_lineage:{selected_document_id:'document',evidence_chunk_ids:['chunk']}}},{id:'followup',role:'visitor',content:q},...prior('Harbor Care')];assert.equal(m.resolveFactualFollowup('And what does it cover?',repeated)?.subject,'Harbor Care');
 for(const denied of ['很抱歉，我目前沒有關於這個計劃的詳細資料。','I do not have information about that plan.'])assert(m.contradictsAvailableFollowupEvidence(denied));
 for(const allowed of ['This plan includes inspection. I do not have information about its expiry date.','資料包括檢查及收集；未提供版本日期。','目前文件未列出能源級別，我不會估計。'])assert(!m.contradictsAvailableFollowupEvidence(allowed));
});

test('same-ticket reference cannot turn an unrelated HTTP200 document into current authority',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const seed=fixture('四電一腦係咩？',{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:'「四電一腦」包括空調機、洗衣機及電腦。',semantic:providerWire({intent:'other',requested_facts:['definition of 四電一腦']},'ASK_FACT')});await seed.run();
 const unrelated=JSON.parse(JSON.stringify(sample).replaceAll('四電一腦','Unrelated subscription'));unrelated.selected_documents[0].evidence[0].content='Unrelated subscription features include reporting and team seats.';
 const f=fixture('你頭先講嗰個計劃包括啲乜？',{originalPreview:true,fullChain:true,previous:seed.tables,history:[...seed.tables.messages].reverse(),source:uuid(883),originalRagResponse:unrelated,semantic:providerWire({intent:'other',topic:'features',requested_facts:['features']},'ASK_FACT')});await f.run();assert.equal(f.commits[0]?.metadata.response_route,'kb_no_current_evidence');assert.equal(f.commits[0].metadata.citations.length,0);assert(!f.requests.some(x=>x.url.endsWith(':generateContent')&&!x.body.generationConfig.responseSchema));
});

test('v243 natural query: valid summary-only candidate cannot poison full evidence or same-ticket pronoun continuation',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const summary=structuredClone(sample.selected_documents[0]);summary.document_id='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';summary.summary.chunk_id='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';summary.evidence=[];
 const mixed={...sample,selected_documents:[summary,...sample.selected_documents],citations:[{...sample.citations[0],document_id:summary.document_id},...sample.citations]};
 const answer='「四電一腦」包括空調機、洗衣機、雪櫃、電視機、電腦、列印機、掃描器及顯示器。';
 const first=fixture('香港四電一腦回收計劃係講乜？',{originalPreview:true,fullChain:true,originalRagResponse:mixed,answer,semantic:providerWire({intent:'other',requested_facts:['definition of 四電一腦']},'ASK_FACT')});await first.run();
 assert.equal(first.commits[0]?.content,answer,JSON.stringify({commits:first.commits,events:first.events.slice(-5)}));assert.equal(first.commits[0].metadata.citation_lineage.selected_document_id,sample.selected_documents[0].document_id);assert.notEqual(first.tables.conversations[0].status,'pending');
 const next=fixture('咁佢涵蓋邊幾類電器？',{originalPreview:true,fullChain:true,previous:first.tables,history:[...first.tables.messages].reverse(),source:uuid(890),originalRagResponse:mixed,answer,semantic:providerWire({intent:'other',topic:'features',requested_facts:['features']},'ASK_FACT')});await next.run();
 assert(JSON.stringify(next.requests.find(x=>x.url.includes('context-search'))?.body).includes('四電一腦'),'pronoun needs source-bound subject, not a generic feature query');assert.equal(next.commits[0]?.content,answer,JSON.stringify(next.commits));
 assert.equal(next.commits[0].metadata.citation_lineage.selected_document_id,sample.selected_documents[0].document_id);
 for(const f of [first,next]){const calls=()=>f.requests.filter(x=>x.url.includes('context-search')||x.url.includes('aiplatform')).length;const before=calls();await f.run();assert.equal(f.commits.length,1);assert.equal(calls(),before);}
});

test('v244 operation facet uses actual full evidence in final prompt and persists a partial grounded answer, then resolves pronoun',async()=>{
 // Retained fixture, NOT the missing five-document v244 remote response.
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const answer='資料列出可安排回收商移走相同種類及數量的舊電器，需預留最少三個工作天。這份資料未證明整個政府計劃的全部運作或最新版本。';
 const first=fixture('香港四電一腦回收計劃係點運作？',{originalPreview:true,fullChain:true,originalRagResponse:sample,answer,semantic:providerWire({intent:'other',topic:'policy.hong kong waste electrical and electronic equipment recycling programme.how it works',requested_facts:['how it works']},'ASK_FACT')});await first.run();
 assert.equal(first.commits[0]?.content,answer,JSON.stringify(first.commits));
 const generation=first.requests.find(x=>x.url.endsWith(':generateContent')&&!x.body.generationConfig.responseSchema);
 assert(generation,'final generation must actually run');assert(JSON.stringify(generation.body).includes('最少 3 個工作天'));
 assert.equal(first.commits[0].metadata.citation_lineage.selected_document_id,sample.selected_documents[0].document_id);
 assert.equal(first.commits[0].metadata.reference_authority.provenance.currentness,'unknown');
 const next=fixture('咁佢包括邊幾類電器？',{originalPreview:true,fullChain:true,previous:first.tables,history:[...first.tables.messages].reverse(),source:uuid(891),originalRagResponse:sample,answer:'資料列出空調機、洗衣機、雪櫃、電視機、電腦、列印機、掃描器及顯示器。',semantic:providerWire({intent:'other',requested_facts:['categories of regulated equipment']},'ASK_FACT')});await next.run();
 assert.equal(next.commits[0]?.metadata.citation_lineage?.selected_document_id,sample.selected_documents[0].document_id,JSON.stringify(next.commits));
 assert(JSON.stringify(next.requests.find(x=>x.url.includes('context-search'))?.body).includes('四電一腦'));
 for(const f of [first,next]){const paid=()=>f.requests.filter(x=>x.url.includes('context-search')||x.url.includes('aiplatform')).length;const count=paid();await f.run();assert.equal(f.commits.length,1);assert.equal(paid(),count);}
});

test('v244 first factual answer cannot deny available subject evidence even with a positive verifier',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const bad='我而家搵唔到足夠嘅現行資料，所以暫時未能確認。舊資料唔會當成現況，我亦唔會估。';
 const f=fixture('香港四電一腦回收計劃係點運作？',{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:bad,semantic:providerWire({intent:'other',requested_facts:['abstract English operation label']},'ASK_FACT')});await f.run();
 assert.notEqual(f.commits[0]?.content,bad);assert.equal(f.commits[0]?.metadata.source_error_code,'LLM_GROUNDING_REJECTED',JSON.stringify({commits:f.commits,events:f.events}));
 assert.equal(f.requests.filter(x=>x.url.endsWith(':generateContent')&&!x.body.generationConfig.responseSchema).length,1);
});

for(const [subject,question,body] of [
 ['雲端備份服務','請問雲端備份服務點樣運作？','雲端備份服務會先驗證帳戶，然後備份已選取的檔案。'],
 ['設備保養服務','設備保養服務如何運作？','設備保養服務會先檢查設備，再提供保養安排。'],
 ['Harbor Care','How does Harbor Care operate?','Harbor Care starts with inspection and then arranges collection.'],
])test('full chain binds unquoted literal subject while free Semantic entity names remain hints: '+subject,async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));const d=sample.selected_documents[0];d.title=subject;d.evidence[0].content=body;d.summary.content=body;sample.citations[0].label=subject;
 const seed=fixture(question,{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:body,semantic:providerWire({intent:'other',topic:'price and warranty policy abstract English operational description',requested_facts:['how the service works'],entities:[{name:subject,kind:'service',confidence:0.98}]},'ASK_FACT')});await seed.run();
 assert.equal(seed.commits[0]?.content,body,JSON.stringify({reply:seed.commits,events:seed.events.slice(-5)}));
 const next=fixture('What does it include?',{originalPreview:true,fullChain:true,previous:seed.tables,history:[...seed.tables.messages].reverse(),source:uuid(892),originalRagResponse:sample,answer:body,semantic:providerWire({intent:'other',requested_facts:['included service scope']},'ASK_FACT')});await next.run();
 assert.equal(next.commits[0]?.content,body,JSON.stringify(next.commits));assert(JSON.stringify(next.requests.find(x=>x.url.includes('context-search'))?.body).includes(subject));
});

for(const question of ['What is Harbor Care?','Could you explain Harbor Care?','I would like to know what Harbor Care includes.','Harbor Care 有啲咩服務？'])test('Task1A full handler natural phrasing retains full-content subject support: '+question,async()=>{
 // Synthetic business content through the existing authenticated-service
 // transport fixture, not a historical/live RAG response or source proof.
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const subject='Harbor Care',body='Harbor Care includes inspection and collection.',d=sample.selected_documents[0];
 d.title=subject;d.evidence[0].content=body;d.summary.content=body;sample.citations[0].label=subject;
 const semantic=providerWire({intent:'other',requested_facts:['included service scope'],entities:[{name:subject,kind:'service',confidence:0.98}]},'ASK_FACT');
 const f=fixture(question,{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:body,semantic});await f.run();
 if(process.env.C3_TASK1A_EVIDENCE_DIR){const dest=path.resolve(process.env.C3_TASK1A_EVIDENCE_DIR);fs.mkdirSync(dest,{recursive:true});fs.writeFileSync(path.join(dest,hash(question)+'.json'),JSON.stringify({scope:'isolated complete handler; NOT Hosted',question,semantic,queries:f.requests.filter(r=>r.url.includes('context-search')).map(r=>r.body),commits:f.commits,events:f.events},null,2));}
 assert.equal(f.commits[0]?.content,body,JSON.stringify({question,commits:f.commits,events:f.events.slice(-5)}));
 assert.equal(f.commits[0]?.metadata.citation_lineage?.selected_document_id,d.document_id);
 assert.equal(f.commits[0]?.metadata.reference_authority?.provenance.currentness,'unknown');
 assert.equal(f.requests.filter(r=>r.url.includes('context-search')).length,1);
 const followup=fixture('What does it include?',{originalPreview:true,fullChain:true,previous:f.tables,history:[...f.tables.messages].reverse(),source:uuid(910),originalRagResponse:sample,answer:body,semantic:providerWire({intent:'other',requested_facts:['included service scope']},'ASK_FACT')});await followup.run();
 assert.equal(followup.commits[0]?.content,body,JSON.stringify(followup.commits));
 assert.equal(followup.requests.filter(r=>r.url.includes('context-search')).length,1);
 assert(JSON.stringify(followup.requests.find(r=>r.url.includes('context-search')).body).includes(subject));
 assert.equal(followup.commits[0]?.metadata.citation_lineage?.selected_document_id,d.document_id);
});

for(const fault of ['wrong-subject','premium','service-scope','region','foreign-tenant','historical','superseded','cancelled','draft','summary-only','no-admission','ambiguous','invented-name','partial-word'])test('Task1A complete handler preserves independent source and subject guards: '+fault,async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const d=sample.selected_documents[0];d.title='Harbor Care';d.evidence[0].content='Harbor Care includes inspection and collection.';d.summary.content=d.evidence[0].content;sample.citations[0].label=d.title;
 let question='Could you explain Harbor Care?',name='Harbor Care';const delta={intent:'other',requested_facts:['included service scope']};
 if(fault==='wrong-subject')name='Atlas Cover',question='Could you explain Atlas Cover?';
 if(fault==='premium')name='Harbor Care Premium',question='Could you explain Harbor Care Premium?';
 if(fault==='service-scope')name='Harbor Care Dental',question='Could you explain Harbor Care Dental?';
 if(fault==='region'){question='Could you explain Harbor Care in Singapore?';d.evidence[0].content='Harbor Care includes inspection and collection in Hong Kong only.';}
 if(fault==='foreign-tenant')d.authority={tenant_id:'99',publication_state:'published',currentness:'current'};
 if(['historical','superseded','cancelled'].includes(fault))d.authority={tenant_id:'34',publication_state:'published',currentness:fault};
 if(fault==='draft')d.authority={tenant_id:'34',publication_state:'draft',currentness:'current'};
 if(fault==='summary-only')d.evidence=[];
 if(fault==='ambiguous')delta.ambiguity={is_ambiguous:true,reasons:['two possible services'],clarification_question:'Which service do you mean?'};
 if(fault==='invented-name')name='Made Up Service';
 if(fault==='partial-word')question='Could you explain Harbor CarePlus?';
 delta.entities=[{name,kind:'service',confidence:0.98}];
 const f=fixture(question,{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:'Harbor Care includes inspection and collection.',semantic:providerWire(delta,'ASK_FACT')});
 if(fault==='no-admission')f.env.ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION='';
 // The fixture initializes the explicit original authority on first run; the
 // absent-admission case revokes the otherwise matching server-side binding.
 if(fault==='no-admission')f.env.KB_SINGAPORE_TENANT_API_KEYS_JSON='{}';
 await f.run();
 assert(!f.commits.some(c=>c.content==='Harbor Care includes inspection and collection.'),JSON.stringify({fault,commits:f.commits}));
 assert(!f.commits.some(c=>c.metadata.citation_lineage?.selected_document_id),JSON.stringify({fault,commits:f.commits}));
});

test('Task1A full request verifier rejects clipped semantic scope without adding a retry',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));const d=sample.selected_documents[0];d.title='Harbor Care';d.evidence[0].content='Harbor Care includes inspection and collection.';d.summary.content=d.evidence[0].content;sample.citations[0].label=d.title;
 const f=fixture('Could you explain Harbor Care Premium?',{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:d.evidence[0].content,verifierResolution:'unsupported',semantic:providerWire({intent:'other',requested_facts:['included service scope'],entities:[{name:'Harbor Care',kind:'service',confidence:0.98}]},'ASK_FACT')});await f.run();
 assert.notEqual(f.commits[0]?.content,d.evidence[0].content);assert.equal(f.commits[0]?.metadata.source_error_code,'LLM_GROUNDING_REJECTED');
 const verifier=f.requests.find(r=>r.body?.generationConfig?.responseSchema?.properties?.grounded);assert(verifier);assert(JSON.stringify(verifier.body).includes('Harbor Care Premium'));assert(JSON.stringify(verifier.body).includes('COMPLETE current request'));
 assert.equal(f.requests.filter(r=>r.url.includes('context-search')).length,1);assert.equal(f.requests.filter(r=>r.url.endsWith(':generateContent')&&!r.body.generationConfig.responseSchema).length,1);
});

for(const [question,body,answer,resolution] of [
 ['可否介紹一下 Harbor Care 提供甚麼？','Harbor Care includes inspection and collection.','Harbor Care 提供檢查及收集。','supported'],
 ['Could you explain Harbor Care and its price?','Harbor Care includes inspection and collection.','Harbor Care includes inspection and collection. The source does not state its price.','partial'],
 ['I would appreciate an overview of Harbor Care.','Harbor Care includes inspection and collection.','Harbor Care includes inspection and collection.','supported'],
 ['Tell me about Harbor Care; what does Harbor Care include?','Harbor Care includes inspection and collection.','Harbor Care includes inspection and collection.','supported'],
])test('Task1A source-bound semantic subject is independent of request grammar and answer language: '+question,async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8')),d=sample.selected_documents[0];d.title='Harbor Care';d.evidence[0].content=body;d.summary.content=body;sample.citations[0].label=d.title;
 const f=fixture(question,{originalPreview:true,fullChain:true,originalRagResponse:sample,answer,verifierResolution:resolution,semantic:providerWire({intent:'other',requested_facts:['included service scope',...(resolution==='partial'?['price']:[])],entities:[{name:'Harbor Care',kind:'service',confidence:0.98}]},'ASK_FACT')});await f.run();
 assert.equal(f.commits[0]?.content,answer,JSON.stringify(f.commits));assert.equal(f.commits[0]?.metadata.reference_authority?.provenance.currentness,'unknown');assert.equal(f.requests.filter(r=>r.url.includes('context-search')).length,1);
 const dispatches=()=>f.requests.filter(r=>r.url.includes('context-search')||r.url.includes('aiplatform')).length;const before=dispatches();await f.run();assert.equal(f.commits.length,1);assert.equal(dispatches(),before,'replay must not dispatch again');
});

test('Task1A natural first answer, factual correction and new follow-up requery the latest source-bound subject',async()=>{
 const response=(subject,body)=>{const r=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));r.selected_documents[0].title=subject;r.selected_documents[0].evidence[0].content=body;r.selected_documents[0].summary.content=body;r.citations[0].label=subject;return r;};
 const proposal=subject=>providerWire({intent:'other',requested_facts:['included service scope'],entities:[{name:subject,kind:'service',confidence:0.98}]},'ASK_FACT');
 const a=response('Harbor Care','Harbor Care includes inspection and collection.'),b=response('Atlas Cover','Atlas Cover includes device repair.');
 const first=fixture('Could you explain Harbor Care?',{originalPreview:true,fullChain:true,originalRagResponse:a,answer:a.selected_documents[0].evidence[0].content,semantic:proposal('Harbor Care')});await first.run();
 const correction=fixture('Actually I meant Atlas Cover, not Harbor Care.',{originalPreview:true,fullChain:true,previous:first.tables,history:[...first.tables.messages].reverse(),source:uuid(920),originalRagResponse:b,answer:b.selected_documents[0].evidence[0].content,semantic:proposal('Atlas Cover')});await correction.run();
 assert.equal(correction.commits[0]?.content,b.selected_documents[0].evidence[0].content,JSON.stringify({commits:correction.commits,events:correction.events}));assert(JSON.stringify(correction.requests.find(r=>r.url.includes('context-search')).body).includes('Atlas Cover'));
 const next=fixture('What does it include?',{originalPreview:true,fullChain:true,previous:correction.tables,history:[correction.commits[0],correction.tables.messages.find(m=>m.id===uuid(920)),...first.tables.messages.slice().reverse()],source:uuid(921),originalRagResponse:b,answer:b.selected_documents[0].evidence[0].content,semantic:providerWire({intent:'other',requested_facts:['included service scope']},'ASK_FACT')});await next.run();
 assert.equal(next.commits[0]?.content,b.selected_documents[0].evidence[0].content,JSON.stringify(next.commits));assert(JSON.stringify(next.requests.find(r=>r.url.includes('context-search')).body).includes('Atlas Cover'));assert.equal(next.requests.filter(r=>r.url.includes('context-search')).length,1);
});

test('Task1A pure lookup preserves existing canonical customer requirements and revision',async()=>{
 const seed=fixture('I need three Archive Service boxes.',{originalPreview:true,fullChain:true,semantic:providerWire({intent:'customer_context_update',entities:[{name:'Archive Service',kind:'service',quantity:3,unit:'boxes',confidence:0.98}]},'ADD_ITEM')});await seed.run();
 assert(seed.tables.conversation_commerce_state.length===1);const before=structuredClone(seed.tables.conversation_commerce_state);
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8')),d=sample.selected_documents[0];d.title='Harbor Care';d.evidence[0].content='Harbor Care includes inspection and collection.';d.summary.content=d.evidence[0].content;sample.citations[0].label=d.title;
 const f=fixture('Could you explain Harbor Care?',{originalPreview:true,fullChain:true,source:uuid(930),previous:seed.tables,history:seed.tables.messages.slice().reverse(),originalRagResponse:sample,answer:d.evidence[0].content,semantic:providerWire({intent:'other',requested_facts:['service scope'],entities:[{name:'Harbor Care',kind:'service',confidence:0.98}]},'ASK_FACT')});await f.run();
 assert.equal(f.commits[0]?.content,d.evidence[0].content,JSON.stringify(f.commits));assert.deepEqual(f.tables.conversation_commerce_state,before);assert.equal(f.commits[0].metadata.b2_expected_revision,before[0].revision);assert(f.tables.conversation_memory_state.length===1,'Memory still follows original pipeline');
});

for(const guard of ['human-control','new-source','stale-revision'])test('Task1A pure lookup still respects original final commit boundary: '+guard,async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8')),d=sample.selected_documents[0];d.title='Harbor Care';d.evidence[0].content='Harbor Care includes inspection and collection.';d.summary.content=d.evidence[0].content;sample.citations[0].label=d.title;
 const f=fixture('Could you explain Harbor Care?',{originalPreview:true,fullChain:true,originalRagResponse:sample,answers:[d.evidence[0].content],humanAfterFirstDraft:guard==='human-control',newSourceAfterFirstDraft:guard==='new-source',...(guard==='stale-revision'?{rpcResult:'stale_authorized_revision'}:{}),semantic:providerWire({intent:'other',requested_facts:['service scope'],entities:[{name:'Harbor Care',kind:'service',confidence:0.98}]},'ASK_FACT')});await f.run();
 assert.equal(f.commits.length,0,JSON.stringify(f.commits));assert.equal(f.requests.filter(r=>r.url.includes('context-search')).length,1);assert.equal(f.requests.filter(r=>r.url.endsWith(':generateContent')&&!r.body.generationConfig.responseSchema).length,1);
});

for(const question of ['Please simplify that.','Translate that into Cantonese.','Rephrase that.'])test('Task1A transforming a prior grounded natural answer does not retrieve again: '+question,async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8')),d=sample.selected_documents[0];d.title='Harbor Care';d.evidence[0].content='Harbor Care includes inspection and collection.';d.summary.content=d.evidence[0].content;sample.citations[0].label=d.title;
 const first=fixture('Could you explain Harbor Care?',{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:d.evidence[0].content,semantic:providerWire({intent:'other',requested_facts:['service scope'],entities:[{name:'Harbor Care',kind:'service',confidence:0.98}]},'ASK_FACT')});await first.run();
 const resolved=first.load(path.join(root,'supabase/functions/_shared/prior-grounded-transform.ts')).resolvePriorGroundedTransform(question,first.tables.messages.slice().reverse());assert(resolved,JSON.stringify(first.tables.messages));
 for(const field of ['reference_authority','factual_request_subject','b2_source_message_id','b2_gate_contract']){const rows=structuredClone(first.tables.messages).reverse();delete rows.find(row=>row.role==='assistant').metadata[field];assert.equal(first.load(path.join(root,'supabase/functions/_shared/prior-grounded-transform.ts')).resolvePriorGroundedTransform(question,rows),null,'low-rank reuse requires '+field);}

 const f=fixture(question,{originalPreview:true,fullChain:true,source:uuid(940),previous:first.tables,history:first.tables.messages.slice().reverse(),originalRagResponse:sample,answer:d.evidence[0].content,semantic:providerWire({intent:'other',requested_facts:[]},'NO_STATE_CHANGE')});await f.run();
 assert.equal(f.commits[0]?.content,d.evidence[0].content,JSON.stringify(f.commits));assert.equal(f.requests.filter(r=>r.url.includes('context-search')).length,0);assert.equal(f.commits.length,1);
 assert.equal(f.commits[0].metadata.citations[0].relevance,'low');assert.equal(f.commits[0].metadata.citation_lineage.evidence_state,'unknown');
 const again=fixture('Rephrase that.',{originalPreview:true,fullChain:true,source:uuid(941),previous:f.tables,history:[f.commits[0],f.tables.messages.find(m=>m.id===uuid(940)),...first.tables.messages.slice().reverse()],originalRagResponse:sample,answer:d.evidence[0].content,semantic:providerWire({intent:'other',requested_facts:[]},'NO_STATE_CHANGE')});await again.run();assert.equal(again.commits[0]?.content,d.evidence[0].content,JSON.stringify(again.commits));assert.equal(again.requests.filter(r=>r.url.includes('context-search')).length,0);

});

for(const options of [{verifierResolution:'unsupported'},{omitQuestionResolution:true},{verifierIds:['C1']}])test('truthful claims alone do not prove current factual question resolution: '+JSON.stringify(options),async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));
 const draft='資料列出空調機、洗衣機及電腦。';const f=fixture('四電一腦係點運作？',{...options,originalPreview:true,fullChain:true,originalRagResponse:sample,answer:draft,semantic:providerWire({intent:'other',requested_facts:['how it works']},'ASK_FACT')});await f.run();
 assert.notEqual(f.commits[0]?.content,draft);assert.equal(f.commits[0]?.metadata.source_error_code,'LLM_GROUNDING_REJECTED');assert.equal(f.requests.filter(x=>x.body?.generationConfig?.responseSchema?.properties?.grounded).length,1);
});

test('source-bound correction and identical earlier follow-up preserve the nearest subject',()=>{
 const f=fixture('unused'),m=f.load(path.join(root,'supabase/functions/_shared/conversation-semantic-contract.ts'));
 const prior=(question,id,label)=>[{role:'assistant',content:'Source-backed answer',metadata:{source_message_id:id,citations:[{document_id:'doc',label}],citation_lineage:{selected_document_id:'doc',evidence_chunk_ids:['chunk']}}},{id,role:'visitor',content:question}];
 assert.equal(m.resolveFactualFollowup('What does it cover?',prior('Actually I meant Harbor Care, not Atlas Cover','correction','"Atlas Cover" document'))?.subject,'Harbor Care');
 const old=prior('What is Harbor Care?','first','Harbor Care'),q='What does it include?';
 assert.equal(m.resolveFactualFollowup(q,[...prior(q,'previous-followup','Harbor Care'),...old])?.subject,'Harbor Care');
 assert.equal(m.resolveFactualFollowup(q,[{id:'cancel',role:'visitor',content:'Cancel Harbor Care.'},...old]),null);
});

for(const kind of ['summary-only','invalid-document'])test('legacy KB response does not manufacture authority or human control: '+kind,async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));sample.selected_documents[0].evidence=[];if(kind==='invalid-document')sample.selected_documents[0].summary=null;
 const f=fixture('香港四電一腦回收計劃係講乜？',{originalPreview:true,fullChain:true,env:{ESC_ENABLE_S0:'false'},originalRagResponse:sample,semantic:providerWire({intent:'other',requested_facts:['definition of 四電一腦']},'ASK_FACT')});await f.run();
 assert.equal(f.commits.length,1);assert(!f.requests.some(x=>x.url.endsWith(':generateContent')&&!x.body.generationConfig.responseSchema));assert(!f.requests.some(x=>/handoff_tx/.test(x.url)));assert.equal(f.tables.conversations[0].status,'open');assert(!f.commits[0].metadata.citations?.length);
 if(kind==='summary-only')assert.equal(f.commits[0].metadata.response_route,'kb_no_current_evidence');else{const traces=f.events.flat().map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);const reject=traces.find(x=>x.authority_reason==='KB_RAG_RESPONSE_INVALID');assert.equal(reject?.validation_rule,'document_shape');assert.equal(reject.http_status,200);}
 const paid=()=>f.requests.filter(x=>x.url.includes('context-search')||x.url.includes('aiplatform')).length;const before=paid();await f.run();assert.equal(f.commits.length,1);assert.equal(paid(),before);
});

test('Task1A a transform with customer-owned facts retains the commerce and Memory writer',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8')),d=sample.selected_documents[0];d.title='Harbor Care';d.evidence[0].content='Harbor Care includes inspection and collection.';d.summary.content=d.evidence[0].content;sample.citations[0].label=d.title;
 const first=fixture('Could you explain Harbor Care?',{originalPreview:true,fullChain:true,originalRagResponse:sample,answer:d.evidence[0].content,semantic:providerWire({intent:'other',requested_facts:['service scope'],entities:[{name:'Harbor Care',kind:'service',confidence:0.98}]},'ASK_FACT')});await first.run();
 const f=fixture('Rephrase that. There are eight people working here.',{originalPreview:true,fullChain:true,source:uuid(945),previous:first.tables,history:first.tables.messages.slice().reverse(),originalRagResponse:sample,answer:d.evidence[0].content,semantic:providerWire({intent:'customer_context_update',customer_facts:[{key:'staff_count',value:8}],requested_facts:[]},'UPDATE_ITEM')});await f.run();
 assert.equal(f.tables.conversation_memory_state[0]?.memory.current_customer_facts.find(f=>f.key==='staff_count')?.value,8,JSON.stringify(f.tables.conversation_memory_state));assert.equal(f.tables.conversation_commerce_state.length,1);
});

// Task1C: exact durable utterances and observed frame projection. Production
// did not retain the private provider delta; unknown labels/fields below are
// explicit fixture inputs, not reconstructed Hosted evidence.
const task1cFirst='我想選一部適合屋企日常使用的電腦，主要上網、文書同視像通話。應該先比較哪些規格？暫時不用查店舖庫存或售價。';
const task1cSecond='答你剛才的澄清：我要桌上型電腦。更正一下，主要會同時開好多瀏覽器分頁，但不打機；之前提到的上網、文書及視像通話仍然需要。請按最新用途給一般規格比較建議，不用查任何店舖型號、庫存或售價。';
for(const label of ['specification comparison','unretained-provider-label'])test('Task1C original multi-turn clarification normalizes observed ADD_ITEM/other without merchant lookup: '+label,async()=>{
 const first=fixture(task1cFirst,{fullChain:true,originalPreview:true,answer:'比較多工流暢度、儲存與視像通話設備。你傾向筆記型還是桌上型？',semantic:{operation:'ASK_FACT',confidence:.97,intent:'customer_guidance',requested_facts:[]}});await first.run();
 const answer='按你最新的桌上型用途，先比較多分頁時的記憶體餘量、日常文書反應與通話設備；不打機可先按實際工作需要取捨，具體型號資料仍需核實。';
 const second=fixture(task1cSecond,{fullChain:true,originalPreview:true,source:uuid(401),previous:first.tables,history:first.tables.messages,answer,semantic:{operation:'ADD_ITEM',confidence:.97,intent:'other',requested_facts:[label],entities:[]}});
 const r=await second.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(second.commits[0]?.content,answer);assert.equal(second.commits[0]?.metadata.response_route,'customer_guidance');assert(!second.requests.some(x=>x.url.includes('context-search')));assert.equal(second.tables.conversation_memory_state[0].memory.current_goal,task1cSecond.normalize('NFKC'));
 assert(second.tables.conversation_memory_state[0].memory.latest_corrections.some(x=>x.includes('桌上型')));assert(!second.tables.conversation_commerce_state.some(x=>x.state.entities.length));
 const generation=second.requests.find(x=>x.body?.systemInstruction?.parts?.[0]?.text?.includes('[EFFECTIVE_CUSTOMER_REQUIREMENTS]'));assert(generation);assert(JSON.stringify(generation.body).includes('多分頁')||JSON.stringify(generation.body).includes('好多瀏覽器分頁'));
 const replay=await second.run();assert.equal(replay.body.idempotent,true);assert.equal(second.commits.length,1);
});
for(const [kind,firstText,correction,key,value] of [
 ['retail','How should I compare a chair for working at home?','Correction: I work standing half the day. Explain how to balance comfort and space.','standing',true],
 ['saas','How should I choose collaboration software for my team?','Correction: eight staff and automatic renewal off. Explain how to balance training and permissions.','automatic_renewal',false],
 ['booking','How should I choose a service booking arrangement?','Correction: mornings only and no stairs. Explain how to balance access and flexibility.','stairs',false],
 ['b2b','How should we compare packaging equipment for our workshop?','Correction: zero floor space for an extra unit. Explain how to balance throughput and available space.','extra_floor_space',0],
 ['subscription','How should I compare subscription arrangements?','Correction: monthly use only. Explain how to balance commitment and flexibility.','usage_period','monthly'],
])test('Task1C cross-industry continuation keeps genuine fact writer and latest effective prompt: '+kind,async()=>{
 const initial=fixture(firstText,{originalPreview:true,fullChain:true,answer:'Compare the requirements and constraints. What is your priority?',semantic:{operation:'ASK_FACT',confidence:.97,intent:'customer_guidance',requested_facts:[]}});await initial.run();
 const answer='Balance the latest stated needs and constraints before choosing; merchant-specific facts require verification.';
 const f=fixture(correction,{source:uuid(410),originalPreview:true,fullChain:true,previous:initial.tables,history:initial.tables.messages,answer,semantic:{operation:'UPDATE_ITEM',confidence:.97,intent:'other',customer_correction:true,customer_facts:[{key,value}],requested_facts:[]}});const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance');assert.equal(f.tables.conversation_memory_state[0].memory.current_customer_facts.find(x=>x.key===key)?.value,value);assert(!f.requests.some(x=>x.url.includes('context-search')));
});
for(const text of ['Correction: check your Pro plan price and stock for Singapore.','Correction: what warranty does your model X100 have in Hong Kong?','Correction: check your cancellation policy for the Taiwan booking.'])test('Task1C qualified merchant follow-up never inherits no-query authority: '+text,async()=>{
 const first=fixture('How should I compare options?',{originalPreview:true,fullChain:true,answer:'Compare your needs and constraints. What is the use case?',semantic:{operation:'ASK_FACT',confidence:.97,intent:'customer_guidance',requested_facts:[]}});await first.run();
 const f=fixture(text,{source:uuid(420),originalPreview:true,fullChain:true,originalRagResponse:JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8')),previous:first.tables,history:first.tables.messages,semantic:{operation:'ASK_FACT',confidence:.97,intent:'customer_guidance',requested_facts:['current qualified merchant fact']}});await f.run();assert(f.requests.some(x=>x.url.includes('context-search')));assert.notEqual(f.commits[0]?.metadata.response_route,'customer_guidance');
});
test('Task1C mixed guidance preserves general answer and scopes legal query to merchant facet',async()=>{
 const text='Explain how to compare service arrangements and check your cancellation policy.';
 const answer='Compare flexibility with your scheduling needs. I cannot verify the specific cancellation policy from the returned evidence.';
 const f=fixture(text,{originalPreview:true,fullChain:true,originalRagResponse:JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8')),answer,verifierIds:['C1'],semantic:{operation:'ASK_FACT',confidence:.97,intent:'other',requested_facts:['cancellation policy']}});const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.commits[0]?.content,answer);assert.equal(f.commits[0]?.metadata.response_route,'mixed_customer_guidance');assert(f.tables.conversation_memory_state[0].memory.question_lifecycle.some(x=>x.status==='pending'),'unverified merchant facet stays pending');const kb=f.requests.find(x=>x.url.includes('context-search'));assert(kb);assert(!kb.body.query.includes('Explain how to compare'));
});

test('Task1C mixed no-evidence guidance cannot certify a fabricated merchant policy',async()=>{
 const f=fixture('Explain how to compare service arrangements and check your cancellation policy.',{originalPreview:true,fullChain:true,originalRagResponse:JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8')),answer:'Your cancellation policy grants an unconditional refund.',verifierIds:['C1'],verifierGrounded:false,semantic:{operation:'ASK_FACT',confidence:.97,intent:'other',requested_facts:['cancellation policy']}});await f.run();assert.notEqual(f.commits[0]?.content,'Your cancellation policy grants an unconditional refund.');assert.equal(f.commits[0]?.metadata.source_error_code,'LLM_GROUNDING_REJECTED');
});

test('Task1C mixed advice retains grounded named-service full content and only queries its factual facet',async()=>{
 const sample=JSON.parse(fs.readFileSync(path.join(root,'tests/c3-widget-live-auth/fixtures/director-original-rag-response.json'),'utf8'));const d=sample.selected_documents[0];d.title='Harbor Care';d.evidence[0].content='Harbor Care includes inspection and collection.';d.summary.content=d.evidence[0].content;sample.citations[0].label=d.title;
 const answer='Compare flexibility with your needs. Harbor Care includes inspection and collection.';
 const f=fixture('Explain how to compare service arrangements and what does Harbor Care include?',{originalPreview:true,fullChain:true,originalRagResponse:sample,answer,semantic:providerWire({intent:'other',requested_facts:['included service scope'],entities:[{name:'Harbor Care',kind:'service',confidence:.98}]},'ASK_FACT')});await f.run();assert.equal(f.commits[0]?.content,answer,JSON.stringify(f.commits));assert.equal(f.commits[0]?.metadata.response_route,'mixed_customer_guidance');assert(f.commits[0]?.metadata.reference_authority);const request=f.requests.find(x=>x.url.includes('context-search'));assert(request);assert(!request.body.query.includes('Explain how to compare'));assert(f.requests.some(x=>x.body?.generationConfig?.responseSchema?.properties?.grounded));
});

for(const [initial,question,short,key,value,intent] of [['How should we compare subscription arrangements?','How many people need access?','Eight people.','staff_count',8,'customer_guidance'],['How should I compare a chair for working at home?','What space is available?','One square metre.','available_area',{amount:1,unit:'square metre'},'other'],['How should we compare service arrangements?','How often will you use it?','Once a month.','usage_period','monthly','other']])test('Task1C a short answer to the active clarification retains general purpose without a correction keyword: '+short,async()=>{
 const first=fixture(initial,{originalPreview:true,fullChain:true,answer:'Compare the requirements with flexibility. '+question,semantic:{operation:'ASK_FACT',confidence:.97,intent:'customer_guidance',requested_facts:[]}});await first.run();
 const answer='Compare the latest needs with the flexibility and ease of use you require. Verify any specific merchant facts before choosing.';
 const f=fixture(short,{source:uuid(430),originalPreview:true,fullChain:true,previous:first.tables,history:first.tables.messages,answer,semantic:{operation:'UPDATE_ITEM',confidence:.97,intent,customer_facts:[{key,value}],requested_facts:[]}});await f.run();assert.equal(f.commits[0]?.content,answer,JSON.stringify(f.commits));assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance');assert(!f.requests.some(x=>x.url.includes('context-search')));assert.deepEqual(f.tables.conversation_memory_state[0].memory.current_customer_facts.find(x=>x.key===key)?.value,value);const generated=f.requests.find(x=>x.body?.systemInstruction?.parts?.[0]?.text?.includes('[EFFECTIVE_CUSTOMER_REQUIREMENTS]'));assert(generated);assert(JSON.stringify(generated.body).includes(initial),'prompt must retain the purpose answered by this clarification');assert(JSON.stringify(generated.body).includes(short),'prompt must include the latest answer');
});

test('Director current guidance correction after declarative advice persists latest facts without superseded recall',async()=>{
 const first=fixture('沿用桌上型電腦需求：二十多個瀏覽器分頁、文書和視像通話，不打機。請給一般選購建議。',{originalPreview:true,fullChain:true,answer:'先按多工負載比較記憶體，再按用途比較處理器與儲存空間。',semantic:providerWire({intent:'customer_guidance',requested_facts:[],customer_facts:[{key:'usage_scenario',value:{browser_tabs_open_simultaneously:20}}]})});await first.run();
 const value={browser_tabs_open_simultaneously:8};
 const f=fixture('其實只會開八個分頁，預算要節省，仍然是桌上型和不打機。請按這個更正調整建議，哪些升級可以暫緩？',{source:uuid(990),originalPreview:true,fullChain:true,previous:first.tables,history:first.tables.messages,answer:'按目前八個分頁與節省預算的需求，可先暫緩高階處理器和額外儲存升級，先確認現有配置是否足夠。',semantic:providerWire({intent:'customer_guidance',requested_facts:[],customer_facts:[{key:'usage_scenario',value},{key:'budget_preference',value:'節省'}]})});
 const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));
 assert.equal(f.commits[0]?.metadata.response_route,'customer_guidance',JSON.stringify({events:f.events,meta:f.commits[0]?.metadata}));
 assert(!f.commits[0]?.content.includes('項目記錄'));assert(!f.commits[0]?.content.includes('20'));
 const memory=f.tables.conversation_memory_state[0].memory;
 assert.deepEqual(memory.current_customer_facts.find(x=>x.key==='usage_scenario')?.value,value);
 assert(memory.active_constraints.every(x=>!x.includes('browser_tabs_open_simultaneously\\\":20')),'old active constraint must not override the new request');
 assert(memory.cancelled_or_superseded.some(x=>JSON.stringify(x.value).includes('browser_tabs_open_simultaneously')&&JSON.stringify(x.value).includes('20')),'superseded customer fact remains historical only');
 const commerce=f.tables.conversation_commerce_state[0].state;
 assert.deepEqual(commerce.customer_constraints.customer_reported_facts.usage_scenario.value,value);
});

// Task1C request resolution regressions. These are synthetic source records and
// deliberately stale but structurally valid semantic proposals. They exercise
// the complete handler, not a helper reimplementation or a Hosted replay.
function task1cModelDocument({model='CW-SUL70BA',price=4680,stock=7,currentness='current',tenant='34',regions=['hong_kong'],publication='published',score=.97,id='resolved-model-document'}={}) {
 const content=`商品型號: ${model}\n品牌: Fixture Home\n描述: 3/4匹窗口式冷氣\n功能: 製冷、送風及除濕\n銷售價: HK$${price.toLocaleString('en-US')}\n庫存: ${stock}`;
 return {document_id:id,title:model,source_type:'Product',document_score:score,
  authority:{tenant_id:tenant,publication_state:publication,currentness,entity_ids:[model],regions,version:'isolated-request-resolution-v1'},
  evidence:[{document_id:id,chunk_id:id+'-full',chunk_type:'full_content',score,content}]};
}
function task1cRagDocuments(...documents) {return {success:true,context_found:true,selected_documents:documents,citations:[]};}
const task1cSemanticFact=(subject,facets)=>({context_encoding:'semantic_fields_v3',operation:'ASK_FACT',confidence:.98,
 language:'zh-TW',intent:'other',topic:subject,customer_correction:false,additive:false,
 transaction_state:'unknown',payment_state:'unknown',booking_state:'unknown',fulfillment_state:'unknown',
 requested_facts:facets,explicit_negations:[],customer_facts:[],referents:[],
 ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},
 entities:subject?[{name:subject,kind:'physical_product',confidence:.98,entity_ref:'',category_hint:null,sku:null,model:null,quantity:null,unit:null,
  capabilities:{requires_delivery:false,supports_pickup:false,requires_installation:false,requires_booking:false,requires_quote:false,
   requires_site_check:false,digital_fulfilment:false,recurring_billing:false,rental_return:false,customization:false}}]:[],
 containers:[],strings:[],numbers:[],booleans:[]});
function task1cObservedRequest(f,{subject,facets,exclude=[]}) {
 const calls=f.requests.filter(r=>r.url.includes('context-search'));
 assert.equal(calls.length,1,'one new visitor request must produce one scoped retrieval: '+JSON.stringify({
  commits:f.commits.map(c=>({route:c.metadata.response_route,code:c.metadata.source_error_code,failure:c.metadata.execution_failure})),
  failures:f.events.filter(event=>/error|fail|reject|exception/iu.test(JSON.stringify(event))),
  stages:f.events.flat().filter(value=>typeof value==='string').slice(-8),
  requests:f.requests.map(r=>new URL(r.url).pathname)}));
 const query=calls[0].body.query;assert.equal(typeof query,'string');
 let parsed=null;try{parsed=JSON.parse(query)}catch{}
 if(parsed&&typeof parsed==='object'){
  assert.equal(parsed.topic,subject,query);assert.deepEqual(parsed.requested_facts,facets,query);
 }else{
  const markers={price:/(?:幾錢|几钱|多少錢|多少钱|價錢|价钱|價格|价格|售價|售价|\bprice\b|\bcost\b|how much)/iu,
   stock:/(?:有冇貨|有沒有貨|有没有货|庫存|库存|現貨|现货|\bstock\b|\binventory\b|\bavailability\b)/iu,
   features:/(?:功能|特點|特点|\bfeatures?\b)/iu};
  const observed=Object.keys(markers).filter(facet=>markers[facet].test(query));
  assert.deepEqual(observed.sort(),[...facets].sort(),'retrieval changed the latest requested facet: '+query);
 }
 assert(query.includes(subject),query);
 for(const phrase of exclude)assert(!query.includes(phrase),'obsolete subject/facet leaked into the RAG request: '+query);
 return {query,parsed};
}
function task1cCommittedAnswer(f,{source,document='resolved-model-document',currentness='current'}) {
 assert.equal(f.commits.length,1,JSON.stringify({commits:f.commits,events:f.events}));
 const reply=f.commits[0],meta=reply.metadata;
 assert.equal(meta.response_route,'canonical_kb_direct_answer',JSON.stringify({route:meta.response_route,failure:meta.execution_failure,gates:catalogueGateEvents(f),
  scope:meta.kb_request_contract,trace:meta.current_grounding_target,grounding:f.events.filter(e=>/named_product_identity|grounding_selection|authority_reason/iu.test(JSON.stringify(e)))}));
 assert.notEqual(meta.generation_success,false);assert.notEqual(meta.degraded,true);
 assert.equal(meta.citation_lineage.selected_document_id,document);
 assert.deepEqual(meta.citation_lineage.evidence_chunk_ids,[document+'-full']);
 assert.equal(meta.reference_authority.provenance.currentness,currentness);
 assert.equal(meta.b2_source_message_id,source);assert.equal(meta.b2_commit_source,'commit_ai_reply_tx');
 assert.equal(meta.b2_expected_company_id,'3d6e17b5-ec79-4f75-aa7f-eaa824ff8493');
 const query=f.requests.find(r=>r.url.includes('context-search')).body.query,receipt=meta.kb_request_contract;
 assert.equal(receipt?.version,'current-factual-request-1');assert.equal(receipt.source_message_id,source);
 assert.equal(receipt.query_sha256,hash(query));assert.equal(receipt.query_char_count,query.length);
 assert(!Object.hasOwn(receipt,'query')&&!Object.hasOwn(receipt,'question'),'safe receipt must not duplicate complete customer text');
 const expectedGate=meta.kb_fact_proof?'B2_ALLOW_CURRENT_KB_SELLING_PRICE':'B2_ALLOW';
 assert(catalogueGateEvents(f).some(e=>e.source_message_id===source&&e.gate_decision==='allow'&&e.gate_code===expectedGate&&e.commit_attempted===true),JSON.stringify(catalogueGateEvents(f)));
 assert.equal(f.requests.filter(r=>r.url.endsWith(':generateContent')).length,1,'direct source renderer needs only the semantic model attempt');
 return reply;
}
async function task1cAssertReplay(f) {
 const rag=f.requests.filter(r=>r.url.includes('context-search')).length;
 const models=f.requests.filter(r=>r.url.endsWith(':generateContent')).length;
 const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
 assert.equal(f.requests.filter(r=>r.url.includes('context-search')).length,rag);
 assert.equal(f.requests.filter(r=>r.url.endsWith(':generateContent')).length,models);
}

for(const model of ['CW-SUL70BA','NX-482A'])test('Task1C resolved request full handler: explicit model price defeats stale feature proposal '+model,async()=>{
 const source=uuid(model==='CW-SUL70BA'?3001:3002);
 const f=fixture(`${model} 幾錢？`,{source,originalPreview:true,fullChain:true,
  originalRagResponse:task1cRagDocuments(task1cModelDocument({model})),semantic:task1cSemanticFact(model,['features'])});
 const r=await f.run();assert.equal(r.status,200,JSON.stringify(r));
 task1cObservedRequest(f,{subject:model,facets:['price'],exclude:['"features"','training','permission']});
 const reply=task1cCommittedAnswer(f,{source});assert(reply.content.includes(model));assert.match(reply.content,/HK\$4,680/);
 assert.equal(reply.metadata.answer_kind,'price');assert.equal(reply.metadata.kb_fact_proof?.value,4680);
 assert.equal(reply.metadata.kb_fact_proof?.currency,'HKD');assert.equal(reply.metadata.kb_fact_proof?.model,model);
 assert(!reply.content.includes('製冷、送風及除濕'),'previous feature intent replaced the price answer');
 await task1cAssertReplay(f);
});

test('Task1C resolved request full handler: features then bare price then bare stock use new facets and fresh evidence',async()=>{
 const first=fixture('CW-SUL70BA 有咩功能？',{source:uuid(3010),originalPreview:true,fullChain:true,
  originalRagResponse:task1cRagDocuments(task1cModelDocument()),semantic:task1cSemanticFact('CW-SUL70BA',['features'])});
 await first.run();task1cObservedRequest(first,{subject:'CW-SUL70BA',facets:['features']});
 const initial=task1cCommittedAnswer(first,{source:uuid(3010)});assert.match(initial.content,/製冷|除濕/);
 const price=fixture('幾錢？',{source:uuid(3011),originalPreview:true,fullChain:true,previous:first.tables,
  history:first.tables.messages.slice().reverse(),originalRagResponse:task1cRagDocuments(task1cModelDocument({price:4980})),
  semantic:task1cSemanticFact('CW-SUL70BA',['features'])});
 await price.run();task1cObservedRequest(price,{subject:'CW-SUL70BA',facets:['price'],exclude:['"features"']});
 const priceReply=task1cCommittedAnswer(price,{source:uuid(3011)});assert.match(priceReply.content,/HK\$4,980/);assert(!priceReply.content.includes('4,680'));
 assert.equal(priceReply.metadata.kb_request_contract.resolution,'follow_up');assert.equal(priceReply.metadata.kb_request_contract.subject_source_message_id,uuid(3010));
 assert.deepEqual(priceReply.metadata.kb_request_contract.requested_fact_classes,['price']);
 const stock=fixture('有冇貨？',{source:uuid(3012),originalPreview:true,fullChain:true,previous:price.tables,
  history:price.tables.messages.slice().reverse(),originalRagResponse:task1cRagDocuments(task1cModelDocument({price:4980,stock:3})),
  semantic:task1cSemanticFact('CW-SUL70BA',['price'])});
 await stock.run();task1cObservedRequest(stock,{subject:'CW-SUL70BA',facets:['stock'],exclude:['"price"','"features"']});
 const stockReply=task1cCommittedAnswer(stock,{source:uuid(3012)});
 assert.equal(stockReply.metadata.kb_request_contract.resolution,'follow_up');assert.equal(stockReply.metadata.kb_request_contract.subject_source_message_id,uuid(3010));
 assert.deepEqual(stockReply.metadata.kb_request_contract.requested_fact_classes,['stock']);
 assert.match(stockReply.content,/(?:庫存數量|库存数量|stock quantity)[:：]\s*3/iu);assert(!stockReply.content.includes('4,980'));
 assert(stockReply.metadata.unresolved_fact_fields.includes('stock'),'recorded count must not establish live availability');
 assert.equal(stockReply.metadata.kb_fact_proof,undefined);
 assert(stockReply.metadata.recorded_kb_facts.some(v=>v.field==='stock_quantity'&&v.value===3&&v.currentness==='unverified'));
 await task1cAssertReplay(stock);
});

for(const [question,subject,name,spu,sku,amount,id] of [
 ['另外，轻量冲锋衣几钱？','轻量冲锋衣','轻量化户外冲锋衣','P002','P002-NV-XL',2100,3020],
 ['How much is Harbor Summit Jacket?','Harbor Summit Jacket','Harbor Summit Jacket','HJ310','HJ310-NV-XL',1290,3021],
])test('Task1C resolved request full handler: explicit new named product owns query and answer '+subject,async()=>{
 const seed=catalogueRetainedSeed(subject===name?'Harbor Jacket':subject,name);
 const catalogue=catalogueRagFixture({name,spu,sku,price:amount}).selected_documents[0];
 catalogue.document_id='resolved-catalogue-document';catalogue.evidence[0].document_id=catalogue.document_id;catalogue.evidence[0].chunk_id=catalogue.document_id+'-full';
 // Higher-ranked old product is deliberately first; retrieval order is not
 // authority to reuse the old topic, price or feature facet.
 const f=fixture(question,{...seed,source:uuid(id),originalPreview:true,fullChain:true,
  originalRagResponse:task1cRagDocuments(task1cModelDocument({score:.99}),catalogue),semantic:task1cSemanticFact('CW-SUL70BA',['features'])});
 const before=structuredClone(f.tables.conversation_commerce_state);
 await f.run();task1cObservedRequest(f,{subject,facets:['price'],exclude:['CW-SUL70BA','"features"','training','permission']});
 const reply=task1cCommittedAnswer(f,{source:uuid(id),document:'resolved-catalogue-document',currentness:'unknown'});
 assert(reply.content.includes(name)&&reply.content.includes(sku));assert(reply.content.includes('CNY '+amount.toLocaleString('en-US')));
 assert(!reply.content.includes('CW-SUL70BA')&&!reply.content.includes('4,680'));
 assert(!reply.metadata.kb_fact_proof);assert.deepEqual(reply.metadata.authoritative_kb_facts,[]);
 assert(reply.metadata.recorded_kb_facts.every(v=>v.document_id==='resolved-catalogue-document'&&v.chunk_id==='resolved-catalogue-document-full'&&v.currentness==='unverified'));
 // The existing writer may advance row revision and customer-source recency
 // after an explicit topic marker. That is not a new merchant/customer fact.
 // Preserve every business value; authorize the answer against the real latest
 // revision instead of claiming that this whole lookup performed zero writes.
 const business=rows=>rows.map(row=>({...row.state,entities:row.state.entities.map(({provenance,...entity})=>entity)}));
 assert.deepEqual(business(f.tables.conversation_commerce_state),business(before),'lookup must not rewrite retained customer requirements');
 assert.equal(reply.metadata.b2_expected_revision,f.tables.conversation_commerce_state[0].revision);
 await task1cAssertReplay(f);
});

test('Task1C resolved request full handler: same model with unknown currentness remains a recorded HKD price',async()=>{
 const source=uuid(3030),f=fixture('CW-SUL70BA 幾錢？',{source,originalPreview:true,fullChain:true,
  originalRagResponse:task1cRagDocuments(task1cModelDocument({currentness:'unknown'})),semantic:task1cSemanticFact('CW-SUL70BA',['price'])});
 await f.run();task1cObservedRequest(f,{subject:'CW-SUL70BA',facets:['price']});
 const reply=task1cCommittedAnswer(f,{source,currentness:'unknown'});assert.match(reply.content,/HK\$4,680/);
 assert.equal(reply.metadata.answer_kind,'listed_price_unverified');assert(!reply.metadata.kb_fact_proof);
 assert.match(reply.content,/未核實|未核实|unverified/iu);
 assert(!reply.metadata.authoritative_kb_facts.some(v=>v.currentness_at_answer==='current'));
});

for(const [kind,changes] of [['foreign-tenant',{tenant:'99'}],['historical',{currentness:'historical'}],['wrong-subject',{model:'NX-482A'}]])test('Task1C resolved request full handler: current scope still rejects '+kind,async()=>{
 const source=uuid(3040),f=fixture('CW-SUL70BA 幾錢？',{source,originalPreview:true,fullChain:true,
  originalRagResponse:task1cRagDocuments(task1cModelDocument(changes)),semantic:task1cSemanticFact('CW-SUL70BA',['features'])});
 await f.run();task1cObservedRequest(f,{subject:'CW-SUL70BA',facets:['price']});
 assert(!f.commits.some(c=>/4,680/.test(c.content)),JSON.stringify(f.commits));
 assert(!f.commits.some(c=>c.metadata.kb_fact_proof||c.metadata.citation_lineage?.selected_document_id==='resolved-model-document'));
 assert(!f.requests.some(r=>r.url.endsWith(':generateContent')&&!r.body?.generationConfig?.responseSchema),'ineligible source reached draft generation');
});

for(const result of ['stale_authorized_revision','tenant_mismatch'])test('Task1C resolved request full handler: direct price preserves final CAS denial '+result,async()=>{
 const f=fixture('CW-SUL70BA 幾錢？',{source:uuid(3050),originalPreview:true,fullChain:true,rpcResult:result,
  originalRagResponse:task1cRagDocuments(task1cModelDocument()),semantic:task1cSemanticFact('CW-SUL70BA',['price'])});
 await f.run();task1cObservedRequest(f,{subject:'CW-SUL70BA',facets:['price']});assert.equal(f.commits.length,0);
 const attempts=f.requests.filter(r=>r.url.endsWith('/commit_ai_reply_tx'));
 assert(attempts.length>0,'the guarded final commit must be attempted');
 assert(attempts.every(r=>r.body.p_metadata.b2_source_message_id===uuid(3050)&&r.body.p_metadata.b2_expected_company_id==='3d6e17b5-ec79-4f75-aa7f-eaa824ff8493'));
});

for(const resolution of ['supported','unsupported'])test('Task1C resolved request full handler: genuine v3 proposal reaches complete-question verifier '+resolution,async()=>{
 const subject='Harbor Care Premium',source=uuid(3060),answer='Harbor Care Premium includes inspection and collection.';
 const semantic=task1cSemanticFact(subject,['included service scope']);semantic.entities[0].kind='service';
 const document={document_id:'resolved-service-document',title:subject,source_type:'Service',document_score:.95,
  authority:{tenant_id:'34',publication_state:'published',currentness:'unknown'},
  evidence:[{document_id:'resolved-service-document',chunk_id:'resolved-service-full',chunk_type:'full_content',score:.95,content:answer}]};
 const question='Could you explain Harbor Care Premium?';
 const f=fixture(question,{source,originalPreview:true,fullChain:true,semantic,originalRagResponse:task1cRagDocuments(document),answer,verifierResolution:resolution});
 await f.run();const retrieval=f.requests.filter(r=>r.url.includes('context-search'));assert.equal(retrieval.length,1);
 assert(retrieval[0].body.query.includes(subject));
 const generation=f.requests.find(r=>r.url.endsWith(':generateContent')&&!r.body.generationConfig.responseSchema);
 assert(generation,'current request must reach governed generation');
 assert(generation.body.systemInstruction.parts[0].text.includes('[CURRENT_FACTUAL_REQUEST]'));
 const verifier=f.requests.find(r=>r.body?.generationConfig?.responseSchema?.properties?.grounded);
 assert(verifier,'complete-question verifier is required');assert(JSON.stringify(verifier.body).includes(question));
 assert(JSON.stringify(verifier.body).includes('COMPLETE current request'));
 assert.equal(f.requests.filter(r=>r.url.endsWith(':generateContent')).length,3,'semantic, generation and verifier only');
 if(resolution==='supported'){
  assert.equal(f.commits[0]?.content,answer);assert.equal(f.commits[0].metadata.citation_lineage.selected_document_id,document.document_id);
  assert.equal(f.commits[0].metadata.kb_request_contract.query_sha256,hash(retrieval[0].body.query));
 }else{
  assert(!f.commits.some(c=>c.content===answer));assert.equal(f.commits[0]?.metadata.source_error_code,'LLM_GROUNDING_REJECTED');
 }
});

test('Task1C resolved request full handler: oversized mixed request preserves conditions and never falls back to a shorter paid query',async()=>{
 const seed=catalogueRetainedSeed();
 const retained=seed.previous.conversation_commerce_state[0].state.entities.find(e=>e.attributes.product_name==='轻量冲锋衣');
 retained.constraints=Object.fromEntries(Array.from({length:6},(_,i)=>['requirement_'+i,('customer-condition-'+i+' ').repeat(13).trim()]));
 const before=structuredClone(retained.constraints);
 const question='Explain how to compare jacket materials and check the price of 轻量冲锋衣.';
 const f=fixture(question,{...seed,source:uuid(3070),originalPreview:true,fullChain:true,
  semantic:task1cSemanticFact('轻量冲锋衣',['price']),originalRagResponse:catalogueRagFixture()});
 await f.run();assert.equal(f.commits.length,1,JSON.stringify({commits:f.commits,events:f.events}));
 assert(f.commits[0].metadata.safe_assumptions?.includes('query_context_limit'),JSON.stringify(f.commits[0].metadata));
 assert.equal(f.commits[0].metadata.knowledge_state,'tool_failure');
 assert.equal(f.requests.filter(r=>r.url.includes('context-search')).length,0,'must not drop the conditions and query a shorter subset');
 assert.equal(f.requests.filter(r=>r.url.endsWith(':generateContent')).length,1,'bounded failure cannot dispatch generation or verifier');
 assert(!f.commits[0].metadata.citation_lineage&&!f.commits[0].metadata.kb_fact_proof);
 const after=f.tables.conversation_commerce_state[0].state.entities.find(e=>e.attributes.product_name==='轻量冲锋衣');
 assert.deepEqual(after.constraints,before,'oversized lookup erased retained customer requirements');
});

test('Task1C resolved request full handler: canonical referent beyond recent history reaches generation and verifier with the same subject',async()=>{
 const seed=catalogueRetainedSeed(),model='CW-SUL70BA',oldSource=uuid(3080),source=uuid(3081);
 const retained=seed.previous.conversation_commerce_state[0].state.entities[0];
 retained.model=model;retained.attributes.product_name=model;retained.provenance.source_message_id=oldSource;
 const semantic=task1cSemanticFact(null,['energy label']);semantic.referents=[{ref:retained.entity_id,source:'persistent_state',confidence:.98}];
 const document=task1cModelDocument({id:'resolved-old-subject-current-evidence'});
 document.evidence[0].content=`商品型號: ${model}\n能源資料: 請參閱官方能源標籤；現有記錄未列出能源級別。`;
 const question='佢嘅能源資料係點？',answer=`${model} 的能源資料請參閱官方能源標籤；現有記錄未列出能源級別。`;
 const oldRow={id:oldSource,conversation_id:ticket,role:'visitor',content:model+' 介紹一下',created_at:'2026-10-13T01:00:00.000Z',is_recalled:false,metadata:{}};
 const intervening=Array.from({length:130},(_,i)=>({id:uuid(5000+i),conversation_id:ticket,role:'visitor',content:'thanks',created_at:new Date(Date.parse(oldRow.created_at)+(i+1)*1000).toISOString(),is_recalled:false,metadata:{}}));
 const f=fixture(question,{...seed,history:[...intervening.reverse(),oldRow],source,originalPreview:true,fullChain:true,semantic,
  originalRagResponse:task1cRagDocuments(document),answer});
 await f.run();assert.equal(f.commits[0]?.content,answer,JSON.stringify({commits:f.commits,events:f.events.slice(-6)}));
 assert(f.tables.messages.findIndex(row=>row.id===oldSource)>100,'original customer source remains in storage beyond the recent query window');
 const rag=f.requests.filter(r=>r.url.includes('context-search'));assert.equal(rag.length,1);assert(rag[0].body.query.includes(model));
 const generation=f.requests.find(r=>r.url.endsWith(':generateContent')&&!r.body.generationConfig.responseSchema);assert(generation);
 const system=generation.body.systemInstruction.parts[0].text;
 assert(system.includes('[CURRENT_FACTUAL_REQUEST]')&&system.includes('"subject":"'+model+'"'));
 const verifier=f.requests.find(r=>r.body?.generationConfig?.responseSchema?.properties?.grounded);assert(verifier);
 const verifierText=verifier.body.contents.flatMap(c=>c.parts).map(p=>p.text??'').join('\n');
 const scope=JSON.parse(verifierText.split('\n').find(line=>line.startsWith('{"question":')));
 assert.equal(scope.followup?.subject,model,'retrieved raw customer source anchors the resolved question');
 assert(scope.followup?.prior_question.includes(model));
 assert.equal(scope.followup?.prior_answer,'','old answers must not become merchant evidence');
 assert.equal(scope.resolved_request.original_question,question);
 assert.equal(scope.resolved_request.resolved_question,model+' '+question.normalize('NFKC'));
 assert.equal(scope.resolved_request.subject,model);
 assert.deepEqual(scope.resolved_request.requested_facts,['energy label']);
 assert.equal(scope.resolved_request.resolution,'follow_up');
 assert.equal(f.commits[0].metadata.citation_lineage.selected_document_id,document.document_id);
 assert.equal(f.commits[0].metadata.kb_request_contract.subject_source_message_id,oldSource);
 assert.equal(f.commits[0].metadata.kb_request_contract.query_sha256,hash(rag[0].body.query));
 assert.equal(f.requests.filter(r=>r.url.endsWith(':generateContent')).length,3);
 await task1cAssertReplay(f);
});

// Task1 semantic context: controlled v4 proposals traverse the real handler,
// source recovery, retrieval, generation/verifier and Memory persistence. These
// fixtures establish source behavior, not live model/provider acceptance.
const task1SemanticContextDemand=(question,patch={})=>({
 question,source_quote:question,subject_refs:[],source_type:'product',requested_facts:[],constraints:{},
 customer_correction:false,explicit_negations:[],ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},...patch,
});
const task1SemanticContextWire=(demands,patch={})=>providerWireV5({
 language:'zh-HK',intent:'merchant_facts',requested_facts:[...new Set(demands.flatMap(demand=>demand.requested_facts))],
 demands,...patch,
},'ASK_FACT');

function v2PartialRecoveryFixture(options={}) {
 const model='AX-QZ81',priceQuestion=model+' 幾錢？',stockQuestion='有冇現貨？';
 const document=task1cModelDocument({model,price:1290,stock:7,currentness:'unknown',id:'v2-recorded-price'});
 const rejected=model+' costs HK$9,999,999 and 88 units are in stock.';
 return fixture(options.question??priceQuestion+stockQuestion,{source:uuid(8201),originalPreview:true,fullChain:true,
  answers:[rejected],originalRagResponse:task1cRagDocuments(document),
  semantic:task1SemanticContextWire([
   task1SemanticContextDemand(priceQuestion,{subject_refs:[model],requested_facts:['price']}),
   task1SemanticContextDemand(stockQuestion,{subject_refs:[model],requested_facts:['availability']}),
  ],{topic:model}),...options});
}
test('V2 partial recovery: rejected multi-demand draft preserves source-recorded price and pending live stock',async()=>{
 const f=v2PartialRecoveryFixture();const result=await f.run();
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.commits.length,1);
 const reply=f.commits[0],meta=reply.metadata;
 assert.equal(meta.response_route,'canonical_kb_partial_recovery',JSON.stringify({content:reply.content,meta}));
 assert.match(reply.content,/AX-QZ81/);assert.match(reply.content,/HK\$1,290/);
 assert.match(reply.content,/來源記錄|来源记录|source.recorded/iu);
 assert.match(reply.content,/現貨|现货|live stock/iu);
 assert.match(reply.content,/未核實|未核实|unverified/iu);
 assert(!/9,999,999|88 units/.test(reply.content),'the rejected draft was reused');
 assert.deepEqual(meta.partial_recovery.demand_outcomes.map(item=>[item.demand_id,item.status]),
  [['demand-1','partial'],['demand-2','unavailable']]);
 assert.deepEqual(meta.citations.map(item=>item.document_id),['v2-recorded-price']);
 assert.equal(meta.recorded_kb_facts.find(item=>item.field==='price_amount').value,1290);
 assert(meta.recorded_kb_facts.every(item=>item.demand_id==='demand-1'&&item.source_message_id===uuid(8201)&&item.currentness==='unverified'));
 assert(!meta.kb_fact_proof);assert.deepEqual(meta.authoritative_kb_facts,[]);
 assert(meta.unresolved_fact_fields.includes('demand-2'));
 assert.equal(meta.source_error_code,'LLM_GROUNDING_REJECTED');
 assert(meta.kb_request_contract,'failed generation must retain the safe retrieval request trace');
 assert(f.events.flat().some(value=>typeof value==='string'&&value.includes('grounding_exact_fact_rejected')));
 assert.equal(f.requests.filter(item=>item.url.includes('context-search')).length,1);
 assert.equal(f.requests.filter(item=>item.url.endsWith(':generateContent')).length,2,'only semantic and the original rejected generation; no retry/verifier call');
 assert.equal(meta.b2_source_message_id,uuid(8201));assert.equal(meta.b2_commit_source,'commit_ai_reply_tx');
 const gates=catalogueGateEvents(f);assert.deepEqual(gates.map(item=>[item.gate_decision,item.gate_code,item.commit_attempted]),[['allow','B2_ALLOW',true]]);
 const memory=f.tables.conversation_memory_state[0].memory;
 assert(memory.question_lifecycle.some(item=>item.source_message_id===uuid(8201)&&item.status==='pending'));
 assert(!memory.question_lifecycle.some(item=>item.source_message_id===uuid(8201)&&item.status==='resolved'));
 assert.deepEqual(f.tables.conversation_commerce_state.flatMap(row=>row.state.quotes),[]);
 const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
 assert.equal(f.requests.filter(item=>item.url.includes('context-search')).length,1);
 assert.equal(f.requests.filter(item=>item.url.endsWith(':generateContent')).length,2);
});
test('V2 partial recovery: a definite B2 block has no first commit and only the safe clarification commits',async()=>{
 // The quoted customer premise is still unverified. The unchanged B2 quote
 // gate may reject it; recovery must use the original clarification, once.
 const price='AX-QZ81 現時售價為 HK$1,290？',stock='有冇現貨？';
 const f=v2PartialRecoveryFixture({question:price+stock,semantic:task1SemanticContextWire([
  task1SemanticContextDemand(price,{subject_refs:['AX-QZ81'],requested_facts:['price']}),
  task1SemanticContextDemand(stock,{subject_refs:['AX-QZ81'],requested_facts:['availability']}),
 ],{topic:'AX-QZ81'})});
 const result=await f.run();assert.equal(result.status,200,JSON.stringify({result,events:f.events.slice(-10)}));
 const gates=catalogueGateEvents(f);
 assert.deepEqual(gates.map(item=>[item.gate_decision,item.gate_code,item.commit_attempted]),
  [['block','CURRENT_QUOTE_NOT_PROVEN',false],['allow','B2_ALLOW',true]],JSON.stringify({gates,commits:f.commits}));
 const writes=f.requests.filter(item=>item.url.endsWith('/commit_ai_reply_tx'));
 assert.equal(writes.length,1,'a blocked proposal must never reach the RPC');assert.equal(f.commits.length,1);
 assert.equal(f.commits[0].metadata.response_route,'grounding_recovery_clarification');
 assert.equal(f.commits[0].metadata.partial_recovery_b2_rejection,'CURRENT_QUOTE_NOT_PROVEN');
 assert(!/1,290|9,999,999/.test(f.commits[0].content));
 assert(!f.commits[0].metadata.recorded_kb_facts);assert(!f.commits[0].metadata.partial_recovery);
 assert.equal(f.requests.filter(item=>item.url.includes('context-search')).length,1);
 assert.equal(f.requests.filter(item=>item.url.endsWith(':generateContent')).length,2);
 assert(f.tables.conversation_memory_state[0].memory.question_lifecycle.some(item=>item.source_message_id===uuid(8201)&&item.status==='pending'));
 const replay=await f.run();assert.equal(replay.body.idempotent,true);
 assert.equal(f.requests.filter(item=>item.url.endsWith('/commit_ai_reply_tx')).length,1);assert.equal(f.commits.length,1);
});
for(const [guard,option,expected] of [
 ['human control',{humanAfterFirstDraft:true},'human_control'],
 ['superseded source',{newSourceAfterFirstDraft:true},'superseded_source'],
 ['stale revision',{rpcResult:'stale_authorized_revision'},'stale_authorized_revision'],
 ['unknown RPC acknowledgement',{rpcResult:'unrecognized_acknowledgement'},'unexpected_result'],
])test('V2 partial recovery: '+guard+' cannot trigger a second persistence attempt',async()=>{
 const f=v2PartialRecoveryFixture(option);const result=await f.run();
 assert.equal(f.commits.length,0,JSON.stringify({result,commits:f.commits}));
 assert(result.body.skipped===expected||String(result.body.error).includes(expected),JSON.stringify(result));
 const attempts=f.requests.filter(item=>item.url.endsWith('/commit_ai_reply_tx'));
 assert.equal(attempts.length,1,JSON.stringify({result,gates:catalogueGateEvents(f)}));
 assert.equal(attempts[0].body.p_metadata.response_route,'canonical_kb_partial_recovery');
 assert.equal(catalogueGateEvents(f).length,1,'control/CAS/unknown denial retried the clarification branch');
 assert.equal(f.requests.filter(item=>item.url.includes('context-search')).length,1);
 assert.equal(f.requests.filter(item=>item.url.endsWith(':generateContent')).length,2);
});
test('V2 partial recovery: constrained price retains the original unresolved clarification',async()=>{
 const price='AX-QZ81 兩件幾錢？',stock='有冇現貨？';
 const f=v2PartialRecoveryFixture({question:price+stock,semantic:task1SemanticContextWire([
  task1SemanticContextDemand(price,{subject_refs:['AX-QZ81'],requested_facts:['price'],constraints:{quantity:2}}),
  task1SemanticContextDemand(stock,{subject_refs:['AX-QZ81'],requested_facts:['availability']}),
 ],{topic:'AX-QZ81'})});
 const result=await f.run();assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.commits.length,1);
 const reply=f.commits[0];assert.equal(reply.metadata.response_route,'grounding_recovery_clarification');
 assert(!reply.metadata.recorded_kb_facts);assert(!/1,290|9,999,999/.test(reply.content));
 assert.deepEqual(reply.metadata.unresolved_fact_fields,['demand-1','demand-2']);
 const query=JSON.parse(f.requests.find(item=>item.url.includes('context-search')).body.query);
 assert.equal(query.questions[0].constraints.quantity,2,'recovery stripped the requested quantity');
 assert.equal(f.requests.filter(item=>item.url.endsWith(':generateContent')).length,2);
});
test('V2 partial recovery: foreign-tenant evidence cannot become a recovered price',async()=>{
 const f=v2PartialRecoveryFixture({originalRagResponse:task1cRagDocuments(task1cModelDocument({model:'AX-QZ81',price:1290,tenant:'99',currentness:'unknown',id:'foreign-recovery-price'}))});
 await f.run();
 assert(!f.commits.some(reply=>reply.metadata.response_route==='canonical_kb_partial_recovery'||reply.metadata.recorded_kb_facts?.length));
 assert(!f.commits.some(reply=>/1,290|9,999,999/.test(reply.content)));
 assert(!f.requests.some(item=>item.url.endsWith(':generateContent')&&!item.body?.generationConfig?.responseSchema));
});
function task1SemanticContextPrompt(f){
 const generation=f.requests.find(request=>request.url.endsWith(':generateContent')&&!request.body?.generationConfig?.responseSchema);
 assert(generation,'the complete request must reach governed generation');
 const system=generation.body.systemInstruction.parts[0].text;
 const block=system.split('[CURRENT_FACTUAL_REQUEST]\n')[1];assert(block,'generation is missing the unified current request');
 return {generation,system,request:JSON.parse(block.split('\n')[0])};
}
function task1SemanticContextCommitted(f,result,answer,document){
 assert.equal(result.status,200,JSON.stringify({result,events:f.events.slice(-8)}));
 assert.equal(f.commits.length,1,JSON.stringify({commits:f.commits,events:f.events.slice(-8)}));
 const reply=f.commits[0];assert.equal(reply.content,answer,JSON.stringify(reply.metadata));
 assert.equal(reply.metadata.citation_lineage?.selected_document_id,document);
 assert.equal(reply.metadata.b2_commit_source,'commit_ai_reply_tx');assert.notEqual(reply.metadata.generation_success,false);
 const memory=f.tables.conversation_memory_state[0]?.memory;assert(memory,'the answered customer request must have durable Memory');
 return {reply,memory};
}

// Current-topic applicability is separate from historical source existence.
// All names, records and model responses here are isolated fixtures. In the
// negative case the semantic provider confidently chooses a real older subject
// and retrieval can even supply that subject's price; neither proves that the
// customer's bare follow-up still refers to it.
function task3TopicSwitchFixture({source,question='How much?',referent='AX-QZ81',documents,answer}={}) {
 const oldSource=uuid(7301),newSource=uuid(7303),older='AX-QZ81',newer='Harbor field pack';
 const history=[
  {id:uuid(7304),role:'assistant',content:newer+' has a roll-top closure.',created_at:'2026-10-13T01:03:00.000Z',
   metadata:{source_message_id:newSource,control_commit:'ai',response_route:'canonical_kb_direct_answer',
    factual_request_subject:newer,citation_lineage:{selected_document_id:'earlier-pack-features',evidence_chunk_ids:['earlier-pack-features-full']}}},
  {id:newSource,role:'visitor',content:newer+' features?',created_at:'2026-10-13T01:02:00.000Z',metadata:{}},
  {id:uuid(7302),role:'assistant',content:'A processing problem prevented an answer; the question remains unresolved.',created_at:'2026-10-13T01:01:00.000Z',
   metadata:{source_message_id:oldSource,control_commit:'ai',response_route:'terminal_failure_recovery',generation_success:false}},
  {id:oldSource,role:'visitor',content:older+' price?',created_at:'2026-10-13T01:00:00.000Z',metadata:{}},
 ].map(row=>({...row,conversation_id:ticket,is_recalled:false}));
 const f=fixture(question,{source,originalPreview:true,fullChain:true,history,
  semantic:task1SemanticContextWire([task1SemanticContextDemand(question,{question:referent+' price?',subject_refs:[referent],requested_facts:['price']})],
   {language:'en',topic:referent,referents:[{ref:referent,source:question.includes(referent)?'current_turn':'prior_turn',confidence:.98}]}),
  originalRagResponse:documents,...(answer?{answer,
   verifierDemandResolutions:[{demand_id:'demand-1',status:'supported',evidence_ids:['E1']}]}:{})});
 return {f,source,oldSource,newSource,older,newer};
}
function task3TopicSwitchQuery(f,subject,excluded){
 const calls=f.requests.filter(request=>request.url.includes('context-search'));
 assert.equal(calls.length,1,'the factual follow-up must make one fresh subject-bound query');
 const query=JSON.parse(calls[0].body.query);
 assert.equal(query.questions.length,1);assert.deepEqual(query.questions[0].subjects,[subject]);
 assert.deepEqual(query.questions[0].requested_facts,['price']);
 assert(!calls[0].body.query.includes(excluded),'superseded conversational subject reached retrieval');
 return calls[0];
}
test('Task3 topic-switch v5: a confident older reference cannot query or commit its genuine price',async()=>{
 const c=task3TopicSwitchFixture({source:uuid(7310),documents:task1cRagDocuments(task1cModelDocument({model:'AX-QZ81',price:5432,id:'older-price-record'}))});
 const result=await c.f.run();assert.equal(result.status,200,JSON.stringify(result));
 task3TopicSwitchQuery(c.f,c.newer,c.older);
 assert.equal(c.f.commits.length,1);const reply=c.f.commits[0];
 assert(!reply.content.includes(c.older)&&!reply.content.includes('5,432'),'an available older price was substituted for the new product');
 assert.notEqual(reply.metadata.factual_request_subject,c.older);
 assert(!(reply.metadata.recorded_kb_facts??[]).some(fact=>fact.model===c.older||fact.value===5432));
 const memory=c.f.tables.conversation_memory_state[0]?.memory;assert(memory,'the same-ticket request must retain its state');
 const anchors=(memory.factual_read_anchors??[]).filter(anchor=>anchor.source_message_id===c.source);
 assert(anchors.length>0,'the current read must retain its customer-bound subject');
 assert(anchors.every(anchor=>anchor.subjects.includes(c.newer)&&!anchor.subjects.includes(c.older)&&anchor.subject_source_message_ids.includes(c.newSource)));
 const questions=memory.question_lifecycle.filter(item=>item.source_message_id===c.source);
 assert(questions.length>0&&questions.every(item=>item.status==='pending'),'an older product price must not resolve the new product question');
 await task1cAssertReplay(c.f);
});
test('Task3 topic-switch v5: correct newer named subject receives fresh price evidence',async()=>{
 const c=task3TopicSwitchFixture({source:uuid(7311),referent:'Harbor field pack',
  answer:'Harbor field pack costs HK$1,290.',
  documents:task1cRagDocuments(task1cModelDocument({model:'Harbor field pack',price:1290,id:'newer-price-record'}))});
 const result=await c.f.run();assert.equal(result.status,200,JSON.stringify(result));
 task3TopicSwitchQuery(c.f,c.newer,c.older);
 assert.equal(c.f.commits.length,1);const reply=c.f.commits[0];
 assert(reply.content.includes(c.newer)&&reply.content.includes('1,290'),JSON.stringify(reply));
 assert(!reply.content.includes(c.older));assert.equal(reply.metadata.factual_request_subject,c.newer);
 assert.equal(reply.metadata.kb_request_contract.subject_source_message_id,c.newSource);
 assert.equal(reply.metadata.citation_lineage.selected_document_id,'newer-price-record');
 assert.equal(reply.metadata.b2_commit_source,'commit_ai_reply_tx');
 const anchor=c.f.tables.conversation_memory_state[0]?.memory.factual_read_anchors?.find(anchor=>anchor.source_message_id===c.source);
 assert(anchor?.subjects.includes(c.newer)&&anchor.subject_source_message_ids.includes(c.newSource));
 await task1cAssertReplay(c.f);
});
test('Task3 topic-switch v5: an explicit return to the older product remains valid',async()=>{
 const c=task3TopicSwitchFixture({source:uuid(7312),question:'Back to AX-QZ81, how much?',
  documents:task1cRagDocuments(task1cModelDocument({model:'AX-QZ81',price:5432,id:'explicit-return-price'}))});
 const result=await c.f.run();assert.equal(result.status,200,JSON.stringify(result));
 task3TopicSwitchQuery(c.f,c.older,c.newer);
 const reply=task1cCommittedAnswer(c.f,{source:c.source,document:'explicit-return-price'});
 assert(reply.content.includes(c.older)&&reply.content.includes('5,432'));assert(!reply.content.includes(c.newer));
 assert.equal(reply.metadata.kb_request_contract.resolution,'explicit');
 assert.equal(reply.metadata.kb_request_contract.subject_source_message_id,c.source);
 await task1cAssertReplay(c.f);
});

function task2PolicyDocument(id,content,patch={}) {
 return {document_id:id,title:'客戶服務政策',source_type:'Policy',document_score:.96,
  authority:{tenant_id:'34',publication_state:'published',currentness:'current',regions:['hong_kong'],version:'isolated-evidence-v1'},
  evidence:[{document_id:id,chunk_id:id+'-full',chunk_type:'full_content',score:.96,content}],...patch};
}
test('Task2 evidence: KB transport rejects oversize query before credentials or network',async()=>{
 const f=fixture('unused'),{fetchKBRag}=f.load(path.join(root,'supabase/functions/_shared/kb-client.ts'));
 const unreachable=new Proxy({},{get(){throw Error('scope/credential accessed before query budget validation');}});
 for(const query of ['x'.repeat(1001),'中'.repeat(700)]){
  const result=await fetchKBRag({query,top_k:5},unreachable,unreachable);assert.equal(result.error_code,'KB_QUERY_BUDGET_EXCEEDED');
 }
 assert.equal(f.requests.length,0);
});
function task2PricePolicyFixture(options={}) {
 const model='CW-SUL70BA',priceQuestion=`${model} 幾錢？`,discountQuestion='有冇會員折扣？',deliveryQuestion='訂購後一般多久可送貨？';
 const question=priceQuestion+discountQuestion+deliveryQuestion;
 const answer=`${model} 現時售價為 HK$4,680。會員購買可享九五折，特價商品除外。一般於訂購後三至五個工作天送貨，離島需另行確認。`;
 return fixture(question,{source:uuid(8101),originalPreview:true,fullChain:true,answer,
  verifierIds:['E1','E2','E3'],verifierDemandResolutions:[
   {demand_id:'demand-1',status:'supported',evidence_ids:['E1']},
   {demand_id:'demand-2',status:'supported',evidence_ids:['E2']},
   {demand_id:'demand-3',status:'supported',evidence_ids:['E3']}],
  semantic:task1SemanticContextWire([
   task1SemanticContextDemand(priceQuestion,{subject_refs:[model],requested_facts:['price']}),
   task1SemanticContextDemand(discountQuestion,{source_type:'policy',requested_facts:['membership_discount']}),
   task1SemanticContextDemand(deliveryQuestion,{source_type:'policy',requested_facts:['delivery_time']}),
  ],{topic:model}),originalRagResponse:task1cRagDocuments(task1cModelDocument({id:'task2-price'}),
   task2PolicyDocument('task2-discount','會員購買一般商品可享九五折，特價商品除外。'),
   task2PolicyDocument('task2-delivery','一般商品於訂購後三至五個工作天送貨，離島需另行確認。')),...options});
}
test('Task2 evidence: actual handler retains price and both applicable policy sources in one complete answer',async()=>{
 const f=task2PricePolicyFixture();const result=await f.run();
 const {reply,memory}=task1SemanticContextCommitted(f,result,`CW-SUL70BA 現時售價為 HK$4,680。會員購買可享九五折，特價商品除外。一般於訂購後三至五個工作天送貨，離島需另行確認。`,null);
 assert.equal(f.requests.filter(request=>request.url.includes('context-search')).length,1);
 assert.deepEqual(reply.metadata.citations.map(item=>item.document_id),['task2-price','task2-discount','task2-delivery']);
 assert.deepEqual(reply.metadata.citation_lineage.source_bindings.map(item=>item.demand_ids),[['demand-1'],['demand-2'],['demand-3']]);
 assert.equal(reply.metadata.reference_authority,null);assert.equal(reply.metadata.reference_authorities.length,3);
 assert.deepEqual(reply.metadata.unresolved_fact_fields,[]);
 assert.equal(reply.metadata.grounding_verification.question_resolution,'supported');
 const nextQuestion='CW-SUL70BA 係咩品牌？';
 const next=fixture(nextQuestion,{source:uuid(8102),originalPreview:true,fullChain:true,previous:f.tables,history:f.tables.messages,
  answer:'CW-SUL70BA 的品牌是 Fixture Home。',verifierDemandResolutions:[{demand_id:'demand-1',status:'supported',evidence_ids:['E1']}],
  semantic:task1SemanticContextWire([task1SemanticContextDemand(nextQuestion,{subject_refs:['CW-SUL70BA'],requested_facts:['brand']})],{topic:'CW-SUL70BA'}),
  originalRagResponse:task1cRagDocuments(task1cModelDocument({id:'task2-next-brand'}))});
 assert.equal((await next.run()).status,200);
 assert(next.tables.conversation_memory_state[0].memory.grounded_reference_lineage.some(item=>item.document_id==='task2-delivery'),
  'next-turn canonical Memory must retain the delivered policy source lineage');
});

for(const [name,options] of [
 ['omitted demand',{verifierDemandResolutions:[{demand_id:'demand-1',status:'supported',evidence_ids:['E1']}]}],
 ['unknown evidence alias',{verifierIds:['E99']}],
 ['partial receipt with falsely complete child demands',{verifierResolution:'partial'}],
 ['unsupported fee using the valid selling-price amount',{answer:'CW-SUL70BA 現時售價為 HK$4,680。CW-SUL70BA 現時送貨收費 HK$4,680。會員可享九五折，特價商品除外。一般三至五個工作天送貨，離島需確認。'}],
])test('Task2 evidence: actual handler rejects '+name,async()=>{
 const f=task2PricePolicyFixture(options);const result=await f.run();
 assert.equal(f.commits.length,1);assert(['LLM_GROUNDING_REJECTED','LLM_INVALID_OUTPUT','B2_SUPERVISION_BLOCKED'].includes(f.commits[0].metadata.source_error_code),JSON.stringify({result,reply:f.commits[0]}));
 assert.notEqual(f.commits[0].content,options.answer);
 const pending=f.tables.conversation_memory_state[0]?.memory.question_lifecycle.find(item=>item.source_message_id===uuid(8101));
 assert.notEqual(pending?.status,'resolved');
});

test('Task2 evidence: actual handler cites only the policy actually used by the verifier',async()=>{
 const question='普通訂單一般幾時送到？',answer='一般訂單於付款後三至五個工作天送貨，離島需另行確認。';
 const f=fixture(question,{source:uuid(8110),originalPreview:true,fullChain:true,answer,verifierIds:['E2'],
  verifierDemandResolutions:[{demand_id:'demand-1',status:'supported',evidence_ids:['E2']}],
  semantic:task1SemanticContextWire([task1SemanticContextDemand(question,{source_type:'policy',requested_facts:['delivery_period']})]),
  originalRagResponse:task1cRagDocuments(task2PolicyDocument('unrelated-policy','會員可參加專屬活動。'),task2PolicyDocument('used-policy',answer))});
 const result=await f.run();const {reply}=task1SemanticContextCommitted(f,result,answer,'used-policy');
 assert.deepEqual(reply.metadata.citations.map(item=>item.document_id),['used-policy']);
 assert.equal(reply.metadata.reference_authorities.length,1);
});

test('Task2 evidence: actual handler preserves supported region while another region remains unavailable',async()=>{
 const price='CW-SUL70BA 幾錢？',hk='香港訂購後一般幾時送貨？',tw='台灣可唔可以送？',question=price+hk+tw;
 const answer='CW-SUL70BA 現時售價為 HK$4,680。香港一般訂單於付款後三至五個工作天送貨。台灣送貨安排目前未能確認。';
 const f=fixture(question,{source:uuid(8111),originalPreview:true,fullChain:true,answer,verifierResolution:'partial',verifierIds:['E1','E2'],
  verifierDemandResolutions:[{demand_id:'demand-1',status:'supported',evidence_ids:['E1']},{demand_id:'demand-2',status:'supported',evidence_ids:['E2']},{demand_id:'demand-3',status:'unavailable',evidence_ids:[]}],
  semantic:task1SemanticContextWire([task1SemanticContextDemand(price,{subject_refs:['CW-SUL70BA'],requested_facts:['price']}),task1SemanticContextDemand(hk,{source_type:'policy',requested_facts:['delivery_period']}),
   task1SemanticContextDemand(tw,{source_type:'policy',requested_facts:['delivery_region']})]),
  originalRagResponse:task1cRagDocuments(task1cModelDocument({id:'hk-price'}),task2PolicyDocument('hk-delivery','香港一般訂單於付款後三至五個工作天送貨。'))});
 const result=await f.run();const {reply}=task1SemanticContextCommitted(f,result,answer,null);
 assert.deepEqual(reply.metadata.citations.map(item=>item.document_id),['hk-price','hk-delivery']);
 assert.deepEqual(reply.metadata.unresolved_fact_fields,['demand-3']);assert.equal(reply.metadata.grounding_verification.question_resolution,'partial');
});

test('Task2 evidence: unresolved same-scope policy conflict fails complete-answer verification',async()=>{
 const question='未開封的一般商品付款後幾日內可退？';
 const a=task2PolicyDocument('returns-seven','一般商品未開封，可於付款後七日內退回。');
 const b=task2PolicyDocument('returns-thirty','一般商品未開封，可於付款後三十日內退回。');
 a.authority.claims=[{key:'return_days',value:'7'}];b.authority.claims=[{key:'return_days',value:'30'}];
 const f=fixture(question,{source:uuid(8112),originalPreview:true,fullChain:true,answer:'一般商品未開封，可於付款後三十日內退回。',
  verifierGrounded:false,verifierIds:[],verifierResolution:'unsupported',verifierDemandResolutions:[],
  semantic:task1SemanticContextWire([task1SemanticContextDemand(question,{source_type:'policy',requested_facts:['returns_period']})]),
  originalRagResponse:task1cRagDocuments(a,b)});
 const result=await f.run();assert.equal(f.commits[0]?.metadata.source_error_code,'LLM_GROUNDING_REJECTED',JSON.stringify({result,reply:f.commits[0]}));
 const prompt=task1SemanticContextPrompt(f);assert(prompt.system.includes('七日內')&&prompt.system.includes('三十日內'));
});

test('Task2 evidence: verifier receives the whole answer beyond the former tail cutoff',async()=>{
 const tail='未獲來源支持的額外保證。',answer='適用條件仍須逐項核對。'.repeat(350)+tail;
 const f=task2PricePolicyFixture({answer,verifierGrounded:false,verifierIds:[],verifierResolution:'unsupported',verifierDemandResolutions:[]});
 await f.run();const verifier=f.requests.find(request=>request.body?.generationConfig?.responseSchema?.properties?.grounded);
 assert(verifier);const text=JSON.stringify(verifier.body.contents);assert(text.includes(tail)&&text.length>3000);
 assert.equal(f.commits[0]?.metadata.source_error_code,'LLM_GROUNDING_REJECTED');assert.notEqual(f.commits[0].content,answer);
});
test('Task2 evidence: over-limit answer is rejected rather than partly verified',async()=>{
 const answer='說明'.repeat(6100),f=task2PricePolicyFixture({answer});await f.run();
 assert(!f.requests.some(request=>request.body?.generationConfig?.responseSchema?.properties?.grounded));
 assert.notEqual(f.commits[0]?.content,answer);assert.equal(f.commits[0]?.metadata.source_error_code,'LLM_GROUNDING_REJECTED');
});

for(const [question,id] of [['邊個牌子出嘅？',7101],['它是甚麼品牌？',7102]])test('Task1 semantic context: v4 unfamiliar brand follow-up retains the actual customer subject '+question,async()=>{
 const model='CW-SUL70BA',oldSource='a7c101ab-c401-4d8b-8c63-8a10701abcde',source=uuid(id);
 const old={id:oldSource,conversation_id:ticket,role:'visitor',content:`我想了解 ${model}。`,created_at:'2026-10-13T01:00:00.000Z',is_recalled:false,metadata:{}};
 const answer=`${model} 的品牌是 Fixture Home。`;
 const f=fixture(question,{source,originalPreview:true,fullChain:true,history:[old],answer,
  verifierDemandResolutions:[{demand_id:'demand-1',status:'supported',evidence_ids:['E1']}],
  semantic:task1SemanticContextWire([task1SemanticContextDemand(question,{question:`${model} 的品牌是甚麼？`,subject_refs:[model],requested_facts:['brand']})],
   {topic:model,referents:[{ref:model,source:'prior_turn',confidence:.98}]}),
  originalRagResponse:task1cRagDocuments(task1cModelDocument({id:'v4-brand-document'}))});
 const result=await f.run();const {reply,memory}=task1SemanticContextCommitted(f,result,answer,'v4-brand-document');
 const rag=f.requests.filter(request=>request.url.includes('context-search'));assert.equal(rag.length,1);
 const query=JSON.parse(rag[0].body.query);assert.equal(query.questions.length,1);assert.deepEqual(query.questions[0].subjects,[model]);assert.deepEqual(query.questions[0].requested_facts,['brand']);
 const generated=task1SemanticContextPrompt(f);assert.equal(generated.request.original_question,question);assert.equal(generated.request.subject,model);
 assert.equal(generated.request.subject_source_message_ids.length,1);assert.deepEqual(generated.request.demands[0].requested_facts,['brand']);
 // The real LLM privacy boundary redacts UUIDs. Exact source ownership remains
 // asserted against the server receipt and durable customer anchor below.
 assert.equal(reply.metadata.kb_request_contract.subject_source_message_id,oldSource);
 assert.equal(reply.metadata.kb_request_contract.query_sha256,hash(rag[0].body.query));
 const anchor=memory.factual_read_anchors?.find(item=>item.source_message_id===source);assert(anchor,'read follow-up was not retained');
 assert(anchor.subjects.includes(model));assert(anchor.subject_source_message_ids.includes(oldSource));
 assert(!(f.tables.conversation_commerce_state[0]?.state.entities??[]).some(entity=>entity.model===model),'a read-only reference became a purchase entity');
});

test('Task1 semantic context: v4 mixed personal order and product question preserves both demands without leaking the order into KB',async()=>{
 const source=uuid(7110),model='CW-SUL70BA',orderQuote='訂單 12354 出貨未？',productQuote=`${model} 有咩功能？`;
 const question=orderQuote+'另外 '+productQuote;
 const answer=`${model} 提供製冷、送風及除濕功能。我目前未能核實訂單 12354 的即時出貨狀態，需要商家查核。`;
 const f=fixture(question,{source,originalPreview:true,fullChain:true,answer,
  verifierResolution:'partial',verifierDemandResolutions:[{demand_id:'demand-1',status:'unavailable',evidence_ids:[]},{demand_id:'demand-2',status:'supported',evidence_ids:['E1']}],
  semantic:task1SemanticContextWire([
   task1SemanticContextDemand(orderQuote,{subject_refs:['12354'],source_type:'transaction',requested_facts:['order_status']}),
   task1SemanticContextDemand(productQuote,{subject_refs:[model],requested_facts:['features']}),
  ],{topic:model}),originalRagResponse:task1cRagDocuments(task1cModelDocument({id:'v4-mixed-features-document'}))});
 const result=await f.run();const {reply,memory}=task1SemanticContextCommitted(f,result,answer,'v4-mixed-features-document');
 const rag=f.requests.filter(request=>request.url.includes('context-search'));assert.equal(rag.length,1,'whole-turn order routing bypassed the product lookup');
 assert(!rag[0].body.query.includes('12354'));assert(!rag[0].body.query.includes('order_status'));
 const query=JSON.parse(rag[0].body.query);assert.equal(query.questions.length,1);assert.deepEqual(query.questions[0].subjects,[model]);assert.deepEqual(query.questions[0].requested_facts,['features']);
 const generated=task1SemanticContextPrompt(f);assert.equal(generated.request.original_question,question);assert.equal(generated.request.demands.length,2);
 assert.deepEqual(generated.request.demands.map(demand=>demand.source_type),['transaction','product']);
 assert.equal(generated.request.transaction_required,true);assert(generated.request.missing_evidence.some(item=>item.reason==='live_transaction_unavailable'));
 assert(generated.system.includes('Missing live transaction evidence remains unresolved'));
 const verifier=f.requests.find(request=>request.body?.generationConfig?.responseSchema?.properties?.grounded);assert(verifier,'mixed requests must reach the complete-question verifier');
 assert(JSON.stringify(verifier.body).includes('live_transaction_unavailable'));assert(JSON.stringify(verifier.body).includes('12354'));
 assert.equal(reply.metadata.kb_request_contract.demand_count,2);assert.equal(reply.metadata.kb_request_contract.transaction_required,true);
 assert(memory.question_lifecycle.some(item=>item.text.includes('12354')&&item.text.includes(model)),'Memory lost one part of the original request');
 assert(memory.question_lifecycle.some(item=>item.source_message_id===source&&item.status==='pending'),'partially answered order/product request was falsely resolved');
 assert.deepEqual(reply.metadata.unresolved_fact_fields,['demand-1']);
});

test('Task1 semantic context: v4 membership preserves policy demand and reaches KB without topical early return',async()=>{
 const question='會員等級？',source=uuid(7120),answer='會員分為基本會員及進階會員；基本會員適用一般購物，進階會員可參加會員活動。';
 const document={document_id:'v4-membership-policy',title:'會員等級',source_type:'FAQ',document_score:.97,
  authority:{tenant_id:'34',publication_state:'published',currentness:'current',regions:['hong_kong']},
  evidence:[{document_id:'v4-membership-policy',chunk_id:'v4-membership-policy-full',chunk_type:'full_content',score:.97,content:answer}]};
 const f=fixture(question,{source,originalPreview:true,fullChain:true,answer,
  verifierDemandResolutions:[{demand_id:'demand-1',status:'supported',evidence_ids:['E1']}],
  semantic:task1SemanticContextWire([task1SemanticContextDemand(question,{question:'會員有哪些等級，各級有甚麼分別？',source_type:'policy',requested_facts:['membership_tiers']})],{topic:'會員等級'}),
  originalRagResponse:task1cRagDocuments(document)});
 // Task2 now retains the FAQ as a policy candidate and verifies its actual
 // applicability/answer coverage. The proposal and verifier remain isolated.
 const result=await f.run();assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.commits.length,1);
 const reply=f.commits[0],memory=f.tables.conversation_memory_state[0]?.memory;assert(memory);
 const rag=f.requests.filter(request=>request.url.includes('context-search'));assert.equal(rag.length,1,'short membership wording took the former fixed no-information exit');
 assert.deepEqual(JSON.parse(rag[0].body.query),{questions:[{question:'會員有哪些等級，各級有甚麼分別？'.normalize('NFKC'),customer_text:question.normalize('NFKC'),subjects:[],requested_facts:['membership_tiers'],source_type:'policy',scope:'merchant_rules_and_subject_exceptions'}]});
 assert.equal(reply.content,answer);assert.equal(reply.metadata.citation_lineage.selected_document_id,document.document_id);
 assert.deepEqual(reply.metadata.grounding_verification.demand_resolutions,[{demand_id:'demand-1',status:'supported',evidence_ids:['E1']}]);
 assert.equal(reply.metadata.kb_request_contract.demand_count,1);assert.equal(reply.metadata.kb_request_contract.source_message_id,source);
 assert.equal(reply.metadata.kb_request_contract.query_sha256,hash(rag[0].body.query));assert.equal(reply.metadata.rag_api_status,'success');
 assert.notEqual(reply.metadata.response_route,'workflow5_topical_recovery');
 assert(memory.question_lifecycle.some(item=>item.source_message_id===source&&item.text===question.normalize('NFKC')),'Memory changed the original short question');
 const anchor=memory.factual_read_anchors.find(item=>item.source_message_id===source);assert(anchor);assert.equal(anchor.customer_text,question.normalize('NFKC'));
 assert.deepEqual(anchor.requested_facts,['membership_tiers']);
});

test('Task1 semantic context: v4 restores the first customer original after 130 intervening turns before querying KB',async()=>{
 const model='CW-SUL70BA',oldSource='b7c131ab-c401-4d8b-8c63-8a13701abcde',source=uuid(7131),question='最初嗰部係咩牌子？',answer=`最初提到的 ${model}，品牌是 Fixture Home。`;
 const old={id:oldSource,conversation_id:ticket,role:'visitor',content:`最初想了解的是 ${model}。`,created_at:'2026-10-13T01:00:00.000Z',is_recalled:false,metadata:{}};
 const history=Array.from({length:130},(_,i)=>({id:uuid(7200+i),conversation_id:ticket,role:'visitor',content:'thanks',
  created_at:new Date(Date.parse(old.created_at)+(i+1)*1000).toISOString(),is_recalled:false,metadata:{}})).reverse();
 history.push(old);
 const f=fixture(question,{source,originalPreview:true,fullChain:true,history,answer,
  verifierDemandResolutions:[{demand_id:'demand-1',status:'supported',evidence_ids:['E1']}],
  semantic:task1SemanticContextWire([task1SemanticContextDemand(question,{question:`${model} 的品牌是甚麼？`,subject_refs:[model],requested_facts:['brand']})],
   {topic:model,referents:[{ref:model,source:'prior_turn',confidence:.98}]}),
  originalRagResponse:task1cRagDocuments(task1cModelDocument({id:'v4-recovered-brand-document'}))});
 const result=await f.run();const {reply,memory}=task1SemanticContextCommitted(f,result,answer,'v4-recovered-brand-document');
 const semantic=f.requests.find(request=>request.body?.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.'));assert(semantic);
 const semanticText=semantic.body.contents.flatMap(content=>content.parts).map(part=>part.text??'').join('\n');
 assert(semanticText.includes(old.content));assert(semanticText.includes('Recovered earlier original customer messages'));
 assert(f.tables.messages.findIndex(row=>row.id===oldSource)>100);
 const rag=f.requests.filter(request=>request.url.includes('context-search'));assert.equal(rag.length,1);assert.deepEqual(JSON.parse(rag[0].body.query).questions[0].subjects,[model]);
 const generated=task1SemanticContextPrompt(f);assert.equal(generated.request.subject,model);assert.equal(generated.request.subject_source_message_ids.length,1);
 assert.equal(reply.metadata.kb_request_contract.subject_source_message_id,oldSource);
 assert(memory.factual_read_anchors.some(anchor=>anchor.source_message_id===source&&anchor.subject_source_message_ids.includes(oldSource)));
});
