/**
 * Universal context binding for an industry adapter's structured customer turn.
 * The core knows entities, scopes and event authority, never industry vocabulary.
 */
import type { CommerceEntity, ConversationCommerceState } from "./commerce-state-contract.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { matchesReferenceLabel } from "./industry-agent-registry.ts";
import { sourceOwnedSubjectLabels,customerOwnedDisplayLabel,safeCustomerDisplayText } from "./commerce-subject-resolution.ts";
import { customerDimensionPair,isCurrentRequirementsRecap,isSourceOwnedActiveAdviceGoal } from "./commerce-state-authority.ts";
import type { CommerceStateEvent } from "./commerce-state-reducer.ts";
import { isExplicitScopedQuantityCorrectionSource, readVerifiedScopedQuantityCorrection,
  scopedQuantityCorrectionSummary, scopedQuantityCorrectionSourceMarker, verifyScopedQuantityCorrectionQuote,
  type ScopedQuantityCorrectionCommit, type ScopedQuantityCorrectionChange } from "./b2-journey-progress-contract.ts";
import { sameCanonicalJson } from "./canonical-json.ts";

/** Server-bound canonical snapshot identity. Never take this from model output. */
export interface ContextualSourceContext {
  company_id: string;
  conversation_id: string;
  source_message_id: string;
  state_revision: number;
}

export interface SourceBoundContextualGoal {
  version: "contextual-scope-1";
  goal_id: string;
  subject_label: string;
  source_text: string;
  company_id: string;
  conversation_id: string;
  source_message_id: string;
  recorded_revision: number;
  status: "active" | "cancelled" | "deferred" | "superseded";
  status_source_message_id?: string;
  status_recorded_revision?: number;
}

export interface SourceBoundScopeFact {
  version: "contextual-scope-1";
  goal_id: string;
  subject_label: string;
  scope: string;
  count: number;
  source_text: string;
  source_message_text: string;
  company_id: string;
  conversation_id: string;
  source_message_id: string;
  recorded_revision: number;
}

const normalizeSource = (text: string): string => text.normalize("NFKC").replace(/\s+/gu, " ").trim();
const sourceNumberPattern = "([0-9]{1,4}|[零〇一二兩两三四五六七八九十]|\\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\\b)";
const sourceNumbers: Record<string, number> = {"零":0,"〇":0,"一":1,"二":2,"兩":2,"两":2,
  "三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9,"十":10,
  one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
const sourceNumber = (text: string): number => Object.prototype.hasOwnProperty.call(sourceNumbers,text.toLowerCase())
  ? sourceNumbers[text.toLowerCase()] : Number(text);
// These are numeral operators, not scope classifiers or industry labels.
const unsupportedNumeralOperator=/[百佰千仟萬万億亿兆拾廿卅卌]/u;

function validSourceContext(context: ContextualSourceContext | undefined): context is ContextualSourceContext {
  return !!context && [context.company_id,context.conversation_id,context.source_message_id]
    .every(value=>typeof value==="string" && value.length>0 && value.length<=200) &&
    Number.isInteger(context.state_revision) && context.state_revision>=0;
}

/** A counted scope is not an item quantity: "two groups" supplies two groups,
 * with no inference about how many goods/services each group needs. */
function verifiedScopeCountQuote(scope: string, count: number, quote: string): boolean {
  if (!scope || scope.length>80 || !/^[\p{L}][\p{L}\s-]*$/u.test(scope) ||
    quote.length<2 || quote.length>200 || !Number.isInteger(count) || count<1 || count>12) return false;
  const numbers=[...quote.matchAll(new RegExp(sourceNumberPattern,"giu"))];
  if(numbers.length!==1 || numbers[0].index!==0 || sourceNumber(numbers[0][0])!==count)return false;
  const after=quote.slice(numbers[0][0].length);
  const at=after.toLowerCase().indexOf(scope.toLowerCase());
  if(at<0 || after.toLowerCase().indexOf(scope.toLowerCase(),at+1)>=0)return false;
  // Optional one-character grammatical classifier, with no classifier or
  // industry vocabulary table; the scope label itself must stay literal.
  return !unsupportedNumeralOperator.test(after.slice(0,at)) &&
    /^(?:\s*|\s*[\p{Script=Han}]\s*)$/u.test(after.slice(0,at)) &&
    /^[\s.。!！]*$/u.test(after.slice(at+scope.length));
}

/** Read only a receipt from this tenant/ticket's committed canonical snapshot. */
export function committedContextualGoal(input: {
  state: ConversationCommerceState; context?: ContextualSourceContext;
}): SourceBoundContextualGoal | null {
  if(!validSourceContext(input.context))return null;
  const raw=input.state.customer_constraints.contextual_goal;
  if(!raw || typeof raw!=="object" || Array.isArray(raw))return null;
  const goal=raw as SourceBoundContextualGoal;
  if(goal.version!=="contextual-scope-1" || goal.status!=="active" ||
    goal.company_id!==input.context.company_id || goal.conversation_id!==input.context.conversation_id ||
    typeof goal.goal_id!=="string" || !goal.goal_id.startsWith("contextual-goal:") ||
    typeof goal.subject_label!=="string" || typeof goal.source_text!=="string" ||
    typeof goal.source_message_id!=="string" || !goal.source_message_id ||
    goal.goal_id!=="contextual-goal:"+goal.source_message_id ||
    !Number.isInteger(goal.recorded_revision) || goal.recorded_revision<1 ||
    goal.recorded_revision>input.context.state_revision ||
    !matchesReferenceLabel(goal.source_text,goal.subject_label) ||
    (input.state.current_topic && input.state.current_topic!==goal.subject_label))return null;
  return goal;
}

export function readSourceBoundContextualGoal(state: ConversationCommerceState,
  context: ContextualSourceContext): SourceBoundContextualGoal | null {
  return committedContextualGoal({state,context});
}

function committedScopeFact(state: ConversationCommerceState, context: ContextualSourceContext | undefined,
  goal: SourceBoundContextualGoal | null, scope: string): SourceBoundScopeFact | null {
  if(!goal || !validSourceContext(context))return null;
  const raw=state.customer_constraints.contextual_scope_facts;
  if(!Array.isArray(raw) || raw.length>24)return null;
  const matching=raw.filter((value): value is SourceBoundScopeFact=>{
    if(!value || typeof value!=="object" || Array.isArray(value))return false;
    const fact=value as SourceBoundScopeFact;
    return fact.version==="contextual-scope-1" && fact.goal_id===goal.goal_id &&
      fact.subject_label===goal.subject_label && fact.scope===scope &&
      fact.company_id===context.company_id && fact.conversation_id===context.conversation_id &&
      typeof fact.source_message_id==="string" && !!fact.source_message_id &&
      fact.source_message_id!==context.source_message_id &&
      Number.isInteger(fact.recorded_revision) && fact.recorded_revision>=1 &&
      fact.recorded_revision>=goal.recorded_revision &&
      fact.recorded_revision<=context.state_revision && typeof fact.source_text==="string" &&
      typeof fact.source_message_text==="string" && fact.source_message_text.length<=1200 &&
      fact.source_message_text.indexOf(fact.source_text)>=0 &&
      fact.source_message_text.indexOf(fact.source_text)===fact.source_message_text.lastIndexOf(fact.source_text) &&
      matchesReferenceLabel(fact.source_message_text,fact.subject_label) &&
      (fact.source_message_id!==goal.source_message_id ||
        (fact.source_message_text===goal.source_text && fact.recorded_revision===goal.recorded_revision)) &&
      verifiedScopeCountQuote(fact.scope,fact.count,fact.source_text);
  });
  return matching.length===1?matching[0]:null;
}

/** Consumer for the existing typed customer_facts container. The writer owns
 * the CAS and binds recorded_revision to expected+1 only when it commits.
 * This proposal can never create a commerce entity or a merchant fact. */
export function verifiedCurrentScopeFacts(input: {
  text: string; semantic_frame?: CommerceSemanticFrame | null;
  state: ConversationCommerceState; context?: ContextualSourceContext;
}): {goal: SourceBoundContextualGoal; facts: SourceBoundScopeFact[]} | null {
  const f=input.semantic_frame, context=input.context;
  if(!f || !validSourceContext(context) || f.operation!=="UPDATE_ITEM" ||
    f.confidence<0.9 || f.ambiguity.is_ambiguous || f.additive || f.entities.length ||
    f.explicit_negations.length || f.requested_facts.length ||
    !["customer_guidance","ask_for_advice","customer_context_update"].includes(f.intent) ||
    !Array.isArray(f.customer_facts) || !f.customer_facts.length || f.customer_facts.length>16 ||
    f.demands?.length!==1 ||
    [f.transaction_state,f.payment_state,f.booking_state,f.fulfillment_state].some(value=>
      value!=="none" && value!=="unknown"))return null;
  // A compound customer turn may also contain independent preferences or
  // measurements. Select this consumer's one proposal explicitly; never take
  // the first fact or let duplicate keys choose a scope/receipt silently.
  // Other facts retain their existing separate Memory handling and obtain no
  // scope, entity, merchant or transaction authority from this verifier.
  const keys=new Set<string>();
  for(const fact of f.customer_facts){
    if(!fact || typeof fact!=="object" || Array.isArray(fact) ||
      Object.keys(fact).some(key=>key!=="key" && key!=="value") ||
      typeof fact.key!=="string" || !fact.key || fact.key!==normalizeSource(fact.key) ||
      keys.has(fact.key) ||
      ["__proto__","constructor","prototype","contextual_goal","contextual_scope_facts"].includes(fact.key))return null;
    keys.add(fact.key);
  }
  const scopeProposals=f.customer_facts.filter(fact=>fact.key==="contextual_scope_counts");
  if(scopeProposals.length!==1)return null;
  const text=normalizeSource(input.text), demand=f.demands[0];
  const quote=normalizeSource(demand.source_quote);
  if(text.length<4 || text.length>1200 || demand.source_type!=="general" ||
    demand.requested_facts.length || demand.ambiguity.is_ambiguous || demand.explicit_negations.length ||
    demand.subject_refs.length!==1 || quote.length<4 || !text.includes(quote))return null;
  const subject=normalizeSource(demand.subject_refs[0]);
  if(subject.length<2 || subject.length>100 || !matchesReferenceLabel(quote,subject))return null;
  const old=committedContextualGoal(input);
  if(f.customer_correction && (!old || old.subject_label!==subject))return null;
  const goal_id=old?.subject_label===subject?old.goal_id:"contextual-goal:"+context.source_message_id;
  const active=input.state.entities.filter(entity=>!["cancelled","deferred","superseded"].includes(entity.status));
  const otherActive=active.filter(entity=>entity.attributes.contextual_goal_id!==goal_id);
  // A separately named, completely sourced planning request may coexist with
  // previously allocated items. It records context only; none of those items
  // supplies this subject's counts and no entity is created by this operation.
  // Keep implicit, mixed-subject and borrowed-referent turns fail-closed.
  if(otherActive.length && (quote!==text || f.referents.length!==0 ||
    normalizeSource(f.topic??"")!==subject ||
    otherActive.some(entity=>sourceOwnedSubjectLabels(entity).some(label=>
      matchesReferenceLabel(quote,label))) ||
    (old?.subject_label!==subject && demand.customer_correction)))return null;
  const rows=scopeProposals[0].value;
  if(!Array.isArray(rows) || rows.length<1 || rows.length>8)return null;
  const facts:SourceBoundScopeFact[]=[], spans:Array<{start:number;end:number}>=[];
  for(const raw of rows){
    if(!raw || typeof raw!=="object" || Array.isArray(raw) ||
      Object.keys(raw).some(key=>!["scope","count","source_text","subject_label"].includes(key)) ||
      typeof raw.scope!=="string" || typeof raw.count!=="number" ||
      typeof raw.source_text!=="string" || raw.subject_label!==subject)return null;
    const scope=normalizeSource(raw.scope), source_text=normalizeSource(raw.source_text);
    const at=text.indexOf(source_text);
    const inDemand=quote.indexOf(source_text);
    if(!verifiedScopeCountQuote(scope,raw.count,source_text) || at<0 ||
      inDemand<0 || quote.indexOf(source_text,inDemand+1)>=0 ||
      text.indexOf(source_text,at+1)>=0 || spans.some(span=>at<span.end && span.start<at+source_text.length) ||
      facts.some(fact=>fact.scope===scope))return null;
    const prior=committedScopeFact(input.state,context,old?.subject_label===subject?old:null,scope);
    if(prior && prior.count!==raw.count && !f.customer_correction)return null;
    spans.push({start:at,end:at+source_text.length});
    facts.push({version:"contextual-scope-1",goal_id,subject_label:subject,scope,count:raw.count,source_text,source_message_text:text,
      company_id:context.company_id,conversation_id:context.conversation_id,
      source_message_id:context.source_message_id,recorded_revision:context.state_revision});
  }
  return {goal:old?.goal_id===goal_id ? old : {version:"contextual-scope-1",goal_id,subject_label:subject,source_text:text,
    company_id:context.company_id,conversation_id:context.conversation_id,
    source_message_id:context.source_message_id,recorded_revision:context.state_revision,status:"active"},facts};
}

export interface ScopedCustomerValue {
  scope: string;
  attribute: string;
  action: "set";
  value: string | number | boolean;
  /** Exact verified customer phrase; member ids stay separate from display. */
  source_text?: string;
  source_message_id?: string;
  source_revision?: number;
  /** Source-verified whole-group replacement; never infer this from an id suffix. */
  group_scope?: string;
  group_goal_id?: string;
  scope_count_source?: {
    goal_id: string;
    source_text: string;
    source_message_id: string;
    source_revision: number;
  };
}

export interface ContextualCandidate {
  topic: string;
  topic_source: "explicit" | "profile" | "semantic";
  entity_id?: string;
  /** Materialized only after current quantities and the committed goal verify. */
  new_entity?: CommerceEntity;
  action: "enquiry" | "scoped_update";
  values: ScopedCustomerValue[];
  /** Explicit aggregate from the adapter; partial scoped changes must not invent it. */
  aggregate_quantity?: number;
  scoped_correction?: ScopedQuantityCorrectionCommit;
  context_sufficient: boolean;
  /** Classification only; the established general-answer handler supplies the reply. */
  requires_generated_guidance?: boolean;
  reply: string;
  clarification: string;
}


/** Domain-neutral clarification for a distributed quantity with no selected
 * industry. It cannot choose a product, invent an aggregate, or mutate state. */
export function unresolvedScopedQuantityCandidate(input: {
  text: string;
  language: "zh-TW" | "zh-CN" | "en";
}): ContextualCandidate | null {
  const text = input.text.normalize("NFKC").trim();
  if (!text || /[?？]/u.test(text) ||
    !/(?:各|每|\beach\b|\bper\b)/iu.test(text) ||
    !/(?:\d+|[零〇一二兩两三四五六七八九十]+|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b)/iu.test(text)) return null;
  const rooms = /(?:房|room|bedroom)/iu.test(text);
  // This fallback covers a source that contains scopes and counts only. A
  // named product/service belongs to the ordinary generic semantic path.
  // Room vocabulary identifies a location, never an appliance industry.
  const residue = text
    .replace(/(?:客廳|客厅|廳|厅|廤|睡房|臥室|卧室|房間|房间|房|living\s+rooms?|lounges?|bedrooms?|rooms?)/giu, "")
    .replace(/(?:\d+|[零〇一二兩两三四五六七八九十]+|\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\b)/giu, "")
    .replace(/(?:每|各|間|间|個|个|要|需|放|裝|装|部|台|\b(?:for|in|the|of|each|per|units?|gets?|needs?|has)\b)/giu, "")
    .replace(/[\s,，.。;；:：]+/gu, "");
  if (!rooms || residue) return null;
  const clarification = input.language === "en"
    ? `Which product or service is this for? Please identify ${rooms ? "how many rooms and " : ""}the quantity for each scope.`
    : input.language === "zh-CN"
    ? `你指哪种产品或服务？请确认${rooms ? "有几间房，以及" : ""}各个范围所需的数量。`
    : `你講緊邊種產品或服務？請確認${rooms ? "有幾間房，同埋" : ""}各個範圍需要嘅數量。`;
  return {topic:"",topic_source:"profile",action:"scoped_update",values:[],
    context_sufficient:false,reply:"",clarification};
}

/** The Semantic Frame is a proposal, never authority for an item or a count.
 * Only source-quoted values belonging to one active persisted customer entity
 * can become scoped updates; this works without industry or room dictionaries.
 */
export function resolveSemanticContextualCandidate(input: {
  text: string; language: "zh-TW" | "zh-CN" | "en";
  state: ConversationCommerceState; semantic_frame?: CommerceSemanticFrame | null;
  context?: ContextualSourceContext;
}): ContextualCandidate | null {
  const f = input.semantic_frame;
  if (!f) return null;
  const text = input.text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const question = input.language === "en"
    ? "Which saved item and exact quantity for each named scope should I update?"
    : input.language === "zh-CN"
      ? "请确认要更新哪件已记录项目，以及每个范围的具体数量。"
      : "請確認要更新邊項已記錄要求，同埋每個範圍嘅實際數量。";
  const invalid = (): ContextualCandidate => ({
    topic: "", topic_source: "semantic", action: "scoped_update",
    values: [], context_sufficient: false, reply: "", clarification: question,
  });
  const item = f.entities.length === 1 ? f.entities[0] : null;
  const proposed = item?.attributes["scoped_customer_updates"];
  // A reserved scoped proposal cannot fall through to general entity updates
  // merely because its envelope has extra entities or an invalid value type.
  // Other multi-entity readings without this reserved field remain independent.
  const hasScopedProposal = f.entities.some(entity =>
    Object.prototype.hasOwnProperty.call(entity.attributes, "scoped_customer_updates"));
  if (hasScopedProposal && (!item || !Array.isArray(proposed))) return invalid();
  if (!Array.isArray(proposed)) {
    const scopeFacts=f.operation==="UPDATE_ITEM" ? verifiedCurrentScopeFacts(input) : null;
    // General advice is a route, not a completed deterministic answer.
    // requested_facts are merchant/KB needs and may never become questions
    // asking the customer to supply a merchant price or specification.
    if ((f.operation !== "ASK_FACT" && !scopeFacts) || f.confidence < 0.9 ||
      f.ambiguity.is_ambiguous || f.customer_correction || f.additive ||
      f.explicit_negations.length !== 0 || f.entities.length > 1 ||
      f.requested_facts.length !== 0 ||
      !["customer_guidance", "ask_for_advice"].includes(f.intent) ||
      text.length < 4 || text.length > 240 ||
      !["none", "unknown"].includes(f.transaction_state) ||
      !["none", "unknown"].includes(f.payment_state) ||
      !["none", "unknown"].includes(f.booking_state) ||
      !["none", "unknown"].includes(f.fulfillment_state)) return null;
    if (item && (item.confidence < 0.9 || item.quantity !== null ||
      item.model || item.sku || !item.name ||
      !matchesReferenceLabel(text, item.name))) return null;
    const requests = f.demands ?? [];
    const existingAdvisory = !!item && requests.length === 0;
    const allDemandsSourced = requests.length === 1 && requests.every(d => {
      const quote = d.source_quote.normalize("NFKC").replace(/\s+/gu, " ").trim();
      return quote.length >= 4 && text.includes(quote) &&
        !d.ambiguity.is_ambiguous && !d.customer_correction &&
        d.explicit_negations.length === 0 &&
        d.source_type === "general" && d.requested_facts.length === 0 &&
        d.subject_refs.length <= 1 && d.subject_refs.every(subject =>
          matchesReferenceLabel(quote, subject) && (!item ||
            subject.normalize("NFKC").trim() === item.name.normalize("NFKC").trim()));
    });
    const firstTurnGuidance = input.state.entities.length === 0 && allDemandsSourced;
    const verifiedScopedGuidance = !!scopeFacts && allDemandsSourced;
    if (!existingAdvisory && !firstTurnGuidance && !verifiedScopedGuidance) return null;
    const name = (item?.name ?? requests[0]?.subject_refs[0] ?? "").normalize("NFKC").trim().slice(0, 100);
    return { topic: name, topic_source: "semantic", action: "enquiry",
      values: [], context_sufficient: true, requires_generated_guidance: true,
      reply: "", clarification: question };
  }
  if (!item || f.confidence < 0.9 || item.confidence < 0.9 ||
    f.ambiguity.is_ambiguous || f.additive ||
    f.explicit_negations.length > 0 ||
    !["UPDATE_ITEM", "SET_QUANTITY"].includes(f.operation) ||
    (f.demands ?? []).length > 0 || f.requested_facts.length>0 || proposed.length < 1 ||
    proposed.length > 8 || !text) return invalid();

  const goal=committedContextualGoal(input);
  const active = input.state.entities.filter(e =>
    e.provenance.source_type === "customer" &&
    Boolean(e.provenance.source_message_id) &&
    !["cancelled", "deferred", "superseded"].includes(e.status));
  const named = active.filter(e => sourceOwnedSubjectLabels(e).some(label =>
    matchesReferenceLabel(text, label)));
  if(goal && item.entity_ref===goal.goal_id && named.some(entity=>
    entity.attributes.contextual_goal_id!==goal.goal_id))return invalid();
  // Replaying the materializing source is bound to its committed goal and
  // entity provenance, even when another independent item is active. This
  // exception never lets a new source select an item by a model-only goal ID.
  const goalReplay = active.filter(e => goal && item.entity_ref===goal.goal_id &&
    e.attributes.contextual_goal_id===goal.goal_id &&
    e.provenance.source_message_id===input.context?.source_message_id &&
    normalizeSource(item.name)===goal.subject_label &&
    f.referents.length===1 && f.referents[0].ref===goal.goal_id &&
    f.referents[0].source==="persistent_state" && f.referents[0].confidence>=0.9);
  const referenced = active.filter(e => (item.entity_ref === e.entity_id &&
    f.referents.some(r => r.ref === e.entity_id &&
      r.source === "persistent_state" && r.confidence >= 0.9)) ||
    goalReplay.includes(e));
  // A model-supplied ID cannot select one of multiple active entities unless
  // the Visitor independently names that existing item in the latest turn.
  const matches = active.length === 1
    ? active.filter(e => named.includes(e) || referenced.includes(e))
    : active.filter(e => goalReplay.includes(e) || (named.includes(e) &&
      (item.entity_ref === e.entity_id || referenced.includes(e))));
  let target:CommerceEntity;
  let newEntity:CommerceEntity|undefined;
  if(matches.length===1) target=matches[0];
  else if(matches.length===0 && goal &&
    goal.source_message_id!==input.context?.source_message_id &&
    item.entity_ref===goal.goal_id && normalizeSource(item.name)===goal.subject_label &&
    f.referents.length===1 && f.referents[0].ref===goal.goal_id &&
    f.referents[0].source==="persistent_state" && f.referents[0].confidence>=0.9 &&
    !input.state.entities.some(entity=>entity.attributes.contextual_goal_id===goal.goal_id ||
      sourceOwnedSubjectLabels(entity).some(label=>
        normalizeSource(label).toLowerCase()===goal.subject_label.toLowerCase()))){
    const entity_id="contextual-item:"+goal.goal_id;
    if(input.state.entities.some(entity=>entity.entity_id===entity_id))return invalid();
    // This temporary descriptor is never persisted with zero quantity. Only
    // a fully validated allocation below may materialize the researched item.
    newEntity={entity_id,category:goal.subject_label,quantity:0,status:"researching",
      attributes:{product_name:goal.subject_label,contextual_goal_id:goal.goal_id,
        subject_source_message_id:goal.source_message_id,subject_source_revision:goal.recorded_revision},
      constraints:{},provenance:{source_type:"customer",source_message_id:goal.source_message_id}};
    target=newEntity;
  } else return invalid();
  // A literal existing subject, proposed name and persistent referent must
  // agree. Selecting the sole active entity cannot override a contradictory
  // new-goal Reading, nor may that entity borrow a different current goal.
  if(!newEntity && ((item.name && !sourceOwnedSubjectLabels(target).some(label=>
      normalizeSource(label).toLowerCase()===normalizeSource(item.name).toLowerCase())) ||
    (item.entity_ref && item.entity_ref!==target.entity_id && !goalReplay.includes(target)) ||
    f.referents.some(ref=>ref.source==="persistent_state" && ref.ref!==target.entity_id &&
      !(goalReplay.includes(target) && ref.ref===goal?.goal_id)) ||
    (goal && target.attributes.contextual_goal_id!==goal.goal_id &&
      (!named.includes(target) || matchesReferenceLabel(text,goal.subject_label)))))return invalid();
  if (item.category_hint && item.category_hint !== target.category)
    return invalid();
  if(f.customer_correction){
    const context=input.context;
    if(newEntity || !validSourceContext(context) || item.entity_ref!==target.entity_id ||
      f.referents.length!==1 || f.referents[0].ref!==target.entity_id ||
      f.referents[0].source!=="persistent_state" || f.referents[0].confidence<0.9 ||
      !named.includes(target) || named.some(entity=>entity.entity_id!==target.entity_id) ||
      f.customer_facts?.length ||
      [f.transaction_state,f.payment_state,f.booking_state,f.fulfillment_state].some(value=>value!=="none"&&value!=="unknown") ||
      !isExplicitScopedQuantityCorrectionSource(text,item.name) || typeof target.attributes.unit!=="string" ||
      item.unit!==target.attributes.unit)return invalid();
    const replay=readVerifiedScopedQuantityCorrection({state:input.state,...context,
      source_text:text,revision:context.state_revision});
    if(target.provenance.source_message_id===context.source_message_id && !replay)return invalid();
    const previous=replay?.previous_updates ?? target.attributes.scoped_customer_updates;
    if(!Array.isArray(previous) || !previous.length || previous.length>24)return invalid();
    const changes:ScopedQuantityCorrectionChange[]=[], updates:ScopedCustomerValue[]=[];
    for(const raw of proposed){
      if(!raw || typeof raw!=="object" || Array.isArray(raw) ||
        Object.keys(raw).some(key=>!["scope","attribute","action","previous_value","value","unit","source_text"].includes(key)))return invalid();
      const row=raw as Record<string,unknown>;
      if(row.attribute!=="quantity" || row.action!=="set" || typeof row.scope!=="string" ||
        typeof row.source_text!=="string" || typeof row.previous_value!=="number" || typeof row.value!=="number" ||
        row.unit!==target.attributes.unit)return invalid();
      const scope=normalizeSource(row.scope), group=previous.filter(value=>value?.group_scope===scope);
      const direct=previous.filter(value=>value?.scope===scope&&!value.group_scope);
      if(group.length && direct.length || !group.length && direct.length!==1)return invalid();
      const targets=group.length?group:direct;
      const change:ScopedQuantityCorrectionChange={scope,previous_value:row.previous_value,value:row.value,
        unit:target.attributes.unit,source_text:normalizeSource(row.source_text),target_scopes:targets.map(value=>value.scope)};
      if(!verifyScopedQuantityCorrectionQuote({...change,grouped:group.length>0}) ||
        targets.some(value=>value.value!==change.previous_value) ||
        change.target_scopes.some(scope=>updates.some(value=>value.scope===scope)))return invalid();
      changes.push(change);
      updates.push(...targets.map(value=>({...value,value:change.value,source_text:change.source_text,
        source_message_id:context.source_message_id,source_revision:replay?.committed_revision ?? context.state_revision+1})));
    }
    const expected=previous.map(value=>updates.find(update=>update.scope===value.scope)??value);
    const ledger:ScopedQuantityCorrectionCommit={version:"scoped-quantity-correction-1",
      company_id:context.company_id,conversation_id:context.conversation_id,source_message_id:context.source_message_id,
      source_text:text,entity_id:target.entity_id,subject_label:item.name,unit:target.attributes.unit,
      previous_revision:replay?.previous_revision??context.state_revision,
      committed_revision:replay?.committed_revision??context.state_revision+1,
      previous_quantity:replay?.previous_quantity??target.quantity,
      current_quantity:expected.reduce((sum,value)=>sum+Number(value.value),0),
      previous_updates:structuredClone(previous),changes};
    if(replay && !sameCanonicalJson(replay,ledger) ||
      item.quantity!==null && item.quantity!==ledger.current_quantity)return invalid();
    const projected=structuredClone(input.state), next=projected.entities.find(value=>value.entity_id===target.entity_id)!;
    next.quantity=ledger.current_quantity;next.provenance={...next.provenance,source_type:"customer",source_message_id:context.source_message_id};
    next.attributes.scoped_customer_updates=structuredClone(expected);
    next.attributes.scoped_quantity_correction=structuredClone(ledger);
    projected.latest_corrections=[...new Set([...projected.latest_corrections,scopedQuantityCorrectionSourceMarker(text),scopedQuantityCorrectionSummary(ledger)])].slice(-8);
    if(!readVerifiedScopedQuantityCorrection({state:projected,...context,source_text:text,revision:ledger.committed_revision}))return invalid();
    const reply=input.language==="en"
      ? `Updated ${item.name}: ${changes.map(change=>change.source_text).join("; ")}. Total ${ledger.current_quantity} ${ledger.unit}. This is not a confirmed order.`
      : input.language==="zh-CN"
      ? `已更新「${item.name}」：${changes.map(change=>change.source_text).join("；")}；合共 ${ledger.current_quantity}${ledger.unit}。尚未下单。`
      : `已更新「${item.name}」：${changes.map(change=>change.source_text).join("；")}；合共 ${ledger.current_quantity}${ledger.unit}。未落單。`;
    return {topic:target.category,topic_source:"semantic",entity_id:target.entity_id,action:"scoped_update",
      values:updates,aggregate_quantity:ledger.current_quantity,scoped_correction:ledger,
      context_sufficient:true,reply,clarification:question};
  }

  const words: Record<string, number> = {
    "零": 0, "〇": 0, "一": 1, "二": 2, "兩": 2, "两": 2,
    "三": 3, "四": 4, "五": 5, "六": 6, "七": 7,
    "八": 8, "九": 9, "十": 10, one: 1, two: 2, three: 3,
    four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10,
  };
  const quantityPattern = "([0-9]{1,4}|[零〇一二兩两三四五六七八九十]|one|two|three|four|five|six|seven|eight|nine|ten)";
  const folded = text.toLowerCase();
  const scopes = new Set<string>();
  const spans: Array<{ start: number; end: number }> = [];
  const values: ScopedCustomerValue[] = [];
  const displayQuotes: string[] = [];
  // Evidence counts follow distinct Visitor quantity phrases, not the
  // derived number of anonymous members in an explicitly counted group.
  let quotedQuantityPhrases = 0;
  let unit: string | null = null;
  for (const raw of proposed) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
    const row = raw as Record<string, unknown>;
    if (row.action !== "set" || row.attribute !== "quantity" ||
      typeof row.scope !== "string" || typeof row.source_text !== "string" ||
      typeof row.unit !== "string" || typeof row.value !== "number" ||
      !Number.isInteger(row.value) || row.value < 1 || row.value > 1000)
      return invalid();
    const scope = row.scope.normalize("NFKC").replace(/\s+/gu, " ").trim();
    const quote = row.source_text.normalize("NFKC").replace(/\s+/gu, " ").trim();
    const sourceUnit = row.unit.normalize("NFKC").trim();
    // A literal scope may have a one-character CJK name (e.g. 隊).
    // Require that exact source character inside one unique current-turn
    // quoted allocation; it never maps to a product/category synonym.
    const grouped = typeof row.scope_count === "number" ||
      typeof row.per_scope_quantity === "number";
    const literalScope = matchesReferenceLabel(quote, scope) ||
      (/^[\p{Script=Han}]$/u.test(scope) &&
        quote.indexOf(scope) >= 0 && quote.indexOf(scope) === quote.lastIndexOf(scope));
    if (scope.length < 1 || scope.length > 80 ||
      quote.length < 3 || quote.length > 200 ||
      !/^[\p{L}\p{N}]{1,20}$/u.test(sourceUnit) ||
      !literalScope || scopes.has(scope.toLowerCase())) return invalid();
    if ((unit !== null && unit.toLowerCase() !== sourceUnit.toLowerCase()) ||
      (item.unit && item.unit.normalize("NFKC").toLowerCase() !== sourceUnit.toLowerCase()) ||
      (typeof target.attributes.unit === "string" && target.attributes.unit &&
        target.attributes.unit.normalize("NFKC").toLowerCase() !== sourceUnit.toLowerCase()))
      return invalid();
    const at = folded.indexOf(quote.toLowerCase());
    if (at < 0 || folded.indexOf(quote.toLowerCase(), at + 1) >= 0 ||
      spans.some(s => at < s.end && s.start < at + quote.length)) return invalid();
    if (grouped) {
      // Both written counts share a quote. An omitted scope count may ONLY
      // come from the committed customer receipt for this exact active goal;
      // a model-supplied prior count or raw dialogue is never evidence.
      const quantities = [...quote.matchAll(new RegExp(
        "([0-9]{1,4}|[零〇一二兩两三四五六七八九十]|\\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\\b)",
        "giu",
      ))];
      if (quantities.some(m => m.index === undefined))
        return invalid();
      const fromPrior = quantities.length===1 && row.scope_count==null &&
        goal && target.attributes.contextual_goal_id===goal.goal_id
        ? committedScopeFact(input.state,input.context,goal,scope):null;
      if(quantities.length!==2 && !fromPrior)return invalid();
      const first = quantities[0], second = quantities[quantities.length-1];
      const number = (s: string): number =>
        Object.prototype.hasOwnProperty.call(words, s.toLowerCase())
          ? words[s.toLowerCase()] : Number(s);
      const n = fromPrior?.count ?? number(first[0]), each = number(second[0]);
      if (!Number.isInteger(n) || !Number.isInteger(each) ||
        n < 1 || n > 12 || each < 1 || each > 100 ||
        n * each > 1000 || (!fromPrior && row.scope_count !== n) ||
        row.per_scope_quantity !== each || row.value !== each)
        return invalid();
      const middle = fromPrior ? quote.slice(0,second.index!)
        : quote.slice(first.index! + first[0].length, second.index!);
      const after = quote.slice(second.index! + second[0].length).trim();
      const sourceName = middle.toLowerCase().indexOf(scope.toLowerCase());
      const afterUnit = after.slice(sourceUnit.length);
      const beforeEach = /(?:各|每|\beach\b|\bper\b)/iu.test(middle);
      const trailingEach = /^\s+each\s*[.!。]?$/iu.test(afterUnit);
      if (sourceName < 0 || middle.toLowerCase().indexOf(scope.toLowerCase(), sourceName + 1) >= 0 ||
        (!fromPrior && unsupportedNumeralOperator.test(middle.slice(0,sourceName))) ||
        /[,，;；.!。!?？]/u.test(middle) ||
        !(beforeEach || trailingEach) ||
        !after.toLowerCase().startsWith(sourceUnit.toLowerCase()) ||
        /^[\p{L}\p{N}]/u.test(afterUnit)) return invalid();
      // Reject extra written per-unit quantities inside the same phrase.
      if ([...quote.matchAll(new RegExp(quantityPattern + "\\s*" + sourceUnit, "giu"))].length !== 1)
        return invalid();
      for (let index = 1; index <= n; index++) {
        const distinct = scope + "#" + index;
        if (scopes.has(distinct.toLowerCase())) return invalid();
        values.push({scope: distinct, attribute: "quantity", action: "set", value: each, source_text: quote,
          group_scope:scope,
          ...(typeof target.attributes.contextual_goal_id==="string"?
            {group_goal_id:target.attributes.contextual_goal_id}:{}),
          ...(fromPrior?{scope_count_source:{goal_id:fromPrior.goal_id,source_text:fromPrior.source_text,
            source_message_id:fromPrior.source_message_id,source_revision:fromPrior.recorded_revision}}:{})});
      }
      unit = sourceUnit;
      scopes.add(scope.toLowerCase());
      spans.push({start: at, end: at + quote.length});
      quotedQuantityPhrases++;
      // Show the exact counted-scope receipt only when it supplied this
      // allocation's omitted count. Persisted source text and member ids stay
      // unchanged; unrelated prior dialogue is never part of the display.
      displayQuotes.push(fromPrior
        ? quote + (input.language === "en" ? " (" + fromPrior.source_text + ")" : "（" + fromPrior.source_text + "）")
        : quote);
      continue;
    }
    const counts = [...quote.matchAll(new RegExp(quantityPattern + "\\s*" + sourceUnit, "giu"))];
    if (counts.length !== 1) return invalid();
    const word = counts[0][1].toLowerCase();
    const count = Object.prototype.hasOwnProperty.call(words, word)
      ? words[word] : Number(word);
    if (count !== row.value) return invalid();
    unit = sourceUnit;
    scopes.add(scope.toLowerCase());
    spans.push({ start: at, end: at + quote.length });
    values.push({ scope, attribute: "quantity", action: "set", value: count, source_text: quote });
    quotedQuantityPhrases++;
    displayQuotes.push(quote);
  }
  if (unit === null || values.length > 24) return invalid();
  // Expanded members preserve the exact N×M customer count, while requiring
  // every written per-item quantity phrase to be accounted for once.
  const all = [...text.matchAll(new RegExp(quantityPattern + "\\s*" + unit, "giu"))];
  if (all.length !== quotedQuantityPhrases || all.some(m => !spans.some(s =>
    (m.index ?? -1) >= s.start && (m.index ?? -1) + m[0].length <= s.end)))
    return invalid();
  const total = values.reduce((sum, v) => sum + Number(v.value), 0);
  if (total < 1 || total > 1000 ||
    (item.quantity !== null && item.quantity !== total)) return invalid();
  const previousValues:ScopedCustomerValue[]=Array.isArray(target.attributes.scoped_customer_updates)
    ? target.attributes.scoped_customer_updates : [];
  // An existing source ID is replay authority only for the exact committed
  // allocation. An altered quantity/quote must not produce a fresh mutation
  // attempt or a false success acknowledgement under that receipt.
  if(goalReplay.includes(target) && (target.quantity!==total ||
    previousValues.length!==values.length || values.some(value=>{
      const prior=previousValues.filter(row=>row.scope===value.scope && row.attribute===value.attribute);
      return prior.length!==1 || prior[0].action!==value.action || prior[0].value!==value.value ||
        prior[0].source_text!==value.source_text || prior[0].group_scope!==value.group_scope ||
        prior[0].group_goal_id!==value.group_goal_id ||
        prior[0].source_message_id!==input.context?.source_message_id ||
        JSON.stringify(prior[0].scope_count_source??null)!==JSON.stringify(value.scope_count_source??null);
    })))return invalid();
  const previousScopes=previousValues.length>0;
  // Every earlier logical scope must be covered before replacing an aggregate.
  // Anonymous member suffixes alone are not proof of group ownership.
  const logicalScope=(value:ScopedCustomerValue):string=>value.group_scope
    ? "group:"+(value.group_goal_id??"")+":"+value.group_scope : "scope:"+value.scope;
  const incomingScopes=new Set(values.map(logicalScope));
  const fullAllocation=!previousScopes || previousValues.every(value=>
    value && value.attribute==="quantity" && typeof value.value==="number" &&
    incomingScopes.has(logicalScope(value)));
  for(const value of values){
    const old=previousValues.find(prior=>prior.scope===value.scope && prior.attribute===value.attribute);
    if(old?.group_scope && (old.group_scope!==value.group_scope ||
      old.group_goal_id!==value.group_goal_id))return invalid();
  }
  const name = typeof target.attributes.product_name === "string" &&
    target.attributes.product_name.trim()
    ? target.attributes.product_name : target.model ?? target.category;
  const entries = displayQuotes;
  const reply = input.language === "en"
    ? "Noted for " + name + ": " + entries.join(", ") +
      (!fullAllocation ? ". Existing other scopes remain. The total has not been reconfirmed." : ". Total " + total + " " + unit + ".") +
      " This is not a confirmed order."
    : input.language === "zh-CN"
      ? "已记录「" + name + "」的分配：" + entries.join("、") +
        (!fullAllocation ? "；其他已记录范围保留，总数未重新确认。" : "；合共 " + total + unit + "。") + "尚未下单。"
      : "已記低「" + name + "」嘅分配：" + entries.join("、") +
        (!fullAllocation ? "；其餘已記錄範圍保留，總數未重新確認。" : "；合共 " + total + unit + "。") + "未落單。";
  return {
    topic: target.category, topic_source: "semantic", entity_id: target.entity_id,
    ...(newEntity?{new_entity:{...newEntity,quantity:total,
      attributes:{...newEntity.attributes,unit,quantity_basis:"customer_explicit"}}}:{}),
    action: "scoped_update", values,
    aggregate_quantity: fullAllocation ? total : undefined,
    context_sufficient: true, reply, clarification: question,
  };
}

export type ContextualDecision =
  | { route: "none"; reason: string; updates: [] }
  | { route: "targeted_clarification"; reason: string; reply: string; updates: [] }
  | { route: "product_guidance"; reason: string; reply: string; topic: string; updates: []; requires_generated_guidance?: boolean }
  | {
    route: "contextual_scoped_update";
    reason: string;
    reply: string;
    topic: string;
    entity_id: string;
    new_entity?: CommerceEntity;
    updates: ScopedCustomerValue[];
    aggregate_quantity?: number;
    scoped_correction?: ScopedQuantityCorrectionCommit;
  };

export function resolveContextualCustomerUpdate(input: {
  candidate: ContextualCandidate | null;
  state: ConversationCommerceState;
  read_only?: boolean;
}): ContextualDecision {
  const candidate = input.candidate;
  if (!candidate) return { route: "none", reason: "NO_CONTEXTUAL_CANDIDATE", updates: [] };
  if (candidate.action === "enquiry") {
    if (!candidate.context_sufficient) {
      return { route: "targeted_clarification", reason: "ENQUIRY_CONTEXT_AMBIGUOUS", reply: candidate.clarification, updates: [] };
    }
    return { route: "product_guidance", reason: "CONTEXTUAL_ENQUIRY", topic: candidate.topic, reply: candidate.reply, updates: [],
      ...(candidate.requires_generated_guidance ? {requires_generated_guidance: true} : {}) };
  }
  if (input.read_only) return { route: "none", reason: "READ_ONLY_TURN", updates: [] };
  const active = input.state.entities.filter((entity) =>
    entity.status !== "cancelled" && entity.status !== "deferred"
  );
  const compatible = active.filter((entity) => entity.category === candidate.topic &&
    (!candidate.entity_id || candidate.entity_id === entity.entity_id));
  if(candidate.new_entity && candidate.topic_source==="semantic" &&
    input.state.current_topic===candidate.new_entity.category &&
    !input.state.entities.some(entity=>entity.entity_id===candidate.new_entity!.entity_id ||
      entity.attributes.contextual_goal_id===candidate.new_entity!.attributes.contextual_goal_id) &&
    candidate.new_entity.entity_id===candidate.entity_id &&
    candidate.new_entity.category===candidate.topic &&
    candidate.new_entity.provenance.source_type==="customer" &&
    candidate.new_entity.provenance.source_message_id &&
    candidate.aggregate_quantity===candidate.new_entity.quantity &&
    candidate.new_entity.quantity>0)compatible.push(candidate.new_entity);
  // An implicit subject must never silently jump across another active domain.
  const ambiguous = candidate.topic_source === "profile" && active.some((entity) =>
    entity.category !== candidate.topic
  );
  if (!candidate.context_sufficient || ambiguous || compatible.length !== 1) {
    return {
      route: "targeted_clarification",
      reason: !candidate.context_sufficient ? "SCOPE_CONTEXT_MISSING" : "ENTITY_REFERENCE_AMBIGUOUS",
      reply: candidate.clarification,
      updates: [],
    };
  }
  if (!candidate.values.length || new Set(candidate.values.map((v) => v.scope + ":" + v.attribute)).size !== candidate.values.length) {
    return { route: "targeted_clarification", reason: "SCOPED_VALUES_AMBIGUOUS", reply: candidate.clarification, updates: [] };
  }
  return {
    route: "contextual_scoped_update",
    reason: "UNIQUE_COMPATIBLE_CONTEXT",
    topic: candidate.topic,
    entity_id: compatible[0].entity_id,
    ...(candidate.new_entity?{new_entity:candidate.new_entity}:{}),
    updates: candidate.values,
    aggregate_quantity: candidate.aggregate_quantity,
    ...(candidate.scoped_correction?{scoped_correction:candidate.scoped_correction}:{}),
    reply: candidate.reply,
  };
}

export function contextualUpdateEvents(
  decision: ContextualDecision,
  state: ConversationCommerceState,
  source_message_id: string,
  occurred_at?: string | null,
  recorded_revision?: number,
): CommerceStateEvent[] {
  if (decision.route !== "contextual_scoped_update") return [];
  const existingTarget=state.entities.find((entity) => entity.entity_id === decision.entity_id);
  const target = existingTarget ?? decision.new_entity;
  if (!target) return [];
  const provenance = { source_type: "customer" as const, source_message_id, recorded_at: occurred_at ?? null };
  const current = target.attributes.scoped_customer_updates;
  const records: ScopedCustomerValue[] = Array.isArray(current)
    ? current.filter((value): value is ScopedCustomerValue =>
      Boolean(value && typeof value === "object" && typeof value.scope === "string" && typeof value.attribute === "string"))
    : [];
  const merged = new Map(records.map((value) => [value.scope + ":" + value.attribute, value]));
  const currentGroups=new Map<string,Set<string>>();
  for(const value of decision.updates){
    if(!value.group_scope)continue;
    const owner=(value.group_goal_id??"")+":"+value.group_scope;
    if(!currentGroups.has(owner))currentGroups.set(owner,new Set());
    currentGroups.get(owner)!.add(value.scope+":"+value.attribute);
  }
  // Remove only superseded members of the exact whole group evidenced now.
  // Keep surviving rows in place so replay preserves ordering and provenance.
  for(const [key,value] of merged){
    if(!value.group_scope)continue;
    const incoming=currentGroups.get((value.group_goal_id??"")+":"+value.group_scope);
    if(incoming && !incoming.has(key))merged.delete(key);
  }
  for (const value of decision.updates) {
    const key=value.scope+":"+value.attribute, old=merged.get(key);
    if(old && old.source_message_id===source_message_id && old.value===value.value &&
      old.source_text===value.source_text &&
      JSON.stringify(old.scope_count_source??null)===JSON.stringify(value.scope_count_source??null))continue;
    merged.set(key,value.source_text ? { ...value, source_message_id,
      ...(Number.isInteger(recorded_revision) && recorded_revision!>0?{source_revision:recorded_revision}:{}) } : value);
  }
  const updates = [...merged.values()];
  const events: CommerceStateEvent[] = [
    ...(!existingTarget && decision.new_entity ? [{type:"ENSURE_ENTITY" as const,entity:{...decision.new_entity,quantity:0}},
      {type:"SET_CONTEXT" as const,topic:decision.new_entity.category,intent:"scoped allocation"}]:[]),{
    type: "SET_ENTITY_ATTRIBUTE",
    entity_id: target.entity_id,
    key: "scoped_customer_updates",
    value: updates,
    provenance,
  }];
  if(decision.scoped_correction){
    const ledger=decision.scoped_correction;
    if(ledger.source_message_id!==source_message_id || ledger.entity_id!==target.entity_id ||
      ledger.current_quantity!==decision.aggregate_quantity)return [];
    events.push({type:"SET_ENTITY_ATTRIBUTE",entity_id:target.entity_id,key:"scoped_quantity_correction",
      value:structuredClone(ledger),provenance},
      {type:"ADD_CORRECTION",correction:ledger.source_text},
      {type:"ADD_CORRECTION",correction:scopedQuantityCorrectionSummary(ledger)});
  }
  // Only an adapter-authoritative aggregate can change the entity quantity.
  const allocation = updates.filter((v) => v.attribute === "quantity" && typeof v.value === "number");
  if (decision.aggregate_quantity !== undefined && allocation.length === updates.length && allocation.length > 0) {
    const total = allocation.reduce((sum, value) => sum + Number(value.value), 0);
    if (Number.isInteger(decision.aggregate_quantity) && decision.aggregate_quantity >= 0 && total === decision.aggregate_quantity &&
      (!existingTarget || total !== target.quantity)) events.push({
      type: "SET_ENTITY_QUANTITY", entity_id: target.entity_id, quantity: total, provenance,
    });
  }
  return events;
}


/** R4(a) paired site measurement: source proof, not an industry classifier.
 * Customer-owned observations never create an item, quantity, merchant fact,
 * transaction or historical value promotion. Keep legacy until equivalence. */
export const PAIRED_SITE_KEY="paired_site_observation";
export const PAIRED_SITE_PATH="customer_constraints."+PAIRED_SITE_KEY;
export const PAIRED_SITE_REASON="source_bound_paired_site_observation_committed";
export interface PairedSiteReceipt {
 version:"paired-site-1"; company_id:string; conversation_id:string;
 subject_ref:string; subject_label:string; owner_kind:"persistent_state"|"prior_turn";
 owner_source_message_id:string; owner_source_text:string;
 width_mm:number; height_mm:number; approximate:boolean;
 source_message_id:string; source_text:string; measurement_revision:number;
 scope:string|null; scope_source_message_id:string|null; scope_source_text:string|null;
 scope_site_label:string|null; scope_site_source_message_id:string|null; scope_site_source_text:string|null;
 recorded_revision:number;
}
type PairedHistory=readonly {id?:string|null;role:string;content:string}[];
const pairedObject=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:null;
const pairedText=(v:string)=>v.normalize("NFKC").trim().replace(/\s+/gu," ");
const pairedLiteral=(v:string)=>pairedText(v).replace(/[。.]$/u,"").trim();
const pairedNonAssertion=/[?？]|(?:如果|假設|假设|假如|hypothetical|what if|不是|唔係|not\b|不要|唔要)/iu;
export function parsePairedSiteMeasurement(text:string) {
 const literal=pairedLiteral(text);
 // Approximation is a qualifier, not authority to invent an exact dimension.
 // Reuses the existing generic approximation vocabulary used by count proof.
 const prefix=literal.match(/^(?:大約|大约|大概|approximately\b|about\b|around\b)\s*/iu);
 const exact=prefix?literal.slice(prefix[0].length):literal;
 const pair=customerDimensionPair(exact,true);
 return pair?{width_mm:pair.width_mm,height_mm:pair.height_mm,approximate:!!prefix}:null;
}
function pairedScope(text:string):string|null {
 const v=pairedLiteral(text);
 if(!v||v.length>80||!/\p{L}/u.test(v)||! /^[\p{L}\p{N}\p{M} -]+$/u.test(v)||pairedNonAssertion.test(v))return null;
 return safeCustomerDisplayText(v);
}
/** Literal scope/site spans must reconstruct one association. The only
 * extra text allowed is generic grammatical glue from the prior association
 * rule; no product or location dictionary, no scope inferred from category. */
export function pairedScopeBinding(text:string,scope:string,site:string|null):boolean {
 if(typeof text!=="string"||typeof scope!=="string"||(site!==null&&typeof site!=="string"))return false;
 const t=pairedLiteral(text);
 if(pairedNonAssertion.test(t)||pairedScope(scope)!==scope)return false;
 if(site===null)return pairedScope(t)===scope;
 if(pairedScope(site)!==site||scope===site)return false;
 const a=t.indexOf(scope),b=t.indexOf(site);
 if(a<0||b<a+scope.length||t.indexOf(scope,a+scope.length)>=0||t.indexOf(site,b+site.length)>=0||b+site.length!==t.length)return false;
 return /^(?:係|是|属于|屬於|belongs to|for the|it's for)\s*$/iu.test(t.slice(0,a))&&
  /^(?:\s+|\s*(?:嗰個|那個|那个|個|个|的)\s*)$/u.test(t.slice(a+scope.length,b));
}
export function pairedSiteSourceMatches(actual:string,expected:string):boolean{return pairedText(actual)===pairedText(expected)}
function pairedHistory(input:PairedHistory|undefined){
 return (input??[]).filter(h=>["visitor","user","customer"].includes(h.role)&&typeof h.id==="string"&&!!h.id&&typeof h.content==="string");
}
function pairedPersistentOwner(state:ConversationCommerceState,context:ContextualSourceContext,ref:string) {
 const active=state.entities.filter(e=>!["cancelled","deferred","superseded"].includes(e.status));
 if(active.length===1&&active[0].entity_id===ref){
  const e=active[0],label=customerOwnedDisplayLabel(e),id=e.provenance.source_message_id;
  if(!label||!id||e.attributes.window_opening_observation!=null||e.attributes.room_window_openings!=null)return null;
  return {ref,label,source_id:id};
 }
 if(active.length!==0)return null;
 const g=readSourceBoundContextualGoal(state,context);
 return g&&g.goal_id===ref?{ref,label:g.subject_label,source_id:g.source_message_id}:null;
}
function pairedPriorOwnerAllowed(state:ConversationCommerceState,label:string):boolean {
 return state.entities.length===0&&state.customer_constraints.contextual_goal==null&&
  (!state.current_topic||matchesReferenceLabel(state.current_topic,label));
}
export function pairedSiteOwnerSourceMatches(r:PairedSiteReceipt,actual:string):boolean {
 return pairedSiteSourceMatches(actual,r.owner_source_text)&&matchesReferenceLabel(actual,r.subject_label)&&
  (r.owner_kind==="persistent_state"||isSourceOwnedActiveAdviceGoal(actual));
}
export function hasPairedSiteProposal(frame:CommerceSemanticFrame|null|undefined):boolean {
 return !!frame?.customer_facts?.some(f=>f.key===PAIRED_SITE_KEY);
}
export function readPairedSiteReceipt(state:ConversationCommerceState,context:ContextualSourceContext):PairedSiteReceipt|null {
 const v=pairedObject(state.customer_constraints[PAIRED_SITE_KEY]);
 if(!v||v.version!=="paired-site-1"||v.company_id!==context.company_id||v.conversation_id!==context.conversation_id||
  typeof v.subject_ref!=="string"||typeof v.subject_label!=="string"||typeof v.owner_source_message_id!=="string"||
  !v.owner_source_message_id||typeof v.owner_source_text!=="string"||!v.owner_source_text||v.owner_source_text.length>2400||
  typeof v.source_message_id!=="string"||!v.source_message_id||v.source_message_id===v.owner_source_message_id||
  typeof v.source_text!=="string"||v.source_text.length>240||
  typeof v.measurement_revision!=="number"||!Number.isSafeInteger(v.measurement_revision)||v.measurement_revision<1||
  typeof v.recorded_revision!=="number"||!Number.isSafeInteger(v.recorded_revision)||
  v.recorded_revision<v.measurement_revision||v.recorded_revision>context.state_revision)return null;
 const r=v as unknown as PairedSiteReceipt;
 if(r.owner_kind==="persistent_state"){
  const o=pairedPersistentOwner(state,context,r.subject_ref);
  if(!o||o.label!==r.subject_label||o.source_id!==r.owner_source_message_id)return null;
 }else if(r.owner_kind!=="prior_turn"||r.subject_ref!==r.subject_label||
  !pairedPriorOwnerAllowed(state,r.subject_label))return null;
 if(!pairedSiteOwnerSourceMatches(r,r.owner_source_text))return null;
 const pair=parsePairedSiteMeasurement(r.source_text);
 if(!pair||r.width_mm!==pair.width_mm||r.height_mm!==pair.height_mm||r.approximate!==pair.approximate)return null;
 if(r.scope===null){
  if(r.scope_source_message_id!==null||r.scope_source_text!==null||r.scope_site_label!==null||
   r.scope_site_source_message_id!==null||r.scope_site_source_text!==null||r.recorded_revision!==r.measurement_revision)return null;
 }else if(typeof r.scope!=="string"||typeof r.scope_source_text!=="string"||
  typeof r.scope_source_message_id!=="string"||!r.scope_source_message_id||
  r.scope_source_message_id===r.source_message_id||r.scope_source_message_id===r.owner_source_message_id||
  r.recorded_revision!==r.measurement_revision+1||!pairedScopeBinding(r.scope_source_text,r.scope,r.scope_site_label))return null;
 else if(r.scope_site_label===null){
  if(r.scope_site_source_message_id!==null||r.scope_site_source_text!==null)return null;
 }else if(typeof r.scope_site_label!=="string"||typeof r.scope_site_source_message_id!=="string"||
  !r.scope_site_source_message_id||r.scope_site_source_message_id===r.scope_source_message_id||
  typeof r.scope_site_source_text!=="string"||!matchesReferenceLabel(r.scope_site_source_text,r.scope_site_label))return null;
 return r;
}
export function verifiedPairedSiteProposal(input:{
 state:ConversationCommerceState;context?:ContextualSourceContext;text:string;
 frame?:CommerceSemanticFrame|null;history?:PairedHistory;
}):PairedSiteReceipt|null {
 const {state,context,frame}=input;
 if(!validSourceContext(context)||!frame||frame.operation!=="UPDATE_ITEM"||frame.confidence<.90||
  frame.ambiguity.is_ambiguous||frame.additive||frame.customer_correction||frame.entities.length||
  frame.explicit_negations.length||frame.requested_facts.length||frame.demands?.length||
  [frame.transaction_state,frame.payment_state,frame.booking_state,frame.fulfillment_state].some(x=>x!=="none"&&x!=="unknown")||
  frame.customer_facts?.length!==1||frame.customer_facts[0].key!==PAIRED_SITE_KEY||frame.referents.length!==1)return null;
 const f=pairedObject(frame.customer_facts[0].value),ref=frame.referents[0],text=pairedText(input.text);
 if(!f||Object.keys(f).some(k=>!["action","subject_ref","source_text","scope","site_label"].includes(k))||
  (f.subject_ref!==undefined&&f.subject_ref!==ref.ref)||ref.confidence<.90||
  !["prior_turn","persistent_state"].includes(ref.source)||typeof f.source_text!=="string"||
  f.source_text!==text||!text||text.length>240)return null;
 const history=pairedHistory(input.history).filter(h=>h.id!==context.source_message_id);
 // Repeated IDs or inconsistent originals must never choose a scope by order.
 if(new Set(history.map(h=>h.id)).size!==history.length)return null;
 if(f.action==="observe"){
  if(f.scope!==null||(f.site_label!==undefined&&f.site_label!==null)||state.customer_constraints[PAIRED_SITE_KEY]!=null)return null;
  const pair=parsePairedSiteMeasurement(text);if(!pair)return null;
  const persisted=ref.source==="persistent_state"?pairedPersistentOwner(state,context,ref.ref):null;
  const prior=ref.source==="prior_turn"&&pairedScope(ref.ref)===ref.ref&&pairedPriorOwnerAllowed(state,ref.ref)?
   history.filter(h=>isSourceOwnedActiveAdviceGoal(h.content)):[];
  const owners=persisted?history.filter(h=>h.id===persisted.source_id&&matchesReferenceLabel(h.content,persisted.label)):prior;
  if(owners.length!==1||(!persisted&&(prior.length!==1||!matchesReferenceLabel(owners[0].content,ref.ref))))return null;
  const source=owners[0],label=persisted?.label??ref.ref;
  if(!source.id||source.content.length>2400)return null;
  return {version:"paired-site-1",company_id:context.company_id,conversation_id:context.conversation_id,
   subject_ref:ref.ref,subject_label:label,owner_kind:ref.source as "persistent_state"|"prior_turn",
   owner_source_message_id:source.id,owner_source_text:pairedText(source.content),
   ...pair,source_message_id:context.source_message_id,source_text:text,measurement_revision:context.state_revision+1,
   scope:null,scope_source_message_id:null,scope_source_text:null,scope_site_label:null,
   scope_site_source_message_id:null,scope_site_source_text:null,recorded_revision:context.state_revision+1};
 }
 if(f.site_label!==undefined&&f.site_label!==null&&typeof f.site_label!=="string")return null;
 const site=typeof f.site_label==="string"?f.site_label:null;
 if(f.action!=="bind_scope"||typeof f.scope!=="string"||!pairedScopeBinding(text,f.scope,site))return null;
 const old=readPairedSiteReceipt(state,context);
 if(!old||old.subject_ref!==ref.ref||old.owner_kind!==ref.source||old.scope!==null||
  old.recorded_revision!==context.state_revision||old.source_message_id===context.source_message_id)return null;
 if(history.filter(h=>h.id===old.owner_source_message_id&&pairedSiteOwnerSourceMatches(old,h.content)).length!==1||
  history.filter(h=>h.id===old.source_message_id&&pairedSiteSourceMatches(h.content,old.source_text)).length!==1)return null;
 const a=history.findIndex(h=>h.id===old.source_message_id),b=history.findIndex(h=>h.id===old.owner_source_message_id);
 // History from the server is chronological or reverse chronological;
 // the measurement must be the immediately preceding visitor source.
 if(a<0||b<0||!((a===history.length-1&&b<a)||(a===0&&b>a)))return null;
 const sites=site===null?[]:history.filter(h=>h.id!==old.source_message_id&&matchesReferenceLabel(h.content,site));
 if(site!==null&&sites.length!==1)return null;
 return {...old,scope:f.scope,scope_source_message_id:context.source_message_id,scope_source_text:text,
  scope_site_label:site,scope_site_source_message_id:sites[0]?.id??null,
  scope_site_source_text:sites[0]?pairedText(sites[0].content):null,recorded_revision:context.state_revision+1};
}
export function pairedSiteReply(r:PairedSiteReceipt,l:"en"|"zh-CN"|"zh-TW"):string{
 const size=r.width_mm+" × "+r.height_mm+" mm",prefix=r.approximate?(l==="en"?"approximately ":l==="zh-CN"?"约 ":"約 "):"";
 if(l==="en")return r.scope===null?"I've recorded "+prefix+size+" (width × height). Which location is this for?":"I've recorded "+prefix+size+" (width × height) for "+r.scope+".";
 if(l==="zh-CN")return r.scope===null?"已记录宽×高 "+prefix+size+"。请问是哪个位置？":"已记录"+r.scope+"的宽×高为 "+prefix+size+"。";
 return r.scope===null?"已記錄闊×高 "+prefix+size+"。請問係邊個位置？":"已記錄"+r.scope+"嘅闊×高為 "+prefix+size+"。";
}
/** Derived Memory value, not a second source of authority. Require the original
 * visitor rows for every component; do not copy model proposal envelopes. */
export function pairedSiteMemoryValue(r:PairedSiteReceipt,history:PairedHistory,l:"en"|"zh-CN"|"zh-TW"):string|null {
 const rows=pairedHistory(history);
 const source=(id:string,text:string,owner=false)=>{
  const found=rows.filter(h=>h.id===id);
  return found.length===1&&(owner?pairedSiteOwnerSourceMatches(r,found[0].content):pairedSiteSourceMatches(found[0].content,text));
 };
 if(!source(r.owner_source_message_id,r.owner_source_text,true)||!source(r.source_message_id,r.source_text))return null;
 if(r.scope!==null&&(!r.scope_source_message_id||!r.scope_source_text||!source(r.scope_source_message_id,r.scope_source_text)))return null;
 if(r.scope_site_label!==null&&(!r.scope_site_source_message_id||!r.scope_site_source_text||!source(r.scope_site_source_message_id,r.scope_site_source_text)))return null;
 const size=(r.approximate?(l==="en"?"approximately ":l==="zh-CN"?"约 ":"約 "):"")+r.width_mm+" × "+r.height_mm+" mm";
 return r.subject_label+": "+size+" ("+(r.scope??(l==="en"?"location unconfirmed":l==="zh-CN"?"位置未确认":"位置未確認"))+")";
}

/** Scoped customer area evidence. Existing contextual counts/allocation remain
 * the sole quantity path. These observations are not item quantities, merchant
 * facts or transactions; the literal area is parsed by the server. */
export const SCOPED_AREA_KEY="scoped_area_observations";
export const SCOPED_AREA_PATH="customer_constraints."+SCOPED_AREA_KEY;
export const SCOPED_AREA_REASON="source_bound_scoped_area_committed";
type ScopedAreaUnit="sq_ft"|"sq_m";
export interface ScopedAreaRow {
 scope:string; amount:number; unit:ScopedAreaUnit; approximate:boolean;
 source_message_id:string; source_text:string; clause:string; recorded_revision:number; mixed_source?:true; first_verified?:true; prior_literal_source_id?:string;
}
export interface ScopedAreaReceipt {
 version:"scoped-area-1"; company_id:string; conversation_id:string;
 subject_ref:string; subject_label:string; owner_kind:"persistent_state"|"prior_turn";
 owner_source_message_id:string; owner_source_text:string;
 source_message_id:string; source_text:string; recorded_revision:number;
 action:"observe"|"correct"; current:ScopedAreaRow[]; superseded:ScopedAreaRow[];

}
const areaCorrectionCue=/^(?:(?:更正|修正)(?:一下)?|correction)\s*[:：]\s*/iu;
const areaUnchangedCue=/^(?:其餘不變|其余不变|others unchanged|everything else unchanged)$/iu;
function areaScopeKey(v:string):string{return pairedText(v).toLocaleLowerCase("en-US")}
function areaClauses(v:string,action:"observe"|"correct"):string[]|null {
 const text=pairedText(v);
 if(!text||text.length>600||pairedNonAssertion.test(text)||areaCorrectionCue.test(text)!==(action==="correct"))return null;
 const clauses=text.replace(areaCorrectionCue,"").split(/[,，;；。]/u).map(s=>s.trim()).filter(Boolean);
 if(action==="correct"&&clauses.length>1&&areaUnchangedCue.test(clauses[clauses.length-1]))clauses.pop();
 return clauses.length>=1&&clauses.length<=8?clauses:null;
}
// A mixed turn can carry other requirements. Every clause containing an
// explicit area unit must be accounted for; questions or negative area
// assertions cannot become evidence by dropping their punctuation.
const explicitAreaUnit=/平方[呎尺米]|平方公尺|\bsq\.?\s*(?:ft|m)\b|\bsquare (?:feet|met(?:er|re)s?)\b|\b(?:ft2|m2)\b/iu;
const mixedCorrectionCue=/^(?:(?:更正|修正)(?:一下)?\s*[:：]?\s*|correction\s*[:：]\s*)/iu;
function mixedAreaClauses(text:string,action:"observe"|"correct"):string[]|null{
 if(!text || text.length>600 || mixedCorrectionCue.test(text)!==(action==="correct"))return null;
 if(/(?:如果|假設|假设|假如|hypothetical|\bif\b|\bunless\b|do not (?:record|save)|不要記錄|不要记录)/iu.test(text))return null;
 const clauses=text.replace(mixedCorrectionCue,"").replace(/\.(?=\s|$)/gu,"。").match(/[^,，;；。?!！？]+[?!！？]?/gu)??[];
 const areas=clauses.map(clause=>clause.trim()).filter(clause=>explicitAreaUnit.test(clause));
 return areas.length && areas.length<=8 && areas.every(clause=>!pairedNonAssertion.test(clause))?areas:null;
}
export function parseScopedAreaClause(clause:string,scope:string,action:"observe"|"correct"):
 Pick<ScopedAreaRow,"scope"|"amount"|"unit"|"approximate">|null {
 if(typeof clause!=="string"||typeof scope!=="string"||pairedScope(scope)!==scope)return null;
 const text=pairedText(clause);
 if(pairedNonAssertion.test(text)||!text.startsWith(scope))return null;
 // The model may not consume the leading digits of the actual amount as part of a scope label.
 const suffix=text.slice(scope.length);
 if(/\p{N}$/u.test(scope)&&/^[\p{N}.]/u.test(suffix))return null;
 let tail=suffix.trim();
 if(action==="correct"){
  const cue=/^(?:改為|改为|改咗|更正為|更正为|其實[係是]|其实[系是]|實際(?:係|是)?|实际(?:系|是)?|corrected to|changed to|is now)\s*/iu;
  if(!cue.test(tail))return null;tail=tail.replace(cue,"");
 }else tail=tail.replace(/^(?:就)?(?:面積|面积|area)?\s*[:：]?\s*(?:是|係|is|=)?\s*/iu,"");
 const approx=/^(?:約|约|approximately|about|around)\s*/iu;
 const approximate=approx.test(tail);tail=tail.replace(approx,"");
 const m=tail.match(/^([0-9]+(?:\.[0-9]{1,3})?)\s*(平方[呎尺]|sq\.?\s*ft|square feet|ft2|平方米|平方公尺|sq\.?\s*m|square met(?:er|re)s?|m2)\.?$/iu);
 if(!m)return null;const amount=Number(m[1]);
 if(!Number.isFinite(amount)||amount<=0||amount>1000000)return null;
 const unit:ScopedAreaUnit=/^(?:平方[呎尺]|sq\.?\s*ft|square feet|ft2)$/iu.test(m[2])?"sq_ft":"sq_m";
 return {scope,amount,unit,approximate};
}
// Decode the retained measurement-frame shape only from a complete original
// exchange. Fact keys do not select a scope, unit, owner or quantity.
export function sourceAreaFrame(state:ConversationCommerceState,c:ContextualSourceContext,text:string,
 f:CommerceSemanticFrame|null|undefined,history:PairedHistory):CommerceSemanticFrame|null {
 if(!f || !f.customer_facts?.length || f.customer_facts.length>8 || f.referents.length || f.entities.length ||
   f.demands?.length || !(f.intent==="customer_context_update" || (f.customer_correction && f.intent==="customer_guidance")) || f.additive || f.ambiguity.is_ambiguous ||
   f.explicit_negations.length || f.requested_facts.length || f.confidence<.9 ||
   [f.transaction_state,f.payment_state,f.booking_state,f.fulfillment_state].some(x=>x!=="none"&&x!=="unknown"))return null;
 if(new Set(f.customer_facts.map(fact=>fact.key)).size!==f.customer_facts.length)return null;
 const correct=f.customer_correction, action=correct?"correct":"observe";
 if(f.operation!==(correct?"UPDATE_ITEM":"NO_STATE_CHANGE"))return null;
 const original=pairedText(text), clauses=areaClauses(original,action);
 if(!clauses||clauses.length!==f.customer_facts.length)return null;
 const old=readScopedAreaReceipt(state,c);
 const prior=history.filter(x=>x.id!==c.source_message_id);
 const owner=prior.filter(x=>x.role==="visitor" && isSourceOwnedActiveAdviceGoal(x.content));
 if(owner.length!==1||!owner[0].id)return null;
 const subject=old?.subject_ref??pairedText(owner[0].content.split(/[,，;；。?!？]/u)[0]);
 if(!subject||!pairedPriorOwnerAllowed(state,subject))return null;
 const scopes:string[]=[],matched=new Set<number>();
 for(const clause of clauses) {
   const m=clause.match(/^(.+?)(?:就|約|约|其實是|其實係|改為|改为|改咗|[0-9])/u);
   if(!m)return null;
   const scope=m[1].trim(),row=parseScopedAreaClause(clause,scope,action);
   if(!row)return null;
   const possible=f.customer_facts.map((fact,i)=>({v:pairedObject(fact.value),i}))
     .filter(({v})=>v && Object.keys(v).length===2 && v.amount===row.amount && v.unit===row.unit);
   if(possible.length!==1 || matched.has(possible[0].i))return null;
   matched.add(possible[0].i);scopes.push(scope);
 }
 return {...f,operation:"UPDATE_ITEM",intent:"customer_context_update",referents:[{source:"prior_turn",ref:subject,confidence:f.confidence}],
   customer_facts:[{key:SCOPED_AREA_KEY,value:{action,source_text:original,scopes,row_texts:clauses}}]};
}
// A correction may establish the first verified area for a previously
// mentioned scope. The old literal identifies only the scope, not its area.
function isScopedAreaAdviceOwner(text:string){
 return !isCurrentRequirementsRecap(text) && isSourceOwnedActiveAdviceGoal(text);
}
function unresolvedScopeSource(history:PairedHistory,scope:string,currentId:string){
 const candidates=pairedHistory(history).filter(row=>row.id!==currentId && !pairedNonAssertion.test(row.content) &&
   pairedText(row.content).split(/[,，;；。]/u).some(part=>{
     const clause=part.trim();
     if(!clause.startsWith(scope))return false;
     return /^(?:就)?(?:約|约|about\s+)?[0-9]+(?:\.[0-9]+)?\s*(?:呎|尺|ft|feet|foot)$/iu.test(clause.slice(scope.length).trim());
   }));
 return candidates.length===1?candidates[0].id:null;
}
function areaOwner(state:ConversationCommerceState,c:ContextualSourceContext,ref:string) {
 const active=state.entities.filter(e=>!["cancelled","deferred","superseded"].includes(e.status));
 const goal=readSourceBoundContextualGoal(state,c);
 if(goal&&goal.goal_id===ref&&active.every(e=>e.attributes.contextual_goal_id===goal.goal_id&&e.attributes.room_sizes==null))return {label:goal.subject_label,id:goal.source_message_id};
 if(active.length===1&&active[0].entity_id===ref){
  const e=active[0],label=customerOwnedDisplayLabel(e),id=e.provenance.source_message_id;
  const legacy=e.attributes.room_sizes;
  return label&&id&&(legacy==null||(typeof legacy==="object"&&!Array.isArray(legacy)&&Object.keys(legacy).length===0))?{label,id}:null;
 }
 if(active.length!==0)return null;
 const g=readSourceBoundContextualGoal(state,c);
 return g&&g.goal_id===ref?{label:g.subject_label,id:g.source_message_id}:null;
}
function parseMixedAreaRow(clause:string,scope:string,action:"observe"|"correct"){
 const row=parseScopedAreaClause(clause,scope,action);
 // A leading explicit correction can supply the correction operator for a plain assignment.
 return row ?? (action==="correct"?parseScopedAreaClause(clause,scope,"observe"):null);
}
/** Merge only source-proved measurements into the existing CAS reduction.
 * Other business facts and transaction decisions retain their original path. */
export function mixedScopedAreaReceipt(previous:ConversationCommerceState,state:ConversationCommerceState,
 context:ContextualSourceContext|undefined,source:string,frame:CommerceSemanticFrame|null|undefined,history:PairedHistory):ScopedAreaReceipt|null{
 if(!validSourceContext(context)||!frame || frame.confidence<.9 || frame.ambiguity.is_ambiguous || frame.additive ||
    frame.explicit_negations.length || !frame.customer_facts?.length ||
    !["customer_context_update","customer_guidance"].includes(frame.intent) ||
    [frame.transaction_state,frame.payment_state,frame.booking_state,frame.fulfillment_state].some(v=>v!=="none"&&v!=="unknown"))return null;
 const text=pairedText(source),action=frame.customer_correction?"correct":"observe";
 const clauses=mixedAreaClauses(text,action);
 if(!clauses)return null;
 const owners=state.entities.filter(e=>!["deferred","cancelled","superseded"].includes(e.status));
 if(owners.length!==1)return null;
 if(!["ASK_FACT","UPDATE_ITEM","NO_STATE_CHANGE"].includes(frame.operation) ||
   (frame.customer_correction && frame.operation!=="UPDATE_ITEM") ||
   (frame.demands??[]).some(d=>d.customer_correction!==frame.customer_correction || d.ambiguity.is_ambiguous || d.explicit_negations.length))return null;
 const subject=owners[0].entity_id,owner=areaOwner(state,context,subject);
 if(!owner || frame.entities.length>1 ||
   frame.entities.some(e=>!matchesReferenceLabel(e.name,owner.label)) ||
   frame.referents.some(ref=>ref.ref!==subject && !matchesReferenceLabel(ref.ref,owner.label)))return null;
 const old=readScopedAreaReceipt(previous,context);
 if(previous.customer_constraints[SCOPED_AREA_KEY]!=null && (!old || old.subject_ref!==subject ||
   old.owner_source_message_id!==owner.id || !scopedAreaSourcesMatch(old,history)))return null;
 if(action==="correct"&&!old)return null;
 const originals=owner.id===context.source_message_id?[{id:owner.id,content:text}]:pairedHistory(history).filter(r=>r.id===owner.id);
 if(originals.length!==1 || !matchesReferenceLabel(originals[0].content,owner.label))return null;
 const current=[...(old?.current??[])],superseded=[...(old?.superseded??[])],used=new Set<number>();
 for(const clause of clauses){
   const match=clause.match(/^(.+?)(?:就|約|约|其實[係是]|其实[系是]|實際|实际|改為|改为|改咗|[0-9])/u);
   if(!match)return null;
   const row=parseMixedAreaRow(clause,match[1].trim(),action);
   if(!row)return null;
   const facts=frame.customer_facts.flatMap((fact,i)=>{
     const value=pairedObject(fact.value);
     if(!value || Object.keys(value).length!==2 || value.amount!==row.amount || typeof value.unit!=="string")return [];
     const literal=clause.match(/[0-9]+(?:\.[0-9]+)?\s*([^0-9]*[a-z²尺呎米]2?)\.?$/iu)?.[1]?.trim().toLowerCase();
     return value.unit===row.unit || value.unit.trim().toLowerCase()===literal?[i]:[];
   });
   if(facts.length!==1 || used.has(facts[0]))return null;
   used.add(facts[0]);
   const index=current.findIndex(v=>areaScopeKey(v.scope)===areaScopeKey(row.scope));
   if((action==="correct")!==(index>=0))return null;
   const next={...row,source_message_id:context.source_message_id,source_text:text,clause,recorded_revision:context.state_revision+1,mixed_source:true as const};
   if(index<0)current.push(next);
   else {const prior=current[index];if(prior.unit!==row.unit || prior.amount===row.amount && prior.approximate===row.approximate)return null;
     superseded.push(prior);current[index]=next;}
 }
 const receipt:ScopedAreaReceipt={version:"scoped-area-1",company_id:context.company_id,conversation_id:context.conversation_id,subject_ref:subject,subject_label:owner.label,owner_kind:"persistent_state",owner_source_message_id:owner.id,owner_source_text:pairedText(originals[0].content),source_message_id:context.source_message_id,source_text:text,recorded_revision:context.state_revision+1,action,current,superseded};
 return readScopedAreaReceipt({...state,customer_constraints:{...state.customer_constraints,[SCOPED_AREA_KEY]:receipt}},{...context,state_revision:context.state_revision+1});
}
function areaRow(v:unknown,r:ScopedAreaReceipt,c:ContextualSourceContext):v is ScopedAreaRow {
 const p=pairedObject(v);
 if(!p||typeof p.scope!=="string"||typeof p.source_message_id!=="string"||!p.source_message_id||
  (p.source_message_id===r.owner_source_message_id && !(p.mixed_source===true && r.owner_kind==="persistent_state" && p.source_text===r.owner_source_text))||typeof p.source_text!=="string"||typeof p.clause!=="string"||
  typeof p.recorded_revision!=="number"||!Number.isSafeInteger(p.recorded_revision)||
  p.recorded_revision<1||p.recorded_revision>c.state_revision||p.recorded_revision>r.recorded_revision)return false;
 const action=(p.mixed_source===true?mixedCorrectionCue:areaCorrectionCue).test(p.source_text)?"correct":"observe";
 const clauses=p.mixed_source===true?mixedAreaClauses(p.source_text,action):areaClauses(p.source_text,action),parsed=(p.mixed_source===true?parseMixedAreaRow:parseScopedAreaClause)(p.clause,p.scope,action);
 return !!clauses&&clauses.filter(x=>x===p.clause).length===1&&!!parsed&&parsed.amount===p.amount&&parsed.unit===p.unit&&parsed.approximate===p.approximate;
}
export function hasScopedAreaProposal(frame:CommerceSemanticFrame|null|undefined):boolean{
 return !!frame?.customer_facts?.some(f=>f.key===SCOPED_AREA_KEY);
}
export function readScopedAreaReceipt(state:ConversationCommerceState,c:ContextualSourceContext):ScopedAreaReceipt|null {
 if(!validSourceContext(c))return null;
 const p=pairedObject(state.customer_constraints[SCOPED_AREA_KEY]);
 if(!p||p.version!=="scoped-area-1"||p.company_id!==c.company_id||p.conversation_id!==c.conversation_id||
  typeof p.subject_ref!=="string"||typeof p.subject_label!=="string"||typeof p.owner_source_message_id!=="string"||!p.owner_source_message_id||
  typeof p.owner_source_text!=="string"||!p.owner_source_text||p.owner_source_text.length>2400||
  typeof p.source_message_id!=="string"||!p.source_message_id||typeof p.source_text!=="string"||
  typeof p.recorded_revision!=="number"||!Number.isSafeInteger(p.recorded_revision)||p.recorded_revision<1||p.recorded_revision>c.state_revision||
  !["observe","correct"].includes(String(p.action))||!Array.isArray(p.current)||!p.current.length||p.current.length>8||
  !Array.isArray(p.superseded)||p.superseded.length>24)return null;
 const r=p as unknown as ScopedAreaReceipt;
 if("unit_context" in p)return null;
 if(!matchesReferenceLabel(r.owner_source_text,r.subject_label))return null;
 if(r.owner_kind==="persistent_state"){
  const owner=areaOwner(state,c,r.subject_ref);
  if(!owner||owner.id!==r.owner_source_message_id||owner.label!==r.subject_label)return null;
 }else if(r.owner_kind!=="prior_turn"||r.subject_ref!==r.subject_label||pairedScope(r.subject_ref)!==r.subject_ref||
  !pairedPriorOwnerAllowed(state,r.subject_label)||!isScopedAreaAdviceOwner(r.owner_source_text))return null;
 if(![...r.current,...r.superseded].every(v=>areaRow(v,r,c)))return null;
 // Replay each complete original source, not merely the latest correction.
 // Dropping an unaffected scope, a predecessor, or part of an older source
 // must invalidate the receipt rather than make an incomplete snapshot true.
 const byRevision=new Map<number,{id:string;text:string;rows:ScopedAreaRow[]}>();
 const revisionBySource=new Map<string,number>();
 for(const row of [...r.current,...r.superseded]){
  const rev=row.recorded_revision,known=revisionBySource.get(row.source_message_id);
  if(known!==undefined&&known!==rev)return null;
  revisionBySource.set(row.source_message_id,rev);
  const batch=byRevision.get(rev);
  if(batch){
   if(batch.id!==row.source_message_id||batch.text!==row.source_text)return null;
   batch.rows.push(row);
  }else byRevision.set(rev,{id:row.source_message_id,text:row.source_text,rows:[row]});
 }
 const ordered=[...byRevision.entries()].sort(([a],[b])=>a-b);
 const last=ordered.at(-1);
 if(!last||last[0]!==r.recorded_revision||last[1].id!==r.source_message_id||last[1].text!==r.source_text||
  ((last[1].rows.every(row=>row.mixed_source)?mixedCorrectionCue:areaCorrectionCue).test(last[1].text)?"correct":"observe")!==r.action)return null;
 const effective=new Map<string,ScopedAreaRow>();
 const historical=new Set(r.superseded);
 for(const [,batch] of ordered){
  const action=(batch.rows.every(row=>row.mixed_source)?mixedCorrectionCue:areaCorrectionCue).test(batch.text)?"correct":"observe";
  const clauses=batch.rows.every(row=>row.mixed_source===true)?mixedAreaClauses(batch.text,action):areaClauses(batch.text,action);
  if(!clauses||clauses.length!==batch.rows.length||
   new Set(batch.rows.map(v=>v.clause)).size!==clauses.length||
   !batch.rows.every(v=>clauses.includes(v.clause))||
   new Set(batch.rows.map(v=>areaScopeKey(v.scope))).size!==batch.rows.length)return null;
  for(const row of batch.rows){
   const key=areaScopeKey(row.scope),prior=effective.get(key);
   if(action==="observe"){
    if(prior)return null;
   }else if(row.first_verified){
    if(!row.prior_literal_source_id || row.prior_literal_source_id===row.source_message_id || prior || batch!==ordered[0][1] || batch.rows.length!==1 || r.owner_kind!=="prior_turn")return null;
   }else if(!prior||!historical.has(prior)||prior.unit!==row.unit||
    (prior.amount===row.amount&&prior.approximate===row.approximate))return null;
   effective.set(key,row);
  }
 }
 if(effective.size!==r.current.length||!r.current.every(v=>effective.get(areaScopeKey(v.scope))===v)||
  r.superseded.some(v=>effective.get(areaScopeKey(v.scope))===v))return null;
 return r;
}
export function scopedAreaSources(r:ScopedAreaReceipt):{id:string;text:string;role?:"assistant"}[] {
 const entries=[{id:r.owner_source_message_id,text:r.owner_source_text},...[...r.current,...r.superseded].map(v=>({id:v.source_message_id,text:v.source_text}))];
 return entries.filter((v,i)=>entries.findIndex(x=>x.id===v.id&&x.text===v.text)===i);
}
export function scopedAreaSourcesMatch(r:ScopedAreaReceipt,history:PairedHistory):boolean {
 const rows=pairedHistory(history),sources=scopedAreaSources(r);
 for(const row of [...r.current,...r.superseded]){
   if(row.first_verified && unresolvedScopeSource(history,row.scope,row.source_message_id)!==row.prior_literal_source_id)return false;
 }
 if(r.owner_kind==="prior_turn"){
  const owners=rows.filter(h=>isScopedAreaAdviceOwner(h.content));
  if(owners.length!==1||owners[0].id!==r.owner_source_message_id||
   !matchesReferenceLabel(owners[0].content,r.subject_label))return false;
 }
 return new Set(sources.map(v=>v.id)).size===sources.length&&sources.every(v=>{
  const originals=v.role==="assistant"?history.filter(x=>x.role==="assistant"&&x.id===v.id):rows.filter(x=>x.id===v.id);
  return originals.length===1&&pairedText(originals[0].content)===v.text;
 });
}
export function verifiedScopedAreaProposal(input:{
 state:ConversationCommerceState;context?:ContextualSourceContext;text:string;frame?:CommerceSemanticFrame|null;history?:PairedHistory;
}):ScopedAreaReceipt|null {
 const {state,context:c,frame:f}=input;
 if(!validSourceContext(c)||!f||f.operation!=="UPDATE_ITEM"||f.intent!=="customer_context_update"||f.confidence<.90||f.ambiguity.is_ambiguous||f.additive||f.entities.length||
  f.explicit_negations.length||f.requested_facts.length||f.demands?.length||
  [f.transaction_state,f.payment_state,f.booking_state,f.fulfillment_state].some(x=>x!=="none"&&x!=="unknown")||
  f.customer_facts?.length!==1||f.customer_facts[0].key!==SCOPED_AREA_KEY||f.referents.length!==1)return null;
 const proposal=pairedObject(f.customer_facts[0].value),ref=f.referents[0],text=pairedText(input.text);
 if(!proposal||Object.keys(proposal).some(k=>!["action","source_text","scopes","row_texts"].includes(k))||
  (proposal.action!=="observe"&&proposal.action!=="correct")||f.customer_correction!==(proposal.action==="correct")||
  proposal.source_text!==text||!Array.isArray(proposal.scopes)||!Array.isArray(proposal.row_texts)||
  !["persistent_state","prior_turn"].includes(ref.source)||ref.confidence<.90)return null;
 const action=proposal.action,clauses=areaClauses(text,action);
 if(!clauses||proposal.scopes.length!==clauses.length||proposal.row_texts.length!==clauses.length)return null;
 const history=pairedHistory(input.history).filter(h=>h.id!==c.source_message_id);
 if(new Set(history.map(h=>h.id)).size!==history.length)return null;
 // Same accepted paired-site ownership boundary: retained object first;
 // otherwise a single literal visitor goal. Never synthesize a goal or entity.
 const persisted=ref.source==="persistent_state"?areaOwner(state,c,ref.ref):null;
 const prior=ref.source==="prior_turn"&&pairedScope(ref.ref)===ref.ref&&pairedPriorOwnerAllowed(state,ref.ref)?
  history.filter(h=>isScopedAreaAdviceOwner(h.content)):[];
 const owners=persisted?history.filter(h=>h.id===persisted.id&&matchesReferenceLabel(h.content,persisted.label)):prior;
 if(owners.length!==1||(!persisted&&!matchesReferenceLabel(owners[0].content,ref.ref))||owners[0].content.length>2400)return null;
 const owner=persisted??{label:ref.ref,id:owners[0].id};
 if(!owner.id||owner.id===c.source_message_id)return null;
 const existing=state.customer_constraints[SCOPED_AREA_KEY],old=readScopedAreaReceipt(state,c);
 if(existing!=null&&(!old||old.subject_ref!==ref.ref||old.owner_kind!==ref.source||old.owner_source_message_id!==owner.id||old.subject_label!==owner.label||scopedAreaSources(old).some(x=>x.id===c.source_message_id)||!scopedAreaSourcesMatch(old,input.history??[])))return null;
 const firstVerified=action==="correct" && !old;
 if(firstVerified && (ref.source!=="prior_turn" || clauses.length!==1))return null;
 const current=[...(old?.current??[])],superseded=[...(old?.superseded??[])],incoming:ScopedAreaRow[]=[];
 for(let i=0;i<clauses.length;i++){
  const scope=proposal.scopes[i],rowText=proposal.row_texts[i];
  if(typeof scope!=="string"||typeof rowText!=="string"||rowText!==clauses[i])return null;
  const parsed=parseScopedAreaClause(clauses[i],scope,action);
  if(!parsed||incoming.some(x=>areaScopeKey(x.scope)===areaScopeKey(parsed.scope)))return null;
  const at=current.findIndex(x=>areaScopeKey(x.scope)===areaScopeKey(parsed.scope));
  if((action==="correct" && !firstVerified)!==(at>=0))return null;
  const priorLiteral=firstVerified?unresolvedScopeSource(input.history??[],scope,c.source_message_id):null;
  if(firstVerified && !priorLiteral)return null;
  const next={...parsed,...(firstVerified?{first_verified:true as const,prior_literal_source_id:priorLiteral!}:{}),source_message_id:c.source_message_id,source_text:text,clause:clauses[i],recorded_revision:c.state_revision+1};
  if(at>=0){const prior=current[at];if(prior.unit!==next.unit||prior.amount===next.amount&&prior.approximate===next.approximate)return null;
   superseded.push(prior);current[at]=next;}else current.push(next);
  incoming.push(next);
 }
 if(current.length>8||superseded.length>24)return null;
 const receipt:ScopedAreaReceipt={version:"scoped-area-1",company_id:c.company_id,conversation_id:c.conversation_id,
  subject_ref:ref.ref,subject_label:owner.label,owner_kind:ref.source as "persistent_state"|"prior_turn",owner_source_message_id:owner.id,owner_source_text:pairedText(owners[0].content),
  source_message_id:c.source_message_id,source_text:text,recorded_revision:c.state_revision+1,action,current,superseded};
 return readScopedAreaReceipt({...state,customer_constraints:{...state.customer_constraints,[SCOPED_AREA_KEY]:receipt}},
  {...c,state_revision:c.state_revision+1});
}
function scopedAreaDisplay(rows:ScopedAreaRow[],l:"en"|"zh-CN"|"zh-TW"):string {
 return rows.map(v=>v.scope+": "+(v.approximate?(l==="en"?"about ":l==="zh-CN"?"约":"約"):"")+v.amount+
  (l==="en"?(v.unit==="sq_ft"?" sq ft":" sq m"):(v.unit==="sq_ft"?" 平方呎":" 平方米"))).join(l==="en"?"; ":"；");
}
export function scopedAreaMemoryValue(r:ScopedAreaReceipt,history:PairedHistory,l:"en"|"zh-CN"|"zh-TW"):string|null{
 return scopedAreaSourcesMatch(r,history)?scopedAreaDisplay(r.current,l):null;
}
export function scopedAreaReply(r:ScopedAreaReceipt,l:"en"|"zh-CN"|"zh-TW"):string {
 const details=scopedAreaDisplay(r.current.filter(v=>v.source_message_id===r.source_message_id),l);
 if(r.current.some(row=>row.first_verified && row.source_message_id===r.source_message_id))return (l==="en"?"First confirmed area from your correction: ":l==="zh-CN"?"按这次更正首次确认的面积：":"按今次更正首次確認的面積：")+details+"。";
 return l==="en"?(r.action==="correct"?"Corrected: ":"Recorded: ")+details+".":(r.action==="correct"?"已更正：":l==="zh-CN"?"已记录：":"已記錄：")+details+"。";
}
