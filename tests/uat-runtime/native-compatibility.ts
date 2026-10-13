import {callModel} from '../../supabase/functions/_shared/llm-router.ts';
import {accountedModelFetch} from '../../supabase/functions/_shared/model-attempt-accounting.ts';
import {uatMap,UAT_COMPANY,UAT_REVISION,legacyPreactivationAuthority} from '../../supabase/functions/_shared/uat-execution-contract.ts';
import {createClient} from 'npm:@supabase/supabase-js@2.45.0';
import {fetchKBRag} from '../../supabase/functions/_shared/kb-client.ts';
import {GoogleAuth} from 'npm:google-auth-library@9.15.0';
const company='11111111-1111-4111-8111-111111111111',conv='99999999-9999-4999-8999-999999999999',uatConv='22222222-2222-4222-8222-222222222222',run='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function assert(v:unknown,message='assertion'):asserts v{if(!v)throw Error(message)}
const equal=(a:unknown,b:unknown)=>assert(JSON.stringify(a)===JSON.stringify(b),`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";
async function sql(query:string){const r=await new Deno.Command('psql',{args:[Deno.env.get('C3_UAT_TEST_DB_URL')!,'-XAt','-v','ON_ERROR_STOP=1','-c',query],stdout:'piped',stderr:'piped'}).output();return {ok:r.success,text:new TextDecoder().decode(r.stdout).trim(),error:new TextDecoder().decode(r.stderr)}};
let providerRequests:unknown[]=[],retry=0,unknown=false, permanentCalls=0;
const network=async(input:RequestInfo|URL,init?:RequestInit):Promise<Response>=>{
 const url=new URL(String(input instanceof Request?input.url:input));const body=init?.body?JSON.parse(String(init.body)):{};
 if(url.origin==='http://native.invalid'){
  if(url.pathname==='/auth/v1/user')return Response.json({message:'invalid bearer'},{status:401});
  if(url.pathname.includes('/rpc/c3_reserve_model_attempt')){permanentCalls++;throw Error('absent permanent RPC must not be called')}
  if(url.pathname.includes('/rpc/ce_verify_worker_token_v1'))return Response.json(false);
  if(url.pathname.includes('/rpc/c3_uat_')){
   const fn=url.pathname.split('/').pop()!;const keys=fn==='c3_uat_reserve_dispatch'?['p_run_id','p_revision','p_company_id','p_conversation_id','p_operation','p_slot','p_identity','p_request_hash','p_provider','p_purpose','p_model','p_attempt','p_input_ceiling','p_output_ceiling','p_cost_microusd']:['p_run_id','p_company_id','p_identity','p_state','p_status','p_input','p_output'];
   const args=keys.map(k=>body[k]===null?'NULL':typeof body[k]==='number'?String(body[k]):q(body[k])).join(',');
   const r=await sql(`set role service_role;select public.${fn}(${args});`);return r.ok?Response.json(JSON.parse(r.text.split('\n').at(-1)!)):Response.json({message:r.error},{status:400});
  }
  if(url.pathname.endsWith('/companies')||url.pathname.endsWith('/conversations')){
   const table=url.pathname.split('/').pop()!, id=(url.searchParams.get('id')||'').replace(/^eq\./,'');
   const r=await sql(`set role service_role;select row_to_json(t) from (select ${table==='companies'?'id':'id,company_id'} from public.${table} where id=${q(id)}::uuid)t;`);
   if(!r.ok)console.error('NATIVE_IDENTITY_READ_FAILURE',r.error);return r.ok?Response.json(r.text?JSON.parse(r.text.split('\n').at(-1)!):null):Response.json({message:r.error},{status:400});
  }
  if(url.pathname.endsWith('/user_roles')||url.pathname.endsWith('/company_membership')){
   const table=url.pathname.split('/').pop()!,user=(url.searchParams.get('user_id')||'').replace(/^eq\./,'');const r=await sql(`set role service_role;select coalesce(json_agg(t),'[]') from (select * from public.${table} where user_id=${q(user)}::uuid)t;`);return r.ok?Response.json(JSON.parse(r.text.split('\n').at(-1)!)):Response.json({message:r.error},{status:400});
  }
  if(url.pathname.endsWith('/upstream_call_log')&&init?.method==='POST')return new Response(null,{status:201});
  throw Error('unexpected native REST request '+url.pathname);
 }
 if(url.pathname.endsWith(':countTokens'))return Response.json({totalTokens:120});
 assert(url.href==='https://api.anthropic.com/v1/messages'||url.pathname.endsWith(':generateContent')||url.href==='https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search','unexpected outbound fixture');
 providerRequests.push({url:url.href,method:init?.method,headers:Object.fromEntries(new Headers(init?.headers)),body:init?.body});
 if(unknown)throw new DOMException('deterministic timeout','AbortError');
 if(retry>0){retry--;return new Response('',{status:503})}
 if(url.pathname.endsWith(':generateContent'))return Response.json({candidates:[{content:{parts:[{text:'{\"ok\":true}'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:120,candidatesTokenCount:20,thoughtsTokenCount:10}});
 return Response.json({content:[{type:'text',text:'{"ok":true}'}],usage:{input_tokens:5,output_tokens:3},stop_reason:'end_turn'});
};
Deno.env.set('SUPABASE_URL','http://native.invalid');Deno.env.set('SUPABASE_SERVICE_ROLE_KEY','native-fixture-key');Deno.env.set('SUPABASE_SECRET_KEY','native-fixture-key');Deno.env.set('SUPABASE_ANON_KEY','native-fixture-anon');Deno.env.set('LLM_PROVIDER','anthropic');Deno.env.set('ANTHROPIC_API_KEY','native-fixture-provider-key');for(const p of ['GENERATION','ASSIST','EVALUATION'])Deno.env.set('LLM_MODEL_'+p,'baseline-test-model');
globalThis.fetch=network;
const dir=Deno.env.get('C3_UAT_BASELINES_DIR')!;
const baseline=await import('file://'+dir+'/generate-reply/functions/_shared/llm-router.ts');
const call={purpose:'generation' as const,system:'Return JSON only.',user:'An existing customer asks about service.',maxTokens:100,companyId:company,conversationId:conv,operationId:'native-compatibility',tag:'generate-reply-orchestration',responseFormat:'json' as const};
Deno.test('captured live router and candidate execute equal non-UAT provider bytes/results for all six caller classes and retry with UAT off/valid/malformed',async()=>{
 const tokenClient=GoogleAuth.prototype.getClient;GoogleAuth.prototype.getClient=(async()=>({getAccessToken:async()=>({token:'native-fixture-token'})})) as any;Deno.env.set('GOOGLE_PROJECT_ID','native-project');Deno.env.set('GOOGLE_REGION','us-central1');Deno.env.set('GOOGLE_SERVICE_ACCOUNT_JSON','{}');
 try{for(const provider of ['anthropic','vertex']){Deno.env.set('LLM_PROVIDER',provider);for(const config of ['off','valid','malformed']){
  if(config==='off')Deno.env.delete('C3_TEMP_UAT_RUN_ID');else Deno.env.set('C3_TEMP_UAT_RUN_ID',config==='valid'?run:'malformed');Deno.env.set('C3_TEMP_UAT_SOURCE_REVISION',UAT_REVISION);
  for(const [purpose,tag] of [['generation','generate-reply-orchestration'],['assist','agent-assist-answer'],['assist','kb-query-expansion'],['evaluation','ce:helpfulness'],['evaluation','ce:auto:signals'],['evaluation','ce:auto:grounding']] as const){
   const input={...call,purpose,tag};providerRequests=[];retry=1;const before=await baseline.callModel(input);const requests=JSON.stringify(providerRequests);assert(before.ok,'live baseline failed');
   providerRequests=[];retry=1;const after=await callModel(input);assert(after.ok,'candidate failed '+JSON.stringify(after));equal(providerRequests,JSON.parse(requests));equal(after.text,before.text);equal(after.usage.attempts,before.usage.attempts);equal(after.usage.input_tokens,before.usage.input_tokens);equal(after.usage.output_tokens,before.usage.output_tokens);
  }
 }}equal(permanentCalls,0);}finally{GoogleAuth.prototype.getClient=tokenClient;Deno.env.set('LLM_PROVIDER','anthropic')}
});
for(const slug of ['generate-reply','agent-assist','kb-search-proxy','conversation-evaluate','ce-evaluation-control','ce-evaluation-worker'])Deno.test(slug+': execute captured and candidate handlers; forged browser cohort without legal auth cannot reach provider',async()=>{
 const rows=JSON.parse(await Deno.readTextFile(new URL('./live-baseline-blobs.json',import.meta.url)));const beforePath=dir+'/'+slug+'/'+rows[slug].entrypoint;let handler:((r:Request)=>Promise<Response>)|undefined;const original=Deno.serve;Object.defineProperty(Deno,'serve',{configurable:true,value:(h:any)=>{handler=h;return {}}});
 try{const statuses=[];for(const path of [beforePath,new URL('../../supabase/functions/'+slug+'/index.ts',import.meta.url).pathname]){
  handler=undefined;await import('file://'+path+'?native-handler=1');assert(handler,'handler not installed');providerRequests=[];
  const result=await (handler as unknown as (r:Request)=>Promise<Response>)(new Request('https://application.invalid/'+slug,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer forged-browser-token-with-no-authority'},body:JSON.stringify({company_id:UAT_COMPANY,uat:true,run_id:run,conversation_id:uatConv})}));assert(result.status>=400,'forged request accepted');equal(providerRequests.length,0);statuses.push(result.status);
 }equal(statuses[0],statuses[1]);}finally{Object.defineProperty(Deno,'serve',{configurable:true,value:original})}
});
Deno.test('live KB POST bytes remain equal; established owner pre-activation uses opaque server authority; browser/foreign scope cannot forge it',async()=>{
 const original=await import('file://'+dir+'/kb-search-proxy/_shared/kb-client.ts');const scope={mode:'canonical' as const,aiCompanyId:company,singaporeTenantId:'34'};const cfg={baseUrl:'https://py.ebixmall.com/py-knowledge-base',ragUrl:'https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search',jwtTtlSec:60,tenantTokens:{},tenantApiKeys:{},apiKeyHeaderMode:'x-api-key' as const,localProjectAuth:true};
 for(const id of [undefined,'invalid-run']){if(id)Deno.env.set('C3_TEMP_UAT_RUN_ID',id);else Deno.env.delete('C3_TEMP_UAT_RUN_ID');providerRequests=[];const before=await original.fetchKBRag({query:'published policy',top_k:3},scope,cfg);const requests=JSON.stringify(providerRequests);providerRequests=[];const after=await fetchKBRag({query:'published policy',top_k:3},scope,cfg);equal(providerRequests,JSON.parse(requests));equal(after,before)}
 Deno.env.set('KB_PREACTIVATION_ENABLED','true');Deno.env.set('KB_PREACTIVATION_TENANT_ID','34');const db=createClient('http://native.invalid','native-fixture-key');const authority=await legacyPreactivationAuthority(db,'12345678-1234-4234-8234-123456789012','34',null);const c={...call,purpose:'assist' as const,companyId:null,conversationId:null,legacyAuthority:authority,tag:'kb-query-expansion'};providerRequests=[];const before=await baseline.callModel(c);const request=JSON.stringify(providerRequests);providerRequests=[];const after=await callModel(c);assert(before.ok&&after.ok);equal(providerRequests,JSON.parse(request));equal(after.text,before.text);
 await sql("insert into public.conversations(id,company_id) values('88888888-8888-4888-8888-888888888888',null)");const bound=await legacyPreactivationAuthority(db,'12345678-1234-4234-8234-123456789012','34','88888888-8888-4888-8888-888888888888');await sql(`update public.conversations set company_id=${q(UAT_COMPANY)}::uuid where id='88888888-8888-4888-8888-888888888888'`);providerRequests=[];const moved=await callModel({...c,conversationId:'88888888-8888-4888-8888-888888888888',legacyAuthority:bound});assert(!moved.ok);equal(providerRequests.length,0);
 providerRequests=[];const forged=await callModel({...c,legacyAuthority:{uat:true,user_id:'12345678-1234-4234-8234-123456789012'}});assert(!forged.ok);equal(providerRequests.length,0);const cross=await callModel({...c,companyId:UAT_COMPANY,conversationId:uatConv});assert(!cross.ok);equal(providerRequests.length,0);equal(permanentCalls,0);
});
Deno.test('actual PostgreSQL UAT lease gates Vertex, KB bound, CE/Assist retries, replay, expiry and unknown outcome; never legacy fallback',async()=>{
 Deno.env.set('C3_TEMP_UAT_RUN_ID',run);Deno.env.set('C3_TEMP_UAT_SOURCE_REVISION',UAT_REVISION);Deno.env.set('GOOGLE_PROJECT_ID','native-project');Deno.env.set('GOOGLE_REGION','us-central1');
 const db=createClient('http://native.invalid','native-fixture-key');const url='https://us-central1-aiplatform.googleapis.com/v1/projects/native-project/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent';const request=JSON.stringify({contents:[{role:'user',parts:[{text:'safe native fixture'}]}],generationConfig:{maxOutputTokens:1024,thinkingConfig:{thinkingBudget:1024}}});
 const meta={companyId:UAT_COMPANY,conversationId:uatConv,operationId:'native',provider:'vertex',purpose:'generation',slot:'generate-reply-orchestration',attempt:1,request};
 const execute=(m=meta,u=url,b=request)=>accountedModelFetch(db,{...m,request:b},u,{method:'POST',body:b},network);
 let serial=0;for(const purpose of ['generation','assist','evaluation']){await execute({...meta,purpose,operationId:'native-'+purpose});serial++}equal(providerRequests.length>=serial,true);
 const denied=async(fn:()=>Promise<unknown>)=>{const n=providerRequests.length;let caught=false;try{await fn()}catch{caught=true}assert(caught,'admission not denied');equal(providerRequests.length,n)};
 await denied(()=>execute({...meta,operationId:'native-generation'}));await execute({...meta,operationId:'native-generation',attempt:2});await denied(()=>execute({...meta,provider:'anthropic',operationId:'unexpected-fallback'}));
 await denied(()=>execute({...meta,companyId:'77777777-7777-4777-8777-777777777777'}));
 await denied(()=>execute({...meta,companyId:company}));
 const remote=JSON.stringify({query:'service policy',company_id:34});await denied(()=>execute({...meta,provider:'singapore-kb',purpose:'kb_embedding',slot:'context-search',operationId:'kb:native'},'https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search',remote));
 await sql(`update public.upstream_call_log set request_payload=jsonb_set(request_payload,'{expires}',to_jsonb(clock_timestamp()-interval '1 second')) where id=${q(run)};`);await denied(()=>execute({...meta,operationId:'expired'}));const legacyWhileExpired=await callModel(call);assert(legacyWhileExpired.ok,'expired UAT lease affected normal Production');
 await sql(`update public.upstream_call_log set request_payload=jsonb_set(request_payload,'{expires}',to_jsonb(clock_timestamp()+interval '1 hour')) where id=${q(run)};`);
 Deno.env.set('C3_TEMP_UAT_SOURCE_REVISION','wrong');await denied(()=>execute({...meta,operationId:'drift'}));Deno.env.set('C3_TEMP_UAT_SOURCE_REVISION',UAT_REVISION);
 unknown=true;let failed=false;try{await execute({...meta,operationId:'unknown'})}catch{failed=true}unknown=false;assert(failed);const paused=await sql(`select request_payload->>'state' from public.upstream_call_log where id=${q(run)};`);equal(paused.text,'paused');await denied(()=>execute({...meta,operationId:'after-unknown'}));
 const retained=await sql(`select count(*) from public.upstream_call_log where request_payload->>'run_id'=${q(run)};`);equal(retained.text,'5');equal(permanentCalls,0);
});
