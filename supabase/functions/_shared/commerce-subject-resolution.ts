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
/** Presentation only: committed customer labels, never internal IDs. */
export function safeCustomerDisplayText(value: unknown, internalId?: string | null): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > 160 || /[\x00-\x1f\x7f]/u.test(text) ||
    /^(?:contextual-(?:item|goal)(?::|$)|generic:|entity:)|(?:^|\s)scope#\d+/iu.test(text) ||
    (internalId && text.toLowerCase() === internalId.trim().toLowerCase())) return null;
  return text;
}
export function customerOwnedDisplayLabel(entity: CommerceEntity): string | null {
  if (entity.provenance.source_type !== "customer" ||
      typeof entity.provenance.source_message_id !== "string" ||
      !entity.provenance.source_message_id.trim()) return null;
  for (const value of [entity.attributes.product_name, entity.attributes.name,
    entity.attributes.original_name, entity.attributes.display_name, entity.model, entity.attributes.sku]) {
    const label = safeCustomerDisplayText(value, entity.entity_id);
    if (label) return label;
  }
  return null;
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
  options:{include_inactive?:boolean;accepted_entity_ref?:string|null;mode?:"read"|"mutation"}={}
):{kind:"one";entity:CommerceEntity}|{kind:"ambiguous";entity_ids:string[]}|{kind:"none"} {
  const q=clean(question);if(!q)return{kind:"none"};
  // State mutation requires the entire customer-recorded name/short alias or
  // an independently server-accepted exact entity ID. Chinese two-char overlap
  // remains read-only discovery and NEVER grants cancellation or quantity edit.
  const wholeMutationLabel=q.replace(
    /(?:暫時唔買住|暫時不買|暂时不买|暫時|暂时|先|請|请|麻煩|麻烦|取消|暫緩|暂缓|唔要|不要|改做|改為|改为|改|更正|延期|延後|延后|那部|呢部|那個|那个)/gu,""
  ).replace(/\b(?:please|cancel|defer|pause|postpone|remove|change|update|the|item|for|now)\b/giu,"")
   .replace(/[\s，,。.!！?？;；:：]+/gu,"").trim();
  const candidates=state.entities.filter(e=>options.include_inactive || !["cancelled","deferred","superseded"].includes(e.status));
  const accepted=clean(options.accepted_entity_ref);
  const matched=candidates.map(entity=>({entity,score:accepted&&entity.entity_id.toLowerCase()===accepted
    ? 2000 : options.mode==="mutation"
      ? (sourceOwnedSubjectLabels(entity).some(name=>name.replace(/[\s，,。.!！?？;；:：]+/gu,"")===wholeMutationLabel)
        ? 1000+wholeMutationLabel.length:0)
      : Math.max(0,...sourceOwnedSubjectLabels(entity).map(name=>score(q,name)))})).filter(o=>o.score>=2);
  if(!matched.length)return{kind:"none"};
  const max=Math.max(...matched.map(m=>m.score));
  const top=matched.filter(m=>m.score===max);
  return top.length===1?{kind:"one",entity:top[0].entity}:{kind:"ambiguous",entity_ids:top.map(m=>m.entity.entity_id)};
}

/** A source-bound partial-unit partition is one customer requirement with two
 * disjoint persisted portions, not two independent same-named products.
 * Read-only structural proof shared by the reply producer and B2. A category
 * label, model proposal or string match cannot create a partition. */
export interface CanonicalUnitPartition {
  parent: CommerceEntity;
  child: CommerceEntity;
  label: string;
  unit: string;
  source: string;
  status: "cancelled" | "deferred";
}
export function canonicalUnitPartitions(
  state: ConversationCommerceState, source: string | null | undefined,
): CanonicalUnitPartition[] {
  if (!source || !source.trim()) return [];
  return state.entities.flatMap(child => {
    if (child.attributes.customer_unit_partition !== "source_bound_status" ||
        child.constraints.source_bound_partial_unit !== true ||
        (child.status !== "cancelled" && child.status !== "deferred") ||
        child.provenance.source_type !== "customer" ||
        child.provenance.source_message_id !== source ||
        child.attributes.quantity_basis !== "customer_explicit" ||
        !Number.isSafeInteger(child.quantity) || child.quantity < 1) return [];
    const parentId = child.attributes.customer_part_of_entity_id;
    if (typeof parentId !== "string" || !parentId || parentId === child.entity_id ||
        child.entity_id !== parentId + ":unit-status:" + source ||
        state.entities.filter(e => e.entity_id === child.entity_id).length !== 1 ||
        state.entities.filter(e => e.attributes.customer_part_of_entity_id === parentId &&
          e.attributes.customer_unit_partition === "source_bound_status").length !== 1) return [];
    const parents = state.entities.filter(e => e.entity_id === parentId);
    if (parents.length !== 1) return [];
    const parent = parents[0], unit = parent.attributes.unit, label = customerOwnedDisplayLabel(parent);
    if (!label || typeof unit !== "string" || !unit || unit !== unit.trim() ||
        unit.length > 64 || !/^[\p{L}\p{N}\p{M}]+(?:[ ./_-][\p{L}\p{N}\p{M}]+)*$/u.test(unit) ||
        child.attributes.unit !== unit || customerOwnedDisplayLabel(child) !== label ||
        parent.provenance.source_type !== "customer" || parent.provenance.source_message_id !== source ||
        parent.attributes.quantity_basis !== "customer_explicit" ||
        Object.prototype.hasOwnProperty.call(parent.attributes,"customer_part_of_entity_id") ||
        ["cancelled","deferred","superseded"].includes(parent.status) ||
        parent.category !== child.category || parent.model !== child.model || parent.brand !== child.brand ||
        !Number.isSafeInteger(parent.quantity) || parent.quantity < 1 ||
        !Number.isSafeInteger(parent.quantity + child.quantity) ||
        parent.constraints.customer_inactive_unit_count !== child.quantity ||
        parent.constraints.customer_inactive_unit_status !== child.status) return [];
    // A competing item with the same customer-owned label cannot be silently
    // folded into this pair. No category-wide quantity or status is inferred.
    const aliases = sourceOwnedSubjectLabels(parent);
    if (state.entities.some(e => e.entity_id !== parentId && e.entity_id !== child.entity_id &&
      sourceOwnedSubjectLabels(e).some(alias => aliases.includes(alias)))) return [];
    return [{parent,child,label,unit,source,status:child.status}];
  });
}

/** Exactly the two customer requirement portions. Not merchant order,
 * refund, booking, entitlement or completed cancellation authority. */
export function renderUnitPartition(
  value: {label:string;unit:string;retained:number;inactive:number;status:"cancelled"|"deferred"},
  language: string,
): string {
  const {label,unit,retained,inactive,status}=value;
  const inactiveLabel = status === "cancelled"
    ? (language === "en" ? "cancelled requirement" : language === "zh-CN" ? "取消的需求" : "取消嘅要求")
    : (language === "en" ? "deferred requirement" : language === "zh-CN" ? "暂缓的需求" : "暫緩嘅要求");
  if (language === "en")
    return "Recorded your requirements for " + label + ": retained " + retained + " " + unit + "; " + inactiveLabel + ": " + inactive + " " + unit + ".";
  if (language === "zh-CN")
    return "已记录你的" + label + "需求：保留 " + retained + " " + unit + "；" + inactiveLabel + "：" + inactive + " " + unit + "。";
  return "已記錄你嘅" + label + "要求：保留 " + retained + " " + unit + "；" + inactiveLabel + "：" + inactive + " " + unit + "。";
}
export function renderCanonicalUnitPartition(pair:CanonicalUnitPartition, language:string):string {
  return renderUnitPartition({label:pair.label,unit:pair.unit,retained:pair.parent.quantity,
    inactive:pair.child.quantity,status:pair.status},language);
}
