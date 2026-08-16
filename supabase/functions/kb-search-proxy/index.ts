import {
  resolveKBEndpoint,
  resolveTenantScope,
  fetchKBRag,
  type KBResolvedScope,
} from "../_shared/kb-client.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);

// Helpers below only need Supabase query-builder access; keep their type
// structural so createClient schema inference (public vs generic) cannot conflict.
type QueryDbClient = {
  from: (relation: string) => any;
};
const MAX_QUERY_LENGTH = 500;
const MAX_TOP_K = 3;
const CONSOLE_ORIGINS = [
  "https://console-chat-hub.lovable.app",
  "https://id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app",
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": CONSOLE_ORIGINS.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
function jsonResponse(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...getCorsHeaders(req), "Content-Type": "application/json" } });
}
function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

type MembershipRow = { company_id: string; role: string };
async function loadEligibleMemberships(admin: QueryDbClient, userId: string): Promise<{ok:true;rows:MembershipRow[]}|{ok:false}> {
  const { data, error } = await admin.from("company_membership").select("company_id, role").eq("user_id", userId).eq("is_active", true);
  if (error) return { ok: false };
  return {
    ok: true,
    rows: (data ?? []).filter((r: {company_id?:unknown;role?:unknown}) => typeof r.company_id === "string" && typeof r.role === "string" && ALLOWED_ROLES.has(r.role)) as MembershipRow[],
  };
}
async function loadGlobalRoles(admin: QueryDbClient, userId: string): Promise<string[] | null> {
  const { data, error } = await admin.from("user_roles").select("role").eq("user_id", userId);
  if (error) return null;
  return (data ?? []).map((r: {role?:unknown}) => String(r.role ?? ""));
}
async function requireActiveCompany(admin: QueryDbClient, companyId: string): Promise<boolean | null> {
  const { data, error } = await admin.from("company").select("id, is_active").eq("id", companyId).maybeSingle();
  return error ? null : !!data && data.is_active === true;
}
function parseTenantMap(): Record<string, string> | null {
  const raw = Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON");
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out: Record<string,string> = {};
    for (const [k,v] of Object.entries(obj as Record<string,unknown>)) {
      if (!isUuid(k) || typeof v !== "string" || !v.trim()) return null;
      out[k] = v.trim();
    }
    return out;
  } catch { return null; }
}
async function resolveStandaloneScope(
  admin: QueryDbClient, userId: string, eligible: MembershipRow[],
): Promise<{ok:true;scope:KBResolvedScope}|{ok:false;status:number;error:string}> {
  const ids = [...new Set(eligible.map(r => r.company_id))];
  if (ids.length > 1) return { ok:false,status:409,error:"company_membership_ambiguous" };
  if (ids.length === 1) {
    const active = await requireActiveCompany(admin, ids[0]);
    if (active === null) return { ok:false,status:500,error:"kb_tenant_unresolved" };
    if (!active) return { ok:false,status:403,error:"company_inactive" };
    const map = parseTenantMap();
    if (map === null) return { ok:false,status:500,error:"kb_tenant_mapping_invalid" };
    const tenant = map[ids[0]];
    if (!tenant) return { ok:false,status:503,error:"kb_tenant_unresolved" };
    return { ok:true, scope:{mode:"canonical",aiCompanyId:ids[0],singaporeTenantId:tenant} };
  }

  // Standalone Knowledge Helper pre-activation: same actor contract as the
  // conversation-bound resolver. A fake company is never created.
  const roles = await loadGlobalRoles(admin, userId);
  if (!roles) return { ok:false,status:500,error:"role_lookup_failed" };
  if (!roles.some(r => ALLOWED_ROLES.has(r))) return { ok:false,status:403,error:"forbidden" };
  const { data: allMemberships, error: allErr } = await admin.from("company_membership").select("company_id, is_active").eq("user_id", userId);
  if (allErr) return { ok:false,status:500,error:"membership_lookup_failed" };
  if ((allMemberships ?? []).length > 0) return { ok:false,status:403,error:"not_a_member" };
  if (Deno.env.get("KB_PREACTIVATION_ENABLED") !== "true") return { ok:false,status:503,error:"kb_preactivation_disabled" };
  const tenant = Deno.env.get("KB_PREACTIVATION_TENANT_ID")?.trim();
  if (!tenant) return { ok:false,status:503,error:"kb_preactivation_config_missing" };
  return { ok:true, scope:{mode:"pre_activation",aiCompanyId:null,singaporeTenantId:tenant} };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("Origin") ?? "";
    if (!CONSOLE_ORIGINS.includes(origin)) return new Response(null,{status:403});
    return new Response(null,{headers:getCorsHeaders(req)});
  }
  if (req.method !== "POST") return jsonResponse({error:"method_not_allowed"},405,req);
  const requestOrigin = req.headers.get("Origin");
  if (requestOrigin && !CONSOLE_ORIGINS.includes(requestOrigin)) return new Response(JSON.stringify({error:"forbidden_origin"}),{status:403,headers:{"Content-Type":"application/json"}});

  try {
    const supabaseUrl=Deno.env.get("SUPABASE_URL"), anonKey=Deno.env.get("SUPABASE_ANON_KEY"), serviceRoleKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if(!supabaseUrl||!anonKey||!serviceRoleKey)return jsonResponse({error:"server_config_missing"},500,req);
    const auth=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:req.headers.get("Authorization")??""}}});
    const {data:{user},error:authErr}=await auth.auth.getUser();
    if(authErr||!user)return jsonResponse({error:"unauthorized"},401,req);
    const admin=createClient(supabaseUrl,serviceRoleKey);
    const roles=await loadGlobalRoles(admin,user.id);
    if(!roles)return jsonResponse({error:"role_lookup_failed"},500,req);
    if(!roles.some(r=>ALLOWED_ROLES.has(r)))return jsonResponse({error:"forbidden"},403,req);

    const membershipResult=await loadEligibleMemberships(admin,user.id);
    if(!membershipResult.ok)return jsonResponse({error:"tenant_authorization_failed"},500,req);
    const body=await req.json().catch(()=>({}));
    for(const forbidden of ["company_id","industry","language","tenant_id","workspace_id"]){
      if(body?.[forbidden]!==undefined)return jsonResponse({error:"invalid_request",detail:"tenant/company/industry/language/workspace scope must not be provided by client"},400,req);
    }
    const rawQuery=body?.query;
    if(typeof rawQuery!=="string")return jsonResponse({error:"invalid_request",detail:"query required"},400,req);
    const query=rawQuery.trim();
    if(!query)return jsonResponse({error:"invalid_request",detail:"query empty"},400,req);
    if(query.length>MAX_QUERY_LENGTH)return jsonResponse({error:"invalid_request",detail:"query too long (max 500)"},400,req);
    const topK=Math.max(1,Math.min(MAX_TOP_K,Number.parseInt(String(body?.top_k),10)||3));

    const rawConversationId=body?.conversation_id;
    let scope:KBResolvedScope; let conversationId:string|null=null;
    if(rawConversationId!==undefined&&rawConversationId!==null){
      if(!isUuid(rawConversationId))return jsonResponse({error:"invalid_request",detail:"invalid conversation_id"},400,req);
      conversationId=rawConversationId;
      const {data:conversation,error:convErr}=await admin.from("conversations").select("id").eq("id",conversationId).maybeSingle();
      if(convErr)return jsonResponse({error:"conversation_lookup_failed"},500,req);
      if(!conversation)return jsonResponse({error:"conversation_not_found"},404,req);
      const resolved=await resolveTenantScope(conversationId,{userId:user.id,allowPreActivation:true});
      if(!resolved.resolved)return jsonResponse({error:"kb_tenant_unresolved",detail:resolved.reason},503,req);
      scope=resolved.scope;
      if(scope.mode==="canonical"){
        if(!scope.aiCompanyId)return jsonResponse({error:"tenant_authorization_failed"},500,req);
        if(!membershipResult.rows.some(r=>r.company_id===scope.aiCompanyId))return jsonResponse({error:"forbidden_tenant_role"},403,req);
        const active=await requireActiveCompany(admin,scope.aiCompanyId);
        if(active===null)return jsonResponse({error:"tenant_authorization_failed"},500,req);
        if(!active)return jsonResponse({error:"forbidden_tenant"},403,req);
      }
    } else {
      const standalone=await resolveStandaloneScope(admin,user.id,membershipResult.rows);
      if(!standalone.ok)return jsonResponse({error:standalone.error},standalone.status,req);
      scope=standalone.scope;
    }

    const endpoint=resolveKBEndpoint();
    if(!endpoint)return jsonResponse({error:"kb_config_missing"},500,req);
    const result=await fetchKBRag({query,top_k:topK},scope,endpoint);
    if(!result.success){
      if(result.error_code==="KB_TIMEOUT")return jsonResponse({error:"kb_api_timeout"},504,req);
      console.error("[kb-search-proxy] KB API error",{code:result.error_code,scope_mode:scope.mode});
      return jsonResponse({error:"kb_api_error",detail:result.error_code},502,req);
    }
    const selectedDocumentId=result.llm_context?.selected_document_id??result.selected_document_id;
    if(selectedDocumentId&&result.citations.some(c=>c.document_id!==undefined&&c.document_id!==selectedDocumentId))return jsonResponse({error:"kb_contract_mismatch"},502,req);
    const policyEvidence=result.llm_context?.full_content_evidence?.filter(i=>i.source_type.toLowerCase().includes("policy")&&i.content.trim()).slice(0,3).map((i,index)=>({label:`Policy evidence ${index+1}`,content:i.content.slice(0,800),source_type:i.source_type.slice(0,40),document_id:i.document_id,...(i.chunk_id?{chunk_id:i.chunk_id}:{}),score:i.score}))??[];
    return jsonResponse({success:true,scope_mode:scope.mode,results:result.citations,llm_context:result.llm_context??null,meta:result.meta??null,selected_document_id:selectedDocumentId??null,policy_evidence:policyEvidence},200,req);
  } catch(e){
    console.error("[kb-search-proxy] unexpected error",(e as Error).name);
    return jsonResponse({error:"internal_error"},500,req);
  }
});
