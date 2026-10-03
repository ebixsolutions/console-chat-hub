import type { NaturalCustomerIntent } from "./natural-customer-response.ts";

type FactualIntent = Extract<NaturalCustomerIntent, { kind: "product_factual_query" }>;

export interface ProductKbSemanticContract {
  referent: string;
  category: string | null;
  facets: FactualIntent["facts"];
  query: string;
  entity_ids: string[];
  topic_ids: string[];
}

/** A resolved product fact has one authority target through retrieval and filtering. */
export function productKbSemanticContract(
  intent: NaturalCustomerIntent,
  category: string | null,
  customerQuestion: string,
): ProductKbSemanticContract | null {
  if (intent.kind !== "product_factual_query" || !intent.product || !intent.facts.length) return null;
  const referent = intent.product.normalize("NFKC").trim();
  const facets = [...new Set(intent.facts)];
  const normalizedQuestion = customerQuestion.normalize("NFKC").trim();
  return {
    referent,
    category,
    facets,
    query: [referent, category, ...facets, normalizedQuestion].filter(Boolean).join(" ").slice(0, 500),
    entity_ids: [referent],
    // This is an evidence family, not a service classifier label. The entity
    // is still required independently, so another product cannot satisfy it.
    topic_ids: ["product_facts"],
  };
}
