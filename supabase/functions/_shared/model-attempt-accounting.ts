import { buildVertexEndpoint } from "./vertex-generation-config.ts";
import { uatFetch, UatDenied, trustedDispatchScope, authenticatedInboxIdentity } from "./uat-execution-contract.ts";
import { ORIGINAL_PREVIEW_ACCOUNTS } from "./original-widget-preview.ts";
import { originalPreviewRagConfiguration } from "./original-preview-kb-config.ts";
import { FRANKIE_KB_SCOPE, queryEmbeddingEvidence, verifiedQueryEmbeddingAttestation, bindQueryEmbeddingResponse,
  liveMetadataPolicy, liveMetadataSessionMatches, currentLiveMetadataSession, bindLiveMetadataResponse, LIVE_METADATA_MODE,
  ragApiPolicy, bindRagApiResponse, RAG_API_MODE,
  type RagApiPolicy, type LiveMetadataPolicy, type QueryEmbeddingEvidence, type QueryEmbeddingAttestation } from "./preview-kb-query-embedding.ts";
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
type Scope = {company:string;actor:string;channel:string;tenant:string;endpoint:string;request:string;runtime:string;authorization:string;authorizationKey:string;expires:number;verified:boolean;used:boolean;evidence?:QueryEmbeddingEvidence;attestation?:QueryEmbeddingAttestation;livePolicy?:LiveMetadataPolicy;liveSession?:object;apiPolicy?:RagApiPolicy;ragKeys?:string};
const permits=new WeakMap<object,Scope>();
const inboxDispatched=new WeakMap<object,Set<string>>();
const inboxGrounded=new WeakMap<object,{authorization:string;expires:number}>();
const endpoint="https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search";
const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
export type OriginalPreviewKBPermit=object;

export async function authorizeOriginalPreviewKB(db:any,meta:{companyId:string|null;conversationId:string|null;provider:string;purpose:string;slot:string;attempt:number;request:string},url:string,init:RequestInit):Promise<OriginalPreviewKBPermit|null> {
  if(!meta.companyId || !meta.conversationId || meta.provider!=="singapore-kb" || meta.purpose!=="kb_embedding" || meta.slot!=="context-search" || meta.attempt!==1 || url!==endpoint || init.method!=="POST" || String(init.body)!==meta.request || new TextEncoder().encode(meta.request).length>8192)return null;
  let grant:any,request:any,map:any;
  try {grant=JSON.parse(Deno.env.get("ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION")??"null");request=JSON.parse(meta.request);map=JSON.parse(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON")??"null");}catch{return null;}
  if(![1,2,3,4].includes(grant?.version) || !Array.isArray(grant.bindings) || grant.bindings.length>(grant.version>=3?20:grant.version===2?1:2) || Object.keys(grant).some(k=>!["version","bindings"].includes(k)) || !map || Array.isArray(map))return null;
  if(typeof request?.query!=="string" || !request.query.trim() || new TextEncoder().encode(request.query).length>2048 || !Number.isSafeInteger(request.company_id) || request.company_id<1 || Object.keys(request).some(k=>!["query","company_id","candidate_top_k","max_documents","max_summary_chunks","max_full_content_chunks","score_threshold"].includes(k)) || !Number.isInteger(request.candidate_top_k) || request.candidate_top_k<1 || request.candidate_top_k>50 || request.max_documents!==5 || request.max_summary_chunks!==1 || request.max_full_content_chunks!==3 || request.score_threshold!==0.05)return null;
  const tenant=String(request.company_id);
  if(String(map[meta.companyId])!==tenant)return null;
  const ticket=await db.from("conversations").select("id,company_id,channel_config_id,metadata_source,status,assigned_agent_id").eq("id",meta.conversationId).eq("company_id",meta.companyId).maybeSingle();
  if(ticket.error || ticket.data?.id!==meta.conversationId || ticket.data.company_id!==meta.companyId)return null;
  if(grant.version>=2 && (ticket.data.status!=="open" || ticket.data.assigned_agent_id))return null;
  const actor=ticket.data.metadata_source?.owner_user_id,channel=ticket.data.channel_config_id;
  if(!uuid.test(actor??"") || !ORIGINAL_PREVIEW_ACCOUNTS.some(a=>a.company===meta.companyId && a.channel===channel))return null;
  const fields=["actor_id","company_id","channel_id","tenant_id","endpoint","provider","purpose","remote_mode","allow_remote_embedding","remote_runtime_sha256"];
  const matches=grant.bindings.filter((b:any)=>{
    if(!b || b.actor_id!==actor || b.company_id!==meta.companyId || b.channel_id!==channel || b.tenant_id!==tenant || b.endpoint!==endpoint || b.provider!=="singapore-kb" || b.purpose!=="kb_embedding")return false;
    if(b.remote_mode===RAG_API_MODE)return originalPreviewRagConfiguration(name=>Deno.env.get(name),{actor,company:meta.companyId!,channel}).ready && validLiveRagCredential(init,tenant);
    if(grant.version>=3 && b.remote_mode===LIVE_METADATA_MODE)return actor===FRANKIE_KB_SCOPE.actor && meta.companyId===FRANKIE_KB_SCOPE.company && channel===FRANKIE_KB_SCOPE.channel && tenant===FRANKIE_KB_SCOPE.tenant && !!liveMetadataPolicy(b) && validLiveRagCredential(init,tenant) && Object.keys(b).every(k=>["actor_id","company_id","channel_id","tenant_id","endpoint","provider","purpose","remote_mode","allow_remote_embedding","evidence_reference"].includes(k));
    if(grant.version===1 || grant.version>=3 && b.remote_mode==="retrieval_only")return b.remote_mode==="retrieval_only" && b.allow_remote_embedding===false && /^[a-f0-9]{64}$/.test(b.remote_runtime_sha256??"") && Object.keys(b).every(k=>fields.includes(k));
    return actor===FRANKIE_KB_SCOPE.actor && meta.companyId===FRANKIE_KB_SCOPE.company && channel===FRANKIE_KB_SCOPE.channel && tenant===FRANKIE_KB_SCOPE.tenant && !!queryEmbeddingEvidence(b) &&
      Object.keys(b).every(k=>[...fields,"deployment_evidence_sha256","embedding_config_sha256","lineage_evidence_sha256","attestation_payload","attestation_signature","evidence_reference"].includes(k));
  });
  if(matches.length!==1)return null;
  const token={};permits.set(token,{company:meta.companyId,actor,channel,tenant,endpoint,request:meta.request,runtime:matches[0].remote_mode===RAG_API_MODE?RAG_API_MODE:matches[0].remote_mode===LIVE_METADATA_MODE?LIVE_METADATA_MODE:matches[0].remote_runtime_sha256,authorization:Deno.env.get("ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION")!,authorizationKey:"ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION",expires:Date.now()+60000,verified:false,used:false,...(matches[0].remote_mode===RAG_API_MODE?{apiPolicy:ragApiPolicy(matches[0])!,ragKeys:Deno.env.get("KB_SINGAPORE_TENANT_API_KEYS_JSON")}:matches[0].remote_mode===LIVE_METADATA_MODE?{livePolicy:liveMetadataPolicy(matches[0])!,ragKeys:Deno.env.get("KB_SINGAPORE_TENANT_API_KEYS_JSON")}:matches[0].remote_mode==="query_embedding_attested_v1"?{evidence:queryEmbeddingEvidence(matches[0])!}:{})});return token;
}

export function originalPreviewKBRemoteScope(permit:object|undefined,company:string|null,tenant:string,url:string,request:string|undefined):{runtime:string;evidence?:QueryEmbeddingEvidence;livePolicy?:LiveMetadataPolicy;apiPolicy?:RagApiPolicy}|null {
  const s=permit && permits.get(permit);
  return s && !s.used && s.expires>Date.now() && s.company===company && s.tenant===tenant && s.endpoint===url && s.request===request ? {runtime:s.runtime,evidence:s.evidence,livePolicy:s.livePolicy,apiPolicy:s.apiPolicy} : null;
}
/** Paid request admission only; source authority is checked after the actual
 * authenticated RAG response. This never attests remote runtime or cost. */
export function prepareOriginalPreviewKBApiAdmission(permit:object|undefined):boolean {
  const s=permit && permits.get(permit);
  if(!s || !s.apiPolicy || s.used || s.expires<=Date.now() || !currentPermitEvidence(s))return false;
  s.verified=true;return true;
}
export function verifyOriginalPreviewKBRemoteProof(permit:object|undefined,runtime:string,attestation?:QueryEmbeddingAttestation):boolean {
  const s=permit && permits.get(permit);if(!s || s.used || s.expires<=Date.now() || s.runtime!==runtime)return false;
  if(s.evidence && (!attestation || !verifiedQueryEmbeddingAttestation(attestation) || attestation.runtime_sha256!==s.runtime ||
    attestation.deployment_evidence_sha256!==s.evidence.deployment_evidence_sha256 || attestation.embedding_config_sha256!==s.evidence.embedding_config_sha256 ||
    attestation.lineage_evidence_sha256!==s.evidence.lineage_evidence_sha256))return false;
  if(attestation && (attestation.actor!==s.actor || attestation.company!==s.company || attestation.channel!==s.channel || attestation.tenant!==s.tenant || attestation.endpoint!==s.endpoint))return false;
  s.attestation=attestation;s.verified=true;return true;
}
export function verifyOriginalPreviewKBLiveProof(permit:object|undefined,session:object):boolean {
  const s=permit && permits.get(permit);
  if(!s || s.used || s.expires<=Date.now() || !s.livePolicy || !liveMetadataSessionMatches(session,s.livePolicy))return false;
  s.liveSession=session;s.verified=true;return true;
}
function validLiveRagCredential(init:RequestInit,tenant:string):boolean {
  try{const keys=JSON.parse(Deno.env.get("KB_SINGAPORE_TENANT_API_KEYS_JSON")??"null"),headers=new Headers(init.headers);return typeof keys?.[tenant]==="string" && !!keys[tenant] && headers.get("x-api-key")===keys[tenant] && !headers.has("authorization") && !headers.has("x-service-role-secret");}catch{return false;}
}
function currentPermitEvidence(s:Scope):boolean {
  if(s.apiPolicy){
    if(s.authorizationKey==="ORIGINAL_WIDGET_PREVIEW_KB_AUTHORIZATION" && !originalPreviewRagConfiguration(name=>Deno.env.get(name),{actor:s.actor,company:s.company,channel:s.channel}).ready)return false;
    if(Deno.env.get("KB_SINGAPORE_TENANT_API_KEYS_JSON")!==s.ragKeys)return false;
    try{const g=JSON.parse(Deno.env.get(s.authorizationKey)??"null"),map=JSON.parse(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON")??"null"),b=g.bindings.filter((x:any)=>x.actor_id===s.actor && x.company_id===s.company && x.channel_id===s.channel && x.tenant_id===s.tenant && x.endpoint===s.endpoint);return String(map?.[s.company])===s.tenant && b.length===1 && JSON.stringify(ragApiPolicy(b[0]))===JSON.stringify(s.apiPolicy);}catch{return false;}
  }
  if(s.livePolicy){
    if(Deno.env.get("KB_SINGAPORE_TENANT_API_KEYS_JSON")!==s.ragKeys)return false;
    try{const g=JSON.parse(Deno.env.get(s.authorizationKey)??"null"),b=g.bindings.filter((x:any)=>x.actor_id===s.actor && x.company_id===s.company && x.channel_id===s.channel && x.tenant_id===s.tenant && x.endpoint===s.endpoint);return b.length===1 && JSON.stringify(liveMetadataPolicy(b[0]))===JSON.stringify(s.livePolicy) && !!s.liveSession && currentLiveMetadataSession(s.liveSession);}catch{return false;}
  }
  if(!s.evidence)return true;
  try {const grant=JSON.parse(Deno.env.get(s.authorizationKey)??"null");const bindings=grant.bindings.filter((b:any)=>b.actor_id===s.actor && b.company_id===s.company && b.channel_id===s.channel && b.tenant_id===s.tenant && b.endpoint===s.endpoint);return bindings.length===1 && JSON.stringify(queryEmbeddingEvidence(bindings[0]))===JSON.stringify(s.evidence);}catch{return false;}
}
export function consumeOriginalPreviewKBPermit(permit:object|undefined):boolean {
  const s=permit && permits.get(permit);if(!s || s.used || !s.verified || s.expires<=Date.now() || Deno.env.get(s.authorizationKey)!==s.authorization)return false;
  if((s.apiPolicy || s.livePolicy) && !currentPermitEvidence(s))return false;
  if(s.evidence && (!currentPermitEvidence(s) || !s.attestation || s.attestation.expires*1000<=Date.now()))return false;
  try {if(String(JSON.parse(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON")??"null")?.[s.company])!==s.tenant)return false;}catch{return false;}
  s.used=true;return true;
}

/** Separately approved manual Inbox scope, never inferred from B-O or ticket
 * ownership. Evidence is verified by the same remote guard before any RAG I/O. */
async function inboxBinding(db:AccountingRpc,meta:ModelAttempt):Promise<any> {
  const a=await authenticatedInboxIdentity(db,meta.legacyAuthority,meta.companyId,meta.conversationId);
  let g:any,map:any;try {g=JSON.parse(Deno.env.get("AUTHENTICATED_INBOX_KB_AUTHORIZATION")??"null");map=JSON.parse(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON")??"null");}catch{throw new ModelAccountingError("INBOX_PAID_SCOPE_DENIED");}
  if(![1,2,3].includes(g?.version) || Object.keys(g).some(k=>!["version","bindings"].includes(k)) || !Array.isArray(g.bindings) || g.bindings.length>20)throw new ModelAccountingError("INBOX_PAID_SCOPE_DENIED");
  const matches=g.bindings.filter((b:any)=>b?.actor_id===a.actor && b.company_id===a.company && b.channel_id===a.channel && b.tenant_id===String(map?.[a.company]) && b.endpoint===endpoint &&
    Array.isArray(b.operations) && b.operations.length>0 && b.operations.every((o:any)=>["knowledge","policy"].includes(o)) && b.operations.includes(a.operation) && b.provider==="singapore-kb" && b.purpose==="kb_embedding" && typeof b.allow_assist==="boolean" &&
    (b.remote_mode===RAG_API_MODE?g.version===3 && a.actor===FRANKIE_KB_SCOPE.actor && a.company===FRANKIE_KB_SCOPE.company && a.channel===FRANKIE_KB_SCOPE.channel && b.tenant_id===FRANKIE_KB_SCOPE.tenant && !!ragApiPolicy(b):b.remote_mode!==LIVE_METADATA_MODE?!!queryEmbeddingEvidence(b):g.version>=2 && a.actor===FRANKIE_KB_SCOPE.actor && a.company===FRANKIE_KB_SCOPE.company && a.channel===FRANKIE_KB_SCOPE.channel && b.tenant_id===FRANKIE_KB_SCOPE.tenant && !!liveMetadataPolicy(b)) &&
    Object.keys(b).every(k=>["actor_id","company_id","channel_id","tenant_id","endpoint","operations","provider","purpose","allow_assist","remote_mode","allow_remote_embedding","remote_runtime_sha256","deployment_evidence_sha256","embedding_config_sha256","lineage_evidence_sha256","attestation_payload","attestation_signature","evidence_reference","rag_api_contract","accepted_remote_risk"].includes(k)));
  if(matches.length!==1)throw new ModelAccountingError("INBOX_PAID_SCOPE_DENIED");
  return {...matches[0],_grant_version:g.version,_live:matches[0].remote_mode===LIVE_METADATA_MODE,_api:matches[0].remote_mode===RAG_API_MODE};
}
async function authorizeInboxKB(db:AccountingRpc,meta:ModelAttempt,url:string,init:RequestInit):Promise<OriginalPreviewKBPermit> {
  const b=await inboxBinding(db,meta);if((b._live || b._api) && (!validLiveRagCredential(init,b.tenant_id) || Object.keys(b).some(k=>!["_grant_version","_live","_api","actor_id","company_id","channel_id","tenant_id","endpoint","provider","purpose","operations","allow_assist","remote_mode","allow_remote_embedding",...(b._api?["rag_api_contract","accepted_remote_risk"]:["evidence_reference"])].includes(k))))throw new ModelAccountingError("INBOX_PAID_SCOPE_DENIED");let r:any;try{r=JSON.parse(meta.request);}catch{throw new ModelAccountingError("INBOX_PAID_SCOPE_DENIED");}
  if(meta.provider!=="singapore-kb" || meta.purpose!=="kb_embedding" || meta.slot!=="context-search" || meta.attempt!==1 || url!==endpoint || init.method!=="POST" || String(init.body)!==meta.request || new TextEncoder().encode(meta.request).length>8192 || typeof r.query!=="string" || !r.query.trim() || new TextEncoder().encode(r.query).length>2048 || String(r.company_id)!==b.tenant_id || !Number.isSafeInteger(r.company_id) || Object.keys(r).some(k=>!["query","company_id","candidate_top_k","max_documents","max_summary_chunks","max_full_content_chunks","score_threshold"].includes(k)) || !Number.isInteger(r.candidate_top_k) || r.candidate_top_k<1 || r.candidate_top_k>50 || r.max_documents!==5 || r.max_summary_chunks!==1 || r.max_full_content_chunks!==3 || r.score_threshold!==0.05)throw new ModelAccountingError("INBOX_PAID_SCOPE_DENIED");
  const token={};permits.set(token,{company:meta.companyId!,actor:b.actor_id,channel:b.channel_id,tenant:b.tenant_id,endpoint,request:meta.request,runtime:b._api?RAG_API_MODE:b._live?LIVE_METADATA_MODE:b.remote_runtime_sha256,authorization:Deno.env.get("AUTHENTICATED_INBOX_KB_AUTHORIZATION")!,authorizationKey:"AUTHENTICATED_INBOX_KB_AUTHORIZATION",expires:Date.now()+60000,verified:false,used:false,...(b._api?{apiPolicy:ragApiPolicy(b)!,ragKeys:Deno.env.get("KB_SINGAPORE_TENANT_API_KEYS_JSON")}:b._live?{livePolicy:liveMetadataPolicy(b)!,ragKeys:Deno.env.get("KB_SINGAPORE_TENANT_API_KEYS_JSON")}:{evidence:queryEmbeddingEvidence(b)!})});return token;
}
export async function accountedModelFetch(
  db: AccountingRpc,
  meta: ModelAttempt,
  url: string,
  init: RequestInit,
  upstream: typeof fetch = fetch,
  onDispatch?: () => void,
  prepare?: (mode: "legacy" | "uat" | "authenticated_preview" | "authenticated_inbox", permit?:OriginalPreviewKBPermit) => Promise<Record<string,string>>,
): Promise<Response> {
  let mode: "legacy" | "uat" | "authenticated_preview" | "authenticated_inbox";
  try {
    mode = await trustedDispatchScope(db, meta.companyId, meta.conversationId, meta.legacyAuthority);
  } catch (e) {
    if (e instanceof UatDenied) throw new ModelAccountingError(e.code);
    // A failed provider transport is not an admission denial. Unknown outcomes
    // have already been durably paused by uatFetch before this error returns.
    throw e;
  }
  let kbPermit:OriginalPreviewKBPermit|undefined;
  if(mode==="authenticated_inbox") {
    const b=await inboxBinding(db,meta);
    if(meta.provider==="singapore-kb") {if(!prepare)throw new ModelAccountingError("INBOX_PAID_SCOPE_DENIED");kbPermit=await authorizeInboxKB(db,meta,url,init);}
    else if(!b.allow_assist || !meta.legacyAuthority || inboxGrounded.get(meta.legacyAuthority)?.authorization!==Deno.env.get("AUTHENTICATED_INBOX_KB_AUTHORIZATION") || (inboxGrounded.get(meta.legacyAuthority)?.expires ?? 0)<=Date.now() || meta.provider!=="vertex" || meta.purpose!=="assist")throw new ModelAccountingError("INBOX_PAID_SCOPE_DENIED");
  }
  if(mode==="authenticated_preview" && meta.provider==="singapore-kb") {
    kbPermit=await authorizeOriginalPreviewKB(db,meta,url,init) ?? undefined;
    if(!kbPermit || !prepare)throw new ModelAccountingError("ORIGINAL_PREVIEW_PROVIDER_DENIED");
  }
  if ((mode === "authenticated_preview" || mode === "authenticated_inbox") && !kbPermit) {
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
  if(kbPermit && (preparedInit.method!=="POST" || String(preparedInit.body)!==meta.request))throw new ModelAccountingError("UAT_REMOTE_BOUND_UNVERIFIED");
  // Established authenticated Production path: preserve exact provider request/response.
  // Permanent Guard is deferred; no new endpoint, provider, credential or tenant scope.
  if(mode==="authenticated_inbox") {
    await inboxBinding(db,meta);
    if(!meta.operationId || meta.operationId.length>240)throw new ModelAccountingError("INBOX_PAID_SCOPE_DENIED");
    const identity=JSON.stringify([meta.operationId,meta.provider,meta.slot,meta.attempt]);
    const used=inboxDispatched.get(meta.legacyAuthority!) ?? new Set<string>();
    if(used.has(identity))throw new ModelAccountingError("INBOX_REPLAY_DENIED");
    used.add(identity);inboxDispatched.set(meta.legacyAuthority!,used);
  }
  // No asynchronous work may separate the final evidence consumption from I/O.
  if(kbPermit){const s=permits.get(kbPermit)!;if((s.apiPolicy || s.livePolicy) && !validLiveRagCredential(preparedInit,s.tenant))throw new ModelAccountingError("UAT_REMOTE_BOUND_UNVERIFIED");}
  if(kbPermit && !consumeOriginalPreviewKBPermit(kbPermit))throw new ModelAccountingError("UAT_REMOTE_BOUND_UNVERIFIED");
  onDispatch?.();
  const response=await upstream(url, (mode==="authenticated_preview" || mode==="authenticated_inbox") ? {...preparedInit,redirect:"error"} : preparedInit);
  if(kbPermit) {
    const s=permits.get(kbPermit)!;
    if(s.apiPolicy){
      if(!currentPermitEvidence(s) || Deno.env.get(s.authorizationKey)!==s.authorization)throw new ModelAccountingError("UAT_REMOTE_BOUND_UNVERIFIED");
      const bound=await bindRagApiResponse(response,s.apiPolicy);
      if(!currentPermitEvidence(s) || Deno.env.get(s.authorizationKey)!==s.authorization)throw new ModelAccountingError("UAT_REMOTE_BOUND_UNVERIFIED");
      if(mode==="authenticated_inbox" && bound.grounded && meta.legacyAuthority)inboxGrounded.set(meta.legacyAuthority,{authorization:s.authorization,expires:s.expires});
      return bound.response;
    }
    if(s.livePolicy){
      if(!currentPermitEvidence(s) || !s.liveSession || Deno.env.get(s.authorizationKey)!==s.authorization)throw new ModelAccountingError("UAT_REMOTE_BOUND_UNVERIFIED");
      const bound=await bindLiveMetadataResponse(response,s.liveSession,upstream,init.signal??undefined);
      if(!currentPermitEvidence(s) || Deno.env.get(s.authorizationKey)!==s.authorization)throw new ModelAccountingError("UAT_REMOTE_BOUND_UNVERIFIED");
      if(mode==="authenticated_inbox" && bound.ok && meta.legacyAuthority)inboxGrounded.set(meta.legacyAuthority,{authorization:s.authorization,expires:s.expires});
      return bound;
    }
    if(s.evidence) {
      if(!currentPermitEvidence(s) || !s.attestation || Deno.env.get(s.authorizationKey)!==s.authorization)throw new ModelAccountingError("UAT_REMOTE_BOUND_UNVERIFIED");
      const bound=await bindQueryEmbeddingResponse(response,s.attestation);
      if(mode==="authenticated_inbox" && bound.ok && meta.legacyAuthority)inboxGrounded.set(meta.legacyAuthority,{authorization:s.authorization,expires:Math.min(s.expires,s.attestation.expires*1000)});
      return bound;
    }
  }
  return response;
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
