/** Legal isolated transport. Entire generate-reply handler and local import
 * graph run unchanged; only external SDK/auth/HTTP boundaries are isolated.
 * This suite is source runtime evidence, never Hosted acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import ts from 'typescript';
const root=path.resolve(new URL('../..',import.meta.url).pathname);
const sdkRequire=createRequire(path.resolve(process.env.C3_CONSOLE_SDK_ROOT || root,'package.json'));
const sdk=sdkRequire('@supabase/supabase-js');
assert.equal(sdkRequire('@supabase/supabase-js/package.json').version,'2.45.0');
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const company=uuid(1),ticket=uuid(2),source=uuid(3);
function fixture(text,options={}) {
 const requests=[],logs=[],commits=[],events=[]; let handler,mode=options.mode || 'ok',foreign=false;
 const conversation={id:ticket,company_id:company,status:options.human?'human_control':'open',assigned_agent_id:null,metadata_source:{}};
 const visitor={id:source,conversation_id:ticket,role:'visitor',content:text,is_recalled:false,created_at:'2026-10-14T01:00:00.000Z',metadata:{}};
 const tables={company:[{id:company,is_active:true}],conversations:[conversation],messages:[visitor],conversation_commerce_state:[],conversation_memory_state:[],conversation_memory_state_event:[],c3_memory_reply_lifecycle_receipt:[]};
 if(options.retainedMemory)tables.conversation_memory_state.push({conversation_id:ticket,company_id:company,revision:7,memory:{current_customer_facts:[{key:'subscription_seats',value:17,source_message_id:uuid(30)}]}});
 const env={SUPABASE_URL:'http://isolated.invalid',SUPABASE_SECRET_KEY:'isolated-fake-key',ENABLE_KB_ADAPTER:'true',LLM_PROVIDER:'vertex',LLM_MODEL_EVALUATION:'gemini-2.5-flash',LLM_MODEL_GENERATION:'gemini-2.5-flash',GOOGLE_PROJECT_ID:'isolated-project',GOOGLE_REGION:'us-central1',GOOGLE_SERVICE_ACCOUNT_JSON:'{}',LLM_TIMEOUT_MS:'5'};
 const network=async (input,init={})=>{
  const url=new URL(input instanceof Request?input.url:String(input)); const method=init.method||'GET';
  const body=init.body?JSON.parse(String(init.body)):null;
  requests.push({url:url.href,method,body});
  if(url.hostname==='us-central1-aiplatform.googleapis.com') {
   assert(url.pathname.endsWith('/gemini-2.5-flash:generateContent'));
   assert.equal(body.generationConfig.thinkingConfig.thinkingBudget,0);
   assert.equal(body.generationConfig.responseMimeType,'application/json');
   assert.equal(body.generationConfig.responseSchema.properties.delta_json.type,'STRING');
   assert.equal(Object.keys(body.generationConfig.responseSchema.properties).length,3);
   if(mode==='400')return Response.json({error:{status:'INVALID_ARGUMENT',message:'response schema too complex; PRIVATE-SECRET user@example.invalid',details:[{fieldViolations:[{field:'generation_config.response_schema',description:'PRIVATE-SECRET'}]}]}},{status:400});
   if(mode==='timeout')return await new Promise((resolve,reject)=>{if(init.signal?.aborted)return reject(new DOMException('isolated','AbortError'));init.signal?.addEventListener('abort',()=>reject(new DOMException('isolated','AbortError')),{once:true})});
   if(mode==='malformed')return Response.json({candidates:[{content:{parts:[{text:'{broken'}]},finishReason:'STOP'}]});
   const semantic=options.semantic || {operation:'ASK_FACT',confidence:0.96,delta_json:JSON.stringify({intent:'merchant_policy',requested_facts:['published policy']})};
   return Response.json({candidates:[{content:{parts:[{text:JSON.stringify(semantic)}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:40,candidatesTokenCount:30}});
  }
  assert.equal(url.origin,'http://isolated.invalid','live network escaped isolated transport');
  if(url.pathname.startsWith('/rest/v1/rpc/')) {
   const rpc=url.pathname.split('/').at(-1);
   if(['explicit_handoff_tx','required_escalation_handoff_tx'].includes(rpc))return Response.json({result:'success'});
   if(rpc==='commit_ai_reply_tx') {
    assert.equal(body.p_conversation_id,ticket);assert.equal(body.p_source_message_id,source);
    assert.equal(body.p_metadata.b2_expected_company_id,company);
    if(options.rpcResult)return Response.json({result:options.rpcResult});
    if(foreign)return Response.json({result:'tenant_mismatch'});
    if(commits.length)return Response.json(body.p_content===commits[0].content?{result:'idempotent',message_id:commits[0].id}:{result:'response_substitution'});
    const reply={id:uuid(10),conversation_id:ticket,role:'assistant',content:body.p_content,is_recalled:false,metadata:{...body.p_metadata,source_message_id:source,control_commit:'ai'}};
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
 const modules=new Map(), deno={env:{get:k=>env[k]},serve:h=>{handler=h}};
 function load(file){
  if(modules.has(file))return modules.get(file);
  const sourceCode=fs.readFileSync(file,'utf8');
  const code=ts.transpileModule(sourceCode,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const module={exports:{}};modules.set(file,module.exports);
  const require=spec=>{
   if(spec.startsWith('.'))return load(path.resolve(path.dirname(file),spec));
   if(spec==='npm:google-auth-library@9.15.0')return {GoogleAuth:class {async getClient(){return {getAccessToken:async()=>({token:'isolated-fake-token'})}}}};
   if(spec==='npm:@supabase/supabase-js@2.45.0'||spec==='https://esm.sh/@supabase/supabase-js@2.45.0')return {...sdk,createClient:(u,k,opts)=>sdk.createClient(u,k,{...opts,auth:{autoRefreshToken:false,persistSession:false},global:{fetch:network}})};
   throw Error('unapproved external import '+spec);
  };
  new Function('require','module','exports','Deno','fetch','console',code)(require,module,module.exports,deno,network,{log:(...v)=>events.push(v),warn:(...v)=>events.push(v),error:(...v)=>events.push(v)});
  modules.set(file,module.exports);return module.exports;
 }
 load(path.join(root,'supabase/functions/generate-reply/index.ts'));
 return {run:async()=>{const response=await handler(new Request('http://isolated.invalid/functions/v1/generate-reply',{method:'POST',body:JSON.stringify({conversation_id:ticket,source_message_id:source})}));return {status:response.status,body:await response.json()};},requests,logs,commits,events,tables,env,load,setMode:v=>{mode=v},setForeign:()=>{foreign=true}};
}
const social=['hi how are you',"what's your name",'who are you?','Hey, how have you been?','hello and how are you doing today?','早晨！你今日好唔好？','你好，你是誰？','你叫咩名？','Are you a real person?','Are you an AI assistant?','What can you help me with?','Hi，你係真人嗎？','thank you','明白啦'];
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
 assert.equal(r.status,200);assert.equal(r.body.degraded,true);assert.equal(r.body.generation_success,false);assert.match(r.body.reply,/technical problem/);
 assert.doesNotMatch(r.body.reply,/verify|knowledge|KB/i);assert.equal(f.commits.length,1);assert.equal(f.commits[0].metadata.source_error_code,'semantic_interpretation_failed');
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
  assert.equal(result.frame,null);assert.equal(result.failure_code,'LLM_ACCOUNTING_DENIED');
 }
 await assert.rejects(interpret({company_id:'4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec',conversation_id:ticket,source_message_id:source,latest:'Check current delivery options',persistent_state_summary:'{}'}),/UAT_AUTHORIZATION_ABSENT/);
 assert(!f.requests.some(r=>r.url.includes('aiplatform')));
});
test('actual interpreter recovers from an isolated 400 using same call path and preserves typed semantic delta',async()=>{
 const f=fixture('unused',{mode:'400',semantic:{operation:'DEFER',confidence:0.98,delta_json:JSON.stringify({intent:'defer_rental',entities:[{name:'conference equipment',kind:'rental',confidence:0.98}],explicit_negations:['not paid']})}}),interpret=f.load(path.join(root,'supabase/functions/_shared/commerce-semantic-interpreter.ts')).interpretCommerceSemantics;
 const input={company_id:company,conversation_id:ticket,source_message_id:source,latest:'Defer the rental; not paid yet',persistent_state_summary:'{}'};
 assert.equal((await interpret(input)).failure_code,'LLM_NON_2XX');f.setMode('ok');const result=await interpret(input);assert.equal(result.failure_code,null);assert.equal(result.frame.operation,'DEFER');assert.deepEqual(result.frame.explicit_negations,['not paid']);assert.equal(f.logs.length,2);assert.equal(f.logs[0].request_payload.outcome,'failed');assert.equal(f.logs[1].request_payload.outcome,'success');
});
