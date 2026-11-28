import { matchesReferenceLabel } from "./industry-agent-registry.ts";
import { resolveSourceOwnedSubject, sourceOwnedSubjectLabels } from "./commerce-subject-resolution.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type { ScopedCustomerValue } from "./contextual-customer-update.ts";
import { sameCanonicalJson } from "./canonical-json.ts";
import type { CustomerJourneyResponseIntent } from "./customer-journey-orchestration.ts";
// Only source-backed canonical entities may supply lifecycle targets.
import { requirementMutationText, splitCustomerOperationClauses } from "./commerce-state-authority.ts";

export interface B2LifecyclePlan {
  action: "deferred" | "cancelled";
  target_category: string;
  /** Present when category alone does not identify one canonical entity. */
  target_entity_id?: string;
  focus_category: string | null;
}

/** Lifecycle and focus are separate clauses. An unbound lifecycle verb is never inferred from history. */
export function resolveEntityLifecyclePlan(
  text: string, state: ConversationCommerceState,
  options: { accepted_entity_ref?: string | null } = {},
): { kind: "mutation"; plans: B2LifecyclePlan[] } | { kind: "ambiguous"; action: "deferred" | "cancelled" } | { kind: "none" } {
  const normalized = requirementMutationText(text).trim().toLowerCase();
  const operation = (part: string): "deferred" | "cancelled" => /取消|唔要|不要|cancel\b/i.test(part) && !/暫時唔|暫時不|暂时不/i.test(part) ? "cancelled" : "deferred";
  const ambiguous = () => ({kind:"ambiguous" as const,action:operation(normalized)});
  const identityValues = (entity: ConversationCommerceState["entities"][number]) => [entity.model,entity.attributes.product_name,entity.attributes.sku].filter((v):v is string=>typeof v==="string" && v.trim().length>=2).map(v=>v.trim().toLowerCase());
  // Identifier tokens are data references, not a catalogue of customer phrases.
  const identifiers = (part: string): string[] => part.match(/\b(?=[a-z0-9_-]*[a-z])(?=[a-z0-9_-]*\d)[a-z0-9]+(?:[-_][a-z0-9]+)*\b/gi) ?? [];

  const aliases = (part: string) => [...new Set([
    ...(() => { const match = resolveSourceOwnedSubject(state, part, { include_inactive: true, mode:"mutation",
      accepted_entity_ref:options.accepted_entity_ref }); return match.kind === "one" ? [match.entity.category] : []; })(),
    // Historical industry taxonomy never supplies implicit lifecycle aliases.
    ...state.entities.filter((entity) =>
      [entity.category, entity.model, entity.attributes.product_name]
        .some((value) => typeof value === "string" && value.trim().length >= 2 &&
          matchesReferenceLabel(part,value)) || identifiers(part).some(id=>identityValues(entity).some(value=>identifiers(value).includes(id)))
    ).map((entity) => entity.category),
  ])];
  const lifecycle = /暫時唔買住|暫時不買|暂时不买|暫時唔|暫時不|暂时不|暫緩|暂缓|先擺低|先放低|稍後先|稍后再|hold off|defer|pause|取消|唔要|不要|cancel\b/i;
  if (!lifecycle.test(normalized)) return { kind: "none" };
  if (/^(?:你仲記唔記得|係咪|有冇|是否|is |was |did )/i.test(normalized)) return { kind: "none" };
  const named = aliases(normalized);
  // Room-scoped cancellation and service/installation actions keep their
  // existing entity/field resolution contract, never become category lifecycle.
  if (/(?:排水|檢查|检查|送貨|送货|delivery|闊度|宽度|高度|深度|尺寸|width|height|depth)/i.test(normalized)) return { kind: "none" };
  const clauses = splitCustomerOperationClauses(normalized.replace(/(?=先搞)|(?=先處理)|(?=先处理)/gu,"；"));
  const lifecycleClauses = clauses.filter((part) => lifecycle.test(part) && !/[?？]/.test(part));
  // A question such as "我要唔要考慮？" contains a negated verb, but does not
  // authorize a lifecycle mutation. Preserve a separate imperative clause if
  // the turn also asks a question.
  if (!lifecycleClauses.length) return { kind: "none" };
  if (!named.length && !/兩樣都|两样都|both\b|暫時唔換|暫時不換|暂时不换/i.test(normalized)) {
    // Strong unbound cancellation/deferral fails closed regardless of language.
    // Ordinary dislike/negation alone is never an implicit cancellation.
    return /取消|暫緩|暂缓|\b(?:cancel|defer|pause)\b/i.test(normalized) ||
      identifiers(normalized).length ? ambiguous() : {kind:"none"};
  }
  const focusClauses = clauses.filter((part) => /(?:先搞|先處理|先处理|focus on|back to|return to)/i.test(part) && !lifecycle.test(part));
  const focusKeys = [...new Set(focusClauses.flatMap(aliases))];
  if (focusKeys.length > 1) return ambiguous();
  const plans: B2LifecyclePlan[] = [];
  for (const [index, part] of lifecycleClauses.entries()) {
    if (/^(?:先)?取消[。.!]?$/i.test(part) && index > 0 && plans.length === 1) {
      plans[0].action = "cancelled";
      continue;
    }
    const sourceMatch = resolveSourceOwnedSubject(state,part,{include_inactive:true,mode:"mutation",
      accepted_entity_ref:options.accepted_entity_ref});
    if(sourceMatch.kind==="ambiguous")return ambiguous();
    // Fuzzy overlap may locate a noun for a read-only answer but must never
    // mutate a whole aggregate merely because it contains a named part.
    const loose=resolveSourceOwnedSubject(state,part,{include_inactive:true});
    if(sourceMatch.kind==="none" && loose.kind!=="none" && !identifiers(part).length)
      return ambiguous();
    let keys = aliases(part);
    if (/兩樣都|两样都|both\b/i.test(part)) {
      // Exactly two verified customer-owned active entities, even if their
      // generic category is identical; no category-wide mutation authority.
      const active=state.entities.filter(entity=>entity.status!=="deferred"&&
        !["cancelled","superseded"].includes(entity.status));
      if(active.length!==2 || active.some(entity=>entity.provenance.source_type!=="customer"))
        return ambiguous();
      for(const entity of active){
        if(plans.some(p=>p.target_entity_id===entity.entity_id))return ambiguous();
        plans.push({target_category:entity.category,target_entity_id:entity.entity_id,
          action:operation(part),focus_category:null});
      }
      continue;
    }
    if (keys.length !== 1 && !/兩樣都|两样都|both\b/i.test(part)) return ambiguous();
    for (const key of keys) {
      const action=operation(part), explicitIds=identifiers(part);
      const namedEntities=sourceMatch.kind==="one"?[sourceMatch.entity]:state.entities.filter(entity=>identityValues(entity).some(value=>matchesReferenceLabel(part,value)) || explicitIds.some(id=>identityValues(entity).some(value=>identifiers(value).includes(id))));
      if(explicitIds.length && explicitIds.some(id=>!namedEntities.some(entity=>identityValues(entity).some(value=>identifiers(value).includes(id)))))return ambiguous();
      const candidates=(namedEntities.length?namedEntities:state.entities.filter(entity=>entity.category===key)).filter(entity=>entity.category===key && (action==="cancelled" || entity.status!=="cancelled"));
      if(candidates.length!==1)return ambiguous();
      const target=candidates[0];
      if(plans.some(plan=>plan.target_entity_id ? plan.target_entity_id===target.entity_id : plan.target_category===target.category))return ambiguous();
      plans.push({target_category:key,action,focus_category:focusKeys[0]??null,...(state.entities.filter(entity=>entity.category===key).length>1 || key.startsWith("generic") ? {target_entity_id:target.entity_id} : {})});
    }
  }
  if (!plans.length || plans.some((plan) =>
    state.entities.filter((entity) => (plan.target_entity_id ? entity.entity_id===plan.target_entity_id : entity.category===plan.target_category) &&
      (plan.action === "cancelled" || entity.status !== "cancelled")).length !== 1 ||
    (plan.focus_category !== null && (plan.focus_category === plan.target_category ||
      state.entities.filter((entity) => entity.category === plan.focus_category &&
        entity.status !== "deferred" && entity.status !== "cancelled").length !== 1))
  )) return ambiguous();
  return { kind: "mutation", plans };
}

export interface B2TrustedLifecycleCommit {
  contract: "entity-lifecycle-commit-v1";
  company_id: string;
  source_message_id: string;
  source_text: string;
  previous_revision: number;
  committed_revision: number;
  plans: B2LifecyclePlan[];
  target_entity_ids: string[];
  previous_state: ConversationCommerceState;
  committed_state: ConversationCommerceState;
  reply: string;
  transaction_before: B2JourneyTransactionBoundary;
  transaction_after: B2JourneyTransactionBoundary;
}

export function verifyEntityLifecycleTransition(
  text: string, before: ConversationCommerceState, after: ConversationCommerceState,
  sourceMessageId: string, acceptedEntityRef: string | null = null,
): { valid: true; plans: B2LifecyclePlan[]; targetIds: string[] } | { valid: false } {
  const resolved = resolveEntityLifecyclePlan(text, before, {accepted_entity_ref:acceptedEntityRef});
  if (resolved.kind !== "mutation" || before.entities.length !== after.entities.length ||
    JSON.stringify(b2JourneyTransactionBoundary(before)) !== JSON.stringify(b2JourneyTransactionBoundary(after))) return { valid: false };
  const targetIds: string[] = [];
  for (const plan of resolved.plans) {
    const old = before.entities.find((entity) => (plan.target_entity_id ? entity.entity_id===plan.target_entity_id : entity.category===plan.target_category) &&
      (plan.action === "cancelled" || entity.status !== "cancelled"));
    if (!old) return { valid: false };
    targetIds.push(old.entity_id);
  }
  const expected = structuredClone(before);
  for (const [index, entity] of expected.entities.entries()) {
    if (!targetIds.includes(entity.entity_id)) continue;
    const changed = after.entities[index];
    if (changed?.entity_id !== entity.entity_id || changed.status !==
      resolved.plans.find((plan) => plan.target_entity_id ? plan.target_entity_id === entity.entity_id : plan.target_category === entity.category)?.action ||
      changed.provenance.source_type !== "customer" ||
      changed.provenance.source_message_id !== sourceMessageId) return { valid: false };
    expected.entities[index] = structuredClone(changed);
    expected.entities[index].quantity = entity.quantity;
    expected.entities[index].attributes = entity.attributes;
    expected.entities[index].constraints = entity.constraints;
    expected.entities[index].model = entity.model;
    expected.entities[index].brand = entity.brand;
  }
  const focus = resolved.plans[0].focus_category;
  if (focus) expected.current_topic = focus;
  expected.conversion.tentative_entity_ids = before.conversion.tentative_entity_ids.filter((id) => !targetIds.includes(id));
  expected.conversion.cancelled_entity_ids = [...new Set([
    ...before.conversion.cancelled_entity_ids,
    ...resolved.plans.filter((plan) => plan.action === "cancelled").flatMap((plan) =>
      targetIds.filter((id) => plan.target_entity_id ? id === plan.target_entity_id : before.entities.find((entity) => entity.entity_id === id)?.category === plan.target_category)),
  ])];
  if (!sameCanonicalJson(expected, after)) return { valid: false };
  for (const [index, entity] of before.entities.entries()) {
    const committed = after.entities[index];
    if (entity.entity_id !== committed.entity_id || entity.category !== committed.category ||
      entity.quantity !== committed.quantity ||
      !sameCanonicalJson(entity.attributes, committed.attributes) ||
      !sameCanonicalJson(entity.constraints, committed.constraints) ||
      entity.model !== committed.model || entity.brand !== committed.brand ||
      (!targetIds.includes(entity.entity_id) && !sameCanonicalJson(entity, committed))) return { valid: false };
  }
  return { valid: true, plans: resolved.plans, targetIds };
}

export interface B2JourneyTransactionBoundary {
  quotes: ConversationCommerceState["quotes"];
  delivery_confirmed: boolean;
  confirmed_installation_items:
    ConversationCommerceState["installation"]["items"];
  quotation_status: string;
  order_status: string;
  payment_status: string;
}

export function b2JourneyTransactionBoundary(
  state: ConversationCommerceState,
): B2JourneyTransactionBoundary {
  return {
    quotes: structuredClone(state.quotes),
    delivery_confirmed: state.delivery.confirmed,
    confirmed_installation_items: structuredClone(
      state.installation.items.filter((item) => item.status === "confirmed"),
    ),
    quotation_status: state.conversion.quotation_status,
    order_status: state.conversion.order_status,
    payment_status: state.conversion.payment_status,
  };
}

interface B2TrustedJourneyProgressBase {
  contract: "journey-progress-after-accepted-update-v1";
  company_id: string;
  source_message_id: string;
  source_text: string;
  previous_revision: number;
  committed_revision: number;
  entity_id: string;
  category: string;
  journey_stage: string;
  next_missing_slot: string | null;
  response_decision: CustomerJourneyResponseIntent;
  response_route: "product_guidance" | "contextual_scoped_update";
  response_reason: string;
  reply: string;
  transaction_before: B2JourneyTransactionBoundary;
  transaction_after: B2JourneyTransactionBoundary;
}

export interface B2TrustedGoalJourneyProgress
  extends B2TrustedJourneyProgressBase {
  update_kind: "customer_goal";
  previous_collected: string[];
  committed_collected: string[];
  previous_missing: string[];
  committed_missing: string[];
  accepted_slots: string[];
  accepted_corrections: string[];
}

export interface B2TrustedScopedJourneyProgress
  extends B2TrustedJourneyProgressBase {
  update_kind: "contextual_scoped_update";
  response_decision: "confirm_controlled_update";
  accepted_updates: ScopedCustomerValue[];
  committed_updates: ScopedCustomerValue[];
  aggregate_quantity?: number;
  /** Source-verified old/new scoped values from the actual committed snapshot. */
  scoped_correction?: ScopedQuantityCorrectionCommit;
}

export interface ScopedQuantityCorrectionChange {
  scope: string;
  previous_value: number;
  value: number;
  unit: string;
  source_text: string;
  target_scopes: string[];
}

/** Latest bounded correction ledger in the existing canonical entity JSON. */
export interface ScopedQuantityCorrectionCommit {
  version: "scoped-quantity-correction-1";
  company_id: string;
  conversation_id: string;
  source_message_id: string;
  source_text: string;
  entity_id: string;
  subject_label: string;
  unit: string;
  previous_revision: number;
  committed_revision: number;
  previous_quantity: number;
  current_quantity: number;
  previous_updates: ScopedCustomerValue[];
  changes: ScopedQuantityCorrectionChange[];
}

const correctionClean = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
const correctionEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const correctionNumbers: Record<string, number> = { zero:0, one:1, two:2, three:3, four:4, five:5,
  six:6, seven:7, eight:8, nine:9, ten:10, "零":0, "〇":0, "一":1, "二":2,
  "兩":2, "两":2, "三":3, "四":4, "五":5, "六":6, "七":7, "八":8, "九":9, "十":10 };
const correctionNumberPattern = "([0-9]{1,4}|[零〇一二兩两三四五六七八九十]|zero|one|two|three|four|five|six|seven|eight|nine|ten)";
const correctionNumber = (value: string): number => correctionNumbers[value.toLowerCase()] ?? Number(value);

/** Syntax only: scope and unit remain literal customer data, never a catalogue. */
export function verifyScopedQuantityCorrectionQuote(input: {
  scope: string; previous_value: number; value: number; unit: string; source_text: string; grouped: boolean;
}): boolean {
  if (![input.previous_value,input.value].every(value=>Number.isInteger(value)&&value>=1&&value<=1000) ||
    input.previous_value===input.value || !input.scope || input.scope.length>80 ||
    !/^[\p{L}\p{N}]{1,20}$/u.test(input.unit) || input.source_text.length>200) return false;
  const scope=correctionEscape(correctionClean(input.scope)), unit=correctionEscape(input.unit);
  const each=input.grouped?"\\s+each":"";
  const patterns=[
    new RegExp("^"+scope+"\\s+from\\s+"+correctionNumberPattern+"\\s*"+unit+each+
      "\\s+to\\s+"+correctionNumberPattern+"\\s*"+unit+each+"[.!。]?$","iu"),
    new RegExp("^"+scope+(input.grouped?"\\s*各":"")+"\\s*(?:由|從|从)\\s*"+correctionNumberPattern+
      "\\s*"+unit+"\\s*(?:改為|改为|改做|到)\\s*"+correctionNumberPattern+"\\s*"+unit+"[.!。]?$","iu"),
    new RegExp("^"+scope+(input.grouped?"\\s*各":"")+"\\s*(?:唔係|不是|唔系|不係)\\s*"+correctionNumberPattern+
      "\\s*"+unit+"\\s*(?:而係|而是|而系)\\s*"+correctionNumberPattern+"\\s*"+unit+"[.!。]?$","iu"),
  ];
  const text=correctionClean(input.source_text);
  return patterns.some(pattern=>{
    const match=text.match(pattern);
    return !!match && correctionNumber(match[1])===input.previous_value && correctionNumber(match[2])===input.value;
  });
}

export function isExplicitScopedQuantityCorrectionSource(text: string, subject: string): boolean {
  const source=correctionClean(text);
  return source.length>=4 && source.length<=1200 && matchesReferenceLabel(source,subject) &&
    /^(?:(?:please\s+)?(?:correct(?:ion)?|change|update)\b|(?:請|请)?(?:更正|修正|改))/iu.test(source) &&
    !/[?？]|\b(?:not|don't|never|if|maybe|perhaps|could|should|would)\b|(?:唔好|不要|假如|如果|可能|可唔可以|可不可以)/iu.test(source);
}

export function scopedQuantityCorrectionSummary(ledger: ScopedQuantityCorrectionCommit): string {
  return `${ledger.subject_label} quantity: change from ${ledger.previous_quantity} ${ledger.unit} to ${ledger.current_quantity} ${ledger.unit}`;
}

/** Existing reducer display projection only; never substitutes full source authority. */
export function scopedQuantityCorrectionSourceMarker(text: string): string {
  return correctionClean(text).slice(0,300);
}

/** One shared validator for the writer's readback, Memory and B2 consumers. */
export function readVerifiedScopedQuantityCorrection(input: {
  state: ConversationCommerceState; company_id: string; conversation_id: string;
  source_message_id: string; source_text: string; revision: number;
}): ScopedQuantityCorrectionCommit | null {
  if(![input.company_id,input.conversation_id,input.source_message_id].every(value=>
    typeof value==="string" && value.trim().length>0 && value.length<=200))return null;
  const candidates=input.state.entities.filter(entity=>{
    const value=entity.attributes.scoped_quantity_correction;
    return value && typeof value==="object" && !Array.isArray(value) &&
      (value as unknown as ScopedQuantityCorrectionCommit).source_message_id===input.source_message_id;
  });
  if(candidates.length!==1)return null;
  const entity=candidates[0], raw=entity.attributes.scoped_quantity_correction;
  const ledger=raw as unknown as ScopedQuantityCorrectionCommit;
  if(ledger.version!=="scoped-quantity-correction-1" || ledger.company_id!==input.company_id ||
    ledger.conversation_id!==input.conversation_id || ledger.source_message_id!==input.source_message_id ||
    typeof ledger.source_text!=="string" || correctionClean(ledger.source_text)!==correctionClean(input.source_text) ||
    typeof ledger.subject_label!=="string" || !isExplicitScopedQuantityCorrectionSource(ledger.source_text,ledger.subject_label) ||
    ledger.entity_id!==entity.entity_id || input.state.entities.filter(value=>value.entity_id===entity.entity_id).length!==1 ||
    ["cancelled","deferred","superseded"].includes(entity.status) ||
    entity.provenance.source_type!=="customer" || entity.provenance.source_message_id!==input.source_message_id ||
    !sourceOwnedSubjectLabels(entity).some(label=>correctionClean(label).toLowerCase()===correctionClean(ledger.subject_label).toLowerCase()) ||
    typeof ledger.unit!=="string" || entity.attributes.unit!==ledger.unit ||
    !Number.isInteger(ledger.previous_revision) || ledger.previous_revision<1 ||
    ledger.committed_revision!==ledger.previous_revision+1 || ledger.committed_revision!==input.revision ||
    !input.state.latest_corrections.includes(scopedQuantityCorrectionSourceMarker(ledger.source_text)) ||
    !input.state.latest_corrections.includes(scopedQuantityCorrectionSummary(ledger)) ||
    !Array.isArray(ledger.previous_updates) || !ledger.previous_updates.length || ledger.previous_updates.length>24 ||
    !Array.isArray(ledger.changes) || !ledger.changes.length || ledger.changes.length>8)return null;
  const previous=ledger.previous_updates;
  if(new Set(previous.map(row=>row?.scope+":"+row?.attribute)).size!==previous.length || previous.some(row=>
    !row || row.attribute!=="quantity" || row.action!=="set" || typeof row.scope!=="string" || !row.scope.trim() ||
    typeof row.value!=="number" || !Number.isInteger(row.value) || row.value<1 || row.value>1000 ||
    typeof row.source_text!=="string" || !row.source_text.trim() || row.source_text.length>200 ||
    typeof row.source_message_id!=="string" || !row.source_message_id.trim() || row.source_message_id===input.source_message_id ||
    !Number.isInteger(row.source_revision) || row.source_revision!<1 || row.source_revision!>ledger.previous_revision ||
    (row.group_scope && (typeof row.group_scope!=="string" || !row.group_scope.trim() ||
      typeof row.group_goal_id!=="string" || !row.group_goal_id.trim() ||
      row.group_goal_id!==entity.attributes.contextual_goal_id)) ||
    (row.scope_count_source && (row.scope_count_source.goal_id!==entity.attributes.contextual_goal_id ||
      typeof row.scope_count_source.source_text!=="string" || !row.scope_count_source.source_text.trim() ||
      typeof row.scope_count_source.source_message_id!=="string" || !row.scope_count_source.source_message_id.trim() ||
      !Number.isInteger(row.scope_count_source.source_revision) || row.scope_count_source.source_revision<1 ||
      row.scope_count_source.source_revision>ledger.previous_revision))))return null;
  const expected=structuredClone(previous), seen=new Set<string>(), spans:Array<{start:number;end:number}>=[];
  const source=correctionClean(ledger.source_text);
  for(const change of ledger.changes){
    if(!change || typeof change.scope!=="string" || typeof change.source_text!=="string" ||
      change.unit!==ledger.unit || !Array.isArray(change.target_scopes) || !change.target_scopes.length ||
      change.target_scopes.length>24)return null;
    const group=previous.filter(row=>row.group_scope===change.scope);
    const direct=previous.filter(row=>row.scope===change.scope && !row.group_scope);
    if(group.length && direct.length || !group.length && direct.length!==1)return null;
    const target=group.length?group:direct;
    if(!sameCanonicalJson(target.map(row=>row.scope),change.target_scopes) ||
      !verifyScopedQuantityCorrectionQuote({...change,grouped:group.length>0}) ||
      target.some(row=>row.value!==change.previous_value || seen.has(row.scope)))return null;
    const quote=correctionClean(change.source_text), at=source.indexOf(quote);
    if(at<0 || source.indexOf(quote,at+1)>=0 || spans.some(span=>at<span.end&&span.start<at+quote.length))return null;
    spans.push({start:at,end:at+quote.length});
    for(const row of target){
      seen.add(row.scope);
      const next=expected.find(value=>value.scope===row.scope)!;
      next.value=change.value;next.source_text=quote;next.source_message_id=input.source_message_id;next.source_revision=input.revision;
    }
  }
  const quantityMentions=[...source.matchAll(new RegExp(correctionNumberPattern+"\\s*"+correctionEscape(ledger.unit),"giu"))];
  if(quantityMentions.length!==ledger.changes.length*2 || quantityMentions.some(match=>!spans.some(span=>
    (match.index??-1)>=span.start&&(match.index??-1)+match[0].length<=span.end)))return null;
  const before=previous.reduce((sum,row)=>sum+Number(row.value),0), after=expected.reduce((sum,row)=>sum+Number(row.value),0);
  if(before!==ledger.previous_quantity || after!==ledger.current_quantity || after!==entity.quantity ||
    after<1 || after>1000 || !sameCanonicalJson(expected,entity.attributes.scoped_customer_updates))return null;
  return ledger;
}

/** Private server-to-server evidence; never request or assistant metadata. */
export type B2TrustedJourneyProgress =
  | B2TrustedGoalJourneyProgress
  | B2TrustedScopedJourneyProgress;

/** In-process receipt for a single scoped correction, after the Commerce CAS commit. */
export interface B2TrustedCorrectionCommit {
  contract: "scoped-correction-commit-v1";
  company_id: string;
  source_message_id: string;
  source_text: string;
  previous_revision: number;
  committed_revision: number;
  entity_id: string;
  category: string;
  scope: string;
  field: "room_size";
  previous_value: string;
  current_value: string;
  previous_values: Record<string, string>;
  committed_values: Record<string, string>;
  correction: string;
  reply: string;
  transaction_before: B2JourneyTransactionBoundary;
  transaction_after: B2JourneyTransactionBoundary;
}
