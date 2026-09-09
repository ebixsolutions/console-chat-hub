import { createEmptyConversationCommerceState, isConversationCommerceState, type ConversationCommerceState } from "./commerce-state-contract.ts";
import { deriveCommerceEventsFromCustomerTurn, reduceCommerceState, type CommerceStateEvent, type CommerceTurnEntityHint } from "./commerce-state-reducer.ts";
import { resolveCommerceAnswerAuthority, type CommerceCalculationTerm, type CommerceAuthorityDecision } from "./commerce-state-authority.ts";

export const COMMERCE_RUNTIME_INTEGRATION_VERSION = "task-a3-commerce-runtime-1.0.0" as const;

type VisitorLanguage = "zh-TW" | "zh-CN" | "en";

type SupabaseLike = {
  from: (table: string) => any;
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

export interface CommerceRuntimeInput {
  supabaseAdmin: SupabaseLike;
  conversation_id: string;
  company_id: string | null | undefined;
  source_message_id: string | null;
  customer_text: string;
  occurred_at?: string | null;
  language: VisitorLanguage;
}

export interface CommerceRuntimeResult {
  handled: boolean;
  reply?: string;
  metadata: Record<string, unknown>;
  state: ConversationCommerceState | null;
  authority?: CommerceAuthorityDecision["authority"];
}

function clean(value: unknown, max = 1200): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function customerProvenance(source_message_id: string, occurred_at?: string | null) {
  return { source_type: "customer" as const, source_message_id, recorded_at: occurred_at ?? null };
}

function numberFrom(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function latestQuote(state: ConversationCommerceState, labels: string[]): ConversationCommerceState["quotes"][number] | null {
  const wanted = new Set(labels.map((x) => x.toLowerCase()));
  for (let i = state.quotes.length - 1; i >= 0; i -= 1) {
    const quote = state.quotes[i];
    if (wanted.has(clean(quote.source_label ?? "", 120).toLowerCase())) return quote;
  }
  return null;
}

function entityHints(state: ConversationCommerceState, text: string): CommerceTurnEntityHint[] {
  const hints = state.entities.map((entity) => ({
    entity_id: entity.entity_id,
    category: entity.category,
    aliases: [entity.category, entity.brand ?? "", entity.model ?? ""].filter(Boolean),
    status: entity.status,
    quantity: entity.quantity,
    brand: entity.brand ?? null,
    model: entity.model ?? null,
    attributes: entity.attributes,
    constraints: entity.constraints,
  }));
  const add = (hint: CommerceTurnEntityHint) => {
    if (!hints.some((x) => x.entity_id === hint.entity_id)) hints.push(hint);
  };

  const has15 = /(?:1\.5\s*(?:hp|匹)|1\s*匹\s*半|一匹半)/i.test(text);
  const has1 = /(?<![.\d])1\s*(?:hp|匹)(?!\s*半|\.5)/i.test(text) || /一匹(?!半)/.test(text);
  if (has1) add({ entity_id: "aircon-1hp", category: "air_conditioner", aliases: ["1匹", "1hp", "一匹", "冷氣", "冷气", "aircon", "ac"], quantity: 1, status: "tentative" });
  if (has15) add({ entity_id: "aircon-1_5hp", category: "air_conditioner", aliases: ["1.5匹", "1.5hp", "1匹半", "一匹半", "冷氣", "冷气", "aircon", "ac"], quantity: 1, status: "tentative" });
  if (!has1 && !has15 && /(?:冷氣|冷气|air\s*con|aircon|\bac\b)/i.test(text)) {
    add({ entity_id: "aircon-general", category: "air_conditioner", aliases: ["冷氣", "冷气", "aircon", "air conditioner", "ac"], quantity: 1, status: "tentative" });
  }
  if (/(?:雪櫃|冰箱|refrigerator|fridge)/i.test(text)) add({ entity_id: "refrigerator", category: "refrigerator", aliases: ["雪櫃", "冰箱", "refrigerator", "fridge"], quantity: 1, status: "researching" });
  if (/(?:洗衣機|洗衣机|washer|washing machine)/i.test(text)) add({ entity_id: "washer", category: "washer", aliases: ["洗衣機", "洗衣机", "washer", "washing machine"], quantity: 1, status: "researching" });
  if (/(?:客廳|客厅|living room).{0,20}(?:冷氣|冷气|air\s*con|aircon|\bac\b)|(?:冷氣|冷气|air\s*con|aircon|\bac\b).{0,20}(?:客廳|客厅|living room)/i.test(text)) {
    add({ entity_id: "aircon-living-room", category: "air_conditioner", aliases: ["客廳冷氣", "客厅冷气", "living room aircon"], quantity: 1, status: "tentative", attributes: { room: "living_room" } });
  }
  return hints;
}

function extraCommerceEvents(text: string, source_message_id: string, occurred_at: string | null | undefined, hints: CommerceTurnEntityHint[]): CommerceStateEvent[] {
  const events: CommerceStateEvent[] = [];
  const p = customerProvenance(source_message_id, occurred_at);
  const ensure = (entityId: string) => {
    const hint = hints.find((x) => x.entity_id === entityId);
    if (!hint) return;
    events.push({ type: "ENSURE_ENTITY", entity: {
      entity_id: hint.entity_id,
      category: hint.category,
      brand: hint.brand ?? null,
      model: hint.model ?? null,
      quantity: hint.quantity ?? 1,
      status: hint.status ?? "researching",
      attributes: hint.attributes ?? {},
      constraints: hint.constraints ?? {},
      provenance: p,
    } });
  };

  if (/(?:一|1)\s*部?.{0,10}(?:1\s*(?:hp|匹)|一匹)(?!半).{0,35}(?:一|1)\s*部?.{0,10}(?:1\.5\s*(?:hp|匹)|1匹半|一匹半)/i.test(text) ||
      /(?:一|1)\s*部?.{0,10}(?:1\.5\s*(?:hp|匹)|1匹半|一匹半).{0,35}(?:一|1)\s*部?.{0,10}(?:1\s*(?:hp|匹)|一匹)(?!半)/i.test(text)) {
    ensure("aircon-1hp"); ensure("aircon-1_5hp");
    events.push({ type: "SET_ENTITY_QUANTITY", entity_id: "aircon-1hp", quantity: 1, provenance: p });
    events.push({ type: "SET_ENTITY_QUANTITY", entity_id: "aircon-1_5hp", quantity: 1, provenance: p });
    const general = hints.find((x) => x.entity_id === "aircon-general");
    if (general) events.push({ type: "SET_ENTITY_STATUS", entity_id: "aircon-general", status: "cancelled", provenance: p });
  }

  if (/(?:客廳|客厅|living room)/i.test(text) && /(?:取消|唔要|不要|暫時唔|暂时不|defer|hold off)/i.test(text)) {
    ensure("aircon-living-room");
    events.push({ type: "SET_ENTITY_STATUS", entity_id: "aircon-living-room", status: /(?:暫時|暂时|defer|hold off)/i.test(text) ? "deferred" : "cancelled", provenance: p });
  }

  if (/(?:雪櫃|冰箱|refrigerator|fridge)/i.test(text)) {
    ensure("refrigerator");
    const doors = text.match(/([234])\s*(?:門|门|door)/i);
    if (doors?.[1]) events.push({ type: "SET_ENTITY_ATTRIBUTE", entity_id: "refrigerator", key: "doors", value: Number(doors[1]), provenance: p });
    const width = text.match(/(?:闊|宽|寬|width).{0,12}(?:唔超過|不超過|不超过|<=|≤|最多|max(?:imum)?|限制)?\s*(\d{3})\s*(?:mm|毫米)?/i) ?? text.match(/(\d{3})\s*mm.{0,12}(?:闊|宽|寬|width|限制)/i);
    if (width?.[1]) events.push({ type: "SET_ENTITY_CONSTRAINT", entity_id: "refrigerator", key: "width_mm", value: Number(width[1]), provenance: p });
    if (/(?:雪櫃|冰箱).{0,18}(?:600).{0,18}(?:限制).{0,10}(?:取消|唔要|不要)/i.test(text)) events.push({ type: "REMOVE_ENTITY_CONSTRAINT", entity_id: "refrigerator", key: "width_mm", provenance: p });
  }

  if (/(?:洗衣機|洗衣机|washer|washing machine)/i.test(text)) {
    ensure("washer");
    const width = text.match(/(?:闊|宽|寬|width).{0,12}(?:唔超過|不超過|不超过|<=|≤|最多|max(?:imum)?|限制)?\s*(\d{3})\s*(?:mm|毫米)?/i) ?? text.match(/(\d{3})\s*mm.{0,12}(?:闊|宽|寬|width|限制)/i);
    if (width?.[1]) events.push({ type: "SET_ENTITY_CONSTRAINT", entity_id: "washer", key: "width_mm", value: Number(width[1]), provenance: p });
    const kg = text.match(/(\d{1,2}(?:\.\d)?)\s*kg/i);
    if (kg?.[1]) events.push({ type: "SET_ENTITY_ATTRIBUTE", entity_id: "washer", key: "capacity_kg", value: Number(kg[1]), provenance: p });
    if (/(?:前置|front[ -]?load)/i.test(text)) events.push({ type: "SET_ENTITY_ATTRIBUTE", entity_id: "washer", key: "load_type", value: "front_load", provenance: p });
    if (/(?:研究|睇下|看看|未決定|未决定|未confirm|未確認|未确认|research)/i.test(text)) events.push({ type: "SET_ENTITY_STATUS", entity_id: "washer", status: "researching", provenance: p });
  }

  const installMatchers: Array<[RegExp, string, string]> = [
    [/(?:拆走|拆除|remove).{0,18}(?:一|1)\s*部.{0,10}(?:舊|旧)?(?:冷氣|冷气|aircon)|(?:一|1)\s*部.{0,10}(?:舊|旧)(?:冷氣|冷气).{0,18}(?:拆走|拆除|remove)/i, "old_ac_removal", "old_ac_removal"],
    [/(?:電力|电力|電線|电线|拉線|拉线|wiring|electrical)/i, "electrical_check", "electrical_or_wiring"],
    [/(?:石屎|混凝土|concrete)/i, "concrete_work", "concrete_work"],
    [/(?:廢料|废料|垃圾|waste|debris)/i, "waste_disposal", "waste_disposal"],
  ];
  for (const [re, id, kind] of installMatchers) {
    if (!re.test(text)) continue;
    events.push({ type: "UPSERT_INSTALLATION_ITEM", item: { item_id: id, kind, status: "pending", details: {}, provenance: p } });
  }

  return events;
}

function labelQuoteEvents(events: CommerceStateEvent[], text: string): void {
  for (const event of events) {
    if (event.type !== "ADD_QUOTE") continue;
    if (/(?:安裝|安装|installation)/i.test(text)) event.quote.source_label = "installation_price";
    else if (/(?:鋁架|铝架|frame)/i.test(text)) event.quote.source_label = "frame_price";
    else if (/(?:計你|优惠|優惠|每部|unit price|negotiat)/i.test(text)) event.quote.source_label = "negotiated_unit_price";
    else if (/(?:機價|机价|machine price|GWF12P)/i.test(text)) event.quote.source_label = "machine_price";
  }
}

function extraQuoteEvents(text: string, source_message_id: string, occurred_at?: string | null): CommerceStateEvent[] {
  const p = customerProvenance(source_message_id, occurred_at);
  const results: CommerceStateEvent[] = [];
  const specs: Array<[RegExp, string]> = [
    [/(?:計你|优惠|優惠|每部|unit price|negotiat)[^0-9]{0,12}(?:HK\$|\$)?\s*([0-9][0-9,]*)/i, "negotiated_unit_price"],
    [/(?:安裝|安装|installation)[^0-9]{0,12}(?:HK\$|\$)?\s*([0-9][0-9,]*)/i, "installation_price"],
    [/(?:鋁架|铝架|frame)[^0-9]{0,12}(?:HK\$|\$)?\s*([0-9][0-9,]*)/i, "frame_price"],
    [/(?:機價|机价|machine price|GWF12P)[^0-9]{0,18}(?:HK\$|\$)?\s*([0-9][0-9,]*)/i, "machine_price"],
  ];
  let i = 0;
  for (const [re, label] of specs) {
    const match = text.match(re);
    const amount = numberFrom(match?.[1]);
    if (amount === null) continue;
    results.push({ type: "ADD_QUOTE", quote: {
      quote_id: `customer:${source_message_id}:semantic:${i++}`,
      amount,
      currency: "HKD",
      quote_type: /(?:之前|上次|舊價|旧价|歷史|历史|previous|historical)/i.test(text) || label !== "machine_price" ? "customer_reported_historical" : "unverified",
      validity_status: /(?:之前|上次|舊價|旧价|歷史|历史|previous|historical)/i.test(text) ? "historical" : "unknown",
      source_label: label,
      conditions: { customer_reported: true, current_verified: false },
      provenance: p,
    } });
  }
  return results;
}

function activeAircons(state: ConversationCommerceState) {
  return state.entities.filter((x) => x.category === "air_conditioner" && x.entity_id !== "aircon-general" && x.status !== "cancelled" && x.status !== "deferred");
}

function quantityQuestion(text: string): boolean {
  return !/(?:價|价|price|幾錢|几钱|多少錢|多少钱)/i.test(text) && /(?:幾多|多少|數量|数量|quantity|how many).{0,8}(?:部|台|冷氣|冷气|aircon|ac)|(?:最後|而家|現在|现在).{0,12}(?:幾多|多少).{0,8}(?:部|台)/i.test(text);
}

function productStateQuestion(text: string): boolean {
  return /(?:邊兩部|哪兩台|咩規格|什麼規格|什么规格|我(?:而家|現在|现在|最後|最后).{0,20}(?:要|揀|选|選).{0,12}(?:冷氣|冷气|產品|产品))/i.test(text);
}

function formatAirconBreakdown(state: ConversationCommerceState): string {
  const active = activeAircons(state);
  const parts = active.map((x) => x.entity_id === "aircon-1hp" ? `${x.quantity}部1匹` : x.entity_id === "aircon-1_5hp" ? `${x.quantity}部1.5匹` : `${x.quantity}部${x.model ?? x.category}`);
  const total = active.reduce((sum, x) => sum + x.quantity, 0);
  const living = state.entities.find((x) => x.entity_id === "aircon-living-room");
  const suffix = living?.status === "cancelled" ? "；客廳嗰部已取消" : living?.status === "deferred" ? "；客廳嗰部已暫緩" : "";
  return total > 0 ? `你最新係 ${total} 部冷氣：${parts.join(" + ")}${suffix}。` : "目前未有足夠已確認資料去確定冷氣數量。";
}

function buildCalculationTerms(state: ConversationCommerceState, question: string): CommerceCalculationTerm[] {
  if (!/(?:之前|上次|舊|旧|歷史|历史|5600|舊報價|旧报价|historical|previous)/i.test(question)) return [];
  const unit = latestQuote(state, ["negotiated_unit_price"]);
  const install = latestQuote(state, ["installation_price"]);
  const frame = latestQuote(state, ["frame_price"]);
  if (!unit || !install || !frame) return [];
  const explicitQty = question.match(/([12兩两二])\s*(?:部|台)/)?.[1];
  const qty = explicitQty ? (["2", "兩", "两", "二"].includes(explicitQty) ? 2 : 1) : activeAircons(state).reduce((sum, x) => sum + x.quantity, 0);
  if (qty <= 0) return [];
  return [
    { label: "historical_unit_price", value: unit.amount, multiplier: qty },
    { label: "historical_installation", value: install.amount, multiplier: qty },
    { label: "historical_frame", value: frame.amount, multiplier: qty },
  ];
}

function isCurrentBusinessFact(text: string): boolean {
  return /(?:而家|現在|现在|目前|最新|今日|today|current|latest).{0,30}(?:價|价|price|stock|庫存|库存|有貨|有货|available|政策|policy|收費|收费|fee|保養|保修|warranty)/i.test(text);
}

function isProfessionalSiteQuestion(text: string): boolean {
  return /(?:現場|现场|師傅|师傅|電力|电力|拉線|拉线|電線|电线|石屎|混凝土|concrete|wiring|electrical|結構|结构|安全).{0,40}(?:可唔可以|可以嗎|能不能|保證|保证|確認|确认|點做|怎么做|幾錢|几钱|收費|收费)?/i.test(text);
}

function transactionSummaryRequested(text: string): boolean {
  return /(?:幫我|帮我|please).{0,18}(?:總結|总结|整理)|(?:準備落單|准备下单|預落單|预下单|quotation|報價|报价).{0,30}(?:總結|总结|整理|跟進|同事)|(?:最後|最后).{0,12}(?:總結|总结)/i.test(text);
}

function buildTransactionSummary(state: ConversationCommerceState, language: VisitorLanguage): string {
  const active = state.entities.filter((x) => x.status !== "cancelled" && x.status !== "deferred" && x.entity_id !== "aircon-general");
  const entityLines = active.map((x) => {
    const label = x.entity_id === "aircon-1hp" ? "1匹冷氣" : x.entity_id === "aircon-1_5hp" ? "1.5匹冷氣" : x.entity_id === "refrigerator" ? "雪櫃" : x.entity_id === "washer" ? "洗衣機" : x.model ?? x.category;
    const details: string[] = [];
    if (x.attributes.doors) details.push(`${x.attributes.doors}門`);
    if (x.attributes.load_type === "front_load") details.push("前置式");
    if (x.attributes.capacity_kg) details.push(`${x.attributes.capacity_kg}kg`);
    if (x.constraints.width_mm) details.push(`闊度≤${x.constraints.width_mm}mm`);
    return `- ${label} × ${x.quantity}${details.length ? `（${details.join("、")}）` : ""}${x.status === "researching" ? "（研究中／未確認）" : ""}`;
  });
  const cancelled = state.entities.filter((x) => x.status === "cancelled" || x.status === "deferred").map((x) => x.entity_id === "aircon-living-room" ? `客廳冷氣：${x.status === "cancelled" ? "已取消" : "已暫緩"}` : `${x.model ?? x.category}：${x.status}`);
  const install = state.installation.items.filter((x) => x.status === "pending").map((x) => x.kind);
  const delivery = [state.delivery.address, state.delivery.preferred_date, state.delivery.recipient_name, state.delivery.recipient_phone].filter(Boolean).join("；");
  const quoteBits = state.quotes.filter((q) => q.quote_type === "customer_reported_historical").slice(-6).map((q) => `${q.source_label ?? "historical_quote"} HK$${q.amount.toLocaleString("en-US")}`);
  const status = state.conversion.order_status === "confirmed" ? "已確認訂單" : state.conversion.payment_status === "paid" ? "已付款" : "目前只屬報價／預落單，未視為正式落單；最新價及工程費仍需確認。";
  if (language === "en") {
    return `Current commerce summary:\n${entityLines.join("\n") || "- No confirmed item details"}\n${cancelled.length ? `Changes: ${cancelled.join("; ")}\n` : ""}${delivery ? `Delivery: ${delivery}\n` : ""}${install.length ? `Pending site/install checks: ${install.join(", ")}\n` : ""}${quoteBits.length ? `Customer-reported historical quotes only: ${quoteBits.join("; ")}\n` : ""}Status: ${status}`;
  }
  return `目前跟進摘要：\n${entityLines.join("\n") || "- 暫未有已確認產品資料"}\n${cancelled.length ? `- 最新更改：${cancelled.join("；")}\n` : ""}${delivery ? `- 送貨：${delivery}\n` : ""}${install.length ? `- 待確認工程／現場項目：${install.join("、")}\n` : ""}${quoteBits.length ? `- 客戶提供嘅歷史價（只作歷史參考）：${quoteBits.join("；")}\n` : ""}- 狀態：${status}`;
}

function knownValueReply(value: unknown, path: string | null | undefined, language: VisitorLanguage): string {
  const rendered = typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value);
  if (language === "en") return `Your latest recorded ${path ?? "detail"} is ${rendered}.`;
  if (language === "zh-CN") return `你最新记录的${path ?? "资料"}是：${rendered}。`;
  return `你最新記錄嘅${path ?? "資料"}係：${rendered}。`;
}

async function loadState(input: CommerceRuntimeInput): Promise<{ revision: number; state: ConversationCommerceState }> {
  const { data, error } = await input.supabaseAdmin.from("conversation_commerce_state")
    .select("revision,state")
    .eq("conversation_id", input.conversation_id)
    .maybeSingle();
  if (error) throw new Error(`commerce_state_load_failed:${clean(error.message, 200)}`);
  const revision = typeof data?.revision === "number" ? data.revision : Number(data?.revision ?? 0);
  const state = isConversationCommerceState(data?.state) ? data.state : createEmptyConversationCommerceState();
  return { revision: Number.isFinite(revision) ? revision : 0, state };
}

async function persistState(input: CommerceRuntimeInput, expectedRevision: number, state: ConversationCommerceState): Promise<number> {
  const { data, error } = await input.supabaseAdmin.rpc("upsert_conversation_commerce_state_v1", {
    p_conversation_id: input.conversation_id,
    p_company_id: input.company_id,
    p_expected_revision: expectedRevision,
    p_source_message_id: input.source_message_id,
    p_state: state,
  });
  if (error) throw new Error(`commerce_state_rpc_failed:${clean(error.message, 200)}`);
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.result === "revision_conflict") {
    const reloaded = await loadState(input);
    const hints = entityHints(reloaded.state, input.customer_text);
    const baseEvents = deriveCommerceEventsFromCustomerTurn({ text: input.customer_text, source_message_id: input.source_message_id!, occurred_at: input.occurred_at ?? null, current_language: input.language, entity_hints: hints });
    labelQuoteEvents(baseEvents, input.customer_text);
    const retryState = reduceCommerceState(reloaded.state, [...baseEvents, ...extraCommerceEvents(input.customer_text, input.source_message_id!, input.occurred_at, hints), ...extraQuoteEvents(input.customer_text, input.source_message_id!, input.occurred_at)]);
    const retry = await input.supabaseAdmin.rpc("upsert_conversation_commerce_state_v1", { p_conversation_id: input.conversation_id, p_company_id: input.company_id, p_expected_revision: reloaded.revision, p_source_message_id: input.source_message_id, p_state: retryState });
    if (retry.error) throw new Error(`commerce_state_rpc_retry_failed:${clean(retry.error.message, 200)}`);
    const retryResult = (retry.data ?? {}) as Record<string, unknown>;
    if (retryResult.result !== "success") throw new Error(`commerce_state_rpc_retry_result:${String(retryResult.result ?? "unknown")}`);
    return Number(retryResult.current_revision ?? retryResult.applied_revision ?? reloaded.revision + 1);
  }
  if (result.result !== "success") throw new Error(`commerce_state_rpc_result:${String(result.result ?? "unknown")}`);
  return Number(result.current_revision ?? result.applied_revision ?? expectedRevision + 1);
}

export async function resolveCommerceRuntimeTurn(input: CommerceRuntimeInput): Promise<CommerceRuntimeResult> {
  if (!input.source_message_id || !input.company_id || !clean(input.customer_text)) return { handled: false, metadata: { commerce_runtime: "skipped_missing_identity" }, state: null };

  const loaded = await loadState(input);
  const hints = entityHints(loaded.state, input.customer_text);
  const baseEvents = deriveCommerceEventsFromCustomerTurn({
    text: input.customer_text,
    source_message_id: input.source_message_id,
    occurred_at: input.occurred_at ?? null,
    current_language: input.language,
    entity_hints: hints,
  });
  labelQuoteEvents(baseEvents, input.customer_text);
  const nextState = reduceCommerceState(loaded.state, [
    ...baseEvents,
    ...extraCommerceEvents(input.customer_text, input.source_message_id, input.occurred_at, hints),
    ...extraQuoteEvents(input.customer_text, input.source_message_id, input.occurred_at),
  ]);
  const revision = await persistState(input, loaded.revision, nextState);
  const persisted = (await loadState(input)).state;

  const commonMeta = {
    commerce_runtime_version: COMMERCE_RUNTIME_INTEGRATION_VERSION,
    commerce_state_revision: revision,
    commerce_state_source_message_id: input.source_message_id,
  };

  if (transactionSummaryRequested(input.customer_text)) {
    return { handled: true, reply: buildTransactionSummary(persisted, input.language), metadata: { ...commonMeta, response_route: "commerce_transaction_summary", answer_authority: "CONVERSATION_STATE" }, state: persisted, authority: "CONVERSATION_STATE" };
  }

  if (quantityQuestion(input.customer_text) && activeAircons(persisted).length > 0) {
    return { handled: true, reply: formatAirconBreakdown(persisted), metadata: { ...commonMeta, response_route: "commerce_known_state", answer_authority: "CONVERSATION_STATE" }, state: persisted, authority: "CONVERSATION_STATE" };
  }

  if (productStateQuestion(input.customer_text) && activeAircons(persisted).length > 0) {
    return { handled: true, reply: formatAirconBreakdown(persisted), metadata: { ...commonMeta, response_route: "commerce_known_state", answer_authority: "CONVERSATION_STATE" }, state: persisted, authority: "CONVERSATION_STATE" };
  }

  const calculationTerms = buildCalculationTerms(persisted, input.customer_text);
  const professional = isProfessionalSiteQuestion(input.customer_text);
  const currentFact = isCurrentBusinessFact(input.customer_text);
  const decision = resolveCommerceAnswerAuthority({
    question: input.customer_text,
    state: persisted,
    calculation_terms: calculationTerms,
    calculation_currency: "HKD",
    requires_current_business_fact: currentFact,
    requires_current_price_or_stock: currentFact && /(?:價|价|price|stock|庫存|库存|有貨|有货)/i.test(input.customer_text),
    requires_professional_site_check: professional,
    unsafe_to_remote_confirm: professional && /(?:安全|保證|保证|結構|结构|電力|电力|wiring|electrical)/i.test(input.customer_text),
  });

  if (decision.authority === "CONVERSATION_STATE") {
    return { handled: true, reply: knownValueReply(decision.known_value, decision.state_path, input.language), metadata: { ...commonMeta, response_route: "commerce_known_state", answer_authority: decision.authority, state_path: decision.state_path ?? null }, state: persisted, authority: decision.authority };
  }
  if (decision.authority === "DETERMINISTIC_CALCULATION" && decision.calculation) {
    const amount = decision.calculation.result.toLocaleString("en-US", { maximumFractionDigits: 2 });
    const reply = input.language === "en"
      ? `Using only the customer-reported historical figures already in this conversation, the deterministic total is HK$${amount}. This is a historical calculation only; the latest price and engineering charges still need current confirmation.`
      : input.language === "zh-CN"
      ? `只按这段对话里客户提供的历史数字计算，确定性合计是 HK$${amount}。这只是历史报价计算；最新价格和工程费仍需重新确认。`
      : `只按你之前喺對話提供嘅歷史數字計，確定性合計係 HK$${amount}。呢個只係歷史報價計算；最新價同工程費仍然要重新確認。`;
    return { handled: true, reply, metadata: { ...commonMeta, response_route: "commerce_deterministic_calculation", answer_authority: decision.authority, calculation_expression: decision.calculation.expression }, state: persisted, authority: decision.authority };
  }
  if (decision.authority === "SAFE_PROFESSIONAL_CONFIRMATION") {
    const reply = input.language === "en"
      ? "I’ve kept the site/engineering item as pending. I can retain the details you already provided, but I shouldn’t guarantee safety, feasibility, or the final charge remotely; a qualified installer needs to confirm the site conditions."
      : input.language === "zh-CN"
      ? "我已把这个现场／工程项目保留为待确认。你之前提供的资料我会继续记住，但安全性、可行性或最终工程费不能远程保证，需要合资格师傅现场确认。"
      : "我已經將呢個現場／工程項目保留做待確認。你之前提供嘅資料我會繼續記住，但安全性、可行性或者最終工程費唔應該遙距保證，要由合資格師傅現場確認。";
    return { handled: true, reply, metadata: { ...commonMeta, response_route: "commerce_safe_professional_confirmation", answer_authority: decision.authority }, state: persisted, authority: decision.authority };
  }
  if (decision.authority === "CURRENT_KB_REQUIRED") {
    return { handled: false, metadata: { ...commonMeta, commerce_route: "current_kb_required", answer_authority: decision.authority }, state: persisted, authority: decision.authority };
  }

  return { handled: false, metadata: { ...commonMeta, commerce_route: "continue_existing_orchestration", answer_authority: decision.authority }, state: persisted, authority: decision.authority };
}
