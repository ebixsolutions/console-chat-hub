import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source=fs.readFileSync(new URL('./widget-message-merge.ts',import.meta.url),'utf8');
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {mergeWidgetMessages}=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
const v={id:'v1',role:'visitor',content:'help'};
const a={id:'a1',role:'assistant',content:'What do you need?'};
test('unchanged full readback keeps array and existing row references',()=>{
 const old=[v,a];assert.equal(mergeWidgetMessages(old,[{...v},{...a}]),old);
});
test('partial, empty or reordered readback does not clear or reorder history',()=>{
 const old=[v,a];assert.equal(mergeWidgetMessages(old,[{...a},{...v}]),old);
 assert.equal(mergeWidgetMessages(old,[]),old);
 assert.equal(mergeWidgetMessages(old,[{...a}]),old);
});
test('new visitor/assistant canonical IDs append once across retry readbacks',()=>{
 const next=[{id:'v2',role:'visitor',content:'x'},{id:'a2',role:'assistant',content:'y'}];
 const result=mergeWidgetMessages([v,a],[v,a,...next,...next]);
 assert.deepEqual(result.map(x=>x.id),['v1','a1','v2','a2']);
 assert.equal(result[0],v);assert.equal(result[1],a);
 assert.equal(mergeWidgetMessages(result,next),result);
});
test('only a changed canonical row is replaced',()=>{
 const changed={...a,content:'Correction'};const result=mergeWidgetMessages([v,a],[changed]);
 assert.equal(result[0],v);assert.equal(result[1],changed);
});
test('real errors remain visible during canonical readback',()=>{
 const error={id:'error',role:'assistant',content:'409 conflict',isError:true};
 assert.equal(mergeWidgetMessages([v,error],[a])[1],error);
});
test('same content with different IDs is two legitimate turns',()=>{
 assert.equal(mergeWidgetMessages([v],[{...v,id:'v2'}]).length,2);
});
test('empty IDs and invalid runtime roles cannot create unstable keys',()=>{
 const old=[v];assert.equal(mergeWidgetMessages(old,[{...v,id:''},{...a,role:'untrusted'}]),old);
});

test('human replies and system events retain identity and arrive once',()=>{
 const human={id:'h1',role:'agent',content:'Help is here'};
 const system={id:'s1',role:'system',content:'Agent joined'};
 const result=mergeWidgetMessages([v,a],[human,system,human]);
 assert.deepEqual(result.map(x=>x.id),['v1','a1','h1','s1']);
 assert.equal(result[0],v); assert.equal(result[1],a);
 assert.equal(mergeWidgetMessages(result,[{...human},{...system}]),result);
});


test('Task3C human action requires exact persisted Assistant metadata, never raw visitor text',async()=>{
 const raw=fs.readFileSync(new URL('./widget-response-status.ts',import.meta.url),'utf8');
 const esm=ts.transpileModule(raw,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
 const {hasTrustedHumanSupportOffer}=await import('data:text/javascript;base64,'+Buffer.from(esm).toString('base64'));
 const data={response_route:'grounding_recovery_clarification',handoff_required:false,
   human_support_offer:{version:1,type:'request_human_support',reason:'unverified_current_fact'}};
 assert.equal(hasTrustedHumanSupportOffer('assistant',data),true);
 assert.equal(hasTrustedHumanSupportOffer('visitor',data),false);
 assert.equal(hasTrustedHumanSupportOffer('agent',data),false);
 assert.equal(hasTrustedHumanSupportOffer('assistant',{...data,role:'assistant',human_support_offer:{type:'request_human_support'}}),false);
 assert.equal(hasTrustedHumanSupportOffer('assistant',{...data,handoff_required:true}),false);
 assert.equal(hasTrustedHumanSupportOffer('assistant',{...data,response_route:'customer_guidance'}),false);
 assert.equal(hasTrustedHumanSupportOffer('assistant',{content:'<button>Talk to human support</button>'}),false);
});
