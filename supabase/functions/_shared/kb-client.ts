// supabase/functions/_shared/kb-client.ts
// PR27 Task 1 — canonical Singapore KB adapter + secure pre-activation scope.
//
// Frozen rules:
// - Canonical company identity always wins.
// - Pre-activation never creates/fabricates company_id and is available only
//   for an authenticated Admin/Supervisor with ZERO company_membership rows.
// - Browser request bodies never choose tenant/company scope.
// - Singapore tenant is server-only configuration.
// - Demo scope is separate and is never used as production/pre-activation fallback.
// - Opaque company-specific API keys / JWTs / tokens / raw upstream payloads are never returned to the browser.
// - Preferred production auth is a server-only Singapore tenant -> API key map.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  resolveSingaporeCredential,
  singaporeCredentialHeaders,
  type KBAuthHeaderMode,
} from "./kb-auth.ts";

export interface KBQueryInput { query: string; top_k: number }
export type KBScopeMode = "canonical" | "pre_activation" | "demo";
export interface KBResolvedScope {
  mode: KBScopeMode;
  aiCompanyId: string | null;
  singaporeTenantId: string;
}
export interface KBFullChunk {
  document_id: string; doc_id?: string; chunk_id?: string; title?: string;
  content: string; score: number; chunk_type: "rag_summary" | "full_content";
  source_type: string; status: "published";
}
export interface KBCitationChunk {
  display_label: string; content: string; score: number; source_type: string;
  document_id?: string; chunk_id?: string; chunk_type?: string;
}
export interface KBLLMContextEvidence {
  document_id: string; chunk_id?: string; content: string; score: number; source_type: string;
}
export interface KBLLMContext {
  selected_document_id: string; orientation_summary: string | null;
  full_content_evidence: KBLLMContextEvidence[];
}
export interface KBRagMeta {
  document_score: number; highest_chunk_score: number; second_highest_chunk_score: number;
  returned_summary_count: number; returned_full_content_count: number;
  dropped_without_document_id: number; dropped_without_content: number;
}
export interface KBRagResponse {
  success: boolean; chunks: KBFullChunk[]; citations: KBCitationChunk[];
  llm_context?: KBLLMContext; meta?: KBRagMeta; selected_document_id?: string;
  dropped_without_document_id?: number; dropped_without_content?: number; error_code?: string;
}
export interface KBEndpointConfig {
  baseUrl: string; ragUrl: string; signingSecret?: string; jwtTtlSec: number;
  defaultToken?: string; tenantTokens: Record<string, string>;
  tenantApiKeys: Record<string, string>;
  apiKeyHeaderMode: KBAuthHeaderMode;
}
export interface KBPreActivationActor {
  userId: string;
  /** Must be explicitly enabled by the authenticated server caller. */
  allowPreActivation: true;
}

const SINGAPORE_KB_DEFAULT_BASE_URL = "https://py.ebixmall.com/py-knowledge-base";
const SINGAPORE_RAG_PATH = "/api/v1/rag/context-search";
const KB_DEFAULT_TIMEOUT_MS = 12000;
const PREACTIVATION_ROLES = new Set(["admin", "supervisor"]);

// Narrow structural type for helpers that only need Supabase query-builder access.
// Avoids coupling helper signatures to createClient's inferred schema generics.
type QueryDbClient = {
  from: (relation: string) => any;
};

function normalizeBaseUrl(raw: string): { baseUrl: string; ragUrl: string } | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocal) return null;
  } catch { return null; }
  if (value.endsWith(SINGAPORE_RAG_PATH)) {
    return { baseUrl: value.slice(0, -SINGAPORE_RAG_PATH.length), ragUrl: value };
  }
  return { baseUrl: value, ragUrl: `${value}${SINGAPORE_RAG_PATH}` };
}

function parseStringMapEnv(name: string): Record<string, string> | null {
  const raw = Deno.env.get(name);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" || !key.trim() || !value.trim()) return null;
      out[key.trim()] = value.trim();
    }
    return out;
  } catch { return null; }
}

export function resolveKBEndpoint(): KBEndpointConfig | null {
  const configured = Deno.env.get("KB_RAG_ENDPOINT") ?? Deno.env.get("KB_RAG_BASE_URL") ?? SINGAPORE_KB_DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(configured);
  if (!normalized) return null;

  const tenantTokens = parseStringMapEnv("KB_RAG_TENANT_TOKENS_JSON");
  const tenantApiKeys = parseStringMapEnv("KB_SINGAPORE_TENANT_API_KEYS_JSON");
  if (tenantTokens === null || tenantApiKeys === null) return null;

  const headerRaw = (Deno.env.get("KB_SINGAPORE_API_KEY_HEADER") ?? "authorization")
    .trim().toLowerCase();
  if (headerRaw !== "authorization" && headerRaw !== "x-api-key") return null;
  const apiKeyHeaderMode = headerRaw as KBAuthHeaderMode;

  const signingSecret = Deno.env.get("KB_SINGAPORE_JWT_SECRET")?.trim() || undefined;
  const ttlRaw = Number.parseInt(Deno.env.get("KB_SINGAPORE_JWT_TTL_SEC") ?? "300", 10);
  const jwtTtlSec = Number.isInteger(ttlRaw) && ttlRaw >= 60 && ttlRaw <= 900 ? ttlRaw : 300;
  const defaultToken = Deno.env.get("KB_RAG_TOKEN")?.trim() || undefined;

  return {
    ...normalized,
    signingSecret,
    jwtTtlSec,
    defaultToken,
    tenantTokens,
    tenantApiKeys,
    apiKeyHeaderMode,
  };
}

export type TenantResolutionReason =
  | "KB_DB_CONFIG_MISSING" | "KB_CONVERSATION_LOOKUP_FAILED" | "KB_CONVERSATION_NOT_FOUND"
  | "KB_TENANT_MAPPING_CONFIG_INVALID" | "KB_TENANT_MAPPING_UNRESOLVED"
  | "KB_TENANT_IDENTITY_CONFLICT" | "KB_DEMO_DISABLED" | "KB_DEMO_CONFIG_MISSING"
  | "KB_PREACTIVATION_DISABLED" | "KB_PREACTIVATION_CONFIG_MISSING"
  | "KB_PREACTIVATION_MEMBERSHIP_PRESENT" | "KB_PREACTIVATION_ROLE_LOOKUP_FAILED"
  | "KB_PREACTIVATION_ROLE_FORBIDDEN";
export type TenantResolutionResult =
  | { resolved: true; scope: KBResolvedScope }
  | { resolved: false; reason: TenantResolutionReason };

async function resolvePreActivationScope(
  sb: QueryDbClient, actor: KBPreActivationActor | undefined,
): Promise<TenantResolutionResult> {
  if (!actor?.allowPreActivation) return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
  if (Deno.env.get("KB_PREACTIVATION_ENABLED") !== "true") {
    return { resolved: false, reason: "KB_PREACTIVATION_DISABLED" };
  }
  const tenantId = Deno.env.get("KB_PREACTIVATION_TENANT_ID")?.trim();
  if (!tenantId) return { resolved: false, reason: "KB_PREACTIVATION_CONFIG_MISSING" };

  // IMPORTANT: query ALL membership rows, not only active ones. Any canonical
  // identity history prevents fallback to pre-activation.
  const { data: memberships, error: membershipError } = await sb
    .from("company_membership").select("company_id, is_active").eq("user_id", actor.userId);
  if (membershipError) return { resolved: false, reason: "KB_PREACTIVATION_ROLE_LOOKUP_FAILED" };
  if ((memberships ?? []).length > 0) {
    return { resolved: false, reason: "KB_PREACTIVATION_MEMBERSHIP_PRESENT" };
  }

  const { data: roles, error: roleError } = await sb
    .from("user_roles").select("role").eq("user_id", actor.userId);
  if (roleError) return { resolved: false, reason: "KB_PREACTIVATION_ROLE_LOOKUP_FAILED" };
  const allowed = (roles ?? []).some((row: { role?: unknown }) => PREACTIVATION_ROLES.has(String(row.role ?? "")));
  if (!allowed) return { resolved: false, reason: "KB_PREACTIVATION_ROLE_FORBIDDEN" };

  return { resolved: true, scope: { mode: "pre_activation", aiCompanyId: null, singaporeTenantId: tenantId } };
}

export async function resolveTenantScope(
  conversationId: string | null,
  actor?: KBPreActivationActor,
): Promise<TenantResolutionResult> {
  if (conversationId) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) return { resolved: false, reason: "KB_DB_CONFIG_MISSING" };
    const sb = createClient(supabaseUrl, serviceRoleKey);
    const { data: conv, error: convErr } = await sb
      .from("conversations").select("company_id, channel_config_id").eq("id", conversationId).maybeSingle();
    if (convErr) return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    if (!conv) return { resolved: false, reason: "KB_CONVERSATION_NOT_FOUND" };

    let channelCompanyId: string | null = null;
    if (conv.channel_config_id) {
      const { data: channel, error: channelErr } = await sb
        .from("channel_config").select("company_id").eq("id", conv.channel_config_id).maybeSingle();
      if (channelErr) return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
      channelCompanyId = channel?.company_id ? String(channel.company_id) : null;
    }
    const conversationCompanyId = conv.company_id ? String(conv.company_id) : null;
    if (conversationCompanyId && channelCompanyId && conversationCompanyId !== channelCompanyId) {
      return { resolved: false, reason: "KB_TENANT_IDENTITY_CONFLICT" };
    }
    const resolvedCompanyId = conversationCompanyId ?? channelCompanyId;

    // Canonical ALWAYS wins. Pre-activation is considered only when both
    // conversation and channel identity are genuinely absent.
    if (!resolvedCompanyId) return await resolvePreActivationScope(sb, actor);

    const { data: company, error: companyErr } = await sb
      .from("company").select("id, is_active").eq("id", resolvedCompanyId).maybeSingle();
    if (companyErr) return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    if (!company || company.is_active !== true) return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    const tenantMap = parseStringMapEnv("KB_SINGAPORE_TENANT_MAP_JSON");
    if (tenantMap === null) return { resolved: false, reason: "KB_TENANT_MAPPING_CONFIG_INVALID" };
    const singaporeTenantId = tenantMap[String(company.id)]?.trim();
    if (!singaporeTenantId) return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    return { resolved: true, scope: { mode: "canonical", aiCompanyId: String(company.id), singaporeTenantId } };
  }

  // Demo is an explicit non-production mode and remains completely separate
  // from pre-activation.
  if (Deno.env.get("KB_DEMO_MODE") !== "true") return { resolved: false, reason: "KB_DEMO_DISABLED" };
  const tenantId = Deno.env.get("KB_DEMO_TENANT_ID")?.trim();
  if (!tenantId) return { resolved: false, reason: "KB_DEMO_CONFIG_MISSING" };
  return { resolved: true, scope: { mode: "demo", aiCompanyId: null, singaporeTenantId: tenantId } };
}

interface SingaporeCitation { document_id?:unknown; document_title?:unknown; chunk_id?:unknown; chunk_type?:unknown; score?:unknown; label?:unknown }
interface SingaporeDocument { document_id?:unknown; doc_score?:unknown; chunk_count?:unknown }
interface SingaporeDocumentMetadata { id?:unknown; name?:unknown; source_type?:unknown; knowledge_type?:unknown; status?:unknown; production_status?:unknown; available_to_live_console?:unknown; is_outdated?:unknown }
function parseSingaporeContext(raw: string): { summaries:string[]; evidence:string[] } {
  const summaries:string[]=[]; const evidence:string[]=[]; let kind:"summary"|"evidence"|null=null; let current:string[]=[];
  const flush=()=>{const text=current.join("\n").trim(); if(text){if(kind==="summary") summaries.push(text); if(kind==="evidence") evidence.push(text);} current=[];};
  for(const line of raw.split(/\r?\n/)){const s=line.match(/^\[summary\]\s*(.*)$/i); if(s){flush();kind="summary";current.push(s[1]??"");continue;} const e=line.match(/^\[evidence\]\s*(.*)$/i); if(e){flush();kind="evidence";current.push(e[1]??"");continue;} if(kind)current.push(line);} flush(); return {summaries,evidence};
}
function asFiniteNumber(value: unknown): number | null { const n=typeof value==="number"?value:Number(value); return Number.isFinite(n)?n:null; }
async function fetchSelectedDocumentMetadata(cfg:KBEndpointConfig,authHeaders:Record<string,string>,documentId:string,signal:AbortSignal):Promise<{ok:true;data:SingaporeDocumentMetadata}|{ok:false;error_code:string}>{
  let response:Response; try{response=await fetch(`${cfg.baseUrl}/api/entities/KBDocument/${encodeURIComponent(documentId)}`,{method:"GET",headers:authHeaders,signal});}catch(err){return {ok:false,error_code:err instanceof DOMException&&err.name==="AbortError"?"KB_TIMEOUT":"KB_DOCUMENT_METADATA_FETCH_ERROR"};}
  if(!response.ok)return {ok:false,error_code:`KB_DOCUMENT_METADATA_HTTP_${response.status}`}; let data:unknown; try{data=await response.json();}catch{return {ok:false,error_code:"KB_DOCUMENT_METADATA_INVALID_JSON"};}
  if(!data||typeof data!=="object"||Array.isArray(data))return {ok:false,error_code:"KB_DOCUMENT_METADATA_SCHEMA_INVALID"}; return {ok:true,data:data as SingaporeDocumentMetadata};
}

export async function fetchKBRag(queryInput:KBQueryInput,scope:KBResolvedScope,endpointCfg:KBEndpointConfig,opts?:{timeoutMs?:number}):Promise<KBRagResponse>{
  const query=queryInput.query.trim(); if(!query)return {success:true,chunks:[],citations:[]};
  const credential=await resolveSingaporeCredential(scope,endpointCfg); if(!credential.ok)return {success:false,chunks:[],citations:[],error_code:credential.error_code};
  const authHeaders=singaporeCredentialHeaders(credential,endpointCfg);
  const controller=new AbortController(); const timeout=setTimeout(()=>controller.abort(),opts?.timeoutMs??KB_DEFAULT_TIMEOUT_MS); let response:Response;
  try{response=await fetch(endpointCfg.ragUrl,{method:"POST",headers:{"Content-Type":"application/json",...authHeaders},body:JSON.stringify({query,top_k:Math.max(queryInput.top_k,12),score_threshold:0.05,max_documents:1,max_summary:1,max_full_chunks:3}),signal:controller.signal});}
  catch(err){clearTimeout(timeout);return {success:false,chunks:[],citations:[],error_code:err instanceof DOMException&&err.name==="AbortError"?"KB_TIMEOUT":"KB_FETCH_ERROR"};}
  if(!response.ok){clearTimeout(timeout);return {success:false,chunks:[],citations:[],error_code:`KB_HTTP_${response.status}`};}
  let data:unknown; try{data=await response.json();}catch{clearTimeout(timeout);return {success:false,chunks:[],citations:[],error_code:"KB_INVALID_JSON"};}
  if(!data||typeof data!=="object"||Array.isArray(data)){clearTimeout(timeout);return {success:false,chunks:[],citations:[],error_code:"KB_SCHEMA_INVALID"};}
  const d=data as Record<string,unknown>; if(typeof d.has_context!=="boolean"||typeof d.reason!=="string"){clearTimeout(timeout);return {success:false,chunks:[],citations:[],error_code:"KB_SCHEMA_INVALID"};}
  if(d.has_context===false){clearTimeout(timeout);if(!Array.isArray(d.citations)||!Array.isArray(d.documents))return {success:false,chunks:[],citations:[],error_code:"KB_SCHEMA_INVALID"};return {success:true,chunks:[],citations:[]};}
  if(d.reason!=="ok"||typeof d.llm_context!=="string"||!Array.isArray(d.citations)||!Array.isArray(d.documents)){clearTimeout(timeout);return {success:false,chunks:[],citations:[],error_code:"KB_SCHEMA_INVALID"};}
  const upstreamCitations=d.citations as SingaporeCitation[]; const upstreamDocuments=d.documents as SingaporeDocument[];
  const selectedDocumentId=typeof upstreamDocuments[0]?.document_id==="string"?upstreamDocuments[0].document_id:typeof upstreamCitations[0]?.document_id==="string"?upstreamCitations[0].document_id:null;
  if(!selectedDocumentId){clearTimeout(timeout);return {success:false,chunks:[],citations:[],error_code:"KB_SCHEMA_INVALID"};}
  if(upstreamCitations.some(c=>typeof c.document_id==="string"&&c.document_id!==selectedDocumentId)){clearTimeout(timeout);return {success:false,chunks:[],citations:[],error_code:"KB_CROSS_DOCUMENT_MISMATCH"};}
  const metadata=await fetchSelectedDocumentMetadata(endpointCfg,authHeaders,selectedDocumentId,controller.signal); clearTimeout(timeout); if(!metadata.ok)return {success:false,chunks:[],citations:[],error_code:metadata.error_code};
  const doc=metadata.data; if(String(doc.id??"")!==selectedDocumentId)return {success:false,chunks:[],citations:[],error_code:"KB_DOCUMENT_METADATA_MISMATCH"};
  if(doc.status!=="published"||doc.production_status!=="production"||doc.available_to_live_console!==true||doc.is_outdated===true)return {success:false,chunks:[],citations:[],error_code:"KB_DOCUMENT_NOT_LIVE"};
  const sourceType=typeof doc.source_type==="string"&&doc.source_type.trim()?doc.source_type.trim():typeof doc.knowledge_type==="string"&&doc.knowledge_type.trim()?doc.knowledge_type.trim():"unknown";
  const title=typeof doc.name==="string"&&doc.name.trim()?doc.name.trim().slice(0,200):"KB document"; const parsed=parseSingaporeContext(d.llm_context);
  const orientationSummary=parsed.summaries[0]??null; const chunks:KBFullChunk[]=[]; const citations:KBCitationChunk[]=[];
  const docScore=asFiniteNumber(upstreamDocuments[0]?.doc_score)??0; const scores=upstreamCitations.map(c=>asFiniteNumber(c.score)).filter((n):n is number=>n!==null).sort((a,b)=>b-a);
  if(orientationSummary){const score=scores[0]??docScore;chunks.push({document_id:selectedDocumentId,doc_id:selectedDocumentId,title,content:orientationSummary,score,chunk_type:"rag_summary",source_type:sourceType,status:"published"});citations.push({display_label:title,content:orientationSummary.slice(0,500),score,source_type:sourceType,document_id:selectedDocumentId,chunk_type:"rag_summary"});}
  let droppedWithoutContent=0,droppedWithoutDocumentId=0; const fullEvidence:KBLLMContextEvidence[]=[];
  for(let i=0;i<upstreamCitations.length&&fullEvidence.length<3;i++){const c=upstreamCitations[i];if(c.chunk_type!=="full_content")continue;if(c.document_id!==selectedDocumentId){droppedWithoutDocumentId++;continue;}const content=parsed.evidence[i]?.trim()??"";if(!content){droppedWithoutContent++;continue;}const score=asFiniteNumber(c.score)??0;const chunkId=typeof c.chunk_id==="string"?c.chunk_id:undefined;chunks.push({document_id:selectedDocumentId,doc_id:selectedDocumentId,...(chunkId?{chunk_id:chunkId}:{}),title,content,score,chunk_type:"full_content",source_type:sourceType,status:"published"});fullEvidence.push({document_id:selectedDocumentId,...(chunkId?{chunk_id:chunkId}:{}),content,score,source_type:sourceType});citations.push({display_label:title,content:content.slice(0,500),score,source_type:sourceType,document_id:selectedDocumentId,...(chunkId?{chunk_id:chunkId}:{}),chunk_type:"full_content"});}
  const llm_context:KBLLMContext={selected_document_id:selectedDocumentId,orientation_summary:orientationSummary,full_content_evidence:fullEvidence};
  const meta:KBRagMeta={document_score:docScore,highest_chunk_score:scores[0]??0,second_highest_chunk_score:scores[1]??0,returned_summary_count:orientationSummary?1:0,returned_full_content_count:fullEvidence.length,dropped_without_document_id:droppedWithoutDocumentId,dropped_without_content:droppedWithoutContent};
  return {success:true,chunks,citations,llm_context,meta,selected_document_id:selectedDocumentId,dropped_without_document_id:droppedWithoutDocumentId,dropped_without_content:droppedWithoutContent};
}
