import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import { DecisionContextLimitError, mergeDecisionContext, normalizeDecisionContext } from "./bounded-decision-context.ts";

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
  const semanticEntities = trusted?.entities.filter(e => e.confidence >= 0.62) ?? [];
  const topic = trusted?.topic ?? (semanticEntities.length === 1
    ? semanticEntities[0].category_hint ?? semanticEntities[0].name : state?.current_topic);
  const normalize = (value: unknown) => typeof value === "string" ? value.normalize("NFKC").trim().toLowerCase() : "";
  const refs = new Set(trusted?.referents.filter(ref => ref.confidence >= 0.62 && ref.source !== "unknown").map(ref => normalize(ref.ref)) ?? []);
  const subjects = new Set(semanticEntities.flatMap(e => [e.entity_ref,e.name,e.model].map(normalize)).filter(Boolean));
  const active = (state?.entities ?? []).filter(e => !["cancelled", "deferred", "superseded"].includes(e.status));
  const identityValues = (e: typeof active[number]) => [e.entity_id,e.entity_id.replace(/^generic:/,""),e.model,e.attributes.model,e.attributes.name,e.attributes.product_name].map(normalize).filter(Boolean);
  const entities = active.filter(e => refs.size ? identityValues(e).some(v => refs.has(v))
    : subjects.size ? identityValues(e).some(v => subjects.has(v)) || subjects.has(normalize(e.category))
    : normalize(e.category) === normalize(topic) || identityValues(e).includes(normalize(topic)));
  const clean = (text: string) => text.normalize("NFKC").replace(/\s+/g," ").trim();
  const readEntity = (e: typeof entities[number]) => ({
    subject: e.model ?? e.attributes.model ?? e.attributes.product_name ?? e.attributes.name ?? e.category,
    unit: typeof e.attributes.unit === "string" ? clean(e.attributes.unit) : null,
    quantity: e.attributes.quantity_basis === "customer_explicit" ? e.quantity : null,
    constraints: normalizeDecisionContext(e.constraints),
    attributes: normalizeDecisionContext(e.attributes.semantic_attributes),
  });
  // Current-turn values supersede prior values for the same resolved subject.
  const current = semanticEntities.filter(e => !(state?.entities ?? []).some(p =>
    ["cancelled","deferred","superseded"].includes(p.status) &&
    [e.entity_ref,e.name,e.model].some(ref => normalize(ref) && identityValues(p).includes(normalize(ref)))));
  const matches = (e: typeof entities[number], c: typeof current[number]) =>
    [c.entity_ref,c.name,c.model].some(ref => normalize(ref) &&
      [e.entity_id,e.model,e.attributes.model,e.attributes.name,e.attributes.product_name].some(v => normalize(v) === normalize(ref)));
  const prior = entities.filter(e => !current.some(c => matches(e,c)))
    .map(readEntity);
  const context = {
    question: clean(question),
    topic: topic ? clean(topic) : null,
    requested_facts: trusted?.requested_facts ?? [],
    explicit_negations: trusted?.explicit_negations ?? [],
    current: current.map(e => {
      const candidates = entities.filter(p => matches(p,e));
      const previous = candidates.length === 1 ? candidates[0] : null;
      return {subject: e.model ?? e.name, unit:e.unit ?? previous?.attributes.unit ?? null,
        quantity:e.quantity ?? (previous?.attributes.quantity_basis === "customer_explicit" ? previous.quantity : null),
        constraints:mergeDecisionContext(previous?.constraints,e.constraints),
        attributes:mergeDecisionContext(previous?.attributes.semantic_attributes,e.attributes)};
    }),
    prior,
  };
  // The provider accepts one query string, not invented filter parameters.
  // Quoted values remain data; no state/credential/history blob is forwarded.
  const query = JSON.stringify(context);
  if (query.length > 1000) throw new DecisionContextLimitError();
  return query;
}
