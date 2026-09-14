import { deriveCurrentGroundingTarget, selectCanonicalGrounding } from "./canonical-grounding.ts";
import { buildCitationMetadata } from "./citation-lineage.ts";
import { buildCanonicalRetrievalQuery } from "./conversation-runtime-state.ts";
import type { KBDocumentCandidate } from "./kb-client.ts";
import { resolvePriorGroundedTransform } from "./prior-grounded-transform.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function document(id: string, content: string, score = 0.8): KBDocumentCandidate {
  return {
    document_id: id,
    title: "Policy",
    source_type: "policy",
    document_score: score,
    chunks: [{ document_id: id, doc_id: id, chunk_id: `${id}-chunk`, title: "Policy", content, score, chunk_type: "full_content", source_type: "policy", status: "published" }],
    citations: [],
    llm_context: { selected_document_id: id, orientation_summary: null, full_content_evidence: [{ document_id: id, chunk_id: `${id}-chunk`, content, score, source_type: "policy" }] },
    meta: { document_score: score, highest_chunk_score: score, second_highest_chunk_score: 0, returned_summary_count: 0, returned_full_content_count: 1, dropped_without_document_id: 0, dropped_without_content: 0 },
    authority: { tenant_id: "34", publication_state: "published", currentness: "current", entity_ids: [], regions: [], language: null, version: null, version_rank: null, updated_at: null, source_priority: null, claims: [] },
  };
}

function select(documents: KBDocumentCandidate[], currentTurnText: string, requestText: string, fallbackEntities: string[] = []) {
  return selectCanonicalGrounding(documents, {
    minScore: 0,
    requestText,
    currentTurnText,
    expectedTenantId: "34",
    expectedEntityIds: fallbackEntities,
    requiresCurrentKb: true,
    targetChanged: /(?:actually|instead|switch|改|更正|不是|唔係)/i.test(currentTurnText),
  });
}

Deno.test("C1 R2 Basic to Pro correction selects only Pro lineage", () => {
  const result = select([document("basic", "Smoke Test Basic\nSKU limit: 50", 0.99), document("pro", "Smoke Test Pro\nSKU limit: 500", 0.4)], "Actually I mean Smoke Test Pro.", "Current factual target: Smoke Test Pro\nRequested fact: SKU limit\nOld context: Smoke Test Basic");
  assert(result.ok && result.document?.document_id === "pro", "Pro did not replace Basic");
  assert(result.ok && result.chunks.every((chunk) => chunk.document_id === "pro"), "Basic chunk leaked");
});

Deno.test("C1 R2 correction retrieval query removes old target", () => {
  const result = buildCanonicalRetrievalQuery("Actually I mean Smoke Test Pro.", [
    { role: "visitor", content: "Actually I mean Smoke Test Pro." },
    { role: "assistant", content: "Smoke Test Basic supports 50 SKUs." },
    { role: "visitor", content: "What is Smoke Test Basic SKU limit?" },
  ]);
  assert(/Smoke Test Pro/i.test(result.query), "current target missing");
  assert(!/Smoke Test Basic/i.test(result.query), "superseded target leaked");
  assert(result.context_turns.length === 0, "stale context inherited");
});

Deno.test("C1 R2 missing Pro evidence never reuses Basic", () => {
  const result = select([document("basic", "Smoke Test Basic\nSKU limit: 50")], "Actually I mean Smoke Test Pro.", "Smoke Test Pro SKU limit; old Basic context");
  assert(result.ok && result.document === null, "Basic reused for missing Pro");
  assert(result.ok && result.authority_decision.selected_source_id === null, "stale source selected");
});

Deno.test("C1 R2 Product A to Product B isolates source", () => {
  const result = select([document("a", "Product A warranty: one year"), document("b", "Product B warranty: two years")], "Switch to Product B warranty.", "Product B warranty; prior Product A warranty");
  assert(result.ok && result.document?.document_id === "b", "Product A leaked into B");
});

Deno.test("C1 R2 Model X to Model Y isolates source", () => {
  const result = select([document("x", "Model X delivery: Monday"), document("y", "Model Y delivery: Tuesday")], "Actually Model Y delivery.", "Model Y delivery; prior Model X delivery");
  assert(result.ok && result.document?.document_id === "y", "Model X leaked into Y");
});

Deno.test("C1 R2 topic switch rejects incompatible warranty source", () => {
  const result = select([document("warranty", "Product A warranty: one year"), document("delivery", "Product A delivery: Tuesday")], "Switch to Product A delivery.", "Product A delivery; prior warranty");
  assert(result.ok && result.document?.document_id === "delivery", "warranty source leaked");
});

Deno.test("C1 R2 multi-entity answer binds only requested entity", () => {
  const result = select([document("a", "Product A price: 10"), document("b", "Product B price: 20")], "What is Product B price?", "Product B price");
  assert(result.ok && result.document?.document_id === "b", "entity A attached to B");
});

Deno.test("C1 R2 explicit region correction rejects prior market", () => {
  const result = select([document("hk", "Hong Kong delivery: one day"), document("tw", "Taiwan delivery: two days")], "Actually Taiwan delivery.", "Taiwan delivery; prior Hong Kong delivery");
  assert(result.ok && result.document?.document_id === "tw", "HK source leaked into TW");
});

Deno.test("C1 R2 stale higher similarity loses after correction", () => {
  const result = select([document("basic", "Smoke Test Basic\nSKU limit: 50", 1), document("pro", "Smoke Test Pro\nSKU limit: 500", 0.01)], "Actually I mean Smoke Test Pro.", "Smoke Test Basic SKU limit Smoke Test Pro SKU limit");
  assert(result.ok && result.document?.document_id === "pro", "similarity overrode current target");
});

Deno.test("C1 R2 same-topic follow-up retains compatible target", () => {
  const result = select([document("pro", "Smoke Test Pro\nSKU limit: 500")], "And what is the SKU limit?", "Smoke Test Pro SKU limit", ["pro"]);
  assert(result.ok && result.document?.document_id === "pro", "compatible follow-up rejected");
});

function groundedHistory() {
  const target = deriveCurrentGroundingTarget("Smoke Test Basic SKU limit");
  return [{ role: "assistant", content: "Smoke Test Basic supports 50 SKUs.", metadata: {
    source_message_id: "source-1",
    citations: [{ label: "Smoke Test Basic", source_type: "plan", relevance: "high", document_id: "basic", chunk_id: "basic-chunk", chunk_type: "full_content" }],
    citation_lineage: { selected_document_id: "basic", evidence_chunk_ids: ["basic-chunk"], current_target: target, authority_decision: "USE_CURRENT_KB", evidence_state: "current" },
  } }];
}

Deno.test("C1 R2 simplify same target preserves lineage", () => {
  const result = resolvePriorGroundedTransform("Shorten the previous answer.", groundedHistory());
  assert(result?.selected_document_id === "basic", "same-target lineage lost");
});

Deno.test("C1 R2 simplify after target switch rejects old lineage", () => {
  const result = resolvePriorGroundedTransform("Shorten the previous answer, but for Smoke Test Pro.", groundedHistory());
  assert(result === null, "target-switch transform reused Basic");
});

Deno.test("C1 R2 citation provenance is internally consistent", () => {
  const result = select([document("pro", "Smoke Test Pro\nSKU limit: 500")], "Actually I mean Smoke Test Pro.", "Smoke Test Pro SKU limit");
  assert(result.ok && result.document !== null, "Pro unavailable");
  const target = deriveCurrentGroundingTarget("Actually I mean Smoke Test Pro.", "Smoke Test Pro SKU limit", [], [], true);
  const metadata = buildCitationMetadata(result.chunks, "pro", { authorityDecision: result.authority_decision, currentTarget: target });
  assert(metadata?.citations[0]?.document_id === "pro", "wrong document");
  assert(metadata?.citations[0]?.chunk_id === "pro-chunk", "chunk missing");
  assert(metadata?.citations[0]?.target_entity_model.includes("pro"), "target missing");
  assert(metadata?.citations[0]?.authority_decision === "USE_CURRENT_KB", "authority missing");
  assert(metadata?.citations[0]?.evidence_state === "current", "currentness missing");
});

Deno.test("C1 R2 fresh retry binds to fresh target", () => {
  const first = select([document("basic", "Smoke Test Basic\nSKU limit: 50")], "Smoke Test Basic SKU limit?", "Smoke Test Basic SKU limit");
  const retry = select([document("basic", "Smoke Test Basic\nSKU limit: 50"), document("pro", "Smoke Test Pro\nSKU limit: 500")], "Actually I mean Smoke Test Pro.", "Smoke Test Pro SKU limit");
  assert(first.ok && first.document?.document_id === "basic", "initial source invalid");
  assert(retry.ok && retry.document?.document_id === "pro", "retry retained stale source");
});

Deno.test("C1 R2 unresolved current conflict exposes no citation", () => {
  const result = select([document("one", "Product B delivery: Monday"), document("two", "Product B delivery: Tuesday")], "Product B delivery?", "Product B delivery");
  assert(result.ok && result.document === null, "arbitrary source selected");
  assert(result.ok && result.authority_decision.decision === "CONFLICT_UNRESOLVED", "conflict hidden");
});
