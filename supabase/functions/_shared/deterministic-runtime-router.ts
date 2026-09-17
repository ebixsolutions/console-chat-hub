/** Network-free compatibility boundary for deterministic runtime call sites. */
import {
  classifyIntent,
  detectLocale,
  extractEntities,
  normalizeCustomerText,
  runDeterministicCommerceEngine,
} from "./deterministic-commerce-engine.ts";
import { COMMERCE_SEMANTIC_FRAME_VERSION } from "./commerce-semantic-frame.ts";

export type LlmFailureCode =
  | "LLM_CONFIG_MISSING"
  | "LLM_INPUT_BLOCKED"
  | "LLM_TIMEOUT"
  | "LLM_NETWORK"
  | "LLM_NON_2XX"
  | "LLM_INVALID_OUTPUT"
  | "LLM_GROUNDING_REJECTED";
export type DeterministicFailureCode = LlmFailureCode;
export interface DeterministicCall {
  purpose: "evaluation" | "assist" | "generation";
  system: string;
  user: string;
  maxTokens: number;
  operationId: string;
  companyId: string | null;
  conversationId: string | null;
  tag: string;
  responseFormat?: "json" | "text";
  responseSchema?: Record<string, unknown>;
  thinkingBudget?: number;
  signal?: AbortSignal;
}

const redactions: Array<[RegExp, string]> = [
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[EMAIL]"],
  [/\+?\d[\d\s\-()]{6,}\d/g, "[PHONE]"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "[CARD]"],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "[UUID]",
  ],
];

export function redact(input: string): string {
  return redactions.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    input,
  );
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : null;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const value = JSON.parse(raw.slice(start, end + 1));
      return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : null;
    } catch {
      return null;
    }
  }
}

export function resolveGenerationMaxTokens(): number {
  return 2048;
}

export function toCeErrorCode(code: DeterministicFailureCode): string {
  return code === "LLM_INPUT_BLOCKED"
    ? "CE_PROVIDER_INPUT_BLOCKED"
    : "CE_PROVIDER_INVALID_OUTPUT";
}

function latestCustomerText(user: string): string {
  const turnMatches = [
    ...user.matchAll(
      /\[Turn\s+\d+\s+(?:Visitor|Customer)\]\s*\n([\s\S]*?)(?=\n\n\[Turn\s+\d+|$)/giu,
    ),
  ];
  if (turnMatches.length) return normalizeCustomerText(turnMatches.at(-1)?.[1]);
  for (
    const label of [
      "Latest customer turn:",
      "Customer message:",
      "CURRENT REQUEST:",
      "Text to check:",
    ]
  ) {
    const index = user.lastIndexOf(label);
    if (index >= 0) {
      return normalizeCustomerText(
        user.slice(index + label.length).split("\n\n")[0],
      );
    }
  }
  return normalizeCustomerText(user.slice(-2000));
}

function semanticFrame(text: string) {
  const classification = classifyIntent(text);
  const entities = extractEntities(text);
  const lower = text.toLowerCase();
  const correction = /更正|改返|改為|改为|actually|correction|not that/iu.test(
    text,
  );
  const cancellation = /取消|唔要|不要了|cancel/iu.test(text);
  const operation = cancellation
    ? "CANCEL_ITEM"
    : correction
    ? "UPDATE_ITEM"
    : classification.intent === "calculation"
    ? "ASK_CALCULATION"
    : [
        "shipping_delivery",
        "stock_availability",
        "returns_refunds",
        "checkout_payment",
        "crm_entitlement_vip",
      ].includes(classification.intent)
    ? "ASK_FACT"
    : "NO_STATE_CHANGE";
  const capabilities = {
    requires_delivery: classification.intent === "shipping_delivery",
    supports_pickup: /pickup|自取|自提/iu.test(text),
    requires_installation: /install|安裝|安装/iu.test(text),
    requires_booking: /book|預約|预约/iu.test(text),
    requires_quote: /quote|報價|报价/iu.test(text),
    requires_site_check: /site check|上門|上门/iu.test(text),
    digital_fulfilment: false,
    recurring_billing: /subscription|訂閱|订阅/iu.test(text),
    rental_return: /rental|租/iu.test(text),
    customization: /custom|訂造|订造/iu.test(text),
  };
  return {
    version: COMMERCE_SEMANTIC_FRAME_VERSION,
    language: detectLocale(text),
    operation,
    intent: classification.intent,
    topic: classification.intent === "unknown" ? null : classification.intent,
    entities: entities.filter((entity) =>
      entity.kind === "sku_or_model" || entity.kind === "quantity"
    ).map((entity, index) => ({
      entity_ref: `det-${index + 1}`,
      name: String(entity.value),
      kind: "unknown",
      category_hint: null,
      sku: entity.kind === "sku_or_model" ? String(entity.value) : null,
      model: entity.kind === "sku_or_model" ? String(entity.value) : null,
      quantity: entity.kind === "quantity" ? Number(entity.value) : null,
      unit: entity.kind === "quantity" ? "unit" : null,
      attributes: {},
      constraints: {},
      capabilities,
      confidence: classification.confidence,
    })),
    referents: [],
    customer_correction: correction,
    additive: /另外|再加|additional|another/iu.test(text),
    explicit_negations: [
      ...lower.matchAll(/\b(?:not|never|no)\b|未|冇|沒有|没有|唔/giu),
    ].map((match) => match[0]).slice(0, 20),
    requested_facts: classification.intent === "unknown"
      ? []
      : [classification.intent],
    transaction_state: cancellation ? "cancelled" : "unknown",
    payment_state: /未付款|not paid/iu.test(text) ? "none" : "unknown",
    booking_state: /未預約|未预约|not booked/iu.test(text) ? "none" : "unknown",
    fulfillment_state: /未送到|not delivered/iu.test(text)
      ? "pending"
      : "unknown",
    ambiguity: {
      is_ambiguous: classification.confidence < 0.62,
      reasons: classification.confidence < 0.62 ? ["low_confidence"] : [],
      clarification_question: classification.confidence < 0.62
        ? "Please clarify the product or order you mean."
        : null,
    },
    confidence: classification.confidence,
  };
}

function signalPayload(user: string) {
  const ids = [
    ...user.matchAll(/#([0-9a-f-]{8,})\s*\nrole=(?:customer|visitor)/giu),
  ].map((match) => match[1]).slice(0, 40);
  return {
    emotion: ids.map((id, index) => ({
      message_id: id,
      turn_index: index,
      sentiment: "neutral",
      sentiment_score: 0,
      trigger_label: "deterministic_no_unverified_emotion_inference",
    })),
    next_steps: [{
      ordinal: 0,
      title: "Review verified facts",
      detail:
        "Use only tenant-scoped KB, CRM and canonical conversation state before taking action.",
      owner_role: "agent",
    }],
  };
}

function deterministicJson(
  call: DeterministicCall,
  text: string,
): Record<string, unknown> {
  if (call.tag.includes("commerce-semantic")) return semanticFrame(text);
  if (call.tag.includes("signals")) return signalPayload(call.user);
  if (call.tag.includes("kb-query-expansion")) return { queries: [] };
  if (call.tag.includes("kb-relevance-rerank")) {
    return { relevant: false, confidence: 0 };
  }
  if (call.tag.includes("policy")) {
    return {
      status: "insufficient_evidence",
      summary:
        "Deterministic policy matching found no exact approved policy binding.",
    };
  }
  if (call.tag.startsWith("ce:")) {
    return {
      score: 50,
      justification:
        "Deterministic runtime evaluation is conservative and is not quality-gate evidence.",
      evidence: [
        redact(text).slice(0, 480) || "No customer-visible text supplied.",
      ],
      grounding_refs: [],
      recommended_correction: "",
    };
  }
  const outcome = runDeterministicCommerceEngine({ text, market: "UNKNOWN" });
  return {
    suggestions: [{ content: outcome.response, tone_label: "Informative" }],
    translated_text: text,
    source_language: outcome.locale,
    target_language: outcome.locale,
    corrected_text: text,
  };
}

export async function callModel(call: DeterministicCall): Promise<
  | {
    ok: true;
    text: string;
    model: string;
    usage: {
      input_tokens: 0;
      output_tokens: 0;
      latency_ms: number;
      attempts: 1;
    };
    request_id: string;
  }
  | {
    ok: false;
    code: DeterministicFailureCode;
    request_id: string;
    usage: {
      input_tokens: 0;
      output_tokens: 0;
      latency_ms: number;
      attempts: 0;
    };
  }
> {
  const started = Date.now();
  if (call.signal?.aborted) {
    return {
      ok: false,
      code: "LLM_INVALID_OUTPUT",
      request_id: call.operationId,
      usage: { input_tokens: 0, output_tokens: 0, latency_ms: 0, attempts: 0 },
    };
  }
  const text = latestCustomerText(call.user);
  try {
    const output = call.responseFormat === "json"
      ? JSON.stringify(deterministicJson(call, text))
      : runDeterministicCommerceEngine({ text, market: "UNKNOWN" }).response;
    return {
      ok: true,
      text: output,
      model: "deterministic-commerce-engine",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: Date.now() - started,
        attempts: 1,
      },
      request_id: call.operationId,
    };
  } catch {
    return {
      ok: false,
      code: "LLM_INVALID_OUTPUT",
      request_id: call.operationId,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: Date.now() - started,
        attempts: 0,
      },
    };
  }
}
