/**
 * PR-6B — SU CoachAI improved result -> Singapore KB publish saga.
 *
 * Uses only verified Singapore source contracts:
 *   GET/PATCH /api/entities/KBDocument/{id}
 *   POST      /api/entities/KBDocumentVersion
 *   POST      /api/functions/kbPublishStart
 *   POST      /api/functions/kbPublishGetStatus
 *
 * No tenant/company is accepted from the caller. The worker resolves the AI
 * company from ce_training_link, maps it to Singapore tenant_id, then mints a
 * short-lived HS256 JWT. Singapore stamps/filters tenant ownership.
 */
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const WORKER_CONTRACT = "PR6B_SINGAPORE_KB_SYNC_V1";
const MAX_CONTENT_BYTES = 512 * 1024;
const TERMINAL_SUCCESS = new Set(["completed", "success", "published"]);
const TERMINAL_FAILURE = new Set(["failed", "cancelled", "rolled_back"]);

type LinkRow = {
  id: string;
  evaluation_id: string;
  company_id: string;
  improved_result: Record<string, unknown>;
  improved_state: string;
  remote_sync_state: string;
};

function response(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function text(v: unknown): string { return typeof v === "string" ? v.trim() : ""; }
function constantTimeEqual(aText: string, bText: string): boolean {
  const a = new TextEncoder().encode(aText), b = new TextEncoder().encode(bText);
  if (a.length !== b.length) return false;
  let d = 0; for (let i=0;i<a.length;i++) d |= a[i]^b[i]; return d===0;
}
function b64url(bytes: Uint8Array): string {
  let s=""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
}
function b64json(v: Record<string, unknown>): string {
  return b64url(new TextEncoder().encode(JSON.stringify(v)));
}
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function mintJwt(secret: string, companyId: string, tenantId: string): Promise<string> {
  const now = Math.floor(Date.now()/1000);
  const h=b64json({alg:"HS256",typ:"JWT"});
  const p=b64json({sub:`ai-chatbot:${companyId}`,tenant_id:tenantId,role:"service",iat:now,exp:now+300});
  const input=`${h}.${p}`;
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}
function parseMap(raw: string): Record<string,string> | null {
  try {
    const v=JSON.parse(raw); if(!v||typeof v!=="object"||Array.isArray(v)) return null;
    const out:Record<string,string>={}; for(const [k,val] of Object.entries(v)){if(typeof val!=="string"||!val.trim())return null;out[k]=val.trim();}
    return out;
  } catch { return null; }
}
function nextMinor(current: string): string | null {
  if(!/^\d+\.\d+$/.test(current)) return null;
  const [maj,min]=current.split(".").map(Number); return `${maj}.${min+1}`;
}
function resolveBase(): string | null {
  const direct=text(Deno.env.get("KB_SINGAPORE_BASE_URL"));
  if(direct) return direct.replace(/\/+$/,"");
  const rag=text(Deno.env.get("KB_RAG_ENDPOINT"));
  if(!rag) return null;
  return rag.replace(/\/api\/v1\/rag\/context-search\/?$/,"").replace(/\/+$/,"");
}
async function kbFetch(base:string,path:string,token:string,init:RequestInit={}):Promise<Response>{
  const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(),15000);
  try { return await fetch(`${base}${path}`,{...init,headers:{"Authorization":`Bearer ${token}`,"Content-Type":"application/json",...(init.headers||{})},signal:ctl.signal}); }
  finally { clearTimeout(t); }
}

Deno.serve(async(req)=>{
  if(req.method!=="POST") return response({ok:false,error:"method_not_allowed"},405);
  const expected=text(Deno.env.get("TRAINING_KB_SYNC_INTERNAL_TOKEN"));
  const actual=text(req.headers.get("X-Training-KB-Sync-Token"));
  if(!expected||!actual||!constantTimeEqual(expected,actual)) return response({ok:false,error:"unauthorized"},401);

  const supabaseUrl=text(Deno.env.get("SUPABASE_URL"));
  const serviceRole=text(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const base=resolveBase();
  const jwtSecret=text(Deno.env.get("KB_SINGAPORE_JWT_SECRET"));
  const tenantMap=parseMap(text(Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON")));
  if(!supabaseUrl||!serviceRole||!base||!jwtSecret||!tenantMap) return response({ok:false,error:"runtime_config_missing"},503);
  const admin=createClient(supabaseUrl,serviceRole);

  // Atomically claim one eligible received training result.
  const {data:claim,error:claimErr}=await admin.rpc("claim_pr6b_kb_sync_tx",{});
  if(claimErr) return response({ok:false,error:"claim_failed"},500);
  const c=claim as Record<string,unknown>|null;
  if(!c||c.result==="none") return response({ok:true,contract:WORKER_CONTRACT,processed:0});
  if(c.result!=="claimed") return response({ok:false,error:String(c.result||"claim_invalid")},409);

  const linkId=String(c.training_link_id), evaluationId=String(c.evaluation_id), companyId=String(c.company_id);
  const improved=(c.improved_result||{}) as Record<string,unknown>;
  const decision=text((c.payload as Record<string,unknown>|undefined)?.decision);
  const kb=(improved.kb_update||{}) as Record<string,unknown>;
  const documentId=text(kb.document_id), expectedHash=text(kb.expected_content_hash), newContent=typeof kb.new_raw_content==="string"?kb.new_raw_content:"";
  const changeSummary=text(kb.change_summary)||`SU CoachAI training merge ${evaluationId}`;

  async function fail(code:string,remoteRef:string|null=null){
    await admin.rpc("finish_pr6b_kb_sync_tx",{p_training_link_id:linkId,p_success:false,p_remote_ref:remoteRef,p_error:code});
    return response({ok:false,error:code,evaluation_id:evaluationId},409);
  }

  if(decision!=="trained") return fail("training_decision_not_trained");
  if(!documentId||!/^[0-9a-fA-F-]{8,64}$/.test(documentId)||!/^[0-9a-f]{64}$/i.test(expectedHash)) return fail("kb_update_contract_invalid");
  if(!newContent.trim()||new TextEncoder().encode(newContent).byteLength>MAX_CONTENT_BYTES) return fail("kb_update_content_invalid");

  const tenantId=tenantMap[companyId]; if(!tenantId) return fail("kb_tenant_mapping_unresolved");
  const token=await mintJwt(jwtSecret,companyId,tenantId);

  let docResp:Response;
  try { docResp=await kbFetch(base,`/api/entities/KBDocument/${encodeURIComponent(documentId)}`,token); }
  catch { return fail("kb_unreachable"); }
  if(!docResp.ok) return fail(`kb_document_http_${docResp.status}`);
  const doc=await docResp.json() as Record<string,unknown>;
  const currentHash=text(doc.content_hash);
  if(currentHash!==expectedHash) return fail("kb_expected_content_hash_mismatch");
  const currentVersion=text(doc.version)||"1.0", nextVersion=nextMinor(currentVersion);
  if(!nextVersion) return fail("kb_version_invalid");
  const newHash=await sha256Hex(newContent);
  if(newHash===expectedHash) return fail("kb_update_no_change");

  // Deterministic snapshot id makes retries safe even across worker crashes.
  const snapshotId=`aitr_${(await sha256Hex(evaluationId+":"+documentId)).slice(0,40)}`;
  const snapshotBody={
    id:snapshotId, document_id:documentId, version:currentVersion, version_type:"minor",
    change_type:"ai_training_merge", change_summary:changeSummary,
    raw_content_snapshot:String(doc.raw_content||"").slice(0,10000), content_hash:expectedHash,
    changed_by_app:"ai_training", related_training_case_id:evaluationId,
    review_status:"pending", vector_status:"not_generated", company_id:doc.company_id
  };
  let snap=await kbFetch(base,"/api/entities/KBDocumentVersion",token,{method:"POST",body:JSON.stringify(snapshotBody)});
  if(!snap.ok && snap.status!==409 && snap.status!==422){ return fail(`kb_version_snapshot_http_${snap.status}`); }
  if(!snap.ok){
    // Existing deterministic snapshot is acceptable only when it matches this evaluation/doc.
    const existing=await kbFetch(base,`/api/entities/KBDocumentVersion/${encodeURIComponent(snapshotId)}`,token);
    if(!existing.ok) return fail("kb_version_snapshot_conflict");
    const ev=await existing.json() as Record<string,unknown>;
    if(text(ev.document_id)!==documentId||text(ev.related_training_case_id)!==evaluationId||text(ev.content_hash)!==expectedHash) return fail("kb_version_snapshot_conflict");
  }

  // Keep current published availability while changing source content. Old vectors
  // remain live until Singapore publish activation replaces them.
  const patchBody={raw_content:newContent,content_hash:newHash,version:nextVersion,updated_by_app:"ai_training",training_sync_status:"pending_sync",production_vector_status:"not_indexed",staging_vector_status:"not_indexed"};
  const patch=await kbFetch(base,`/api/entities/KBDocument/${encodeURIComponent(documentId)}`,token,{method:"PATCH",body:JSON.stringify(patchBody)});
  if(!patch.ok) return fail(`kb_document_patch_http_${patch.status}`);
  const patched=await patch.json() as Record<string,unknown>;
  if(text(patched.content_hash)!==newHash||text(patched.version)!==nextVersion) return fail("kb_document_patch_verify_failed");

  const idem=`pr6b_${evaluationId.replace(/-/g,"")}`;
  const start=await kbFetch(base,"/api/functions/kbPublishStart",token,{method:"POST",body:JSON.stringify({document_ids:[documentId],idempotency_key:idem})});
  if(!start.ok) return fail(`kb_publish_start_http_${start.status}`);
  const startJson=await start.json() as Record<string,unknown>;
  const operation=(startJson.operation||{}) as Record<string,unknown>;
  const operationId=text(operation.id);
  if(!operationId) return fail("kb_publish_operation_missing");

  await admin.rpc("finish_pr6b_kb_sync_tx",{p_training_link_id:linkId,p_success:true,p_remote_ref:operationId,p_error:null});
  return response({ok:true,contract:WORKER_CONTRACT,processed:1,evaluation_id:evaluationId,document_id:documentId,operation_id:operationId,state:"publish_started"});
});
