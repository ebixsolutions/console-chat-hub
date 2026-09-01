export interface GroundingChunk {
  document_id?: string;
  doc_id?: string;
  chunk_id?: string;
  content: string;
  score: number;
  chunk_type: string;
  source_type: string;
  status?: string;
}
export interface GroundingEvidence {
  document_id: string;
  chunk_id?: string;
  content: string;
  score: number;
  source_type: string;
}
export interface GroundingDocument {
  document_id: string;
  document_score: number;
  chunks: GroundingChunk[];
  llm_context: {
    selected_document_id: string;
    orientation_summary: string | null;
    full_content_evidence: GroundingEvidence[];
  };
}
export type GroundedSelection =
  | { ok: true; document: GroundingDocument | null; chunks: GroundingChunk[]; evidence: GroundingEvidence[] }
  | { ok: false; error: "KB_DOCUMENT_EVIDENCE_MISMATCH" | "KB_EVIDENCE_NOT_PUBLISHED" };

export function selectGroundedDocument(
  documents: GroundingDocument[],
  options: { minScore?: number; policyOnly?: boolean; requirePublished?: boolean } = {},
): GroundedSelection {
  const minScore = Number.isFinite(options.minScore) ? Number(options.minScore) : 0;
  const policyOnly = options.policyOnly === true;
  const requirePublished = options.requirePublished !== false;
  const eligible: Array<{ document: GroundingDocument; chunks: GroundingChunk[]; evidence: GroundingEvidence[]; evidenceScore: number }> = [];

  for (const document of documents ?? []) {
    if (document.llm_context.selected_document_id !== document.document_id) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }
    if ((document.llm_context.full_content_evidence ?? []).some((e) => e.document_id !== document.document_id)) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }
    if ((document.chunks ?? []).some((c) => (c.document_id ?? c.doc_id) !== document.document_id)) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }

    const chunks = (document.chunks ?? []).filter((c) =>
      typeof c.content === "string" && c.content.trim() &&
      typeof c.score === "number" && Number.isFinite(c.score) && c.score >= minScore &&
      (!requirePublished || c.status === "published") &&
      (!policyOnly || c.source_type.toLowerCase().includes("policy"))
    );
    const fullIds = new Set(chunks.filter((c) => c.chunk_type === "full_content").map((c) => c.chunk_id ?? c.content));
    const evidence = (document.llm_context.full_content_evidence ?? []).filter((e) =>
      e.document_id === document.document_id &&
      typeof e.content === "string" && e.content.trim() &&
      typeof e.score === "number" && Number.isFinite(e.score) && e.score >= minScore &&
      (!policyOnly || e.source_type.toLowerCase().includes("policy")) &&
      fullIds.has(e.chunk_id ?? e.content)
    );

    if (requirePublished && evidence.length > 0 && chunks.every((c) => c.status !== "published")) {
      return { ok: false, error: "KB_EVIDENCE_NOT_PUBLISHED" };
    }
    if (!evidence.length) continue;
    eligible.push({
      document, chunks, evidence,
      evidenceScore: Math.max(...evidence.map((e) => e.score), 0),
    });
  }

  eligible.sort((a, b) =>
    b.document.document_score - a.document.document_score ||
    b.evidenceScore - a.evidenceScore ||
    a.document.document_id.localeCompare(b.document.document_id)
  );
  const winner = eligible[0];
  return winner
    ? { ok: true, document: winner.document, chunks: winner.chunks, evidence: winner.evidence }
    : { ok: true, document: null, chunks: [], evidence: [] };
}
