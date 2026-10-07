import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";

/** A semantic proposal can select a read, but cannot authorize a fact or mutation. */
export function requiresSemanticKnowledge(frame: CommerceSemanticFrame | null | undefined): boolean {
  return Boolean(frame && frame.confidence >= 0.62 && !frame.ambiguity.is_ambiguous &&
    (frame.requested_facts.length || frame.operation === "ASK_FACT" ||
      ["explore_options", "recommend_options", "compare_options"].includes(frame.intent)));
}

export function scopedServiceKnowledgeQuery(
  question: string,
  frame: CommerceSemanticFrame | null | undefined,
  state: ConversationCommerceState | null,
): string {
  const trusted = frame && frame.confidence >= 0.62 && !frame.ambiguity.is_ambiguous ? frame : null;
  const topic = trusted?.topic ?? state?.current_topic;
  const normalize = (value: unknown) => typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
  const refs = new Set(trusted?.referents.filter(ref => ref.confidence >= 0.62 && ref.source !== "unknown").map(ref => normalize(ref.ref)) ?? []);
  const subjects = new Set(trusted?.entities.filter(e => e.confidence >= 0.62).flatMap(e => [e.entity_ref, e.name, e.model, e.category_hint].map(normalize)).filter(Boolean) ?? []);
  if (topic) subjects.add(normalize(topic));
  const entities = (state?.entities ?? []).filter(e => !["cancelled", "deferred"].includes(e.status) &&
    [e.entity_id, e.entity_id.replace(/^generic:/, ""), e.category, e.model, e.attributes.model, e.attributes.name, e.attributes.product_name].some(value =>
      Boolean(normalize(value)) && (refs.has(normalize(value)) || subjects.has(normalize(value)))));
  const scalarValues = (record: Record<string, unknown>) => Object.values(record).filter(value => typeof value === "string" || typeof value === "number").map(String);
  const parts = [topic, ...entities.flatMap(e => [e.model, e.attributes.model, e.attributes.product_name, e.attributes.name,
    ...scalarValues(e.constraints),
    ...(e.attributes.semantic_attributes && typeof e.attributes.semantic_attributes === "object" && !Array.isArray(e.attributes.semantic_attributes)
      ? scalarValues(e.attributes.semantic_attributes as Record<string, unknown>) : [])]),
    ...(trusted?.entities.filter(e => e.confidence >= 0.62).flatMap(e => [e.name, e.model, ...scalarValues(e.attributes), ...scalarValues(e.constraints)]) ?? []),
    ...(trusted?.requested_facts ?? []), question];
  return [...new Set(parts.filter(value => typeof value === "string" && value.trim()).map(value => String(value).normalize("NFKC").trim()))].join(" ").slice(0, 1000);
}
