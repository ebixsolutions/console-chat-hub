/**
 * Universal context binding for an industry adapter's structured customer turn.
 * The core knows entities, scopes and event authority, never industry vocabulary.
 */
import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import { matchesReferenceLabel } from "./industry-agent-registry.ts";
import { sourceOwnedSubjectLabels } from "./commerce-subject-resolution.ts";
import type { CommerceStateEvent } from "./commerce-state-reducer.ts";

export interface ScopedCustomerValue {
  scope: string;
  attribute: string;
  action: "set";
  value: string | number | boolean;
  /** Exact verified customer phrase; member ids stay separate from display. */
  source_text?: string;
  source_message_id?: string;
  source_revision?: number;
}

export interface ContextualCandidate {
  topic: string;
  topic_source: "explicit" | "profile" | "semantic";
  entity_id?: string;
  action: "enquiry" | "scoped_update";
  values: ScopedCustomerValue[];
  /** Explicit aggregate from the adapter; partial scoped changes must not invent it. */
  aggregate_quantity?: number;
  context_sufficient: boolean;
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
    // Never take precedence over a published-KB, policy, price, inventory or
    // transaction demand. General, fact-free advice can only ask one useful
    // follow-up about a literal current-turn subject.
    if (f.operation !== "ASK_FACT" || f.confidence < 0.9 ||
      f.ambiguity.is_ambiguous || f.customer_correction || f.additive ||
      f.explicit_negations.length !== 0 || f.entities.length !== 1 ||
      !item || item.confidence < 0.9 || item.quantity !== null ||
      !["customer_guidance", "ask_for_advice"].includes(f.intent) ||
      !item.name || !matchesReferenceLabel(text, item.name)) return null;
    // The existing fact-free advisory remains unchanged. A first-turn enquiry
    // with a verified source-quoted, unresolved product/general demand can
    // receive a known-first clarification without claiming merchant specs.
    const existingAdvisory = f.requested_facts.length === 0 &&
      (f.demands ?? []).length === 0;
    const requests = f.demands ?? [];
    const allDemandsSourced = requests.length <= 1 && requests.every(d => {
      const quote = d.source_quote.normalize("NFKC").replace(/\s+/gu, " ").trim();
      return quote.length >= 4 && text.includes(quote) &&
        !d.ambiguity.is_ambiguous && !d.customer_correction &&
        d.explicit_negations.length === 0 &&
        (d.source_type === "product" || d.source_type === "general");
    });
    const firstTurnGuidance = input.state.entities.length === 0 &&
      text.length >= 4 && text.length <= 240 && !item.model && !item.sku &&
      allDemandsSourced && f.requested_facts.length <= 8;
    if (!existingAdvisory && !firstTurnGuidance) return null;
    const name = item.name.normalize("NFKC").trim().slice(0, 100);
    const reply = firstTurnGuidance && !existingAdvisory
      ? input.language === "en"
        ? "You asked: '" + text + "'. I can start from your stated conditions. To give reliable guidance, please share the relevant area, size or limits for each scope. I cannot verify a specification or an order yet."
        : input.language === "zh-CN"
          ? "你问的是「" + text + "」。我可以先按你说过的要求整理；要提供可靠建议，请补充各个范围的面积、尺寸或其他限制。目前不能确认具体规格，也不是已下单。"
          : "你問緊「" + text + "」。我可以先按你講過嘅要求整理；要提供可靠指引，請補充各個範圍嘅面積、尺寸或其他限制。而家未能核實具體規格，亦唔代表已落單。"
      : input.language === "en"
        ? "For " + name + ", what is the main intended use or constraint? This is guidance, not an order."
        : input.language === "zh-CN"
          ? "关于「" + name + "」，最需要考虑的用途或限制是什么？现在只是选购讨论，未下单。"
          : "關於「" + name + "」，你最想優先考慮嘅用途或限制係乜？而家只係選購討論，未落單。";
    return { topic: name, topic_source: "semantic", action: "enquiry",
      values: [], context_sufficient: true, reply, clarification: question };
  }
  if (!item || f.confidence < 0.9 || item.confidence < 0.9 ||
    f.ambiguity.is_ambiguous || f.customer_correction || f.additive ||
    f.explicit_negations.length > 0 ||
    !["UPDATE_ITEM", "SET_QUANTITY"].includes(f.operation) ||
    (f.demands ?? []).length > 0 || proposed.length < 1 ||
    proposed.length > 8 || !text) return invalid();

  const active = input.state.entities.filter(e =>
    e.provenance.source_type === "customer" &&
    Boolean(e.provenance.source_message_id) &&
    !["cancelled", "deferred", "superseded"].includes(e.status));
  const named = active.filter(e => sourceOwnedSubjectLabels(e).some(label =>
    matchesReferenceLabel(text, label)));
  const referenced = active.filter(e => item.entity_ref === e.entity_id &&
    f.referents.some(r => r.ref === e.entity_id &&
      r.source === "persistent_state" && r.confidence >= 0.9));
  // A model-supplied ID cannot select one of multiple active entities unless
  // the Visitor independently names that existing item in the latest turn.
  const matches = active.length === 1
    ? active.filter(e => named.includes(e) || referenced.includes(e))
    : active.filter(e => named.includes(e) &&
      (item.entity_ref === e.entity_id || referenced.includes(e)));
  if (matches.length !== 1) return invalid();
  const target = matches[0];
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
      // Grammar is language-level "N scopes, M each", not a room/industry
      // dictionary. Both numerical tokens, the literal scope label, the
      // distributive marker and the item unit must be visible in this one
      // Visitor quote. No previous unverified history or model-only count.
      const quantities = [...quote.matchAll(new RegExp(
        "([0-9]{1,4}|[零〇一二兩两三四五六七八九十]|\\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\\b)",
        "giu",
      ))];
      if (quantities.length !== 2 || quantities.some(m => m.index === undefined))
        return invalid();
      const first = quantities[0], second = quantities[1];
      const number = (s: string): number =>
        Object.prototype.hasOwnProperty.call(words, s.toLowerCase())
          ? words[s.toLowerCase()] : Number(s);
      const n = number(first[0]), each = number(second[0]);
      if (!Number.isInteger(n) || !Number.isInteger(each) ||
        n < 1 || n > 12 || each < 1 || each > 100 ||
        n * each > 1000 || row.scope_count !== n ||
        row.per_scope_quantity !== each || row.value !== each)
        return invalid();
      const middle = quote.slice(first.index! + first[0].length, second.index!);
      const after = quote.slice(second.index! + second[0].length).trim();
      const sourceName = middle.toLowerCase().indexOf(scope.toLowerCase());
      const afterUnit = after.slice(sourceUnit.length);
      const beforeEach = /(?:各|每|\beach\b|\bper\b)/iu.test(middle);
      const trailingEach = /^\s+each\s*[.!。]?$/iu.test(afterUnit);
      if (sourceName < 0 || middle.toLowerCase().indexOf(scope.toLowerCase(), sourceName + 1) >= 0 ||
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
        values.push({scope: distinct, attribute: "quantity", action: "set", value: each, source_text: quote});
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
  const previousScopes = Array.isArray(target.attributes.scoped_customer_updates) &&
    target.attributes.scoped_customer_updates.length > 0;
  const name = typeof target.attributes.product_name === "string" &&
    target.attributes.product_name.trim()
    ? target.attributes.product_name : target.model ?? target.category;
  const entries = displayQuotes;
  const reply = input.language === "en"
    ? "Noted for " + name + ": " + entries.join(", ") +
      (previousScopes ? ". Existing other scopes remain." : ". Total " + total + " " + unit + ".") +
      " This is not a confirmed order."
    : input.language === "zh-CN"
      ? "已记录「" + name + "」的分配：" + entries.join("、") +
        (previousScopes ? "；其他已记录范围保留。" : "；合共 " + total + unit + "。") + "尚未下单。"
      : "已記低「" + name + "」嘅分配：" + entries.join("、") +
        (previousScopes ? "；其餘已記錄範圍保留。" : "；合共 " + total + unit + "。") + "未落單。";
  return {
    topic: target.category, topic_source: "semantic", entity_id: target.entity_id,
    action: "scoped_update", values,
    aggregate_quantity: previousScopes ? undefined : total,
    context_sufficient: true, reply, clarification: question,
  };
}

export type ContextualDecision =
  | { route: "none"; reason: string; updates: [] }
  | { route: "targeted_clarification"; reason: string; reply: string; updates: [] }
  | { route: "product_guidance"; reason: string; reply: string; topic: string; updates: [] }
  | {
    route: "contextual_scoped_update";
    reason: string;
    reply: string;
    topic: string;
    entity_id: string;
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
    return { route: "product_guidance", reason: "CONTEXTUAL_ENQUIRY", topic: candidate.topic, reply: candidate.reply, updates: [] };
  }
  if (input.read_only) return { route: "none", reason: "READ_ONLY_TURN", updates: [] };
  const active = input.state.entities.filter((entity) =>
    entity.status !== "cancelled" && entity.status !== "deferred"
  );
  const compatible = active.filter((entity) => entity.category === candidate.topic &&
    (!candidate.entity_id || candidate.entity_id === entity.entity_id));
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
): CommerceStateEvent[] {
  if (decision.route !== "contextual_scoped_update") return [];
  const target = state.entities.find((entity) => entity.entity_id === decision.entity_id);
  if (!target) return [];
  const provenance = { source_type: "customer" as const, source_message_id, recorded_at: occurred_at ?? null };
  const current = target.attributes.scoped_customer_updates;
  const records: ScopedCustomerValue[] = Array.isArray(current)
    ? current.filter((value): value is ScopedCustomerValue =>
      Boolean(value && typeof value === "object" && typeof value.scope === "string" && typeof value.attribute === "string"))
    : [];
  const merged = new Map(records.map((value) => [value.scope + ":" + value.attribute, value]));
  for (const value of decision.updates) merged.set(value.scope + ":" + value.attribute,
    value.source_text ? { ...value, source_message_id } : value);
  const updates = [...merged.values()];
  const events: CommerceStateEvent[] = [{
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
    if (Number.isInteger(decision.aggregate_quantity) && decision.aggregate_quantity >= 0 && total === decision.aggregate_quantity && total !== target.quantity) events.push({
      type: "SET_ENTITY_QUANTITY", entity_id: target.entity_id, quantity: total, provenance,
    });
  }
  return events;
}
