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
  resolveCustomerRequestDecision, withoutExcludedLookups, type CustomerRequestDecision,
} from "./commerce-state-authority.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import { DecisionContextLimitError, mergeDecisionContext, normalizeDecisionContext } from "./bounded-decision-context.ts";

/** A read target, not merchant evidence, transaction authority or a state delta.
 * History must already be bounded to the caller's source, ticket and tenant.
 * Latest customer wording owns the requested facets; history only locates a
 * missing subject. No prior answer's price, stock or policy is copied here. */
export interface CurrentFactualRequest {
  version: "current-factual-request-1";
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
  history?: FactualRequestHistoryRow[];
  semantic?: CommerceSemanticFrame | null;
  commerce?: ConversationCommerceState | null;
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
    /^(?:what (?:are|is) (?:the )?)?(?:features?|specifications?)\s+(?:of|for)\s+(?:the )?(.+?)[?？.!！。]*$/iu.exec(text)?.[1]?.trim();
  if (validSubject(named) && !POINTER.test(named)) return {subjects: [named], reference: named};
  return {subjects: [], reference: null};
}

/** Shared legacy serializer. It retains typed, bounded customer requirements;
 * a resolved current subject narrows state matching instead of appending every
 * retained entity or an unrelated historical topic. */
export function serializeCurrentFactualQuery(
  input: ResolveCurrentFactualRequestInput, request: CurrentFactualRequest, forceContext = false,
): string {
  if (request.needs_subject_clarification && !forceContext) {
    const query = request.merchant_request ?? request.question;
    if (query.length > 1000) throw new DecisionContextLimitError();
    return query;
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
    if (query.length > 1000) throw new DecisionContextLimitError();
    return query;
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
  if (query.length > 1000) throw new DecisionContextLimitError();
  return query;
}

export function resolveCurrentFactualRequest(input: ResolveCurrentFactualRequestInput): CurrentFactualRequest {
  const question = clean(input.question), history = input.history ?? [];
  const rows = semanticRows(history), semantic = trustedFrame(input.semantic);
  const decision = input.request_decision ?? resolveCustomerRequestDecision(question, input.semantic ?? null,
    rows.map(row => ({...row, role: row.role ?? "", content: row.content ?? ""})));
  const turn = classifyCanonicalConversationTurn(question, rows);
  const topicChanged = TOPIC_BOUNDARY.test(question) || turn.topic_action === "SWITCH" || turn.topic_action === "CORRECT";
  const empty: CurrentFactualRequest = {version: "current-factual-request-1", applicable: false, question,
    merchant_request: null, subject: null, subjects: [], requested_facts: [], query: null, answer_request: null,
    resolution: "none", subject_source_message_id: null, topic_changed: topicChanged, context_turns: [], needs_subject_clarification: false};
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
  const needsSubject = !located.subjects.length && (POINTER.test(merchant) ||
    literalFacts.some(fact => fact !== "policy"));
  // An explicit current subject always wins. Only dependent questions search
  // history, and a changed/ambiguous topic never revives an older candidate.
  if (needsSubject && !topicChanged && !PLURAL_POINTER.test(merchant)) {
    let skippedCurrent = false;
    let historyBoundary = false;
    // Preserve the existing source-bound generic service/policy locator. Its
    // cited name must match a customer turn; the old answer is never copied.
    // This also handles natural first-turn wording that does not fit a product
    // grammar, and narrows descriptive scheme names via the existing anchor.
    const grounded = resolveFactualFollowup(merchant, rows.slice(0, 32));
    if (grounded && validSubject(grounded.subject) && !POINTER.test(grounded.subject)) {
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
    if (!request.subject && !historyBoundary && semantic) {
      // A server-scoped unique active referent can locate a read when the
      // bounded recent history does not contain its original customer turn.
      const refs = semantic.referents.filter(ref => ref.confidence >= .62 && ref.source !== "unknown").map(ref => norm(ref.ref));
      const matches = (input.commerce?.entities ?? []).filter(entity => !INACTIVE.has(entity.status) &&
        entityNames(entity).some(name => refs.includes(norm(name))));
      const candidate = matches.length === 1 && refs.length === 1 ? matches[0] : null;
      const name = candidate ? clean(candidate.model ?? candidate.attributes.model ?? candidate.attributes.product_name ?? candidate.attributes.name) : "";
      // Preserve existing generic-service typed requirement reads. Unlike a
      // bare price/stock follow-up, these carry a current validated entity and
      // decision context; they still gain no merchant evidence authority.
      const generic = !literalFacts.length && !history.length && semantic.entities.length === 1 &&
        semantic.entities[0].confidence >= .62 ? semantic.entities[0] : null;
      const genericName = generic ? clean(generic.model ?? generic.name) : "";
      const target = validSubject(name) ? name : validSubject(genericName) && !inactive.has(norm(genericName)) ? genericName : null;
      if (target) {
        request.subject = target; request.subjects = [target]; request.resolution = "follow_up";
        request.subject_source_message_id = candidate?.provenance.source_message_id ?? null;
        request.answer_request = `${target} ${merchant}`;
      }
    }
  }
  request.needs_subject_clarification = needsSubject && !request.subject;
  request.query = serializeCurrentFactualQuery(input, request);
  return request;
}
