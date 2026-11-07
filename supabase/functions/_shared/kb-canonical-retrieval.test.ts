import { fetchKBRag, type KBEndpointConfig, type KBResolvedScope } from "./kb-client.ts";
import { deriveCurrentGroundingTarget, selectCanonicalGrounding } from "./canonical-grounding.ts";
import { buildCitationMetadata } from "./citation-lineage.ts";
import { classifyNaturalCustomerIntent } from "./natural-customer-response.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const scope: KBResolvedScope = {
  mode: "canonical", aiCompanyId: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
  singaporeTenantId: "123",
};
const endpoint: KBEndpointConfig = {
  baseUrl: "https://kb.example.test", ragUrl: "https://kb.example.test/api/v1/rag/context-search",
  jwtTtlSec: 300, tenantTokens: {}, tenantApiKeys: { "123": "mock-scoped-api-key-123" },
  apiKeyHeaderMode: "x-api-key",
};
const product = "PANASONIC 樂聲 CW-SUL90BA";
const customer = `有沒有 ${product}`;
const response = (tenantId = "123") => ({
  success: true, context_found: true,
  selected_documents: [{
    document_id: "sg-doc-example", title: product, source_type: "product",
    document_score: 0.93,
    authority: { tenant_id: tenantId, publication_state: "published", currentness: "current", entity_ids: ["CW-SUL90BA"] },
    summary: null,
    evidence: [{ chunk_id: "sg-chunk-example", chunk_type: "full_content", score: 0.91,
      content: `Product name: ${product}. This is a product entry; stock availability is not specified.` }],
  }],
});

async function withMockFetch<T>(handler: typeof fetch, work: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await work(); } finally { globalThis.fetch = original; }
}

Deno.test("Singapore KB exact SKU: grounded evidence and document/chunk citation lineage", async () => {
  await withMockFetch(async (input, init) => {
    assert(String(input) === endpoint.ragUrl, "wrong_endpoint");
    assert(init?.headers && new Headers(init.headers).get("x-api-key") === "mock-scoped-api-key-123", "wrong_tenant_credential");
    const body = JSON.parse(String(init.body));
    assert(body.company_id === 123 && body.query.includes("CW-SUL90BA"), "wrong_company_or_query");
    return Response.json(response());
  }, async () => {
    const result = await fetchKBRag({ query: product, top_k: 5 }, scope, endpoint);
    assert(result.success && result.chunks.length === 1, JSON.stringify(result));
    const target = deriveCurrentGroundingTarget(customer, product);
    const selected = selectCanonicalGrounding(result.documents, {
      minScore: 0.45, requirePublished: true, requestText: product, currentTurnText: customer,
      expectedTenantId: scope.singaporeTenantId, expectedEntityIds: target.entity_ids,
      expectedTopicIds: target.topic_ids, requiresCurrentKb: true,
    });
    assert(selected.ok && selected.document?.document_id === "sg-doc-example" && selected.evidence[0]?.chunk_id === "sg-chunk-example", JSON.stringify(selected));
    const citation = buildCitationMetadata(selected.chunks, selected.document.document_id, {
      authorityDecision: selected.authority_decision,
      currentTarget: target,
    });
    assert(citation && JSON.stringify(citation).includes("sg-chunk-example"), "citation_lineage_missing:" + JSON.stringify(selected.authority_decision));
    assert(classifyNaturalCustomerIntent(customer).kind === "product_availability", "wrong_intent");
    console.log("GROUNDED|" + result.chunks[0].content + "|doc=" + selected.document.document_id + "|chunk=" + selected.evidence[0].chunk_id);
  });
});

Deno.test("Singapore KB nonexistent SKU returns honest no-current-evidence envelope", async () => {
  await withMockFetch(async () => Response.json({ success: true, context_found: false, selected_documents: [], citations: [] }), async () => {
    const result = await fetchKBRag({ query: "NONEXISTENT-999999", top_k: 5 }, scope, endpoint);
    assert(result.success && result.chunks.length === 0 && result.documents.length === 0, "fabricated_product");
  });
});

Deno.test("Singapore KB cross-tenant response exposes zero evidence", async () => {
  await withMockFetch(async () => Response.json(response("other-tenant")), async () => {
    const result = await fetchKBRag({ query: product, top_k: 5 }, scope, endpoint);
    assert(!result.success && result.error_code === "KB_AUTH_TENANT_MISMATCH", JSON.stringify(result));
    assert(result.chunks.length === 0 && result.documents.length === 0 && result.citations.length === 0, "tenant_leak");
  });
});

Deno.test("Singapore KB outage and malformed response fail closed", async () => {
  await withMockFetch(async () => new Response("Unavailable", { status: 503 }), async () => {
    const result = await fetchKBRag({ query: product, top_k: 5 }, scope, endpoint);
    assert(!result.success && result.error_code === "KB_HTTP_503" && !result.chunks.length, JSON.stringify(result));
  });
  await withMockFetch(async () => Response.json({ success: true, context_found: true, selected_documents: [] }), async () => {
    const result = await fetchKBRag({ query: product, top_k: 5 }, scope, endpoint);
    assert(!result.success && result.error_code === "KB_SCHEMA_INVALID" && !result.chunks.length, JSON.stringify(result));
  });
});
