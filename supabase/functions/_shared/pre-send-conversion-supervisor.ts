/**
 * B2 — fail-closed pre-send conversion supervisor.
 *
 * This module is deliberately read-only. It validates a proposed customer
 * response against the latest canonical commerce snapshot, then repeats the
 * tenant/source/revision read immediately before invoking the existing atomic
 * persistence RPC. Only an `allow` decision can reach the callback.
 */

import {
  type CommerceEntity,
  type CommerceQuote,
  type ConversationCommerceState,
  createEmptyConversationCommerceState,
  isConversationCommerceState,
} from "./commerce-state-contract.ts";
import { parseAddressReplacementCorrection } from "./commerce-state-reducer.ts";
import { currentKbSellingPrice, exactKbModelIds } from "./canonical-kb-direct-answer.ts";
import type { ContextualDecision } from "./contextual-customer-update.ts";
import {
  b2JourneyTransactionBoundary,
  type B2TrustedCorrectionCommit,
  type B2TrustedJourneyProgress,
  type B2TrustedLifecycleCommit,
  verifyEntityLifecycleTransition,
} from "./b2-journey-progress-contract.ts";
import { roomSizeCorrection } from "./conversation-long-memory.ts";
import { activeCustomerGoal } from "./customer-journey-orchestration.ts";
import { sameCanonicalJson } from "./canonical-json.ts";

export type B2DecisionKind = "allow" | "block" | "indeterminate";

export type B2PersistenceKind =
  | "ai_reply"
  | "required_escalation_clarification"
  | "required_escalation_handoff"
  | "explicit_handoff"
  | "kb_fallback_handoff"
  | "system_failure_handoff";

export interface B2Decision {
  decision: B2DecisionKind;
  code: string;
  detail?: string;
}
export type B2AuthoritativePersistenceClassification =
  | "COMMITTED"
  | "IDEMPOTENT"
  | "NO_SEMANTIC_CHANGE"
  | "INDETERMINATE";
export interface B2CanonicalSnapshot {
  conversation_id: string;
  company_id: string;
  source_message_id: string;
  source_message_content?: string;
  commerce_state_revision: number;
  commerce_state_source_message_id: string | null;
  state: ConversationCommerceState;
}

export interface B2EvaluationInput {
  proposed_response: string;
  persistence_kind: B2PersistenceKind;
  snapshot: B2CanonicalSnapshot;
  metadata?: Record<string, unknown> | null;
  /** Private server-side evidence, never accepted from a customer request or persisted. */
  trusted_kb_price_proof?: B2KbPriceProof | null;
  /** Private result from the server Commerce runtime, never request metadata. */
  trusted_targeted_clarification?: B2TrustedTargetedClarification | null;
  /** Private Commerce-runtime receipt, never accepted from request metadata. */
  trusted_journey_progress?: B2TrustedJourneyProgress | null;
  trusted_correction_commit?: B2TrustedCorrectionCommit | null;
  trusted_lifecycle_commit?: B2TrustedLifecycleCommit | null;
}

export interface B2TrustedTargetedClarification {
  reply: string;
  revision: number;
  contextual_decision: ContextualDecision;
}

export interface B2KbPriceProof {
  field: "selling_price";
  value: number;
  currency: "HKD";
  model: string;
  document_id: string;
  chunk_id: string;
  tenant_id: string;
  company_id: string;
  currentness: "current";
  authority_decision: "USE_CURRENT_KB";
  request: string;
  full_content: string;
}

export interface B2QueryResult {
  data: unknown;
  error: unknown;
}

export interface B2QueryBuilder {
  select(columns: string): B2QueryBuilder;
  eq(column: string, value: string): B2QueryBuilder;
  maybeSingle(): Promise<B2QueryResult>;
}

export interface B2DatabaseClient {
  from(table: string): B2QueryBuilder;
}

export interface B2PersistenceInput<T> {
  client: B2DatabaseClient;
  conversation_id: string;
  source_message_id: string;
  proposed_response: string;
  persistence_kind: B2PersistenceKind;
  metadata?: Record<string, unknown> | null;
  trusted_kb_price_proof?: B2KbPriceProof | null;
  trusted_targeted_clarification?: B2TrustedTargetedClarification | null;
  trusted_journey_progress?: B2TrustedJourneyProgress | null;
  trusted_correction_commit?: B2TrustedCorrectionCommit | null;
  trusted_lifecycle_commit?: B2TrustedLifecycleCommit | null;
  expected_commerce_state_revision?: number | null;
  commit: (snapshot: B2CanonicalSnapshot) => Promise<T>;
}

export type B2PersistenceResult<T> =
  | {
      committed: true;
      decision: B2Decision;
      snapshot: B2CanonicalSnapshot;
      value: T;
    }
  | {
      committed: false;
      decision: B2Decision;
      snapshot?: B2CanonicalSnapshot;
    };

const CURRENT_PRICE_CLAIM =
  /(?:current|latest|today(?:'s)?|now|而家|現在|现在|目前|最新).{0,36}(?:price|quote|quotation|fee|價|价|報價|报价|收費|收费)|(?:price|quote|quotation|fee|價|价|報價|报价|收費|收费).{0,36}(?:current|latest|valid|confirmed|final|而家|現在|现在|目前|最新|有效|作準|作准|確認|确认)/i;
const QUESTION =
  /[?？]|(?:what|which|when|where|who|how|please (?:tell|provide|confirm)|請問|请问|邊個|边个|邊度|边度|幾多|几多|多少|是否|係咪|是不是|請提供|请提供|請確認|请确认)/i;
const RESTORE_OR_ACTIVE =
  /(?:restore|reinstate|put .{0,20} back|add .{0,20} back|proceed|continue|keep|include|remains? in|active|confirmed|安排|繼續|继续|照舊|照旧|保留|重新加入|加返|放返|仍然包括|仍包括|確認要|确认要|會處理|会处理)/i;
const ORDER_CONFIRMED =
  /(?:order (?:is |has been )?(?:confirmed|completed|placed)|confirmed order|訂單已確認|订单已确认|已確認訂單|已确认订单|已落單|已下单|落單完成|下单完成)/i;
const PAYMENT_COMPLETED =
  /(?:payment (?:is |has been )?(?:paid|received|completed|processed)|paid in full|付款已完成|付款完成|已付款|已收到付款|支付完成)/i;
const DELIVERY_CONFIRMED =
  /(?:delivery (?:is |has been )?(?:confirmed|arranged|scheduled)|送貨已確認|送货已确认|已安排送貨|已安排送货|送貨安排已確認|送货安排已确认)/i;
const DELIVERY_COMPLETED =
  /(?:delivery (?:is |has been )?(?:completed|delivered|fulfilled)|successfully delivered|送貨已完成|送货已完成|已送達|已送达|已經送貨|已经送货|派送完成)/i;
const INSTALLATION_CONFIRMED =
  /(?:installation (?:is |has been )?(?:confirmed|arranged|scheduled)|安裝已確認|安装已确认|已安排安裝|已安排安装|安裝安排已確認|安装安排已确认)/i;
const INSTALLATION_COMPLETED =
  /(?:installation (?:is |has been )?(?:completed|installed|finished|executed)|successfully installed|安裝已完成|安装已完成|已經安裝|已经安装|安裝完成|安装完成)/i;
const GENERIC_COMPLETION =
  /(?:action|request|operation|process|booking|reservation).{0,24}(?:completed|processed|executed|done|finished)|(?:completed|processed|executed|done|finished).{0,24}(?:action|request|operation|process|booking|reservation)|(?:操作|動作|动作|請求|请求|流程|程序|預約|预约).{0,20}(?:已完成|完成咗|完成了|已執行|已执行|已處理|已处理)/i;

function clean(value: unknown, max = 65_536): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return clean(value, 300) || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return null;
}

function aliasesForKey(key: string): string[] {
  const normalized = key
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase();
  const aliases = new Set([normalized, key.toLowerCase()]);
  const common: Record<string, string[]> = {
    address: ["address", "delivery address", "地址", "送貨地址", "送货地址"],
    recipient_name: ["recipient", "recipient name", "收貨人", "收货人"],
    recipient_phone: [
      "phone",
      "contact number",
      "telephone",
      "電話",
      "电话",
      "聯絡號碼",
      "联络号码",
    ],
    preferred_date: ["delivery date", "date", "送貨日期", "送货日期", "日期"],
    preferred_window: ["delivery time", "time slot", "送貨時間", "送货时间", "時段", "时段"],
    confirmed: ["confirmed", "confirmation", "確認", "确认"],
    quantity: ["quantity", "how many", "數量", "数量", "幾多", "几多"],
    brand: ["brand", "品牌"],
    category: ["category", "product type", "產品類型", "产品类型", "產品種類", "产品种类"],
    room_sizes: ["room sizes", "room areas", "房間面積", "房间面积", "各空間面積", "各空间面积"],
    installation_type: ["installation type", "installation arrangement", "安裝方式", "安装方式", "窗口位", "分體位", "分体位"],
    model: ["model", "model number", "型號", "型号"],
    amount: ["amount", "price", "quote", "價錢", "价钱", "報價", "报价"],
    currency: ["currency", "幣別", "币别", "貨幣", "货币"],
    quote_type: ["quote type", "quotation type", "報價類型", "报价类型"],
    validity_status: ["quote validity", "validity", "報價有效狀態", "报价有效状态"],
    current_intent: ["intent", "current intent", "目的", "意圖", "意图"],
    current_topic: ["topic", "current topic", "主題", "主题"],
    current_industry: ["industry", "行業", "行业"],
    unresolved_items: ["unresolved", "outstanding item", "待處理", "待处理", "未解決", "未解决"],
    funnel_stage: ["stage", "funnel stage", "階段", "阶段"],
    quotation_status: ["quotation status", "quote status", "報價狀態", "报价状态"],
    order_status: ["order status", "訂單狀態", "订单状态"],
    payment_status: ["payment status", "付款狀態", "付款状态", "支付狀態", "支付状态"],
    kind: ["installation item", "installation type", "安裝項目", "安装项目"],
    status: ["status", "狀態", "状态"],
  };
  const leaf = key.split(/[._-]/).at(-1) ?? key;
  for (const item of common[leaf] ?? []) aliases.add(item.toLowerCase());
  const semanticKey = key.replace(/[.\s-]+/g, "_").toLowerCase();
  for (const item of common[semanticKey] ?? []) aliases.add(item.toLowerCase());
  return [...aliases].filter((item) => item.length >= 2);
}

interface KnownFact {
  path: string;
  value: string;
  aliases: string[];
}

function addFact(facts: KnownFact[], path: string, value: unknown): void {
  const rendered = scalarText(value);
  if (!rendered) return;
  facts.push({
    path,
    value: rendered,
    aliases: [...new Set([...aliasesForKey(path), ...aliasesForKey(rendered)])],
  });
}

function addRecordFacts(facts: KnownFact[], prefix: string, value: Record<string, unknown>): void {
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) addRecordFacts(facts, `${prefix}.${key}`, item);
    else if (Array.isArray(item)) {
      item.forEach((entry, index) =>
        isRecord(entry)
          ? addRecordFacts(facts, `${prefix}.${key}.${index}`, entry)
          : addFact(facts, `${prefix}.${key}.${index}`, entry)
      );
    }
    else addFact(facts, `${prefix}.${key}`, item);
  }
}

export function collectKnownCommerceFacts(state: ConversationCommerceState): KnownFact[] {
  const facts: KnownFact[] = [];
  addFact(facts, "current_intent", state.current_intent);
  addFact(facts, "current_topic", state.current_topic);
  addFact(facts, "current_industry", state.current_industry);
  state.unresolved_items.forEach((item, index) =>
    addFact(facts, `unresolved_items.${index}`, item),
  );
  addRecordFacts(facts, "customer_constraints", state.customer_constraints);
  state.entities.forEach((entity, index) => {
    addFact(facts, `entities.${index}.category`, entity.category);
    addFact(facts, `entities.${index}.brand`, entity.brand);
    addFact(facts, `entities.${index}.model`, entity.model);
    addFact(facts, `entities.${index}.quantity`, entity.quantity);
    addFact(facts, `entities.${index}.status`, entity.status);
    addRecordFacts(facts, `entities.${index}.attributes`, entity.attributes);
    addRecordFacts(facts, `entities.${index}.constraints`, entity.constraints);
  });
  state.quotes.forEach((quote, index) => {
    addFact(facts, `quotes.${index}.amount`, quote.amount);
    addFact(facts, `quotes.${index}.currency`, quote.currency);
    addFact(facts, `quotes.${index}.quote_type`, quote.quote_type);
    addFact(facts, `quotes.${index}.validity_status`, quote.validity_status);
    addRecordFacts(facts, `quotes.${index}.conditions`, quote.conditions);
  });
  addFact(facts, "delivery.preferred_date", state.delivery.preferred_date);
  addFact(facts, "delivery.preferred_window", state.delivery.preferred_window);
  addFact(facts, "delivery.address", state.delivery.address);
  addFact(facts, "delivery.recipient_name", state.delivery.recipient_name);
  addFact(facts, "delivery.recipient_phone", state.delivery.recipient_phone);
  addFact(facts, "delivery.confirmed", state.delivery.confirmed);
  addRecordFacts(facts, "installation.site_conditions", state.installation.site_conditions);
  state.installation.pending_checks.forEach((item, index) =>
    addFact(facts, `installation.pending_checks.${index}`, item),
  );
  state.installation.items.forEach((item, index) => {
    addFact(facts, `installation.items.${index}.kind`, item.kind);
    addFact(facts, `installation.items.${index}.status`, item.status);
    addRecordFacts(facts, `installation.items.${index}.details`, item.details);
  });
  addFact(facts, "conversion.funnel_stage", state.conversion.funnel_stage);
  addFact(facts, "conversion.quotation_status", state.conversion.quotation_status);
  addFact(facts, "conversion.order_status", state.conversion.order_status);
  addFact(facts, "conversion.payment_status", state.conversion.payment_status);
  return facts;
}

export function classifyCommerceStatePersistenceResult(
  result: unknown,
): B2AuthoritativePersistenceClassification {
  switch (clean(result, 120)) {
    case "success":
    case "authoritative_post_commit_readback":
      return "COMMITTED";
    case "idempotent":
    case "source_message_already_applied":
      return "IDEMPOTENT";
    case "read_only":
    case "no_semantic_change":
      return "NO_SEMANTIC_CHANGE";
    default:
      return "INDETERMINATE";
  }
}

export function buildB2AuthoritativeReadbackProof(
  state: ConversationCommerceState,
  statePath: string,
): Record<string, unknown> | null {
  const path = clean(statePath, 240);
  if (path === "commerce.authoritative_projection") {
    return {
      state_path: path,
      entities: state.entities.map((entity) => ({
        entity_id: entity.entity_id,
        quantity: entity.quantity,
        status: entity.status,
        attributes: entity.attributes,
        constraints: entity.constraints,
      })),
      delivery: state.delivery,
      installation: state.installation,
      conversion: state.conversion,
      quotes: state.quotes,
      customer_constraints: state.customer_constraints,
      unresolved_items: state.unresolved_items,
      latest_corrections: state.latest_corrections,
    };
  }
  if (path === "installation.pending_checks") {
    return {
      state_path: path,
      values: [...state.installation.pending_checks],
      count: state.installation.pending_checks.length,
    };
  }
  const fact = collectKnownCommerceFacts(state).find((item) => item.path === path);
  return fact ? { state_path: path, value: fact.value } : null;
}

/**
 * A read-only commerce answer has no mutation receipt by design. It may only
 * recover an otherwise indeterminate B2 evaluation when the authoritative
 * snapshot proves the exact revision, active state path, and rendered value.
 * Transport/readback failures and snapshot drift remain fail-closed.
 */
export function classifyB2AuthoritativePersistence(
  input: B2EvaluationInput,
): B2AuthoritativePersistenceClassification {
  const metadata = input.metadata;
  if (!isRecord(metadata)) return "INDETERMINATE";
  const classification = classifyCommerceStatePersistenceResult(
    metadata.commerce_state_persist_result,
  );
  if (
    metadata.commerce_state_persistence_classification !== classification ||
    Number(metadata.commerce_state_revision) !== input.snapshot.commerce_state_revision
  ) return "INDETERMINATE";
  if (classification !== "NO_SEMANTIC_CHANGE") {
    return input.snapshot.commerce_state_source_message_id ===
        input.snapshot.source_message_id
      ? classification
      : "INDETERMINATE";
  }
  if (
    !["commerce_state_answer", "commerce_transaction_summary"].includes(
      clean(metadata.response_route, 120),
    ) ||
    ![
      "CONVERSATION_STATE",
      "DETERMINISTIC_CALCULATION",
      "SAFE_PROFESSIONAL_CONFIRMATION",
      "CURRENT_KB_REQUIRED",
    ].includes(clean(metadata.commerce_authority, 120))
  ) return "INDETERMINATE";

  const statePath = clean(metadata.commerce_state_path, 240);
  const expectedProof = buildB2AuthoritativeReadbackProof(input.snapshot.state, statePath);
  if (
    !expectedProof ||
    JSON.stringify(metadata.commerce_state_readback_proof) !==
      JSON.stringify(expectedProof)
  ) return "INDETERMINATE";

  if (statePath === "installation.pending_checks") {
    const values = input.snapshot.state.installation.pending_checks;
    const response = clean(input.proposed_response);
    const claimedCount = response.match(/(?:^|\D)(\d{1,4})\s*(?:項|项|items?|checks?)/i);
    if (!claimedCount || Number(claimedCount[1]) !== values.length) {
      return "INDETERMINATE";
    }
    return "NO_SEMANTIC_CHANGE";
  }

  if (statePath === "commerce.authoritative_projection") {
    return "NO_SEMANTIC_CHANGE";
  }

  const fact = collectKnownCommerceFacts(input.snapshot.state).find((item) => item.path === statePath);
  if (!fact || !clean(input.proposed_response).includes(fact.value)) return "INDETERMINATE";

  const quantityPath = statePath.match(/^entities\.(\d+)\.quantity$/);
  if (quantityPath) {
    const entity = input.snapshot.state.entities[Number(quantityPath[1])];
    if (!entity || entity.status === "cancelled" || entity.status === "deferred") {
      return "INDETERMINATE";
    }
    const claimedQuantities = [...clean(input.proposed_response).matchAll(
      /([0-9]{1,4})\s*(?:部|台|件|個|个|套|units?|items?)/gi,
    )].map((match) => Number(match[1]));
    if (claimedQuantities.length !== 1 || claimedQuantities[0] !== Number(fact.value)) {
      return "INDETERMINATE";
    }
  }
  return "NO_SEMANTIC_CHANGE";
}

function entityAliases(entity: CommerceEntity): string[] {
  const values = [entity.entity_id, entity.category, entity.brand, entity.model];
  for (const key of ["product_name", "display_name", "name", "sku"]) {
    values.push(scalarText(entity.attributes[key]));
  }
  return [...new Set(values.map(lower).filter((item) => item.length >= 2))];
}

function mentionedEntityIds(text: string, state: ConversationCommerceState): string[] {
  const candidate = lower(text);
  return state.entities
    .filter((entity) => entityAliases(entity).some((alias) => candidate.includes(alias)))
    .map((entity) => entity.entity_id);
}

interface MoneyMention {
  amount: number;
  currency: string | null;
}

function extractMoneyMentions(text: string): MoneyMention[] {
  const results: MoneyMention[] = [];
  const pattern =
    /(?:\b(HKD|USD|TWD)\b\s*|((?:HK|US|NT)\$|\$)\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{1,10})(?:\.([0-9]{1,2}))?\s*(元|蚊|dollars?)?/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    // Model identifiers and measurements are never prices, even when a
    // selling-price sentence appears nearby in the same short response.
    if (/[A-Za-z0-9]/.test(text[match.index - 1] ?? "") ||
      /[A-Za-z]/.test(text[match.index + match[0].length] ?? "")) continue;
    // Fractions and room measurements remain measurements even in a reply
    // that also cites a KB selling price (for example 3/4匹 and 80呎).
    if (!match[1] && !match[2] && !match[5] &&
      (text[match.index - 1] === "/" || text[match.index + match[0].length] === "/" ||
        /^\s*(?:平方[呎尺]|[呎尺]|sq\.?\s*ft|square\s*feet|BTU(?:\/h)?)/iu.test(text.slice(match.index + match[0].length)))) continue;
    const amount = Number(`${match[3].replace(/,/g, "")}${match[4] ? `.${match[4]}` : ""}`);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const marker = `${match[1] ?? ""}${match[2] ?? ""}${match[5] ?? ""}`.toUpperCase();
    const ordinal = !marker && amount <= 99 && /^\s*[.)、。]/.test(text.slice(match.index + match[0].length));
    if (ordinal) continue;
    // Bare measurements, quantities, dates and model numbers are not money.
    // Keep an unmarked number only when the response itself makes a monetary
    // claim; quote evaluation will still fail closed when currency is absent.
    const localContext = text.slice(Math.max(0, match.index - 80), Math.min(text.length, match.index + match[0].length + 80));
    const hasLocalMoneyContext = /(?:price|quote|quotation|amount|fee|cost|dollars?|價|价|報價|报价|收費|收费|金額|金额|費用|费用)/i.test(localContext);
    if (!marker && /^(?:匹|HP|P|cm|mm|kg|吋|瓦|年)/i.test(text.slice(match.index + match[0].length).trimStart())) continue;
    if (!marker && !hasLocalMoneyContext) continue;
    const currency =
      marker.includes("USD") || marker.includes("US$")
        ? "USD"
        : marker.includes("TWD") || marker.includes("NT$")
          ? "TWD"
          : marker.includes("HKD") ||
              marker.includes("HK$") ||
              marker.includes("$") ||
              /元|蚊/.test(marker)
            ? "HKD"
            : null;
    results.push({ amount, currency });
  }
  return results;
}

function quoteMatchesClaim(
  quote: CommerceQuote,
  money: MoneyMention,
  mentioned: string[],
): boolean {
  if (quote.quote_type !== "current_verified" || quote.validity_status !== "current") return false;
  if (quote.amount !== money.amount) return false;
  if (!money.currency || quote.currency.toUpperCase() !== money.currency) return false;
  if (quote.entity_id) return mentioned.includes(String(quote.entity_id));
  return mentioned.length === 0;
}

function evaluateCurrentKbSellingPrice(input: B2EvaluationInput, draft: string): B2Decision {
  const block = (code: string): B2Decision => ({ decision: "block", code });
  const proof = input.trusted_kb_price_proof;
  const metadata = input.metadata;
  if (input.persistence_kind !== "ai_reply" || !proof || !isRecord(metadata) ||
    metadata.response_route !== "canonical_kb_direct_answer" || metadata.answer_kind !== "price") {
    return block("CURRENT_KB_PRICE_PROOF_MISSING");
  }
  const authority = metadata.reference_authority;
  const provenance = isRecord(authority) ? authority.provenance : null;
  const lineage = metadata.citation_lineage;
  const citations = metadata.citations;
  const publicProof = metadata.kb_fact_proof;
  const { full_content, request, company_id, ...publicFields } = proof;
  if (!isRecord(authority) || !isRecord(provenance) || !isRecord(lineage) ||
    !Array.isArray(citations) || citations.length !== 1 || !isRecord(citations[0]) ||
    !isRecord(publicProof) ||
    JSON.stringify(publicProof) !== JSON.stringify(publicFields) ||
    proof.field !== "selling_price" || proof.currency !== "HKD" ||
    proof.authority_decision !== "USE_CURRENT_KB" || proof.currentness !== "current" ||
    authority.decision !== "USE_CURRENT_KB" || provenance.currentness !== "current" ||
    provenance.region !== "hong_kong" || provenance.tenant_id !== proof.tenant_id ||
    authority.selected_source_id !== proof.document_id ||
    company_id !== input.snapshot.company_id || !proof.tenant_id ||
    lineage.selected_document_id !== proof.document_id || lineage.evidence_count !== 1 ||
    lineage.authority_decision !== "USE_CURRENT_KB" || lineage.evidence_state !== "current" ||
    !Array.isArray(lineage.evidence_chunk_ids) || lineage.evidence_chunk_ids.length !== 1 ||
    lineage.evidence_chunk_ids[0] !== proof.chunk_id ||
    citations[0].document_id !== proof.document_id || citations[0].chunk_id !== proof.chunk_id ||
    citations[0].chunk_type !== "full_content" ||
    citations[0].authority_decision !== "USE_CURRENT_KB" || citations[0].evidence_state !== "current") {
    return block("CURRENT_KB_PRICE_LINEAGE_INVALID");
  }
  const model = exactKbModelIds(request);
  const target = isRecord(lineage.current_target) ? lineage.current_target : null;
  const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const modelKey = normalized(proof.model);
  const suffixKey = normalized(proof.model.split("-").at(-1) ?? "");
  if (model.length !== 1 || model[0] !== proof.model ||
    !exactKbModelIds(full_content).includes(proof.model) ||
    !target || !Array.isArray(target.entity_ids) ||
    !target.entity_ids.some((id) => typeof id === "string" &&
      [modelKey, suffixKey].includes(normalized(id))) ||
    currentKbSellingPrice(full_content) !== proof.value ||
    !Number.isFinite(proof.value) || proof.value <= 0) {
    return block("CURRENT_KB_PRICE_FACT_MISMATCH");
  }
  const money = extractMoneyMentions(draft);
  const exactPrice = `HK$${proof.value.toLocaleString("en-US")}`;
  if (money.length !== 1 || money[0].currency !== "HKD" ||
    money[0].amount !== proof.value || !draft.includes(exactPrice) ||
    /(?:成本|特價|特价|cost|special\s*price|有現貨|有现货|in stock)/i.test(draft)) {
    return block("CURRENT_KB_PRICE_RESPONSE_MISMATCH");
  }
  return { decision: "allow", code: "B2_ALLOW_CURRENT_KB_SELLING_PRICE" };
}

function evaluateQuoteReality(text: string, state: ConversationCommerceState, input: B2EvaluationInput): B2Decision | null {
  if (input.metadata?.response_route === "canonical_kb_direct_answer" &&
    input.metadata.answer_kind === "price" || input.trusted_kb_price_proof) {
    const result = evaluateCurrentKbSellingPrice(input, text);
    return result.decision === "allow" ? null : result;
  }
  if (!CURRENT_PRICE_CLAIM.test(text)) return null;
  if (/(?:checklist|清單|清单)|(?:核實|核对|核對|verify|confirm).{0,24}(?:price|quote|quotation|價|价|報價|报价)/i.test(text)) return null;
  if (/(?:(?:報價|报价|quotation)\s*(?:階段|阶段|stage)).{0,30}(?:唔係|不是|not).{0,12}(?:已確認|已确认|confirmed)?\s*(?:訂單|订单|order)/i.test(text)) return null;
  if (/(?:does not guarantee|not (?:a )?(?:current|confirmed|final) price|need(?:s)? to be confirmed|未必|不代表.{0,20}(?:現價|现价|同一個價|同一个价)|(?:最新價格|最新价格|current price).{0,30}(?:要|需|must|need).{0,20}(?:確認|确认|confirm))/i.test(text)) return null;
  const money = extractMoneyMentions(text);
  if (money.length === 0) {
    return { decision: "block", code: "CURRENT_QUOTE_WITHOUT_VERIFIED_AMOUNT" };
  }
  const mentioned = mentionedEntityIds(text, state);
  for (const item of money) {
    if (!state.quotes.some((quote) => quoteMatchesClaim(quote, item, mentioned))) {
      return {
        decision: "block",
        code: "CURRENT_QUOTE_NOT_PROVEN",
        detail: `${item.currency ?? "currency_unknown"}:${item.amount}`,
      };
    }
  }
  return null;
}

function evaluateTransactionReality(
  text: string,
  kind: B2PersistenceKind,
  state: ConversationCommerceState,
): B2Decision | null {
  if (DELIVERY_COMPLETED.test(text)) {
    return {
      decision: "block",
      code: "DELIVERY_COMPLETION_NOT_CANONICALLY_PROVABLE",
    };
  }
  if (INSTALLATION_COMPLETED.test(text)) {
    return {
      decision: "block",
      code: "INSTALLATION_COMPLETION_NOT_CANONICALLY_PROVABLE",
    };
  }
  if (DELIVERY_CONFIRMED.test(text) && state.delivery.confirmed !== true) {
    return { decision: "block", code: "DELIVERY_CONFIRMATION_NOT_PROVEN" };
  }
  if (
    INSTALLATION_CONFIRMED.test(text) &&
    !state.installation.items.some((item) => item.status === "confirmed")
  ) {
    return { decision: "block", code: "INSTALLATION_CONFIRMATION_NOT_PROVEN" };
  }
  const orderConfirmationNegated = /(?:未有|沒有|没有|冇|尚未|還未|还未|唔係|不是|not|no).{0,24}(?:已確認|已确认|confirmed)?\s*(?:訂單|订单|order)/i.test(text);
  if (
    ORDER_CONFIRMED.test(text) && !orderConfirmationNegated &&
    state.conversion.order_status !== "confirmed" &&
    state.conversion.order_status !== "completed"
  ) {
    return { decision: "block", code: "ORDER_CONFIRMATION_NOT_PROVEN" };
  }
  const paymentCompletionNegated = /(?:未有|沒有|没有|冇|尚未|還未|还未|not|no).{0,24}(?:已付款|付款完成|payment.{0,8}(?:paid|received|completed)|paid)/i.test(text);
  if (PAYMENT_COMPLETED.test(text) && !paymentCompletionNegated && state.conversion.payment_status !== "paid") {
    return { decision: "block", code: "PAYMENT_COMPLETION_NOT_PROVEN" };
  }
  if (GENERIC_COMPLETION.test(text)) {
    const atomicHandoff =
      kind === "required_escalation_handoff" ||
      kind === "explicit_handoff" ||
      kind === "kb_fallback_handoff" ||
      kind === "system_failure_handoff";
    if (!atomicHandoff) {
      return { decision: "block", code: "ACTION_COMPLETION_NOT_PROVEN" };
    }
  }
  return null;
}

function evaluateKnownContext(text: string, state: ConversationCommerceState): B2Decision | null {
  if (!QUESTION.test(text)) return null;
  const questionClauses = text
    .split(/(?<=[?？.!！。])|\n+/)
    .map(lower)
    .filter((clause) => QUESTION.test(clause));
  for (const clause of questionClauses) {
    for (const fact of collectKnownCommerceFacts(state)) {
      if (fact.aliases.some((alias) => clause.includes(alias))) {
        return {
          decision: "block",
          code: "KNOWN_CONTEXT_RECONFIRMATION",
          detail: fact.path,
        };
      }
    }
  }
  return null;
}

function isTrustedTargetedReadOnlyClarification(input: B2EvaluationInput, draft: string): boolean {
  const proof = input.trusted_targeted_clarification;
  const metadata = input.metadata;
  if (!proof || !isRecord(metadata) || input.persistence_kind !== "ai_reply") return false;
  const decision = proof.contextual_decision;
  return metadata.response_route === "commerce_state_answer" &&
    metadata.commerce_reason === "contextual_targeted_clarification" &&
    metadata.commerce_state_persist_result === "read_only" &&
    metadata.commerce_state_persistence_classification === "NO_SEMANTIC_CHANGE" &&
    metadata.commerce_state_revision === input.snapshot.commerce_state_revision &&
    proof.revision === input.snapshot.commerce_state_revision &&
    decision.route === "targeted_clarification" && decision.updates.length === 0 &&
    JSON.stringify(metadata.contextual_decision) === JSON.stringify(decision) &&
    clean(proof.reply) === draft && clean(decision.reply) === draft &&
    !metadata.commerce_state_path && !metadata.commerce_state_readback_proof &&
    !metadata.commerce_calculation && !metadata.correction_resolution &&
    !metadata.correction_operation && !metadata.correction_source_message_id &&
    !ORDER_CONFIRMED.test(draft) && !PAYMENT_COMPLETED.test(draft) &&
    !DELIVERY_CONFIRMED.test(draft) && !DELIVERY_COMPLETED.test(draft) &&
    !INSTALLATION_CONFIRMED.test(draft) && !INSTALLATION_COMPLETED.test(draft) &&
    !GENERIC_COMPLETION.test(draft) && !CURRENT_PRICE_CLAIM.test(draft) &&
    extractMoneyMentions(draft).length === 0;
}

function equalJson(left: unknown, right: unknown): boolean {
  return sameCanonicalJson(left, right);
}

function isTrustedCorrectionCommit(input: B2EvaluationInput, draft: string): boolean {
  const proof = input.trusted_correction_commit;
  const metadata = input.metadata;
  if (!proof || !isRecord(metadata) || input.persistence_kind !== "ai_reply") return false;
  const parsed = roomSizeCorrection(input.snapshot.source_message_content ?? "");
  if (!parsed || proof.contract !== "scoped-correction-commit-v1" ||
    proof.field !== "room_size" || proof.category !== "air_conditioner" ||
    !(
      proof.scope === "large_bedroom" && /(?:大房|large\s*bedroom)/i.test(parsed.label) ||
      proof.scope === "small_bedroom" && /(?:細房|细房|小房|small\s*bedroom)/i.test(parsed.label) ||
      proof.scope === "living_room" && /(?:客廳|客厅|個廳|个厅|living\s*room)/i.test(parsed.label)
    ) ||
    proof.company_id !== input.snapshot.company_id ||
    proof.source_message_id !== input.snapshot.source_message_id ||
    clean(proof.source_text) !== clean(input.snapshot.source_message_content) ||
    proof.correction !== clean(input.snapshot.source_message_content) ||
    proof.previous_value !== parsed.old_value || proof.current_value !== parsed.new_value ||
    proof.previous_revision + 1 !== proof.committed_revision ||
    proof.committed_revision !== input.snapshot.commerce_state_revision ||
    input.snapshot.commerce_state_source_message_id !== proof.source_message_id ||
    proof.previous_values[proof.scope] !== proof.previous_value ||
    proof.committed_values[proof.scope] !== proof.current_value ||
    Object.keys(proof.previous_values).length !== Object.keys(proof.committed_values).length ||
    Object.keys(proof.previous_values).some((key) =>
      key !== proof.scope && proof.previous_values[key] !== proof.committed_values[key]
    ) ||
    !input.snapshot.state.latest_corrections.includes(proof.correction) ||
    !equalJson(proof.transaction_before, proof.transaction_after) ||
    !equalJson(proof.transaction_after, b2JourneyTransactionBoundary(input.snapshot.state)) ||
    clean(proof.reply) !== draft ||
    metadata.response_route !== "commerce_state_answer" ||
    metadata.commerce_reason !== "authoritative_scoped_correction_applied" ||
    metadata.commerce_authority !== "CONVERSATION_STATE" ||
    metadata.commerce_state_persist_result !== "success" ||
    metadata.commerce_state_persistence_classification !== "COMMITTED" ||
    Number(metadata.commerce_state_revision) !== proof.committed_revision ||
    ORDER_CONFIRMED.test(draft) || PAYMENT_COMPLETED.test(draft) ||
    DELIVERY_CONFIRMED.test(draft) || DELIVERY_COMPLETED.test(draft) ||
    INSTALLATION_CONFIRMED.test(draft) || INSTALLATION_COMPLETED.test(draft) ||
    extractMoneyMentions(draft).length > 0) return false;
  const entity = input.snapshot.state.entities.filter((candidate) =>
    candidate.category === proof.category &&
    candidate.status !== "cancelled" && candidate.status !== "deferred"
  );
  return entity.length === 1 && entity[0].entity_id === proof.entity_id &&
    equalJson(entity[0].attributes.room_sizes, proof.committed_values);
}

function isTrustedLifecycleCommit(input: B2EvaluationInput, draft: string): boolean {
  const proof = input.trusted_lifecycle_commit;
  const metadata = input.metadata;
  if (!proof || !isRecord(metadata) || input.persistence_kind !== "ai_reply" ||
    proof.contract !== "entity-lifecycle-commit-v1" ||
    proof.company_id !== input.snapshot.company_id ||
    proof.source_message_id !== input.snapshot.source_message_id ||
    clean(proof.source_text) !== clean(input.snapshot.source_message_content) ||
    proof.previous_revision + 1 !== proof.committed_revision ||
    proof.committed_revision !== input.snapshot.commerce_state_revision ||
    input.snapshot.commerce_state_source_message_id !== proof.source_message_id ||
    !equalJson(proof.committed_state, input.snapshot.state) ||
    !equalJson(proof.transaction_before, b2JourneyTransactionBoundary(proof.previous_state)) ||
    !equalJson(proof.transaction_after, b2JourneyTransactionBoundary(input.snapshot.state)) ||
    !equalJson(proof.transaction_before, proof.transaction_after) ||
    clean(proof.reply) !== draft ||
    metadata.response_route !== "commerce_state_answer" ||
    metadata.commerce_reason !== "authoritative_scoped_lifecycle_applied" ||
    metadata.commerce_authority !== "CONVERSATION_STATE" ||
    metadata.commerce_state_persist_result !== "success" ||
    metadata.commerce_state_persistence_classification !== "COMMITTED" ||
    Number(metadata.commerce_state_revision) !== proof.committed_revision ||
    ORDER_CONFIRMED.test(draft) || PAYMENT_COMPLETED.test(draft) ||
    DELIVERY_CONFIRMED.test(draft) || DELIVERY_COMPLETED.test(draft) ||
    INSTALLATION_CONFIRMED.test(draft) || INSTALLATION_COMPLETED.test(draft) ||
    extractMoneyMentions(draft).length > 0) return false;
  const transition = verifyEntityLifecycleTransition(proof.source_text, proof.previous_state,
    input.snapshot.state, proof.source_message_id);
  return transition.valid && equalJson(transition.plans, proof.plans) &&
    equalJson(transition.targetIds, proof.target_entity_ids);
}

function isTrustedJourneyProgressAfterAcceptedUpdate(
  input: B2EvaluationInput,
  draft: string,
): boolean {
  const proof = input.trusted_journey_progress;
  const metadata = input.metadata;
  if (!proof || !isRecord(metadata) || input.persistence_kind !== "ai_reply") return false;
  if (
    proof.contract !== "journey-progress-after-accepted-update-v1" ||
    proof.company_id !== input.snapshot.company_id ||
    proof.source_message_id !== input.snapshot.source_message_id ||
    clean(proof.source_text) !== clean(input.snapshot.source_message_content) ||
    proof.committed_revision !== input.snapshot.commerce_state_revision ||
    proof.previous_revision + 1 !== proof.committed_revision ||
    input.snapshot.commerce_state_source_message_id !== proof.source_message_id ||
    clean(proof.reply) !== draft ||
    metadata.response_route !== proof.response_route ||
    metadata.commerce_reason !== proof.response_reason ||
    metadata.commerce_authority !== "CONVERSATION_STATE" ||
    metadata.commerce_state_persist_result !== "success" ||
    metadata.commerce_state_persistence_classification !== "COMMITTED" ||
    Number(metadata.commerce_state_revision) !== proof.committed_revision ||
    !equalJson(proof.transaction_before, proof.transaction_after) ||
    !equalJson(
      proof.transaction_after,
      b2JourneyTransactionBoundary(input.snapshot.state),
    )
  ) return false;

  const entity = input.snapshot.state.entities.find((candidate) =>
    candidate.entity_id === proof.entity_id && candidate.category === proof.category
  );
  if (!entity || entity.status === "cancelled" || entity.status === "deferred") return false;

  if (proof.update_kind === "customer_goal") {
    const active = activeCustomerGoal(input.snapshot.state, proof.category);
    if (!active || active.entity_id !== proof.entity_id) return false;
    const goal = active.goal;
    const acceptedSlots = proof.committed_collected.filter((slot) =>
      !proof.previous_collected.includes(slot)
    );
    if (
      goal.source_message_id !== proof.source_message_id ||
      goal.category !== proof.category ||
      goal.journey_stage !== proof.journey_stage ||
      goal.response_intent !== proof.response_decision ||
      (goal.missing[0] ?? null) !== proof.next_missing_slot ||
      !equalJson(goal.collected, proof.committed_collected) ||
      !equalJson(goal.missing, proof.committed_missing) ||
      !equalJson(acceptedSlots, proof.accepted_slots) ||
      (!proof.accepted_slots.length && !proof.accepted_corrections.length) ||
      !proof.response_reason.startsWith("CUSTOMER_JOURNEY_") ||
      metadata.contextual_decision !== null
    ) return false;
    for (const correction of proof.accepted_corrections) {
      if (!input.snapshot.state.latest_corrections.includes(correction)) return false;
    }
    return true;
  }

  const contextualMetadata = isRecord(metadata.contextual_decision)
    ? metadata.contextual_decision
    : null;
  if (
    proof.response_route !== "contextual_scoped_update" ||
    proof.response_decision !== "confirm_controlled_update" ||
    proof.response_reason !== "UNIQUE_COMPATIBLE_CONTEXT" ||
    !proof.accepted_updates.length ||
    !contextualMetadata ||
    contextualMetadata.route !== proof.response_route ||
    contextualMetadata.reason !== proof.response_reason ||
    contextualMetadata.reply !== proof.reply ||
    contextualMetadata.topic !== proof.category ||
    contextualMetadata.entity_id !== proof.entity_id ||
    !equalJson(contextualMetadata.updates, proof.accepted_updates) ||
    contextualMetadata.aggregate_quantity !== proof.aggregate_quantity
  ) return false;
  const committed = Array.isArray(entity.attributes.scoped_customer_updates)
    ? entity.attributes.scoped_customer_updates
    : [];
  if (!equalJson(committed, proof.committed_updates)) return false;
  for (const update of proof.accepted_updates) {
    const matched = proof.committed_updates.find((candidate) =>
      candidate.scope === update.scope && candidate.attribute === update.attribute
    );
    if (!matched || !equalJson(matched, update)) return false;
  }
  return proof.aggregate_quantity === undefined ||
    entity.quantity === proof.aggregate_quantity;
}

interface CorrectionPair {
  previous: string;
  current: string;
}

function trimCorrectionPart(value: string): string {
  return clean(value, 180).replace(/^[,，:：;；\s]+|[,，。.!！?？;；\s]+$/g, "");
}

function parseCorrection(value: string): CorrectionPair | null {
  const text = clean(value, 500);
  const address = parseAddressReplacementCorrection(text);
  if (address) {
    return { previous: address.previous ?? "", current: address.current };
  }
  const patterns = [
    /(?:唔係|唔系|不是|不係)\s*(.+?)\s*(?:而係|而系|而是)\s*(.+)$/i,
    /(?:change|changed|correct|correction)(?:\s+it)?\s+from\s+(.+?)\s+to\s+(.+)$/i,
    /(?:更正|改(?:返|成|做|為|为)?|actually|i meant)\s*[:：]?\s*(.+?)\s*(?:改為|改为|變成|变成|to|而係|而是)\s*(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const previous = trimCorrectionPart(match?.[1] ?? "");
    const current = trimCorrectionPart(match?.[2] ?? "");
    if (previous && current && previous !== current) {
      return { previous, current };
    }
  }

  // A replacement-only correction can be fully deterministic even when the
  // customer does not repeat the superseded value (for example, "改做一部1匹，
  // 一部1.5匹"). Treat it as resolved only when it carries a concrete assignment;
  // vague references such as "記住我最新嗰個更正" must remain indeterminate.
  const replacement = text.match(
    /(?:更正|改(?:做|成|為|为|返)?|變成|变成|change(?:\s+it)?\s+to|make\s+it|actually|i meant)\s*[:：,，]?\s*(.+)$/i,
  );
  const current = trimCorrectionPart(replacement?.[1] ?? "");
  const concreteAssignment = /(?:\d{1,4}|[一二兩两三四五六七八九十])\s*(?:部|台|件|個|个|套|units?|pcs?|pieces?|items?)|(?:quantity|數量|数量|地址|address|型號|型号|model|品牌|brand)\s*(?:係|是|=|:|：)/i.test(
    current,
  );
  if (current && concreteAssignment) {
    return { previous: "", current };
  }
  return null;
}

function responseTouchesCommerce(text: string, state: ConversationCommerceState): boolean {
  if (extractMoneyMentions(text).length > 0) return true;
  if (mentionedEntityIds(text, state).length > 0) return true;
  return /(?:order|payment|quote|price|delivery|installation|quantity|model|brand|address|recipient|phone|訂單|订单|付款|支付|報價|报价|價錢|价钱|送貨|送货|安裝|安装|數量|数量|型號|型号|品牌|地址|收貨人|收货人|電話|电话)/i.test(
    text,
  );
}

type CorrectionDomain = "address" | "contact" | "delivery" | "entity" | "installation" | "price" | "transaction";

function correctionDomains(text: string, state: ConversationCommerceState): Set<CorrectionDomain> {
  const domains = new Set<CorrectionDomain>();
  if (/(?:地址|address|座|樓|楼|室|街|道|路|號|号)/i.test(text)) domains.add("address");
  if (/(?:電話|电话|聯絡|联络|收貨人|收货人|recipient|phone|contact)/i.test(text)) domains.add("contact");
  if (/(?:送貨|送货|配送|星期|週|周|delivery|deliver|appointment)/i.test(text)) domains.add("delivery");
  if (/(?:安裝|安装|師傅|师傅|拆機|拆机|舊機|旧机|installation|technician|dismantle)/i.test(text)) domains.add("installation");
  if (extractMoneyMentions(text).length > 0 || /(?:報價|报价|價錢|价钱|price|quote|fee)/i.test(text)) domains.add("price");
  if (/(?:訂單|订单|落單|下单|付款|支付|quotation|order|payment)/i.test(text)) domains.add("transaction");
  if (mentionedEntityIds(text, state).length > 0 || /(?:數量|数量|幾部|几部|匹數|匹数|品牌|型號|型号|quantity|horsepower|brand|model)/i.test(text)) domains.add("entity");
  return domains;
}

function unresolvedCorrectionCarriesConcreteResolution(text: string): boolean {
  return /(?:\d|[一二兩两三四五六七八九十])\s*(?:部|台|件|個|个|套|匹)|(?:取消|唔要|不要|唔裝|不裝|不装|暫緩|暂缓|defer|cancel|remove)|(?:quotation|報價|报价).{0,12}(?:咋|啫|而已|only)|(?:地址|address).{0,40}(?:座|樓|楼|室|街|道|路|號|号)|(?:電話|电话|phone|contact).{0,40}\d{4}/i.test(text);
}

function evaluateCorrections(text: string, state: ConversationCommerceState): B2Decision | null {
  if (state.latest_corrections.length === 0) return null;
  const latest = state.latest_corrections.at(-1) ?? "";
  const parsed = parseCorrection(latest);
  if (!parsed) {
    if (!responseTouchesCommerce(text, state)) return null;
    const correctionScope = correctionDomains(latest, state);
    if (unresolvedCorrectionCarriesConcreteResolution(latest)) return null;
    if (correctionScope.size === 0) return { decision: "indeterminate", code: "LATEST_CORRECTION_UNRESOLVED" };
    const responseScope = correctionDomains(text, state);
    return [...correctionScope].some((domain) => responseScope.has(domain))
      ? { decision: "indeterminate", code: "LATEST_CORRECTION_UNRESOLVED" }
      : null;
  }
  const candidate = lower(text);
  const previous = lower(parsed.previous);
  const current = lower(parsed.current);
  if (previous && candidate.includes(previous) && !candidate.includes(current)) {
    return {
      decision: "block",
      code: "SUPERSEDED_VALUE_REUSED",
      detail: `${parsed.previous} -> ${parsed.current}`,
    };
  }
  return null;
}

function evaluateCancellation(text: string, state: ConversationCommerceState): B2Decision | null {
  const candidate = lower(text);
  const activeLanguage = RESTORE_OR_ACTIVE.test(text);
  if (!activeLanguage) return null;

  const cancelledEntities = state.entities.filter((entity) => entity.status === "cancelled");
  const activeEntities = state.entities.filter(
    (entity) => entity.status !== "cancelled" && entity.status !== "deferred",
  );
  const mentionedCancelled = cancelledEntities.filter((entity) =>
    entityAliases(entity).some((alias) => candidate.includes(alias)),
  );
  if (mentionedCancelled.length > 0) {
    return { decision: "block", code: "CANCELLED_ENTITY_RESTORATION" };
  }
  const pronoun =
    /(?:the one|that one|it\b|removed one|cancelled one|嗰個|果個|該項|该项|取消嗰|取消的|移除嗰|移除的)/i.test(
      text,
    );
  if (pronoun && cancelledEntities.length > 0) {
    return activeEntities.length === 0
      ? { decision: "block", code: "CANCELLED_ENTITY_INDIRECT_RESTORATION" }
      : {
          decision: "indeterminate",
          code: "AMBIGUOUS_CANCELLED_ENTITY_REFERENCE",
        };
  }

  const cancelledQuote = state.quotes.some(
    (quote) =>
      quote.validity_status === "invalid" ||
      quote.validity_status === "expired" ||
      quote.validity_status === "superseded",
  );
  if (cancelledQuote && /(?:quote|quotation|price|報價|报价|價錢|价钱)/i.test(text)) {
    return { decision: "block", code: "INACTIVE_QUOTE_RESTORATION" };
  }
  if (
    state.conversion.order_status === "cancelled" &&
    /(?:order|訂單|订单|落單|下单)/i.test(text)
  ) {
    return { decision: "block", code: "CANCELLED_ORDER_RESTORATION" };
  }
  if (
    state.installation.items.some((item) => item.status === "cancelled") &&
    /(?:(?:cancelled|canceled|removed|取消|已取消).{0,28}(?:installation|install|安裝|安装)|(?:installation|install|安裝|安装).{0,28}(?:cancelled|canceled|removed|取消|已取消))/i.test(
      text,
    )
  ) {
    return { decision: "block", code: "CANCELLED_INSTALLATION_RESTORATION" };
  }
  return null;
}

export function evaluateB2BeforeCommit(input: B2EvaluationInput): B2Decision {
  const draft = clean(input.proposed_response);
  if (!draft) {
    return { decision: "indeterminate", code: "EMPTY_PROPOSED_RESPONSE" };
  }
  if (!isConversationCommerceState(input.snapshot.state)) {
    return {
      decision: "indeterminate",
      code: "INVALID_CANONICAL_COMMERCE_STATE",
    };
  }
  const state = input.snapshot.state;
  const kbPriceDecision = input.metadata?.response_route === "canonical_kb_direct_answer" &&
      input.metadata.answer_kind === "price" || input.trusted_kb_price_proof
    ? evaluateCurrentKbSellingPrice(input, draft)
    : null;
  if (kbPriceDecision?.decision === "block") return kbPriceDecision;
  const correctionDecision = evaluateCorrections(draft, state);
  const authoritativeNoSemanticChange =
    correctionDecision?.decision === "indeterminate" &&
    classifyB2AuthoritativePersistence(input) === "NO_SEMANTIC_CHANGE";
  const trustedTargetedClarification = isTrustedTargetedReadOnlyClarification(input, draft);
  const trustedJourneyProgress = isTrustedJourneyProgressAfterAcceptedUpdate(
    input,
    draft,
  );
  const trustedCorrection = isTrustedCorrectionCommit(input, draft);
  const trustedLifecycle = isTrustedLifecycleCommit(input, draft);
  if ((input.trusted_lifecycle_commit || input.metadata?.commerce_reason === "authoritative_scoped_lifecycle_applied") && !trustedLifecycle) {
    return { decision: "block", code: "UNPROVEN_LIFECYCLE_COMMIT" };
  }
  if (
    (input.trusted_correction_commit ||
      input.metadata?.commerce_reason === "authoritative_scoped_correction_applied") &&
    !trustedCorrection
  ) return { decision: "block", code: "UNPROVEN_CORRECTION_COMMIT" };
  return (
    (authoritativeNoSemanticChange || trustedLifecycle ? null : correctionDecision) ??
    evaluateCancellation(draft, state) ??
    (kbPriceDecision ? null : evaluateQuoteReality(draft, state, input)) ??
    evaluateTransactionReality(draft, input.persistence_kind, state) ??
    (trustedTargetedClarification || trustedJourneyProgress || trustedCorrection || trustedLifecycle
      ? null
      : evaluateKnownContext(draft, state)) ?? {
      decision: "allow",
      code: kbPriceDecision?.code ?? (trustedLifecycle
        ? "B2_ALLOW_COMMITTED_SCOPED_LIFECYCLE"
        : trustedCorrection
        ? "B2_ALLOW_COMMITTED_SCOPED_CORRECTION"
        : trustedJourneyProgress
        ? "B2_ALLOW_JOURNEY_PROGRESS_AFTER_ACCEPTED_UPDATE"
        : trustedTargetedClarification
        ? "B2_ALLOW_TARGETED_READ_ONLY_CLARIFICATION"
        : authoritativeNoSemanticChange
        ? "B2_ALLOW_NO_SEMANTIC_CHANGE_AFTER_AUTHORITATIVE_READBACK"
        : "B2_ALLOW"),
    }
  );
}

function queryErrorDetail(error: unknown): string {
  if (isRecord(error)) {
    return clean(error.message ?? error.code, 180) || "query_error";
  }
  return clean(error, 180) || "query_error";
}

async function loadB2Snapshot(
  client: B2DatabaseClient,
  conversation_id: string,
  source_message_id: string,
): Promise<
  | { ok: true; snapshot: B2CanonicalSnapshot }
  | {
      ok: false;
      decision: B2Decision;
    }
> {
  try {
    const conversationResult = await client
      .from("conversations")
      .select("id, company_id")
      .eq("id", conversation_id)
      .maybeSingle();
    if (conversationResult.error) {
      return {
        ok: false,
        decision: {
          decision: "indeterminate",
          code: "CONVERSATION_SCOPE_LOOKUP_FAILED",
          detail: queryErrorDetail(conversationResult.error),
        },
      };
    }
    if (!isRecord(conversationResult.data)) {
      return {
        ok: false,
        decision: {
          decision: "indeterminate",
          code: "CONVERSATION_SCOPE_NOT_FOUND",
        },
      };
    }
    const companyId = clean(conversationResult.data.company_id, 160);
    if (!companyId) {
      return {
        ok: false,
        decision: {
          decision: "indeterminate",
          code: "CONVERSATION_COMPANY_UNRESOLVED",
        },
      };
    }

    const sourceResult = await client
      .from("messages")
      .select("id, conversation_id, role, content")
      .eq("id", source_message_id)
      .eq("conversation_id", conversation_id)
      .maybeSingle();
    if (sourceResult.error) {
      return {
        ok: false,
        decision: {
          decision: "indeterminate",
          code: "SOURCE_MESSAGE_LOOKUP_FAILED",
          detail: queryErrorDetail(sourceResult.error),
        },
      };
    }
    if (
      !isRecord(sourceResult.data) ||
      clean(sourceResult.data.id, 160) !== source_message_id ||
      clean(sourceResult.data.conversation_id, 160) !== conversation_id ||
      sourceResult.data.role !== "visitor"
    ) {
      return {
        ok: false,
        decision: { decision: "indeterminate", code: "SOURCE_MESSAGE_INVALID" },
      };
    }

    const stateResult = await client
      .from("conversation_commerce_state")
      .select("company_id, revision, source_message_id, state")
      .eq("conversation_id", conversation_id)
      .eq("company_id", companyId)
      .maybeSingle();
    if (stateResult.error) {
      return {
        ok: false,
        decision: {
          decision: "indeterminate",
          code: "COMMERCE_STATE_LOOKUP_FAILED",
          detail: queryErrorDetail(stateResult.error),
        },
      };
    }

    let state = createEmptyConversationCommerceState();
    let revision = 0;
    let stateSource: string | null = null;
    if (stateResult.data !== null && stateResult.data !== undefined) {
      if (!isRecord(stateResult.data)) {
        return {
          ok: false,
          decision: {
            decision: "indeterminate",
            code: "COMMERCE_STATE_INVALID_ROW",
          },
        };
      }
      if (clean(stateResult.data.company_id, 160) !== companyId) {
        return {
          ok: false,
          decision: {
            decision: "indeterminate",
            code: "COMMERCE_STATE_COMPANY_MISMATCH",
          },
        };
      }
      const rawRevision =
        typeof stateResult.data.revision === "number"
          ? stateResult.data.revision
          : Number(stateResult.data.revision);
      if (!Number.isInteger(rawRevision) || rawRevision < 0) {
        return {
          ok: false,
          decision: {
            decision: "indeterminate",
            code: "COMMERCE_STATE_REVISION_INVALID",
          },
        };
      }
      if (!isConversationCommerceState(stateResult.data.state)) {
        return {
          ok: false,
          decision: {
            decision: "indeterminate",
            code: "INVALID_CANONICAL_COMMERCE_STATE",
          },
        };
      }
      state = structuredClone(stateResult.data.state);
      revision = rawRevision;
      stateSource = clean(stateResult.data.source_message_id, 160) || null;
    }

    return {
      ok: true,
      snapshot: {
        conversation_id,
        company_id: companyId,
        source_message_id,
        source_message_content: clean(sourceResult.data.content),
        commerce_state_revision: revision,
        commerce_state_source_message_id: stateSource,
        state,
      },
    };
  } catch (error) {
    return {
      ok: false,
      decision: {
        decision: "indeterminate",
        code: "SUPERVISOR_READ_ERROR",
        detail: error instanceof Error ? error.name : "unknown_error",
      },
    };
  }
}

function stableSnapshotFingerprint(snapshot: B2CanonicalSnapshot): string {
  return JSON.stringify({
    conversation_id: snapshot.conversation_id,
    company_id: snapshot.company_id,
    source_message_id: snapshot.source_message_id,
    source_message_content: snapshot.source_message_content,
    commerce_state_revision: snapshot.commerce_state_revision,
    commerce_state_source_message_id: snapshot.commerce_state_source_message_id,
    state: snapshot.state,
  });
}

/**
 * Executes the complete read/evaluate/revalidate/commit sequence. The callback
 * is never invoked for block, indeterminate, evaluation errors, tenant drift,
 * source drift, or revision drift.
 */
export async function executeB2PersistenceGate<T>(
  input: B2PersistenceInput<T>,
): Promise<B2PersistenceResult<T>> {
  const initial = await loadB2Snapshot(
    input.client,
    input.conversation_id,
    input.source_message_id,
  );
  if (!initial.ok) return { committed: false, decision: initial.decision };

  if (
    input.expected_commerce_state_revision !== undefined &&
    input.expected_commerce_state_revision !== null &&
    input.expected_commerce_state_revision !== initial.snapshot.commerce_state_revision
  ) {
    return {
      committed: false,
      snapshot: initial.snapshot,
      decision: {
        decision: "indeterminate",
        code: "EXPECTED_COMMERCE_REVISION_MISMATCH",
      },
    };
  }

  let decision: B2Decision;
  try {
    decision = evaluateB2BeforeCommit({
      proposed_response: input.proposed_response,
      persistence_kind: input.persistence_kind,
      snapshot: initial.snapshot,
      metadata: input.metadata ? structuredClone(input.metadata) : input.metadata,
      trusted_kb_price_proof: input.trusted_kb_price_proof,
      trusted_targeted_clarification: input.trusted_targeted_clarification,
      trusted_journey_progress: input.trusted_journey_progress,
      trusted_correction_commit: input.trusted_correction_commit,
      trusted_lifecycle_commit: input.trusted_lifecycle_commit,
    });
  } catch (error) {
    decision = {
      decision: "indeterminate",
      code: "SUPERVISOR_ERROR",
      detail: error instanceof Error ? error.name : "unknown_error",
    };
  }
  if (decision.decision !== "allow") {
    return { committed: false, decision, snapshot: initial.snapshot };
  }

  const revalidated = await loadB2Snapshot(
    input.client,
    input.conversation_id,
    input.source_message_id,
  );
  if (!revalidated.ok) {
    return { committed: false, decision: revalidated.decision };
  }
  if (
    stableSnapshotFingerprint(initial.snapshot) !== stableSnapshotFingerprint(revalidated.snapshot)
  ) {
    return {
      committed: false,
      snapshot: revalidated.snapshot,
      decision: {
        decision: "indeterminate",
        code: "COMMERCE_CONTEXT_CHANGED_BEFORE_COMMIT",
      },
    };
  }

  const value = await input.commit(revalidated.snapshot);
  return { committed: true, decision, snapshot: revalidated.snapshot, value };
}
