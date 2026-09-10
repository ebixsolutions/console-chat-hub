import type { CommerceEntity, ConversationCommerceState } from "./commerce-state-contract.ts";
import type { CommerceTurnEntityHint } from "./commerce-state-reducer.ts";

export type CommerceKind = "physical_product" | "digital_good" | "service" | "b2b_product" | "unknown";

export interface CommerceCapabilities {
  requires_delivery: boolean;
  requires_installation: boolean;
  requires_booking: boolean;
  requires_quote: boolean;
  requires_site_check: boolean;
  digital_fulfilment: boolean;
}

export interface GenericEntityExtraction {
  entity_id: string;
  category: string;
  display_name: string;
  quantity: number;
  unit: string | null;
  kind: CommerceKind;
  sku: string | null;
  variant: Record<string, string>;
  capabilities: CommerceCapabilities;
  aliases: string[];
}

const COUNT_TOKEN = "[一二兩两三四五六七八九十]|\\d{1,4}";
const GENERIC_UNIT = "件|個|个|盒|箱|包|袋|樽|瓶|支|枝|本|冊|册|套|對|对|雙|双|條|条|張|张|台|部|份|位|席|間|间|晚|次|堂|課|课|units?|pcs?|pieces?|items?|boxes?|bottles?|packs?|bags?|pairs?|sets?|seats?|nights?|sessions?|lessons?";

function clean(value: unknown, max = 1200): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function countValue(raw: string): number | null {
  const map: Record<string, number> = {
    一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  };
  if (/^\d+$/.test(raw)) return Number(raw);
  return map[raw] ?? null;
}

function trimCandidate(raw: string): string {
  return clean(raw, 80)
    .replace(/(?:請|请)?(?:報價|报价|幾錢|几钱|多少錢|多少钱|price|quote|quotation|total|合共|總共|总共).*$/i, "")
    .replace(/(?:星期[一二三四五六日天]|週[一二三四五六日天]|周[一二三四五六日天]|monday|tuesday|wednesday|thursday|friday|saturday|sunday).*$/i, "")
    .replace(/(?:HK\$|HKD|US\$|USD|NT\$|TWD|\$)\s*[0-9].*$/i, "")
    .replace(/[，。！？,.!?;；:：]+$/g, "")
    .trim();
}

function canonicalGenericName(raw: string): string {
  let value = trimCandidate(raw)
    .replace(/^(?:黑色|白色|紅色|红色|藍色|蓝色|綠色|绿色|黃色|黄色|粉紅|粉红|紫色|灰色|black|white|red|blue|green|yellow|pink|purple|grey|gray)\s*/i, "")
    .replace(/^(?:small|medium|large|xl|xxl|xs)\s+/i, "")
    .replace(/^(?:size\s*[xsml0-9-]+)\s+/i, "")
    .trim();
  if (/^[a-z0-9][a-z0-9 -]{3,}$/i.test(value) && /s$/i.test(value) && !/ss$/i.test(value)) {
    value = value.replace(/s$/i, "");
  }
  return value;
}

function slugify(raw: string): string {
  return canonicalGenericName(raw)
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function extractSku(text: string): string | null {
  const match = clean(text).match(/(?:SKU|貨號|货号|型號|型号|model)\s*(?:=|:|：|#)?\s*([A-Z0-9][A-Z0-9._\/-]{1,39})/i);
  return match?.[1] ? match[1].trim() : null;
}

function extractVariant(text: string): Record<string, string> {
  const t = clean(text);
  const variant: Record<string, string> = {};
  const size = t.match(/(?:size|尺寸|尺碼|尺码)\s*(?:=|:|：)?\s*([A-Z0-9-]{1,12})/i)
    ?? t.match(/\b([XSML]{1,4})\s*碼/i);
  if (size?.[1]) variant.size = size[1];
  const color = t.match(/(?:color|colour|顏色|颜色)\s*(?:=|:|：)?\s*([^，。,.!?！？]{1,24})/i);
  if (color?.[1]) variant.color = color[1].trim();
  else {
    const leading = t.match(/(黑色|白色|紅色|红色|藍色|蓝色|綠色|绿色|黃色|黄色|粉紅|粉红|紫色|灰色|black|white|red|blue|green|yellow|pink|purple|grey|gray)(?=\s|[A-Za-z\u3400-\u9fff])/i);
    if (leading?.[1]) variant.color = leading[1];
  }
  return variant;
}

function inferKind(text: string, unit: string | null, quantity: number): CommerceKind {
  const t = clean(text).toLowerCase();
  if (/(?:下載|下载|電子版|电子版|digital|download|software|license|licence|ebook|e-book|activation key|啟用碼|激活码)/i.test(t)) return "digital_good";
  if (/(?:預約|预约|appointment|book(?:ing)?|reserve|reservation|服務|服务|剪髮|剪发|療程|疗程|consultation|session|lesson|class)/i.test(t)
      || /^(?:位|席|次|堂|課|课|sessions?|lessons?|seats?)$/i.test(unit ?? "")) return "service";
  if (quantity >= 20 && /(?:批發|批发|MOQ|minimum order|wholesale|報價|报价|quotation|quote)/i.test(t)) return "b2b_product";
  if (unit || /(?:產品|产品|商品|貨品|货品|product|item)/i.test(t)) return "physical_product";
  return "unknown";
}

export function inferCommerceCapabilities(text: string, kind: CommerceKind): CommerceCapabilities {
  const t = clean(text).toLowerCase();
  const requiresInstallation = /(?:安裝|安装|install(?:ation)?|mount(?:ing)?|setup|拆機|拆机)/i.test(t);
  const requiresSiteCheck = requiresInstallation && /(?:上門|上门|site|onsite|on-site|窗口|窗台|牆|墙|承重|電壓|电压|排水|師傅|师傅|technician|survey)/i.test(t);
  const requiresBooking = kind === "service" || /(?:預約|预约|appointment|book(?:ing)?|reserve|reservation|時段|时段|slot)/i.test(t);
  const requiresDelivery = /(?:送貨|送货|配送|delivery|deliver|shipping|ship\b|寄送|收貨|收货|delivery address)/i.test(t);
  const requiresQuote = /(?:報價|报价|quotation|quote|幾錢|几钱|多少錢|多少钱|price|fee|收費|收费|MOQ)/i.test(t);
  return {
    requires_delivery: requiresDelivery,
    requires_installation: requiresInstallation,
    requires_booking: requiresBooking,
    requires_quote: requiresQuote,
    requires_site_check: requiresSiteCheck,
    digital_fulfilment: kind === "digital_good",
  };
}

function mergeCapabilities(a: CommerceCapabilities, b: CommerceCapabilities): CommerceCapabilities {
  return {
    requires_delivery: a.requires_delivery || b.requires_delivery,
    requires_installation: a.requires_installation || b.requires_installation,
    requires_booking: a.requires_booking || b.requires_booking,
    requires_quote: a.requires_quote || b.requires_quote,
    requires_site_check: a.requires_site_check || b.requires_site_check,
    digital_fulfilment: a.digital_fulfilment || b.digital_fulfilment,
  };
}

export function extractGenericCommerceEntity(text: string): GenericEntityExtraction | null {
  const t = clean(text);
  if (!t) return null;

  const action = "(?:我要|我想要|想買|想买|要買|要买|買|买|需要|訂購|订购|訂|订|預訂|预订|預約|预约|另外加|再加|加多|新增|I\\s+(?:want|need)|want|need|buy|order|pre[- ]?order|book|reserve|add)";
  const zhOrUnit = new RegExp(`${action}\\s*(${COUNT_TOKEN})\\s*(${GENERIC_UNIT})?\\s*([^，。！？,.!?;；]{1,60})`, "i");
  const match = t.match(zhOrUnit);
  if (!match?.[1] || !match?.[3]) return null;

  const quantity = countValue(match[1]);
  if (quantity === null || quantity <= 0) return null;
  const unit = match[2]?.trim() || null;
  const rawName = trimCandidate(match[3]);
  const canonicalName = canonicalGenericName(rawName);
  const slug = slugify(canonicalName);
  if (!canonicalName || !slug || canonicalName.length < 2) return null;

  const kind = inferKind(t, unit, quantity);
  const capabilities = inferCommerceCapabilities(t, kind);
  const category = kind === "service" ? "service"
    : kind === "digital_good" ? "digital_good"
    : kind === "b2b_product" ? "b2b_product"
    : "generic_product";
  const aliases = [...new Set([canonicalName, rawName].map((x) => clean(x, 80)).filter(Boolean))];

  return {
    entity_id: `generic:${slug}`,
    category,
    display_name: canonicalName,
    quantity,
    unit,
    kind,
    sku: extractSku(t),
    variant: extractVariant(t),
    capabilities,
    aliases,
  };
}

export function buildGenericCommerceEntityHints(texts: string[]): CommerceTurnEntityHint[] {
  const hints = new Map<string, CommerceTurnEntityHint>();
  for (const raw of texts) {
    const extracted = extractGenericCommerceEntity(raw);
    if (!extracted) continue;
    const next: CommerceTurnEntityHint = {
      entity_id: extracted.entity_id,
      category: extracted.category,
      aliases: extracted.aliases,
      quantity: extracted.quantity,
      attributes: {
        product_name: extracted.display_name,
        commerce_kind: extracted.kind,
        unit: extracted.unit,
        sku: extracted.sku,
        variant: extracted.variant,
        capabilities: extracted.capabilities,
      },
    };
    const existing = hints.get(extracted.entity_id);
    if (!existing) {
      hints.set(extracted.entity_id, next);
      continue;
    }
    const existingCaps = readCapabilitiesFromAttributes(existing.attributes);
    hints.set(extracted.entity_id, {
      ...existing,
      aliases: [...new Set([...(existing.aliases ?? []), ...extracted.aliases])],
      attributes: {
        ...(existing.attributes ?? {}),
        capabilities: mergeCapabilities(existingCaps, extracted.capabilities),
      },
    });
  }
  return [...hints.values()];
}

function readCapabilitiesFromAttributes(attributes: Record<string, unknown> | undefined): CommerceCapabilities {
  const raw = attributes?.capabilities;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return inferCommerceCapabilities("", "unknown");
  const r = raw as Record<string, unknown>;
  return {
    requires_delivery: r.requires_delivery === true,
    requires_installation: r.requires_installation === true,
    requires_booking: r.requires_booking === true,
    requires_quote: r.requires_quote === true,
    requires_site_check: r.requires_site_check === true,
    digital_fulfilment: r.digital_fulfilment === true,
  };
}

export function getEntityCapabilities(entity: CommerceEntity): CommerceCapabilities {
  return readCapabilitiesFromAttributes(entity.attributes);
}

export function aggregateCommerceCapabilities(state: ConversationCommerceState): CommerceCapabilities {
  const zero = inferCommerceCapabilities("", "unknown");
  return state.entities
    .filter((entity) => entity.status !== "cancelled" && entity.status !== "deferred")
    .reduce((acc, entity) => mergeCapabilities(acc, getEntityCapabilities(entity)), zero);
}

export function genericEntityLabelFromId(entityId: string): string | null {
  if (!entityId.startsWith("generic:")) return null;
  const raw = entityId.slice("generic:".length).replace(/-/g, " ").trim();
  return raw || null;
}

export function buildCapabilityAwarePreorderNextStep(
  state: ConversationCommerceState,
  language: "zh-TW" | "zh-CN" | "en",
): string {
  const caps = aggregateCommerceCapabilities(state);
  if (language === "en") {
    if (caps.requires_booking) return "The next step is to confirm the service or time slot, the final price, and then the payment arrangement.";
    if (caps.requires_installation || caps.requires_site_check) return "The next step is to confirm the final price, any installation or site requirements, and then the payment arrangement.";
    if (caps.requires_delivery) return "The next step is to confirm the final price and order details, delivery arrangements, and then payment.";
    if (caps.digital_fulfilment) return "The next step is to confirm the final price and order details, then arrange payment before digital fulfilment.";
    return "The next step is to confirm the final price and order details, then arrange payment.";
  }
  if (language === "zh-CN") {
    if (caps.requires_booking) return "下一步需要确认服务／预约时段和最终价格，再安排付款。";
    if (caps.requires_installation || caps.requires_site_check) return "下一步需要确认最终价格及适用的安装／现场条件，再安排付款。";
    if (caps.requires_delivery) return "下一步需要确认最终价格和订单资料、送货安排，再安排付款。";
    if (caps.digital_fulfilment) return "下一步需要确认最终价格和订单资料，再安排付款及数码交付。";
    return "下一步需要确认最终价格和订单资料，再安排付款。";
  }
  if (caps.requires_booking) return "下一步要確認服務／預約時段同最終價格，再安排付款。";
  if (caps.requires_installation || caps.requires_site_check) return "下一步要確認最終價格同適用嘅安裝／現場條件，再安排付款。";
  if (caps.requires_delivery) return "下一步要確認最終價格同訂單資料、送貨安排，再安排付款。";
  if (caps.digital_fulfilment) return "下一步要確認最終價格同訂單資料，再安排付款同數碼交付。";
  return "下一步要確認最終價格同訂單資料，再安排付款。";
}
