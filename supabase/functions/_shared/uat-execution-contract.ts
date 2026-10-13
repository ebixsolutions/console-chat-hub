/** Temporary synthetic UAT admission. Existing log persistence, not the deferred shared Guard. */
export const UAT_COMPANY = "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec";
export const UAT_REVISION = "c3-3f8b7c2-bounded-uat-v1";
export const UAT_MAX_INPUT = 20000;
export const UAT_MAX_OUTPUT = 8192;
export const UAT_THINKING = 1024;
type Db = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{data: any; error: any}> };
export type UatContext = { companyId: string | null; conversationId: string | null; operationId: string; provider: string; purpose: string; slot: string; attempt: number; request: string };
export class UatDenied extends Error { constructor(public code: string) { super(code); } }
export function uatRun(company: string | null): string | null {
  if (company !== UAT_COMPANY) return null;
  const id = Deno.env.get("C3_TEMP_UAT_RUN_ID");
  if (!id) return null;
  if (!/^[a-f0-9-]{36}$/.test(id) || Deno.env.get("C3_TEMP_UAT_SOURCE_REVISION") !== UAT_REVISION) throw new UatDenied("UAT_SOURCE_OR_RUN_DENIED");
  return id;
}
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b=>b.toString(16).padStart(2,"0")).join("");
async function rpc(db: Db, name: string, args: Record<string, unknown>) {
  let r;
  try { r = await db.rpc(name, args); } catch { throw new UatDenied("UAT_PERSISTENCE_UNAVAILABLE"); }
  if (r.error || !r.data) throw new UatDenied("UAT_ADMISSION_DENIED");
  return r.data;
}
/** Must persist a denial/pause for unknown in-flight outcomes; never refund reservations. */
export async function uatFetch(db: Db, meta: UatContext, url: string, init: RequestInit, upstream: typeof fetch = fetch, onDispatch?: ()=>void): Promise<Response> {
  const run = uatRun(meta.companyId);
  if (!run || !meta.conversationId || !meta.operationId || meta.operationId.length>240 || meta.slot.length>120 || !Number.isInteger(meta.attempt) || meta.attempt<1 || meta.attempt>3 || init.method!=="POST" || String(init.body)!==meta.request) throw new UatDenied("UAT_SCOPE_DENIED");
  const body = JSON.parse(meta.request);
  const remote = meta.provider === "singapore-kb";
  let inputCeiling = UAT_MAX_INPUT, outputCeiling = 0, model = "gemini-embedding-001", cost = 100000;
  if (remote) {
    if (url!=="https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search" || meta.purpose!=="kb_embedding" || typeof body.query!=="string" || new TextEncoder().encode(body.query).length>2048 || Object.keys(body).some(k=>!["query","company_id","candidate_top_k","max_documents","max_summary_chunks","max_full_content_chunks","score_threshold"].includes(k))) throw new UatDenied("UAT_REMOTE_SCOPE_DENIED");
    inputCeiling = 2048;
  } else {
    const u=new URL(url);
    const project=Deno.env.get("GOOGLE_PROJECT_ID")?.trim(), region=Deno.env.get("GOOGLE_REGION")?.trim();
    if (!project || !region || (u.protocol!=="https:" || u.hostname!==`${region}-aiplatform.googleapis.com` || u.port!=="") || u.pathname!==`/v1/projects/${project}/locations/${region}/publishers/google/models/gemini-2.5-flash:generateContent` || u.search || meta.provider!=="vertex" || !["generation","evaluation","assist"].includes(meta.purpose)) throw new UatDenied("UAT_PROVIDER_DENIED");
    if (new TextEncoder().encode(meta.request).length>80000 || body.tools || body.cachedContent || body.contents?.some((c:any)=>c.parts?.some((p:any)=>Object.keys(p).some(k=>k!=="text"))) || !Number.isInteger(body.generationConfig?.maxOutputTokens) || body.generationConfig.maxOutputTokens<1 || body.generationConfig.maxOutputTokens>UAT_MAX_OUTPUT || body.generationConfig?.thinkingConfig?.thinkingBudget!==UAT_THINKING) throw new UatDenied("UAT_TOKEN_EXPOSURE_DENIED");
    // CountTokens is pre-inference. Any failure denies before generateContent.
    const countRequest={contents:[...(body.contents ?? []),{role:"user",parts:[...(body.systemInstruction?.parts ?? []),{text:JSON.stringify(body.generationConfig?.responseSchema ?? {})}]}]};
    const counted=await upstream(url.replace(/:generateContent$/,":countTokens"), {method:"POST",headers:init.headers,body:JSON.stringify(countRequest),redirect:"error",signal:init.signal});
    if (!counted.ok) throw new UatDenied("UAT_TOKEN_COUNT_UNAVAILABLE");
    const count=(await counted.json()).totalTokens;
    if (!Number.isInteger(count) || count<1 || count>UAT_MAX_INPUT-1024) throw new UatDenied("UAT_INPUT_LIMIT");
    // Reserve the full input ceiling + output AND thinking ceilings, not average spend.
    outputCeiling=body.generationConfig.maxOutputTokens+UAT_THINKING;
    model="gemini-2.5-flash";
    cost=Math.ceil(UAT_MAX_INPUT*0.30+outputCeiling*2.50);
  }
  const requestHash=await digest(JSON.stringify([url,meta.request]));
  const key=await digest(JSON.stringify([meta.operationId,meta.slot,meta.attempt,meta.provider]));
  const receipt=await rpc(db,"c3_uat_reserve_dispatch",{p_run_id:run,p_revision:UAT_REVISION,p_company_id:meta.companyId,p_conversation_id:meta.conversationId,p_operation:meta.operationId,p_slot:meta.slot,p_identity:key,p_request_hash:requestHash,p_provider:meta.provider,p_purpose:meta.purpose,p_model:model,p_attempt:meta.attempt,p_input_ceiling:inputCeiling,p_output_ceiling:outputCeiling,p_cost_microusd:cost});
  if (receipt.dispatch!==true || receipt.run_id!==run || receipt.identity!==key || receipt.state!=="reserved" || !Number.isFinite(receipt.expires_epoch) || Date.now()/1000>=receipt.expires_epoch) throw new UatDenied("UAT_REPLAY_OR_RECEIPT_DENIED");
  const finish=async(state:string,status:number,input:number|null,output:number|null)=>{
    const r=await rpc(db,"c3_uat_finalize_dispatch",{p_run_id:run,p_company_id:meta.companyId,p_identity:key,p_state:state,p_status:status,p_input:input,p_output:output});
    if(r.state!==state)throw new UatDenied("UAT_FINALIZATION_DENIED");
  };
  let response:Response;
  try {onDispatch?.();response=await upstream(url,{...init,redirect:"error"});}
  catch(e){await finish("unknown",0,null,null);throw e;}
  if(remote){
    // Remote attempt/cost exposure is a retained bound, never a fabricated observed token count.
    await finish("remote_bound",response.status,null,null);
    return response;
  }
  if(!response.ok){await finish("response",response.status,0,0);return response;}
  let usage:any;
  try{usage=(await response.clone().json()).usageMetadata;}catch{}
  const input=usage?.promptTokenCount, output=(usage?.candidatesTokenCount??0)+(usage?.thoughtsTokenCount??0);
  if(!Number.isInteger(input) || input<0 || !Number.isInteger(usage?.candidatesTokenCount) || !Number.isInteger(output) || output<0 || input>inputCeiling || output>outputCeiling){await finish("unknown",response.status,null,null);throw new UatDenied("UAT_USAGE_UNOBSERVABLE_OR_OVER_LIMIT");}
  await finish("response",response.status,input,output);
  return response;
}

/** One in-flight synthetic dispatch; production retains its existing concurrency. */
export async function uatMap<T>(company: string | null, tasks: Array<()=>Promise<T>>): Promise<T[]> {
  if (!uatRun(company)) return await Promise.all(tasks.map(task=>task()));
  const results:T[]=[]; for(const task of tasks)results.push(await task()); return results;
}
