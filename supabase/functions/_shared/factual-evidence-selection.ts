import {selectCanonicalGrounding, fullContentSubjectMatch, deriveCurrentGroundingTarget,
  type CanonicalGroundingOptions, type CanonicalGroundingResult, type CurrentGroundingTarget} from "./canonical-grounding.ts";
import {customerOptionSpecifications, hasUnboundSourceOwnedOptionSpecification, optionSpecificationMatches,
  type CurrentFactualRequest, type CurrentFactualDemand} from "./current-factual-request.ts";
import {literalFactualSubject} from "./conversation-semantic-contract.ts";
import type {KBDocumentCandidate, KBFullChunk} from "./kb-client.ts";
import {buildCitationMetadata} from "./citation-lineage.ts";
import {currentKbSellingPrice, exactKbModelIds, resolveCanonicalKbDirectAnswer} from "./canonical-kb-direct-answer.ts";
import {kbProductFieldKey, kbProductRecordPrice, kbProductRecordStock, normalizeCatalogueCode, parseKbProductRecord} from "./kb-product-record.ts";
import {GROUNDING_EVIDENCE_LIMITS, groundingEvidenceText, validGroundingEvidence,
  type GroundingEvidence, type GroundingEvidenceItem, type GroundingDemand, type GroundingDemandResolution,
  type GroundingRejectionReceipt} from "./grounding-evidence.ts";

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

/** Inspect the same full chunk later offered to the verifier. A related
 * title, FAQ, low-scoring sibling or different SKU cannot prove applicability. */
function applicableOptionChunk(chunk: KBFullChunk, demand: CurrentFactualDemand,
  units: ReturnType<typeof customerOptionSpecifications>): boolean {
  if (chunk.chunk_type !== "full_content" || !chunk.chunk_id) return false;
  const record = parseKbProductRecord(chunk.content);
  if (record.ambiguous) return false;
  const brandFields = record.fields.filter(field => /^(?:brand|manufacturer|品牌|製造商|制造商)$/iu.test(kbProductFieldKey(field.key)));
  const categoryFields = record.fields.filter(field => /^(?:category|productcategory|類別|类别|商品類別|商品类别|分類|分类)$/iu.test(kbProductFieldKey(field.key)));
  const contains = (text: string, label: string) => Boolean(literalFactualSubject(text,[label]));
  const customerLabels = (key: string) => [demand.constraints[key]].flat().filter(
    (label): label is string => typeof label === "string" && contains(demand.source_quote,label));
  const scope = demand.option_criteria?.scope ?? [];
  const brand = customerLabels("brand");
  const category = [...new Set([...customerLabels("category"), ...scope.slice(1).map(item=>item.label)])];
  const anchor = scope[0]?.label;
  const identityFields = [...record.names,...brandFields.map(field=>field.value),...categoryFields.map(field=>field.value)];
  if (anchor && !(identityFields.length ? identityFields.some(value=>contains(value,anchor)) : contains(chunk.content,anchor))) return false;
  if (!brand.every(label => brandFields.length
    ? brandFields.every(field => contains(field.value,label))
    : contains(chunk.content,label))) return false;
  if (!category.every(label => categoryFields.length
    ? categoryFields.every(field => contains(field.value,label))
    : contains(chunk.content,label))) return false;
  // Product identity and labelled scalar attributes own numeric facts. A
  // mention in a description or related-product recommendation cannot prove
  // the specification of this SKU.
  const scalarFields = record.fields.filter(field =>
    /^[\d.]+(?:\/\d+)?\s*[\p{L}%°]{1,12}$/u.test(field.value));
  const specificationText = [...record.names,...scalarFields.map(field=>field.value)];
  if (record.format === "unsupported") specificationText.push(chunk.content);
  return units.every(unit => specificationText.some(text=>optionSpecificationMatches(text,unit)));
}

const kbDemand=(demand:CurrentFactualDemand)=>["product","policy","unknown"].includes(demand.source_type);
const APPLICABILITY_FACT=/(?:product_)?suitab|compatib|eligib|\bfit\b|適合|适合|合適|合适|適用|适用/iu,APPLICABILITY_TEXT=/適用|适用|適合|适合|合適|合适|suitab|compatib|recommended\s+(?:room|area)|room\s+(?:area|size)|適用面積|适用面积/iu;
function demandNeedsApplicabilityProof(demand:CurrentFactualDemand){return demand.requested_facts.some(fact=>APPLICABILITY_FACT.test(fact));}
function scalarConstraintValues(value:unknown):string[]{if(typeof value==="string"||typeof value==="number"||typeof value==="boolean")return [String(value)];if(!value||typeof value!=="object"||Array.isArray(value))return [];return Object.values(value as Record<string,unknown>).flatMap(scalarConstraintValues);}
/** Each condition must be supported by the SAME exact full-content
 * chunk. Never infer orientation or other context from a per-scenario keyword
 * translation, another chunk, or the customer's own question. */
function sourceConditionMatches(text:string,value:string):boolean{
 const needle=key(value),haystack=key(text);
 if(!needle||needle==="true"||needle==="false")return false;
 if(/^\d+(?:\.\d+)?$/u.test(needle)){
   const exact=needle.replace(/\./gu,"\\.");
   return new RegExp("(?:^|[^\\p{L}\\p{N}.])"+exact+"(?=$|[^\\p{L}\\p{N}.])","u").test(haystack);
 }
 return haystack.includes(needle);
}
function sourceExplicitlySupportsApplicability(source:FactualEvidenceSource,demand:CurrentFactualDemand){
 if(!demandNeedsApplicabilityProof(demand))return true;
 const conditions=Object.entries(demand.constraints).filter(([name])=>!["brand","name","model","sku","spu"].includes(key(name)));
 return source.selection.chunks.filter(chunk=>chunk.chunk_type==="full_content").some(chunk=>{
  const text=chunk.content.normalize("NFKC");
  return APPLICABILITY_TEXT.test(text)&&conditions.every(([,value])=>{
   const values=scalarConstraintValues(value).filter(item=>item&&item!=="true"&&item!=="false");
   return values.length>0&&values.every(item=>sourceConditionMatches(text,item));
  });
 });
}

/** Source provenance still uses the existing authority gate. A merchant policy
 * is a candidate for applicability review, not an exact-SKU fact or an order. */
export function selectFactualEvidence(
  documents: KBDocumentCandidate[], request: CurrentFactualRequest,
  options: CanonicalGroundingOptions,
): FactualEvidenceBundle {
  const empty = selectCanonicalGrounding([], options);
  if (!empty.ok) return empty;
  if (request.interpretation_source !== "semantic_demands" || request.demands.length > 12 || documents.length > 10) {
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
    const current = [demand.question, ...demand.subjects, JSON.stringify(demand.constraints)].join("\n");
    // The legacy caller's expectedRegion describes the whole turn. A region
    // mentioned by another demand must not re-scope this demand's product.
    const region = deriveCurrentGroundingTarget(current).region;
    const policy = demand.source_type === "policy";
    const discovery = demand.subjects.length === 0;
    const productOptions = discovery && demand.source_type === "product";
    const literalUnits = productOptions ? customerOptionSpecifications(demand) : [];
    const unboundNumeric = productOptions && !literalUnits.length &&
      hasUnboundSourceOwnedOptionSpecification(demand);
    if (unboundNumeric) {
      coverage.missing_reasons.push("requested_specification_not_supported_by_returned_products");
      continue;
    }
    const constrainedOptions = productOptions && (literalUnits.length > 0 ||
      Boolean(demand.option_criteria?.scope.length) || "brand" in demand.constraints || "category" in demand.constraints);
    const base: CanonicalGroundingOptions = {...options, minScore: options.minScore ?? 0.45,
      requestText: current, currentTurnText: current, expectedSubject: undefined,
      expectedEntityIds: [], expectedTopicIds: [], semanticFactDescriptions: [],
      expectedRegion: region, targetChanged: false, requireSubjectSupport: false};
    if (policy || discovery) {
      const scope = policy ? "policy_candidate" as const : "discovery_candidate" as const;
      const candidates: Selection[] = [];
      for (const document of documents) {
        // Candidate similarity is not a proof of the customer's literal size/capacity.
        if (constrainedOptions && !/product|商品|產品|产品/iu.test(document.source_type)) continue;
        // A product record cannot stand in for a merchant-wide policy about an
        // unnamed/different item. Full-content identity remains necessary.
        if (policy && /product|商品|產品|产品/iu.test(document.source_type) &&
            !demand.subjects.some(subject => fullContentSubjectMatch(subject, document))) continue;
        if (policy && demand.subjects.length && document.authority?.entity_ids?.length &&
            !demand.subjects.some(subject => document.authority?.entity_ids.some(id => key(id) === key(subject)) || fullContentSubjectMatch(subject, document))) continue;
        const selected = selectCanonicalGrounding([document], {...base, evidenceScope: scope});
        if (!selected.ok) return selected;
        if (selected.authority_decision.decision === "CONFLICT_UNRESOLVED") coverage.missing_reasons.push("source_conflict");
        if (!selected.document) continue;
        if (!constrainedOptions) {
          candidates.push(selected);
          continue;
        }
        const matching = selected.chunks.filter(chunk => applicableOptionChunk(chunk,demand,literalUnits));
        if (matching.length) candidates.push({...selected, chunks:matching,
          evidence:selected.evidence.filter(item=>matching.some(chunk=>chunk.chunk_id===item.chunk_id && chunk.content===item.content))});
      }
      // A shared title/claim key/region/version rank does not establish the
      // same applicability scope or a supersession relationship. For example,
      // stock and pre-order delivery periods can legitimately differ. Preserve
      // each eligible policy's full text for the existing semantic verifier to
      // distinguish conditions, exceptions and genuine unresolved conflicts.
      if(constrainedOptions&&!candidates.length)coverage.missing_reasons.push("requested_specification_not_supported_by_returned_products");
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
    const demandSources=sources.filter(source=>source.demand_ids.includes(demand.id));if(!demandSources.length)coverage.missing_reasons.push("no_applicable_source");
    if(demandNeedsApplicabilityProof(demand)&&!demandSources.some(source=>sourceExplicitlySupportsApplicability(source,demand)))coverage.missing_reasons.push("requested_condition_not_supported_by_source");
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

export interface SourceRecordedPartialRecovery {
  reply: string;
  citation_metadata: Record<string, unknown>;
  used_evidence_ids: string[];
  demand_outcomes: Array<{demand_id:string;status:"partial"|"unavailable";reason:string;evidence_ids:string[];answered_fields:string[]}>;
  unresolved_demand_ids: string[];
  recorded_facts: Array<{field:"price_amount"|"price_currency"|"stock_quantity";value:number|string;model:string;demand_id:string;
    evidence_id:string;document_id:string;chunk_id:string;source_field:string;source_message_id:string;
    tenant_id:string;company_id:string;currentness:"unverified";source_currentness:"current"|"unknown"}>;
}

/** Discard rejected generation completely. Only independently bound source
 * fields may be reconstructed; this never verifies current price, live stock,
 * policy applicability or a transaction, and never turns a partial turn complete. */
export function resolveSourceRecordedPartialRecovery(
  bundle: Extract<FactualEvidenceBundle, {ok:true}>, request: CurrentFactualRequest,
  options:{language:"en"|"zh-TW"|"zh-CN";companyId:string;sourceMessageId:string;expectedTenantId:string;preserveQuestionInUnsentDraft?:true;groundingRejection?:GroundingRejectionReceipt},
): SourceRecordedPartialRecovery | null {
  if (!options.companyId || !options.sourceMessageId || !options.expectedTenantId ||
      request.source_message_id !== options.sourceMessageId || request.interpretation_source !== "semantic_demands" ||
      !request.demands.length || !validGroundingEvidence(bundle.grounding)) return null;
  const outcomes: SourceRecordedPartialRecovery["demand_outcomes"] = request.demands.map(demand => ({
    demand_id:demand.id,status:"unavailable",reason:"not_independently_proven",evidence_ids:[],answered_fields:[],
  }));
  const facts: SourceRecordedPartialRecovery["recorded_facts"] = [];
  const replies: string[] = [];
  for (const demand of request.demands) {
    const coverage=bundle.grounding.demands.find(item=>item.id===demand.id),verifierResolution=options.groundingRejection?.demand_resolutions.find(item=>item.demand_id===demand.id);
    const commonEligible=demand.source_type==="product"&&!demand.ambiguity.is_ambiguous&&demand.subjects.length===1&&demand.subject_source_message_ids.length>0&&!demand.customer_correction&&!demand.explicit_negations.length&&Boolean(coverage)&&!coverage!.blocked&&!request.missing_evidence.some(item=>item.demand_id===demand.id);
    const matchedSources=commonEligible?bundle.sources.filter(source=>source.scope==="subject_evidence"&&source.demand_ids.includes(demand.id)&&source.target.entity_ids.length===1&&key(source.target.entity_ids[0])===key(demand.subjects[0])):[];
    const wantedFacts=demand.requested_facts.map(key),wantsFeatures=wantedFacts.length>0&&wantedFacts.every(fact=>/feature|功能/iu.test(fact));
    // After BOTH allowed verifier attempts are malformed, the original draft
    // remains rejected. Only exact, independently bound source fields may
    // survive the output-shape failure, never the draft's unsupported claims.
    const reviewerShapeFailure=options.groundingRejection?.stage==="demand_resolution_shape"||
      options.groundingRejection?.stage==="verifier_output_shape";
    const approvedFeatureVerdict=Boolean(verifierResolution&&["supported","partial"].includes(verifierResolution.status));
    if(commonEligible&&coverage&&wantsFeatures&&
      (approvedFeatureVerdict||(!verifierResolution&&reviewerShapeFailure))&&
      !coverage.missing_reasons.length&&matchedSources.length===1){
      const source=matchedSources[0],authority=source.selection.authority_decision;
      if(authority.decision==="USE_CURRENT_KB"&&authority.provenance.tenant_id===options.expectedTenantId){
        const matches=source.selection.chunks.filter(chunk=>chunk.chunk_type==="full_content"&&Boolean(chunk.chunk_id)).flatMap(chunk=>{
          const item=bundle.grounding.items.find(value=>value.document_id===chunk.document_id&&
            value.chunk_id===chunk.chunk_id&&value.content===chunk.content&&
            value.demand_ids.includes(demand.id)&&value.demand_scopes[demand.id]==="subject_evidence"&&
            coverage.evidence_ids.includes(value.id)&&
            value.source_authority.currentness===authority.provenance.currentness&&
            value.source_authority.authority_class===authority.selected_authority_class&&
            (!verifierResolution||verifierResolution.evidence_ids.includes(value.id)));
          return item?[{chunk,item}]:[];
        });
        // A malformed verdict cannot choose between different chunks.
        if(matches.length===1){
          const {chunk,item}=matches[0],record=parseKbProductRecord(chunk.content);
          if(!record.ambiguous){
            const safeValues=record.fields.filter(field=>
              /^(?:description|details|features?|描述|商品描述|產品描述|产品描述|功能)$/iu.test(kbProductFieldKey(field.key))&&
              field.value.length>=2&&field.value.length<=600&&
              !/(?:成本|銷售價|销售价|售價|售价|特價|特价|庫存|库存|stock|price|cost|[$<>])/iu.test(field.value))
              .map(field=>field.value.replace(/\s+/gu," ").trim()).filter(Boolean).slice(0,2);
            if(safeValues.length){
              const subject=demand.subjects[0],detail=[...new Set(safeValues)].join(options.language==="en"?"; ":"；");
              replies.push(options.language==="en"?"The published source record for "+subject+" describes: "+detail+"."
                :options.language==="zh-CN"?subject+" 的已发布来源记录描述："+detail+"。"
                :subject+" 嘅已發布來源記錄描述："+detail+"。");
              const outcome=outcomes.find(value=>value.demand_id===demand.id)!;
              outcome.status="partial";
              outcome.reason=approvedFeatureVerdict?"source_recorded_features_currentness_unverified":"source_recorded_features_independent_shape_recovery";
              outcome.evidence_ids=[item.id];outcome.answered_fields=["features"];
            }
          }
        }
      }
    }
    const wantsSuitability=wantedFacts.some(fact=>APPLICABILITY_FACT.test(fact));
    if(commonEligible&&coverage&&wantsSuitability&&
      (verifierResolution?.status==="unavailable"||verifierResolution?.status==="partial"||
       coverage.missing_reasons.includes("requested_condition_not_supported_by_source")||
       (!verifierResolution&&reviewerShapeFailure))){
      // The failed verifier does not establish that a source has no answer.
      // State only the missing verification, never claim a fit/booking outcome.
      const subject=demand.subjects[0];
      replies.push(options.language==="en"
        ?"Whether "+subject+" is suitable for your stated conditions has not been verified from the selected source. Confirm the applicable specifications or conditions with the merchant or relevant specialist; no assessment has been booked."
        :options.language==="zh-CN"
        ?"至于 "+subject+" 是否适合你提出的条件，现有来源尚未能可靠核实；需要按相关规格及适用条件向商家或专业人员确认，尚未安排任何评估。"
        :"至於 "+subject+" 是否適合你提出嘅條件，現有來源仍未能可靠核實；要按相關規格及適用條件向商家或相關專業人員確認，目前未有安排評估。");
      const outcome=outcomes.find(value=>value.demand_id===demand.id)!;
      if(outcome.status!=="partial"){outcome.status="unavailable";outcome.reason="applicability_not_independently_verified";outcome.evidence_ids=[];outcome.answered_fields=[];}
    }
    if (demand.source_type !== "product" || demand.ambiguity.is_ambiguous || demand.subjects.length !== 1 ||
        !demand.subject_source_message_ids.length || demand.customer_correction || demand.explicit_negations.length ||
        Object.keys(demand.constraints).length || !demand.requested_facts.some(fact => ["price","stock","availability"].includes(key(fact))) ||
        !demand.requested_facts.every(fact => ["price","stock","availability"].includes(key(fact))) ||
        !coverage || coverage.blocked || coverage.missing_reasons.length ||
        request.missing_evidence.some(item => item.demand_id === demand.id)) continue;
    const sources = bundle.sources.filter(source => source.scope === "subject_evidence" &&
      source.demand_ids.includes(demand.id) && source.target.entity_ids.length === 1 &&
      key(source.target.entity_ids[0]) === key(demand.subjects[0]));
    if (sources.length !== 1) continue;
    const source = sources[0], authority = source.selection.authority_decision;
    if (authority.provenance.tenant_id !== options.expectedTenantId) continue;
    const canonical = resolveCanonicalKbDirectAnswer({request:demand.question,selection:source.selection,language:options.language});
    if (!canonical || !["price","listed_price_unverified","recorded_product_facts"].includes(canonical.kind) ||
        canonical.identity_confirmation_required || canonical.evidence_chunks.length !== 1) continue;
    const chunk = canonical.evidence_chunks[0];
    const item = bundle.grounding.items.find(value => value.document_id === chunk.document_id &&
      value.chunk_id === chunk.chunk_id && value.content === chunk.content && value.demand_ids.includes(demand.id) &&
      value.demand_scopes[demand.id] === "subject_evidence" && coverage.evidence_ids.includes(value.id) &&
      value.source_authority.currentness === authority.provenance.currentness &&
      value.source_authority.authority_class === authority.selected_authority_class);
    if (!item) continue;

    // Discard the rejected LLM draft. The original authenticated catalogue
    // record and this exact demand/chunk/tenant are the ONLY recovery inputs.
    const record=parseKbProductRecord(chunk.content);
    const price=kbProductRecordPrice(record),stock=kbProductRecordStock(record);
    const wanted=demand.requested_facts.map(key);
    const wantsPrice=wanted.includes("price");
    const wantsStock=wanted.includes("stock") || wanted.includes("availability");
    const catalogue=Boolean(source.selection.catalogue_binding);
    const recorded=canonical.recorded_facts?.filter(f=>f.document_id===item.document_id &&
      f.chunk_id===item.chunk_id && f.currentness==="unverified") ?? [];
    const priceBound=wantsPrice && price.reason==="ok" && price.amount!==null && Boolean(price.field) &&
      (!canonical.price_fact || canonical.price_fact.value===price.amount) &&
      (catalogue
        ? recorded.some(f=>f.field==="price_amount" && f.value===price.amount) &&
          (!price.currency || recorded.some(f=>f.field==="price_currency" && f.value===price.currency))
        : exactKbModelIds(demand.subjects[0]).length!==1 || currentKbSellingPrice(chunk.content)===price.amount);
    // A quantity is a snapshot, never proof of live sellable inventory.
    // Accept zero. Reject legacy prose, ambiguous/missing stock and unbound SKU.
    const stockBound=wantsStock && catalogue && record.sku_codes.length===1 &&
      normalizeCatalogueCode(record.sku_codes[0])===normalizeCatalogueCode(demand.subjects[0]) &&
      stock.reason==="ok" && stock.quantity!==null &&
      Boolean(stock.field) && recorded.some(f=>f.field==="stock_quantity" && f.value===stock.quantity);
    if(!priceBound && !stockBound)continue;
    const subject=demand.subjects[0],answeredFields:string[]=[];
    if(priceBound){
      const amount=price.amount!.toLocaleString("en-US",{maximumFractionDigits:4});
      const display=price.currency==="HKD"?"HK$"+amount:price.currency?price.currency+" "+amount:amount;
      const currencyNote=price.currency?"":options.language==="en"?" (currency not specified by the source)"
        :options.language==="zh-CN"?"（来源未注明币别）":"（來源未註明幣別）";
      replies.push(options.language==="en"
        ?"The published product record for "+subject+" contains a selling-price field recording "+display+currencyNote+". This source-recorded amount is not a formal quotation. The current price is unverified; the checkout price still needs merchant verification."
        :options.language==="zh-CN"
        ?subject+" 的已发布商品资料中，价格栏位记录 "+display+currencyNote+"。这只是来源记录，尚未核实现价，并非正式报价；实际结算价仍待商家核实。"
        :subject+" 嘅已發布商品資料中，價格欄位記錄 "+display+currencyNote+"。呢個只係來源記錄，未核實係現價，並非正式報價；實際結帳價仍待商家核實。");
      const provenance={model:subject,demand_id:demand.id,evidence_id:item.id,document_id:item.document_id,
        chunk_id:item.chunk_id,source_field:price.field!,source_message_id:options.sourceMessageId,
        tenant_id:options.expectedTenantId,company_id:options.companyId,currentness:"unverified" as const,
        source_currentness:item.source_authority.currentness};
      facts.push({...provenance,field:"price_amount",value:price.amount!});
      answeredFields.push("price_amount");
      if(price.currency){facts.push({...provenance,field:"price_currency",value:price.currency});answeredFields.push("price_currency");}
    }
    if(stockBound){
      const quantity=stock.quantity!;
      replies.push(options.language==="en"
        ?"The published source record for "+subject+" records a stock quantity of "+quantity+". This is not a live availability guarantee or an inventory reservation; the merchant must verify current availability."
        :options.language==="zh-CN"
        ?subject+" 的已发布资料记录库存数量："+quantity+"。这不是即时可售库存或预留证明，现货仍须商家核实。"
        :subject+" 嘅已發布資料記錄庫存數量："+quantity+"。呢個唔代表即時可售庫存或預留商品；現貨仍須商家核實。");
      facts.push({model:subject,demand_id:demand.id,evidence_id:item.id,document_id:item.document_id,
        chunk_id:item.chunk_id,source_field:stock.field!,source_message_id:options.sourceMessageId,
        tenant_id:options.expectedTenantId,company_id:options.companyId,currentness:"unverified",
        source_currentness:item.source_authority.currentness,field:"stock_quantity",value:quantity});
      answeredFields.push("stock_quantity");
    }
    const outcome=outcomes.find(value=>value.demand_id===demand.id)!;
    outcome.status="partial";
    outcome.reason=priceBound && stockBound?"source_recorded_price_stock_currentness_unverified":
      priceBound?"source_recorded_price_currentness_unverified":"source_recorded_stock_availability_unverified";
    outcome.evidence_ids=[item.id];
    outcome.answered_fields=answeredFields;
  }
  if (!replies.length) return null;
  const used = [...new Set(outcomes.flatMap(item => item.evidence_ids))];
  const citation = buildFactualCitationMetadata(bundle,used,outcomes);
  if (!citation) return null;
  // Keep original customer wording in the stored request/Visitor and every
  // unresolved demand ID, never inside the reply. An echoed question can
  // trigger B2's KNOWN_CONTEXT_RECONFIRMATION against an already-known model.
  // Declarative labels state only what remains unverified, not a live offer.
  const pendingFact = (fact: string, sourceType: CurrentFactualDemand["source_type"]) => {
    const value = key(fact);
    const en = options.language === "en", cn = options.language === "zh-CN";
    if (/(?:price|selling|售價|售价|價錢|价钱|現價|现价|價格|价格)/u.test(value))
      return en ? "price verification pending" : cn ? "售价待核实" : "售價待核實";
    if (/(?:stock|inventor|availab|現貨|现货|庫存|库存)/u.test(value))
      return en ? "live stock verification pending" : cn ? "现货库存待核实" : "現貨庫存待核實";
    if (/(?:feature|specification|功能|規格|规格)/u.test(value))
      return en ? "product features" : cn ? "商品功能" : "商品功能";
    if (APPLICABILITY_FACT.test(value)) return en ? "product suitability" : cn ? "商品适用性" : "產品適用性";
    if (/(?:deliver|ship|dispatch|送貨|送货|物流)/u.test(value))
      return en ? "delivery conditions" : cn ? "配送条件" : "送貨條件";
    if (/(?:return|refund|cancel|退貨|退货|退款|取消)/u.test(value))
      return en ? "return conditions" : cn ? "退换条件" : "退換條件";
    if (/(?:discount|coupon|promotion|優惠|优惠|折扣|促銷|促销)/u.test(value))
      return en ? "promotion applicability" : cn ? "优惠适用条件" : "優惠適用條件";
    return sourceType === "transaction" ? (en ? "transaction status" : cn ? "交易状态" : "交易狀態")
      : sourceType === "policy" ? (en ? "policy applicability" : cn ? "政策适用条件" : "政策適用條件")
      : sourceType === "product" ? (en ? "remaining product details" : cn ? "其余商品资料" : "其餘商品資料")
      : (en ? "remaining details" : cn ? "其余待核实资料" : "其餘待核實資料");
  };
  const pending = options.preserveQuestionInUnsentDraft === true
    ? [...new Set(request.demands.map(demand=>demand.source_quote.trim()))].filter(Boolean)
    : [...new Set(request.demands.map(demand => {
    const factLabels = [...new Set(demand.requested_facts.map(fact => pendingFact(fact,demand.source_type)))];
    const subject = demand.subjects.length === 1
      ? demand.subjects[0].replace(/[?？\r\n]/gu," ").trim().slice(0,100) : "";
    return [subject, (factLabels.length ? factLabels : [pendingFact("",demand.source_type)])
      .join(options.language === "en" ? ", " : "、")].filter(Boolean).join(" — ");
  }))].filter(Boolean);
  const remaining = options.language === "en"
    ? `Still unverified: ${pending.map(question => `“${question}”`).join("; ")}.`
    : options.language === "zh-CN"
    ? `仍待核实：${pending.map(question => `「${question}」`).join("、")}。`
    : `仍待核實：${pending.map(question => `「${question}」`).join("、")}。`;
  const reply = [...new Set(replies),remaining].join("\n\n");
  if (reply.length > GROUNDING_EVIDENCE_LIMITS.answerCharacters) return null;
  return {reply,citation_metadata:citation,used_evidence_ids:used,demand_outcomes:outcomes,
    unresolved_demand_ids:request.demands.map(demand => demand.id),recorded_facts:facts};
}
