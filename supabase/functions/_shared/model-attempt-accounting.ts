import { buildVertexEndpoint } from "./vertex-generation-config.ts";
import { uatFetch, UatDenied, trustedDispatchScope } from "./uat-execution-contract.ts";
import { ORIGINAL_PREVIEW_ACCOUNTS } from "./original-widget-preview.ts";
/** Shared pre-dispatch model boundary. No scoped fail-open path. */
export type AccountingRpc = {
  from?: (table: string)=>any;
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: any; error: any }>;
};
export class ModelAccountingError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ModelAccountingError";
  }
}
export interface ModelAttempt {
  companyId: string | null;
  legacyAuthority?: object;
  conversationId: string | null;
  operationId: string;
  provider: string;
  purpose: string;
  slot: string;
  attempt: number;
  request: string;
}
export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(bytes),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Optional, separately approved server permission. B-O alone never grants KB.
 * A permission is inert until the existing remote proof matches the exact
 * request and reviewed runtime. No configuration is installed by this module. */
type Scope = {company:string;actor:string;channel:string;tenant:string;endpoint:string;request:string;runtime:string;authorization:string;expires:number;verified:boolean;used:boolean};
const permits=new WeakMap<object,Scope>();
const endpoint="https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search";
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export type OriginalPreviewKBPermit=object;

export async function authorizeOriginalPreviewKB(db:any,meta:{companyId:string|null;conversationId:string|null;provider:string;purpose:string;slot:string;attempt:number;request:string},url:string,init:RequestInit):Promise<OriginalPreviewKBPermit|null> {
  if(!meta.companyId || !meta.conversationId || meta.provider!=="singapore-kb" || meta.purpose!=="kb_embedding" || meta.slot!=="context-search" || meta.attempt!==1 || url!==endpoint || init.method!=="POST" || String(init.body)!==meta.request || new TextEncoder().encode(meta.request).length>8192)return null;
  let grant:any,request:any,map:any;
  try {grant=JSON.parse(Deno.env.get("ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION")??"null");request=JSON.parse(meta.request);map=JSON.parse(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON")??"null");}catch{return null;}
  if(grant?.version!==1 || !Array.isArray(grant.bindings) || grant.bindings.length>2 || Object.keys(grant).some(k=>!["version","bindings"].includes(k)) || !map || Array.isArray(map))return null;
  if(typeof request?.query!=="string" || !request.query.trim() || new TextEncoder().encode(request.query).length>2048 || !Number.isSafeInteger(request.company_id) || request.company_id<1 || Object.keys(request).some(k=>!["query","company_id","candidate_top_k","max_documents","max_summary_chunks","max_full_content_chunks","score_threshold"].includes(k)) || !Number.isInteger(request.candidate_top_k) || request.candidate_top_k<1 || request.candidate_top_k>50 || request.max_documents!==5 || request.max_summary_chunks!==1 || request.max_full_content_chunks!==3 || request.score_threshold!==0.05)return null;
  const tenant=String(request.company_id);
  if(String(map[meta.companyId])!==tenant)return null;
  const ticket=await db.from("conversations").select("id,company_id,channel_config_id,metadata_source").eq("id",meta.conversationId).eq("company_id",meta.companyId).maybeSingle();
  if(ticket.error || ticket.data?.id!==meta.conversationId || ticket.data.company_id!==meta.companyId)return null;
  const actor=ticket.data.metadata_source?.owner_user_id,channel=ticket.data.channel_config_id;
  if(!uuid.test(actor??"") || !ORIGINAL_PREVIEW_ACCOUNTS.some(a=>a.company===meta.companyId && a.channel===channel))return null;
  const matches=grant.bindings.filter((b:any)=>b && b.actor_id===actor && b.company_id===meta.companyId && b.channel_id===channel && b.tenant_id===tenant && b.endpoint===endpoint && b.provider==="singapore-kb" && b.purpose==="kb_embedding" && b.remote_mode==="retrieval_only" && b.allow_remote_embedding===false && /^[a-f0-9]{64}$/.test(b.remote_runtime_sha256??"") && Object.keys(b).every(k=>["actor_id","company_id","channel_id","tenant_id","endpoint","provider","purpose","remote_mode","allow_remote_embedding","remote_runtime_sha256"].includes(k)));
  if(matches.length!==1)return null;
  const token={};permits.set(token,{company:meta.companyId,actor,channel,tenant,endpoint,request:meta.request,runtime:matches[0].remote_runtime_sha256,authorization:Deno.env.get("ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION")!,expires:Date.now()+60000,verified:false,used:false});return token;
}

export function originalPreviewKBRemoteScope(permit:object|undefined,company:string|null,tenant:string,url:string,request:string|undefined):{runtime:string}|null {
  const s=permit && permits.get(permit);
  return s && !s.used && s.expires>Date.now() && s.company===company && s.tenant===tenant && s.endpoint===url && s.request===request ? {runtime:s.runtime} : null;
}
export function verifyOriginalPreviewKBRemoteProof(permit:object|undefined,runtime:string):boolean {
  const s=permit && permits.get(permit);if(!s || s.used || s.expires<=Date.now() || s.runtime!==runtime)return false;s.verified=true;return true;
}
export function consumeOriginalPreviewKBPermit(permit:object|undefined):boolean {
  const s=permit && permits.get(permit);if(!s || s.used || !s.verified || s.expires<=Date.now() || Deno.env.get("ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION")!==s.authorization)return false;
  try {if(String(JSON.parse(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON")??"null")?.[s.company])!==s.tenant)return false;}catch{return false;}
  s.used=true;return true;
}

export async function accountedModelFetch(
  db: AccountingRpc,
  meta: ModelAttempt,
  url: string,
  init: RequestInit,
  upstream: typeof fetch = fetch,
  onDispatch?: () => void,
  prepare?: (mode: "legacy" | "uat" | "authenticated_preview", permit?:OriginalPreviewKBPermit) => Promise<Record<string,string>>,
): Promise<Response> {
  let mode: "legacy" | "uat" | "authenticated_preview";
  try {
    mode = await trustedDispatchScope(db, meta.companyId, meta.conversationId, meta.legacyAuthority);
  } catch (e) {
    if (e instanceof UatDenied) throw new ModelAccountingError(e.code);
    // A failed provider transport is not an admission denial. Unknown outcomes
    // have already been durably paused by uatFetch before this error returns.
    throw e;
  }
  let kbPermit:OriginalPreviewKBPermit|undefined;
  if(mode==="authenticated_preview" && meta.provider==="singapore-kb") {
    kbPermit=await authorizeOriginalPreviewKB(db,meta,url,init) ?? undefined;
    if(!kbPermit || !prepare)throw new ModelAccountingError("ORIGINAL_PREVIEW_PROVIDER_DENIED");
  }
  if (mode === "authenticated_preview" && !kbPermit) {
    // Explicit original-account paid permission, not synthetic admission and
    // never ordinary traffic reclassification. Existing provider only, bounded
    // original retry/output controls; no new ledger or inferred UAT balance.
    const model=Deno.env.get("LLM_MODEL_"+meta.purpose.toUpperCase())?.trim();
    const project=Deno.env.get("GOOGLE_PROJECT_ID")?.trim(),region=Deno.env.get("GOOGLE_REGION")?.trim();
    if(Deno.env.get("LLM_PROVIDER")?.trim().toLowerCase()!=="vertex" || meta.provider!=="vertex" ||
      !["generation","assist","evaluation"].includes(meta.purpose) || !model || !project || !region ||
      !Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON")?.trim() || url!==buildVertexEndpoint(project,region,model) ||
      init.method!=="POST" || String(init.body)!==meta.request || !Number.isInteger(meta.attempt) || meta.attempt<1 || meta.attempt>3)
      throw new ModelAccountingError("ORIGINAL_PREVIEW_PROVIDER_DENIED");
    const body=JSON.parse(meta.request);
    if(new TextEncoder().encode(meta.request).length>256000 || !Number.isInteger(body.generationConfig?.maxOutputTokens) ||
      body.generationConfig.maxOutputTokens<1 || body.generationConfig.maxOutputTokens>8192)
      throw new ModelAccountingError("ORIGINAL_PREVIEW_PROVIDER_DENIED");
  }
  // Prepare remote retrieval only after trusted identity and provider admission.
  // The mode is server-derived here; no HTTP/body flag can select this branch.
  const prepareInit=async(value:RequestInit):Promise<RequestInit>=>{
    const extraHeaders=await prepare?.(mode,kbPermit);
    return extraHeaders ? {...value,headers:{...Object.fromEntries(new Headers(value.headers).entries()),...extraHeaders}} : value;
  };
  if(mode==="uat") {
    // The synthetic durable quota/bound admission still precedes preparation
    // and remote I/O. A denied reservation must not call the preparation hook.
    const transport:typeof fetch=prepare ? async(input,options)=>await upstream(input,await prepareInit(options ?? {})) : upstream;
    try {return await uatFetch(db,{...meta,operationId:`${meta.slot}:${meta.operationId}`},url,init,transport,onDispatch);}
    catch(error){if(error instanceof UatDenied)throw new ModelAccountingError(error.code);throw error;}
  }
  const preparedInit=await prepareInit(init);
  if(kbPermit && !consumeOriginalPreviewKBPermit(kbPermit))throw new ModelAccountingError("UAT_REMOTE_BOUND_UNVERIFIED");
  // Established authenticated Production path: preserve exact provider request/response.
  // Permanent Guard is deferred; no new endpoint, provider, credential or tenant scope.
  onDispatch?.();
  return await upstream(url, mode==="authenticated_preview" ? {...preparedInit,redirect:"error"} : preparedInit);
}

/** Historical deferred Guard contract. No six-Function runtime caller uses this API. */
export async function deferredAccountedModelFetch(
  db: AccountingRpc, meta: ModelAttempt, url: string, init: RequestInit,
  upstream: typeof fetch = fetch, onDispatch?: ()=>void,
): Promise<Response> {
  // Request hash is durable; provider payload/secrets/customer text are not stored.
  const identity = await sha256(
    JSON.stringify([meta.operationId, meta.slot, meta.attempt, meta.provider]),
  );
  let reservation: any;
  try {
    const result = await db.rpc("c3_reserve_model_attempt", {
      p_company_id: meta.companyId,
      p_conversation_id: meta.conversationId,
      p_identity: identity,
      p_operation_id: meta.operationId,
      p_provider: meta.provider,
      p_purpose: meta.purpose,
      p_request_sha256: await sha256(
        JSON.stringify([url, init.method ?? "GET", meta.request]),
      ),
    });
    if (
      result.error || !result.data || typeof result.data.scoped !== "boolean" ||
      typeof result.data.dispatch !== "boolean"
    ) {
      throw new Error("reservation_failed");
    }
    reservation = result.data;
    if (!reservation.dispatch) {
      throw new ModelAccountingError("MODEL_ATTEMPT_ALREADY_RESERVED");
    }
    if (
      reservation.scoped &&
      (!reservation.run_id || reservation.state !== "reserved")
    ) throw new Error("invalid_receipt");
  } catch (e) {
    if (e instanceof ModelAccountingError) throw e;
    throw new ModelAccountingError("MODEL_ACCOUNTING_DENIED");
  }
  const finalize = async (state: "response" | "unknown", status: number) => {
    if (!reservation.scoped) return;
    try {
      const result = await db.rpc("c3_finalize_model_attempt", {
        p_company_id: meta.companyId,
        p_run_id: reservation.run_id,
        p_identity: identity,
        p_state: state,
        p_http_status: status,
      });
      if (result.error || result.data?.state !== state) {
        throw new Error("finalize_failed");
      }
    } catch {
      throw new ModelAccountingError(
        "MODEL_ACCOUNTING_FINALIZATION_UNAVAILABLE",
      );
    }
  };
  let response: Response;
  try {
    onDispatch?.();
    response = await upstream(url, { ...init, redirect: "error" });
  } catch (e) {
    await finalize("unknown", 0);
    throw e;
  }
  await finalize("response", response.status);
  return response;
}
