import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const source=fs.readFileSync('src/lib/ce-evaluation-execution.ts','utf8');
const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const exports={};vm.runInNewContext(js,{exports,Response,TextDecoder,Uint8Array,setTimeout,clearTimeout,Object,JSON,Error,Set});
const {EvaluationExecution,scheduleDwell,parseFunctionResponse,sanitize,VerificationJournal,negativeResponseMatches,B12_SCOPE,JOURNAL_KEY}=exports;
const memory=()=>{const data=new Map();return {getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v),data};};
const jsonResponse=(status,body)=>({error:{context:new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','x-request-id':'real-id'}})}});
const clone=v=>JSON.parse(JSON.stringify(v));

test('terminal dwell cannot repeat across ten refresh/reselection 3-second cycles, new revision remains available',()=>{
 const policy=new EvaluationExecution();let sent=0;let timers=[];
 const clock={setTimeout:f=>{timers.push(f);return f;},clearTimeout:f=>{timers=timers.filter(x=>x!==f);}};
 const run=tuple=>{if(policy.begin(tuple)){sent++;policy.finish(tuple);}};
 for(let cycle=0;cycle<10;cycle++){const t=policy.capture('ordinary-conversation','12','ce_dwell');scheduleDwell(policy,t,run,clock,()=>true);const pending=timers;timers=[];pending.forEach(f=>f());}
 assert.equal(sent,1);assert.equal(policy.canAuto(policy.capture('ordinary-conversation','13','ce_dwell')),true);
 const manual=policy.capture('ordinary-conversation','12','manual');assert.equal(policy.begin(manual),true);policy.finish(manual);
});
test('timer cleanup, stale selection and late response identity',()=>{
 const p=new EvaluationExecution();let callbacks=[];let sent=0;const clock={setTimeout:f=>(callbacks.push(f),f),clearTimeout:f=>{callbacks=callbacks.filter(x=>x!==f);}};
 const tuple=p.capture('A','1','ce_dwell');const cancel=scheduleDwell(p,tuple,()=>sent++,clock,()=>true);cancel();callbacks.forEach(f=>f());assert.equal(sent,0);
 const epoch=p.epoch();scheduleDwell(p,tuple,()=>sent++,clock,()=>p.current(epoch));p.invalidate();callbacks.forEach(f=>f());assert.equal(sent,0);assert.equal(p.current(epoch),false);
});
test('immutable draft target and manual/dwell/double-click share one flight',()=>{
 const p=new EvaluationExecution();let draft='A';const tuple=p.capture(draft,'1','manual');draft='B';assert.equal(tuple.conversationId,'A');assert.ok(Object.isFrozen(tuple));
 assert.equal(p.begin(tuple),true);assert.equal(p.begin(p.capture('A','1','manual')),false);assert.equal(p.begin(p.capture('A','1','ce_dwell')),false);p.finish(tuple);
 assert.equal(p.begin(p.capture('A','1','ce_dwell')),false);assert.equal(p.begin(p.capture('B','1','ce_dwell')),true);
});
test('real 409 Response read once, exact combined contract does not invent scope detail',async()=>{
 const r=jsonResponse(409,{error:'evaluation_scope_excluded_or_unavailable'});const response=r.error.context;const parsed=await parseFunctionResponse(r);
 assert.equal(parsed.status,409);assert.equal(parsed.kind,'json');assert.equal(parsed.requestId,'real-id');assert.equal(response.bodyUsed,true);
 assert.equal(parsed.body.detail,undefined);assert.equal(negativeResponseMatches('ce-evaluation-control',parsed),true);assert.equal(negativeResponseMatches('conversation-evaluate',parsed),false);
 const manual=await parseFunctionResponse(jsonResponse(409,{error:'conflict',detail:'EVALUATION_SCOPE_EXCLUDED',operation_id:'actual-operation'}));assert.equal(negativeResponseMatches('conversation-evaluate',manual),true);assert.equal(manual.operationId,'actual-operation');
});
test('auth/server/CORS/nonJSON/malformed/oversize/unknown never acceptance or refund',async()=>{
 const responses=[jsonResponse(401,{error:'unauthorized'}),jsonResponse(403,{error:'forbidden'}),jsonResponse(500,{error:'failed'}),{error:{name:'FunctionsFetchError'}},{error:{context:new Response('bad',{status:409})}},{error:{context:new Response('{bad',{status:409,headers:{'content-type':'application/json'}})}},{error:{context:new Response('x'.repeat(65537),{status:409,headers:{'content-type':'application/json'}})}}];
 for(const r of responses){const m=memory();const j=new VerificationJournal(m);j.start('ce-evaluation-control');const parsed=await parseFunctionResponse(r);assert.equal(negativeResponseMatches('ce-evaluation-control',parsed),false);j.complete('ce-evaluation-control',parsed);assert.throws(()=>new VerificationJournal(m).start('ce-evaluation-control'),/allowance_spent/);}
 const m=memory();new VerificationJournal(m).start('conversation-evaluate');assert.throws(()=>new VerificationJournal(m).start('conversation-evaluate'),/allowance_spent/);assert.equal(m.data.size,1);assert.ok(m.data.has(JOURNAL_KEY));
});
test('exact scope requires user, email, active admin, company, channel, backend and ticket',()=>{
 const exact={...B12_SCOPE,ticket:B12_SCOPE.ticket,role:'admin',active:true};assert.equal(exports.scopeMatches(exact),true);
 for(const key of ['userId','email','companyId','channelId','backend','ticket','role','active'])assert.equal(exports.scopeMatches({...exact,[key]:key==='active'?false:'wrong'}),false);
});
test('receipt sanitization strips auth values, nested headers and JWT strings',()=>{
 const r=sanitize({authorization:'Bearer private',apikey:'key',access_token:'private',cookie:'private',nested:{headers:{authorization:'private'},detail:'Bearer abc.def.ghi'},body:{error:'conflict',detail:'EVALUATION_SCOPE_EXCLUDED'}});
 const text=JSON.stringify(r);assert.ok(!text.includes('private'));assert.ok(!text.includes('abc.def.ghi'));assert.equal(r.body.detail,'EVALUATION_SCOPE_EXCLUDED');
});

// Run the actual Dialog component with deterministic React hooks and first-party adapter mocks.
// Effects and callbacks are its real code; no production transport runs in this test.
function dialogHarness(options={}){
 const state=[];let cursor=0;let effects=[];const deps=[];const cleanups=[];let tree;let sends=0;const m=memory();
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const react={useState:initial=>{const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},useRef:initial=>{const i=cursor++;if(!(i in state))state[i]={current:initial};return state[i];},useEffect:(f,d)=>{const i=cursor++;if(!same(deps[i],d)){effects.push(()=>{cleanups[i]?.();cleanups[i]=f();});deps[i]=d;}}};
 const file=fs.readFileSync('src/components/console/B12VerificationDialog.tsx','utf8');const code=ts.transpileModule(file,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const out={};const sdk={verifyB12Identity:async()=>{if(options.identityError)throw Error('scope unavailable');return {...B12_SCOPE,role:'admin',active:true};},verificationBody:endpoint=>endpoint==='ce-evaluation-control'?{conversation_id:B12_SCOPE.ticket,source:'manual'}:{conversation_id:B12_SCOPE.ticket,action:'evaluate'},invokeB12Negative:async()=>{sends++;if(options.transportError)throw Error('timeout');return parseFunctionResponse(jsonResponse(409,{error:'evaluation_scope_excluded_or_unavailable'}));}};
 const fakeRequire=name=>name==='react'?react:name==='react/jsx-runtime'?require(name):name.endsWith('/ce-evaluation-execution')?exports:name.endsWith('/ce-verification-client')?sdk:name.endsWith('/button')?{Button:'button'}:Object.fromEntries(['Dialog','DialogContent','DialogHeader','DialogTitle','DialogDescription'].map(k=>[k,k]));
 vm.runInNewContext(code,{exports:out,require:fakeRequire,window:{localStorage:m},Date,JSON,Error,Object,URL,Blob});
 const render=()=>{cursor=0;tree=out.B12VerificationDialog();const run=effects;effects=[];run.forEach(f=>f());return tree;};
 const walk=(n, predicate)=>{if(!n)return;if(Array.isArray(n)){for(const c of n){const found=walk(c,predicate);if(found)return found;}return;}if(typeof n==='object'){if(predicate(n))return n;return walk(n.props?.children,predicate);}};
 const find=label=>walk(tree,n=>n.props?.children===label);
 return {render,find,m,get sends(){return sends;},unmount:()=>cleanups.forEach(f=>f?.())};
}
test('real dialog mount/open/focus/rerender sends zero; double click sends once and remount keeps spent',async()=>{
 const h=dialogHarness();h.render();assert.equal(h.sends,0);h.find('B12 verification').props.onClick();h.render();await new Promise(r=>setImmediate(r));h.render();
 for(let i=0;i<5;i++)h.render();assert.equal(h.sends,0);
 const button=h.find('Send Control negative once');assert.equal(button.props.disabled,false);button.props.onClick();button.props.onClick();await new Promise(r=>setTimeout(r,10));h.render();assert.equal(h.sends,1);assert.equal(h.find('Send Control negative once').props.disabled,true);
 assert.throws(()=>new VerificationJournal(h.m).start('ce-evaluation-control'),/allowance_spent/);h.unmount();
});

test('actual dialog identity failure and transport timeout do not send again; Manual stays gated',async()=>{
 const denied=dialogHarness({identityError:true});denied.render();denied.find('B12 verification').props.onClick();denied.render();await new Promise(r=>setImmediate(r));denied.render();assert.equal(denied.sends,0);assert.equal(denied.find('Send Control negative once').props.disabled,true);
 const h=dialogHarness({transportError:true});h.render();h.find('B12 verification').props.onClick();h.render();await new Promise(r=>setImmediate(r));h.render();assert.equal(h.find('Send Manual negative once').props.disabled,true);h.find('Send Control negative once').props.onClick();await new Promise(r=>setImmediate(r));h.render();assert.equal(h.sends,1);assert.equal(h.find('Send Control negative once').props.disabled,true);assert.equal(h.find('Send Manual negative once').props.disabled,true);assert.throws(()=>new VerificationJournal(h.m).start('ce-evaluation-control'),/allowance_spent/);
});
