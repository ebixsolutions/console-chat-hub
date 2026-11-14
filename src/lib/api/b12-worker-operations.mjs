import {SCOPE, BASELINE, guards, validateReceipt} from '../../../ops/b12-worker-once/executor.mjs';
export const OPS_SCOPE = SCOPE;
export const OPS_KEY = 'c3-b12-worker-once-client-intents-v1';
const codes = new Set(['method_not_allowed','runtime_project_mismatch','caller_authentication_failed','caller_scope_denied',
  'operation_expired_or_spent','operation_already_armed','input_unavailable','fixed_input_required','protected_runtime_unavailable',
  'before_unavailable','before_guard_failed','activation_required','prepare_unavailable_or_spent','activation_unarmed_expired_or_spent']);
const safeSnapshot = v => v && typeof v==='object' ? Object.fromEntries(Object.entries(BASELINE).map(([k,expected])=>[k,v[k]===expected?expected:'MISMATCH'])) : null;
/** Whitelist the complete defined protocol, never arbitrary peer strings or fields. */
export function safeOpsResponse(status, raw) {
  const body=raw&&typeof raw==='object'?raw:{};
  const out={http_status:Number.isInteger(status)?status:null,state:['DRY_RUN','PASS','FAIL','UNKNOWN','STOP','DISABLED'].includes(body.state)?body.state:'UNKNOWN'};
  if(codes.has(body.code))out.code=body.code;
  if(body.scope)out.scope=JSON.stringify(body.scope)===JSON.stringify(SCOPE)?SCOPE:'MISMATCH';
  for(const name of ['before','after'])if(body[name])out[name]=safeSnapshot(body[name]);
  for(const name of ['spent','credential_resolved','full_rows_unchanged','binding_unchanged','credential_export'])if(typeof body[name]==='boolean')out[name]=body[name];
  for(const name of ['send_attempts','retry','redirect','authentication_metadata_writes'])if([0,1].includes(body[name]))out[name]=body[name];
  if(body.send_attempts==='READ_PERSISTENT_LEDGER')out.send_attempts=body.send_attempts;
  if(body.request_body)out.request_body=JSON.stringify(body.request_body)===JSON.stringify({source:'realtime',job_id:SCOPE.job})?body.request_body:'MISMATCH';
  for(const name of ['started_at','ended_at'])if(typeof body[name]==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(body[name]))out[name]=body[name];
  if(body.persistent_receipt==='UNAVAILABLE_SPENT_RETAINED')out.persistent_receipt=body.persistent_receipt;
  if(body.trace_limit==='Bounded actual HTTP receipt + early guard + full scoped hashes; no complete internal call trace.')out.trace_limit=body.trace_limit;
  if(body.response){const r=body.response;out.response={status:Number.isInteger(r.status)?r.status:null,body:{}};
    for(const [k,values] of Object.entries({error:['realtime_claim_rejected','unauthorized','claim_failed','evaluation_failed','internal_error'],reason:['conversation_not_evaluable','already_running','not_found','runtime_disabled']}))if(values.includes(r.body?.[k]))out.response.body[k]=r.body[k];
    if(r.body?.job_id===SCOPE.job)out.response.body.job_id=SCOPE.job;
    for(const k of ['request_id','execution_id'])out.response[k]=typeof r[k]==='string'&&/^[a-f0-9-]{16,80}$/i.test(r[k])?r[k]:'NOT_AVAILABLE';
    if(r.response_redacted===true)out.response.response_redacted=true;
  }
  return out;
}
export function successfulDryRun(r){return r?.http_status===200&&r.state==='DRY_RUN'&&r.send_attempts===0&&r.credential_resolved===false
  &&JSON.stringify(r.scope)===JSON.stringify(SCOPE)&&guards(r.before);}
/** No constructor/mount/timer network. Storage contains only non-secret intents. */
export class WorkerOperations {
  constructor(storage,verify,invoke){this.storage=storage;this.verify=verify;this.invoke=invoke;this.busy=false;this.proof=null;this.epoch=0;}
  invalidate(){this.epoch++;this.proof=null;}
  read(){const raw=this.storage.getItem(OPS_KEY);if(raw===null)return{};const j=JSON.parse(raw);
    if(!j||typeof j!=='object'||Array.isArray(j)||Object.keys(j).some(k=>!['dry-run','execute'].includes(k))||Object.values(j).some(v=>v!==SCOPE.activation))throw Error('intent_unavailable');return j;}
  can(mode){try{return !this.busy&&!this.read()[mode]&&(mode==='dry-run'||successfulDryRun(this.proof));}catch{return false;}}
  async run(mode){
    if(!['dry-run','execute'].includes(mode)||!this.can(mode))return null;
    this.busy=true;const epoch=this.epoch;
    try{await this.verify();if(epoch!==this.epoch)return null;
      // Re-read after identity awaits. Persist conservatively before the one invoke.
      const j=this.read();if(j[mode]||(mode==='execute'&&!successfulDryRun(this.proof)))return null;
      j[mode]=SCOPE.activation;this.storage.setItem(OPS_KEY,JSON.stringify(j));
      const body=Object.freeze(mode==='dry-run'?{mode}:{mode,activation_id:SCOPE.activation});
      let receipt;try{const r=await this.invoke(body);receipt=safeOpsResponse(r.status,r.body);}catch{receipt={http_status:null,state:'UNKNOWN'};}
      if(epoch!==this.epoch)return null;
      if(mode==='dry-run'&&successfulDryRun(receipt))this.proof=receipt;
      return receipt;
    }catch{return {http_status:null,state:'STOP',code:'client_identity_or_intent_unavailable'};}
    finally{this.busy=false;}
  }
}
export function workerResponseMatches(r){return validateReceipt(r?.response);}

/** Parse the actual SDK HTTP envelope, preserving non-secret protocol booleans. */
export async function parseOpsResult(result){
  const response=result.error?.context instanceof Response?result.error.context:result.response;
  if(!(response instanceof Response))return {status:null,body:{state:'UNKNOWN'}};
  let raw;
  try{
    if(!result.error&&response.bodyUsed)raw=result.data;
    else{const reader=response.body?.getReader();if(!reader)throw 0;let timer;
      try{const read=async()=>{let bytes=0,parts=[];for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.byteLength;if(bytes>16384)throw 0;parts.push(r.value);}
        const all=new Uint8Array(bytes);let n=0;for(const p of parts){all.set(p,n);n+=p.byteLength;}return JSON.parse(new TextDecoder().decode(all));};
        raw=await Promise.race([read(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(0),5000);})]);
      }finally{clearTimeout(timer);void reader.cancel().catch(()=>{});}
    }
    return {status:response.status,body:safeOpsResponse(response.status,raw)};
  }catch{return {status:response.status,body:{state:'UNKNOWN'}};}
}
