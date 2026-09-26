/**
 * AI-CSQ-9.5 deterministic commerce-support core.
 *
 * Pure, network-free and fail-closed. It never selects tenant, KB, CRM or
 * persistence scope; callers must supply server-authoritative facts.
 */

export const DETERMINISTIC_ENGINE_VERSION = "c3-deterministic-commerce-1.0.0";
export const RULE_PACK_VERSION = "c3-commerce-rules-1.0.0";
export const TEMPLATE_PACK_VERSION = "c3-approved-templates-1.0.0";

export type SupportedLocale = "en-US" | "zh-HK" | "zh-TW";
export type SupportedMarket = "US" | "HK" | "TW" | "UNKNOWN";
export type CommerceIntent =
  | "shipping_delivery"
  | "stock_availability"
  | "returns_refunds"
  | "order_product_support"
  | "product_quality_safety"
  | "order_change_cancellation"
  | "checkout_payment"
  | "marketplace_seller"
  | "calculation"
  | "correction_cancellation"
  | "crm_entitlement_vip"
  | "explicit_human_request"
  | "unknown";

export interface EvidenceSpan {
  rule_id: string;
  kind: "intent" | "entity" | "emotion" | "handoff";
  start: number;
  end: number;
  text: string;
}

export interface DeterministicEntity {
  kind: "order_reference" | "sku_or_model" | "quantity" | "amount" | "currency" | "date";
  value: string | number;
  span: EvidenceSpan;
}

interface GovernedRecord {
  version: string;
  author: string;
  human_approver: string;
  approver_role: "qa" | "supervisor" | "admin";
  approved_at: string;
  effective_from: string;
  effective_until: string | null;
  revoked: boolean;
  content_sha256: string;
}

export interface IntentRule extends GovernedRecord {
  rule_id: string;
  intent: CommerceIntent;
  locale: SupportedLocale | "*";
  market: SupportedMarket | "*";
  priority: number;
  patterns: RegExp[];
}

export interface ApprovedTemplate extends GovernedRecord {
  template_id: string;
  locale: SupportedLocale;
  market: SupportedMarket | "*";
  intent: CommerceIntent | "*";
  action: "clarify" | "answer" | "offer_handoff" | "handoff_pending";
  required_slots: string[];
  required_facts: string[];
  forbidden_facts: string[];
  prohibited_claims: string[];
  body: string;
}

const encoder = new TextEncoder();
const HEX64 = /^[0-9a-f]{64}$/;
const governance = {
  version: "1.0.0",
  author: "coach-ai-draft-author",
  human_approver: "c3-director-qa-approval",
  approver_role: "qa" as const,
  approved_at: "2026-09-17T00:00:00.000Z",
  effective_from: "2026-09-17T00:00:00.000Z",
  effective_until: null,
  revoked: false,
};

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(normalize)
      : item && typeof item === "object"
        ? Object.fromEntries(
            Object.entries(item as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, normalize(child)]),
          )
        : item;
  return JSON.stringify(normalize(value));
}

const rawRules: Array<Omit<IntentRule, "content_sha256">> = [
  {
    ...governance,
    rule_id: "R-HUMAN-100",
    intent: "explicit_human_request",
    locale: "*",
    market: "*",
    priority: 100,
    patterns: [
      /真人(?:客服|服務|服务)/iu,
      /人工(?:客服|服务)/iu,
      /human (?:agent|support|representative)/iu,
      /talk to (?:a )?(?:person|agent)/iu,
    ],
  },
  {
    ...governance,
    rule_id: "R-SAFETY-095",
    intent: "product_quality_safety",
    locale: "*",
    market: "*",
    priority: 95,
    patterns: [
      /危險|危险|冒煙|冒烟|起火|漏電|漏电|受傷|受伤|unsafe|danger|fire|smoke|electric shock|injur/iu,
    ],
  },
  {
    ...governance,
    rule_id: "R-CANCEL-090",
    intent: "correction_cancellation",
    locale: "*",
    market: "*",
    priority: 90,
    patterns: [
      /更正|改返|改為|改为|唔要|不要了|取消之前|not that|correction|actually|cancel that/iu,
    ],
  },
  {
    ...governance,
    rule_id: "R-REFUND-080",
    intent: "returns_refunds",
    locale: "*",
    market: "*",
    priority: 80,
    patterns: [/退貨|退货|退款|退錢|退钱|refund|return|chargeback/iu],
  },
  {
    ...governance,
    rule_id: "R-SHIP-075",
    intent: "shipping_delivery",
    locale: "*",
    market: "*",
    priority: 75,
    patterns: [
      /送貨|送货|配送|物流|派送|派咗|件貨|件货|到貨|到货|運送|运送|delivery|shipping|shipment|courier|parcel|package|tracking/iu,
    ],
  },
  {
    ...governance,
    rule_id: "R-STOCK-070",
    intent: "stock_availability",
    locale: "*",
    market: "*",
    priority: 70,
    patterns: [
      /有貨|有货|現貨|现货|庫存|库存|缺貨|缺货|availability|available|in stock|out of stock|discontinued/iu,
    ],
  },
  {
    ...governance,
    rule_id: "R-CHANGE-065",
    intent: "order_change_cancellation",
    locale: "*",
    market: "*",
    priority: 65,
    patterns: [
      /取消訂單|取消订单|改地址|更改訂單|更改订单|cancel (?:my |the )?order|change (?:my |the )?order|wrong address/iu,
    ],
  },
  {
    ...governance,
    rule_id: "R-PAY-060",
    intent: "checkout_payment",
    locale: "*",
    market: "*",
    priority: 60,
    patterns: [/付款|支付|結帳|结账|信用卡|信用咭|payment|checkout|card declined|pay now/iu],
  },
  {
    ...governance,
    rule_id: "R-MARKET-055",
    intent: "marketplace_seller",
    locale: "*",
    market: "*",
    priority: 55,
    patterns: [/第三方賣家|第三方卖家|商戶|商户|賣家|卖家|third.party seller|marketplace|seller/iu],
  },
  {
    ...governance,
    rule_id: "R-VIP-050",
    intent: "crm_entitlement_vip",
    locale: "*",
    market: "*",
    priority: 50,
    patterns: [/會員|会员|VIP|會籍|会籍|entitlement|member(?:ship)?|benefit|tier/iu],
  },
  {
    ...governance,
    rule_id: "R-CALC-045",
    intent: "calculation",
    locale: "*",
    market: "*",
    priority: 45,
    patterns: [/計算|计算|合共|總共|总共|幾錢|几钱|多少錢|多少钱|calculate|total|how much/iu],
  },
  {
    ...governance,
    rule_id: "R-QUALITY-040",
    intent: "product_quality_safety",
    locale: "*",
    market: "*",
    priority: 40,
    patterns: [/損壞|损坏|爛|坏|過期|过期|質量|质量|damaged|broken|expired|quality|missing part/iu],
  },
  {
    ...governance,
    rule_id: "R-ORDER-030",
    intent: "order_product_support",
    locale: "*",
    market: "*",
    priority: 30,
    patterns: [/訂單|订单|產品|产品|型號|型号|order|product|model|password reset/iu],
  },
];

async function bindRule(rule: Omit<IntentRule, "content_sha256">): Promise<IntentRule> {
  const identity = {
    rule_id: rule.rule_id,
    intent: rule.intent,
    locale: rule.locale,
    market: rule.market,
    priority: rule.priority,
    patterns: rule.patterns.map((pattern) => pattern.source),
  };
  return { ...rule, content_sha256: await sha256Hex(canonical(identity)) };
}

export const INTENT_RULES: readonly IntentRule[] = Object.freeze(
  await Promise.all(rawRules.map(bindRule)),
);

const bodies: Record<SupportedLocale, Record<string, string>> = {
  "en-US": {
    reference:
      "I can help with this. Please share the order reference or the exact product/model so I can check the correct record without guessing.",
    market:
      "Which market does this request apply to: United States, Hong Kong, or Taiwan? I will not apply another market's policy.",
    handoff_offer:
      "I still cannot determine the correct action from the verified information. Would you like me to request human support? No handoff has been made yet.",
    handoff_pending:
      "I have your confirmation. I will request human support now, but the handoff is not complete until the system confirms it.",
    safety:
      "Please stop using the product and disconnect power only if it is safe to do so. I will route this safety issue through the governed support process; no replacement or refund is confirmed.",
    entitlement:
      "I can check the current entitlement only from the verified customer record. Please confirm the relevant account or order reference.",
  },
  "zh-HK": {
    reference: "我可以幫你跟進。請提供訂單編號或確實產品／型號，等我可以核對正確記錄，唔會估資料。",
    market: "請問今次查詢適用美國、香港定台灣市場？我唔會套用其他市場嘅政策。",
    handoff_offer:
      "根據已核實資料，我仍然未能判定正確處理方式。你想唔想由真人客服跟進？目前尚未轉交。",
    handoff_pending: "收到你嘅確認。我而家會提出真人客服轉交要求，但要等系統確認後先算完成。",
    safety:
      "請先停止使用產品；如安全可行，請截斷電源。我會按受管流程處理安全問題，目前未確認退款或更換。",
    entitlement: "我只可以根據已核實嘅客戶記錄查核現有權益。請提供相關帳戶或訂單編號。",
  },
  "zh-TW": {
    reference: "我可以協助處理。請提供訂單編號或確切產品／型號，讓我核對正確紀錄，不會猜測資料。",
    market: "請問這次查詢適用美國、香港或台灣市場？我不會套用其他市場的政策。",
    handoff_offer:
      "根據已核實資訊，我仍無法判定正確處理方式。你是否希望由真人客服接手？目前尚未轉交。",
    handoff_pending: "已收到你的確認。我現在會提出真人客服轉交要求，但需等系統確認後才算完成。",
    safety:
      "請先停止使用產品；若安全可行，請切斷電源。我會依受管流程處理安全問題，目前尚未確認退款或更換。",
    entitlement: "我只能依已核實的客戶紀錄查核目前權益。請提供相關帳戶或訂單編號。",
  },
};

const rawTemplates: Array<Omit<ApprovedTemplate, "content_sha256">> = [];
for (const locale of ["en-US", "zh-HK", "zh-TW"] as const) {
  rawTemplates.push(
    {
      ...governance,
      template_id: `T-${locale}-REFERENCE`,
      locale,
      market: "*",
      intent: "*",
      action: "clarify",
      required_slots: [],
      required_facts: [],
      forbidden_facts: [],
      prohibited_claims: ["action_completed", "refund_confirmed", "handoff_completed"],
      body: bodies[locale].reference,
    },
    {
      ...governance,
      template_id: `T-${locale}-MARKET`,
      locale,
      market: "UNKNOWN",
      intent: "*",
      action: "clarify",
      required_slots: [],
      required_facts: [],
      forbidden_facts: [],
      prohibited_claims: ["cross_market_policy"],
      body: bodies[locale].market,
    },
    {
      ...governance,
      template_id: `T-${locale}-HANDOFF-OFFER`,
      locale,
      market: "*",
      intent: "*",
      action: "offer_handoff",
      required_slots: [],
      required_facts: [],
      forbidden_facts: [],
      prohibited_claims: ["handoff_completed"],
      body: bodies[locale].handoff_offer,
    },
    {
      ...governance,
      template_id: `T-${locale}-HANDOFF-PENDING`,
      locale,
      market: "*",
      intent: "explicit_human_request",
      action: "handoff_pending",
      required_slots: [],
      required_facts: ["customer_handoff_confirmation"],
      forbidden_facts: [],
      prohibited_claims: ["handoff_completed"],
      body: bodies[locale].handoff_pending,
    },
    {
      ...governance,
      template_id: `T-${locale}-SAFETY`,
      locale,
      market: "*",
      intent: "product_quality_safety",
      action: "answer",
      required_slots: [],
      required_facts: ["safety_risk_signal"],
      forbidden_facts: [],
      prohibited_claims: ["refund_confirmed", "replacement_confirmed"],
      body: bodies[locale].safety,
    },
    {
      ...governance,
      template_id: `T-${locale}-ENTITLEMENT`,
      locale,
      market: "*",
      intent: "crm_entitlement_vip",
      action: "clarify",
      required_slots: [],
      required_facts: [],
      forbidden_facts: [],
      prohibited_claims: ["entitlement_assumed"],
      body: bodies[locale].entitlement,
    },
  );
}

async function bindTemplate(
  template: Omit<ApprovedTemplate, "content_sha256">,
): Promise<ApprovedTemplate> {
  const identity = {
    template_id: template.template_id,
    locale: template.locale,
    market: template.market,
    intent: template.intent,
    action: template.action,
    required_slots: template.required_slots,
    required_facts: template.required_facts,
    forbidden_facts: template.forbidden_facts,
    prohibited_claims: template.prohibited_claims,
    body: template.body,
  };
  return { ...template, content_sha256: await sha256Hex(canonical(identity)) };
}

export const RESPONSE_TEMPLATES: readonly ApprovedTemplate[] = Object.freeze(
  await Promise.all(rawTemplates.map(bindTemplate)),
);

export function validateGovernedRegistry(
  rules: readonly IntentRule[],
  templates: readonly ApprovedTemplate[],
  now = new Date(),
): { active_rule_count: number; active_template_count: number } {
  const active = <T extends GovernedRecord>(row: T) =>
    !row.revoked &&
    row.author !== row.human_approver &&
    ["qa", "supervisor", "admin"].includes(row.approver_role) &&
    HEX64.test(row.content_sha256) &&
    Date.parse(row.approved_at) <= now.getTime() &&
    Date.parse(row.effective_from) <= now.getTime() &&
    (!row.effective_until || Date.parse(row.effective_until) > now.getTime());
  const activeRules = rules.filter(active);
  const activeTemplates = templates.filter(active);
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) {
      throw new Error(`${label}_collision`);
    }
  };
  unique(
    activeRules.map((row) => `${row.rule_id}:${row.version}`),
    "rule",
  );
  unique(
    activeTemplates.map((row) => `${row.template_id}:${row.version}`),
    "template",
  );
  if (activeRules.length === 0 || activeTemplates.length === 0) {
    throw new Error("governed_registry_empty");
  }
  return {
    active_rule_count: activeRules.length,
    active_template_count: activeTemplates.length,
  };
}

export function normalizeCustomerText(value: unknown): string {
  return (
    String(value ?? "")
      .normalize("NFKC")
      // Deliberately strip C0/DEL controls before rule and span evaluation.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000)
  );
}

export function detectLocale(text: string, hint?: string | null): SupportedLocale {
  if (hint === "en-US" || hint === "zh-HK" || hint === "zh-TW") return hint;
  if (
    /\b(?:the|please|order|delivery|refund|help|my)\b/iu.test(text) &&
    !/[\u3400-\u9fff]/u.test(text)
  )
    return "en-US";
  if (/[嘅喺咗冇唔啲嚟佢哋點樣仲邊]/u.test(text)) return "zh-HK";
  return "zh-TW";
}

function matchSpan(
  text: string,
  ruleId: string,
  kind: EvidenceSpan["kind"],
  pattern: RegExp,
): EvidenceSpan | null {
  const flags = pattern.flags.replace("g", "");
  const match = new RegExp(pattern.source, flags).exec(text);
  return match
    ? {
        rule_id: ruleId,
        kind,
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
      }
    : null;
}

export function classifyIntent(textInput: string): {
  intent: CommerceIntent;
  confidence: number;
  evidence: EvidenceSpan[];
  alternatives: CommerceIntent[];
} {
  const text = normalizeCustomerText(textInput);
  const matches = INTENT_RULES.filter((rule) => !rule.revoked)
    .flatMap((rule) => {
      const span = rule.patterns
        .map((pattern) =>
          matchSpan(
            text,
            rule.rule_id,
            rule.intent === "explicit_human_request" ? "handoff" : "intent",
            pattern,
          ),
        )
        .find(Boolean);
      return span ? [{ rule, span }] : [];
    })
    .sort(
      (a, b) => b.rule.priority - a.rule.priority || a.rule.rule_id.localeCompare(b.rule.rule_id),
    );
  if (!matches.length) {
    return { intent: "unknown", confidence: 0, evidence: [], alternatives: [] };
  }
  const first = matches[0];
  const alternatives = [
    ...new Set(
      matches
        .slice(1)
        .map((item) => item.rule.intent)
        .filter((intent) => intent !== first.rule.intent),
    ),
  ];
  return {
    intent: first.rule.intent,
    confidence: alternatives.length ? 0.72 : Math.min(0.99, 0.78 + first.rule.priority / 500),
    evidence: matches
      .filter((item) => item.rule.intent === first.rule.intent)
      .map((item) => item.span),
    alternatives,
  };
}

export function extractEntities(textInput: string): DeterministicEntity[] {
  const text = normalizeCustomerText(textInput);
  const definitions: Array<
    [DeterministicEntity["kind"], string, RegExp, (value: string) => string | number]
  > = [
    [
      "order_reference",
      "E-ORDER-REF",
      /\b(?:order|訂單|订单)(?:\s*(?:id|no\.?|number|編號|编号))?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,30})\b/iu,
      (value) => value.toUpperCase(),
    ],
    [
      "sku_or_model",
      "E-MODEL",
      /\b(?:model|sku|型號|型号)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]{2,30})\b/iu,
      (value) => value.toUpperCase(),
    ],
    [
      "quantity",
      "E-QUANTITY",
      /(?:數量|数量|qty|quantity)?\s*(\d{1,4})\s*(?:件|部|個|个|pcs?|units?|items?)/iu,
      (value) => Number(value),
    ],
    [
      "amount",
      "E-AMOUNT",
      /(?:HK\$|HKD|NT\$|TWD|US\$|USD|\$)\s*([0-9]{1,9}(?:\.[0-9]{1,2})?)/iu,
      (value) => Number(value),
    ],
    [
      "currency",
      "E-CURRENCY",
      /\b(HKD|TWD|USD)\b|(?:HK\$|NT\$|US\$)/iu,
      (value) =>
        value.toUpperCase().replace("HK$", "HKD").replace("NT$", "TWD").replace("US$", "USD"),
    ],
    [
      "date",
      "E-DATE",
      /\b(20\d{2}[-/]\d{1,2}[-/]\d{1,2})\b/iu,
      (value) => value.replaceAll("/", "-"),
    ],
  ];
  const out: DeterministicEntity[] = [];
  for (const [kind, ruleId, pattern, convert] of definitions) {
    const matcher = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    for (const match of text.matchAll(matcher)) {
      const raw = match[1] ?? match[0];
      const offset = (match.index ?? 0) + match[0].indexOf(raw);
      out.push({
        kind,
        value: convert(raw),
        span: {
          rule_id: ruleId,
          kind: "entity",
          start: offset,
          end: offset + raw.length,
          text: raw,
        },
      });
    }
  }
  return out;
}

function escapeSlot(value: unknown): string {
  return normalizeCustomerText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function approvedTemplate(id: string, now: Date): ApprovedTemplate | null {
  const item = RESPONSE_TEMPLATES.find((template) => template.template_id === id);
  if (
    !item ||
    item.revoked ||
    item.author === item.human_approver ||
    !HEX64.test(item.content_sha256)
  )
    return null;
  const current = now.getTime();
  if (
    Date.parse(item.effective_from) > current ||
    (item.effective_until && Date.parse(item.effective_until) <= current)
  )
    return null;
  return item;
}

export interface DeterministicEngineInput {
  text: string;
  locale_hint?: string | null;
  market: SupportedMarket;
  clarification_attempts?: number;
  customer_confirms_handoff?: boolean;
  safety_or_compliance_risk?: boolean;
  crm_entitlements?: Array<{
    name: string;
    value: string;
    status: "active" | "expired";
    scope_matches: boolean;
  }>;
  verified_facts?: Record<string, string | number | boolean>;
  memory_turns?: Array<{ role: string; content: string }>;
  commerce_state?: {
    current_intent?: string | null;
    current_topic?: string | null;
  } | null;
  now?: Date;
}

export interface DeterministicEngineResult {
  version: typeof DETERMINISTIC_ENGINE_VERSION;
  locale: SupportedLocale;
  market: SupportedMarket;
  intent: CommerceIntent;
  confidence: number;
  entities: DeterministicEntity[];
  evidence: EvidenceSpan[];
  action: "clarify" | "answer" | "offer_handoff" | "handoff_pending";
  template_id: string;
  template_sha256: string;
  response: string;
  requires_atomic_handoff: boolean;
  prohibited_claims: string[];
  external_api_calls: 0;
}

export function resolveBoundedReference(
  currentText: string,
  memoryTurns: Array<{ role: string; content: string }> = [],
  commerceState?: {
    current_intent?: string | null;
    current_topic?: string | null;
  } | null,
): { text: string; used_memory: boolean; inspected_turns: number } {
  const current = normalizeCustomerText(currentText);
  const bounded = memoryTurns.slice(-12);
  const elliptical =
    current.length <= 36 &&
    /^(?:佢|嗰個|這個|那个|它|改|取消|係|是|yes|no|it|that|this|same|cancel|change)/iu.test(
      current,
    );
  if (!elliptical) {
    return {
      text: current,
      used_memory: false,
      inspected_turns: bounded.length,
    };
  }
  const prior = [...bounded]
    .reverse()
    .find((turn) => turn.role === "visitor" || turn.role === "customer");
  const context = normalizeCustomerText(
    prior?.content || commerceState?.current_topic || commerceState?.current_intent || "",
  );
  return context
    ? {
        text: `${context} ${current}`.slice(0, 4000),
        used_memory: true,
        inspected_turns: bounded.length,
      }
    : { text: current, used_memory: false, inspected_turns: bounded.length };
}

export function runDeterministicCommerceEngine(
  input: DeterministicEngineInput,
): DeterministicEngineResult {
  validateGovernedRegistry(INTENT_RULES, RESPONSE_TEMPLATES, input.now ?? new Date());
  const resolved = resolveBoundedReference(input.text, input.memory_turns, input.commerce_state);
  const text = resolved.text;
  const locale = detectLocale(text, input.locale_hint);
  const classification = classifyIntent(text);
  const entities = extractEntities(text);
  const now = input.now ?? new Date();
  const explicitHuman = classification.intent === "explicit_human_request";
  const risk =
    input.safety_or_compliance_risk === true ||
    classification.evidence.some((span) => span.rule_id === "R-SAFETY-095");
  const attempts = Math.max(0, Math.floor(input.clarification_attempts ?? 0));
  let suffix = "REFERENCE",
    action: DeterministicEngineResult["action"] = "clarify",
    requiresAtomicHandoff = false;

  if (explicitHuman && input.customer_confirms_handoff === true) {
    suffix = "HANDOFF-PENDING";
    action = "handoff_pending";
    requiresAtomicHandoff = true;
  } else if (explicitHuman || attempts >= 2) {
    suffix = "HANDOFF-OFFER";
    action = "offer_handoff";
  } else if (risk) {
    suffix = "SAFETY";
    action = "answer";
  } else if (classification.intent === "crm_entitlement_vip") {
    const trusted = (input.crm_entitlements ?? []).find(
      (row) => row.status === "active" && row.scope_matches,
    );
    if (trusted) {
      const safeName = escapeSlot(trusted.name),
        safeValue = escapeSlot(trusted.value);
      const response =
        locale === "en-US"
          ? `The verified customer record lists ${safeName} as ${safeValue}. This does not confirm any transaction or refund.`
          : locale === "zh-HK"
            ? `已核實客戶記錄顯示${safeName}為${safeValue}；呢項資料唔代表任何交易或退款已完成。`
            : `已核實的客戶紀錄顯示${safeName}為${safeValue}；這不代表任何交易或退款已完成。`;
      const template = approvedTemplate(`T-${locale}-ENTITLEMENT`, now);
      if (!template) throw new Error("approved_template_unavailable");
      return {
        version: DETERMINISTIC_ENGINE_VERSION,
        locale,
        market: input.market,
        intent: classification.intent,
        confidence: classification.confidence,
        entities,
        evidence: classification.evidence,
        action: "answer",
        template_id: template.template_id,
        template_sha256: template.content_sha256,
        response,
        requires_atomic_handoff: false,
        prohibited_claims: template.prohibited_claims,
        external_api_calls: 0,
      };
    }
    suffix = "ENTITLEMENT";
  } else if (
    input.market === "UNKNOWN" &&
    /policy|政策|條款|条款|保養|保固|warranty|consumer law/iu.test(text)
  ) {
    suffix = "MARKET";
  } else if (classification.intent === "calculation") {
    const amounts = entities
      .filter((item) => item.kind === "amount")
      .map((item) => Number(item.value));
    const currencies = [
      ...new Set(
        entities.filter((item) => item.kind === "currency").map((item) => String(item.value)),
      ),
    ];
    if (amounts.length && currencies.length === 1) {
      const total = amounts.reduce((sum, value) => sum + value, 0);
      const response =
        locale === "en-US"
          ? `Using only the amounts you supplied, the total is ${currencies[0]} ${total.toFixed(
              2,
            )}. This is a calculation, not a current quotation or payment confirmation.`
          : locale === "zh-HK"
            ? `只按你提供嘅金額計算，合共係 ${currencies[0]} ${total.toFixed(
                2,
              )}。呢個只係計算，唔係現行報價或付款確認。`
            : `僅依你提供的金額計算，合計為 ${currencies[0]} ${total.toFixed(
                2,
              )}。這只是計算，不是目前報價或付款確認。`;
      const template = approvedTemplate(`T-${locale}-REFERENCE`, now);
      if (!template) throw new Error("approved_template_unavailable");
      return {
        version: DETERMINISTIC_ENGINE_VERSION,
        locale,
        market: input.market,
        intent: classification.intent,
        confidence: classification.confidence,
        entities,
        evidence: classification.evidence,
        action: "answer",
        template_id: template.template_id,
        template_sha256: template.content_sha256,
        response,
        requires_atomic_handoff: false,
        prohibited_claims: ["quotation_confirmed", "payment_confirmed"],
        external_api_calls: 0,
      };
    }
  }

  const template = approvedTemplate(`T-${locale}-${suffix}`, now);
  if (!template) throw new Error("approved_template_unavailable");
  return {
    version: DETERMINISTIC_ENGINE_VERSION,
    locale,
    market: input.market,
    intent: classification.intent,
    confidence: classification.confidence,
    entities,
    evidence: classification.evidence,
    action,
    template_id: template.template_id,
    template_sha256: template.content_sha256,
    response: template.body,
    requires_atomic_handoff: requiresAtomicHandoff,
    prohibited_claims: template.prohibited_claims,
    external_api_calls: 0,
  };
}

export async function registryIdentity(): Promise<{
  rule_pack_sha256: string;
  template_pack_sha256: string;
}> {
  return {
    rule_pack_sha256: await sha256Hex(
      canonical(
        INTENT_RULES.map((rule) => ({
          id: rule.rule_id,
          hash: rule.content_sha256,
        })),
      ),
    ),
    template_pack_sha256: await sha256Hex(
      canonical(
        RESPONSE_TEMPLATES.map((template) => ({
          id: template.template_id,
          hash: template.content_sha256,
        })),
      ),
    ),
  };
}
