import { selectCanonicalGrounding } from "./canonical-grounding.ts";
import { parseAggregationResponse } from "./kb-aggregation-response.ts";
import type { KBDocumentCandidate } from "./kb-client.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function document(
  id: string,
  content: string,
  overrides: Partial<KBDocumentCandidate> = {},
): KBDocumentCandidate {
  const score = overrides.document_score ?? 0.8;
  return {
    document_id: id,
    title: "Policy",
    source_type: "policy",
    document_score: score,
    chunks: [
      {
        document_id: id,
        doc_id: id,
        chunk_id: `${id}-chunk`,
        title: "Policy",
        content,
        score,
        chunk_type: "full_content",
        source_type: "policy",
        status: "published",
      },
    ],
    citations: [],
    llm_context: {
      selected_document_id: id,
      orientation_summary: null,
      full_content_evidence: [
        {
          document_id: id,
          chunk_id: `${id}-chunk`,
          content,
          score,
          source_type: "policy",
        },
      ],
    },
    meta: {
      document_score: score,
      highest_chunk_score: score,
      second_highest_chunk_score: 0,
      returned_summary_count: 0,
      returned_full_content_count: 1,
      dropped_without_document_id: 0,
      dropped_without_content: 0,
    },
    authority: {
      tenant_id: "34",
      publication_state: "published",
      currentness: "current",
      entity_ids: [],
      regions: [],
      language: null,
      version: null,
      version_rank: null,
      updated_at: null,
      source_priority: null,
      claims: [],
    },
    ...overrides,
  };
}

Deno.test("C1 aggregation preserves bounded authority provenance", () => {
  const parsed = parseAggregationResponse({
    success: true,
    context_found: true,
    selected_documents: [
      {
        document_id: "doc-v2",
        title: "Returns",
        source_type: "policy",
        document_score: 0.9,
        company_id: 34,
        metadata: {
          status: "published",
          currentness: "current",
          version_id: "v2",
          version_rank: 2,
          regions: ["hong_kong"],
          entity_ids: ["sku-a"],
          claims: [{ key: "return_days", value: "7" }],
        },
        summary: null,
        evidence: [
          {
            chunk_id: "e1",
            chunk_type: "full_content",
            content: "Return days: 7",
            score: 0.9,
          },
        ],
      },
    ],
    llm_context: { summary_count: 0, evidence_count: 1, combined_text: "" },
    citations: [],
  });
  assert(parsed.ok && parsed.contextFound, "aggregation rejected");
  const authority = parsed.documents[0].authority;
  assert(authority.tenant_id === "34", "numeric tenant provenance lost");
  assert(authority.version === "v2" && authority.version_rank === 2, "version lost");
  assert(authority.claims[0]?.key === "return_days", "claim lost");
});

Deno.test("C1 grounding selects current lower-score evidence over stale high score", () => {
  const stale = document("stale", "Warranty: old", {
    document_score: 0.99,
    authority: {
      ...document("x", "x").authority!,
      currentness: "superseded",
      version_rank: 1,
    },
  });
  stale.chunks[0].status = "superseded";
  const current = document("current", "Warranty: current", {
    document_score: 0.5,
    authority: { ...document("x", "x").authority!, version_rank: 2 },
  });
  const selected = selectCanonicalGrounding([stale, current], {
    minScore: 0,
    requestText: "What is the warranty?",
    expectedTenantId: "34",
    requiresCurrentKb: true,
  });
  assert(
    selected.ok && selected.document?.document_id === "current",
    "current evidence did not win",
  );
});

Deno.test("C1 grounding rejects equal-authority conflicting documents", () => {
  const one = document("one", "Warranty: one year");
  const two = document("two", "Warranty: two years");
  const selected = selectCanonicalGrounding([one, two], {
    minScore: 0,
    requestText: "What is the warranty?",
    expectedTenantId: "34",
  });
  assert(selected.ok && selected.document === null, "conflict selected a document");
  assert(
    selected.ok && selected.authority_decision.decision === "CONFLICT_UNRESOLVED",
    "conflict not surfaced",
  );
});

Deno.test("C1 grounding rejects conflicting chunks inside one current document", () => {
  const conflicting = document("one", "Warranty: one year\nWarranty: two years");
  const selected = selectCanonicalGrounding([conflicting], {
    minScore: 0,
    requestText: "What is the warranty?",
    expectedTenantId: "34",
  });
  assert(selected.ok && selected.document === null, "internal conflict selected evidence");
  assert(
    selected.ok && selected.authority_decision.decision === "CONFLICT_UNRESOLVED",
    "internal conflict not surfaced",
  );
});

Deno.test("C1 grounding enforces tenant, entity, and region bindings", () => {
  const wrongTenant = document("wrong-tenant", "Model A warranty", {
    authority: {
      ...document("x", "x").authority!,
      tenant_id: "99",
      entity_ids: ["model-a"],
      regions: ["taiwan"],
    },
  });
  const wrongEntity = document("wrong-entity", "Model B warranty", {
    authority: {
      ...document("x", "x").authority!,
      entity_ids: ["model-b"],
      regions: ["hong_kong"],
    },
  });
  const wrongRegion = document("wrong-region", "Model A Taiwan warranty", {
    authority: {
      ...document("x", "x").authority!,
      entity_ids: ["model-a"],
      regions: ["taiwan"],
    },
  });
  const selected = selectCanonicalGrounding([wrongTenant, wrongEntity, wrongRegion], {
    minScore: 0,
    requestText: "Model A Hong Kong warranty",
    expectedTenantId: "34",
    expectedEntityIds: ["model-a"],
    expectedRegion: "hong_kong",
    requiresCurrentKb: true,
  });
  assert(selected.ok && selected.document === null, "wrong-bound evidence selected");
  assert(
    selected.ok && selected.authority_decision.rejected.length === 3,
    "binding rejections incomplete",
  );
});
