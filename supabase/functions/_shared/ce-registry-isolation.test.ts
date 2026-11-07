import {processEvaluationJob,verifyEvaluationJobScope,type AutomationJob} from './ce-automation-engine.ts';
const assert=(v:unknown,m:string)=>{if(!v)throw Error(m)};
const job={id:'job',conversation_id:'conversation',company_id:'company',snapshot_hash:'snapshot',evaluation_fingerprint:'fingerprint',expected_revision:2} as AutomationJob;
function db(eligible:unknown=true,opts:{scopeError?:boolean,foreign?:boolean,savedForeign?:boolean}={}){
 const calls:string[]=[];
 const tables:any={ce_evaluation_job:{...job,id:job.id,conversation_id:job.conversation_id,company_id:opts.savedForeign?'other':'company'},conversations:{company_id:'company',channel_config_id:'channel'},channel_config:{company_id:opts.foreign?'other':'company'}};
 return {calls,from:(name:string)=>{calls.push('read:'+name);if(!tables[name])throw Error('forbidden downstream read '+name);return{select:()=>({eq:()=>({maybeSingle:async()=>({data:tables[name],error:null})})})}},rpc:async(name:string)=>{calls.push('rpc:'+name);if(name!=='ce_conversation_evaluable_v1')throw Error('forbidden downstream write '+name);return{data:eligible,error:opts.scopeError?{code:'unavailable'}:null}}};
}
for(const [label,value] of [['registered synthetic',false],['missing scope',null],['malformed scope','true']] as const){
 Deno.test('worker direct caller rejects '+label+' before Grounding/LLM/methodology/status writes',async()=>{
 const admin=db(value);const r=await processEvaluationJob(admin as any,job);assert(!r.ok&&r.code?.startsWith('EVALUATION_SCOPE'),'not rejected');assert(admin.calls.every(c=>c.startsWith('read:')||c==='rpc:ce_conversation_evaluable_v1'),'mutation');assert(!admin.calls.includes('read:messages'),'messages read before guard');
 });
}
Deno.test('scope RPC failure is fail closed and does not fail/reset job',async()=>{const a=db(true,{scopeError:true});assert((await processEvaluationJob(a as any,job)).code==='EVALUATION_SCOPE_UNAVAILABLE','RPC failure swallowed')});
Deno.test('worker binds stored job and tenant to actual conversation/channel',async()=>{for(const opts of [{foreign:true},{savedForeign:true}]){const a=db(true,opts);assert((await processEvaluationJob(a as any,job)).code==='EVALUATION_JOB_TENANT_MISMATCH','foreign job accepted');assert(!a.calls.some(c=>c.startsWith('rpc:')),'foreign job RPC write/read')}});
Deno.test('normal eligible server-side job passes read-only scope gate',async()=>{const a=db();assert(await verifyEvaluationJobScope(a as any,job)===null,'normal scope disabled')});
