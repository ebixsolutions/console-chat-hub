import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import ts from 'typescript';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const root=path.resolve(new URL('../..',import.meta.url).pathname);
const sdkRoot=process.env.C3_CONSOLE_SDK_ROOT;
assert(sdkRoot,'Set C3_CONSOLE_SDK_ROOT to the isolated install of @supabase/supabase-js@2.45.0');
const sdkRequire=createRequire(path.join(sdkRoot,'package.json'));
assert.equal(sdkRequire('@supabase/supabase-js/package.json').version,'2.45.0');
const {createClient}=sdkRequire('@supabase/supabase-js');
const baseline='91b6eed199d6773e95fa3743c7288055c6e6ad56';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const company=uuid(1), foreignCompany=uuid(2), user=uuid(3), otherVisitor=uuid(4), agent=uuid(5);
function dataset(n,{sameVisitor=false}={}){
 const tables={company:[{id:company,is_active:true},{id:foreignCompany,is_active:true}],company_membership:[{id:uuid(6),user_id:user,company_id:company,is_active:true,role:'admin'}],user_roles:[],conversations:[],visitor_session:[],messages:[],feedback_request:[],conversation_evaluation:[],ce_emotion_point:[],agent_profile:[{id:agent,display_name:'Synthetic agent'}]};
 for(let i=0;i<n;i++){
  const id=uuid(10000+i), vs=sameVisitor?uuid(50000):uuid(50000+(i%Math.min(n,480))), stamp=new Date(Date.UTC(2026,0,1)+i*1000).toISOString();
  tables.conversations.push({id,company_id:company,visitor_session_id:vs,status:i%2?'resolved':'open',priority:'normal',created_at:stamp,updated_at:stamp,resolved_at:i%2?stamp:null,assigned_agent_id:agent,channel_config:{name:'Synthetic channel'}});
  if(!tables.visitor_session.some(v=>v.id===vs)) tables.visitor_session.push({id:vs,created_at:stamp,last_seen_at:stamp,visitor_metadata:{name:'Synthetic visitor'},channel_config:{name:'Synthetic channel'}});
  for(let j=0;j<2;j++) tables.messages.push({id:uuid(100000+i*2+j),conversation_id:id,content:'Synthetic text',is_recalled:false});
  tables.feedback_request.push({id:uuid(200000+i),conversation_id:id,rating:i%2?3:5,feedback_text:'Synthetic feedback',created_at:stamp});
  const ev=uuid(300000+i);tables.conversation_evaluation.push({id:ev,conversation_id:id,company_id:company,overall_score:95,severity:'low',review_status:'reviewed',created_at:stamp});
  tables.ce_emotion_point.push({id:uuid(400000+i),evaluation_id:ev,company_id:company,turn_index:i,sentiment:'neutral',sentiment_score:0,occurred_at:stamp});
 }
 const id=uuid(900000);tables.conversations.push({id,company_id:foreignCompany,visitor_session_id:otherVisitor,status:'open',created_at:'2026-01-01',updated_at:'2026-01-01'});
 tables.visitor_session.push({id:otherVisitor,visitor_metadata:{name:'Foreign must never leak'}});
 tables.feedback_request.push({id:uuid(900001),conversation_id:id,rating:1,feedback_text:'Foreign must never leak'});
 return tables;
}
function loadHandler(slug,url,{legacy=false,keyMode='modern'}={}){
 const cache=new Map(); let handler;
 const env={SUPABASE_URL:url,SUPABASE_ANON_KEY:'synthetic-public'};
 if(keyMode==='modern')env.SUPABASE_SECRET_KEY='synthetic-server';
 if(keyMode==='plural')env.SUPABASE_SECRET_KEYS=JSON.stringify({default:'synthetic-server'});
 if(keyMode==='legacy'||legacy)env.SUPABASE_SERVICE_ROLE_KEY='synthetic-server';
 const deno={env:{get:k=>env[k]},serve:h=>{handler=h}};
 function load(file){
  if(cache.has(file))return cache.get(file);
  let source=legacy?execFileSync('git',['show',baseline+':'+path.relative(root,file)],{cwd:root,encoding:'utf8'}):fs.readFileSync(file,'utf8');
  const transpiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
  const errors=transpiled.diagnostics?.filter(d=>d.category===ts.DiagnosticCategory.Error)||[];assert.equal(errors.length,0);
  const module={exports:{}};cache.set(file,module.exports);
  const require=spec=>spec.startsWith('https://esm.sh/@supabase/supabase-js')?{createClient} : spec.startsWith('.')?load(path.resolve(path.dirname(file),spec)) : (()=>{throw Error('unapproved import '+spec)})();
  new Function('require','module','exports','Deno',transpiled.outputText)(require,module,module.exports,deno);
  cache.set(file,module.exports);return module.exports;
 }
 load(path.join(root,'supabase/functions',slug,'index.ts'));return handler;
}
async function fixture(n,options,run){
 const tables=dataset(n,options), requests=[], errors=[];let rejected=0;
 if(options.role)tables.company_membership[0].role=options.role;
 if(options.inactive)tables.company[0].is_active=false;
 if(options.ambiguous)tables.company_membership.push({...tables.company_membership[0],id:uuid(7),company_id:foreignCompany});
 if(options.preActivation){tables.company_membership=[];tables.user_roles=[{id:uuid(8),user_id:user,role:'admin'}];for(const c of tables.conversations)if(c.company_id===company)c.company_id=null;}
 const server=http.createServer({maxHeaderSize:options.largeHeaders?65536:8192},(req,res)=>{
  const url=new URL(req.url,'http://localhost'),table=url.pathname.split('/').at(-1), q=url.searchParams;
  requests.push({table,urlLength:req.url.length,query:Object.fromEntries(q),method:req.method});
  const send=(status,data,total,from=0,to=0)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');if(total!==undefined)res.setHeader('Content-Range',`${from}-${to}/${total}`);res.end(req.method==='HEAD'?'':JSON.stringify(data));};
  if(url.pathname==='/auth/v1/user'){return req.headers.authorization==='Bearer synthetic-user'?send(200,{id:user}):send(401,{code:'bad_jwt',message:'Unauthorized'});}
  assert.equal(req.headers.apikey,'synthetic-server');
  let rows=[...(tables[table]||[])];
  for(const [field,value] of q){if(['select','order','offset','limit'].includes(field))continue;
   rows=rows.filter(r=>value.startsWith('eq.')?String(r[field])===value.slice(3):value==='is.null'?r[field]===null:value==='not.is.null'?r[field]!=null:value.startsWith('neq.')?String(r[field])!==value.slice(4):value.startsWith('in.')?value.slice(4,-1).split(',').includes(String(r[field])):true);
  }
  const total=rows.length, from=Number(q.get('offset')||0), limit=Math.min(Number(q.get('limit')||1000),options.pageCap||1000);
  const order=(q.get('order')||'').split(',').filter(Boolean);
  rows.sort((a,b)=>{for(const entry of order){const [key,dir]=entry.split('.');const c=String(a[key]??'').localeCompare(String(b[key]??''));if(c)return dir==='desc'?-c:c;}return 0;});
  if(options.fail?.table===table && (options.fail.offset===undefined||from===options.fail.offset) && (options.fail.after===undefined||requests.filter(r=>r.table===table).length>options.fail.after))return send(503,{code:'SYNTHETIC_READ_FAILURE',message:'Required read failed'});
  const select=(q.get('select')||'*').split(/,(?![^()]*\))/).map(s=>s.split(':')[0]);
  rows=rows.slice(from,from+limit).map(r=>Object.fromEntries(Object.entries(r).filter(([k])=>select.includes('*')||select.includes(k))));
  if(options.duplicate && table==='conversations'&&from===200&&rows.length)rows[0].id=uuid(10000);
  if(options.foreignRow&&table==='feedback_request'&&rows.length)rows[0].conversation_id=uuid(900000);
  if(req.headers.accept?.includes('application/vnd.pgrst.object'))return rows.length===1?send(200,rows[0]):send(406,{code:'PGRST116',details:`The result contains ${rows.length} rows`,message:'JSON object requested, multiple (or no) rows returned'});
  send(req.method==='HEAD'||total>limit?206:200,rows,req.headers.prefer?.includes('count=exact')&&!options.noCount?(options.changedCount&&from===200?total+1:total):undefined,from,from+rows.length-1);
 });
 server.on('clientError',(err,socket)=>{rejected++;errors.push(err.code);socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 async function call(slug,body,opts={}){
  const h=loadHandler(slug,url,opts);const response=await h(new Request(url,{method:'POST',headers:{Origin:'https://console-chat-hub.lovable.app',Authorization:opts.noAuth?'':'Bearer synthetic-user','Content-Type':'application/json'},body:JSON.stringify(body)}));
  const data=await response.json();assert(!JSON.stringify(data).includes('synthetic-server'));assert(!JSON.stringify(data).includes('Foreign must never leak'));return {status:response.status,data};
 }
 try{await run({call,requests,tables,rejected:()=>rejected,errors});}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
const directory={mode:'directory'}, summary={mode:'summary'};
test('A15/A14 legacy actual handler + SDK 2.45 reproduces oversized HTTP query failure at 505/480 cardinality',async()=>fixture(505,{},async f=>{
 for(const [slug,body,error] of [['customer360-local',directory,'directory_session_query_failed'],['visitor-analytics',summary,'analytics_query_failed']]){const r=await f.call(slug,body,{legacy:true});assert.equal(r.status,500);assert.equal(r.data.error,error);}
 assert(f.rejected()>=2);assert(f.errors.includes('HPE_HEADER_OVERFLOW'));
 console.log('ISOLATED_REPRODUCTION: real SDK query URL exceeds localhost HTTP header budget; historical Production response code remains unobserved');
}));
test('legacy scoped source truncation reproduces false success beyond PostgREST 1000-row default',async()=>fixture(1305,{largeHeaders:true},async f=>{const r=await f.call('visitor-analytics',summary,{legacy:true});assert.equal(r.status,200);assert.equal(r.data.summary.total_conversations,1000);assert.notEqual(r.data.summary.total_conversations,1305);}));
for(const n of [0,1,505,1305])test(`complete directory and exact summary at volume ${n}`,async()=>fixture(n,{},async f=>{
 const a=await f.call('customer360-local',directory),b=await f.call('visitor-analytics',summary);assert.equal(a.status,200);assert.equal(b.status,200);
 assert.equal(a.data.visitors.length,Math.min(n,50));assert.equal(b.data.summary.total_conversations,n);assert.equal(b.data.summary.total_sessions,Math.min(n,480));assert.equal(b.data.summary.total_messages,n*2);assert.equal(b.data.summary.feedback_count,n);
 assert.equal(b.data.summary.average_rating,n?Math.round((Math.ceil(n/2)*5+Math.floor(n/2)*3)/n*10)/10:null);
 assert.equal(b.data.summary.recent_sessions.length,Math.min(n,20));
 assert.equal(a.data.visitors.reduce((sum,r)=>sum+r.conversation_count,0),n<=50?n:a.data.visitors.reduce((sum,r)=>sum+r.conversation_count,0));
 if(n){assert(a.data.visitors.every(v=>v.conversation_count===f.tables.conversations.filter(c=>c.company_id===company&&c.visitor_session_id===v.id).length));assert.equal(a.data.visitors[0].last_activity,f.tables.conversations[n-1].updated_at);}
 assert(f.requests.every(r=>r.urlLength<4096));assert.equal(f.rejected(),0);
 for(const r of f.requests.filter(r=>r.table==='conversations'))assert.equal(r.query.company_id,'eq.'+company);
}));
test('both detail branches include all 1305 historical conversations, messages, feedback, evaluations and emotion points without schema additions',async()=>fixture(1305,{sameVisitor:true},async f=>{
 const vs=uuid(50000),a=await f.call('customer360-local',{mode:'detail',visitor_session_id:vs}),b=await f.call('visitor-analytics',{visitor_session_id:vs});
 assert.equal(a.status,200);assert.equal(b.status,200);assert.equal(a.data.customer.conversations.length,1305);assert.equal(a.data.customer.feedback.length,1305);assert.equal(a.data.customer.evaluations.length,1305);assert.equal(a.data.customer.emotion_points.length,1305);
 assert(a.data.customer.feedback.every(r=>!('id' in r)));assert.equal(a.data.customer.customer_ref,null);assert(!('orders' in a.data.customer));assert(!('ltv' in a.data.customer));assert(!('tier' in a.data.customer));
 assert.equal(b.data.visitor.conversations.length,1305);assert(b.data.visitor.conversations.every(c=>c.message_count===2&&c.has_feedback));assert(f.requests.every(r=>r.urlLength<4096));
}));
for(const [name,options,status] of [['agent',{role:'agent'},403],['supervisor',{role:'supervisor'},200],['inactive company',{inactive:true},403],['ambiguous company',{ambiguous:true},409],['pre activation null tenant',{preActivation:true},200]])test(name+' resolves real shared scope and never broadens tenant',async()=>fixture(2,options,async f=>{
 for(const [slug,body] of [['customer360-local',directory],['visitor-analytics',summary]])assert.equal((await f.call(slug,body)).status,status);
 if(options.preActivation)assert(f.requests.filter(r=>r.table==='conversations').every(r=>r.query.company_id==='is.null'));
 if(status!==200)assert(!f.requests.some(r=>r.table==='conversations'));
}));
test('unauthorized and foreign visitor fail before downstream data; request tenant cannot override scope',async()=>fixture(2,{},async f=>{
 for(const slug of ['customer360-local','visitor-analytics']){const body=slug==='customer360-local'?{mode:'detail',visitor_session_id:otherVisitor}:{visitor_session_id:otherVisitor};assert.equal((await f.call(slug,body,{noAuth:true})).status,401);assert.equal((await f.call(slug,body)).status,404);}
 const a=await f.call('customer360-local',{mode:'directory',company_id:foreignCompany});assert.equal(a.status,200);assert.equal(a.data.scope.company_id,company);
 assert.equal((await f.call('visitor-analytics',{mode:'summary',company_id:foreignCompany})).status,400);
 assert(!f.requests.some(r=>r.table==='visitor_session'&&r.query.id==='eq.'+otherVisitor));
}));
for(const options of [{fail:{table:'conversations',offset:200}},{noCount:true},{pageCap:100},{duplicate:true},{changedCount:true},{fail:{table:'visitor_session',after:1}},{fail:{table:'feedback_request',after:1}},{foreignRow:true}])test('required page/batch/shape failure never returns partial success '+JSON.stringify(options),async()=>fixture(505,options,async f=>{
 for(const [slug,body] of [['customer360-local',options.foreignRow?{mode:'detail',visitor_session_id:uuid(50000)}:directory],['visitor-analytics',summary]]){
  const r=await f.call(slug,body);if(slug==='customer360-local'&&options.fail?.table==='feedback_request'){assert.equal(r.status,200);continue;}assert.equal(r.status,500);assert(!r.data.success);assert(!r.data.visitors);assert(!r.data.summary);
 }
}));
test('detail required feedback/evaluation/emotion/session read failure is honest 500; clean retry succeeds',async()=>{
 for(const table of ['feedback_request','conversation_evaluation','ce_emotion_point','visitor_session'])await fixture(3,{sameVisitor:true,fail:{table}},async f=>{const r=await f.call('customer360-local',{mode:'detail',visitor_session_id:uuid(50000)});assert.equal(r.status,500);assert(!r.data.success);});
 await fixture(3,{sameVisitor:true},async f=>assert.equal((await f.call('customer360-local',{mode:'detail',visitor_session_id:uuid(50000)})).status,200));
});
test('key resolver preserves modern, plural and legacy server compatibility through actual handlers',async()=>fixture(1,{},async f=>{for(const keyMode of ['modern','plural','legacy'])for(const [slug,body] of [['customer360-local',directory],['visitor-analytics',summary]])assert.equal((await f.call(slug,body,{keyMode})).status,200);}));

test('filtered metrics retain recalled/thinking exclusions and null-rating denominators',async()=>fixture(3,{},async f=>{
 const c=f.tables.conversations[0].id; f.tables.messages.push({id:uuid(910001),conversation_id:c,content:'__THINKING__',is_recalled:false},{id:uuid(910002),conversation_id:c,content:'Recalled synthetic',is_recalled:true});
 f.tables.feedback_request.push({id:uuid(910003),conversation_id:c,rating:null});
 const r=await f.call('visitor-analytics',summary);assert.equal(r.status,200);assert.equal(r.data.summary.total_messages,6);assert.equal(r.data.summary.feedback_count,3);assert.equal(r.data.summary.average_rating,4.3);
}));
test('later detail batches fail closed for both handlers, then an unchanged clean retry succeeds',async()=>{
 for(const slug of ['customer360-local','visitor-analytics'])await fixture(505,{sameVisitor:true,fail:{table:'feedback_request',after:1}},async f=>{const body=slug==='customer360-local'?{mode:'detail',visitor_session_id:uuid(50000)}:{visitor_session_id:uuid(50000)};const r=await f.call(slug,body);assert.equal(r.status,500);assert(!r.data.success);});
 await fixture(505,{sameVisitor:true},async f=>{for(const slug of ['customer360-local','visitor-analytics'])assert.equal((await f.call(slug,slug==='customer360-local'?{mode:'detail',visitor_session_id:uuid(50000)}:{visitor_session_id:uuid(50000)})).status,200);});
});
