import { canonicalJson } from "./canonical-json.ts";
/** Compatibility with the existing Singapore query-embedding API. DEFAULT OFF.
 * This is an alternative evidence protocol, not retrieval_only or a spending
 * guarantee. It needs a separately approved exact grant AND an existing KB
 * operator's signed, short-lived deployment/lineage attestation. It does not
 * require a new remote endpoint. Source ZIPs cannot attest a live deployment.
 */
export const QUERY_EMBEDDING_MODE = "query_embedding_attested_v1";
export const FRANKIE_KB_SCOPE = Object.freeze({
  actor:"3bdf936e-b543-41d8-9fff-fa020a85f3f6", company:"3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
  channel:"b0000000-0000-0000-0000-000000000001", tenant:"34",
  endpoint:"https://py.ebixmall.com/py-knowledge-base/api/v1/rag/context-search",
});
export type QueryEmbeddingEvidence = {
  remote_mode: typeof QUERY_EMBEDDING_MODE;
  remote_runtime_sha256: string;
  deployment_evidence_sha256: string;
  embedding_config_sha256: string;
  lineage_evidence_sha256: string;
  attestation_payload: string;
  attestation_signature: string;
};
type Document = {document_id:string;version_id:string;chunks:Array<{chunk_id:string;content_sha256:string}>};
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
      if(!object(c) || Object.keys(c).some(k=>!["chunk_id","content_sha256"].includes(k)) || !id(c.chunk_id) || !hash(c.content_sha256) || chunks.has(c.chunk_id))return deny();
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
      if(!known || typeof c.content!=="string" || await digest(c.content)!==known.content_sha256)return deny();
    }
    d.authority={tenant_id:a.tenant,version_id:reviewed.version_id,publication_state:"published",currentness:"current"};
  }
  // Only selected, attested document evidence is consumed by the existing parser.
  return Response.json({success:true,context_found:true,selected_documents:data.selected_documents,citations:[]},{headers:{"Cache-Control":"no-store"}});
}
