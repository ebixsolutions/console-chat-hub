/** Verified customer-owned subject identity; no industry or translation table.
 * Selects a candidate only; the caller still verifies original Visitor source,
 * authenticated Company, revision, current status and the intended operation.
 */
import type { CommerceEntity, ConversationCommerceState } from "./commerce-state-contract.ts";
import { matchesReferenceLabel } from "./industry-agent-registry.ts";
const clean = (v: unknown): string => typeof v === "string" ? v.normalize("NFKC").trim().toLowerCase().slice(0,160) : "";
export function sourceOwnedSubjectLabels(e: CommerceEntity): string[] {
  if (e.provenance.source_type !== "customer") return [];
  return [...new Set([e.model,e.attributes.product_name,e.attributes.name,e.attributes.original_name,e.attributes.display_name,e.attributes.sku,
    ...(Array.isArray(e.attributes.customer_subject_aliases) ? e.attributes.customer_subject_aliases : [])]
    .map(clean).filter(v=>v.length>=2))].slice(0,20);
}
function score(q: string,label:string):number {
  if(matchesReferenceLabel(q,label))return 1000+label.length;
  // Only substrings of a customer's actually recorded name; never a category synonym.
  let best=0;
  for(const hit of label.matchAll(/[\p{Script=Han}]{2,}/gu)){
    const token=hit[0];
    for(let length=Math.min(token.length,8);length>=2;length--) {
      for(let at=0;at<=token.length-length;at++) if(q.includes(token.slice(at,at+length)))best=Math.max(best,length);
    }
  }
  return best;
}
export function resolveSourceOwnedSubject(
  state:ConversationCommerceState,question:string,
  options:{include_inactive?:boolean;accepted_entity_ref?:string|null}={}
):{kind:"one";entity:CommerceEntity}|{kind:"ambiguous";entity_ids:string[]}|{kind:"none"} {
  const q=clean(question);if(!q)return{kind:"none"};
  const candidates=state.entities.filter(e=>options.include_inactive || !["cancelled","deferred","superseded"].includes(e.status));
  const accepted=clean(options.accepted_entity_ref);
  const matched=candidates.map(entity=>({entity,score:accepted&&entity.entity_id.toLowerCase()===accepted
    ? 2000 : Math.max(0,...sourceOwnedSubjectLabels(entity).map(name=>score(q,name)))})).filter(o=>o.score>=2);
  if(!matched.length)return{kind:"none"};
  const max=Math.max(...matched.map(m=>m.score));
  const top=matched.filter(m=>m.score===max);
  return top.length===1?{kind:"one",entity:top[0].entity}:{kind:"ambiguous",entity_ids:top.map(m=>m.entity.entity_id)};
}
