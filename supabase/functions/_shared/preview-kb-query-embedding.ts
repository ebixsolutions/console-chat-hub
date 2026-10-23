import { FRANKIE_KB_SCOPE, RAG_API_MODE, ORIGINAL_RAG_ACTIVATION, ragApiPolicy, type RagApiPolicy } from "./original-preview-kb-config.ts";
export { FRANKIE_KB_SCOPE, RAG_API_MODE, ORIGINAL_RAG_ACTIVATION, ragApiPolicy } from "./original-preview-kb-config.ts";
export type { RagApiPolicy } from "./original-preview-kb-config.ts";
import { canonicalJson } from "./canonical-json.ts";
/** Compatibility with the existing Singapore query-embedding API. DEFAULT OFF.
 * This is an alternative evidence protocol, not retrieval_only or a spending
 * guarantee. It needs a separately approved exact grant AND an existing KB
 * operator's signed, short-lived deployment/lineage attestation. It does not
 * require a new remote endpoint. Source ZIPs cannot attest a live deployment.
 */
export const QUERY_EMBEDDING_MODE = "query_embedding_attested_v1";

export type QueryEmbeddingEvidence = {
  remote_mode: typeof QUERY_EMBEDDING_MODE;
  remote_runtime_sha256: string;
  deployment_evidence_sha256: string;
  embedding_config_sha256: string;
  lineage_evidence_sha256: string;
  attestation_payload: string;
  attestation_signature: string;
};
type Document = {document_id:string;version_id:string;chunks:Array<{chunk_id:string;chunk_type:string;content_sha256:string}>};
export type QueryEmbeddingAttestation = typeof FRANKIE_KB_SCOPE & {
  protocol:"original-preview-query-embedding-v1";runtime_sha256:string;
  deployment_evidence_sha256:string;embedding_config_sha256:string;lineage_evidence_sha256:string;
  observed_at:number;expires:number;
  deployment_pinned_until_expiry:true;lineage_pinned_until_expiry:true;
  query_embedding_calls:1;embedding_retries:0;generation_calls:0;
  ingestion_allowed:false;reindex_allowed:false;max_query_bytes:2048;
  documents:Document[];
};
const hash = (s:unknown) => typeof s==="string" && /^[a-f0-9]{64}$/.test(s) && !/^0+$/.test(s);
const id = (s:unknown) => typeof s==="string" && /^[a-zA-Z0-9_-]{1,160}$/.test(s);
const object = (s:unknown):s is Record<string,unknown> => !!s && typeof s==="object" && !Array.isArray(s);
const deny = (code="UAT_REMOTE_BOUND_UNVERIFIED"):never => {throw Object.assign(new Error(code),{code});};
const digest = async (s:string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))),b=>b.toString(16).padStart(2,"0")).join("");
const verified = new WeakSet<object>();
export const verifiedQueryEmbeddingAttestation = (a:object) => verified.has(a);
const active = (a:QueryEmbeddingAttestation) => Number.isSafeInteger(a.observed_at) && Number.isSafeInteger(a.expires) &&
  a.observed_at<=Math.floor(Date.now()/1000) && a.expires>Math.floor(Date.now()/1000) && a.expires-a.observed_at<=3600;

export function queryEmbeddingEvidence(binding:any):QueryEmbeddingEvidence|null {
  // Permission and renewable evidence are independent. An existing operator
  // may refresh this signed read-only receipt under a separately approved
  // automation scope; users do not renew B-O or their paid grant per test.
  // Runtime + embedding configuration remain pinned by the standing grant.
  if(binding?.evidence_reference!==undefined) {
    if(typeof binding.evidence_reference!=="string" || !/^[a-z0-9_-]{1,80}$/.test(binding.evidence_reference) || binding.attestation_payload!==undefined || binding.attestation_signature!==undefined)return null;
    let evidence:any;try{evidence=JSON.parse(Deno.env.get("KB_QUERY_EMBEDDING_EVIDENCE_JSON")??"null");}catch{return null;}
    if(![1,2].includes(evidence?.version) || Object.keys(evidence).some(k=>!["version","records"].includes(k)) || !Array.isArray(evidence.records) || evidence.records.length>20)return null;
    const matches=evidence.records.filter((r:any)=>r?.reference_id===binding.evidence_reference);
    if(matches.length!==1)return null;
    const {reference_id:_,...record}=matches[0];
    if(Object.keys(record).some(k=>!["remote_mode","remote_runtime_sha256","deployment_evidence_sha256","embedding_config_sha256","lineage_evidence_sha256","attestation_payload","attestation_signature"].includes(k)) || record.remote_runtime_sha256!==binding.remote_runtime_sha256 || record.embedding_config_sha256!==binding.embedding_config_sha256)return null;
    return queryEmbeddingEvidence({...record,allow_remote_embedding:binding.allow_remote_embedding,remote_mode:binding.remote_mode});
  }
  return binding?.remote_mode===QUERY_EMBEDDING_MODE && binding.allow_remote_embedding===true &&
    hash(binding.remote_runtime_sha256) && hash(binding.deployment_evidence_sha256) && hash(binding.embedding_config_sha256) && hash(binding.lineage_evidence_sha256) &&
    typeof binding.attestation_payload==="string" && new TextEncoder().encode(binding.attestation_payload).length<=32768 &&
    hash(binding.attestation_signature) ? {
      remote_mode:QUERY_EMBEDDING_MODE,remote_runtime_sha256:binding.remote_runtime_sha256,
      deployment_evidence_sha256:binding.deployment_evidence_sha256,lineage_evidence_sha256:binding.lineage_evidence_sha256,
      embedding_config_sha256:binding.embedding_config_sha256,
      attestation_payload:binding.attestation_payload,attestation_signature:binding.attestation_signature,
    } : null;
}

/** Signature uses the existing server-bound tenant credential. Browser flags,
 * locally copied ZIP hashes and unsigned operator claims cannot satisfy this. */
export async function verifyQueryEmbeddingEvidence(e:QueryEmbeddingEvidence,credential:string):Promise<QueryEmbeddingAttestation> {
  if(!credential || !queryEmbeddingEvidence({...e,allow_remote_embedding:true}))return deny();
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(credential),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
  if(!await crypto.subtle.verify("HMAC",key,new Uint8Array(e.attestation_signature.match(/../g)!.map(v=>parseInt(v,16))),new TextEncoder().encode(e.attestation_payload)))return deny();
  let a:QueryEmbeddingAttestation;try {a=JSON.parse(e.attestation_payload);}catch{return deny();}
  const keys=[...Object.keys(FRANKIE_KB_SCOPE),"protocol","runtime_sha256","deployment_evidence_sha256","embedding_config_sha256","lineage_evidence_sha256","observed_at","expires","deployment_pinned_until_expiry","lineage_pinned_until_expiry","query_embedding_calls","embedding_retries","generation_calls","ingestion_allowed","reindex_allowed","max_query_bytes","documents"];
  if(!object(a) || Object.keys(a).some(k=>!keys.includes(k)) ||
    Object.entries(FRANKIE_KB_SCOPE).some(([k,v])=>a[k as keyof QueryEmbeddingAttestation]!==v) ||
    a.protocol!=="original-preview-query-embedding-v1" || !active(a) ||
    a.runtime_sha256!==e.remote_runtime_sha256 || a.deployment_evidence_sha256!==e.deployment_evidence_sha256 || a.embedding_config_sha256!==e.embedding_config_sha256 || a.lineage_evidence_sha256!==e.lineage_evidence_sha256 ||
    a.deployment_pinned_until_expiry!==true || a.lineage_pinned_until_expiry!==true ||
    a.query_embedding_calls!==1 || a.embedding_retries!==0 || a.generation_calls!==0 ||
    a.ingestion_allowed!==false || a.reindex_allowed!==false || a.max_query_bytes!==2048 ||
    !Array.isArray(a.documents) || !a.documents.length || a.documents.length>10)return deny();
  const docs=new Set<string>(),chunks=new Set<string>();
  for(const d of a.documents) {
    if(!object(d) || Object.keys(d).some(k=>!["document_id","version_id","chunks"].includes(k)) || !id(d.document_id) || !id(d.version_id) || docs.has(d.document_id) || !Array.isArray(d.chunks) || !d.chunks.length || d.chunks.length>40)return deny();
    docs.add(d.document_id);
    for(const c of d.chunks) {
      if(!object(c) || Object.keys(c).some(k=>!["chunk_id","chunk_type","content_sha256"].includes(k)) || !id(c.chunk_id) || !["rag_summary","full_content","faq_pair","section"].includes(c.chunk_type) || !hash(c.content_sha256) || chunks.has(c.chunk_id))return deny();
      chunks.add(c.chunk_id);
    }
  }
  if(await digest(canonicalJson(a.documents))!==a.lineage_evidence_sha256)return deny();
  verified.add(a);return a;
}

/** The old API omits version metadata. Bind returned content to the separately
 * attested *current published* document/version/chunk snapshot before grounding.
 * Changed/unreviewed bytes, cross-tenant/version claims and expired evidence
 * deny; no model answer is made from combined_text or unverified snippets. */
export async function bindQueryEmbeddingResponse(response:Response,a:QueryEmbeddingAttestation):Promise<Response> {
  if(!verified.has(a) || !active(a))return deny();
  if(!response.ok)return response;
  const reader=response.body?.getReader();if(!reader)return deny("KB_TOOL_FAILURE");
  const parts:Uint8Array[]=[];let length=0;
  try {for(;;){const r=await reader.read();if(r.done)break;length+=r.value.length;if(length>2_000_000){await reader.cancel();return deny("KB_TOOL_FAILURE");}parts.push(r.value);}}
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const p of parts){bytes.set(p,offset);offset+=p.length;}
  let data:any;try {data=JSON.parse(new TextDecoder().decode(bytes));}catch{return deny("KB_TOOL_FAILURE");}
  if(!active(a))return deny();
  if(data?.success!==true || typeof data.context_found!=="boolean" || !Array.isArray(data.selected_documents) || data.selected_documents.length>5)return deny("KB_TOOL_FAILURE");
  if(data.company_id!==undefined && String(data.company_id)!==a.tenant || data.tenant_id!==undefined && String(data.tenant_id)!==a.tenant)return deny();
  if(!data.context_found) {
    if(data.selected_documents.length)return deny("KB_TOOL_FAILURE");
    return Response.json({success:true,context_found:false,selected_documents:[],citations:[]},{headers:{"Cache-Control":"no-store"}});
  }
  if(!data.selected_documents.length)return deny("KB_TOOL_FAILURE");
  const seen=new Set<string>();
  for(const d of data.selected_documents) {
    const reviewed=a.documents.find(v=>v.document_id===d?.document_id);
    if(!reviewed || seen.has(d.document_id) || !Array.isArray(d.evidence) || d.evidence.length>3)return deny();
    seen.add(d.document_id);
    for(const m of [d,d.authority,d.metadata].filter(object)) {
      if(m.tenant_id!==undefined && String(m.tenant_id)!==a.tenant || m.company_id!==undefined && String(m.company_id)!==a.tenant ||
        m.version_id!==undefined && String(m.version_id)!==reviewed.version_id || m.version!==undefined && String(m.version)!==reviewed.version_id ||
        m.publication_state!==undefined && m.publication_state!=="published" || m.status!==undefined && m.status!=="published" ||
        m.currentness!==undefined && m.currentness!=="current")return deny();
    }
    for(const c of [...(d.summary?[d.summary]:[]),...d.evidence]) {
      const known=reviewed.chunks.find(v=>v.chunk_id===c?.chunk_id);
      if(!known || c.chunk_type!==known.chunk_type || typeof c.content!=="string" || await digest(c.content)!==known.content_sha256)return deny();
    }
    d.authority={...(object(d.metadata)?d.metadata:{}),...(object(d.authority)?d.authority:{}),
      tenant_id:a.tenant,version_id:reviewed.version_id,publication_state:"published",currentness:"current"};
  }
  // Only selected, attested document evidence is consumed by the existing parser.
  return Response.json({success:true,context_found:true,selected_documents:data.selected_documents,citations:[]},{headers:{"Cache-Control":"no-store"}});
}

/** Proposed alternative to operator-pinned snapshots. DEFAULT OFF and not
 * authorized by old B settings: version3 Preview / version2 Inbox must opt in.
 * Authenticated live entity reads establish current evidence at observation,
 * not a pinned runtime, a future publication lock or a remote spending cap. */
/** Original authenticated RAG transport, with authority carried by its own
 * response. Separate explicit grant: metadata-mode approval cannot enable it.
 * Missing native authority remains unknown and denies, never filled locally.
 */
const ragAuthorityFailure=(reason:string):never=>{throw Object.assign(new Error("KB_TOOL_FAILURE"),{code:"KB_TOOL_FAILURE",reason});};
type ServiceRead = {tenant:string; relevance:string|null};
// Out-of-band, server-only provenance: an API body/browser flag cannot mint it.
const serviceResponses=new WeakMap<Response,Map<string,ServiceRead>>();
const serviceDocuments=new WeakMap<object,ServiceRead>();
export function bindRagServiceDocument(response:Response,document:{document_id:string}):void {
  const proof=serviceResponses.get(response)?.get(document.document_id);
  if(proof)serviceDocuments.set(document,proof);
}
export function ragServiceDocument(document:object):ServiceRead|undefined {return serviceDocuments.get(document);}
async function bindOriginalAggregation(data:any):Promise<{response:Response;grounded:boolean}> {
  // Trust only the separately approved authenticated endpoint's tenant-key +
  // production/published/live/indexed/active-version filter contract. This is
  // not independent live attestation. Missing version/publication stays unknown.
  const check=(claim:any,version?:string,chunk=false)=>{
    if(!object(claim))return;
    if(claim.company_id!==undefined && String(claim.company_id)!==FRANKIE_KB_SCOPE.tenant || claim.tenant_id!==undefined && String(claim.tenant_id)!==FRANKIE_KB_SCOPE.tenant)return ragAuthorityFailure("KB_RAG_TENANT_CONFLICT");
    if(claim.publication_state!==undefined && claim.publication_state!=="published" && claim.publication_state!=="live" || claim.status!==undefined && !["published","live",...(chunk?["active"]:[])].includes(String(claim.status)) || claim.currentness!==undefined && !["current","unknown"].includes(String(claim.currentness)) || claim.is_current===false || claim.is_published===false || claim.available_to_live_console===false || claim.environment!==undefined && claim.environment!=="production")return ragAuthorityFailure("KB_RAG_AUTHORITY_CONFLICT");
    if(version && (claim.version_id!==undefined && claim.version_id!==version || claim.version!==undefined && claim.version!==version))return ragAuthorityFailure("KB_RAG_AUTHORITY_CONFLICT");
  };
  check(data);check(data.metadata);check(data.meta);
  if(data.authority_contract!==undefined && data.authority_contract!=="singapore_rag_published_v1")return ragAuthorityFailure("KB_RAG_AUTHORITY_CONFLICT");
  if(!Array.isArray(data.citations))return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
  if(!data.context_found){
    if(data.selected_documents.length || data.citations.length)return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
    if(data.llm_context!==undefined && data.llm_context!==null && (!object(data.llm_context) || data.llm_context.summary_count!==0 || data.llm_context.evidence_count!==0))return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
    return {response:Response.json({success:true,context_found:false,selected_documents:[],citations:[]},{headers:{"Cache-Control":"no-store"}}),grounded:false};
  }
  if(!data.selected_documents.length)return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
  const docs=new Set<string>(),chunks=new Set<string>(),owners=new Map<string,string>(),proofs=new Map<string,ServiceRead>();
  for(const d of data.selected_documents){
    if(!object(d) || !id(d.document_id) || docs.has(String(d.document_id)) || typeof d.title!=="string" || !d.title.trim() || typeof d.source_type!=="string" || !d.source_type.trim() || typeof d.document_score!=="number" || !Number.isFinite(d.document_score) || !Array.isArray(d.evidence) || !d.evidence.length || d.evidence.length>3)return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
    docs.add(String(d.document_id));
    if(d.authority!==undefined && !object(d.authority) || d.metadata!==undefined && !object(d.metadata))return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
    const versions=[d.version_id,d.version,(d.authority as any)?.version_id,(d.authority as any)?.version,(d.metadata as any)?.version_id,(d.metadata as any)?.version].filter(v=>v!==undefined && v!==null);
    if(versions.some(v=>!id(v)) || new Set(versions).size>1)return ragAuthorityFailure("KB_RAG_AUTHORITY_CONFLICT");
    for(const claim of [d,d.authority,d.metadata])check(claim,versions[0] as string|undefined);
    const chunkVersions=new Set<string>();
    for(const c of [...(d.summary?[d.summary]:[]),...d.evidence]){
      if(!object(c) || !id(c.chunk_id) || chunks.has(String(c.chunk_id)) || !["rag_summary","full_content","faq_pair","section"].includes(String(c.chunk_type)) || typeof c.content!=="string" || !c.content.trim() || typeof c.score!=="number" || !Number.isFinite(c.score) || c.document_id!==undefined && c.document_id!==d.document_id)return ragAuthorityFailure("KB_RAG_CHUNK_INVALID");
      check(c,versions[0] as string|undefined,true);check(c.metadata,versions[0] as string|undefined,true);
      if(c.version_id!==undefined){if(!id(c.version_id))return ragAuthorityFailure("KB_RAG_CHUNK_INVALID");chunkVersions.add(String(c.version_id));}
      if(c.content_sha256!==undefined && (!hash(c.content_sha256) || await digest(c.content)!==c.content_sha256))return ragAuthorityFailure("KB_RAG_CONTENT_MISMATCH");
      chunks.add(String(c.chunk_id));
      owners.set(String(c.chunk_id),String(d.document_id));
    }
    if(chunkVersions.size>1)return ragAuthorityFailure("KB_RAG_AUTHORITY_CONFLICT");
  }
  const cited=new Set<string>();
  for(const c of data.citations){
    if(!object(c) || !docs.has(String(c.document_id)) || cited.has(String(c.document_id)) || c.chunk_id!==undefined && owners.get(String(c.chunk_id))!==c.document_id)return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
    check(c);cited.add(String(c.document_id));
  }
  for(const d of data.selected_documents){const citation=data.citations.find((c:any)=>c.document_id===d.document_id);proofs.set(d.document_id,{tenant:FRANKIE_KB_SCOPE.tenant,relevance:typeof citation?.relevance==="string"?citation.relevance:null});}
  // Keep actual authority fields exactly; no locally fabricated hashes/versions.
  // combined_text/query never become evidence or a second customer instruction.
  const response=Response.json({success:true,context_found:true,selected_documents:data.selected_documents,citations:data.citations},{headers:{"Cache-Control":"no-store"}});
  serviceResponses.set(response,proofs);return {response,grounded:true};
}
/** No metadata GET, fallback legacy path, fabricated version or model retry.
 * These are authenticated service assertions, not an independently verified
 * index snapshot or runtime/cost attestation. Approval must accept that boundary.
 */
export async function bindRagApiResponse(response:Response,policy:RagApiPolicy):Promise<{response:Response;grounded:boolean}> {
  if(!ragApiPolicy({...policy,allow_remote_embedding:true}))return deny();
  if(!response.ok)return {response,grounded:false};
  const data=await boundedJson(response);
  if(!object(data) || data.success!==true || typeof data.context_found!=="boolean" || !Array.isArray(data.selected_documents) || data.selected_documents.length>5)return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
  if(policy.rag_api_contract==="singapore_rag_aggregation_v1")return await bindOriginalAggregation(data);
  if(data.authority_contract!==policy.rag_api_contract || data.company_id===undefined)return ragAuthorityFailure("KB_RAG_AUTHORITY_MISSING");
  if(String(data.company_id)!==FRANKIE_KB_SCOPE.tenant || data.tenant_id!==undefined && String(data.tenant_id)!==FRANKIE_KB_SCOPE.tenant)return ragAuthorityFailure("KB_RAG_TENANT_CONFLICT");
  if(!data.context_found){
    if(data.selected_documents.length)return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
    return {response:Response.json({success:true,context_found:false,selected_documents:[],citations:[]},{headers:{"Cache-Control":"no-store"}}),grounded:false};
  }
  if(!data.selected_documents.length)return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
  const docs=new Set<string>(),chunks=new Set<string>();
  for(const doc of data.selected_documents){
    if(!object(doc) || !id(doc.document_id) || docs.has(doc.document_id as string) || typeof doc.title!=="string" || !doc.title.trim() || typeof doc.source_type!=="string" || !doc.source_type.trim() || typeof doc.document_score!=="number" || !Number.isFinite(doc.document_score) || !Array.isArray(doc.evidence) || !doc.evidence.length || doc.evidence.length>3)return ragAuthorityFailure("KB_RAG_RESPONSE_INVALID");
    docs.add(doc.document_id as string);
    const a=doc.authority;
    if(!object(a) || !id(a.version_id) || !hash(a.content_sha256) || a.tenant_id===undefined || a.publication_state===undefined || a.currentness===undefined)return ragAuthorityFailure("KB_RAG_AUTHORITY_MISSING");
    if(String(a.tenant_id)!==FRANKIE_KB_SCOPE.tenant || a.publication_state!=="published" || a.currentness!=="current")return ragAuthorityFailure("KB_RAG_AUTHORITY_CONFLICT");
    for(const claim of [doc,a,doc.metadata].filter(object)){
      if(claim.company_id!==undefined && String(claim.company_id)!==FRANKIE_KB_SCOPE.tenant || claim.tenant_id!==undefined && String(claim.tenant_id)!==FRANKIE_KB_SCOPE.tenant ||
        claim.version_id!==undefined && claim.version_id!==a.version_id || claim.version!==undefined && claim.version!==a.version_id ||
        claim.status!==undefined && claim.status!=="published" || claim.publication_state!==undefined && claim.publication_state!=="published" ||
        claim.currentness!==undefined && claim.currentness!=="current" || claim.is_current===false)return ragAuthorityFailure("KB_RAG_AUTHORITY_CONFLICT");
    }
    for(const part of [...(doc.summary?[doc.summary]:[]),...doc.evidence]){
      if(!object(part) || !id(part.chunk_id) || chunks.has(part.chunk_id as string) || part.document_id!==doc.document_id || part.version_id!==a.version_id ||
        !["rag_summary","full_content","faq_pair","section"].includes(String(part.chunk_type)) || typeof part.content!=="string" || !part.content.trim() || typeof part.score!=="number" || !Number.isFinite(part.score) || !hash(part.content_sha256))return ragAuthorityFailure("KB_RAG_CHUNK_INVALID");
      if(await digest(part.content)!==part.content_sha256)return ragAuthorityFailure("KB_RAG_CONTENT_MISMATCH");
      chunks.add(part.chunk_id as string);
    }
  }
  // Preserve actual source/version assertions. Never synthesize CURRENT_KB
  // metadata for old unversioned responses or use combined_text as evidence.
  return {response:Response.json({success:true,context_found:true,selected_documents:data.selected_documents,citations:[]},{headers:{"Cache-Control":"no-store"}}),grounded:true};
}

export const LIVE_METADATA_MODE = "query_embedding_live_metadata_v1";
export type LiveMetadataPolicy = {
  reference_id:string; remote_mode:typeof LIVE_METADATA_MODE;
  metadata_tenant_id:string;
  metadata_api_contract:"singapore_entities_bearer_v1";
  accepted_remote_risk:"unattested_runtime_cost_and_publication_race_v1";
  max_query_bytes:2048;
};
type LiveSession={policy:LiveMetadataPolicy;credential:string;authorization:string;tokens:string;expires:number};
const liveSessions=new WeakMap<object,LiveSession>();
const liveBase="https://py.ebixmall.com/py-knowledge-base/api/entities/";
const safeId=(s:unknown):s is string=>typeof s==="string" && /^[a-zA-Z0-9_-]{1,160}$/.test(s);
export function liveMetadataPolicy(binding:any):LiveMetadataPolicy|null {
  if(binding?.remote_mode!==LIVE_METADATA_MODE || binding.allow_remote_embedding!==true ||
    !safeId(binding.evidence_reference) || binding.remote_runtime_sha256!==undefined || binding.attestation_payload!==undefined || binding.attestation_signature!==undefined)return null;
  let config:any;try{config=JSON.parse(Deno.env.get("KB_QUERY_EMBEDDING_EVIDENCE_JSON")??"null");}catch{return null;}
  if(config?.version!==2 || Object.keys(config).some(k=>!["version","records"].includes(k)) || !Array.isArray(config.records) || config.records.length>20)return null;
  const rows=config.records.filter((x:any)=>x?.reference_id===binding.evidence_reference);
  if(rows.length!==1)return null;
  const p=rows[0];
  if(Object.keys(p).some(k=>!["reference_id","remote_mode","metadata_tenant_id","metadata_api_contract","accepted_remote_risk","max_query_bytes"].includes(k)) ||
    p.remote_mode!==LIVE_METADATA_MODE || !safeId(p.metadata_tenant_id) || p.metadata_api_contract!=="singapore_entities_bearer_v1" ||
    p.accepted_remote_risk!=="unattested_runtime_cost_and_publication_race_v1" || p.max_query_bytes!==2048)return null;
  return {...p};
}
export function liveMetadataSessionMatches(session:object,policy:LiveMetadataPolicy):boolean {
  const s=liveSessions.get(session);return !!s && currentLiveMetadataSession(session) && canonicalJson(s.policy)===canonicalJson(policy);
}
export function currentLiveMetadataSession(session:object):boolean {
  const s=liveSessions.get(session);
  return !!s && s.expires>Date.now() && Deno.env.get("KB_QUERY_EMBEDDING_EVIDENCE_JSON")===s.authorization && Deno.env.get("KB_RAG_TENANT_TOKENS_JSON")===s.tokens;
}
async function boundedJson(response:Response):Promise<any> {
  if(!response.ok) {
    await response.body?.cancel();return deny([401,403].includes(response.status)?"UAT_AUTHORIZATION_DENIED":"KB_TOOL_FAILURE");
  }
  const invalid=(reason:string):never=>{throw Object.assign(new Error("KB_TOOL_FAILURE"),{code:"KB_TOOL_FAILURE",reason});};
  const reader=response.body?.getReader();if(!reader)return invalid("KB_RESPONSE_EMPTY");
  const parts:Uint8Array[]=[];let n=0;
  try{for(;;){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>2_000_000){await reader.cancel();return invalid("KB_RESPONSE_TOO_LARGE");}parts.push(r.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(n);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{return invalid("KB_RESPONSE_INVALID_JSON");}
}
// Match the existing Python hash_content(strip) and _normalize_text(split)
// contracts exactly, including NEL/control whitespace, without altering facts.
function pythonStrip(value:string):string {
  return value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu,"");
}
function pythonNormalize(value:string):string {
  return pythonStrip(value).replace(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu," ");
}
function ownedMetadata(row:any,s:LiveSession):boolean {
  return object(row) && String(row.company_id)===FRANKIE_KB_SCOPE.tenant && row.tenant_id===s.policy.metadata_tenant_id;
}
function currentDocument(row:any,s:LiveSession):boolean {
  return ownedMetadata(row,s) && safeId(row.id) && safeId(row.active_version_id) && row.status==="published" &&
    row.available_to_live_console===true && row.production_vector_status==="indexed" && hash(row.content_hash);
}
async function metadata(session:object,path:string,upstream:typeof fetch,signal?:AbortSignal):Promise<any> {
  const s=liveSessions.get(session);if(!s || !currentLiveMetadataSession(session))return deny();
  const response=await upstream(liveBase+path,{method:"GET",redirect:"error",cache:"no-store",headers:{Authorization:`Bearer ${s.credential}`,Accept:"application/json"},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
  const value=await boundedJson(response);if(!currentLiveMetadataSession(session))return deny();return value;
}
/** A credential is taken only from the existing server tenant Bearer binding.
 * No RAG API-key reuse, JWT minting, service-role header or credential export. */
export async function prepareLiveMetadata(policy:LiveMetadataPolicy,ragCredential:string,upstream:typeof fetch=fetch,signal?:AbortSignal):Promise<object> {
  const current=liveMetadataPolicy({remote_mode:LIVE_METADATA_MODE,allow_remote_embedding:true,evidence_reference:policy.reference_id});
  if(!current || canonicalJson(current)!==canonicalJson(policy))return deny();
  const tokens=Deno.env.get("KB_RAG_TENANT_TOKENS_JSON")??"";let parsed:any;
  try{parsed=JSON.parse(tokens);}catch{return deny();}
  const credential=parsed?.[FRANKIE_KB_SCOPE.tenant];
  if(typeof credential!=="string" || !credential.trim() || credential===ragCredential || /[\r\n]/.test(credential))return deny();
  const session={};liveSessions.set(session,{policy,credential,authorization:Deno.env.get("KB_QUERY_EMBEDDING_EVIDENCE_JSON")??"",tokens,expires:Date.now()+60000});
  // Verify actual metadata access before any paid RAG request. A record label
  // alone is insufficient; missing/incompatible authority denies without RAG.
  const docs=await metadata(session,"KBDocument?_limit=1&company_id=34&status=published&available_to_live_console=true&production_vector_status=indexed",upstream,signal);
  if(!Array.isArray(docs) || docs.length!==1 || !currentDocument(docs[0],liveSessions.get(session)!))return deny();
  return session;
}
async function metadataSet(session:object,entity:string,ids:string[],upstream:typeof fetch,signal?:AbortSignal):Promise<Map<string,any>> {
  if(!ids.length || ids.length>20 || new Set(ids).size!==ids.length || ids.some(x=>!safeId(x)))return deny();
  const query=encodeURIComponent(JSON.stringify({id:{$in:ids},company_id:34}));
  const rows=await metadata(session,`${entity}?_limit=${ids.length}&q=${query}`,upstream,signal);
  if(!Array.isArray(rows) || rows.length!==ids.length || rows.some(x=>!object(x) || !ids.includes(x.id as string)) || new Set(rows.map(x=>x.id)).size!==rows.length)return deny();
  return new Map(rows.map(x=>[x.id,x]));
}
/** Bind only current, authenticated Singapore metadata for each returned hit.
 * No static document allowlist. No truncation or invented/omitted versions.
 * Re-read every document after chunk verification to detect intervening change;
 * a change after that read remains an explicitly acknowledged remote race. */
export async function bindLiveMetadataResponse(response:Response,session:object,upstream:typeof fetch=fetch,signal?:AbortSignal):Promise<Response> {
  if(!currentLiveMetadataSession(session))return deny();
  if(!response.ok)return response;
  const s=liveSessions.get(session)!,data=await boundedJson(response);
  if(data?.success!==true || typeof data.context_found!=="boolean" || !Array.isArray(data.selected_documents) || data.selected_documents.length>5)return deny("KB_TOOL_FAILURE");
  if(data.company_id!==undefined && String(data.company_id)!==FRANKIE_KB_SCOPE.tenant || data.tenant_id!==undefined && String(data.tenant_id)!==FRANKIE_KB_SCOPE.tenant)return deny();
  if(!data.context_found){if(data.selected_documents.length)return deny("KB_TOOL_FAILURE");return Response.json({success:true,context_found:false,selected_documents:[],citations:[]});}
  if(!data.selected_documents.length)return deny("KB_TOOL_FAILURE");
  // Existing GET filter supports $in. Batch each dependent layer; no N+1
  // metadata loop, new API, or bulk mutation endpoint is introduced.
  const ids=data.selected_documents.map((d:any)=>d?.document_id);
  const documents=await metadataSet(session,"KBDocument",ids,upstream,signal);
  if([...documents.values()].some(d=>!currentDocument(d,s)))return deny();
  const versionIds=[...documents.values()].map(d=>d.active_version_id);
  const versions=await metadataSet(session,"KBDocumentVersion",versionIds,upstream,signal);
  const chunkIds=data.selected_documents.flatMap((d:any)=>{
    if(!Array.isArray(d?.evidence) || d.evidence.length>3)return deny();
    return [...(d.summary?[d.summary]:[]),...d.evidence].map((c:any)=>c?.chunk_id);
  });
  const chunks=await metadataSet(session,"KBVectorChunk",chunkIds,upstream,signal);
  const seenDocs=new Set<string>(),seenChunks=new Set<string>(),checks:Array<{id:string;fingerprint:string}>=[];
  const fingerprint=(d:any)=>canonicalJson([d.id,d.company_id,d.tenant_id,d.status,d.available_to_live_console,d.production_vector_status,d.active_version_id,d.content_hash,d.name,d.source_type]);
  for(const hit of data.selected_documents){
    if(!safeId(hit?.document_id) || seenDocs.has(hit.document_id) || !Array.isArray(hit.evidence) || hit.evidence.length>3)return deny();
    seenDocs.add(hit.document_id);
    const doc=documents.get(hit.document_id);
    if(!currentDocument(doc,s) || doc.id!==hit.document_id || hit.title!==doc.name || hit.source_type!==doc.source_type)return deny();
    const version=versions.get(doc.active_version_id);
    if(!ownedMetadata(version,s) || version.id!==doc.active_version_id || version.document_id!==doc.id || version.review_status==="rejected" || version.vector_status==="outdated" || version.vector_status==="failed" ||
      version.content_hash!==doc.content_hash || typeof version.raw_content_snapshot!=="string" || await digest(pythonStrip(version.raw_content_snapshot))!==version.content_hash)return deny();
    for(const claim of [hit,hit.authority,hit.metadata].filter(object)){
      if(claim.company_id!==undefined && String(claim.company_id)!==FRANKIE_KB_SCOPE.tenant || claim.tenant_id!==undefined && String(claim.tenant_id)!==FRANKIE_KB_SCOPE.tenant ||
        claim.version_id!==undefined && claim.version_id!==doc.active_version_id || claim.version!==undefined && claim.version!==doc.active_version_id ||
        claim.status!==undefined && claim.status!=="published" || claim.publication_state!==undefined && claim.publication_state!=="published" || claim.currentness!==undefined && claim.currentness!=="current")return deny();
    }
    const evidence=[...(hit.summary?[hit.summary]:[]),...hit.evidence];if(!evidence.length)return deny();
    for(const part of evidence){
      if(!safeId(part?.chunk_id) || seenChunks.has(part.chunk_id) || !["rag_summary","full_content","faq_pair","section"].includes(part.chunk_type) || typeof part.content!=="string" || !part.content.trim())return deny();
      seenChunks.add(part.chunk_id);
      const chunk=chunks.get(part.chunk_id);
      const vector=Array.isArray(chunk?.embedding_vector)?chunk.embedding_vector:chunk?.embedding_vector?.values;
      if(!ownedMetadata(chunk,s) || chunk.id!==part.chunk_id || chunk.document_id!==doc.id || chunk.version_id!==doc.active_version_id || chunk.environment!=="production" || chunk.status!=="active" ||
        !["generated","completed"].includes(chunk.embedding_status) || chunk.chunk_type!==part.chunk_type || typeof chunk.chunk_text!=="string" ||
        !Array.isArray(vector) || !Number.isSafeInteger(chunk.embedding_dimensions) || chunk.embedding_dimensions<1 || vector.length!==chunk.embedding_dimensions || vector.some((v:unknown)=>typeof v!=="number" || !Number.isFinite(v)) ||
        await digest(pythonNormalize(chunk.chunk_text))!==await digest(part.content))return deny();
    }
    checks.push({id:doc.id,fingerprint:fingerprint(doc)});
    hit.authority={tenant_id:FRANKIE_KB_SCOPE.tenant,version_id:doc.active_version_id,publication_state:"published",currentness:"current"};
  }
  const finalDocuments=await metadataSet(session,"KBDocument",ids,upstream,signal);
  for(const c of checks){const current=finalDocuments.get(c.id);if(!currentDocument(current,s) || fingerprint(current)!==c.fingerprint)return deny();}
  if(!currentLiveMetadataSession(session))return deny();
  return Response.json({success:true,context_found:true,selected_documents:data.selected_documents,citations:[]},{headers:{"Cache-Control":"no-store"}});
}
