/**
 * Universal context binding for an industry adapter's structured customer turn.
 * The core knows entities, scopes and event authority, never industry vocabulary.
 */
import type { CommerceEntity, ConversationCommerceState } from "./commerce-state-contract.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { matchesReferenceLabel } from "./industry-agent-registry.ts";
import { sourceOwnedSubjectLabels } from "./commerce-subject-resolution.ts";
import type { CommerceStateEvent } from "./commerce-state-reducer.ts";

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
    f.customer_facts?.length!==1 || f.customer_facts[0].key!=="contextual_scope_counts" ||
    f.demands?.length!==1 ||
    [f.transaction_state,f.payment_state,f.booking_state,f.fulfillment_state].some(value=>
      value!=="none" && value!=="unknown"))return null;
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
  if(active.some(entity=>entity.attributes.contextual_goal_id!==goal_id))return null;
  const rows=f.customer_facts[0].value;
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
    const firstTurnGuidance = input.state.entities.length === 0 &&
      allDemandsSourced;
    if (!existingAdvisory && !firstTurnGuidance) return null;
    const name = (item?.name ?? requests[0]?.subject_refs[0] ?? "").normalize("NFKC").trim().slice(0, 100);
    return { topic: name, topic_source: "semantic", action: "enquiry",
      values: [], context_sufficient: true, requires_generated_guidance: true,
      reply: "", clarification: question };
  }
  if (!item || f.confidence < 0.9 || item.confidence < 0.9 ||
    f.ambiguity.is_ambiguous || f.customer_correction || f.additive ||
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
  const referenced = active.filter(e => (item.entity_ref === e.entity_id &&
    f.referents.some(r => r.ref === e.entity_id &&
      r.source === "persistent_state" && r.confidence >= 0.9)) ||
    // The exact source that materialized this item may replay its original
    // goal referent. A new turn must use the committed entity reference.
    (active.length===1 && goal && item.entity_ref===goal.goal_id &&
      e.attributes.contextual_goal_id===goal.goal_id &&
      e.provenance.source_message_id===input.context?.source_message_id &&
      normalizeSource(item.name)===goal.subject_label &&
      f.referents.some(r=>r.ref===goal.goal_id && r.source==="persistent_state" && r.confidence>=0.9)));
  // A model-supplied ID cannot select one of multiple active entities unless
  // the Visitor independently names that existing item in the latest turn.
  const matches = active.length === 1
    ? active.filter(e => named.includes(e) || referenced.includes(e))
    : active.filter(e => named.includes(e) &&
      (item.entity_ref === e.entity_id || referenced.includes(e)));
  let target:CommerceEntity;
  let newEntity:CommerceEntity|undefined;
  if(matches.length===1) target=matches[0];
  else if(matches.length===0 && active.length===0 && goal &&
    goal.source_message_id!==input.context?.source_message_id &&
    item.entity_ref===goal.goal_id && normalizeSource(item.name)===goal.subject_label &&
    f.referents.some(ref=>ref.ref===goal.goal_id && ref.source==="persistent_state" && ref.confidence>=0.9)){
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
  if (item.category_hint && item.category_hint !== target.category)
    return invalid();

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
      displayQuotes.push(quote);
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
  if(candidate.new_entity && active.length===0 &&
    !input.state.entities.some(entity=>entity.entity_id===candidate.new_entity!.entity_id) &&
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
