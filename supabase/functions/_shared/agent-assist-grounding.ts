export interface AgentAssistEvidence {
  document_id: string;
  chunk_id?: string;
  content: string;
  score: number;
  source_type: string;
}
export interface AgentAssistDocument {
  document_id: string;
  document_score: number;
  llm_context: {
    selected_document_id: string;
    orientation_summary: string | null;
    full_content_evidence: AgentAssistEvidence[];
  };
}
export type GroundingSelection =
  | { ok: true; document: AgentAssistDocument | null; evidence: AgentAssistEvidence[] }
  | { ok: false; error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
function usableEvidence(document: AgentAssistDocument, policyOnly: boolean): AgentAssistEvidence[] | null {
  if (document.llm_context.selected_document_id !== document.document_id) return null;
  const evidence = document.llm_context.full_content_evidence ?? [];
  if (evidence.some((item) => item.document_id !== document.document_id)) return null;
  return evidence.filter((item) => Boolean(item.content?.trim()) && (!policyOnly || item.source_type.toLowerCase().includes("policy")));
}
export function selectAgentAssistGrounding(
  documents: AgentAssistDocument[],
  options: { policyOnly?: boolean } = {},
): GroundingSelection {
  const eligible: Array<{ document: AgentAssistDocument; evidence: AgentAssistEvidence[]; evidenceScore: number }> = [];
  for (const document of documents ?? []) {
    const evidence = usableEvidence(document, options.policyOnly === true);
    if (evidence === null) return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    if (!evidence.length) continue;
    eligible.push({ document, evidence, evidenceScore: Math.max(...evidence.map((e) => Number.isFinite(e.score) ? e.score : 0), 0) });
  }
  eligible.sort((a, b) => b.document.document_score - a.document.document_score || b.evidenceScore - a.evidenceScore || a.document.document_id.localeCompare(b.document.document_id));
  const winner = eligible[0];
  return winner ? { ok: true, document: winner.document, evidence: winner.evidence } : { ok: true, document: null, evidence: [] };
}
