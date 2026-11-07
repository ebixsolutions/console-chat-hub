// Shared by the protected Edge runtime and offline tests. No CLI or URL inputs.
export const SCOPE = Object.freeze({
  backend: 'nrfxhqabwblzxoushgnm',
  endpoint: 'https://nrfxhqabwblzxoushgnm.supabase.co/functions/v1/ce-evaluation-worker',
  company: '4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec',
  channel: '0405282f-77dc-47cf-8074-99dd3dc6c393',
  conversation: '4813e2b2-ad0b-509f-aff2-e8c548745b71',
  job: '16e0abc4-aa3d-48f8-857b-5ca6f75142ea',
  activation: 'C3-B12-WORKER-ONCE-20261009-42eee3e7',
});
export const BODY = '{"source":"realtime","job_id":"16e0abc4-aa3d-48f8-857b-5ca6f75142ea"}';
export const BASELINE = Object.freeze({
  jobs: '44d482de57328d4019b28a8d15d53ee6',
  methodology: 'cf07d879c1273487b71e7eff835984f1',
  ce_state: 'dd139ab433a5bedeb2d941a7537d1900',
  messages: '03889f973e5d3e89e89f143772fb560b',
  models: 'd4c66cb6843e5c85a6b52ccc671a911a',
  canonical: 'd751713988987e9331980363e24189ce',
  local: 'd751713988987e9331980363e24189ce',
  evaluations: 'd751713988987e9331980363e24189ce',
  learning: 'd751713988987e9331980363e24189ce',
  training: 'd751713988987e9331980363e24189ce',
  outbox: 'd751713988987e9331980363e24189ce',
  jobs_count: 11, messages_count: 22, models_count: 7,
  canonical_count: 0, local_count: 0, evaluations_count: 0,
  learning_count: 0, training_count: 0, outbox_count: 0,
  jobs_shape: true, exact_scope: true, scope_all: true, learning_excluded: true,
  ce_evaluable: false, runtime_enabled: false,
  verifier: 'de11168474a55582e694ea995824e950',
  claim: 'f49f8c0c08c6fb7b6db0a758b0e30885',
  evaluable: '2109fe94d06a191d10adf5f92e2a6eb8',
  registry: '4688a8d44d45c7a31445c105160a1250',
});
export function guards(snapshot) {
  return snapshot && Object.entries(BASELINE).every(([k,v]) => snapshot[k] === v);
}
export function validateReceipt(r) {
  return r?.status === 409 && r?.body?.error === 'realtime_claim_rejected'
    && r?.body?.reason === 'conversation_not_evaluable'
    && r?.body?.job_id === SCOPE.job;
}
const safeId = v => typeof v === 'string' && /^[a-f0-9-]{16,80}$/i.test(v) ? v : 'NOT_AVAILABLE';
// Never echo an arbitrary error/body/string supplied by a network peer.
export function sanitizeResponse(status, raw, requestId, secrets = []) {
  const out = { status: Number.isInteger(status) ? status : null, body: {}, request_id: safeId(requestId) };
  let body; try { body = JSON.parse(raw); } catch { return out; }
  const known = {error:['realtime_claim_rejected','unauthorized','claim_failed','evaluation_failed','internal_error'],
    reason:['conversation_not_evaluable','already_running','not_found','runtime_disabled']};
  for (const [key,values] of Object.entries(known)) if(values.includes(body?.[key])) out.body[key] = body[key];
  if(body?.job_id === SCOPE.job) out.body.job_id = SCOPE.job;
  out.execution_id = safeId(body?.execution_id);
  if (secrets.some(s => typeof s === 'string' && s.length && JSON.stringify(out).includes(s)))
    return {status:out.status,body:{},request_id:'NOT_AVAILABLE',execution_id:'NOT_AVAILABLE',response_redacted:true};
  return out;
}
export async function readBounded(response, limit = 4096) {
  if(!response.body) return '';
  const reader = response.body.getReader(); let bytes=0, parts=[];
  try {
    for (;;) { const {done,value}=await reader.read(); if(done)break;
      bytes+=value.byteLength; if(bytes>limit) { await reader.cancel(); return ''; } parts.push(value); }
    const buf=new Uint8Array(bytes); let n=0; for(const p of parts){buf.set(p,n);n+=p.byteLength;}
    return new TextDecoder().decode(buf);
  } finally { reader.releaseLock(); }
}
/** @param {Record<string, any>} input @param {any} io */
export async function execute(input = {}, io) {
  const keys = Object.keys(input ?? {});
  if(!input || typeof input !== 'object' || Array.isArray(input) || keys.some(k=>!['mode','activation_id'].includes(k))
    || !['dry-run','execute'].includes(input.mode ?? 'dry-run')
    || (input.activation_id !== undefined && input.activation_id !== SCOPE.activation))
    return {state:'STOP',code:'fixed_input_required',send_attempts:0};
  let before;
  try { before=await io.snapshot(); } catch { return {state:'STOP',code:'before_unavailable',send_attempts:0}; }
  if(!guards(before)) return {state:'STOP',code:'before_guard_failed',send_attempts:0};
  if((input.mode ?? 'dry-run')==='dry-run') return {state:'DRY_RUN',scope:SCOPE,before,send_attempts:0,credential_resolved:false};
  if(input.activation_id!==SCOPE.activation) return {state:'STOP',code:'activation_required',send_attempts:0};
  // prepare resolves credential privately, rechecks guards, and atomically COMMITs
  // spent/send-intent before returning its closure. No business locks span HTTP.
  let send;
  try { send=await io.prepare(); } catch { return {state:'STOP',code:'prepare_unavailable_or_spent',send_attempts:0}; }
  if(!send) return {state:'STOP',code:'activation_unarmed_expired_or_spent',send_attempts:0};
  const started_at=new Date().toISOString(); let response=null, outcome='UNKNOWN';
  try { response=await send(); outcome=validateReceipt(response)?'RESPONSE_MATCH':'RESPONSE_FAIL'; }
  catch { /* Exception messages can contain secrets. Never stringify/log them. */ }
  let after=null, unchanged=false, binding_unchanged=false;
  try { after=await io.snapshot(); unchanged=guards(after);
    binding_unchanged=await io.bindingUnchanged(); } catch { /* Unknown -> spent. */ }
  const receipt={state:outcome==='RESPONSE_MATCH'&&unchanged&&binding_unchanged?'PASS':outcome==='UNKNOWN'?'UNKNOWN':'FAIL',
    scope:SCOPE,request_body:JSON.parse(BODY),started_at,ended_at:new Date().toISOString(),
    send_attempts:1,spent:true,retry:0,redirect:0,response,before,after,
    full_rows_unchanged:unchanged,binding_unchanged,credential_export:false,authentication_metadata_writes:0,
    trace_limit:'Bounded actual HTTP receipt + early guard + full scoped hashes; no complete internal call trace.'};
  try { await io.finish(receipt); } catch { return {...receipt,persistent_receipt:'UNAVAILABLE_SPENT_RETAINED'}; }
  return receipt;
}
