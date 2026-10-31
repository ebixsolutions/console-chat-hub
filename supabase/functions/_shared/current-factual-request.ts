import {
  classifyCanonicalConversationTurn, factualSubject, literalFactualSubject, resolveFactualFollowup,
  type SemanticHistoryRow,
} from "./conversation-semantic-contract.ts";
import {
  classifyNaturalCustomerIntent, exactProductIdentifiers, productFactualFacets,
} from "./natural-customer-response.ts";
import { catalogueFactRequest } from "./kb-product-record.ts";
import {
  isCurrentRequirementsRecap, isPersonalOrderStatusRequest,
  applyCustomerRequestDecision, resolveCustomerRequestDecision, withoutExcludedLookups, type CustomerRequestDecision,
} from "./commerce-state-authority.ts";
import type { CommerceSemanticAmbiguity, CommerceSemanticDemand, CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type { CanonicalConversationMemory } from "./conversation-long-memory.ts";
import { DecisionContextLimitError, mergeDecisionContext, normalizeDecisionContext, type DecisionValue } from "./bounded-decision-context.ts";

export type FactualDemandSourceType = "product" | "policy" | "transaction" | "general" | "unknown";
export interface CurrentFactualDemand {
  id: string;
  question: string;
  source_quote: string;
  subjects: string[];
  subject_source_message_ids: string[];
  source_type: FactualDemandSourceType;
  requested_facts: string[];
  constraints: Record<string, DecisionValue>;
  customer_correction: boolean;
  explicit_negations: string[];
  ambiguity: CommerceSemanticAmbiguity;
}
export interface FactualRequestMissingEvidence {
  demand_id: string;
  reason: "live_transaction_unavailable" | "subject_unresolved" | "semantic_ambiguity" | "source_quote_unbound" | "transaction_scope_overlap";
}

/** A read target, not merchant evidence, transaction authority or a state delta.
 * History must already be bounded to the caller's source, ticket and tenant.
 * Latest customer wording owns the requested facets; history only locates a
 * missing subject. No prior answer's price, stock or policy is copied here. */
export interface CurrentFactualRequest {
  version: "current-factual-request-1";
  source_message_id: string | null;
  original_question: string;
  interpretation_source: "semantic_demands" | "legacy_compatibility";
  applicable: boolean;
  question: string;
  merchant_request: string | null;
  subject: string | null;
  subjects: string[];
  requested_facts: string[];
  query: string | null;
  answer_request: string | null;
  resolution: "explicit" | "follow_up" | "unresolved" | "none";
  subject_source_message_id: string | null;
  subject_source_message_ids: string[];
  demands: CurrentFactualDemand[];
  kb_required: boolean;
  transaction_required: boolean;
  unresolved_demand_ids: string[];
  missing_evidence: FactualRequestMissingEvidence[];
  topic_changed: boolean;
  context_turns: string[];
  needs_subject_clarification: boolean;
}
export type FactualRequestHistoryRow = {
  id?: string | null; role?: string; content?: string | null;
  created_at?: string | null; metadata?: unknown;
};
export interface ResolveCurrentFactualRequestInput {
  question: string;
  source_message_id?: string | null;
  history?: FactualRequestHistoryRow[];
  semantic?: CommerceSemanticFrame | null;
  commerce?: ConversationCommerceState | null;
  memory?: CanonicalConversationMemory | null;
  request_decision?: CustomerRequestDecision;
}

const CUSTOMER = new Set(["visitor", "customer", "user"]);
const INACTIVE = new Set(["cancelled", "deferred", "superseded"]);
const clean = (value: unknown): string => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/gu, " ").trim() : "";
const norm = (value: unknown): string => clean(value).toLowerCase();
const unique = (values: string[]) => [...new Map(values.filter(Boolean).map(value => [norm(value), value])).values()];
const STOCK = /(?:庫存|库存|現貨|现货|有冇貨|有無貨|有沒有貨|有没有货|有貨|有货|剩幾多|剩多少|\b(?:stock|inventory|availability|available)\b|how many.+left)/iu;
const POINTER = /(?:嗰|呢|這|这|那)(?:一)?(?:款|部|個|个|件|項|项)|佢|它|^其|\b(?:it|its|this|that|these|those|same|previous|earlier)\b/iu;
const PLURAL_POINTER = /(?:嗰|呢|這|这|那)(?:兩|两|幾|几)(?:款|部|個|个|件|項|项)|\b(?:(?:these|those)\s+(?:models?|products?|items?|options?|services?)|both|all of them)\b/iu;
const TOPIC_BOUNDARY = /(?:換個話題|换个话题|轉個話題|转个话题|不談|不谈|改問|改问|轉去|转去)|\b(?:different topic|another topic|switch(?:ing)? to|mov(?:e|ing) to|forget that)\b/iu;
const FACET_ONLY_LABEL = /^(?:price|cost|features?|specs?|specifications?|stock|inventory|availability|available|policy|details?|how much|how many left|in|and|or|only|just|the|what|how|is|are|功能|價錢|价钱|價格|价格|庫存|库存|現貨|现货|規格|规格|呢|呀|嗎|吗|貨|货)$/iu;
const CONTROL_ONLY = /^(?:好|好的|好呀|明白|知道|多謝|谢谢|謝謝|ok(?:ay)?|thanks?|got it)[.!！。\s]*$/iu;
const LIFECYCLE_BOUNDARY = /(?:取消|唔要|不要|先擺低|先放低|暫緩|暂缓)|\b(?:cancel(?:led)?|defer(?:red)?|no longer want)\b/iu;
const EXPLICIT_HISTORY_REFERENCE = /(?:返去|返回|回到|講返|讲回|講回|說回|说回|前者|後者|后者)|(?:最初|原先|第[一二三四五六七八九十]+)(?:嗰|那|的|嘅)?(?:款|部|件|個|个|產品|产品|服務|服务)|\b(?:back to|return(?:ing)? to|the former|the latter)\b|\b(?:earlier|previous|original|first|second)\s+(?:one|item|product|model|service|plan|option)\b/iu;
const EXPLICIT_COMPARISON = /(?:比較|比较|對比|对比|相比)|\b(?:compar(?:e|ing|ison)|versus|vs\.?|both)\b/iu;
const POLICY_FACET_LABEL = /^(?:(?:general|merchant|store|the)\s+|(?:一般|通用|全店|商家)(?:嘅|的)?)*(?:退貨政策|退货政策|保養政策|保修政策|付款政策|預約政策|预约政策|取消政策|(?:billing|booking|cancellation|return|warranty)\s+policy)$/iu;
const UNNAMED_REFERENCE_LABEL = /^(?:the\s+)?(?:current|original|listed|selling|earlier|previous|first|second|former|latter|last)(?:\s+(?:one|item|product|model|service|plan|option|order|price))?$/iu;

function trustedFrame(input: CommerceSemanticFrame | null | undefined): CommerceSemanticFrame | null {
  return input && input.confidence >= 0.62 && !input.ambiguity.is_ambiguous ? input : null;
}
function semanticRows(history: FactualRequestHistoryRow[]): SemanticHistoryRow[] {
  return history.map(row => ({...row, id: row.id ?? undefined, role: row.role ?? "", content: row.content ?? ""}));
}
function entityNames(entity: NonNullable<ResolveCurrentFactualRequestInput["commerce"]>["entities"][number]): string[] {
  return [entity.entity_id, entity.model, entity.attributes.model, entity.attributes.product_name, entity.attributes.name]
    .map(clean).filter(Boolean);
}
function literalHints(input: ResolveCurrentFactualRequestInput): string[] {
  return unique([
    ...(input.semantic?.entities ?? []).filter(entity => entity.confidence >= 0.62).flatMap(entity => [entity.model ?? "", entity.name]),
    input.semantic?.topic ?? "",
    ...(input.commerce?.entities ?? []).flatMap(entityNames),
  ]);
}
function validSubject(subject: string | null | undefined): subject is string {
  return Boolean(subject && subject.length >= 2 && subject.length <= 160 && !FACET_ONLY_LABEL.test(subject) &&
    !/^(?:it|its|this|that|these|those|the same|佢|它|呢個|嗰個|這個|这个|那個|那个)(?:$|\s)/iu.test(subject));
}
function locatingLabel(value: string): string {
  return value.replace(/^(?:(?:請問|请问|請查|请查|查下|查|只要|只查|只問|只问|幫我查|帮我查|不要|唔要)\s*|(?:only|just|please|check|tell me|show me)\b\s*)+/iu, "")
    .replace(/(?:呢|呀|嗎|吗)[?？.!！。]*$/u, "").trim();
}
function currentFacetText(question: string): string {
  // Use the existing refusal projection; a declined deliverable may also use
  // "不要價錢" without repeating a lookup verb. Negative product conditions
  // such as "not waterproof" or "no stairs" remain untouched.
  return withoutExcludedLookups(question).split(/[，,;；]|\bbut\b|但(?:係|是)?/iu).map(clause => clause.trim()).filter(Boolean).filter(clause =>
    !/^\s*(?:不要|唔要|不想知道|(?:I\s+)?(?:do not|don't) want)\s*/iu.test(clause) ||
    !(productFactualFacets(clause).length || STOCK.test(clause))).join("; ");
}
function currentFacets(question: string): string[] {
  const text = currentFacetText(question);
  const facts: string[] = [...productFactualFacets(text)];
  const catalogue = catalogueFactRequest(text);
  if (catalogue?.price && !facts.includes("price")) facts.push("price");
  if (STOCK.test(text)) facts.push("stock");
  return unique(facts);
}
/** Cheap route hint only; it neither constructs a query nor admits a read. */
export function hasCurrentFactualReadHint(question: string): boolean {
  return currentFacets(question).length > 0 || Boolean(factualSubject(question, false));
}
function reconcileFacets(question: string, semantic: CommerceSemanticFrame | null): string[] {
  const explicit = currentFacets(question);
  if (!explicit.length) return unique(semantic?.requested_facts ?? []);
  const descriptive = (semantic?.requested_facts ?? []).filter(fact => {
    const known = currentFacets(fact.replace(/_/gu, " "));
    return !known.length;
  });
  // A valid model frame can still mislabel a stock request as price. Known
  // current facets replace its labels; other semantic descriptions remain
  // read hints, and the complete current question remains the answer contract.
  return unique([...explicit, ...descriptive]);
}
type LocatedSubject = { subjects: string[]; reference: string | null };
function locateSubjects(question: string, hints: string[]): LocatedSubject {
  const text = clean(currentFacetText(question))
    .replace(/^(?:不談|不谈|唔講|forget(?: about)?|ignore)\s*[^，,;；]{1,160}[，,;；]\s*/iu, "")
    .replace(/^(?:(?:另外|改問|改问|轉去|转去|轉睇|转看|換個話題|换个话题|轉個話題|转个话题|回到|返回|講返|讲回|其實係|其实是|改成|改返)[，,;；:：\s]*|(?:actually[,;\s]+(?:i (?:mean|meant)\s+)?|i (?:mean|meant)\s+|switch(?:ing)? to\s+|mov(?:e|ing) to\s+|back to\s+|return to\s+|what about\s+))+/iu, "");
  const ids = unique(exactProductIdentifiers(text));
  if (ids.length) return {subjects: ids, reference: ids.length === 1 ? ids[0] : null};
  const literal = literalFactualSubject(text, hints);
  if (validSubject(literal)) return {subjects: [literal], reference: literal};
  const catalogue = catalogueFactRequest(text);
  const catalogueLabel = catalogue ? locatingLabel(catalogue.label) : "";
  if (catalogue && validSubject(catalogueLabel) && !POINTER.test(catalogueLabel)) {
    return {subjects: [catalogueLabel], reference: [catalogueLabel,
      catalogue.color ? `color: ${catalogue.color}` : null,
      catalogue.size ? `size: ${catalogue.size}` : null].filter(Boolean).join(" ")};
  }
  // The refusal projection serializes sentence boundaries as semicolons. Do
  // not let a later instruction become part of a definition's locating name.
  // The complete question still remains in the query and answer contract.
  const factual = factualSubject(clean(currentFacetText(question.split(/[?？]/u, 1)[0])));
  if (validSubject(factual) && !POINTER.test(factual)) return {subjects: [factual], reference: factual};
  const policy = text.match(/(?:退貨政策|退货政策|保養政策|保修政策|付款政策|預約政策|预约政策|取消政策|(?:billing|booking|cancellation|return|warranty)\s+policy)/iu)?.[0];
  if (policy && !POINTER.test(text)) return {subjects: [policy], reference: policy};
  const natural = classifyNaturalCustomerIntent(text);
  if (validSubject(natural.product) && !POINTER.test(natural.product)) return {subjects: [natural.product], reference: natural.product};
  // The existing product grammar recognizes named model facts. A named
  // catalogue/service without a model may use the same ordinary feature or
  // policy construction; retain its literal designation, never infer a name.
  const named = /^(?:請問|请问|請介紹|请介绍|介紹|介绍|tell me about\s+)?\s*(.+?)\s*(?:嘅|的)?\s*(?:功能|特點|特点|規格|规格|退貨政策|退货政策|保養政策|保修政策)(?:係咩|是什麼|是什么|有哪些|有啲咩|呢|呀|嗎|吗)?[?？.!！。]*$/iu.exec(text)?.[1]?.trim() ??
    /^(?:what (?:are|is) (?:the )?)?(?:features?|specifications?)\s+(?:of|for)\s+(?:the )?(.+?)[?？.!！。]*$/iu.exec(text)?.[1]?.trim() ??
    /^(.+?)\s+(?:features?|specifications?|specs?)[?？.!！。]*$/iu.exec(text)?.[1]?.trim();
  if (validSubject(named) && !POINTER.test(named)) return {subjects: [named], reference: named};
  return {subjects: [], reference: null};
}

type SubjectBinding = {subject: string; source_message_id: string | null; customer_text: string | null; current: boolean};
const clearAmbiguity = (): CommerceSemanticAmbiguity => ({is_ambiguous: false, reasons: [], clarification_question: null});
function explicitlyNegatesSubject(text: string, subject: string): boolean {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:\\bnot\\s+|唔係\\s*|不是\\s*|並非\\s*|并非\\s*)${escaped}(?![a-z0-9_-])`, "iu").test(text);
}

/** A model may propose a referent, but only a customer's actual words bind it.
 * Recovered rows have already passed the caller's ticket/tenant/source bound.
 * Retained entities and Memory anchors supply aliases/IDs, never substitute
 * for the original customer text or carry merchant facts into this contract. */
function bindSemanticSubject(ref: string, input: ResolveCurrentFactualRequestInput): SubjectBinding | null {
  const frame = trustedFrame(input.semantic);
  const aliases = unique([
    ref,
    ...(frame?.entities ?? []).filter(entity => entity.confidence >= .62 &&
      [entity.entity_ref, entity.name, entity.model].some(name => norm(name) === norm(ref)))
      .flatMap(entity => [entity.model ?? "", entity.name]),
    ...(input.commerce?.entities ?? []).filter(entity => entityNames(entity).some(name => norm(name) === norm(ref)))
      .flatMap(entityNames),
  ]).filter(validSubject).sort((a, b) => b.length - a.length);
  const current = literalFactualSubject(input.question, aliases);
  if (current && explicitlyNegatesSubject(input.question, current)) return null;
  if (validSubject(current)) return {subject: current, source_message_id: input.source_message_id ?? null,
    customer_text: input.question, current: true};
  const semanticRef = frame?.referents.find(candidate => norm(candidate.ref) === norm(ref));
  if (semanticRef?.source === "current_turn" || semanticRef?.source === "unknown") return null;
  const inactive = new Set((input.commerce?.entities ?? []).filter(entity => INACTIVE.has(entity.status)).flatMap(entityNames).map(norm));
  if (aliases.some(alias => inactive.has(norm(alias)))) return null;
  for (const row of input.history ?? []) {
    if (!CUSTOMER.has(String(row.role ?? "").toLowerCase())) continue;
    const text = clean(row.content);
    if (!text || text === clean(input.question) || row.id && row.id === input.source_message_id || CONTROL_ONLY.test(text)) continue;
    const name = literalFactualSubject(text, aliases);
    if (!validSubject(name)) continue;
    // Only an applicable correction/cancellation can invalidate this named
    // historical reference. An unrelated product or lifecycle turn is not a
    // global history barrier. The semantic demand owns whether a historical
    // subject is intended; this function proves it using actual customer text.
    if (LIFECYCLE_BOUNDARY.test(text) && !/(?:policy|政策|\bif\b|如果|唔好取消|不要取消|do not cancel|don't cancel)/iu.test(text)) return null;
    if (explicitlyNegatesSubject(text, name)) return null;
    return {subject: name, source_message_id: row.id ?? null, customer_text: text, current: false};
  }
  return null;
}

function proposedReferences(frame: CommerceSemanticFrame | null): string[] {
  if (!frame) return [];
  const refs = frame.referents.filter(ref => ref.confidence >= .62 && ref.source !== "unknown").map(ref => ref.ref);
  return refs.length ? unique(refs) : unique(frame.entities.filter(entity => entity.confidence >= .62)
    .map(entity => entity.model ?? entity.name).filter(validSubject));
}

/** A retained read anchor may help locate a literal name, never establish the
 * current subject by itself. In particular, a poisoned "How much? -> old SKU"
 * anchor cannot override the original customer's newer named product. */
function customerSubjectHints(input: ResolveCurrentFactualRequestInput, row?: FactualRequestHistoryRow): string[] {
  const anchored = row?.id ? (input.memory?.factual_read_anchors ?? [])
    .filter(anchor => anchor.source_message_id === row.id && clean(anchor.customer_text) === clean(row.content))
    .flatMap(anchor => anchor.subjects.filter(subject => literalFactualSubject(row.content ?? "", [subject]))) : [];
  return unique([...literalHints(input), ...proposedReferences(trustedFrame(input.semantic)), ...anchored]);
}

function explicitCustomerSubjects(text: string, hints: string[]): string[] {
  const literal = hints.filter(hint => validSubject(hint) && literalFactualSubject(text, [hint]));
  const maximalLiteral = unique(literal).filter(subject => !literal.some(other => norm(subject) !== norm(other) && norm(other).includes(norm(subject))));
  const located = locateSubjects(text, hints).subjects;
  // A grammar-produced label spanning two separately named products is a
  // comparison phrase, not a longer alias that can erase those identities.
  const subjects = maximalLiteral.length > 1 ? unique([...maximalLiteral,
    ...located.filter(subject => !maximalLiteral.some(name => norm(subject).includes(norm(name))))]) : unique([...located, ...literal]);
  // A source may supply both an exact full name and its shorter alias. Keep
  // the maximal literal designation, without translating or inventing aliases.
  return subjects.filter(subject => !POLICY_FACET_LABEL.test(subject) &&
    (!UNNAMED_REFERENCE_LABEL.test(subject) || maximalLiteral.some(literal => norm(literal) === norm(subject))) &&
    !subjects.some(other => norm(subject) !== norm(other) && norm(other).includes(norm(subject))));
}

type CustomerDiscourseFocus = {bindings: SubjectBinding[]; blocked: boolean};
function recentCustomerDiscourseFocus(input: ResolveCurrentFactualRequestInput): CustomerDiscourseFocus {
  const inactive = new Set((input.commerce?.entities ?? []).filter(entity => INACTIVE.has(entity.status)).flatMap(entityNames).map(norm));
  for (const row of input.history ?? []) {
    if (!CUSTOMER.has(String(row.role ?? "").toLowerCase())) continue;
    const text = clean(row.content);
    if (!text || text === "__THINKING__" || row.id && row.id === input.source_message_id ||
      !row.id && text === clean(input.question)) continue;
    const mentioned = explicitCustomerSubjects(text, customerSubjectHints(input, row));
    const subjects = mentioned.filter(subject => !explicitlyNegatesSubject(text, subject));
    if (mentioned.length) {
      if (!subjects.length || subjects.some(subject => inactive.has(norm(subject))) ||
        LIFECYCLE_BOUNDARY.test(text) && !/(?:policy|政策|\bif\b|如果|唔好取消|不要取消|do not cancel|don't cancel)/iu.test(text)) {
        return {bindings: [], blocked: true};
      }
      return {bindings: subjects.map(subject => ({subject, source_message_id: row.id ?? null, customer_text: text, current: false})), blocked: false};
    }
    if (TOPIC_BOUNDARY.test(text) || EXPLICIT_HISTORY_REFERENCE.test(text)) return {bindings: [], blocked: true};
    const operation = classifyCanonicalConversationTurn(text, []).operation;
    const committedCustomerContinuation = !!row.id && ((input.memory?.current_customer_facts ?? [])
      .some(fact => fact.authority === "customer" && fact.source_message_id === row.id) || (input.commerce?.entities ?? [])
      .some(entity => entity.provenance.source_type === "customer" && entity.provenance.source_message_id === row.id && !INACTIVE.has(entity.status)));
    // Only proven control/formatting and subject-less factual continuations
    // preserve the prior focus. An unknown customer statement is a boundary,
    // not permission to scan backwards for a convenient historical SKU.
    if (CONTROL_ONLY.test(text) || !currentFacets(text).length &&
      ["TRIVIAL", "CONVERSATION_MEMORY", "TRANSLATE", "SIMPLIFY", "REPHRASE", "SUMMARIZE"].includes(operation) ||
      committedCustomerContinuation || currentFacets(text).length ||
      POINTER.test(text) && ["PRONOUN_OR_ELLIPSIS", "FOLLOW_UP_FACTUAL"].includes(operation)) continue;
    return {bindings: [], blocked: true};
  }
  return {bindings: [], blocked: false};
}

type DemandSubjectResolution = {bindings: SubjectBinding[]; question: string; unresolved: boolean};
function resolveDemandSubjects(
  input: ResolveCurrentFactualRequestInput, demand: CommerceSemanticDemand, refs: string[], currentSubjects: string[],
): DemandSubjectResolution {
  const original = refs.map(ref => bindSemanticSubject(ref, input));
  const originalBindings = original.filter((binding): binding is SubjectBinding => binding !== null);
  const unchanged = () => ({bindings: originalBindings, question: clean(demand.question), unresolved: refs.length > originalBindings.length});
  if (!["product", "policy", "unknown"].includes(demand.source_type)) return unchanged();
  const quote = clean(demand.source_quote);
  if (demand.source_type === "policy" && refs.length && refs.every(ref => POLICY_FACET_LABEL.test(ref)) &&
    refs.some(ref => literalFactualSubject(quote, [ref]))) return unchanged();
  const mentioned = explicitCustomerSubjects(quote, unique([...customerSubjectHints(input), ...refs]));
  const explicit = mentioned.filter(subject => !explicitlyNegatesSubject(quote, subject));
  // Empty refs can mean deliberate category discovery. Only a genuinely
  // subject-less facet or a pronoun gains a missing referent from history;
  // do not promote a grammar-derived discovery phrase into a named product.
  const dependent = refs.length > 0 || POINTER.test(quote) ||
    demand.source_type !== "policy" && currentFacets(quote).length > 0 && !mentioned.length;
  if (!dependent) return unchanged();
  if (mentioned.length && !explicit.length) return {bindings: [], question: quote, unresolved: true};
  if (!explicit.length && (EXPLICIT_HISTORY_REFERENCE.test(quote) ||
    refs.length > 1 && (PLURAL_POINTER.test(quote) || EXPLICIT_COMPARISON.test(quote)))) return unchanged();
  // A cancelled, negated or invented semantic identity remains invalid. Focus
  // repair corrects a stale but source-proven reference, never grants a new
  // meaning to an unbound identity or revives its lifecycle authority.
  if (!explicit.length && refs.length > originalBindings.length) return unchanged();
  const current = explicit.length ? explicit : currentSubjects;
  const focus = current.length
    ? {bindings: current.map(subject => ({subject, source_message_id: input.source_message_id ?? null, customer_text: input.question, current: true})), blocked: false}
    : TOPIC_BOUNDARY.test(quote) ? {bindings: [], blocked: true} : recentCustomerDiscourseFocus(input);
  if (focus.blocked || !explicit.length && focus.bindings.length > 1) return {bindings: [], question: quote, unresolved: true};
  if (!focus.bindings.length) return unchanged();
  const sameSubjects = focus.bindings.length === originalBindings.length && focus.bindings.every(binding =>
    originalBindings.some(original => norm(original.subject) === norm(binding.subject)));
  // A wrong identity may also have caused the model to attach old, unquoted
  // conditions. Do not transfer those conditions to another subject or silently
  // delete them. A clear simple follow-up can be rebound from customer wording;
  // a conflicting conditioned request remains unresolved for clarification.
  const unboundConditions = Object.keys(demand.constraints).length > 0 || demand.explicit_negations.length > 0 || demand.customer_correction;
  const historicalSubjects = (input.history ?? []).filter(row => CUSTOMER.has(String(row.role ?? "").toLowerCase()))
    .flatMap(row => explicitCustomerSubjects(clean(row.content), customerSubjectHints(input, row)));
  const staleLabels = unique([...refs, ...historicalSubjects, ...exactProductIdentifiers(demand.question),
    ...demand.requested_facts.flatMap(exactProductIdentifiers)]).filter(ref =>
    !focus.bindings.some(binding => norm(binding.subject) === norm(ref)) && !literalFactualSubject(quote, [ref]));
  const staleFact = staleLabels.some(ref => demand.requested_facts.some(fact => literalFactualSubject(fact, [ref])));
  const staleCondition = staleLabels.some(ref => literalFactualSubject(JSON.stringify([demand.constraints, demand.explicit_negations]), [ref]));
  if (!sameSubjects && unboundConditions || staleFact || staleCondition) return {bindings: [], question: quote, unresolved: true};
  const staleQuestion = staleLabels.some(ref => literalFactualSubject(demand.question, [ref]));
  if (sameSubjects && explicit.length && !staleQuestion) return {bindings: focus.bindings, question: clean(demand.question), unresolved: false};
  return {bindings: focus.bindings,
    question: `${focus.bindings.map(binding => binding.subject).join("; ")} ${quote}`, unresolved: false};
}

function subjectConstraints(subjects: string[], input: ResolveCurrentFactualRequestInput): Record<string, DecisionValue> {
  let result: Record<string, DecisionValue> = {};
  for (const entity of input.commerce?.entities ?? []) {
    if (INACTIVE.has(entity.status) || entity.provenance.source_type !== "customer" || !entity.provenance.source_message_id ||
      !entityNames(entity).some(name => subjects.some(subject => norm(name) === norm(subject)))) continue;
    const source = (input.history ?? []).find(row => row.id === entity.provenance.source_message_id && CUSTOMER.has(String(row.role ?? "").toLowerCase()));
    if (!source || !subjects.some(subject => literalFactualSubject(source.content ?? "", [subject]))) continue;
    result = mergeDecisionContext(result, entity.constraints);
  }
  return result;
}

function isKbDemand(demand: CurrentFactualDemand): boolean {
  return ["product", "policy", "unknown"].includes(demand.source_type);
}

/** Structured semantic demands own scope. This layer validates their source
 * quotes/references and preserves every demand; it does not classify them a
 * second time using product words or give any demand evidence authority. */
function resolveSemanticDemands(input: ResolveCurrentFactualRequestInput, proposed: CommerceSemanticDemand[]): CurrentFactualRequest {
  const question = clean(input.question), frame = input.semantic!;
  const missing: FactualRequestMissingEvidence[] = [];
  const contexts: string[] = [];
  const bindings: Array<SubjectBinding & {demand_id: string}> = [];
  const privateLocators = new Map<string, string[]>();
  const explicitCurrentSubjects = unique(proposed.filter(demand => ["product", "policy", "unknown"].includes(demand.source_type) &&
    (demand.subject_refs.length > 0 || proposedReferences(trustedFrame(input.semantic)).some(ref => literalFactualSubject(demand.source_quote, [ref]))) &&
    (demand.source_type !== "policy" || demand.subject_refs.some(ref => !POLICY_FACET_LABEL.test(ref) && literalFactualSubject(demand.source_quote, [ref]))) &&
    !!clean(demand.source_quote) && norm(question).includes(norm(demand.source_quote)))
    .flatMap(demand => explicitCustomerSubjects(clean(demand.source_quote), unique([...customerSubjectHints(input), ...demand.subject_refs]))
      .filter(subject => !explicitlyNegatesSubject(clean(demand.source_quote), subject))));
  const demands = proposed.map((demand, index): CurrentFactualDemand => {
    const id = `demand-${index + 1}`;
    const sourceQuote = clean(demand.source_quote);
    const quoteBound = !!sourceQuote && norm(question).includes(norm(sourceQuote));
    const ambiguity: CommerceSemanticAmbiguity = {
      is_ambiguous: demand.ambiguity.is_ambiguous,
      reasons: [...demand.ambiguity.reasons], clarification_question: demand.ambiguity.clarification_question,
    };
    if (!quoteBound) {
      ambiguity.is_ambiguous = true; ambiguity.reasons.push("source_quote_unbound");
      missing.push({demand_id: id, reason: "source_quote_unbound"});
    }
    const refs = demand.subject_refs.length ? demand.subject_refs : demand.source_type === "product"
      ? proposedReferences(trustedFrame(frame)) : [];
    if (quoteBound && demand.source_type === "transaction") privateLocators.set(id,
      refs.filter(ref => norm(sourceQuote).includes(norm(ref))));
    const resolved = quoteBound && !demand.ambiguity.is_ambiguous
      ? resolveDemandSubjects(input, demand, refs, explicitCurrentSubjects)
      : {bindings: [], question: clean(demand.question), unresolved: false};
    const located = resolved.bindings;
    // Product/category discovery may intentionally have no specific item.
    // Missing-reference ambiguity belongs to the semantic demand, not to a
    // new rule that every product read must name a SKU before searching.
    const unresolved = resolved.unresolved;
    if (quoteBound && unresolved && !demand.ambiguity.is_ambiguous) {
      ambiguity.is_ambiguous = true; ambiguity.reasons.push("subject_not_bound_to_customer_source");
      missing.push({demand_id: id, reason: "subject_unresolved"});
    }
    if (demand.ambiguity.is_ambiguous) missing.push({demand_id: id, reason: "semantic_ambiguity"});
    if (quoteBound && demand.source_type === "transaction") missing.push({demand_id: id, reason: "live_transaction_unavailable"});
    bindings.push(...located.map(binding => ({...binding, demand_id: id})));
    if (["product", "policy", "unknown"].includes(demand.source_type)) contexts.push(...located.filter(binding => !binding.current && binding.customer_text).map(binding => clean(binding.customer_text)));
    const subjects = unique(located.map(binding => binding.subject));
    return {
      id, question: resolved.question, source_quote: sourceQuote, subjects,
      subject_source_message_ids: unique(located.map(binding => binding.source_message_id ?? "")),
      source_type: demand.source_type, requested_facts: unique(demand.requested_facts),
      constraints: mergeDecisionContext(subjectConstraints(subjects, input), demand.constraints),
      customer_correction: demand.customer_correction, explicit_negations: [...demand.explicit_negations], ambiguity,
    };
  });
  // Excluding a transaction demand alone is insufficient when a model quotes
  // the entire mixed message as a KB demand. Keep the request pending instead
  // of forwarding the overlapping private clause or identifier to retrieval.
  const transactions = demands.filter(demand => demand.source_type === "transaction" &&
    !missing.some(item => item.demand_id === demand.id && item.reason === "source_quote_unbound"));
  for (const demand of demands.filter(isKbDemand)) {
    const overlaps = transactions.some(transaction => {
      const a = norm(demand.source_quote), b = norm(transaction.source_quote);
      return !!a && !!b && (a.includes(b) || b.includes(a)) || [...transaction.subjects, ...(privateLocators.get(transaction.id) ?? [])].some(subject =>
        !demand.subjects.some(value => norm(value) === norm(subject)) &&
        norm(JSON.stringify([demand.question, demand.source_quote, demand.subjects, demand.constraints,
          demand.requested_facts, demand.explicit_negations])).includes(norm(subject)));
    });
    if (overlaps) {
      demand.ambiguity.is_ambiguous = true;
      demand.ambiguity.reasons.push("transaction_scope_overlap");
      missing.push({demand_id: demand.id, reason: "transaction_scope_overlap"});
    }
  }
  const boundDemands = demands.filter(demand => !missing.some(item => item.demand_id === demand.id && item.reason === "source_quote_unbound"));
  const kbDemands = boundDemands.filter(isKbDemand);
  const subjects = unique(kbDemands.flatMap(demand => demand.subjects));
  const allSourceIds = unique(demands.flatMap(demand => demand.subject_source_message_ids));
  const kbIds = new Set(kbDemands.map(demand => demand.id));
  const kbBindings = [...new Map(bindings.filter(binding => kbIds.has(binding.demand_id)).map(binding =>
    [JSON.stringify([norm(binding.subject), binding.source_message_id]), binding])).values()];
  const currentSubjects = kbBindings.filter(binding => binding.current);
  const priorSubjects = kbBindings.filter(binding => !binding.current);
  const needsSubject = kbDemands.length > 0 && kbDemands.every(demand => demand.ambiguity.is_ambiguous);
  // Preserve the entire original request for answer generation/verification;
  // only the retrieval projection excludes guidance and private transactions.
  const resolvedContext = unique(priorSubjects.map(binding => binding.subject));
  const answerRequest = kbDemands.length
    ? [question, resolvedContext.length ? `[Resolved subjects: ${resolvedContext.join("; ")}]` : null].filter(Boolean).join("\n") : null;
  const request: CurrentFactualRequest = {
    version: "current-factual-request-1", source_message_id: input.source_message_id ?? null,
    original_question: input.question, interpretation_source: "semantic_demands",
    applicable: kbDemands.length > 0, question, merchant_request: kbDemands.map(demand => demand.source_quote).join("; ") || null,
    subject: subjects.length === 1 ? subjects[0] : null, subjects,
    requested_facts: unique(kbDemands.flatMap(demand => demand.requested_facts)), query: null, answer_request: answerRequest,
    resolution: subjects.length ? currentSubjects.length ? "explicit" : "follow_up" : needsSubject ? "unresolved" : "none",
    subject_source_message_id: priorSubjects.length === 1 ? priorSubjects[0].source_message_id : currentSubjects.length === 1 ? currentSubjects[0].source_message_id : null,
    subject_source_message_ids: allSourceIds, demands,
    kb_required: kbDemands.length > 0, transaction_required: boundDemands.some(demand => demand.source_type === "transaction"),
    unresolved_demand_ids: unique(missing.map(item => item.demand_id)), missing_evidence: missing,
    // This flag records an explicit switch/correction marker. The source-bound
    // subjects above establish focus even when a new name has no such marker.
    topic_changed: TOPIC_BOUNDARY.test(question) || frame.customer_correction,
    context_turns: unique(contexts), needs_subject_clarification: needsSubject,
  };
  if (request.applicable) request.query = serializeCurrentFactualQuery(input, request);
  return request;
}

/** Shared legacy serializer. It retains typed, bounded customer requirements;
 * a resolved current subject narrows state matching instead of appending every
 * retained entity or an unrelated historical topic. */
export function serializeCurrentFactualQuery(
  input: ResolveCurrentFactualRequestInput, request: CurrentFactualRequest, forceContext = false,
): string {
  if (request.interpretation_source === "semantic_demands" && request.applicable) {
    const demands = request.demands.filter(demand => isKbDemand(demand) && !demand.ambiguity.is_ambiguous &&
      !request.missing_evidence.some(missing => missing.demand_id === demand.id && missing.reason === "source_quote_unbound"));
    // Keep the complete request as the answer contract, while the retrieval
    // projection contains only KB needs. No transaction identifier/history or
    // declined general-guidance clause is appended merely to fill a query.
    const query = JSON.stringify({questions: demands.map(demand => ({
      question: demand.question, ...(demand.question !== demand.source_quote ? {customer_text: demand.source_quote} : {}), subjects: demand.subjects,
      requested_facts: demand.requested_facts, source_type: demand.source_type,
      ...(demand.source_type === "policy" ? {scope: "merchant_rules_and_subject_exceptions"} : {}),
      ...(Object.keys(demand.constraints).length ? {constraints: demand.constraints} : {}),
      ...(demand.explicit_negations.length ? {explicit_negations: demand.explicit_negations} : {}),
    }))});
    return demands.length ? assertFactualQueryBudget(query) : "";
  }
  if (request.needs_subject_clarification && !forceContext) {
    const query = request.merchant_request ?? request.question;
    return assertFactualQueryBudget(query);
  }
  const semantic = trustedFrame(input.semantic), state = input.commerce;
  const scope = new Set(request.subjects.map(norm));
  const semanticEntities = semantic?.entities.filter(entity => entity.confidence >= 0.62) ?? [];
  const topic = request.subject ?? (!request.topic_changed && !scope.size ? semantic?.topic ?? state?.current_topic : null) ?? null;
  const refs = new Set(semantic?.referents.filter(ref => ref.confidence >= 0.62 && ref.source !== "unknown").map(ref => norm(ref.ref)) ?? []);
  const semanticSubjects = new Set(semanticEntities.flatMap(entity => [entity.entity_ref, entity.name, entity.model].map(norm)).filter(Boolean));
  const active = (state?.entities ?? []).filter(entity => !INACTIVE.has(entity.status));
  const identity = (entity: typeof active[number]) => entityNames(entity).map(norm);
  const entities = active.filter(entity => scope.size ? identity(entity).some(value => scope.has(value))
    : request.topic_changed ? false
    : refs.size ? identity(entity).some(value => refs.has(value))
    : semanticSubjects.size ? identity(entity).some(value => semanticSubjects.has(value)) || semanticSubjects.has(norm(entity.category))
    : norm(entity.category) === norm(topic) || identity(entity).includes(norm(topic)));
  const current = semanticEntities.filter(entity => {
    const names = [entity.entity_ref, entity.name, entity.model].map(norm).filter(Boolean);
    if ((state?.entities ?? []).some(prior => INACTIVE.has(prior.status) && identity(prior).some(value => names.includes(value)))) return false;
    if (scope.size) return names.some(value => scope.has(value));
    return !request.topic_changed || names.some(value => Boolean(literalFactualSubject(request.merchant_request ?? request.question, [value])));
  });
  const matches = (entity: typeof entities[number], next: typeof current[number]) =>
    [next.entity_ref, next.name, next.model].map(norm).some(value => value && identity(entity).includes(value));
  const readEntity = (entity: typeof entities[number]) => ({
    subject: entity.model ?? entity.attributes.model ?? entity.attributes.product_name ?? entity.attributes.name ?? entity.category,
    unit: typeof entity.attributes.unit === "string" ? clean(entity.attributes.unit) : null,
    quantity: entity.attributes.quantity_basis === "customer_explicit" ? entity.quantity : null,
    constraints: normalizeDecisionContext(entity.constraints), attributes: normalizeDecisionContext(entity.attributes.semantic_attributes),
  });
  const prior = entities.filter(entity => !current.some(next => matches(entity, next))).map(readEntity);
  const projected = current.map(entity => {
    const candidates = entities.filter(previous => matches(previous, entity));
    const previous = candidates.length === 1 ? candidates[0] : null;
    return {subject: entity.model ?? entity.name, unit: entity.unit ?? previous?.attributes.unit ?? null,
      quantity: entity.quantity ?? (previous?.attributes.quantity_basis === "customer_explicit" ? previous.quantity : null),
      constraints: mergeDecisionContext(previous?.constraints, entity.constraints),
      attributes: mergeDecisionContext(previous?.attributes.semantic_attributes, entity.attributes)};
  });
  const needsContext = forceContext || prior.length > 0 || projected.some(entity =>
    entity.quantity !== null || entity.unit !== null || Object.keys(entity.constraints).length || Object.keys(entity.attributes).length) ||
    Boolean(semantic?.explicit_negations.length) || (!request.subject && Boolean(topic)) ||
    request.requested_facts.some(fact => !currentFacets(fact.replace(/_/gu, " ")).length && !norm(request.question).includes(norm(fact)));
  if (!needsContext) {
    const query = request.answer_request ?? request.merchant_request ?? request.question;
    return assertFactualQueryBudget(query);
  }
  const context = {
    ...(request.resolution === "follow_up" && request.subject ? {resolved_subject: request.subject} : {}),
    question: request.merchant_request ?? request.question,
    topic: topic ? clean(topic) : null,
    requested_facts: request.requested_facts,
    explicit_negations: semantic?.explicit_negations ?? [],
    current: projected, prior,
  };
  const query = JSON.stringify(context);
  return assertFactualQueryBudget(query);
}

/** Matches the existing adapter/admission budgets before any paid dispatch. */
export function assertFactualQueryBudget(query: string): string {
  if (query.length > 1000 || new TextEncoder().encode(query).length > 2048) throw new DecisionContextLimitError();
  return query;
}

function resolveLegacyCurrentFactualRequest(input: ResolveCurrentFactualRequestInput): CurrentFactualRequest {
  const question = clean(input.question), history = input.history ?? [];
  const rows = semanticRows(history), semantic = trustedFrame(input.semantic);
  const decision = input.request_decision ?? resolveCustomerRequestDecision(question, input.semantic ?? null,
    rows.map(row => ({...row, role: row.role ?? "", content: row.content ?? ""})));
  const turn = classifyCanonicalConversationTurn(question, rows);
  const topicChanged = TOPIC_BOUNDARY.test(question) || turn.topic_action === "SWITCH" || turn.topic_action === "CORRECT";
  const empty: CurrentFactualRequest = {version: "current-factual-request-1", source_message_id: input.source_message_id ?? null,
    original_question: input.question, interpretation_source: "legacy_compatibility", applicable: false, question,
    merchant_request: null, subject: null, subjects: [], requested_facts: [], query: null, answer_request: null,
    resolution: "none", subject_source_message_id: null, subject_source_message_ids: [], demands: [], kb_required: false,
    transaction_required: false, unresolved_demand_ids: [], missing_evidence: [],
    topic_changed: topicChanged, context_turns: [], needs_subject_clarification: false};
  const transform = ["CONVERSATION_MEMORY", "SIMPLIFY", "REPHRASE", "TRANSLATE", "SUMMARIZE", "TRIVIAL", "EXPLICIT_HANDOFF"].includes(turn.operation);
  if (!question || decision.kind === "guidance" || isCurrentRequirementsRecap(question) || isPersonalOrderStatusRequest(question) ||
    transform && !(semantic?.operation === "ASK_FACT" && decision.kind === "mixed")) return empty;
  const merchant = decision.kind === "mixed" && decision.merchant_request ? clean(decision.merchant_request) : question;
  const literalFacts = currentFacets(merchant);
  const hints = literalHints(input);
  const located = locateSubjects(merchant, hints);
  const semanticRead = Boolean(semantic && (semantic.operation === "ASK_FACT" || semantic.requested_facts.length ||
    ["explore_options", "recommend_options", "compare_options"].includes(semantic.intent)));
  const dependentFactual = POINTER.test(merchant) &&
    ["PRONOUN_OR_ELLIPSIS", "FOLLOW_UP_FACTUAL"].includes(turn.operation);
  // Broad assessment language can describe the customer's draft or supplied
  // requirements. Without a located product, dependency or semantic read,
  // "assess" alone must not force a product lookup/clarification. Likewise a
  // correction may locate a subject but is not itself a factual speech act.
  const literalRead = literalFacts.some(fact => fact !== "suitability" || located.subjects.length > 0 || dependentFactual);
  if (!literalRead && !factualSubject(merchant, false) && !dependentFactual && !semanticRead &&
    !["merchant_facts", "mixed"].includes(decision.kind)) return empty;
  const request: CurrentFactualRequest = {...empty, applicable: true, merchant_request: merchant,
    requested_facts: reconcileFacets(merchant, semantic), subjects: located.subjects,
    subject: located.subjects.length === 1 ? located.subjects[0] : null,
    resolution: located.subjects.length ? "explicit" : "unresolved", answer_request: merchant};
  const inactive = new Set((input.commerce?.entities ?? []).filter(entity => INACTIVE.has(entity.status)).flatMap(entityNames).map(norm));
  const semanticRefs = semanticRead ? proposedReferences(semantic) : [];
  const needsSubject = !located.subjects.length && (POINTER.test(merchant) ||
    literalFacts.some(fact => fact !== "policy") || semanticRefs.length > 0);
  // An explicit current subject always wins. Only dependent questions search
  // history, and a changed/ambiguous topic never revives an older candidate.
  if (needsSubject && !topicChanged && !PLURAL_POINTER.test(merchant)) {
    let skippedCurrent = false;
    let historyBoundary = false;
    // Validated semantic dependencies are not restricted to price/stock
    // wording. For any requested fact, the proposed reference still needs an
    // actual customer mention; no model-only entity can manufacture a target.
    const semanticBindings = semanticRefs.map(ref => bindSemanticSubject(ref, input));
    const semanticBinding = semanticBindings.length === 1 ? semanticBindings[0] : null;
    if (semanticBinding) {
      request.subject = semanticBinding.subject; request.subjects = [semanticBinding.subject];
      request.resolution = semanticBinding.current ? "explicit" : "follow_up";
      request.subject_source_message_id = semanticBinding.source_message_id;
      request.context_turns = semanticBinding.current || !semanticBinding.customer_text ? [] : [clean(semanticBinding.customer_text)];
      request.answer_request = `${semanticBinding.subject} ${merchant}`;
    } else if (semanticBindings.length > 1) historyBoundary = true;
    // Preserve the existing source-bound generic service/policy locator. Its
    // cited name must match a customer turn; the old answer is never copied.
    // This also handles natural first-turn wording that does not fit a product
    // grammar, and narrows descriptive scheme names via the existing anchor.
    const grounded = resolveFactualFollowup(merchant, rows.slice(0, 32));
    if (!request.subject && !historyBoundary && grounded && validSubject(grounded.subject) && !POINTER.test(grounded.subject)) {
      const prior = locateSubjects(grounded.prior_question, unique([...hints, grounded.subject]));
      historyBoundary = inactive.has(norm(grounded.subject)) || prior.subjects.length > 1;
      if (!historyBoundary) {
        request.subject = grounded.subject; request.subjects = [grounded.subject];
        request.resolution = "follow_up"; request.subject_source_message_id = grounded.source_message_id;
        request.context_turns = [clean(grounded.prior_question)];
        request.answer_request = `${grounded.subject} ${merchant}`;
      }
    }
    for (const row of request.subject || historyBoundary ? [] : history.slice(0, 32)) {
      if (!CUSTOMER.has(String(row.role ?? "").toLowerCase())) continue;
      const text = clean(row.content);
      if (!text || text === "__THINKING__") continue;
      if (!skippedCurrent && text === question) { skippedCurrent = true; continue; }
      if (CONTROL_ONLY.test(text)) continue;
      if (LIFECYCLE_BOUNDARY.test(text) && !/(?:policy|政策|\bif\b|如果|唔好取消|不要取消|do not cancel|don't cancel)/iu.test(text)) { historyBoundary = true; break; }
      const prior = locateSubjects(text, hints);
      if (prior.subjects.length === 1 && !inactive.has(norm(prior.subjects[0]))) {
        request.subject = prior.subjects[0]; request.subjects = prior.subjects;
        request.resolution = "follow_up"; request.subject_source_message_id = row.id ?? null;
        request.context_turns = [text];
        request.answer_request = `${prior.reference ?? request.subject} ${merchant}`;
        break;
      }
      if (prior.subjects.length || TOPIC_BOUNDARY.test(text)) { historyBoundary = true; break; }
      // Skip only another subject-less factual follow-up, never an unrelated
      // customer topic or unknown statement to reach a convenient old item.
      if (!currentFacets(text).length && !POINTER.test(text)) { historyBoundary = true; break; }
    }
  }
  request.needs_subject_clarification = needsSubject && !request.subject;
  request.query = serializeCurrentFactualQuery(input, request);
  return request;
}

export function resolveCurrentFactualRequest(input: ResolveCurrentFactualRequestInput): CurrentFactualRequest {
  if (input.semantic && input.semantic.confidence >= .62 &&
    (input.semantic.demands?.length || input.request_decision?.semantic_demands !== undefined)) {
    const decision = input.request_decision?.semantic_demands !== undefined ? input.request_decision :
      resolveCustomerRequestDecision(input.question, input.semantic,
        (input.history ?? []).map(row => ({...row, role: row.role ?? "", content: row.content ?? ""})));
    const frame = applyCustomerRequestDecision(input.semantic, decision);
    const proposed = (input.semantic.demands ?? []).filter(demand => !(decision.excluded_lookup_quotes ?? []).includes(demand.source_quote));
    return resolveSemanticDemands({...input, semantic: frame, request_decision: decision}, proposed);
  }
  // Old/manual callers retain their bounded behavior. Their interpretation is
  // explicitly marked compatibility data; it must not masquerade as a newly
  // source-validated semantic decomposition of every possible customer need.
  const request = resolveLegacyCurrentFactualRequest(input);
  request.kb_required = request.applicable;
  request.transaction_required = isPersonalOrderStatusRequest(input.question);
  request.subject_source_message_ids = unique([
    request.subject_source_message_id ?? "",
    ...(request.resolution === "explicit" && request.subjects.length ? [input.source_message_id ?? ""] : []),
  ]);
  const sourceType: FactualDemandSourceType = request.transaction_required ? "transaction" : request.applicable ? "unknown" : "general";
  request.demands = [{id: "demand-1", question: request.question, source_quote: request.original_question,
    subjects: request.subjects, subject_source_message_ids: request.subject_source_message_ids,
    source_type: sourceType, requested_facts: request.requested_facts,
    constraints: subjectConstraints(request.subjects, input), customer_correction: input.semantic?.customer_correction ?? false,
    explicit_negations: [...(input.semantic?.explicit_negations ?? [])],
    ambiguity: request.needs_subject_clarification
      ? {is_ambiguous: true, reasons: ["subject_not_bound_to_customer_source"], clarification_question: null}
      : clearAmbiguity()}];
  if (request.transaction_required) request.missing_evidence.push({demand_id: "demand-1", reason: "live_transaction_unavailable"});
  if (request.needs_subject_clarification) request.missing_evidence.push({demand_id: "demand-1", reason: "subject_unresolved"});
  request.unresolved_demand_ids = unique(request.missing_evidence.map(item => item.demand_id));
  if (request.applicable && request.answer_request && request.merchant_request !== request.question) {
    request.answer_request = [request.question, request.subject && request.resolution === "follow_up" ? `[Resolved subject: ${request.subject}]` : null].filter(Boolean).join("\n");
  }
  return request;
}
