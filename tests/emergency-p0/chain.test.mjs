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
function fixture(text,options={}) {
 const company=options.company ?? uuid(1),source=options.source??uuid(3);
 const requests=[],logs=[],commits=[],events=[]; let handler,mode=options.mode || 'ok',foreign=false;
 const conversation={id:ticket,company_id:company,status:options.human?'human_control':'open',assigned_agent_id:null,metadata_source:{}};
 const visitor={id:source,conversation_id:ticket,role:'visitor',content:text,is_recalled:false,created_at:'2026-10-14T01:00:00.000Z',metadata:{}};
 const tables={conversation_commerce_state_event:[],company:[{id:company,is_active:true}],conversations:[conversation],messages:[visitor],conversation_commerce_state:[],conversation_memory_state:[],conversation_memory_state_event:[],c3_memory_reply_lifecycle_receipt:[]};
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
   if(body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.'))assert.equal(body.generationConfig.thinkingConfig?.thinkingBudget,company==='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'?1024:0);
   if(options.fullChain && !body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.')) {
    const verifier=body.generationConfig.responseSchema?.properties?.grounded;
    const text=verifier?JSON.stringify({grounded:true,unsupported_claims:[],evidence_chunk_ids:['E1']}):options.answer??'CW-SUL70BA 的能源效益資料請參閱官方能源標籤；目前文件未列出能源級別，我不會估計。';
    return Response.json({candidates:[{content:{parts:[{text}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:30}});
   }
   assert.equal(body.generationConfig.responseMimeType,'application/json');
   assert.equal(body.generationConfig.responseSchema.properties.delta_json.type,'STRING');
   assert.equal(Object.keys(body.generationConfig.responseSchema.properties).length,3);
   if(mode==='400')return Response.json({error:{status:'INVALID_ARGUMENT',message:'response schema too complex; PRIVATE-SECRET user@example.invalid',details:[{fieldViolations:[{field:'generation_config.response_schema',description:'PRIVATE-SECRET'}]}]}},{status:400});
   if(mode==='timeout')return await new Promise((resolve,reject)=>{if(init.signal?.aborted)return reject(new DOMException('isolated','AbortError'));init.signal?.addEventListener('abort',()=>reject(new DOMException('isolated','AbortError')),{once:true})});
   if(mode==='malformed')return Response.json({candidates:[{content:{parts:[{text:'{broken'}]},finishReason:'STOP'}]});
   const semantic=options.semantic || {operation:'ASK_FACT',confidence:0.96,delta_json:JSON.stringify({intent:'merchant_policy',requested_facts:['published policy']})};
   return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(semantic)}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:30}});
  }
  if(options.fullChain && url.origin==='https://py.ebixmall.com') {
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
    if(options.rpcResult)return Response.json({result:options.rpcResult});
    if(foreign)return Response.json({result:'tenant_mismatch'});
    if(commits.length)return Response.json(body.p_content===commits[0].content?{result:'idempotent',message_id:commits[0].id}:{result:'response_substitution'});
    const reply={id:options.source?uuid(Number(source.slice(-6))+1000):uuid(10),conversation_id:ticket,role:'assistant',content:body.p_content,is_recalled:false,metadata:{...body.p_metadata,source_message_id:source,control_commit:'ai'}};
    commits.push(reply);tables.messages.push(reply);return Response.json({result:'success',message_id:reply.id});
   }
   throw Error('unhandled isolated RPC '+rpc);
  }
  const table=url.pathname.split('/').at(-1);
  if(table==='upstream_call_log'&&method==='POST'){logs.push(body);return new Response(null,{status:201});}
  if(method==='DELETE')return new Response(null,{status:204});
  assert.equal(method,'GET','unexpected mutation '+table);
  assert(table in tables,'unhandled isolated table '+table);
  let rows=tables[table];
  for(const [field,value] of url.searchParams){
   if(value.startsWith('eq.')) rows=rows.filter(r=>String(r[field])===value.slice(3));
   if(value.startsWith('neq.')) rows=rows.filter(r=>String(r[field])!==value.slice(4));
  }
  if(foreign&&table==='company')rows=[];
  if(foreign&&table==='messages'&&url.searchParams.get('id')===`eq.${source}`)rows=[];
  const headers=new Headers(init.headers);const object=headers.get('accept')?.includes('pgrst.object');
  if(method==='HEAD') return new Response(null,{headers:{'content-range':`0-0/${rows.length}`}});
  return Response.json(object?(rows[0]??null):rows,{headers:{'content-range':`0-${Math.max(0,rows.length-1)}/${rows.length}`}});
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
  new Function('require','module','exports','Deno','fetch','console',code)(require,module,module.exports,deno,network,{log:(...v)=>events.push(v),warn:(...v)=>events.push(v),error:(...v)=>events.push(v.map(x=>x instanceof Error?{name:x.name,message:x.message}:x))});
  modules.set(file,module.exports);return module.exports;
 }
 load(path.join(root,'supabase/functions/generate-reply/index.ts'));
 return {run:async()=>{const response=await handler(new Request('http://isolated.invalid/functions/v1/generate-reply',{method:'POST',body:JSON.stringify({conversation_id:ticket,source_message_id:source})}));return {status:response.status,body:await response.json()};},requests,logs,commits,events,tables,env,load,setMode:v=>{mode=v},setForeign:()=>{foreign=true}};
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
 assert(request.includes('customer_correction'));assert(request.includes('"value_json"'));assert(!request.includes('customer_facts, lifecycle, correction, negations'));
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
