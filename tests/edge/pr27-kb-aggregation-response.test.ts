import { parseAggregationResponse } from "../../supabase/functions/_shared/kb-aggregation-response.ts";

function assert(v: unknown, label: string): asserts v {
  if (!v) throw new Error(label);
}
function eq(a: unknown, b: unknown, label: string) {
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

Deno.test("aggregation success contract maps one summary plus evidence", () => {
  const r = parseAggregationResponse({
    success: true,
    query: "return policy",
    context_found: true,
    selected_documents: [{
      document_id: "doc-1",
      title: "Return Policy",
      source_type: "policy",
      document_score: 0.91,
      summary: {
        chunk_id: "sum-1",
        chunk_index: 7,
        chunk_type: "rag_summary",
        content: "Return policy overview.",
        score: 0.84,
      },
      evidence: [{
        chunk_id: "ev-1",
        chunk_index: 3,
        chunk_type: "full_content",
        content: "Returns accepted within 7 days.",
        score: 0.91,
      }],
    }],
    llm_context: {
      summary_count: 1,
      evidence_count: 1,
      combined_text: "[SUMMARY]...",
    },
    citations: [{
      document_id: "doc-1",
      label: "Return Policy",
      source_type: "policy",
      relevance: "high",
    }],
    meta: {
      candidate_chunks: 10,
      qualified_chunks: 2,
      selected_documents: 1,
      score_threshold: 0.7,
    },
  });

  assert(r.ok && r.contextFound, "success response");
  eq(r.selectedDocumentId, "doc-1", "selected doc");
  eq(r.chunks.length, 2, "summary + evidence");
  eq(r.llmContext.full_content_evidence.length, 1, "evidence");
  eq(r.meta.returned_summary_count, 1, "summary count");
});

Deno.test("aggregation no-context contract is a successful empty result", () => {
  const r = parseAggregationResponse({
    success: true,
    query: "unknown",
    context_found: false,
    selected_documents: [],
    llm_context: {
      summary_count: 0,
      evidence_count: 0,
      combined_text: "",
    },
    citations: [],
    fallback: {
      required: true,
      reason: "no_qualified_context",
    },
  });

  assert(r.ok && !r.contextFound, "no context success");
  eq(r.chunks.length, 0, "empty chunks");
});

Deno.test("legacy has_context/string llm_context contract is rejected", () => {
  const r = parseAggregationResponse({
    has_context: true,
    reason: "ok",
    llm_context: "[summary] old",
    citations: [],
    documents: [],
  });
  assert(!r.ok, "legacy contract must reject");
  eq(r.error_code, "KB_SCHEMA_INVALID", "schema error");
});

Deno.test("more than three evidence chunks fails closed", () => {
  const evidence = Array.from({ length: 4 }, (_, i) => ({
    chunk_id: `e-${i}`,
    chunk_type: "full_content",
    content: `evidence ${i}`,
    score: 0.8,
  }));
  const r = parseAggregationResponse({
    success: true,
    context_found: true,
    selected_documents: [{
      document_id: "doc",
      title: "Doc",
      source_type: "policy",
      document_score: 0.9,
      summary: null,
      evidence,
    }],
    llm_context: { summary_count: 0, evidence_count: 4, combined_text: "x" },
    citations: [],
  });
  assert(!r.ok, "evidence overflow must fail");
});


Deno.test("producer-compatible faq_pair and section evidence are references, not full-content grounding", () => {
  const r = parseAggregationResponse({
    success: true,
    context_found: true,
    selected_documents: [{
      document_id: "doc-ref",
      title: "",
      source_type: "",
      document_score: 0.88,
      summary: null,
      evidence: [
        {
          chunk_id: "faq-1",
          chunk_type: "faq_pair",
          content: "FAQ reference",
          score: 0.88,
        },
        {
          chunk_id: "sec-1",
          chunk_type: "section",
          content: "Section reference",
          score: 0.82,
        },
      ],
    }],
    llm_context: {
      summary_count: 0,
      evidence_count: 2,
      combined_text: "[EVIDENCE 1]...",
    },
    citations: [{
      document_id: "doc-ref",
      label: "",
      source_type: "",
      relevance: "high",
    }],
    meta: {
      candidate_chunks: 10,
      qualified_chunks: 2,
      selected_documents: 1,
      score_threshold: 0.7,
    },
  });

  assert(r.ok && r.contextFound, "producer response should parse");
  eq(r.chunks.length, 2, "reference chunks retained");
  eq(r.chunks[0].chunk_type, "faq_pair", "faq type preserved");
  eq(r.chunks[1].chunk_type, "section", "section type preserved");
  eq(r.llmContext.full_content_evidence.length, 0, "references must not become factual evidence");
  eq(r.chunks[0].title, "Knowledge Base document", "empty title fallback");
  eq(r.chunks[0].source_type, "knowledge", "empty source type fallback");
});

Deno.test("mixed producer evidence keeps only full_content in factual grounding", () => {
  const r = parseAggregationResponse({
    success: true,
    context_found: true,
    selected_documents: [{
      document_id: "doc-mixed",
      title: "Policy",
      source_type: "policy",
      document_score: 0.92,
      summary: null,
      evidence: [
        { chunk_id: "f-1", chunk_type: "full_content", content: "Authoritative policy text", score: 0.92 },
        { chunk_id: "q-1", chunk_type: "faq_pair", content: "FAQ helper", score: 0.87 },
      ],
    }],
    llm_context: { summary_count: 0, evidence_count: 2, combined_text: "..." },
    citations: [],
    meta: { candidate_chunks: 10, qualified_chunks: 2, selected_documents: 1, score_threshold: 0.7 },
  });
  assert(r.ok && r.contextFound, "mixed response should parse");
  eq(r.chunks.length, 2, "both safe references exposed");
  eq(r.llmContext.full_content_evidence.length, 1, "only full_content grounds LLM");
  eq(r.llmContext.full_content_evidence[0].content, "Authoritative policy text", "correct factual evidence");
});
