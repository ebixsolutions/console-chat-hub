import {currentKbSellingPrice, exactKbModelIds, resolveCanonicalKbDirectAnswer} from "./canonical-kb-direct-answer.ts";
import type {CurrentFactualRequest} from "./current-factual-request.ts";
import type {FactualEvidenceBundle} from "./factual-evidence-selection.ts";
import type {GroundingVerificationReceipt} from "./grounding-evidence.ts";
import type {B2KbPriceClaim} from "./pre-send-conversion-supervisor.ts";

/** Mint private proof only from the server's selected source and the verifier's
 * actual used aliases. The existing price resolver checks all relevant chunks
 * for conflicting/malformed fields before any individual used chunk can qualify.
 * This neither turns a recorded price into a current quote nor proves discounts. */
export function buildFactualKbPriceClaims(
  bundle: Extract<FactualEvidenceBundle, {ok:true}>, request: CurrentFactualRequest,
  receipt: GroundingVerificationReceipt, companyId: string, sourceMessageId: string, tenantId: string,
): B2KbPriceClaim[] {
  if (!companyId || !sourceMessageId || !tenantId || request.source_message_id !== sourceMessageId) return [];
  const claims: B2KbPriceClaim[] = [], seen = new Set<string>();
  for (const source of bundle.sources) {
    const authority = source.selection.authority_decision;
    if (source.scope !== "subject_evidence" || authority.decision !== "USE_CURRENT_KB" ||
        authority.provenance.currentness !== "current" || authority.provenance.region !== "hong_kong" ||
        authority.provenance.tenant_id !== tenantId || authority.conflict_source_ids.length) continue;
    for (const demandId of source.demand_ids) {
      const demand = request.demands.find(item => item.id === demandId);
      const coverage = bundle.grounding.demands.find(item => item.id === demandId);
      const resolution = receipt.demand_resolutions.find(item => item.demand_id === demandId);
      if (!demand || demand.source_type !== "product" || demand.ambiguity.is_ambiguous ||
          !coverage || coverage.blocked || coverage.missing_reasons.length || !resolution || resolution.status === "unavailable") continue;
      for (const subject of demand.subjects) {
        const models = exactKbModelIds(subject);
        if (models.length !== 1 || !source.target.entity_ids.includes(subject)) continue;
        const model = models[0], factRequest = `${model} selling price`;
        const canonical = resolveCanonicalKbDirectAnswer({request:factRequest,selection:source.selection,language:"en"});
        const fact = canonical?.price_fact;
        if (!fact || fact.model !== model) continue;
        for (const item of bundle.grounding.items) {
          if (!receipt.used_evidence_ids.includes(item.id) || !resolution.evidence_ids.includes(item.id) ||
              item.document_id !== fact.document_id || !item.demand_ids.includes(demandId) ||
              !source.selection.evidence.some(chunk => chunk.document_id === item.document_id && chunk.chunk_id === item.chunk_id && chunk.content === item.content) ||
              !exactKbModelIds(item.content).includes(model) || currentKbSellingPrice(item.content) !== fact.value) continue;
          const identity = JSON.stringify([item.document_id,item.chunk_id,model]);
          if (seen.has(identity)) continue;
          seen.add(identity);
          claims.push({contract:"bound-kb-selling-price-v1",source_message_id:sourceMessageId,demand_id:demandId,evidence_id:item.id,
            proof:{field:"selling_price",value:fact.value,currency:"HKD",model,
              document_id:item.document_id,chunk_id:item.chunk_id,tenant_id:tenantId,company_id:companyId,
              currentness:"current",authority_decision:"USE_CURRENT_KB",request:factRequest,full_content:item.content}});
        }
      }
    }
  }
  return claims;
}
