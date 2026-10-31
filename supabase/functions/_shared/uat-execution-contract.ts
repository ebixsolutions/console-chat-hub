import { verifyOriginalPreview } from "./original-widget-preview.ts";
import { safeExecutionCode } from "./execution-failure.ts";
import { buildVertexEndpoint } from "./vertex-generation-config.ts";
/** Temporary synthetic UAT admission. Existing log persistence, not the deferred shared Guard. */
export const UAT_COMPANY = "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec";
// Second pre-existing lawful admin/company channel; never borrow the C3 authorization.
export const FRANKIE_DEMO_COMPANY = "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493";
export const FRANKIE_DEMO_REVISION = "c3-frankie-tenant-bounded-demo-v1";
export function isBoundedDemoCompany(company: string | null): boolean {
  return company === UAT_COMPANY || company === FRANKIE_DEMO_COMPANY;
}
export const UAT_REVISION = "c3-3322877-bounded-uat-r2";
export const UAT_MAX_INPUT = 20000;
export const UAT_MAX_OUTPUT = 8192;
export const UAT_THINKING = 1024;
export type Db = { from?: (table: string)=>any; rpc(name: string, args: Record<string, unknown>): PromiseLike<{data: any; error: any}> };
export type UatContext = { companyId: string | null; conversationId: string | null; operationId: string; provider: string; purpose: string; slot: string; attempt: number; request: string };
export class UatDenied extends Error { constructor(public code: string) { super(code); this.name = "UatDenied"; } }
export function uatRun(company: string | null): string | null {
  if (!isBoundedDemoCompany(company)) return null;
  const frankie = company === FRANKIE_DEMO_COMPANY;
  const runKey = frankie ? "FRANKIE_DEMO_UAT_RUN_ID" : "C3_TEMP_UAT_RUN_ID";
  const revisionKey = frankie ? "FRANKIE_DEMO_UAT_SOURCE_REVISION" : "C3_TEMP_UAT_SOURCE_REVISION";
  const expectedRevision = frankie ? FRANKIE_DEMO_REVISION : UAT_REVISION;
  const id = Deno.env.get(runKey);
  if (!id) throw new UatDenied("UAT_AUTHORIZATION_ABSENT");
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) || Deno.env.get(revisionKey) !== expectedRevision) throw new UatDenied("UAT_SOURCE_OR_RUN_DENIED");
  return id;
}
// Opaque server-only authority for the already existing authenticated KB pre-activation path.
// Never reconstructed from JSON/browser fields, and never usable for a company-bound UAT ticket.
const preactivation = new WeakMap<object,{conversation:string|null;tenant:string;expires:number}>();
export async function legacyPreactivationAuthority(db: {from:(table:string)=>any}, user: string, tenant: string, conversation: string|null): Promise<object> {
  if(Deno.env.get("KB_PREACTIVATION_ENABLED")!=="true" || tenant!==Deno.env.get("KB_PREACTIVATION_TENANT_ID")?.trim())throw new UatDenied("PREACTIVATION_SCOPE_DENIED");
  const memberships=await db.from("company_membership").select("company_id").eq("user_id",user);
  const roles=await db.from("user_roles").select("role").eq("user_id",user);
  if(memberships.error || roles.error || !Array.isArray(memberships.data) || memberships.data.length || !roles.data?.some((r:any)=>["admin","supervisor","agent"].includes(r.role)))throw new UatDenied("PREACTIVATION_ACTOR_DENIED");
  if(conversation){const ticket=await db.from("conversations").select("id,company_id").eq("id",conversation).maybeSingle();if(ticket.error || ticket.data?.id!==conversation || ticket.data.company_id!==null)throw new UatDenied("PREACTIVATION_TICKET_DENIED");}
  const token={};preactivation.set(token,{conversation,tenant,expires:Date.now()+60000});return token;
}
/** Opaque authenticated Inbox operation. Ticket provenance is not the actor's
 * execution authority. Mint only after getUser()/validateAgent(), then recheck
 * persisted roles/membership/ticket/channel at every dispatch. No browser flag
 * or serialized object can reconstruct this capability. Reading a human-owned
 * ticket never enables the automatic reply path or changes its human state. */
export type InboxOperation = "knowledge" | "policy" | "translate" | "grammar" | "suggest_reply" | "knowledge_helper" | "handoff_context";
export type InboxIdentity = {actor:string;company:string;conversation:string;channel:string;operation:InboxOperation;expires:number};
const inboxAuthorities = new WeakMap<object,InboxIdentity>();
export async function authenticatedInboxAuthority(db:Db,actor:string,company:string,conversation:string,operation:InboxOperation):Promise<object> {
  if(!["knowledge","policy","translate","grammar","suggest_reply","knowledge_helper","handoff_context"].includes(operation) || ![actor,company,conversation].every(v=>/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v)))throw new UatDenied("INBOX_AUTHORITY_DENIED");
  const token={},identity={actor,company,conversation,operation,channel:"",expires:Date.now()+120000};
  inboxAuthorities.set(token,identity);
  try {const checked=await authenticatedInboxIdentity(db,token,company,conversation);identity.channel=checked.channel;return token;}
  catch(error){inboxAuthorities.delete(token);throw error;}
}
export async function authenticatedInboxIdentity(db:Db,authority:object|undefined,company:string|null,conversation:string|null):Promise<InboxIdentity> {
  const a=authority && inboxAuthorities.get(authority);
  if(!a || a.expires<=Date.now() || a.company!==company || a.conversation!==conversation || !db.from)throw new UatDenied("INBOX_AUTHORITY_DENIED");
  // These reads share no data dependency. Read once per validation boundary,
  // retaining a fresh complete validation after remote preparation.
  const [roles,membership,owner,ticket] = await Promise.all([
    a.operation==="knowledge" ? db.from("user_roles").select("role").eq("user_id",a.actor) : Promise.resolve({data:[],error:null}),
    db.from("company_membership").select("company_id,role,is_active").eq("user_id",a.actor).eq("company_id",a.company).eq("is_active",true).maybeSingle(),
    db.from("company").select("id,is_active").eq("id",a.company).maybeSingle(),
    db.from("conversations").select("id,company_id,channel_config_id,visitor_session_id,metadata_source,status,assigned_agent_id").eq("id",a.conversation).eq("company_id",a.company).maybeSingle(),
  ]);
  if((a.operation==="knowledge" && (roles.error || !roles.data?.some((r:any)=>["admin","supervisor"].includes(r.role)))) || membership.error || membership.data?.is_active!==true || !["admin","supervisor","agent"].includes(membership.data.role) || owner.error || owner.data?.is_active!==true || ticket.error || ticket.data?.id!==a.conversation || ticket.data.company_id!==a.company)throw new UatDenied("INBOX_AUTHORITY_DENIED");
  const c=ticket.data,m=c.metadata_source;
  const elevated=["admin","supervisor"].includes(membership.data.role);
  // Knowledge retains its original global-role + Company-role checks. Agent
  // tools retain validateAgent's active profile + canonical Company-role model;
  // a global user_roles row is not an extra prerequisite for an assigned Agent.
  if(a.operation==="knowledge" && !elevated)throw new UatDenied("INBOX_AUTHORITY_DENIED");
  if(a.operation!=="knowledge") {
    const agent=await db.from("agent_profile").select("id,status").eq("user_id",a.actor).maybeSingle();
    if(agent.error || !agent.data?.id || agent.data.status!=="active" || !elevated && (a.operation!=="policy" || membership.data.role!=="agent" || c.assigned_agent_id!==agent.data.id))throw new UatDenied("INBOX_AUTHORITY_DENIED");
  }
  if(m?.synthetic===true || m?.source==="c3_uat_widget")throw new UatDenied("INBOX_SYNTHETIC_SCOPE_DENIED");
  if((m?.widget_live_test===true || m?.source==="widget_live_test") && !await verifyOriginalPreview(db,c,undefined,false))throw new UatDenied("INBOX_AUTHORITY_DENIED");
  const channel=await db.from("channel_config").select("id,company_id,is_active").eq("id",c.channel_config_id).eq("company_id",a.company).maybeSingle();
  if(channel.error || channel.data?.id!==c.channel_config_id || channel.data.company_id!==a.company || channel.data.is_active!==true || a.channel && a.channel!==c.channel_config_id)throw new UatDenied("INBOX_AUTHORITY_DENIED");
  return {...a,channel:c.channel_config_id};
}
/** Identity comes from service-side persistence and existing authenticated caller scopes.
 * The fixed Director synthetic company never falls through to legacy dispatch.
 * A request body flag, tenant UUID or missing lease cannot grant UAT privileges. */
export async function trustedDispatchScope(db: Db, company: string | null, conversation: string | null, authority?: object, onInboxIdentity?: (identity: InboxIdentity)=>void): Promise<"legacy" | "uat" | "authenticated_preview" | "authenticated_inbox"> {
  if(authority && inboxAuthorities.has(authority)){const identity=await authenticatedInboxIdentity(db,authority,company,conversation);onInboxIdentity?.(identity);return "authenticated_inbox";}
  if(company===null && authority){const grant=preactivation.get(authority);if(grant && grant.conversation===conversation && grant.expires>Date.now() && Deno.env.get("KB_PREACTIVATION_ENABLED")==="true" && grant.tenant===Deno.env.get("KB_PREACTIVATION_TENANT_ID")?.trim()){if(conversation){if(!db.from)throw new UatDenied("PREACTIVATION_TICKET_DENIED");const ticket=await db.from("conversations").select("id,company_id").eq("id",conversation).maybeSingle();if(ticket.error || ticket.data?.id!==conversation || ticket.data.company_id!==null)throw new UatDenied("PREACTIVATION_TICKET_DENIED");}return "legacy";}throw new UatDenied("PREACTIVATION_AUTHORITY_DENIED");}
  if(authority)throw new UatDenied("INBOX_AUTHORITY_DENIED");
  if (!company || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(company) || !db.from) throw new UatDenied("DISPATCH_COMPANY_UNPROVEN");
  try {
    const owner = await db.from("company").select("id").eq("id", company).maybeSingle();
    if (owner.error || owner.data?.id !== company) throw new UatDenied("DISPATCH_COMPANY_UNPROVEN");
    if (conversation) {
      const ticket = await db.from("conversations").select("id,company_id").eq("id", conversation).maybeSingle();
      if (ticket.error || ticket.data?.id !== conversation || ticket.data?.company_id !== company) throw new UatDenied("DISPATCH_TENANT_MISMATCH");
    }
  } catch (error) { throw error instanceof UatDenied ? error : new UatDenied("DISPATCH_IDENTITY_UNAVAILABLE"); }
  if (conversation && (company === UAT_COMPANY || company === FRANKIE_DEMO_COMPANY)) {
    const ticket=await db.from("conversations").select("id,company_id,channel_config_id,visitor_session_id,metadata_source").eq("id",conversation).eq("company_id",company).maybeSingle();
    if(ticket.error || !ticket.data)throw new UatDenied("DISPATCH_IDENTITY_UNAVAILABLE");
    if(ticket.data.metadata_source?.execution_class === "authenticated_admin_preview") {
      if(await verifyOriginalPreview(db,ticket.data)) return "authenticated_preview";
      throw new UatDenied("UAT_AUTHORIZATION_DENIED");
    }
  }
  if (company === UAT_COMPANY) { if (!conversation) throw new UatDenied("UAT_CONVERSATION_REQUIRED"); uatRun(company); return "uat"; }
  if (company === FRANKIE_DEMO_COMPANY && conversation) {
    // Only the authenticated, tagged synthetic preview enters bounded admission.
    // Existing ordinary Frankie customer/agent conversations stay on their
    // established Production path without a new accounting prerequisite.
    const ticket = await db.from("conversations").select("metadata_source")
      .eq("id", conversation).eq("company_id", company).maybeSingle();
    if (ticket.error || !ticket.data) throw new UatDenied("DISPATCH_IDENTITY_UNAVAILABLE");
    const source = ticket.data.metadata_source;
    if (source?.source === "c3_uat_widget" || source?.source === "widget_live_test" ||
        source?.synthetic === true || source?.widget_live_test === true) {
      if (source?.source !== "c3_uat_widget" || source?.synthetic !== true || source?.exclude_training !== true ||
          typeof source?.owner_user_id !== "string") throw new UatDenied("UAT_AUTHORIZATION_DENIED");
      uatRun(company);
      return "uat";
    }
  }
  return "legacy";
}
const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b=>b.toString(16).padStart(2,"0")).join("");
async function rpc(db: Db, name: string, args: Record<string, unknown>) {
  let r;
  try { r = await db.rpc(name, args); } catch { throw new UatDenied("UAT_PERSISTENCE_UNAVAILABLE"); }
  if (r.error) {
    if (["PGRST202", "42883"].includes(r.error.code)) throw new UatDenied("UAT_DEPENDENCY_MISSING");
    // Only an exact closed SQL exception label is safe to propagate.
    throw new UatDenied(safeExecutionCode(r.error.message) ?? "UAT_ADMISSION_DENIED");
  }
  if (!r.data) throw new UatDenied("UAT_ADMISSION_DENIED");
  return r.data;
}
/** Must persist a denial/pause for unknown in-flight outcomes; never refund reservations. */
export async function uatFetch(db: Db, meta: UatContext, url: string, init: RequestInit, upstream: typeof fetch = fetch, onDispatch?: ()=>void): Promise<Response> {
  const run = uatRun(meta.companyId);
  if (!run || !meta.conversationId || !meta.operationId || meta.operationId.length>240 || meta.slot.length>120 || meta.slot.startsWith("countTokens:") || !Number.isInteger(meta.attempt) || meta.attempt<1 || meta.attempt>3 || init.method!=="POST" || String(init.body)!==meta.request) throw new UatDenied("UAT_SCOPE_DENIED");
  // Every external call, including countTokens, owns a durable admission before dispatch.
  const admit = async (slot: string, callUrl: string, request: string, input: number, output: number, model: string, cost: number) => {
    const key=await digest(JSON.stringify([meta.operationId,slot,meta.attempt,meta.provider]));
    const receipt=await rpc(db,"c3_uat_reserve_dispatch",{p_run_id:run,p_revision:meta.companyId === FRANKIE_DEMO_COMPANY ? FRANKIE_DEMO_REVISION : UAT_REVISION,p_company_id:meta.companyId,p_conversation_id:meta.conversationId,p_operation:meta.operationId,p_slot:slot,p_identity:key,p_request_hash:await digest(JSON.stringify([callUrl,request])),p_provider:meta.provider,p_purpose:meta.purpose,p_model:model,p_attempt:meta.attempt,p_input_ceiling:input,p_output_ceiling:output,p_cost_microusd:cost});
    if (receipt.dispatch!==true || receipt.run_id!==run || receipt.identity!==key || receipt.state!=="reserved" || !Number.isFinite(receipt.expires_epoch) || Date.now()/1000>=receipt.expires_epoch) throw new UatDenied("UAT_REPLAY_OR_RECEIPT_DENIED");
    return async(state:string,status:number,input:number|null,output:number|null)=>{
      const result=await rpc(db,"c3_uat_finalize_dispatch",{p_run_id:run,p_company_id:meta.companyId,p_identity:key,p_state:state,p_status:status,p_input:input,p_output:output});
      if(result.state!==state)throw new UatDenied("UAT_FINALIZATION_DENIED");
    };
  };
  const body = JSON.parse(meta.request);
  const remote = meta.provider === "singapore-kb";
  let inputCeiling = UAT_MAX_INPUT, outputCeiling = 0, model = "gemini-embedding-001", cost = 100000;
  if (remote) {
    if (url!=="https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search" || meta.purpose!=="kb_embedding" || typeof body.query!=="string" || new TextEncoder().encode(body.query).length>2048 || Object.keys(body).some(k=>!["query","company_id","candidate_top_k","max_documents","max_summary_chunks","max_full_content_chunks","score_threshold"].includes(k))) throw new UatDenied("UAT_REMOTE_SCOPE_DENIED");
    inputCeiling = 2048;
  } else {
    const u=new URL(url);
    const project=Deno.env.get("GOOGLE_PROJECT_ID")?.trim(), region=Deno.env.get("GOOGLE_REGION")?.trim();
    let expectedEndpoint = "";
    try { if (project && region) expectedEndpoint = buildVertexEndpoint(project, region, "gemini-2.5-flash"); } catch { /* Invalid server configuration remains denied. */ }
    if (!expectedEndpoint || u.href !== expectedEndpoint || meta.provider!=="vertex" || !["generation","evaluation","assist"].includes(meta.purpose)) throw new UatDenied("UAT_PROVIDER_DENIED");
    if (new TextEncoder().encode(meta.request).length>80000 || body.tools || body.cachedContent || body.contents?.some((c:any)=>c.parts?.some((p:any)=>Object.keys(p).some(k=>k!=="text"))) || !Number.isInteger(body.generationConfig?.maxOutputTokens) || body.generationConfig.maxOutputTokens<1 || body.generationConfig.maxOutputTokens>UAT_MAX_OUTPUT || body.generationConfig?.thinkingConfig?.thinkingBudget!==UAT_THINKING) throw new UatDenied("UAT_TOKEN_EXPOSURE_DENIED");
    // CountTokens is pre-inference. Any failure denies before generateContent.
    const countRequest={contents:[...(body.contents ?? []),{role:"user",parts:[...(body.systemInstruction?.parts ?? []),{text:JSON.stringify(body.generationConfig?.responseSchema ?? {})}]}]};
    const countUrl=url.replace(/:generateContent$/,":countTokens"), countBody=JSON.stringify(countRequest);
    const countedFinish=await admit("countTokens:"+await digest(meta.slot),countUrl,countBody,UAT_MAX_INPUT,0,"gemini-2.5-flash",Math.ceil(UAT_MAX_INPUT*0.30));
    let counted:Response;
    try { counted=await upstream(countUrl,{method:"POST",headers:init.headers,body:countBody,redirect:"error",signal:init.signal}); }
    catch(error){await countedFinish("unknown",0,null,null);throw new UatDenied(error instanceof Error && error.name==="AbortError"?"UAT_TIMEOUT_OUTCOME_UNKNOWN":"UAT_NETWORK_OUTCOME_UNKNOWN");}
    let count:unknown;
    try {if(counted.ok)count=(await counted.json()).totalTokens;}catch { /* Missing observation retains its reservation. */ }
    if (!counted.ok || typeof count!=="number" || !Number.isInteger(count) || count<1 || count>UAT_MAX_INPUT-1024) {
      await countedFinish("unknown",counted.status,null,null);throw new UatDenied("UAT_TOKEN_COUNT_UNAVAILABLE");
    }
    await countedFinish("response",counted.status,count,0);
    // Reserve the full input ceiling + output AND thinking ceilings, not average spend.
    outputCeiling=body.generationConfig.maxOutputTokens+UAT_THINKING;
    model="gemini-2.5-flash";
    cost=Math.ceil(UAT_MAX_INPUT*0.30+outputCeiling*2.50);
  }
  const finish=await admit(meta.slot,url,meta.request,inputCeiling,outputCeiling,model,cost);
  let response:Response;
  try {onDispatch?.();response=await upstream(url,{...init,redirect:"error"});}
  catch(e){await finish("unknown",0,null,null);throw new UatDenied(e instanceof Error && e.name === "AbortError" ? "UAT_TIMEOUT_OUTCOME_UNKNOWN" : "UAT_NETWORK_OUTCOME_UNKNOWN");}
  if(remote){
    // Remote attempt/cost exposure is a retained bound, never a fabricated observed token count.
    await finish("remote_bound",response.status,null,null);
    return response;
  }
  if(!response.ok){await finish("unknown",response.status,null,null);throw new UatDenied("UAT_PROVIDER_OUTCOME_UNKNOWN");}
  let usage:any;
  try{usage=(await response.clone().json()).usageMetadata;}catch{}
  const input=usage?.promptTokenCount, output=(usage?.candidatesTokenCount??0)+(usage?.thoughtsTokenCount??0);
  if(!Number.isInteger(input) || input<0 || !Number.isInteger(usage?.candidatesTokenCount) || !Number.isInteger(output) || output<0 || input>inputCeiling || output>outputCeiling){await finish("unknown",response.status,null,null);throw new UatDenied("UAT_USAGE_UNOBSERVABLE_OR_OVER_LIMIT");}
  await finish("response",response.status,input,output);
  return response;
}

/** One in-flight synthetic dispatch; production retains its existing concurrency. */
export async function uatMap<T>(company: string | null, tasks: Array<()=>Promise<T>>): Promise<T[]> {
  // Keep legitimate Frankie Production requests unchanged. Synthetic
  // Frankie traffic still requires atomic per-dispatch admission in uatFetch.
  if (company === FRANKIE_DEMO_COMPANY || !uatRun(company))
    return await Promise.all(tasks.map(task=>task()));
  const results:T[]=[]; for(const task of tasks)results.push(await task()); return results;
}
