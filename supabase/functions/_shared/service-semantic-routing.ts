import type { SemanticHistoryRow } from "./conversation-semantic-contract.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import { resolveCurrentFactualRequest, serializeCurrentFactualQuery, type CurrentFactualRequest } from "./current-factual-request.ts";

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
  history: SemanticHistoryRow[] = [],
  resolved?: CurrentFactualRequest,
): string {
  // The generator/planner supplies its one source-bound decision. Legacy
  // callers resolve once here; neither path reclassifies a provided contract.
  const input = {question, semantic: frame, commerce: state, history};
  const request = resolved ?? resolveCurrentFactualRequest(input);
  if (request.applicable && request.query !== null) return request.query;
  // Preserve the established typed-context serializer for callers that use
  // this utility to inspect requirements rather than dispatch a factual read.
  const trusted = frame && frame.confidence >= 0.62 && !frame.ambiguity.is_ambiguous ? frame : null;
  return serializeCurrentFactualQuery(input, {
    ...request,
    requested_facts: trusted?.requested_facts ?? [],
  }, true);
}
