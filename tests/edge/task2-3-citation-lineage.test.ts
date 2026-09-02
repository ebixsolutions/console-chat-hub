import { buildCitationMetadata } from "../../supabase/functions/_shared/citation-lineage.ts";
import type { KBFullChunk } from "../../supabase/functions/_shared/kb-client.ts";

function chunk(overrides: Partial<KBFullChunk> = {}): KBFullChunk {
  return {
    document_id: "doc-1",
    chunk_id: "chunk-1",
    title: "Warranty Policy",
    content: "Warranty period is 24 months.",
    score: 0.91,
    chunk_type: "full_content",
    source_type: "policy",
    status: "published",
    ...overrides,
  };
}

Deno.test("persists exact document and chunk lineage for full-content evidence", () => {
  const metadata = buildCitationMetadata([chunk()], "doc-1");
  if (!metadata) throw new Error("expected citation metadata");
  if (metadata.citations.length !== 1) throw new Error("expected one citation");
  if (metadata.citations[0]?.document_id !== "doc-1") throw new Error("document lineage missing");
  if (metadata.citations[0]?.chunk_id !== "chunk-1") throw new Error("chunk lineage missing");
  if (metadata.citations[0]?.chunk_type !== "full_content") throw new Error("citation must be full_content");
  if (metadata.citation_lineage.selected_document_id !== "doc-1") throw new Error("selected document missing");
  if (metadata.citation_lineage.evidence_chunk_ids.join(",") !== "chunk-1") throw new Error("evidence chunk lineage mismatch");
});

Deno.test("orientation summary is never persisted as answer citation", () => {
  const metadata = buildCitationMetadata([
    chunk({ chunk_id: "summary-1", chunk_type: "rag_summary", content: "orientation" }),
    chunk({ chunk_id: "full-1", chunk_type: "full_content", content: "authoritative detail" }),
  ], "doc-1");
  if (!metadata) throw new Error("expected citation metadata");
  if (metadata.citations.length !== 1) throw new Error("summary must be excluded");
  if (metadata.citations[0]?.chunk_id !== "full-1") throw new Error("wrong evidence persisted");
});

Deno.test("cross-document evidence fails closed", () => {
  const metadata = buildCitationMetadata([
    chunk({ document_id: "doc-2", chunk_id: "chunk-x" }),
  ], "doc-1");
  if (metadata !== null) throw new Error("cross-document lineage must be rejected");
});

Deno.test("missing selected document fails closed", () => {
  const metadata = buildCitationMetadata([chunk()], null);
  if (metadata !== null) throw new Error("missing selected document must be rejected");
});

Deno.test("deduplicates repeated evidence chunks and bounds citations to three", () => {
  const metadata = buildCitationMetadata([
    chunk({ chunk_id: "c1" }),
    chunk({ chunk_id: "c1" }),
    chunk({ chunk_id: "c2" }),
    chunk({ chunk_id: "c3" }),
    chunk({ chunk_id: "c4" }),
  ], "doc-1");
  if (!metadata) throw new Error("expected citation metadata");
  const ids = metadata.citations.map((c) => c.chunk_id).join(",");
  if (ids !== "c1,c2,c3") throw new Error(`unexpected bounded lineage: ${ids}`);
  if (metadata.citation_lineage.evidence_count !== 3) throw new Error("evidence count must equal persisted citations");
});

Deno.test("does not persist raw evidence content in citation metadata", () => {
  const secretEvidence = "internal exact evidence body";
  const metadata = buildCitationMetadata([chunk({ content: secretEvidence })], "doc-1");
  if (!metadata) throw new Error("expected citation metadata");
  if (JSON.stringify(metadata).includes(secretEvidence)) throw new Error("raw evidence content leaked into metadata");
});
