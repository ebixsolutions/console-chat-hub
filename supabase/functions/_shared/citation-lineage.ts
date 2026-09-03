import type { KBFullChunk } from "./kb-client.ts";

export interface PersistedKBCitation {
  label: string;
  source_type: string;
  relevance?: "high" | "medium";
  document_id: string;
  chunk_id?: string;
  chunk_type: "full_content";
}

export interface KBCitationMetadata extends Record<string, unknown> {
  citations: PersistedKBCitation[];
  citation_lineage: {
    selected_document_id: string;
    evidence_chunk_ids: string[];
    evidence_count: number;
  };
}

export function buildCitationMetadata(
  chunks: KBFullChunk[],
  selectedDocumentId: string | null,
): KBCitationMetadata | null {
  const selected = (selectedDocumentId ?? "").trim();
  if (!selected) return null;

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
    });
  }

  if (citations.length === 0) return null;

  return {
    citations,
    citation_lineage: {
      selected_document_id: selected,
      evidence_chunk_ids: citations.flatMap((citation) => citation.chunk_id ? [citation.chunk_id] : []),
      evidence_count: citations.length,
    },
  };
}
