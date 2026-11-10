/** Private Admin/Tenant evidence only. Never include in public logs or replies. */
export interface ProtectedDiagnosticText {
  capture_origin: string;
  capture_state: "CAPTURED" | "WITHHELD_OVERSIZED" | "WITHHELD_SENSITIVE";
  sha256: string; bytes: number; body: string | null;
}
async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,"0")).join("");
}
export async function captureProtectedDiagnosticText(
  value: string,
  origin: ProtectedDiagnosticText["capture_origin"],
): Promise<ProtectedDiagnosticText> {
  const bytes = new TextEncoder().encode(value).byteLength;
  const hash = await sha256(value);
  // Whole-body withholding avoids retaining a partially scrubbed credential or
  // reporting truncated data as the actual complete model response.
  let inspected = value;
  // Inspect escaped JSON strings too, without changing the captured bytes.
  try { inspected += "\n" + JSON.stringify(JSON.parse(value)); } catch { /* Preserve malformed model text as received. */ }
  const sensitive = /\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b|(?<![A-Za-z0-9])(?:\+?852[- .]?)?[23569]\d{3}[- .]?\d{4}(?![A-Za-z0-9])|(?<![A-Za-z0-9])\+\d{1,3}(?:[ .()-]?\d){7,14}(?![A-Za-z0-9])|\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})|\b(?:password|authorization|x-api-key|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|private[_ -]?key|client[_ -]?secret|service[_ -]?role[_ -]?key)\b/i.test(inspected.normalize("NFKC"));
  const state = bytes > 65_536 ? "WITHHELD_OVERSIZED" : sensitive ? "WITHHELD_SENSITIVE" : "CAPTURED";
  return {capture_origin: origin, capture_state: state, sha256: hash, bytes,
    body: state === "CAPTURED" ? value : null};
}


/** Closed, PII-free gate decision receipt. The original captured payload is
 * retained separately; unknown historic decisions are never reconstructed. */
export async function safeGateReasonReceipt(scope:{
 company_id:string;conversation_id:string;source_message_id:string;
},stage:string,evidence:unknown,payload:ProtectedDiagnosticText){
 const gates:Record<string,string>={grounding_verdict:"grounding_verifier",assist_grounding_verdict:"grounding_verifier",b2_verdict:"b2",semantic_validation:"semantic_validation",recovery_decision:"recovery"};
 const gate=gates[stage];if(!gate)return null;
 const obj=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
 const x=obj(evidence),verdict=obj(x.verdict),rejection=obj(verdict.rejection),decision=obj(x.decision);
 const allow=new Set(["raw_not_array","demand_count_mismatch","invalid_grounding_evidence","invalid_item",
 "unexpected_key","unknown_or_duplicate_demand","invalid_status","invalid_evidence_ids",
 "evidence_id_not_used_or_bound","blocked_demand_must_be_unavailable","kb_resolution_requires_evidence",
 "unavailable_cannot_cite_evidence","supported_with_missing_reasons","used_evidence_unattributed",
 "question_resolution_missing","question_resolution_unsupported","question_resolution_demand_inconsistent",
 "unsupported_semantic_claim","verifier_invalid_output","verifier_demand_resolution_invalid",
 "question_not_resolved_by_applicable_evidence"]);
 const reason=(v:unknown)=>typeof v==="string"&&allow.has(v)?v:null;
 const code=(v:unknown)=>typeof v==="string"&&/^[A-Z0-9_]{3,80}$/u.test(v)?v:null;
 const fired=gate==="grounding_verifier"?reason(rejection.reason)??reason(verdict.reason):
   gate==="b2"?code(decision.code):gate==="recovery"?code(x.fallback_condition):code(x.failure_code);
 const outcome=gate==="grounding_verifier"?verdict.ok===true?"accepted":verdict.ok===false?"rejected":"NOT_CAPTURED":
   gate==="b2"?decision.decision==="allow"?"accepted":decision.decision==="block"?"rejected":"NOT_CAPTURED":
   gate==="recovery"?"fallback_selected":x.accepted===true?"accepted":x.accepted===false?"rejected":"NOT_CAPTURED";
 const fault=gate==="grounding_verifier"?
   rejection.stage==="demand_resolution_shape"||fired==="question_resolution_missing"||
   fired==="question_resolution_demand_inconsistent"?"reviewer_output_shape":
   rejection.stage==="semantic_claims"||fired==="unsupported_semantic_claim"?"content":"NOT_CAPTURED":
   gate==="b2"&&outcome==="rejected"?"policy":"NOT_CAPTURED";
 const demands=Array.isArray(rejection.demand_resolutions)?rejection.demand_resolutions.slice(0,12).flatMap(v=>{
   const d=obj(v);
   if(typeof d.demand_id!=="string"||!/^demand-(?:[1-9]|1[0-2])$/u.test(d.demand_id)||
      !["supported","partial","unavailable"].includes(String(d.status)))return [];
   return [{demand_id:d.demand_id,status:d.status,evidence_ids:Array.isArray(d.evidence_ids)?
     d.evidence_ids.filter(t=>typeof t==="string"&&/^E(?:[1-9]|1[0-5])$/u.test(t)).slice(0,15):[]}];
 }):[];
 const candidate=typeof x.candidate==="string"&&x.candidate.length<=65536?x.candidate:null;
 const candidate_ref=candidate===null?null:{sha256:await sha256(candidate),bytes:new TextEncoder().encode(candidate).length};
 return {contract:"c3-gate-reason-v1",gate,outcome,fired_condition:fired??"NOT_CAPTURED",
  fault_class:fault,per_demand:demands,candidate_ref,
  capture_state:payload.capture_state,selected_fallback:typeof x.selected_fallback==="string"&&
    /^[a-z_]{4,80}$/u.test(x.selected_fallback)?x.selected_fallback:null,
  source_binding:{...scope,state_revision:typeof x.state_revision==="number"&&Number.isSafeInteger(x.state_revision)?
    x.state_revision:null,runtime_source_identity:"NOT_CAPTURED"},
  commit_confirmed:gate==="b2"?x.committed===true?true:x.committed===false?false:null:null};
}
/** Callers supply server-resolved IDs. Verify again before the existing RLS
 * protected sink; capture failure never changes business decisions or retries. */
export async function writeProtectedPipelineEvidence(db: any, scope: {
  company_id: string; conversation_id: string; source_message_id: string;
}, stage: string, evidence: unknown): Promise<boolean> {
  try {
    if (![scope.company_id,scope.conversation_id,scope.source_message_id].every(value=>typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))) return false;
    const {data: ticket,error: te}=await db.from("conversations").select("id,company_id")
      .eq("id",scope.conversation_id).eq("company_id",scope.company_id).maybeSingle();
    if (te || ticket?.id!==scope.conversation_id || ticket.company_id!==scope.company_id) return false;
    const {data: source,error: se}=await db.from("messages").select("id,conversation_id,role,is_recalled")
      .eq("id",scope.source_message_id).eq("conversation_id",scope.conversation_id).maybeSingle();
    if (se || source?.id!==scope.source_message_id || source.conversation_id!==scope.conversation_id ||
      source.role!=="visitor" || source.is_recalled!==false) return false;
    const payload=await captureProtectedDiagnosticText(JSON.stringify(evidence),"SERVER_PIPELINE_SNAPSHOT");
    const decision_receipt=await safeGateReasonReceipt(scope,stage,evidence,payload);
    const {error}=await db.from("rag_trace").insert({id:crypto.randomUUID(),
      conversation_id:scope.conversation_id,message_id:scope.source_message_id,
      query_sent:"",top_score:null,kb_source:"protected_pipeline_diagnostic",
      retrieved_chunks:{contract:"c3-protected-pipeline-evidence-v1",stage,
        source_message_id:scope.source_message_id,company_id:scope.company_id,payload,...(decision_receipt?{decision_receipt}:{})}});
    return !error;
  } catch { return false; }
}
