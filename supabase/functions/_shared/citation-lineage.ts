import type { KBFullChunk } from "./kb-client.ts";
import type { CurrentGroundingTarget } from "./canonical-grounding.ts";
import type { ReferenceAuthorityDecision } from "./commerce-state-authority.ts";

export interface PersistedKBCitation {
  label: string;
  source_type: string;
  relevance?: "high" | "medium";
  document_id: string;
  chunk_id?: string;
  chunk_type: "full_content";
  target_entity_model: string[];
  target_topics: string[];
  authority_decision: string;
  evidence_state: string;
}

export interface KBCitationMetadata extends Record<string, unknown> {
  citations: PersistedKBCitation[];
  citation_lineage: {
    selected_document_id: string;
    evidence_chunk_ids: string[];
    evidence_count: number;
    current_target: CurrentGroundingTarget;
    authority_decision: string;
    evidence_state: string;
  };
}
export interface CitationAuthorityBinding {
  authorityDecision: ReferenceAuthorityDecision;
  currentTarget: CurrentGroundingTarget;
}

export function buildCitationMetadata(
  chunks: KBFullChunk[],
  selectedDocumentId: string | null,
  binding?: CitationAuthorityBinding,
): KBCitationMetadata | null {
  const selected = (selectedDocumentId ?? "").trim();
  if (!selected) return null;
  if (!binding || binding.authorityDecision.selected_source_id !== selected) return null;
  if (binding.authorityDecision.decision !== "USE_CURRENT_KB") return null;
  const evidenceState = binding.authorityDecision.provenance.currentness ?? "unknown";
  if (evidenceState !== "current") return null;

  const citations: PersistedKBCitation[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    if (citations.length >= 3) break;
    if (chunk.chunk_type !== "full_content") continue;
    if (!chunk.content?.trim()) continue;
    if (!Number.isFinite(chunk.score)) continue;
    if (chunk.document_id !== selected) return null;

    const chunkId = typeof chunk.chunk_id === "string" && chunk.chunk_id.trim()
      ? chunk.chunk_id.trim()
      : undefined;
    if (!chunkId) return null;
    const dedupeKey = chunkId ? `${selected}:${chunkId}` : `${selected}:${chunk.content}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const rawLabel = typeof chunk.title === "string" ? chunk.title.trim().slice(0, 120) : "";
    const rawSourceType = typeof chunk.source_type === "string" ? chunk.source_type.trim().slice(0, 40) : "";
    const relevance: "high" | "medium" = chunk.score >= 0.85 ? "high" : "medium";

    citations.push({
      label: rawLabel || "Knowledge Base source",
      source_type: rawSourceType || "unknown",
      relevance,
      document_id: selected,
      ...(chunkId ? { chunk_id: chunkId } : {}),
      chunk_type: "full_content",
      target_entity_model: [...binding.currentTarget.entity_ids],
      target_topics: [...binding.currentTarget.topic_ids],
      authority_decision: binding.authorityDecision.decision,
      evidence_state: evidenceState,
    });
  }

  if (citations.length === 0) return null;

  return {
    citations,
    citation_lineage: {
      selected_document_id: selected,
      evidence_chunk_ids: citations.flatMap((citation) => citation.chunk_id ? [citation.chunk_id] : []),
      evidence_count: citations.length,
      current_target: { ...binding.currentTarget },
      authority_decision: binding.authorityDecision.decision,
      evidence_state: evidenceState,
    },
  };
}
