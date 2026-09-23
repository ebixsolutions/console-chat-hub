/**
 * TASK A3 — Commerce state runtime adapter.
 *
 * This module owns capability-driven commerce extraction plus optional industry
 * profiles. A1 (contract) and A2 (reducer + authority) stay frozen and universal.
 *
 * Responsibilities:
 *  - load persistent commerce state for (conversation_id, company_id)
 *  - derive events for the current customer turn (A2 universal derivation plus
 *    A3 runtime hints), reduce them, and persist through
 *    public.upsert_conversation_commerce_state_v1 with source_message_id and
 *    expected revision (one retry on revision_conflict, never a blind overwrite)
 *  - resolve the answer authority (A2) and build the customer-facing answer for
 *    CONVERSATION_STATE / DETERMINISTIC_CALCULATION / SAFE_PROFESSIONAL_CONFIRMATION
 *    and transaction-summary intents, while letting CURRENT_KB_REQUIRED fall
 *    through to the existing authoritative KB retrieval path.
 */

import {
  type ConversationCommerceState,
  createEmptyConversationCommerceState,
  isConversationCommerceState,
} from "./commerce-state-contract.ts";
import {
  type CommerceStateEvent,
  type CommerceTurnEntityHint,
  deriveCommerceEventsFromCustomerTurn,
  extractDeliveryPreference,
  parseAddressReplacementCorrection,
  reduceCommerceState,
} from "./commerce-state-reducer.ts";
import {
  type CommerceAnswerAuthority,
  type CommerceCalculationTerm,
  type CommerceDimensionAttribute,
  inferCommerceDimensionAttribute,
  isReadOnlyCurrentStateAggregateQuery,
  isReadOnlyMemoryOrCurrentStateRecall,
  parseCommerceDimensionMeasurement,
  resolveCommerceAnswerAuthority,
} from "./commerce-state-authority.ts";
import {
  buildCapabilityAwarePreorderNextStep,
  buildGenericCommerceEntityHints,
  genericEntityLabelFromId,
} from "./commerce-capability-runtime.ts";
import type { CommerceSemanticFrame } from "./commerce-semantic-frame.ts";
import {
  mergeCommerceEntityHints,
  semanticFrameToEntityHints,
  semanticFrameToStateEvents,
} from "./commerce-semantic-adapter.ts";
import { industryEntityLabel, resolveIndustryContextualCandidate, resolveIndustryRuntime } from "./industry-runtime-adapter.ts";
import { contextualUpdateEvents, resolveContextualCustomerUpdate } from "./contextual-customer-update.ts";
import type { ContextualDecision } from "./contextual-customer-update.ts";
import {
  HOME_APPLIANCE_CATEGORIES as CATEGORY_SPECS,
  HOME_APPLIANCE_ROOMS as ROOM_SPECS,
} from "./industry-profiles/home-appliance-v1.ts";

export type CommerceLanguage = "zh-TW" | "zh-CN" | "en";

export interface CommerceStateQueryResult {
  data: unknown;
  error: unknown;
}

export interface CommerceStateDbClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<CommerceStateQueryResult>;
      };
    };
  };
  rpc(fn: string, params: Record<string, unknown>): Promise<CommerceStateQueryResult>;
}

export interface CommerceHistoryTurn {
  role: string;
  content: string;
}

export interface CommerceRuntimeInput {
  conversation_id: string;
  company_id: string;
  source_message_id: string;
  text: string;
  language: CommerceLanguage;
  history?: CommerceHistoryTurn[];
  occurred_at?: string | null;
  semantic_frame?: CommerceSemanticFrame | null;
  industry_identifier?: string | null;
}

export interface CommerceRuntimeOutcome {
  authority: CommerceAnswerAuthority;
  reply: string | null;
  revision: number;
  persist_result: string;
  reason: string;
  state_path?: string | null;
  calculation?: { expression: string; result: number; currency?: string | null } | null;
  route: "commerce_state_answer" | "commerce_transaction_summary" | "commerce_kb_required" | "product_guidance" | "contextual_scoped_update";
  contextual_decision?: ContextualDecision;
}

export interface CommittedAddressCorrectionResolution {
  status: "RESOLVED";
  operation: "FULL_REPLACE" | "SCOPED_COMPONENT_UPDATE";
  address: string;
  source_message_id: string;
  reply: string;
  reason: "authoritative_address_correction_resolved";
}

export interface CommittedAddressCorrectionEvidence {
  text: string;
  source_message_id: string;
  language: CommerceLanguage;
  memory: {
    source_message_id: string;
    commerce_state_revision: number | null;
    current_customer_facts: Array<{
      key: string;
      value: unknown;
      authority: string;
      source_message_id?: string | null;
    }>;
    cancelled_or_superseded: Array<{
      key: string;
      value: unknown;
      source_message_id?: string | null;
    }>;
    latest_corrections: string[];
    open_questions: string[];
  } | null;
  commerce: {
    source_message_id: string;
    revision: number;
    state: ConversationCommerceState;
  } | null;
}

const COMMERCE_STATE_RPC = "upsert_conversation_commerce_state_v1" as const;
const MAX_HISTORY_TURNS = 24;

function clean(value: unknown, max = 1600): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * A3 runtime extraction (generic capability layer + optional industry profiles)
 * ------------------------------------------------------------------ */

function matchedAliases(lower: string, aliases: readonly string[]): string[] {
  return aliases.filter((alias) => alias.trim().length >= 2 && lower.includes(alias.trim().toLowerCase()));
}

function detectCategories(text: string) {
  const lower = clean(text).toLowerCase();
  return CATEGORY_SPECS.filter((spec) => matchedAliases(lower, spec.aliases).length > 0);
}

type AttributeConstraintQueryResolution = {
  authority: CommerceAnswerAuthority;
  reason:
    | "read_only_attribute_constraint_query_resolved"
    | "read_only_attribute_constraint_query_unresolved";
  reply: string;
  state_path: string | null;
};

type PendingCheckAggregateResolution = {
  authority: CommerceAnswerAuthority;
  reason: "read_only_current_state_aggregate_query_resolved" | "read_only_current_state_aggregate_query_unresolved";
  reply: string;
  state_path: string | null;
};

type PendingCheckAggregateScope =
  | { mode: "global" }
  | { mode: "entity"; entity_id: string | null };

function pendingCheckLabel(check: string, language: CommerceLanguage): string {
  const labels: Record<string, Record<CommerceLanguage, string>> = {
    installation_site_check: { "zh-TW": "安裝現場檢查", "zh-CN": "安装现场检查", en: "installation site check" },
    window_opening_check: { "zh-TW": "窗口尺寸檢查", "zh-CN": "窗口尺寸检查", en: "window-opening check" },
    wall_structure_check: { "zh-TW": "牆身承托檢查", "zh-CN": "墙体承托检查", en: "wall-structure check" },
    electrical_supply_check: { "zh-TW": "電力供應檢查", "zh-CN": "电力供应检查", en: "electrical-supply check" },
    drainage_check: { "zh-TW": "排水檢查", "zh-CN": "排水检查", en: "drainage check" },
  };
  return labels[check]?.[language] ?? clean(check, 120).replaceAll("_", " ");
}

function resolvePendingCheckAggregateScope(
  input: CommerceRuntimeInput,
  state: ConversationCommerceState,
): PendingCheckAggregateScope {
  const text = clean(input.text);
  const lower = text.toLowerCase();
  const categories = detectCategories(text).map((category) => category.key);
  const rooms = detectRooms(text).map((room) => room.key);
  const semanticRefs = input.semantic_frame?.entities.flatMap((entity) => [
    clean(entity.entity_ref, 160),
    clean(entity.name, 160),
    clean(entity.category_hint, 160),
  ]).filter((value) => {
    const normalized = value.toLowerCase();
    return normalized.length >= 2 &&
      !["product", "item", "installation", "產品", "产品", "安裝", "安装"].includes(normalized) &&
      lower.includes(normalized);
  }) ?? [];
  const explicitDeictic = /(?:呢|這|这|嗰|那)(?:一|兩|两|二|\d+)?(?:部|件|個|个|樣|样|位)|\bthis\s+(?:one|item|unit|product|installation|refrigerator|fridge|air\s*conditioner)\b|\bfor\s+(?:this|the)\b/i.test(text);
  const explicitScope = categories.length > 0 || rooms.length > 0 ||
    semanticRefs.length > 0 || explicitDeictic;
  if (!explicitScope) return { mode: "global" };

  const active = state.entities.filter((entity) =>
    entity.status !== "cancelled" && entity.status !== "deferred"
  );
  let candidates = active.filter((entity) => {
    if (categories.length && !categories.includes(entity.category)) return false;
    if (rooms.length) {
      const room = entity.entity_id.split(":")[1] ?? "";
      if (!rooms.includes(room)) return false;
    }
    if (semanticRefs.length) {
      const values = [entity.entity_id, entity.category].map((value) => clean(value, 160).toLowerCase());
      if (!semanticRefs.some((ref) => {
        const normalized = ref.toLowerCase();
        return values.some((value) => value === normalized || value.includes(normalized) || normalized.includes(value));
      }) && !categories.length && !rooms.length) return false;
    }
    return true;
  });
  if (!categories.length && !rooms.length && !semanticRefs.length && explicitDeictic) {
    candidates = active;
  }
  return { mode: "entity", entity_id: candidates.length === 1 ? candidates[0].entity_id : null };
}

function hasPendingCheckDomainAmbiguity(input: CommerceRuntimeInput): boolean {
  if (input.semantic_frame?.ambiguity.is_ambiguous !== true) return false;
  return input.semantic_frame.ambiguity.reasons.some((reason) =>
    /(?:incompatible|different|multiple)\s+(?:meaning|interpretation|domain)|(?:師傅|师傅|technician|professional).*(?:意思|含義|含义|meaning|ambiguous)/i.test(
      clean(reason, 240),
    )
  );
}

function pendingCheckUnknownReply(
  language: CommerceLanguage,
  mode: PendingCheckAggregateScope["mode"],
): string {
  if (mode === "global") {
    if (language === "en") return "I can't confirm the current pending technician-check total because no authoritative pending-check state is available yet.";
    if (language === "zh-CN") return "目前没有可核实的待师傅确认状态，所以暂时无法确认总数。";
    return "而家未有可核實嘅待師傅確認狀態，所以暫時未能確認總數。";
  }
  if (language === "en") return "Which product or installation do you mean? I can check its pending technician items without changing them.";
  if (language === "zh-CN") return "你是指哪件产品或哪项安装？我可以只查看对应的待师傅确认项目，不会更改它们。";
  return "你係指邊件產品或邊項安裝？我可以只查看對應嘅待師傅確認項目，唔會更改佢哋。";
}

function resolvePendingCheckAggregateQuery(
  input: CommerceRuntimeInput,
  state: ConversationCommerceState,
  revision: number,
): PendingCheckAggregateResolution | null {
  if (
    !isReadOnlyCurrentStateAggregateQuery(input.text, input.semantic_frame) &&
    !/(?:有咩|有什么|what).{0,18}(?:仲未|還沒|还没|未|not yet|outstanding|pending).{0,12}(?:confirm|確認|确认)|(?:仲未|還沒|还没|not yet).{0,12}(?:confirm|確認|确认).{0,12}(?:有咩|有什么|what)/i.test(input.text)
  ) return null;
  const scope = resolvePendingCheckAggregateScope(input, state);
  if (
    revision === 0 ||
    (scope.mode === "global" && hasPendingCheckDomainAmbiguity(input)) ||
    (scope.mode === "entity" &&
      (scope.entity_id === null || hasPendingCheckDomainAmbiguity(input)))
  ) {
    const reply = pendingCheckUnknownReply(input.language, scope.mode);
    return { authority: "INSUFFICIENT_INFORMATION", reason: "read_only_current_state_aggregate_query_unresolved", reply, state_path: null };
  }
  const scopedItems = state.installation.items.filter((item) =>
    item.status === "pending" &&
    (scope.mode === "global" || item.entity_id === scope.entity_id)
  );
  if (
    scope.mode === "entity" &&
    state.installation.pending_checks.length > 0 &&
    !state.installation.items.some((item) => Boolean(item.entity_id))
  ) {
    return {
      authority: "INSUFFICIENT_INFORMATION",
      reason: "read_only_current_state_aggregate_query_unresolved",
      reply: pendingCheckUnknownReply(input.language, scope.mode),
      state_path: null,
    };
  }
  const pending = [...new Set([
    ...(scope.mode === "global" ? state.installation.pending_checks : []),
    ...scopedItems.map((item) => item.kind),
  ].map((item) => clean(item, 160)).filter(Boolean))];
  const labels = pending.map((item) => pendingCheckLabel(item, input.language));
  const asksForList = /(?:邊啲|边啲|哪些|which\s+(?:checks?|items?)|what\s+(?:still\s+)?(?:needs?|requires?))/i.test(input.text);
  let reply: string;
  if (input.language === "en") {
    reply = pending.length === 0
      ? "There are currently no pending technician-confirmation items."
      : asksForList
      ? `The pending technician-confirmation item${pending.length === 1 ? " is" : "s are"}: ${labels.join(", ")}.`
      : `There ${pending.length === 1 ? "is" : "are"} currently ${pending.length} pending technician-confirmation item${pending.length === 1 ? "" : "s"}: ${labels.join(", ")}.`;
  } else if (input.language === "zh-CN") {
    reply = pending.length === 0 ? "目前没有待师傅确认的项目。" : asksForList ? `待师傅确认的是：${labels.join("、")}。` : `目前有 ${pending.length} 项待师傅确认：${labels.join("、")}。`;
  } else {
    reply = pending.length === 0 ? "而家冇待師傅確認嘅項目。" : asksForList ? `待師傅確認嘅係：${labels.join("、")}。` : `而家有 ${pending.length} 項要師傅確認：${labels.join("、")}。`;
  }
  return {
    authority: "CONVERSATION_STATE",
    reason: "read_only_current_state_aggregate_query_resolved",
    reply,
    state_path: scope.mode === "global"
      ? "installation.pending_checks"
      : `installation.items[entity_id=${scope.entity_id}]`,
  };
}

function semanticCategoryKeys(frame: CommerceSemanticFrame | null | undefined): string[] {
  if (!frame) return [];
  const values = [
    frame.topic,
    ...frame.entities.flatMap((entity) => [
      entity.category_hint ?? "",
      entity.entity_ref ?? "",
      entity.name ?? "",
    ]),
    ...frame.referents.map((referent) => referent.ref),
  ];
  const keys = new Set<string>();
  for (const value of values) {
    const normalized = clean(value, 160).toLowerCase();
    if (!normalized) continue;
    const exact = CATEGORY_SPECS.find((spec) => spec.key === normalized);
    if (exact) keys.add(exact.key);
    for (const category of detectCategories(normalized)) keys.add(category.key);
  }
  return [...keys];
}

function explicitCategoryKeys(text: string): string[] {
  return [...new Set(detectCategories(text).map((category) => category.key))];
}

function resolveAttributeQueryCategory(input: CommerceRuntimeInput): {
  category: string | null;
  ambiguous: boolean;
} {
  // Current-turn semantics outrank stale topic inheritance.  A unique explicit
  // category in the utterance is the strongest binding, followed by the
  // schema-constrained semantic frame, then the nearest prior customer topic.
  const current = explicitCategoryKeys(input.text);
  if (current.length > 1) return { category: null, ambiguous: true };
  if (current.length === 1) return { category: current[0], ambiguous: false };

  const semantic = semanticCategoryKeys(input.semantic_frame);
  if (semantic.length > 1) return { category: null, ambiguous: true };
  if (semantic.length === 1) return { category: semantic[0], ambiguous: false };

  for (const turn of input.history ?? []) {
    if (!["visitor", "user", "customer"].includes(turn.role)) continue;
    const recent = explicitCategoryKeys(turn.content);
    if (recent.length > 1) return { category: null, ambiguous: true };
    if (recent.length === 1) return { category: recent[0], ambiguous: false };
  }
  return { category: null, ambiguous: false };
}

function dimensionConstraintKey(attribute: CommerceDimensionAttribute): string[] {
  return [`max_${attribute}_mm`, `${attribute}_max_mm`, `${attribute}_mm`, attribute];
}

function numericConstraint(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string") return null;
  return (
    parseCommerceDimensionMeasurement(value)?.value_mm ??
    (/^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null)
  );
}

function stateDimensionConstraint(
  state: ConversationCommerceState,
  category: string,
  attribute: CommerceDimensionAttribute,
): { value_mm: number; path: string } | null {
  const active = state.entities.filter(
    (entity) =>
      entity.category === category && entity.status !== "cancelled" && entity.status !== "deferred",
  );
  if (active.length === 1) {
    const entityIndex = state.entities.indexOf(active[0]);
    for (const key of dimensionConstraintKey(attribute)) {
      const value = numericConstraint(active[0].constraints[key]);
      if (value !== null) {
        return { value_mm: value, path: `entities.${entityIndex}.constraints.${key}` };
      }
    }
  }

  const categoryConstraints = state.customer_constraints[category];
  if (isRecord(categoryConstraints)) {
    for (const key of dimensionConstraintKey(attribute)) {
      const value = numericConstraint(categoryConstraints[key]);
      if (value !== null) {
        return { value_mm: value, path: `customer_constraints.${category}.${key}` };
      }
    }
  }
  return null;
}

function maximumConstraintLanguage(text: string): boolean {
  return /(?:樓下|楼下|以下|上限|最多|唔好超過|不要超過|不超過|不超过|不能超過|不能超过|至多|≤|<=|at most|no more than|maximum|max\.?|under)/i.test(
    text,
  );
}

function parseProductDimension(text: string): {
  attribute: CommerceDimensionAttribute | null;
  value: number;
  unit: "mm";
  value_mm: number;
} | ReturnType<typeof parseCommerceDimensionMeasurement> {
  const explicit = parseCommerceDimensionMeasurement(text);
  if (explicit) return explicit;
  const compact = clean(text).match(/(\d{2,4}(?:\.\d+)?)\s*(闊|宽|高|深)(?:度)?/i);
  if (!compact) return null;
  const value = Number(compact[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const attribute: CommerceDimensionAttribute = /闊|宽/i.test(compact[2])
    ? "width"
    : /高/i.test(compact[2]) ? "height" : "depth";
  return { attribute, value, unit: "mm", value_mm: value };
}

function contextualConstraintAttribute(
  history: CommerceHistoryTurn[],
  index: number,
  category: string,
): CommerceDimensionAttribute | null {
  const direct = inferCommerceDimensionAttribute(history[index]?.content ?? "");
  if (direct) return direct;
  // A terse correction such as "595mm以下先啱" inherits only from the
  // nearest older compatible dimension statement.  A conflicting explicit
  // category closes the window instead of allowing cross-entity carryover.
  for (let offset = index + 1; offset < Math.min(history.length, index + 6); offset += 1) {
    const turn = history[offset];
    if (!["visitor", "user", "customer"].includes(turn.role)) continue;
    const categories = explicitCategoryKeys(turn.content);
    if (categories.length && !categories.includes(category)) break;
    const inherited = inferCommerceDimensionAttribute(turn.content);
    if (inherited) return inherited;
  }
  return null;
}

function historyDimensionConstraint(
  input: CommerceRuntimeInput,
  category: string,
  attribute: CommerceDimensionAttribute,
): { value_mm: number; path: string } | null {
  const history = (input.history ?? [])
    .filter((turn) => ["visitor", "user", "customer"].includes(turn.role))
    .slice(0, MAX_HISTORY_TURNS);
  for (let index = 0; index < history.length; index += 1) {
    const turn = history[index];
    const categories = explicitCategoryKeys(turn.content);
    if (categories.length && !categories.includes(category)) continue;
    const measurement = parseCommerceDimensionMeasurement(turn.content);
    if (!measurement || !maximumConstraintLanguage(turn.content)) continue;
    const candidateAttribute =
      measurement.attribute ?? contextualConstraintAttribute(history, index, category);
    if (candidateAttribute !== attribute) continue;
    return {
      value_mm: measurement.value_mm,
      path: `customer_constraints.${category}.${attribute}`,
    };
  }
  return null;
}

function categoryLabel(category: string, language: CommerceLanguage): string {
  const spec = CATEGORY_SPECS.find((candidate) => candidate.key === category);
  return spec?.label[language] ?? category;
}

function dimensionLabel(attribute: CommerceDimensionAttribute, language: CommerceLanguage): string {
  const labels = {
    width: { "zh-TW": "闊度", "zh-CN": "宽度", en: "width" },
    height: { "zh-TW": "高度", "zh-CN": "高度", en: "height" },
    depth: { "zh-TW": "深度", "zh-CN": "深度", en: "depth" },
  } as const;
  return labels[attribute][language];
}

function formatMillimetres(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

function resolveReadOnlyAttributeConstraintQuery(
  input: CommerceRuntimeInput,
  state: ConversationCommerceState,
): AttributeConstraintQueryResolution | null {
  if (!isReadOnlyCommerceQuestion(input.text, input.semantic_frame)) return null;
  const measurement = parseCommerceDimensionMeasurement(input.text);
  if (!measurement) return null;

  const categoryResolution = resolveAttributeQueryCategory(input);
  const attribute =
    inferCommerceDimensionAttribute(input.text, input.semantic_frame) ??
    (() => {
      const history = (input.history ?? []).filter((turn) =>
        ["visitor", "user", "customer"].includes(turn.role),
      );
      for (let index = 0; index < history.length; index += 1) {
        const candidate = contextualConstraintAttribute(
          history,
          index,
          categoryResolution.category ?? "",
        );
        if (candidate) return candidate;
      }
      return null;
    })();

  if (categoryResolution.ambiguous || !categoryResolution.category) {
    const value = `${measurement.value}${measurement.unit}`;
    const reply =
      input.language === "en"
        ? `Which product is the ${value} measurement for? I will compare it only with that product's current dimension constraint.`
        : input.language === "zh-CN"
          ? `这个 ${value} 尺寸是指哪类产品？我只会用该产品目前的尺寸限制来比较。`
          : `呢個 ${value} 尺寸係指邊類產品？我只會用該產品目前嘅尺寸限制去比較。`;
    return {
      authority: "INSUFFICIENT_INFORMATION",
      reason: "read_only_attribute_constraint_query_unresolved",
      reply,
      state_path: null,
    };
  }

  const category = categoryResolution.category;
  if (!attribute) {
    const product = categoryLabel(category, input.language);
    const reply =
      input.language === "en"
        ? `For the ${product}, does ${measurement.value}${measurement.unit} refer to its width, height or depth?`
        : input.language === "zh-CN"
          ? `你说的${product} ${measurement.value}${measurement.unit} 是指宽度、高度还是深度？`
          : `你講嘅${product} ${measurement.value}${measurement.unit} 係指闊度、高度定深度？`;
    return {
      authority: "INSUFFICIENT_INFORMATION",
      reason: "read_only_attribute_constraint_query_unresolved",
      reply,
      state_path: null,
    };
  }

  const constraint =
    stateDimensionConstraint(state, category, attribute) ??
    historyDimensionConstraint(input, category, attribute);
  if (!constraint) {
    const product = categoryLabel(category, input.language);
    const dimension = dimensionLabel(attribute, input.language);
    const reply =
      input.language === "en"
        ? `What is your current ${product} ${dimension} limit? I cannot safely compare ${measurement.value}${measurement.unit} with another product's state.`
        : input.language === "zh-CN"
          ? `你目前的${product}${dimension}上限是多少？我不能用其他产品的状态来判断 ${measurement.value}${measurement.unit}。`
          : `你目前嘅${product}${dimension}上限係幾多？我唔可以用其他產品嘅狀態去判斷 ${measurement.value}${measurement.unit}。`;
    return {
      authority: "INSUFFICIENT_INFORMATION",
      reason: "read_only_attribute_constraint_query_unresolved",
      reply,
      state_path: null,
    };
  }

  const candidateMm = measurement.value_mm;
  const limitMm = constraint.value_mm;
  const candidate = formatMillimetres(candidateMm);
  const limit = formatMillimetres(limitMm);
  const exceeds = candidateMm > limitMm;
  const reply =
    input.language === "en"
      ? exceeds
        ? `${candidate} mm exceeds your current ${limit} mm ${dimensionLabel(attribute, "en")} limit, so it is not recommended under the current requirement.`
        : `${candidate} mm is within your current ${limit} mm ${dimensionLabel(attribute, "en")} limit, so it can be considered on that dimension.`
      : input.language === "zh-CN"
        ? exceeds
          ? `${candidate}mm 超过你目前设定的 ${limit}mm ${dimensionLabel(attribute, "zh-CN")}上限，所以按现有条件不建议考虑。`
          : `${candidate}mm 没有超过你目前设定的 ${limit}mm ${dimensionLabel(attribute, "zh-CN")}上限，所以按这个尺寸条件可以考虑。`
        : exceeds
          ? `${candidate}mm 超過你目前設定嘅 ${limit}mm ${dimensionLabel(attribute, "zh-TW")}上限，所以按現有條件唔建議考慮。`
          : `${candidate}mm 冇超過你目前設定嘅 ${limit}mm ${dimensionLabel(attribute, "zh-TW")}上限，所以按呢個尺寸條件可以考慮。`;
  return {
    authority: "CONVERSATION_STATE",
    reason: "read_only_attribute_constraint_query_resolved",
    reply,
    state_path: constraint.path,
  };
}

function compatibleQuantityStatePath(
  input: CommerceRuntimeInput,
  state: ConversationCommerceState,
): string | null {
  const requested = (input.semantic_frame?.requested_facts ?? []).join(" ");
  const text = clean(input.text);
  const deliveryFields: Array<[RegExp, keyof ConversationCommerceState["delivery"]]> = [
    [/(?:地址|address|邊座|哪座)/i, "address"],
    [/(?:收貨人|收货人|recipient)/i, "recipient_name"],
    [/(?:電話|电话|phone|contact)/i, "recipient_phone"],
    [/(?:送(?:貨|货)?.{0,8}(?:星期|邊日|边日|日期|幾時|几时)|delivery\s*(?:day|date)|preferred_date)/i, "preferred_date"],
  ];
  for (const [pattern, field] of deliveryFields) {
    if ((pattern.test(text) || new RegExp(String(field), "i").test(requested)) && state.delivery[field] != null) return `delivery.${field}`;
  }
  if (/(?:舊機|旧机|舊冷氣|旧空调).{0,12}(?:拆|移除)|(?:拆|移除).{0,12}(?:舊機|旧机)/i.test(text)) {
    const count = state.installation.site_conditions["old_machine_removal_count"];
    if (typeof count === "number" && Number.isFinite(count)) return "installation.site_conditions.old_machine_removal_count";
  }
  if (/(?:匹數|匹数|幾匹|几匹|horsepower|\bhp\b)/i.test(text + " " + requested)) {
    const resolved = resolveAttributeQueryCategory(input);
    if (!resolved.ambiguous && resolved.category) {
      const compatible = state.entities.filter((entity) => entity.category === resolved.category && entity.status !== "cancelled" && entity.status !== "deferred");
      const facts = compatible.map((entity) => ({ index: state.entities.indexOf(entity), value: entity.attributes["horsepower"] })).filter((item) => item.value != null);
      if (facts.length === 1) return `entities.${facts[0].index}.attributes.horsepower`;
    }
    return null;
  }
  if (
    /(?:狀態|状态|status|已取消|取消咗|取消了|仲要|仍然要|still active|cancelled|canceled)/i.test(
      input.text,
    ) ||
    /(?:status|current_state)/i.test(requested)
  )
    return null;
  const asksQuantity =
    /(?:quantity|current_quantity)/i.test(requested) ||
    /(?:數量|数量|quantity|how many|幾多|几多|多少)/i.test(input.text) ||
    /(?:記唔記得|记不记得|記得嗎|记得吗|仲記得|还记得|還記得|頭先|头先|do you remember|remind me).{0,30}(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套)/i.test(
      input.text,
    ) ||
    /(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套).{0,20}(?:定|還是|还是|or).{0,20}(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套)/i.test(
      input.text,
    );
  if (!asksQuantity) return null;
  const resolved = resolveAttributeQueryCategory(input);
  if (resolved.ambiguous || !resolved.category) return null;
  const compatible = state.entities.filter(
    (entity) =>
      entity.category === resolved.category &&
      entity.status !== "cancelled" &&
      entity.status !== "deferred",
  );
  if (compatible.length !== 1) return null;
  return `entities.${state.entities.indexOf(compatible[0])}.quantity`;
}


function detectRooms(text: string) {
  const lower = clean(text).toLowerCase();
  return ROOM_SPECS.filter((spec) => matchedAliases(lower, spec.aliases).length > 0);
}

function detectReferencedRooms(text: string) {
  const rooms = new Map(detectRooms(text).map((room) => [room.key, room]));
  // Cantonese commonly shortens 客廳 to 個廳/我個廳 in a follow-up.  Treat
  // that as a referent only; buildCommerceEntityHints continues to require a
  // full room alias, so a first-turn aggregate such as "兩間房加個廳" is not
  // collapsed into one scoped entity.
  if (/(?:我(?:個|个)?|呢(?:個|个)|這(?:個|个)|这(?:个|個)|嗰(?:個|个)|果(?:個|个))?\s*(?:個|个)?(?:廳|厅)(?!房)/i.test(clean(text))) {
    const livingRoom = ROOM_SPECS.find((room) => room.key === "living_room");
    if (livingRoom) rooms.set(livingRoom.key, livingRoom);
  }
  return [...rooms.values()];
}

function entityLabel(entityId: string, language: CommerceLanguage): string {
  const generic = genericEntityLabelFromId(entityId);
  if (generic) return generic;
  const industry = industryEntityLabel(entityId, language);
  if (industry) return industry;
  const [categoryKey, roomKey] = entityId.split(":");
  const category = CATEGORY_SPECS.find((x) => x.key === categoryKey);
  const room = ROOM_SPECS.find((x) => x.key === roomKey);
  const categoryText = category ? category.label[language] : clean(categoryKey, 60);
  if (!room) return categoryText;
  return language === "en"
    ? `${room.label.en} ${categoryText}`
    : `${room.label[language]}${categoryText}`;
}

/** Build entity hints from the whole conversation so state survives topic drift. */
export function buildCommerceEntityHints(texts: string[]): CommerceTurnEntityHint[] {
  const hints = new Map<string, CommerceTurnEntityHint>();
  for (const raw of texts) {
    const text = clean(raw);
    if (!text) continue;
    const categories = detectCategories(text);
    if (categories.length) {
      const rooms = detectRooms(text);
      for (const category of categories) {
        const scopes = rooms.length ? rooms : [null];
        for (const room of scopes) {
          const entityId = room ? `${category.key}:${room.key}` : `${category.key}:unscoped`;
          if (hints.has(entityId)) continue;
          hints.set(entityId, {
            entity_id: entityId,
            category: category.key,
            aliases: [...category.aliases, ...(room ? room.aliases : [])],
          });
        }
      }
      continue;
    }
    for (const hint of buildGenericCommerceEntityHints([text])) {
      const existing = hints.get(hint.entity_id);
      if (!existing) hints.set(hint.entity_id, hint);
      else hints.set(hint.entity_id, {
        ...existing,
        aliases: [...new Set([...(existing.aliases ?? []), ...(hint.aliases ?? [])])],
        attributes: { ...(existing.attributes ?? {}), ...(hint.attributes ?? {}) },
      });
    }
  }
  return [...hints.values()];
}

function hintsMentionedInTurn(text: string, hints: CommerceTurnEntityHint[]): CommerceTurnEntityHint[] {
  const lower = clean(text).toLowerCase();
  const categories = detectCategories(text).map((x) => x.key);
  const rooms = categories.length > 0
    ? detectRooms(text)
    : detectReferencedRooms(text);
  return hints.filter((hint) => {
    if (hint.entity_id.startsWith("generic:")) {
      return (hint.aliases ?? []).some((alias) => {
        const normalized = clean(alias, 80).toLowerCase();
        return normalized.length >= 2 && lower.includes(normalized);
      });
    }
    const [, roomKey] = hint.entity_id.split(":");
    if (!categories.includes(hint.category)) {
      // A scoped follow-up can refer to an already-known commerce entity by
      // room alone (for example, cancelling "the living-room one").
      return rooms.length > 0 && roomKey !== "unscoped" &&
        rooms.some((room) => room.key === roomKey);
    }
    if (!rooms.length) return true;
    if (roomKey === "unscoped") return false;
    return rooms.some((room) => room.key === roomKey) || Boolean(lower) === false;
  });
}

function hintRequiresBookingWithoutDelivery(hint: CommerceTurnEntityHint): boolean {
  const attributes = hint.attributes;
  if (!isRecord(attributes)) return false;
  const capabilities = attributes["capabilities"];
  if (!isRecord(capabilities)) return false;
  return capabilities["requires_booking"] === true
    && capabilities["requires_delivery"] !== true
    && capabilities["requires_installation"] !== true;
}

const COUNT_TOKEN = "[一二兩两三四五六七八九十]|\\d{1,4}";
const COUNT_UNIT = "部|台|件|個|个|套|張|张|盒|箱|包|袋|樽|瓶|支|枝|本|冊|册|對|对|雙|双|條|条|份|位|席|間|间|晚|次|堂|課|课|units?|pcs?|pieces?|items?|boxes?|bottles?|packs?|bags?|pairs?|sets?|seats?|nights?|sessions?|lessons?";

function countTokenValue(raw: string): number | null {
  const map: Record<string, number> = {
    一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  if (/^\d+$/.test(raw)) return Number(raw);
  return map[raw] ?? null;
}

export function detectQuantityCorrectionSignal(text: string): boolean {
  const t = clean(text);
  return /(?:更正|改(?:做|成|為|为|返)?|變成|变成|唔係.+?(?:而係|係|系)|不是.+?(?:而是|是)|不係.+?(?:而係|係)|actually|change(?:\s+it)?\s+to|make\s+it)/i.test(t);
}

function parseCount(text: string): number | null {
  const t = clean(text);
  if (!t) return null;

  const correctionPatterns = [
    new RegExp(`(?:唔係|唔系|不是|不係)\\s*(?:${COUNT_TOKEN})\\s*(?:${COUNT_UNIT})?.{0,24}?(?:而係|而系|而是|係|系|是)\\s*(${COUNT_TOKEN})\\s*(?:${COUNT_UNIT})`, "i"),
    new RegExp(`(?:更正|改(?:做|成|為|为|返)?|變成|变成|change(?:\\s+it)?\\s+to|make\\s+it|actually)\\s*[:：,，]?\\s*(${COUNT_TOKEN})\\s*(?:${COUNT_UNIT})`, "i"),
  ];
  for (const pattern of correctionPatterns) {
    const correction = t.match(pattern);
    if (correction?.[1]) return countTokenValue(correction[1]);
  }

  const m = t.match(
    /(?:改(?:做|成|返)?|變成|变成|change to|要|need|order)?\s*([一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|張|张|盒|箱|包|袋|樽|瓶|支|枝|本|冊|册|對|对|雙|双|條|条|份|位|席|間|间|晚|次|堂|課|课|units?|pcs?|pieces?|items?|boxes?|bottles?|packs?|bags?|pairs?|sets?|seats?|nights?|sessions?|lessons?)/i,
  );
  if (!m?.[1]) return null;
  return countTokenValue(m[1]);
}

function looksInterrogative(text: string): boolean {
  const t = clean(text);
  return /[?？]/.test(t) ||
    /(?:係咪|系咪|是否|有冇|有沒有|有没有|幾多|几多|多少|邊個|边个|哪個|哪个|咩|什麼|什么|定係|定系|仲係|仲系|還是|还是|how many|what(?:'s| is)|which|is it|do i|did i|have i|current|status)/i.test(t);
}

function hasExplicitSupportedMutation(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  if (parseAddressReplacementCorrection(t)) return true;
  const strongMutation = /(?:更正|改(?:做|成|為|为|返)|變成|变成|再加|加多|新增|另外加|取消|移除|刪除|删除|change\s+(?:it\s+)?to|set\s+(?:it\s+)?to|add\s+(?:another|one|two|three|\d)|cancel|remove)/i.test(t);
  if (strongMutation) return true;
  // Deliberative questions such as "要唔要考慮？" ask for advice; the
  // embedded 要/不要 alternation is not a BUY/CANCEL instruction.
  if (
    looksInterrogative(t) &&
    /(?:要唔要|要不要|應唔應該|应不应该|需唔需要|需不需要|值唔值得|值不值得|should\s+i|do\s+i\s+need\s+to|worth\s+considering)/i.test(t)
  ) return false;
  if (
    /(?:更正|改(?:做|成|為|为|返)|變成|变成|再加|加多|新增|另外加|我要|我想(?:買|买|訂|订)|想(?:買|买|訂|订)|要(?:買|买|訂|订)|落單|下單|下单)/i.test(t) ||
    /(?:幫我|帮我|請|请).{0,24}(?:改|加|取消|移除|刪除|删除|設定|设置|買|买|訂|订)/i.test(t) ||
    /(?:change|set|make|add|buy|purchase|order|cancel|remove)\b/i.test(t)
  ) return true;
  if (!looksInterrogative(t) && (detectCancellation(t) || detectDeferral(t))) return true;
  if (!looksInterrogative(t) && detectEntityReactivation(t)) return true;
  if (
    !looksInterrogative(t) &&
    /(?:星期[一二三四五六日天]|週[一二三四五六日天]|周[一二三四五六日天]|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(t) &&
    /(?:首選|首选|改(?:做|成|為|为)|安排|prefer|preferred|make it|set it)/i.test(t)
  ) return true;
  // A bare counted statement remains a supported SET/ADD input. The same
  // words inside a question are mentions, not mutation authority.
  return !looksInterrogative(t) && parseCount(t) !== null;
}

/**
 * Shared fail-closed contract for factual questions. An interrogative cannot
 * authorize commerce mutation merely because it contains an entity or count.
 * Explicit supported mutation language still wins (including polite requests
 * phrased with a question mark).
 */
export function isReadOnlyCommerceQuestion(
  text: string,
  semanticFrame?: CommerceSemanticFrame | null,
): boolean {
  const semanticRead = semanticFrame?.operation === "ASK_FACT" ||
    semanticFrame?.operation === "ASK_CALCULATION" ||
    semanticFrame?.operation === "NO_STATE_CHANGE";
  return (semanticRead || looksInterrogative(text)) &&
    !hasExplicitSupportedMutation(text);
}

/** READ_ONLY_CURRENT_STATE_QUERY is distinct from every mutation operation. */
export function isReadOnlyCurrentStateQuery(
  text: string,
  semanticFrame?: CommerceSemanticFrame | null,
): boolean {
  if (isReadOnlyCurrentStateAggregateQuery(text, semanticFrame)) return true;
  if (isReadOnlyMemoryOrCurrentStateRecall(text, semanticFrame)) return true;
  if (!isReadOnlyCommerceQuestion(text, semanticFrame)) return false;
  const t = clean(text);
  const requested = (semanticFrame?.requested_facts ?? []).join(" ");
  const quantity = /(?:數量|数量|quantity|how many|幾多|几多|多少|(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|units?|items?).{0,20}?(?:定|還是|还是|or)\s*(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|units?|items?))/i.test(t) ||
    /(?:quantity|current_quantity)/i.test(requested);
  const status = /(?:狀態|状态|status|已取消|取消咗|取消了|仲要|仍然要|still active|cancelled|canceled)/i.test(t) ||
    /(?:status|current_state)/i.test(requested);
  return quantity || status;
}

function isAllocationBreakdown(text: string): boolean {
  const matches = clean(text).match(
    /(?:[一二兩两三四五六七八九十]|\d{1,4})\s*(?:部|台|件|個|个|套|units?|items?)/gi,
  );
  return (matches?.length ?? 0) > 1;
}

/**
 * A room counter is not itself a product-unit counter.  For room-scoped
 * appliances, however, an explicit allocation such as "two rooms plus a
 * living room" is authoritative evidence for the requested aggregate.  Keep
 * this separate from parseCount so isolated room sizes/counts never become a
 * product quantity, and require both a recognised commerce category and at
 * least one explicitly counted room group.
 */
export function parseSpaceScopedCommerceQuantity(text: string): number | null {
  const t = clean(text);
  if (!t || detectCategories(t).length === 0) return null;

  const countedRoom = t.match(
    /([一二兩两三四五六七八九十]|\d{1,2})\s*(?:間|间)\s*(?:睡房|臥室|卧室|房間|房间|客房|房)/i,
  );
  const base = countedRoom?.[1] ? countTokenValue(countedRoom[1]) : null;
  if (base === null || base < 1) return null;

  const remainder = t.slice((countedRoom?.index ?? 0) + countedRoom![0].length);
  const additionalSpaces = [
    /(?:一\s*(?:個|个|間|间)|(?:個|个))?\s*(?:客廳|客厅|廳|厅)/i,
    /(?:一\s*(?:個|个|間|间)|(?:個|个))?\s*(?:廚房|厨房)/i,
    /(?:an?\s+)?(?:living\s+room|lounge|kitchen)/i,
  ].reduce((sum, pattern) => sum + (pattern.test(remainder) ? 1 : 0), 0);

  return additionalSpaces > 0 ? base + additionalSpaces : null;
}

function detectCancellation(text: string): boolean {
  return /(?:取消|唔要|不要|唔買|不买|不買|唔裝|不裝|不装|cancel|remove it|drop it|not install|won't install|do not install)/i.test(text);
}

function detectDeferral(text: string): boolean {
  return /(?:暫時唔|暫時不|暂时不|未決定(?:買|购|購|要)?住|未决定(?:买|购|要)?|稍後先|稍后再|later|hold off|defer|not decided yet)/i.test(text);
}

function dimensionConstraintCancellation(text: string): boolean {
  return /(?:(?:闊度|宽度|高度|深度|尺寸|dimension|width|height|depth).{0,18}(?:限制|上限|constraint|limit).{0,12}(?:取消|唔要|不要|remove|cancel)|(?:取消|唔要|不要|remove|cancel).{0,12}(?:闊度|宽度|高度|深度|尺寸|dimension|width|height|depth).{0,18}(?:限制|上限|constraint|limit)?)/i.test(clean(text));
}

function establishesDurableProductResearch(text: string): boolean {
  const t = clean(text);
  if (explicitCategoryKeys(t).length !== 1) return false;
  if (
    looksInterrogative(t) && parseCommerceDimensionMeasurement(t) &&
    !/(?:我位得|位置得|上限|最多|唔好超過|不要超过|at most|maximum)/i.test(t)
  ) return false;
  if (detectExplicitEntityCreationSignal(t)) return true;
  if (dimensionConstraintCancellation(t) || parseSpaceScopedCommerceQuantity(t) !== null) return true;
  return /(?:想問|想问|問埋|问埋|想要|我位得|位置|限制|上限|樓下|楼下|以下|接受|照舊|照旧|三門|三门|前置式|\d+\s*kg|買咩|买什么|邊款|哪款|recommend|advice|considering)/i.test(t);
}

function detectEntityReactivation(text: string): boolean {
  const t = clean(text);
  if (!t || looksInterrogative(t) || detectCancellation(t) || detectDeferral(t)) {
    return false;
  }
  return /(?:恢復|恢复|加返|要返|裝返|装返|都係(?:要|買|买|裝|装)|都要(?:買|买|裝|装)|裝埋|装埋|重新(?:加入|安裝|安装)|reactivate|restore|add (?:it|that|the .+?) back|include (?:it|that|the .+?)|go ahead with)/i.test(t);
}

const SITE_CHECK_PATTERNS: Array<[RegExp, string]> = [
  [/(?:窗口|窗台|window opening)/i, "window_opening_check"],
  [/(?:牆|墙|承重|wall strength|structural)/i, "wall_structure_check"],
  [/(?:電壓|电压|電力|电力|voltage|power supply|安培|amp)/i, "electrical_supply_check"],
  [/(?:排水|drainage|drain pipe|冷凝水)/i, "drainage_check"],
  [/(?:安裝|安装|installation|拆機|拆机|dismantle)/i, "installation_site_check"],
];

function detectSiteChecks(text: string): string[] {
  return SITE_CHECK_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, key]) => key);
}

export function requiresProfessionalSiteCheck(text: string): boolean {
  const structural = /(?:啲|個|个)?(?:窗口|窗台|牆|墙|電壓|电压|排水|承重|wall strength|structural|voltage|drainage)/i.test(text)
    && /(?:得唔得|可以嗎|可以吗|夠唔夠|够不够|安全|裝得|装得|OK嗎|ok\?|feasible|可行|支持|support)/i.test(text);
  const installation = /(?:安裝|安装|installation|install|mount|拆機|拆机|dismantle)/i.test(text)
    && /(?:上門|上门|師傅|师傅|onsite|on-site|site (?:visit|survey)|technician|安全|可行|feasible)/i.test(text);
  return structural || installation;
}

/* ------------------------------------------------------------------ *
 * Negation-aware transaction statement handling
 * A negated statement ("未正式落單", "not paid yet") must never be read as a
 * positive confirmation of order / payment / booking.
 * ------------------------------------------------------------------ */

const NEGATED_TX_PATTERNS: RegExp[] = [
  /(?:尚未|還未|还未|暫未|暂未|未|唔係|唔系|唔|冇|沒有|没有|沒|没|不是|不係|不)(?:係|系|會|会|有|想|要)?\s*(?:正式)?(?:落單|落单|下單|下单|確認落單|确认下单|確認訂單|确认订单|落實|落实|訂單|订单|確認|确认)/gi,
  /(?:尚未|還未|还未|暫未|暂未|未|唔|不)(?:係|系)?\s*正式/gi,
  /(?:尚未|還未|还未|暫未|暂未|未|唔|冇|沒有|没有|沒|没|不)\s*(?:付款|付錢|付钱|支付|畀錢|畀钱|付)/gi,
  /(?:尚未|還未|还未|暫未|暂未|未|唔|冇|沒有|没有|沒|没|不)\s*(?:預約|预约|約定|约定|約|约|安排|落實時間|落实时间)/gi,
  /\b(?:not|no|never|haven'?t|hasn'?t|have\s+not|has\s+not|didn'?t|did\s+not|don'?t|do\s+not|won'?t)\b[^.,;!?]{0,24}?\b(?:order(?:ed|s)?|paid|pay(?:ment|ing)?|confirm(?:ed)?|book(?:ed|ing)?|schedul(?:ed|e|ing))\b/gi,
  /\b(?:order|payment|booking|delivery|installation)\b[^.,;!?]{0,16}?\bnot\b\s*(?:yet\s*)?(?:been\s*)?(?:made|confirmed|placed|paid|booked|scheduled)?/gi,
];

interface NegatedTransactionScan {
  positive: string;
  negated_order: boolean;
  negated_payment: boolean;
  negated_booking: boolean;
}

function scanNegatedTransaction(text: string): NegatedTransactionScan {
  let positive = text;
  const removed: string[] = [];
  for (const pattern of NEGATED_TX_PATTERNS) {
    positive = positive.replace(pattern, (match) => {
      removed.push(match);
      return " ";
    });
  }
  const negated = removed.join(" ");
  return {
    positive,
    negated_order: /(?:落單|落单|下單|下单|訂單|订单|正式|確認|确认|order|confirm)/i.test(negated),
    negated_payment: /(?:付|支付|pay|paid)/i.test(negated),
    negated_booking: /(?:預約|预约|約|约|安排|book|schedul)/i.test(negated),
  };
}

function explicitOrderConfirmation(text: string): boolean {
  return /(?:已付款|已付|付咗|paid\b|正式落單|正式下单|確認落單|确认下单|confirm(?:ed)? (?:the )?order|已預約|已预约|booked)/i.test(text);
}

function explicitPaymentConfirmation(text: string): boolean {
  return /(?:已付款|已付|付咗|已支付|paid\b)/i.test(text);
}

function explicitBookingConfirmation(text: string): boolean {
  return /(?:已預約|已预约|已約|已约|已安排|booked|scheduled)/i.test(text);
}

function quotationOnlySignal(text: string): boolean {
  return /(?:報價|报价|quotation|quote|未落單|未下单|未正式|唔係落單|不是下单|先問價|先问价)/i.test(text);
}

function explicitQuotationOnlySignal(text: string): boolean {
  return /(?:quotation|報價|报价)\s*(?:咋|啫|而已|only)|(?:只係|只是|淨係|净是)\s*(?:quotation|報價|报价)|(?:未\s*(?:confirm|確認|确认).{0,18}(?:正式)?(?:order|落單|落单|下單|下单)|唔好.{0,12}當.{0,8}(?:正式)?(?:order|落單|落单|訂單|订单))/i.test(text);
}

export function detectTransactionSummaryIntent(text: string): boolean {
  return /(?:幫我總結|帮我总结|總結一下|总结一下|幫我整理|帮我整理|簡單講一次|简单说一次|成單而家有咩|整張單而家有咩|整理(?:一下)?(?:比|畀|給|给)?同事|同事跟進|同事跟进|summar(?:y|ise|ize)|recap|what(?:'s| is) in (?:the|my) (?:quote|order)|hand over to)/i.test(clean(text));
}

function detectsConstraintRecall(text: string): boolean {
  if (dimensionConstraintCancellation(text)) return false;
  return /(?:限制|條件|条件|要求|constraint|limit|requirement).{0,8}(?:呢|係咩|是什么|有咩|what)?[?？]?$/i.test(clean(text));
}

function detectsPortfolioRecall(text: string): boolean {
  return /(?:(?:總共|总共|依家|而家|目前|currently).{0,18}(?:睇緊|看着|考慮|考虑|considering).{0,10}(?:咩|什么|what)|(?:睇緊|看着|considering).{0,10}(?:咩電器|什么电器|what))/i.test(clean(text));
}

function detectsQuoteReadyRecall(text: string): boolean {
  if (detectTransactionSummaryIntent(text)) return false;
  return /(?:真正|實際|实际|而家|目前|currently).{0,16}(?:準備|准备|ready).{0,8}(?:報價|报价|quote).{0,12}(?:係咩|是什么|有咩|what)|(?:準備|准备|ready).{0,8}(?:報價|报价|quote)/i.test(clean(text));
}

function detectsQuoteProvenanceRecall(text: string): boolean {
  return /(?:邊個|边个|哪些|which).{0,12}(?:價|价|price|quote).{0,12}(?:有來源|有来源|source|來源|来源)/i.test(clean(text));
}

function detectsBrandRequirementRecall(text: string): boolean {
  return /(?:品牌|牌子|brand).{0,16}(?:一定|指定|必須|必须|required|mandatory)|(?:一定|指定|必須|必须|required|mandatory).{0,16}(?:品牌|牌子|brand)/i.test(clean(text));
}

function buildEntityPortfolioAnswer(state: ConversationCommerceState, language: CommerceLanguage, quoteReadyOnly: boolean): string {
  const entities = state.entities.filter((entity) => entity.status !== "cancelled" && (!quoteReadyOnly || entity.status !== "deferred"));
  const labels = entities.map((entity) => `${entityLabel(entity.entity_id, language)} x${entity.quantity}`);
  if (language === "en") return labels.length ? `${quoteReadyOnly ? "The currently active items are" : "You are currently considering"}: ${labels.join(", ")}.` : `There are currently no ${quoteReadyOnly ? "active items" : "items under consideration"}.`;
  if (language === "zh-CN") return labels.length ? `${quoteReadyOnly ? "目前有效项目是" : "你目前正在考虑的是"}：${labels.join("、")}。` : `目前没有${quoteReadyOnly ? "有效" : "正在考虑"}的产品。`;
  return labels.length ? `${quoteReadyOnly ? "而家有效嘅項目係" : "你而家睇緊嘅係"}：${labels.join("、")}。` : `而家未有${quoteReadyOnly ? "有效" : "考慮中"}嘅產品。`;
}

function buildScopedConstraintAnswer(input: CommerceRuntimeInput, state: ConversationCommerceState): { reply: string; path: string } | null {
  const categoryResolution = resolveAttributeQueryCategory(input);
  if (categoryResolution.ambiguous || !categoryResolution.category) return null;
  const category = categoryResolution.category;
  const active = state.entities.filter((entity) => entity.category === category && entity.status !== "cancelled" && entity.status !== "deferred");
  if (active.length !== 1) return null;
  const entity = active[0];
  const labels: string[] = [];
  for (const [key, raw] of Object.entries(entity.constraints)) {
    const value = numericConstraint(raw);
    const match = key.match(/^(?:max|excluded)_(width|height|depth)_mm$/);
    if (value === null || !match) continue;
    const dimension = dimensionLabel(match[1] as CommerceDimensionAttribute, input.language);
    if (input.language === "en") labels.push(key.startsWith("excluded_") ? `${dimension} ${formatMillimetres(value)} mm is excluded` : `${dimension} up to ${formatMillimetres(value)} mm`);
    else if (input.language === "zh-CN") labels.push(key.startsWith("excluded_") ? `${dimension}不接受 ${formatMillimetres(value)}mm` : `${dimension}上限 ${formatMillimetres(value)}mm`);
    else labels.push(key.startsWith("excluded_") ? `${dimension}唔接受 ${formatMillimetres(value)}mm` : `${dimension}上限 ${formatMillimetres(value)}mm`);
  }
  if (!labels.length) return null;
  const product = categoryLabel(category, input.language);
  const reply = input.language === "en" ? `The current ${product} constraint is: ${labels.join(", ")}.` : input.language === "zh-CN" ? `目前${product}的限制是：${labels.join("、")}。` : `而家${product}嘅限制係：${labels.join("、")}。`;
  return { reply, path: `entities.${state.entities.indexOf(entity)}.constraints` };
}

function buildQuoteProvenanceAnswer(state: ConversationCommerceState, language: CommerceLanguage): string {
  const values = state.quotes.filter((quote) => quote.quote_type === "customer_reported_historical").map((quote) => `${quote.currency} ${quote.amount}`);
  if (language === "en") return values.length ? `The sourced figures on record are the historical prices you provided: ${values.join(", ")}. They are references, not verified current prices.` : "There is no sourced price on record yet, so I cannot confirm a current price.";
  if (language === "zh-CN") return values.length ? `目前有来源的数字是你提供的历史报价：${values.join("、")}。这些只作参考，并非已核实的现价。` : "目前没有已记录来源的价格，所以暂时无法确认现价。";
  return values.length ? `目前有來源嘅數字係你提供過嘅歷史報價：${values.join("、")}。呢啲只係參考，唔係已核實嘅現價。` : "目前未有已記錄來源嘅價錢，所以暫時未能確認現價。";
}

export function detectCurrentPriceValidityQuestion(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  const historical = /(?:之前|以前|以往|舊|旧|歷史|历史|previous|earlier|old)/i.test(t);
  const price = /(?:報價|报价|價|价|price|quote|quotation|收費|收费|fee)/i.test(t);
  const current = /(?:而家|現在|现在|目前|最新|仲係|还是|仍然|current|latest|still)/i.test(t);
  const validity = /(?:一定|作準|作准|有效|同價|同价|一樣|一样|same|valid|guarantee|guaranteed)/i.test(t);
  return historical && price && (current || validity);
}

function asksToReuseRecordedPrice(text: string, state: ConversationCommerceState): boolean {
  if (!/[?？]/.test(text)) return false;
  const amounts = (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((value) => Number(value.replace(/,/g, "")));
  return amounts.length > 0 && state.quotes.some((quote) => amounts.includes(quote.amount) && (quote.quote_type !== "current_verified" || quote.validity_status !== "current"));
}

function historicalPriceExclusionInstruction(text: string): boolean {
  return /(?:唔好|不要|不可|不能|not|don'?t).{0,30}(?:當|当|用|沿用|treat|use).{0,30}(?:正式價|正式价|現價|现价|落單|下单|order|current\s*price)|(?:舊價|旧价|old\s*(?:price|quote)).{0,30}(?:唔好|不要|not|don'?t).{0,20}(?:用|沿用|use)/i.test(text);
}

function buildHistoricalPriceExclusionAnswer(language: CommerceLanguage): string {
  if (language === "en") return "Understood. Recorded or previous prices will stay historical only and will not be used as a current price or to place an order.";
  if (language === "zh-CN") return "明白。已记录或之前的价格只会保留作历史参考，不会当作现价或用来下单。";
  return "明白。已記錄或之前嘅價錢只會保留做歷史參考，唔會當現價或用嚟落單。";
}

function paymentChecklistIntent(text: string): boolean {
  return /(?:付款|支付|payment).{0,24}(?:前|之前|before).{0,24}(?:checklist|清單|清单|核對|核对)|(?:checklist|清單|清单).{0,24}(?:付款|支付|payment)/i.test(text);
}

function buildPaymentChecklist(state: ConversationCommerceState, language: CommerceLanguage): string {
  const pending = [...new Set([...state.installation.pending_checks, ...state.installation.items.filter((item) => item.status === "pending").map((item) => item.kind)])];
  const items = language === "en"
    ? ["Confirm the final item list and quantities", "Confirm the current written quote and all fees", "Confirm delivery details", pending.length ? "Complete the outstanding technician checks" : "Confirm whether any technician check is still required", "Confirm the order before payment"]
    : language === "zh-CN"
    ? ["核对最终产品及数量", "核实当前书面报价和所有费用", "核对收货资料", pending.length ? "完成待师傅确认项目" : "确认是否仍需师傅检查", "付款前再次确认订单"]
    : ["核對最終產品同數量", "核實最新書面報價同所有費用", "核對收貨資料", pending.length ? "完成待師傅確認項目" : "確認係咪仲需要師傅檢查", "付款前再確認訂單"];
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

export function detectPreorderUnpaidIntent(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  const preorder = /(?:想預訂|想预订|想訂|想订|要預訂|要预订|預訂|预订|想預約|想预约|要預約|要预约|預約|预约|reserve|reservation|book(?:ing)?|pre[- ]?order|want to order|place an order)/i.test(t);
  return preorder && scanNegatedTransaction(t).negated_payment;
}

function parseMoneyTerms(text: string): number[] {
  const amounts: number[] = [];
  const re = /(?:HK\$|HKD|\$|元|價|价|費|费|收費|收费|fee|price)\s*((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?)|((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.[0-9]{1,2})?)\s*(?:元|蚊|dollars?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1] ?? m[2];
    if (!raw) continue;
    const value = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) amounts.push(value);
  }
  return amounts;
}

export function detectExplicitCalculationRequest(text: string): boolean {
  return /(?:加埋|合共|總共|总共|一共|總數|总数|埋一齊|埋一起|total|altogether|calculate|計下|计下|算下|計算|计算|計幾錢|计多少钱|算幾錢|算多少钱|how much.*(?:total|altogether)|(?:按|用).{0,24}(?:報價|报价|price|quote).{0,24}(?:計|计|算))/i.test(clean(text));
}

export function extractCommerceCalculationTerms(
  texts: string[],
  state: ConversationCommerceState,
  options?: { include_historical_state?: boolean },
): { terms: CommerceCalculationTerm[]; currency: string | null } {
  const amounts: number[] = [];
  if (options?.include_historical_state) {
    const latestHistorical = state.quotes.filter((quote) => quote.quote_type === "customer_reported_historical").at(-1);
    if (latestHistorical) amounts.push(latestHistorical.amount);
    for (const raw of texts) {
      const text = clean(raw);
      const costPattern = /(?:安裝|安装|鋁架|铝架|支架|架|拆機|拆机|運費|运费|送貨費|送货费|installation|frame|bracket|delivery\s*fee)\s*(?:費|费|係|是|:|：)?\s*(\d[\d,]*(?:\.\d+)?)/gi;
      let match: RegExpExecArray | null;
      while ((match = costPattern.exec(text)) !== null) {
        const amount = Number(match[1].replaceAll(",", ""));
        if (Number.isFinite(amount) && amount > 0) amounts.push(amount);
      }
    }
  } else {
    for (const raw of texts) {
      const text = clean(raw);
      if (!text) continue;
      for (const amount of parseMoneyTerms(text)) amounts.push(amount);
    }
  }
  const unique: number[] = [];
  const seen = new Map<number, number>();
  for (const amount of amounts) {
    const count = seen.get(amount) ?? 0;
    if (count < 2) {
      seen.set(amount, count + 1);
      unique.push(amount);
    }
  }
  if (!unique.length) return { terms: [], currency: null };

  const currentTurnMultiplier = parseCount(texts[0] ?? "");
  const activeEntities = state.entities.filter(
    (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
  );
  const stateMultiplier = activeEntities.length === 1
    ? Math.max(1, activeEntities[0].quantity)
    : activeEntities.reduce((sum, entity) => sum + Math.max(0, entity.quantity), 0) || 1;
  const multiplier = currentTurnMultiplier ?? stateMultiplier;

  const currency = state.quotes.find((q) => q.currency)?.currency ?? "HKD";
  return {
    terms: unique.map((amount, index) => ({ label: `customer_term_${index + 1}`, value: amount, multiplier })),
    currency,
  };
}

function calculationExplicitlyUsesHistory(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  return /(?:(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier).{0,40}(?:數字|数字|價|价|報價|报价|price|quote|figure|amount).{0,40}(?:計|计|算|calculate|total|合共|總共|总共)|(?:計|计|算|calculate|total|合共|總共|总共).{0,40}(?:之前|以前|以往|舊|旧|歷史|历史|previous|historical|earlier))/i.test(t);
}

interface LoadedCommerceState {
  state: ConversationCommerceState;
  revision: number;
}

export async function loadCommerceState(
  db: CommerceStateDbClient,
  conversation_id: string,
): Promise<LoadedCommerceState> {
  const { data, error } = await db.from("conversation_commerce_state").select("revision, state").eq("conversation_id", conversation_id).maybeSingle();
  if (error || !isRecord(data)) return { state: createEmptyConversationCommerceState(), revision: 0 };
  const revision = typeof data["revision"] === "number" ? data["revision"] : Number(data["revision"] ?? 0);
  const state = data["state"];
  return {
    state: isConversationCommerceState(state) ? state : createEmptyConversationCommerceState(),
    revision: Number.isFinite(revision) && revision > 0 ? revision : 0,
  };
}

function deriveA3RuntimeEvents(
  input: CommerceRuntimeInput,
  hints: CommerceTurnEntityHint[],
  previous: ConversationCommerceState,
): CommerceStateEvent[] {
  const text = clean(input.text);
  const events: CommerceStateEvent[] = [];
  const provenance = {
    source_type: "customer" as const,
    source_message_id: input.source_message_id,
    recorded_at: input.occurred_at ?? null,
  };
  const mentioned = hintsMentionedInTurn(text, hints);
  const quantity = parseSpaceScopedCommerceQuantity(text) ?? parseCount(text);
  const constraintCancellation = dimensionConstraintCancellation(text);
  const cancelled = detectCancellation(text) && !constraintCancellation;
  const deferred = detectDeferral(text);
  const reactivated = detectEntityReactivation(text);
  const semanticAuthoritative = Boolean(
    input.semantic_frame && input.semantic_frame.confidence >= 0.72,
  );
  const activeAggregates = previous.entities.filter((entity) =>
    entity.entity_id.endsWith(":unscoped") &&
    entity.status !== "cancelled" && entity.status !== "deferred"
  );
  const additive = detectAdditiveEntityCreationSignal(text);
  const explicitCreation = detectExplicitEntityCreationSignal(text) || establishesDurableProductResearch(text);
  const correction = quantity !== null && detectQuantityCorrectionSignal(text);
  const allocationBreakdown = correction && isAllocationBreakdown(text);
  const addressCorrection = parseAddressReplacementCorrection(text);

  // The semantic adapter owns entity mutation when its frame is authoritative,
  // but B2 still needs the customer's exact correction ledger. Record explicit
  // quantity corrections here so a later, superseded tentative statement cannot
  // remain the apparent "latest" correction merely because semantic extraction
  // handled the entity updates.
  if (correction || addressCorrection) {
    events.push({ type: "ADD_CORRECTION", correction: text });
  }

  if (addressCorrection) {
    events.push({
      type: "SET_DELIVERY",
      patch: {},
      address_update: addressCorrection,
      provenance,
    });
  }

  const currentCategories = explicitCategoryKeys(text);
  if (currentCategories.length === 1 && establishesDurableProductResearch(text)) {
    events.push({ type: "SET_CONTEXT", topic: currentCategories[0] });
  }

  // Persist dimension constraints against the same uniquely scoped product
  // used by the reader, preventing cross-entity carryover.
  const dimensionCategory = resolveAttributeQueryCategory(input);
  if (!dimensionCategory.ambiguous && dimensionCategory.category && !looksInterrogative(text)) {
    const category = dimensionCategory.category;
    const target = previous.entities.find((entity) =>
      entity.category === category && entity.status !== "cancelled" && entity.status !== "deferred"
    ) ?? mentioned.find((hint) => hint.category === category);
    if (target) {
      if (constraintCancellation) {
        const attribute = inferCommerceDimensionAttribute(text) ?? "width";
        for (const key of dimensionConstraintKey(attribute)) {
          events.push({ type: "REMOVE_ENTITY_CONSTRAINT", entity_id: target.entity_id, key, provenance });
        }
      } else {
        const measurement = parseProductDimension(text);
        const attribute = measurement
          ? inferCommerceDimensionAttribute(text, input.semantic_frame) ?? contextualConstraintAttribute(input.history ?? [], 0, category)
          : null;
        if (measurement && attribute && (maximumConstraintLanguage(text) || /(?:位得|位置得|接受|照舊|照旧|fit|accept)/i.test(text))) {
          events.push({ type: "SET_ENTITY_CONSTRAINT", entity_id: target.entity_id, key: `max_${attribute}_mm`, value: measurement.value_mm, provenance });
        }
        if (measurement && attribute && /(?:就唔好|就不要|唔接受|不接受|排除|exclude|reject)/i.test(text)) {
          events.push({ type: "SET_ENTITY_CONSTRAINT", entity_id: target.entity_id, key: `excluded_${attribute}_mm`, value: measurement.value_mm, provenance });
        }
      }
    }
  }

  // generate-reply supplies newest-first history.  Reading the tail here used
  // the oldest turns and dropped the immediately preceding delivery context in
  // long conversations (captured production T058).  Keep the bounded newest
  // window and let the shared extractor reject questions/policy/cancellation.
  const deliveryContext = (input.history ?? []).slice(0, MAX_HISTORY_TURNS).some((turn) =>
    /(?:送貨|送货|配送|派送|delivery|deliver)/i.test(turn.content)
  );
  const preferredDeliveryDate = extractDeliveryPreference(text, deliveryContext);
  if (preferredDeliveryDate) {
    events.push({
      type: "SET_DELIVERY",
      patch: { preferred_date: preferredDeliveryDate },
      provenance,
    });
  }

  const horsepower = [...text.matchAll(/(\d+(?:\.\d+)?)\s*匹/gi)].map((match) => `${match[1]}匹`);
  if (horsepower.length > 0 && !/[?？]/.test(text)) {
    const categories = [...new Set(hints.map((hint) => hint.category))];
    const active = previous.entities.filter((entity) => entity.status !== "cancelled" && entity.status !== "deferred" && (categories.length === 0 || categories.includes(entity.category)));
    const scopedMentionIds = [...new Set(mentioned
      .filter((hint) => !hint.entity_id.endsWith(":unscoped"))
      .map((hint) => hint.entity_id))];
    const scopedTarget = scopedMentionIds.length === 1
      ? previous.entities.find((entity) =>
        entity.entity_id === scopedMentionIds[0] &&
        (!["cancelled", "deferred"].includes(entity.status) || reactivated)
      )
      : null;
    const target = scopedTarget ?? (scopedMentionIds.length === 0
      ? active.length === 1
        ? active[0]
        : active.find((entity) => entity.category === "air_conditioner" && entity.entity_id.endsWith(":unscoped"))
      : null);
    if (target) events.push({ type: "SET_ENTITY_ATTRIBUTE", entity_id: target.entity_id, key: "horsepower", value: [...new Set(horsepower)].join("、"), provenance });
  }

  if (/(?:舊機|旧机|舊冷氣|旧空调)/i.test(text) && /(?:拆|移除|冇機|没机|no\s+(?:old\s+)?unit)/i.test(text) && !/[?？]/.test(text)) {
    const explicit = text.match(/([一二兩两三四五六七八九十]|\d{1,2})\s*部\s*(?:舊機|旧机)/i)?.[1];
    const removalCount = explicit ? countTokenValue(explicit) : /(?:一部|one\s+(?:old\s+)?unit)/i.test(text) ? 1 : null;
    if (removalCount !== null) events.push({ type: "SET_SITE_CONDITION", key: "old_machine_removal_count", value: removalCount });
  }

  if (/(?:[\p{L}\p{N}-]+[、,，]){1,}[\p{L}\p{N}-]+(?:都得|均可|皆可|any\s+(?:is|are)\s+fine)/iu.test(text)) {
    events.push({ type: "SET_CUSTOMER_CONSTRAINT", key: "brand_required", value: false });
  }

  if (
    correction && !allocationBreakdown && quantity !== null &&
    mentioned.length === 0
  ) {
    const active = previous.entities.filter(
      (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
    );
    if (active.length === 1) {
      events.push({
        type: "SET_ENTITY_QUANTITY",
        entity_id: active[0].entity_id,
        quantity,
        provenance,
      });
    }
  }

  if (additive && quantity !== null && mentioned.length === 0) {
    const active = previous.entities.filter(
      (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
    );
    if (active.length === 1) {
      events.push({
        type: "SET_ENTITY_QUANTITY",
        entity_id: active[0].entity_id,
        quantity: active[0].quantity + quantity,
        provenance,
      });
      events.push({ type: "SET_ENTITY_STATUS", entity_id: active[0].entity_id, status: "tentative", provenance });
    }
  }

  for (const hint of mentioned) {
    const existing = previous.entities.find((entity) =>
      entity.entity_id === hint.entity_id
    );
    const aggregate = previous.entities.find((entity) =>
      entity.category === hint.category &&
      entity.entity_id.endsWith(":unscoped") &&
      entity.status !== "cancelled" && entity.status !== "deferred"
    );
    const scopedEntity = hint.entity_id.startsWith(`${hint.category}:`) &&
      !hint.entity_id.endsWith(":unscoped");
    const canMaterializeSemanticScope = semanticAuthoritative && !existing &&
      scopedEntity && activeAggregates.length === 1 &&
      activeAggregates[0].category === hint.category;

    if ((cancelled || deferred) && canMaterializeSemanticScope) {
      events.push({
        type: "ENSURE_ENTITY",
        entity: {
          entity_id: hint.entity_id,
          category: hint.category,
          brand: hint.brand ?? null,
          model: hint.model ?? null,
          quantity: hint.quantity ?? 1,
          status: "tentative",
          attributes: { ...(hint.attributes ?? {}) },
          constraints: { ...(hint.constraints ?? {}) },
          provenance,
        },
      });
    }

    if (cancelled) {
      // A semantic-authoritative mutation may only target a durable entity or
      // the uniquely materialized scoped entity above. Ambiguous references
      // stay read-only so downstream clarification remains fail-closed.
      if (semanticAuthoritative && !existing && !canMaterializeSemanticScope) continue;
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "cancelled", provenance });
      if (!existing && aggregate && aggregate.quantity > 0) {
        events.push({
          type: "SET_ENTITY_QUANTITY",
          entity_id: aggregate.entity_id,
          quantity: Math.max(0, aggregate.quantity - (hint.quantity ?? 1)),
          provenance,
        });
      }
      continue;
    }
    if (deferred) {
      if (semanticAuthoritative && !existing && !canMaterializeSemanticScope) continue;
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "deferred", provenance });
      if (!existing && aggregate && aggregate.quantity > 0) {
        events.push({
          type: "SET_ENTITY_QUANTITY",
          entity_id: aggregate.entity_id,
          quantity: Math.max(0, aggregate.quantity - (hint.quantity ?? 1)),
          provenance,
        });
      }
      continue;
    }
    if (reactivated && existing && ["cancelled", "deferred"].includes(existing.status)) {
      events.push({
        type: "SET_ENTITY_STATUS",
        entity_id: hint.entity_id,
        status: "tentative",
        provenance,
      });
    }
    if (quantity !== null && (additive || mentioned.length === 1)) {
      const existing = previous.entities.find((entity) => entity.entity_id === hint.entity_id);
      const nextQuantity = additive && existing ? existing.quantity + quantity : quantity;
      events.push({ type: "SET_ENTITY_QUANTITY", entity_id: hint.entity_id, quantity: nextQuantity, provenance });
    }
    if (quantity !== null || explicitCreation) {
      events.push({ type: "SET_ENTITY_STATUS", entity_id: hint.entity_id, status: "tentative", provenance });
    }
  }

  const checks = detectSiteChecks(text);
  if (checks.length) {
    const nextChecks = detectCancellation(text)
      ? previous.installation.pending_checks.filter((check) => !checks.includes(check))
      : [...previous.installation.pending_checks, ...checks];
    events.push({ type: "SET_PENDING_CHECKS", checks: [...new Set(nextChecks)] });
  }
  return events;
}

export function enforceQuotationNotOrderEvents(
  text: string,
  state: ConversationCommerceState,
): CommerceStateEvent[] {
  const scan = scanNegatedTransaction(text);
  const positiveOrder = explicitOrderConfirmation(scan.positive);
  const positivePayment = explicitPaymentConfirmation(scan.positive);
  const positiveBooking = explicitBookingConfirmation(scan.positive);
  const events: CommerceStateEvent[] = [];

  if (scan.negated_booking && !positiveBooking && state.delivery.confirmed) {
    events.push({ type: "SET_DELIVERY", patch: { confirmed: false }, provenance: { source_type: "derived" } });
  }
  if (positiveOrder) return events;

  const promoted = state.conversion.order_status === "confirmed" || state.conversion.order_status === "completed" || state.conversion.funnel_stage === "order_confirmed";
  const paidDrift = !positivePayment && scan.negated_payment && (state.conversion.payment_status === "paid" || state.conversion.payment_status === "pending_payment");

  if (!promoted && !paidDrift) {
    if (quotationOnlySignal(text) && state.conversion.quotation_status === "none") {
      events.push({ type: "SET_CONVERSION", patch: { funnel_stage: "quotation", quotation_status: "draft" } });
    }
    return events;
  }

  const patch: Partial<ConversationCommerceState["conversion"]> = {
    funnel_stage: "quotation",
    quotation_status: state.conversion.quotation_status === "none" ? "draft" : state.conversion.quotation_status,
  };
  if (promoted) patch.order_status = "draft";
  if (paidDrift) patch.payment_status = "pending_quote";
  events.push({ type: "SET_CONVERSION", patch });
  return events;
}

export function detectExplicitEntityCreationSignal(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  if (parseCount(t) !== null) return true;
  return /(?:另外|再加|再要|加多|加一|加個|加个|多要|多買|多买|新增|想買|想买|要買|要买|購買|购买|訂購|订购|落單|下單|下单|需要|我要|加裝|加装|安裝多|添置|add\s|buy\s|purchase|order\s|need\s|want\s|another|extra|additional)/i.test(t);
}

export function detectAdditiveEntityCreationSignal(text: string): boolean {
  const t = clean(text);
  if (!t) return false;
  return /(?:另外\s*(?:加|要|買|买|訂|订|新增|加裝|加装)|再加|再要|加多|多要|多買|多买|新增多|加裝多|加装多|another|extra|additional|add\s+(?:another|one|two|three|\d))/i.test(t);
}

export function filterGhostUnscopedHints(
  text: string,
  state: ConversationCommerceState,
  hints: CommerceTurnEntityHint[],
): CommerceTurnEntityHint[] {
  const explicitCreation = detectExplicitEntityCreationSignal(text) || establishesDurableProductResearch(text);
  const additive = detectAdditiveEntityCreationSignal(text);
  const categories = new Set(detectCategories(text).map((category) => category.key));
  const rooms = detectRooms(text);

  return hints.filter((hint) => {
    if (!categories.has(hint.category)) return true;
    const roomKey = hint.entity_id.split(":")[1];
    if (rooms.length > 0 && roomKey === "unscoped") return false;
    if (additive && rooms.length === 0) return roomKey === "unscoped";
    if (roomKey !== "unscoped") return true;
    if (state.entities.some((e) => e.entity_id === hint.entity_id)) return true;
    if (!explicitCreation) return false;
    const hasConcreteSameCategory = state.entities.some(
      (entity) => entity.category === hint.category && !entity.entity_id.endsWith(":unscoped") && entity.status !== "cancelled" && entity.status !== "deferred",
    );
    if (rooms.length === 0 && hasConcreteSameCategory) return false;
    return true;
  });
}

function materializeRoomOnlyReferenceHints(
  text: string,
  state: ConversationCommerceState,
  hints: CommerceTurnEntityHint[],
  history: CommerceHistoryTurn[] = [],
): CommerceTurnEntityHint[] {
  const rooms = detectReferencedRooms(text);
  const scopedAttributeAssignment = !looksInterrogative(text) &&
    /(?:\d+(?:\.\d+)?\s*匹|horsepower|\bhp\b)/i.test(text);
  if (
    rooms.length === 0 || detectCategories(text).length > 0 ||
    (!detectCancellation(text) && !detectDeferral(text) &&
      !detectEntityReactivation(text) && !scopedAttributeAssignment)
  ) return hints;

  let aggregateCategories = [...new Set(
    state.entities.filter((entity) =>
      entity.entity_id.endsWith(":unscoped") &&
      entity.status !== "cancelled" && entity.status !== "deferred"
    ).map((entity) => entity.category),
  )];
  if (aggregateCategories.length > 1) {
    for (const turn of history) {
      if (!["visitor", "user", "customer"].includes(turn.role)) continue;
      const recent = explicitCategoryKeys(turn.content).filter((category) => aggregateCategories.includes(category));
      if (recent.length === 1) {
        aggregateCategories = recent;
        break;
      }
    }
  }
  // A room-only reference is resolvable only when the current state supplies
  // one authoritative aggregate category. Multiple active categories remain
  // ambiguous and must not be guessed here.
  if (aggregateCategories.length !== 1) return hints;

  const category = aggregateCategories[0];
  const canonicalEntityIds = new Set(rooms.map((room) => `${category}:${room.key}`));
  const roomAliases = rooms.flatMap((room) => room.aliases)
    .map((alias) => clean(alias, 80).toLowerCase())
    .filter(Boolean);
  // A semantic frame can describe the same scoped phrase with a generated
  // entity id (for example, generic:<room phrase>). Once the aggregate and
  // room make the reference deterministic, discard that non-persisted shadow
  // before events are built; otherwise it can fail mutation before the
  // canonical scoped entity is materialized and leave reply routing unaware
  // that the requested action was successfully resolved.
  const next = new Map(hints.filter((hint) => {
    if (hint.category !== category || canonicalEntityIds.has(hint.entity_id)) return true;
    if (state.entities.some((entity) => entity.entity_id === hint.entity_id)) return true;
    return !(hint.aliases ?? []).some((alias) => {
      const normalized = clean(alias, 80).toLowerCase();
      return normalized && roomAliases.some((roomAlias) =>
        normalized.includes(roomAlias) || roomAlias.includes(normalized)
      );
    });
  }).map((hint) => [hint.entity_id, hint]));
  for (const room of rooms) {
    const entity_id = `${category}:${room.key}`;
    if (!next.has(entity_id)) {
      next.set(entity_id, {
        entity_id,
        category,
        quantity: 1,
        aliases: [...room.aliases],
      });
    }
  }
  return [...next.values()];
}

export function reduceTurn(
  previous: ConversationCommerceState,
  input: CommerceRuntimeInput,
  rawHints: CommerceTurnEntityHint[],
): ConversationCommerceState {
  // READ_ONLY_CURRENT_STATE_QUERY (and other factual interrogatives) emits no
  // state events. Persistence may still record this source-message revision,
  // but its canonical state payload remains byte-for-byte unchanged.
  const durableResearchTurn = establishesDurableProductResearch(input.text);
  if (isReadOnlyCurrentStateQuery(input.text, input.semantic_frame) && !durableResearchTurn) {
    return previous;
  }
  const contextual = resolveContextualTurn(input, previous);
  if (contextual.route === "targeted_clarification") return previous;
  if (contextual.route === "contextual_scoped_update") {
    return reduceCommerceState(previous, contextualUpdateEvents(
      contextual, previous, input.source_message_id, input.occurred_at,
    ));
  }
  const calculationTurn = detectExplicitCalculationRequest(input.text);
  const resolvedHints = calculationTurn
    ? []
    : materializeRoomOnlyReferenceHints(input.text, previous, rawHints, input.history ?? []);
  const hints = calculationTurn
    ? []
    : filterGhostUnscopedHints(input.text, previous, resolvedHints);
  const mentioned = calculationTurn ? [] : hintsMentionedInTurn(input.text, hints);
  const bookingWithoutDelivery = mentioned.some(hintRequiresBookingWithoutDelivery);
  const semanticAuthoritative = !calculationTurn && Boolean(input.semantic_frame && input.semantic_frame.confidence >= 0.72);
  const semanticEventsRaw = semanticAuthoritative
    ? semanticFrameToStateEvents(input.semantic_frame, previous, hints, input.source_message_id, input.occurred_at ?? null)
    : [];
  const semanticEvents = bookingWithoutDelivery
    ? semanticEventsRaw.filter((event) => event.type !== "SET_DELIVERY")
    : semanticEventsRaw;
  const deterministicEvents = calculationTurn ? [] : deriveCommerceEventsFromCustomerTurn({
    text: input.text,
    source_message_id: input.source_message_id,
    occurred_at: input.occurred_at ?? null,
    entity_hints: hints,
    current_language: input.language,
  });
  // Semantic interpretation owns entity mutations, but it has no address
  // component contract. Keep deterministic delivery events so a complete
  // address is present before a later scoped correction is merged.
  const derivedRaw = semanticAuthoritative
    ? deterministicEvents.filter((event) =>
      event.type === "SET_DELIVERY" ||
      (durableResearchTurn && (event.type === "ENSURE_ENTITY" || event.type === "SET_CONTEXT"))
    )
    : deterministicEvents;
  const derivedWithoutConstraintCancellation = dimensionConstraintCancellation(input.text)
    ? derivedRaw.filter((event) => event.type !== "SET_ENTITY_STATUS")
    : derivedRaw;
  const allocationBreakdown = detectQuantityCorrectionSignal(input.text) &&
    isAllocationBreakdown(input.text);
  const derivedWithoutAllocationOverwrite = allocationBreakdown
    ? derivedWithoutConstraintCancellation.filter((event) => event.type !== "SET_ENTITY_QUANTITY")
    : derivedWithoutConstraintCancellation;
  const derived = bookingWithoutDelivery
    ? derivedWithoutAllocationOverwrite.filter((event) =>
      event.type !== "SET_DELIVERY"
    )
    : derivedWithoutAllocationOverwrite;
  const runtimeEvents = calculationTurn ? [] : deriveA3RuntimeEvents(input, hints, previous);
  const industryEvent: CommerceStateEvent[] = input.industry_identifier
    ? [{ type: "SET_CONTEXT", language: input.language, industry: input.industry_identifier }]
    : [];
  const reduced = reduceCommerceState(previous, [...industryEvent, ...semanticEvents, ...derived, ...runtimeEvents]);
  const guard = enforceQuotationNotOrderEvents(clean(input.text), reduced);
  return guard.length ? reduceCommerceState(reduced, guard) : reduced;
}

function resolveContextualTurn(
  input: CommerceRuntimeInput,
  state: ConversationCommerceState,
): ContextualDecision {
  const history = (input.history ?? [])
    .filter((turn) => ["visitor", "user", "customer"].includes(turn.role))
    .slice(0, MAX_HISTORY_TURNS).map((turn) => clean(turn.content));
  const candidate = resolveIndustryContextualCandidate({
    text: input.text, history, state, language: input.language,
  });
  return resolveContextualCustomerUpdate({
    candidate,
    state,
    read_only: isReadOnlyCurrentStateQuery(input.text, input.semantic_frame),
  });
}

function rpcResult(data: unknown): { result: string; applied_revision: number | null } {
  if (!isRecord(data)) return { result: "rpc_transport_error", applied_revision: null };
  const result = typeof data["result"] === "string" ? data["result"] : "rpc_unknown_result";
  const applied = data["applied_revision"];
  return { result, applied_revision: typeof applied === "number" ? applied : null };
}

export async function persistCommerceTurn(
  db: CommerceStateDbClient,
  input: CommerceRuntimeInput,
  hints: CommerceTurnEntityHint[],
): Promise<{ previous_state: ConversationCommerceState; state: ConversationCommerceState; revision: number; result: string }> {
  const loaded = await loadCommerceState(db, input.conversation_id);
  let expected = loaded.revision;
  let previous = loaded.state;
  let next = reduceTurn(previous, input, hints);

  for (let attempt = 0; attempt < 2; attempt++) {
    // A conversational turn that does not alter the canonical commerce state
    // has no mutation receipt by design. Preserve revision and provenance, and
    // let the B2 readback contract prove the authoritative no-op.
    if (JSON.stringify(next) === JSON.stringify(previous)) {
      return {
        previous_state: previous,
        state: previous,
        revision: expected,
        result: "no_semantic_change",
      };
    }
    const { data, error } = await db.rpc(COMMERCE_STATE_RPC, {
      p_conversation_id: input.conversation_id,
      p_company_id: input.company_id,
      p_expected_revision: expected,
      p_source_message_id: input.source_message_id,
      p_state: next,
    });
    if (error) return { previous_state: previous, state: next, revision: expected, result: "rpc_transport_error" };
    const parsed = rpcResult(data);
    if (parsed.result === "success") return { previous_state: previous, state: next, revision: parsed.applied_revision ?? expected + 1, result: "success" };
    if (parsed.result === "revision_conflict" && attempt === 0) {
      const reloaded = await loadCommerceState(db, input.conversation_id);
      expected = reloaded.revision;
      previous = reloaded.state;
      next = reduceTurn(previous, input, hints);
      continue;
    }
    return { previous_state: previous, state: next, revision: expected, result: parsed.result };
  }
  return { previous_state: previous, state: next, revision: expected, result: "revision_conflict" };
}

function statusLabel(status: string, language: CommerceLanguage): string {
  const table: Record<string, Record<CommerceLanguage, string>> = {
    cancelled: { "zh-TW": "已取消", "zh-CN": "已取消", en: "cancelled" },
    deferred: { "zh-TW": "暫緩", "zh-CN": "暂缓", en: "deferred" },
    confirmed: { "zh-TW": "已確認", "zh-CN": "已确认", en: "confirmed" },
    tentative: { "zh-TW": "初步", "zh-CN": "初步", en: "tentative" },
    researching: { "zh-TW": "考慮中", "zh-CN": "考虑中", en: "under consideration" },
  };
  return table[status]?.[language] ?? status;
}

export function buildTransactionSummary(
  state: ConversationCommerceState,
  language: CommerceLanguage,
): string {
  const lines: string[] = [];
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const inactive = state.entities.filter((e) => e.status === "cancelled" || e.status === "deferred");
  const historical = state.quotes.filter((q) => q.quote_type === "customer_reported_historical");

  const t = {
    head: { "zh-TW": "我幫你整理咗現時已確認嘅資料：", "zh-CN": "我帮你整理了目前已确认的资料：", en: "Here is what is on record so far:" },
    items: { "zh-TW": "項目", "zh-CN": "项目", en: "Items" },
    none: { "zh-TW": "暫時未有", "zh-CN": "暂时没有", en: "none yet" },
    removed: { "zh-TW": "已取消／暫緩", "zh-CN": "已取消／暂缓", en: "Cancelled / deferred" },
    delivery: { "zh-TW": "送貨安排", "zh-CN": "送货安排", en: "Delivery" },
    pending: { "zh-TW": "待師傅上門確認", "zh-CN": "待师傅上门确认", en: "Pending onsite professional checks" },
    quotes: { "zh-TW": "你提供嘅歷史報價（歷史數字，非現價）", "zh-CN": "你提供的历史报价（历史数字，非现价）", en: "Historical prices you provided (historical, not current)" },
    status: { "zh-TW": "目前狀態", "zh-CN": "目前状态", en: "Current status" },
    tail: { "zh-TW": "最新價格、適用費用同相關條件仍然要確認之後先作準。", "zh-CN": "最新价格、适用费用及相关条件仍需确认后才作准。", en: "Latest pricing, applicable fees and relevant conditions still need to be confirmed." },
  } as const;

  lines.push(t.head[language]);
  const renderEntity = (entity: ConversationCommerceState["entities"][number]) => {
    const constraints = Object.entries(entity.constraints).flatMap(([key, raw]) => {
      const value = numericConstraint(raw);
      const match = key.match(/^(?:max|excluded)_(width|height|depth)_mm$/);
      if (value === null || !match) return [];
      const dimension = dimensionLabel(match[1] as CommerceDimensionAttribute, language);
      const prefix = key.startsWith("excluded_") ? language === "en" ? "exclude" : language === "zh-CN" ? "不接受" : "唔接受" : language === "en" ? "max" : "上限";
      return [`${dimension}${prefix} ${formatMillimetres(value)}mm`];
    });
    const horsepower = clean(entity.attributes.horsepower, 80);
    const details = [horsepower, ...constraints].filter(Boolean);
    return `${entityLabel(entity.entity_id, language)} x${entity.quantity} (${statusLabel(entity.status, language)}${details.length ? `；${details.join("、")}` : ""})`;
  };
  lines.push(`${t.items[language]}: ${active.length ? active.map(renderEntity).join("、") : t.none[language]}`);
  if (inactive.length) lines.push(`${t.removed[language]}: ${inactive.map((e) => `${entityLabel(e.entity_id, language)} (${statusLabel(e.status, language)})`).join("、")}`);
  const delivery = state.delivery;
  const deliveryParts = [delivery.preferred_date, delivery.preferred_window, delivery.address, delivery.recipient_name, delivery.recipient_phone].map((x) => clean(x, 180)).filter(Boolean);
  lines.push(`${t.delivery[language]}: ${deliveryParts.length ? deliveryParts.join(" / ") : t.none[language]}`);
  const pending = [...state.installation.pending_checks, ...state.installation.items.filter((i) => i.status === "pending").map((i) => i.kind)];
  if (pending.length) lines.push(`${t.pending[language]}: ${[...new Set(pending)].map((item) => pendingCheckLabel(item, language)).join("、")}`);
  if (historical.length) lines.push(`${t.quotes[language]}: ${historical.map((q) => `${q.currency} ${q.amount}`).join("、")}`);
  const orderConfirmed = state.conversion.order_status === "confirmed" || state.conversion.order_status === "completed";
  const paymentPaid = state.conversion.payment_status === "paid";
  if (language === "en") {
    lines.push(orderConfirmed ? "Order: confirmed." : "Order: not yet confirmed.");
    lines.push(paymentPaid ? "Payment: received." : "Payment: no confirmed payment on record yet.");
  } else if (language === "zh-CN") {
    lines.push(orderConfirmed ? "订单：已确认。" : "订单：尚未确认。");
    lines.push(paymentPaid ? "付款：已确认收到。" : "付款：目前未有已付款记录。");
  } else {
    lines.push(orderConfirmed ? "訂單：已確認。" : "訂單：尚未確認。");
    lines.push(paymentPaid ? "付款：已確認收到。" : "付款：目前未有已付款記錄。");
  }
  lines.push(t.tail[language]);
  return lines.join("\n");
}

function buildQuantityAnswer(state: ConversationCommerceState, language: CommerceLanguage): string | null {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  if (!active.length) return null;
  const total = active.reduce((sum, e) => sum + e.quantity, 0);
  const breakdown = active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、");
  if (language === "en") return `You currently have ${total} unit(s) in total: ${breakdown}.`;
  if (language === "zh-CN") return `你目前合共 ${total} 个单位：${breakdown}。`;
  return `你而家合共 ${total} 個單位：${breakdown}。`;
}

function buildKnownStateAnswer(language: CommerceLanguage, statePath: string, value: unknown, state: ConversationCommerceState): string {
  if (statePath.startsWith("entities.") && statePath.endsWith(".quantity")) {
    const index = Number(statePath.split(".")[1]);
    const entity = Number.isInteger(index) ? state.entities[index] : null;
    if (entity && entity.status !== "cancelled" && entity.status !== "deferred") {
      const quantity = typeof value === "number" ? value : entity.quantity;
      const label = entityLabel(entity.entity_id, language);
      if (language === "en") return `Your current ${label} quantity is ${quantity}.`;
      if (language === "zh-CN") return `你目前的${label}数量是 ${quantity} 部。`;
      return `你而家嘅${label}數量係 ${quantity} 部。`;
    }
    const answer = buildQuantityAnswer(state, language);
    if (answer) return answer;
  }
  const rendered = typeof value === "object" ? JSON.stringify(value) : clean(String(value), 300);
  if (statePath === "delivery.preferred_date") {
    if (language === "en") return `Your recorded preferred delivery day is ${rendered}.`;
    if (language === "zh-CN") return `目前记录的首选送货日期是${rendered}。`;
    return `而家記錄嘅首選送貨日係${rendered}。`;
  }
  if (language === "en") return `From what you already told me: ${rendered}.`;
  if (language === "zh-CN") return `按你之前提供的资料：${rendered}。`;
  return `按你之前提供嘅資料：${rendered}。`;
}

function buildResolvedEntityStatusChangeAnswer(input: CommerceRuntimeInput, state: ConversationCommerceState): string | null {
  if (!detectCancellation(input.text) && !detectDeferral(input.text)) return null;
  const changed = state.entities.filter((entity) =>
    ["cancelled", "deferred"].includes(entity.status) &&
    entity.provenance.source_message_id === input.source_message_id
  );
  // Only this turn's uniquely resolved entity may bypass clarification.
  if (changed.length !== 1) return null;
  const entity = changed[0];
  const activeQuantity = state.entities.filter((candidate) =>
    candidate.category === entity.category &&
    !["cancelled", "deferred"].includes(candidate.status)
  ).reduce((total, candidate) => total + candidate.quantity, 0);
  const label = entityLabel(entity.entity_id, input.language);
  const status = statusLabel(entity.status, input.language);
  if (input.language === "en") return `${label} is ${status}. The current active quantity is ${activeQuantity}.`;
  if (input.language === "zh-CN") return `${label}${status}；目前有效数量为 ${activeQuantity} 部。`;
  return `${label}${status}；而家有效數量係 ${activeQuantity} 部。`;
}

export function buildResolvedAddressCorrectionAnswer(
  input: CommerceRuntimeInput,
  previous: ConversationCommerceState,
  state: ConversationCommerceState,
): string | null {
  const correction = parseAddressReplacementCorrection(input.text);
  if (!correction || input.semantic_frame?.ambiguity.is_ambiguous === true) return null;
  const address = clean(state.delivery.address, 300);
  if (!address || state.delivery.provenance?.source_message_id !== input.source_message_id) return null;

  if (correction.operation === "SCOPED_COMPONENT_UPDATE") {
    const prior = clean(previous.delivery.address, 300);
    const previousComponent = clean(correction.previous, 180);
    const currentComponent = clean(correction.current, 180);
    if (
      !prior || !previousComponent || !currentComponent ||
      !prior.toLocaleLowerCase().includes(previousComponent.toLocaleLowerCase()) ||
      address === currentComponent || address === prior ||
      !address.toLocaleLowerCase().includes(currentComponent.toLocaleLowerCase())
    ) return null;
  } else if (address !== clean(correction.current, 300)) return null;

  if (input.language === "en") return `I've updated the delivery address to ${address}.`;
  if (input.language === "zh-CN") return `已更新送货地址为${address}。`;
  return `已更新送貨地址為${address}。`;
}

/**
 * Post-commit correction precedence contract.
 *
 * A semantic ambiguity bit is pre-commit advisory data. It may not force a
 * clarification after both canonical stores prove the exact correction was
 * committed for this source message. Conversely, a reply is only resolved when
 * memory and commerce independently bind the same complete value/revision and
 * the previous scoped value is durably superseded.
 */
export function resolveCommittedAddressCorrection(
  input: CommittedAddressCorrectionEvidence,
): CommittedAddressCorrectionResolution | null {
  const correction = parseAddressReplacementCorrection(input.text);
  const memory = input.memory;
  const commerce = input.commerce;
  if (!correction || !memory || !commerce) return null;
  if (
    memory.source_message_id !== input.source_message_id ||
    commerce.source_message_id !== input.source_message_id ||
    memory.commerce_state_revision !== commerce.revision ||
    memory.open_questions.length > 0 ||
    commerce.state.unresolved_items.length > 0
  ) return null;

  const address = clean(commerce.state.delivery.address, 300);
  if (
    !address ||
    commerce.state.delivery.provenance?.source_message_id !==
      input.source_message_id
  ) return null;
  const addressKeys = new Set([
    "address",
    "delivery_address",
    "shipping_address",
    "corrected_delivery_address",
  ]);
  const memoryCurrent = memory.current_customer_facts.find((fact) =>
    addressKeys.has(clean(fact.key, 120)) &&
    clean(fact.value, 300) === address &&
    fact.authority === "canonical_commerce" &&
    fact.source_message_id === input.source_message_id
  );
  if (!memoryCurrent) return null;
  const correctionLedgerMatches = memory.latest_corrections.some((entry) => {
    const parsed = parseAddressReplacementCorrection(entry);
    return Boolean(
      parsed && parsed.operation === correction.operation &&
        clean(parsed.previous, 180) === clean(correction.previous, 180) &&
        clean(parsed.current, 180) === clean(correction.current, 180),
    );
  });
  if (!correctionLedgerMatches) return null;

  const current = clean(correction.current, 180);
  if (correction.operation === "SCOPED_COMPONENT_UPDATE") {
    const previous = clean(correction.previous, 180);
    const superseded = memory.cancelled_or_superseded.some((fact) =>
      fact.key === "superseded_delivery_address" &&
      typeof fact.value === "string" &&
      clean(fact.value, 300).toLocaleLowerCase().includes(
        previous.toLocaleLowerCase(),
      ) &&
      fact.source_message_id !== input.source_message_id
    );
    if (
      !previous || !current || !superseded || address === current ||
      !address.toLocaleLowerCase().includes(current.toLocaleLowerCase()) ||
      address.toLocaleLowerCase().includes(previous.toLocaleLowerCase())
    ) return null;
  } else if (!current || address !== current) return null;

  const reply = input.language === "en"
    ? `I've updated the delivery address to ${address}.`
    : input.language === "zh-CN"
    ? `已更新送货地址为${address}。`
    : `已更新送貨地址為${address}。`;
  return {
    status: "RESOLVED",
    operation: correction.operation,
    address,
    source_message_id: input.source_message_id,
    reply,
    reason: "authoritative_address_correction_resolved",
  };
}

function formatCalculationNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function renderCalculationExpression(calculation: { expression: string; result: number }): string {
  const parsed = calculation.expression.split(" + ").map((part) => {
    const match = part.match(/^[^:]+:([0-9.]+)×([0-9.]+)$/);
    return match ? { value: Number(match[1]), multiplier: Number(match[2]) } : null;
  });
  if (parsed.length && parsed.every(Boolean)) {
    const terms = parsed as Array<{ value: number; multiplier: number }>;
    const multiplier = terms[0].multiplier;
    if (terms.every((term) => term.multiplier === multiplier)) {
      const values = terms.map((term) => formatCalculationNumber(term.value)).join(" + ");
      return `${formatCalculationNumber(multiplier)} × (${values}) = ${formatCalculationNumber(calculation.result)}`;
    }
  }
  return `${calculation.expression} = ${formatCalculationNumber(calculation.result)}`;
}

function buildCalculationAnswer(language: CommerceLanguage, calculation: { expression: string; result: number; currency?: string | null }): string {
  const currency = calculation.currency ?? "HKD";
  const rendered = renderCalculationExpression(calculation);
  if (language === "en") return `Based only on the figures in this calculation: ${rendered} (${currency}). Latest prices, applicable fees and conditions still need to be confirmed.`;
  if (language === "zh-CN") return `只按你这次提供的数字计算：${rendered}（${currency}）。最新价格、适用费用及相关条件仍需确认。`;
  return `按你提供嘅歷史報價試算：${rendered}（${currency}）。呢個唔係現行正式報價；最新價格、適用費用同相關條件仍然要確認。`;
}

function buildProfessionalConfirmationAnswer(language: CommerceLanguage, state: ConversationCommerceState): string {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、") : "";
  if (language === "en") return `${known ? `I still have your details on record: ${known}. ` : ""}For safety and accuracy, our technician needs to inspect the site in person before we can confirm whether the installation is suitable.`;
  if (language === "zh-CN") return `${known ? `我们已保留您之前提供的资料：${known}。` : ""}为确保安全和准确，需要师傅上门检查窗口尺寸、承托及安装环境后再确认是否适合安装。`;
  return `${known ? `我哋已保留您之前提供嘅資料：${known}。` : ""}為確保安全同準確，需要師傅上門檢查窗口尺寸、承托同安裝環境後先可以確認是否適合安裝。`;
}

export function buildCurrentPriceValidityAnswer(language: CommerceLanguage): string {
  if (language === "en") return "Not necessarily. A previous quote is only a reference and does not guarantee the current price. The latest price, applicable fees and relevant conditions need to be confirmed again before they are final.";
  if (language === "zh-CN") return "未必。你之前看到的报价只可作为参考，并不代表目前仍是同一价格。最新价格、适用费用及相关条件需要重新确认后才作准。";
  return "未必。你之前見過嘅報價只可以作參考，唔代表而家仍然係同一個價。最新價格、適用費用同相關條件需要重新確認後先作準。";
}

export function buildPreorderUnpaidAnswer(language: CommerceLanguage, state: ConversationCommerceState): string {
  const active = state.entities.filter((e) => e.status !== "cancelled" && e.status !== "deferred");
  const known = active.length ? active.map((e) => `${entityLabel(e.entity_id, language)} x${e.quantity}`).join("、") : "";
  const nextStep = buildCapabilityAwarePreorderNextStep(state, language);
  if (language === "en") return `${known ? `Got it — you want to reserve ${known}. ` : "Got it — you want to proceed. "}Since payment has not been made yet, this is not a completed or confirmed order. ${nextStep}`;
  if (language === "zh-CN") return `${known ? `好的，我知道你想预订${known}。` : "好的，我知道你想继续预订。"}由于目前还未付款，所以现在还不算已完成或已确认订单。${nextStep}`;
  return `${known ? `好，我知道你想預訂${known}。` : "好，我知道你想繼續預訂。"}因為你仲未付款，所以而家未算完成或已確認訂單。${nextStep}`;
}

export async function runCommerceStateRuntime(
  db: CommerceStateDbClient,
  input: CommerceRuntimeInput,
): Promise<CommerceRuntimeOutcome | null> {
  const text = clean(input.text);
  if (!text || !input.conversation_id || !input.company_id || !input.source_message_id) return null;

  const language = input.language;

  // Bind adapter-extracted scopes against committed context before semantic
  // inference, so ambiguity is read-only and a unique update can win the
  // shared reply precedence without a phrase-specific generate-reply branch.
  const contextualBefore = await loadCommerceState(db, input.conversation_id);
  const contextualDecision = resolveContextualTurn(input, contextualBefore.state);
  if (contextualDecision.route === "targeted_clarification") {
    return {
      authority: "CONVERSATION_STATE", reply: contextualDecision.reply,
      revision: contextualBefore.revision, persist_result: "read_only",
      reason: "contextual_targeted_clarification",
      route: "commerce_state_answer", contextual_decision: contextualDecision,
    };
  }

  // Resolve known scoped/aggregate facts before generic clarification.
  if (detectsConstraintRecall(text) || detectsPortfolioRecall(text) || detectsQuoteReadyRecall(text) || detectsQuoteProvenanceRecall(text) || detectsBrandRequirementRecall(text)) {
    const loaded = await loadCommerceState(db, input.conversation_id);
    if (detectsConstraintRecall(text)) {
      const resolved = buildScopedConstraintAnswer(input, loaded.state);
      if (resolved) return { authority: "CONVERSATION_STATE", reply: resolved.reply, revision: loaded.revision, persist_result: "read_only", reason: "read_only_scoped_constraint_recall_resolved", state_path: resolved.path, route: "commerce_state_answer" };
    }
    if (detectsPortfolioRecall(text) || detectsQuoteReadyRecall(text)) {
      const quoteReady = detectsQuoteReadyRecall(text);
      return { authority: "CONVERSATION_STATE", reply: buildEntityPortfolioAnswer(loaded.state, language, quoteReady), revision: loaded.revision, persist_result: "read_only", reason: quoteReady ? "read_only_quote_ready_entities_resolved" : "read_only_entity_portfolio_resolved", state_path: "commerce.authoritative_projection", route: "commerce_state_answer" };
    }
    if (detectsQuoteProvenanceRecall(text)) return { authority: "CONVERSATION_STATE", reply: buildQuoteProvenanceAnswer(loaded.state, language), revision: loaded.revision, persist_result: "read_only", reason: "read_only_quote_provenance_resolved", state_path: "commerce.authoritative_projection", route: "commerce_state_answer" };
    if (detectsBrandRequirementRecall(text) && typeof loaded.state.customer_constraints.brand_required === "boolean") {
      const required = loaded.state.customer_constraints.brand_required;
      const reply = language === "en" ? required ? "Yes. A specific brand is currently required." : "No. You said a specific brand is not mandatory." : language === "zh-CN" ? required ? "是，目前必须指定品牌。" : "不是，你之前说品牌并非必须指定。" : required ? "係，而家必須指定品牌。" : "唔係，你之前講過品牌並非必須指定。";
      return { authority: "CONVERSATION_STATE", reply, revision: loaded.revision, persist_result: "read_only", reason: "read_only_brand_requirement_resolved", state_path: "customer_constraints.brand_required", route: "commerce_state_answer" };
    }
  }

  // Aggregate technician-check questions resolve from the committed snapshot
  // before generic quantity routing or persistence, so a read cannot create a
  // semantic event or rebind the pending facts' provenance.
  if (isReadOnlyCurrentStateAggregateQuery(text, input.semantic_frame) || /(?:有咩|有什么|what).{0,18}(?:仲未|還沒|还没|未|not yet|outstanding|pending).{0,12}(?:confirm|確認|确认)/i.test(text)) {
    const loaded = await loadCommerceState(db, input.conversation_id);
    const aggregateResolution = resolvePendingCheckAggregateQuery(input, loaded.state, loaded.revision);
    if (aggregateResolution) {
      return { ...aggregateResolution, revision: loaded.revision, persist_result: "read_only", route: "commerce_state_answer" };
    }
  }

  // Dimension/attribute questions must be bound before the generic recall
  // shortcut. Otherwise an article such as "一部598mm" can be mistaken for
  // a quantity target and inherit the first active entity's known quantity.
  if (
    parseCommerceDimensionMeasurement(text) &&
    isReadOnlyCommerceQuestion(text, input.semantic_frame) &&
    !establishesDurableProductResearch(text)
  ) {
    const loaded = await loadCommerceState(db, input.conversation_id);
    const attributeResolution = resolveReadOnlyAttributeConstraintQuery(
      input,
      loaded.state,
    );
    if (attributeResolution) {
      return {
        ...attributeResolution,
        revision: loaded.revision,
        persist_result: "read_only",
        route: "commerce_state_answer",
      };
    }
  }

  if (detectPreorderUnpaidIntent(text)) {
    const loaded = await loadCommerceState(db, input.conversation_id);
    const hasActiveEntity = loaded.state.entities.some(
      (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
    );
    if (hasActiveEntity) {
      return {
        authority: "CONVERSATION_STATE",
        reply: buildPreorderUnpaidAnswer(language, loaded.state),
        revision: loaded.revision,
        persist_result: "read_only",
        reason: "preorder_intent_acknowledged_without_order_or_payment_promotion",
        state_path: "commerce.authoritative_projection",
        route: "commerce_state_answer",
      };
    }
  }

  // READ_ONLY_MEMORY_OR_CURRENT_STATE_RECALL is resolved from the already
  // committed snapshot. Do not call the state RPC: even an identical payload
  // would create a semantic event/revision and could rebind fact provenance to
  // this question rather than the customer turn that supplied the fact.
  if (isReadOnlyMemoryOrCurrentStateRecall(text, input.semantic_frame) && !detectExplicitCalculationRequest(text)) {
    const loaded = await loadCommerceState(db, input.conversation_id);
    const requestedStatePath = compatibleQuantityStatePath(input, loaded.state);
    const decision = resolveCommerceAnswerAuthority({
      question: text,
      state: loaded.state,
      requested_state_path: requestedStatePath,
      calculation_terms: [],
      calculation_currency: null,
      requires_professional_site_check: false,
    });
    if (decision.authority === "CONVERSATION_STATE" && decision.state_path) {
      return {
        authority: decision.authority,
        state_path: decision.state_path,
        reply: buildKnownStateAnswer(
          language,
          decision.state_path,
          decision.known_value,
          loaded.state,
        ),
        revision: loaded.revision,
        persist_result: "read_only",
        reason: "read_only_memory_or_current_state_recall_resolved",
        route: "commerce_state_answer",
      };
    }
    return {
      authority: decision.authority,
      state_path: decision.state_path ?? null,
      reply: null,
      revision: loaded.revision,
      persist_result: "read_only",
      reason: "read_only_memory_or_current_state_recall_unresolved",
      route: "commerce_state_answer",
    };
  }

  const historyTexts = (input.history ?? []).filter((turn) => turn.role === "visitor" || turn.role === "user" || turn.role === "customer").slice(0, MAX_HISTORY_TURNS).map((turn) => clean(turn.content));
  const conversationTexts = [text, ...historyTexts];
  const deterministicHints = buildCommerceEntityHints(conversationTexts);
  const semanticHints = semanticFrameToEntityHints(input.semantic_frame);
  const industry = resolveIndustryRuntime({
    texts: conversationTexts,
    semantic_frame: input.semantic_frame,
    industry_identifier: input.industry_identifier,
  });
  const hints = mergeCommerceEntityHints(
    semanticHints,
    mergeCommerceEntityHints(industry.hints, deterministicHints),
  );
  const runtimeInput = industry.industry_id && !input.industry_identifier
    ? { ...input, industry_identifier: industry.industry_id }
    : input;

  const persisted = await persistCommerceTurn(db, runtimeInput, hints);
  const state = persisted.state;
  if (
    (contextualDecision.route === "product_guidance" ||
      contextualDecision.route === "contextual_scoped_update") &&
    ["success", "no_semantic_change", "source_message_already_applied"].includes(persisted.result)
  ) {
    return {
      authority: "CONVERSATION_STATE",
      reply: contextualDecision.reply,
      revision: persisted.revision,
      persist_result: persisted.result,
      reason: contextualDecision.reason,
      route: contextualDecision.route,
      contextual_decision: contextualDecision,
    };
  }
  const readOnlyCurrentStateQuery = isReadOnlyCurrentStateQuery(
    text,
    input.semantic_frame,
  );

  const summaryIntent = detectTransactionSummaryIntent(text);
  const wantsCalculation = detectExplicitCalculationRequest(text);
  const historicalCalculation = wantsCalculation && calculationExplicitlyUsesHistory(text);
  const calculationTexts = historicalCalculation ? conversationTexts : [text];
  const calculation = wantsCalculation
    ? extractCommerceCalculationTerms(calculationTexts, state, { include_historical_state: historicalCalculation })
    : { terms: [] as CommerceCalculationTerm[], currency: null };
  const decision = resolveCommerceAnswerAuthority({
    question: text,
    state,
    calculation_terms: calculation.terms,
    calculation_currency: calculation.currency,
    requires_professional_site_check: requiresProfessionalSiteCheck(text),
  });

  const base = {
    revision: persisted.revision,
    persist_result: persisted.result,
    reason: decision.authority === "CONVERSATION_STATE" &&
        readOnlyCurrentStateQuery
      ? "read_only_current_state_query_resolved"
      : decision.reason,
  };

  const resolvedStatusChangeReply = persisted.result === "success"
    ? buildResolvedEntityStatusChangeAnswer(runtimeInput, state)
    : null;
  if (resolvedStatusChangeReply) {
    return {
      ...base,
      authority: "CONVERSATION_STATE",
      reason: "explicit_entity_status_change_applied",
      reply: resolvedStatusChangeReply,
      route: "commerce_state_answer",
    };
  }

  const resolvedAddressCorrectionReply = persisted.result === "success"
    ? buildResolvedAddressCorrectionAnswer(runtimeInput, persisted.previous_state, state)
    : null;
  if (resolvedAddressCorrectionReply) {
    return {
      ...base,
      authority: "CONVERSATION_STATE",
      reason: "explicit_address_correction_applied",
      reply: resolvedAddressCorrectionReply,
      route: "commerce_state_answer",
    };
  }

  if (decision.authority === "SAFE_PROFESSIONAL_CONFIRMATION") {
    return { ...base, authority: decision.authority, reply: buildProfessionalConfirmationAnswer(language, state), route: "commerce_state_answer" };
  }

  if (detectPreorderUnpaidIntent(text)) {
    return { ...base, authority: "CONVERSATION_STATE", reason: "preorder_intent_acknowledged_without_order_or_payment_promotion", state_path: "commerce.authoritative_projection", reply: buildPreorderUnpaidAnswer(language, state), route: "commerce_state_answer" };
  }

  if (explicitQuotationOnlySignal(text)) {
    const reply = language === "en"
      ? "Understood. This remains at the quotation stage and is not a confirmed order."
      : language === "zh-CN"
      ? "明白，目前只属报价阶段，不是已确认订单。"
      : "明白，而家只係報價階段，唔係已確認訂單。";
    return { ...base, authority: "CONVERSATION_STATE", reason: "quotation_only_state_acknowledged", state_path: "commerce.authoritative_projection", reply, route: "commerce_state_answer" };
  }

  if (historicalPriceExclusionInstruction(text)) {
    return { ...base, authority: "CONVERSATION_STATE", reason: "historical_price_exclusion_acknowledged", state_path: "commerce.authoritative_projection", reply: buildHistoricalPriceExclusionAnswer(language), route: "commerce_state_answer" };
  }

  if (paymentChecklistIntent(text)) {
    return { ...base, authority: "CONVERSATION_STATE", reason: "payment_checklist_from_current_state", state_path: "commerce.authoritative_projection", reply: buildPaymentChecklist(state, language), route: "commerce_transaction_summary" };
  }

  if (decision.authority === "CONVERSATION_STATE" && decision.state_path) {
    return { ...base, authority: decision.authority, state_path: decision.state_path, reply: buildKnownStateAnswer(language, decision.state_path, decision.known_value, state), route: "commerce_state_answer" };
  }

  if (decision.authority === "DETERMINISTIC_CALCULATION" && decision.calculation) {
    return { ...base, authority: decision.authority, calculation: decision.calculation, reply: buildCalculationAnswer(language, decision.calculation), route: "commerce_state_answer" };
  }

  if (detectCurrentPriceValidityQuestion(text) || asksToReuseRecordedPrice(text, state)) {
    return { ...base, authority: "CURRENT_KB_REQUIRED", reason: "previous_quote_not_authoritative_for_current_price", state_path: "commerce.authoritative_projection", reply: buildCurrentPriceValidityAnswer(language), route: "commerce_state_answer" };
  }

  if (summaryIntent && (state.entities.length > 0 || state.quotes.length > 0)) {
    return { ...base, authority: "CONVERSATION_STATE", reason: "read_only_transaction_summary_resolved", state_path: "commerce.authoritative_projection", reply: buildTransactionSummary(state, language), route: "commerce_transaction_summary" };
  }

  return {
    ...base,
    authority: decision.authority === "CURRENT_KB_REQUIRED" ? "CURRENT_KB_REQUIRED" : decision.authority,
    reply: null,
    route: "commerce_kb_required",
  };
}
