import {selectCanonicalGrounding, fullContentSubjectMatch, deriveCurrentGroundingTarget,
  type CanonicalGroundingOptions, type CanonicalGroundingResult, type CurrentGroundingTarget} from "./canonical-grounding.ts";
import type {CurrentFactualRequest, CurrentFactualDemand} from "./current-factual-request.ts";
import type {KBDocumentCandidate, KBFullChunk} from "./kb-client.ts";
import {buildCitationMetadata} from "./citation-lineage.ts";
import {GROUNDING_EVIDENCE_LIMITS, groundingEvidenceText, validGroundingEvidence,
  type GroundingEvidence, type GroundingEvidenceItem, type GroundingDemand, type GroundingDemandResolution} from "./grounding-evidence.ts";

type Selection = Extract<CanonicalGroundingResult, {ok: true}>;
export interface FactualEvidenceSource {
  selection: Selection;
  target: CurrentGroundingTarget;
  demand_ids: string[];
  scope: GroundingEvidenceItem["scope"];
}
export type FactualEvidenceBundle = {
  ok: true;
  primary: Selection;
  sources: FactualEvidenceSource[];
  grounding: GroundingEvidence;
  chunks: KBFullChunk[];
} | Extract<CanonicalGroundingResult, {ok: false}>;

const key = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const sourceKey = (document: string, chunk: string) => JSON.stringify([document, chunk]);
const kbDemand = (demand: CurrentFactualDemand) => ["product", "policy", "unknown"].includes(demand.source_type);

/** Source provenance still uses the existing authority gate. A merchant policy
 * is a candidate for applicability review, not an exact-SKU fact or an order. */
export function selectFactualEvidence(
  documents: KBDocumentCandidate[], request: CurrentFactualRequest,
  options: CanonicalGroundingOptions,
): FactualEvidenceBundle {
  const empty = selectCanonicalGrounding([], options);
  if (!empty.ok) return empty;
  if (request.interpretation_source !== "semantic_demands" || request.demands.length > 12 || documents.length > 5) {
    return {ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH"};
  }
  // Never repair mismatched content by copying another chunk's identity.
  for (const document of documents) {
    if (document.llm_context.selected_document_id !== document.document_id ||
        document.chunks.some(chunk => chunk.document_id !== document.document_id) ||
        document.llm_context.full_content_evidence.some(evidence => evidence.document_id !== document.document_id ||
          !document.chunks.some(chunk => chunk.chunk_type === "full_content" && chunk.chunk_id === evidence.chunk_id && chunk.content === evidence.content))) {
      return {ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH"};
    }
  }
  const sources: FactualEvidenceSource[] = [];
  const demands: GroundingDemand[] = [];
  let primary: Selection = empty;
  const append = (selection: Selection, demand: CurrentFactualDemand, scope: GroundingEvidenceItem["scope"], target: CurrentGroundingTarget) => {
    if (!selection.document || selection.authority_decision.decision !== "USE_CURRENT_KB") return;
    // Keep the exact chunk subset/target of this demand. One document can
    // contain separate SKU rows; document identity alone cannot merge them.
    sources.push({selection, demand_ids: [demand.id], scope, target});
    if (!primary.document) primary = selection;
  };
  for (const demand of request.demands) {
    const missing = request.missing_evidence.filter(item => item.demand_id === demand.id).map(item => item.reason);
    const blocked = demand.ambiguity.is_ambiguous || missing.some(reason => reason !== "live_transaction_unavailable");
    const coverage: GroundingDemand = {id: demand.id, source_type: demand.source_type, evidence_ids: [], missing_reasons: [...missing], blocked};
    demands.push(coverage);
    if (!kbDemand(demand) || blocked) continue;
    const current = [demand.source_quote, ...demand.subjects, JSON.stringify(demand.constraints)].join("\n");
    // The legacy caller's expectedRegion describes the whole turn. A region
    // mentioned by another demand must not re-scope this demand's product.
    const region = deriveCurrentGroundingTarget(current).region;
    const policy = demand.source_type === "policy";
    const discovery = demand.subjects.length === 0;
    const base: CanonicalGroundingOptions = {...options, minScore: options.minScore ?? 0.45,
      requestText: current, currentTurnText: current, expectedSubject: undefined,
      expectedEntityIds: [], expectedTopicIds: [], semanticFactDescriptions: [],
      expectedRegion: region, targetChanged: false, requireSubjectSupport: false};
    if (policy || discovery) {
      const scope = policy ? "policy_candidate" as const : "discovery_candidate" as const;
      const candidates: Selection[] = [];
      for (const document of documents) {
        // A product record cannot stand in for a merchant-wide policy about an
        // unnamed/different item. Full-content identity remains necessary.
        if (policy && /product|商品|產品|产品/iu.test(document.source_type) &&
            !demand.subjects.some(subject => fullContentSubjectMatch(subject, document))) continue;
        if (policy && demand.subjects.length && document.authority?.entity_ids?.length &&
            !demand.subjects.some(subject => document.authority?.entity_ids.some(id => key(id) === key(subject)) || fullContentSubjectMatch(subject, document))) continue;
        const selected = selectCanonicalGrounding([document], {...base, evidenceScope: scope});
        if (!selected.ok) return selected;
        if (selected.authority_decision.decision === "CONFLICT_UNRESOLVED") coverage.missing_reasons.push("source_conflict");
        if (selected.document) candidates.push(selected);
      }
      // A shared title/claim key/region/version rank does not establish the
      // same applicability scope or a supersession relationship. For example,
      // stock and pre-order delivery periods can legitimately differ. Preserve
      // each eligible policy's full text for the existing semantic verifier to
      // distinguish conditions, exceptions and genuine unresolved conflicts.
      for (const selected of candidates) {
        const target: CurrentGroundingTarget = {entity_ids: [], topic_ids: [], region,
          explicit_entity: false, explicit_topic: false, target_changed: false};
        append(selected, demand, scope, target);
      }
    } else {
      for (const subject of demand.subjects) {
        const selected = selectCanonicalGrounding(documents, {...base, evidenceScope: undefined,
          expectedSubject: subject, currentTurnText: subject + " " + demand.source_quote,
          semanticFactDescriptions: demand.requested_facts, requireSubjectSupport: true});
        if (!selected.ok) return selected;
        if (!selected.document) coverage.missing_reasons.push("subject_evidence_missing");
        if (!primary.document && selected.catalogue_options?.length) primary = selected;
        if (selected.authority_decision.decision === "CONFLICT_UNRESOLVED") coverage.missing_reasons.push("source_conflict");
        const target: CurrentGroundingTarget = {entity_ids: [subject], topic_ids: [], region,
          explicit_entity: selected.authority_decision.provenance.entity_ids.some(id => key(id) === key(subject)),
          explicit_topic: false, target_changed: false};
        append(selected, demand, "subject_evidence", target);
      }
    }
    if (!sources.some(source => source.demand_ids.includes(demand.id))) coverage.missing_reasons.push("no_applicable_source");
  }
  const items: GroundingEvidenceItem[] = [];
  const selectedChunks = new Map<string, KBFullChunk>();
  let limited = false;
  // Round-robin retains at least the first available chunk from each source
  // before secondary chunks. Whole chunks are omitted with an explicit gap;
  // an exception after character 1200 is never silently chopped off.
  for (let offset = 0; offset < 3; offset++) for (const source of sources) {
    const chunk = source.selection.chunks.filter(item => item.chunk_type === "full_content")[offset];
    if (!chunk) continue;
    const ids = source.demand_ids;
    if (!chunk.chunk_id) {
      for (const demand of demands.filter(item => ids.includes(item.id))) demand.missing_reasons.push("missing_chunk_identity");
      continue;
    }
    const identity = sourceKey(chunk.document_id, chunk.chunk_id);
    const prior = items.find(item => sourceKey(item.document_id, item.chunk_id) === identity);
    if (prior) {
      const previous = prior.demand_ids;
      const previousScopes = prior.demand_scopes;
      prior.demand_ids = [...new Set([...previous, ...ids])];
      prior.demand_scopes = {...previousScopes, ...Object.fromEntries(ids.map(id => [id, source.scope]))};
      if (groundingEvidenceText(items).length > GROUNDING_EVIDENCE_LIMITS.characters) {
        prior.demand_ids = previous; prior.demand_scopes = previousScopes; limited = true;
        for (const demand of demands.filter(value => ids.includes(value.id))) demand.missing_reasons.push("evidence_budget");
      }
      continue;
    }
    const item: GroundingEvidenceItem = {id: "E" + (items.length + 1), document_id: chunk.document_id,
      chunk_id: chunk.chunk_id, content: chunk.content, source_type: chunk.source_type,
      scope: source.scope, demand_ids: [...ids], demand_scopes: Object.fromEntries(ids.map(id => [id, source.scope])), source_authority: {
        authority_class: source.selection.authority_decision.selected_authority_class as "CURRENT_KB" | "PUBLISHED_KB_SERVICE",
        currentness: source.selection.authority_decision.provenance.currentness as "current" | "unknown",
        version: source.selection.authority_decision.provenance.version,
        regions: [...(source.selection.document!.authority?.regions ?? [])],
      }};
    if (items.length >= GROUNDING_EVIDENCE_LIMITS.items || groundingEvidenceText([...items, item]).length > GROUNDING_EVIDENCE_LIMITS.characters) {
      limited = true;
      for (const demand of demands.filter(value => ids.includes(value.id))) demand.missing_reasons.push("evidence_budget");
      continue;
    }
    items.push(item); selectedChunks.set(identity, chunk);
  }
  for (const demand of demands) {
    demand.evidence_ids = items.filter(item => item.demand_ids.includes(demand.id)).map(item => item.id);
    demand.missing_reasons = [...new Set(demand.missing_reasons)];
    if (kbDemand(request.demands.find(item => item.id === demand.id)!) && !demand.evidence_ids.length && !demand.missing_reasons.length) demand.missing_reasons.push("no_applicable_source");
  }
  const grounding: GroundingEvidence = {version: "grounding-evidence-1", items, demands, selection_limited: limited};
  if (!validGroundingEvidence(grounding)) return {ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH"};
  return {ok: true, primary, sources, grounding, chunks: [...selectedChunks.values()]};
}

/** Validate each source independently before combining persisted citations.
 * A primary document's authority/currentness never covers another document. */
export function buildFactualCitationMetadata(bundle: Extract<FactualEvidenceBundle, {ok: true}>, usedIds: string[], resolutions?: GroundingDemandResolution[]): Record<string, unknown> | null {
  const ids = new Set(usedIds);
  if (ids.size !== usedIds.length || usedIds.some(id => !bundle.grounding.items.some(item => item.id === id))) return null;
  const items = bundle.grounding.items.filter(item => ids.has(item.id));
  if (!items.length) return null;
  const documentIds = [...new Set(items.map(item => item.document_id))];
  const citations: unknown[] = [], bindings: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const source of bundle.sources) {
    const documentId = source.selection.document!.document_id;
    const usedForSource = items.filter(item => source.demand_ids.some(id => item.demand_ids.includes(id) &&
      (!resolutions || resolutions.some(resolution => resolution.demand_id === id && resolution.evidence_ids.includes(item.id)))));
    const chunks = source.selection.chunks.filter(chunk => usedForSource.some(item => item.document_id === chunk.document_id && item.chunk_id === chunk.chunk_id && item.content === chunk.content));
    if (!chunks.length) continue;
    const citation = buildCitationMetadata(chunks, documentId,
      {authorityDecision: source.selection.authority_decision, currentTarget: source.target});
    if (!citation) return null;
    for (const item of citation.citations) {
      const identity = sourceKey(item.document_id, item.chunk_id!);
      if (!seen.has(identity)) { citations.push(item); seen.add(identity); }
    }
    bindings.push({...citation.citation_lineage, demand_ids: source.demand_ids.filter(id => usedForSource.some(item =>
      chunks.some(chunk => chunk.document_id === item.document_id && chunk.chunk_id === item.chunk_id) && item.demand_ids.includes(id) &&
      (!resolutions || resolutions.some(resolution => resolution.demand_id === id && resolution.evidence_ids.includes(item.id))))),
      reference_authority: source.selection.authority_decision});
  }
  if (items.some(item => !seen.has(sourceKey(item.document_id, item.chunk_id)))) return null;
  return {citations, reference_authority: documentIds.length === 1 ? bindings[0].reference_authority : null,
    reference_authorities: bindings.map(binding => ({document_id: binding.selected_document_id,
      demand_ids: binding.demand_ids, ...(binding.reference_authority as Record<string, unknown>)})), citation_lineage: {
    selected_document_id: documentIds.length === 1 ? documentIds[0] : null,
    selected_document_ids: documentIds, source_bindings: bindings,
    evidence_chunk_ids: items.map(item => item.chunk_id), evidence_count: items.length,
  }};
}

export function canUseSingleDemandDirectAnswer(request?: CurrentFactualRequest): boolean {
  if (!request || request.interpretation_source !== "semantic_demands") return true;
  const demand = request.demands[0];
  return request.demands.length === 1 && demand.source_type === "product" && !demand.ambiguity.is_ambiguous &&
    demand.subjects.length === 1 && demand.subject_source_message_ids.length > 0 &&
    demand.requested_facts.length > 0 && demand.requested_facts.every(fact => ["price", "stock"].includes(fact)) &&
    Object.keys(demand.constraints).length === 0 && demand.explicit_negations.length === 0 && !request.missing_evidence.length;
}
