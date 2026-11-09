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
    const {error}=await db.from("rag_trace").insert({id:crypto.randomUUID(),
      conversation_id:scope.conversation_id,message_id:scope.source_message_id,
      query_sent:"",top_score:null,kb_source:"protected_pipeline_diagnostic",
      retrieved_chunks:{contract:"c3-protected-pipeline-evidence-v1",stage,
        source_message_id:scope.source_message_id,company_id:scope.company_id,payload}});
    return !error;
  } catch { return false; }
}
