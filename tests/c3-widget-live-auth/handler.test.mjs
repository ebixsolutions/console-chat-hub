import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';
const root=new URL('../../',import.meta.url);
let code=fs.readFileSync(new URL('supabase/functions/widget-live-ai-test/index.ts',root),'utf8').replace(/^import .*;\n/gm,'').replace('Deno.serve(createWidgetLiveHandler());','');
const helper=fs.readFileSync(new URL('supabase/functions/_shared/supabase-admin-key.ts',root),'utf8').replace('export function','function');
code='const createClient=()=>{throw new Error("unexpected SDK client")}; const supabaseCorsHeaders=()=>({});\n'+helper+'\n'+code+'\nexport {getSupabaseAdminKey as testAdminKey};';
const js=ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {createWidgetLiveHandler,testAdminKey}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const company='10000000-0000-4000-8000-000000000001',channel='20000000-0000-4000-8000-000000000001';
const user='30000000-0000-4000-8000-000000000001', token='authenticated-test-token',secret='server-secret-never-output';
let completed=[];
async function check(name, options={}, expected=200, body={action:'history'}) {
 const logs=[], calls=[]; let clients=0; const requests=[]; const originalFetch=globalThis.fetch;
 const conversation={id:company,company_id:company,channel_config_id:channel,status:options.human?'pending':'open',visitor_session_id:channel,metadata_source:{source:'c3_uat_widget',synthetic:true,owner_user_id:user,exclude_training:true}};
 globalThis.fetch=async(url,init)=>{requests.push({url,body:JSON.parse(init.body)}); const data=String(url).endsWith('receive-widget-message')?{message_id:channel,ai_reply_pending:false,idempotent:true}:{messages:[{id:channel,role:'agent',content:'synthetic response'}],conversation_status:options.human?'pending':'open',human_support:{state:options.human?'waiting':'none',queue_position:2,estimated_wait_minutes:4}}; return new Response(JSON.stringify({success:true,data}));};
 const row={company_id:company,role:options.role??'admin',is_active:options.active??true};
 const memberships=options.ambiguous?[row,{...row,company_id:channel}]:[row];
 const client={from(table){const chain={singleRow:false,select(){return this},eq(k,v){calls.push([table,k,v]);return this},order(){return this},limit(){return this},maybeSingle(){this.singleRow=true;return this},then(resolve){
 let data=table==='company_membership'?memberships:table==='company'?{id:company,is_active:options.companyActive??true}:table==='channel_config'?{id:channel,company_id:company,is_active:true,channel_type:'web_widget',allowed_origins:['https://preview--console-chat-hub.lovable.app']}:table==='conversations'?(this.singleRow?{...conversation,metadata_source:options.foreignOwner?{...conversation.metadata_source,owner_user_id:channel}:conversation.metadata_source}:[]):table==='visitor_session'?{session_token:'synthetic-session-token-with-32-characters'}:[];
 resolve({data,status:options.providerError?401:200,error:table==='company_membership'&&options.providerError?{code:'PGRST301',message:secret}:null});
 }};return chain;}};
 const env={SUPABASE_SECRET_KEY:secret,SUPABASE_URL:'https://nrfxhqabwblzxoushgnm.supabase.co',SUPABASE_ANON_KEY:'public-key',...(options.env??{})};
 globalThis.Deno={env:{get:k=>env[k]}};
 const handler=createWidgetLiveHandler({env:k=>env[k],getAdminKey:options.missingKey?()=>{throw Error(secret)}:testAdminKey, log:event=>logs.push(event),createClient:(url,key,config)=>{
 clients++; assert.equal(url,env.SUPABASE_URL); assert.equal(config.auth.persistSession,false);
 if(clients===1) return {auth:{getUser:async jwt=>{assert.equal(jwt,options.token??token);return {data:{user:options.invalid?null:{id:user}},error:options.invalid?{code:'bad_jwt',message:secret}:null}}},rpc:async()=>({data:{isolated:options.isolated??true,config:{company_id:company,channel_id:channel}},error:null})};
 assert.equal(key,secret);assert.equal(config.global,undefined);return client;
 }});
 const headers={Origin:'https://preview--console-chat-hub.lovable.app'};
 if(!options.noToken)headers.Authorization='Bearer '+(options.token??token);
 const response=await handler(new Request('https://endpoint.invalid',{method:'POST',headers,body:JSON.stringify(body)}));
 const responseText=await response.text(); assert.equal(response.status,expected,responseText);
 assert(!responseText.includes(secret));assert(!JSON.stringify(logs).includes(secret));assert(!JSON.stringify(logs).includes(token));
 if(expected===200&&options.isolated!==false && body.action==='history') {assert(calls.some(c=>c[0]==='conversations'&&c[1]==='company_id'&&c[2]===company));assert(calls.some(c=>c[0]==='conversations'&&c[1]==='channel_config_id'&&c[2]===channel));}
 if(options.providerError)assert.equal(logs[0].provider_http_class,'4xx');
 if(body.action==='send'&&expected===200){assert(requests.some(r=>r.url.endsWith('receive-widget-message'))); assert(!requests.some(r=>r.url.endsWith('generate-reply'))); assert.equal(requests[0].body.client_message_id,body.client_message_id);assert.equal(requests[0].body.conversation_id,company);}
 if(body.action==='load'&&expected===200){assert(requests.some(r=>r.url.endsWith('widget-poll-messages')));const payload=JSON.parse(responseText);assert.equal(payload.messages[0].role,'agent');assert.equal(payload.human_support.queue_position,2);}
 globalThis.fetch=originalFetch;
 completed.push({name,status:'PASS',kind:'actual_handler_unit_with_provider_adapters'});
}
await check('valid Admin');await check('valid Supervisor',{role:'supervisor'});
await check('no token',{noToken:true},401);await check('invalid JWT',{invalid:true,token:'invalid-token'},401);await check('expired JWT',{invalid:true,token:'expired-token'},401);
await check('inactive membership',{active:false},403);await check('unsupported role',{role:'agent'},403);
await check('inactive company',{companyActive:false},403);await check('ambiguous company',{ambiguous:true},409);
await check('tenant injection',{},400,{action:'history',company_id:channel});await check('user injection',{},400,{action:'history',user_id:user});
await check('admin key missing',{missingKey:true},500);
await check('modern key');await check('service fallback',{env:{SUPABASE_SECRET_KEY:undefined,SUPABASE_SERVICE_ROLE_KEY:secret}});await check('plural compatibility',{env:{SUPABASE_SECRET_KEY:undefined,SUPABASE_SECRET_KEYS:JSON.stringify({default:secret})}});
await check('wrong hosted project rejected',{env:{SUPABASE_URL:'https://unapproved.supabase.co'}},500);
await check('loopback requires server native marker',{env:{SUPABASE_URL:'http://127.0.0.1:54321'}},500);
await check('browser native marker cannot change backend',{env:{SUPABASE_URL:'http://127.0.0.1:54321'}},500,{action:'history',C3_NATIVE_ISOLATED_AUTH:'local-only'});
await check('explicit disposable native backend',{env:{SUPABASE_URL:'http://127.0.0.1:54321',C3_NATIVE_ISOLATED_AUTH:'local-only'}});
await check('native marker cannot authorize other hosted project',{env:{SUPABASE_URL:'https://unapproved.supabase.co',C3_NATIVE_ISOLATED_AUTH:'local-only'}},500);
await check('provider error safe diagnostics',{providerError:true},500);
await check('no registered scope cannot send',{isolated:false},503,{action:'send',query:'test',client_message_id:company});
await Promise.all([check('concurrent history A'),check('concurrent history B')]);
await check('load isolated conversation',{},200,{action:'load',test_conversation_id:company});
await check('foreign owner load denied',{foreignOwner:true},404,{action:'load',test_conversation_id:company});
await check('canonical send',{},200,{action:'send',test_conversation_id:company,client_message_id:channel,query:'synthetic generic request'});
await check('human control send remains ordinary widget',{human:true},200,{action:'send',test_conversation_id:company,client_message_id:channel,query:'synthetic reply'});
await check('missing stable message id rejected before writes',{},400,{action:'send',query:'synthetic'});
if(process.env.C3_WIDGET_TEST_REPORT)fs.writeFileSync(process.env.C3_WIDGET_TEST_REPORT,JSON.stringify({completed,production_runtime:false},null,2));
console.log(JSON.stringify({tests:completed.length,passed:completed.length,production_runtime:false}));
