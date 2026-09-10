export const COMMERCE_SEMANTIC_FRAME_VERSION = "commerce-semantic-1.0.0" as const;

export type CommerceSemanticOperation =
  | "ADD_ITEM"
  | "SET_QUANTITY"
  | "UPDATE_ITEM"
  | "REMOVE_ITEM"
  | "CANCEL_ITEM"
  | "RESERVE"
  | "REQUEST_QUOTE"
  | "ASK_FACT"
  | "ASK_CALCULATION"
  | "CONFIRM"
  | "DEFER"
  | "NO_STATE_CHANGE";

export type CommerceSemanticKind =
  | "physical_product"
  | "digital_good"
  | "service"
  | "rental"
  | "subscription"
  | "ticket"
  | "custom_item"
  | "b2b_product"
  | "unknown";

export interface CommerceSemanticCapabilities {
  requires_delivery: boolean;
  supports_pickup: boolean;
  requires_installation: boolean;
  requires_booking: boolean;
  requires_quote: boolean;
  requires_site_check: boolean;
  digital_fulfilment: boolean;
  recurring_billing: boolean;
  rental_return: boolean;
  customization: boolean;
}

export interface CommerceSemanticEntity {
  entity_ref: string;
  name: string;
  kind: CommerceSemanticKind;
  category_hint: string | null;
  sku: string | null;
  model: string | null;
  quantity: number | null;
  unit: string | null;
  attributes: Record<string, string | number | boolean | null>;
  constraints: Record<string, string | number | boolean | null>;
  capabilities: CommerceSemanticCapabilities;
  confidence: number;
}

export interface CommerceSemanticReferent {
  ref: string;
  source: "current_turn" | "prior_turn" | "persistent_state" | "unknown";
  confidence: number;
}

export interface CommerceSemanticFrame {
  version: typeof COMMERCE_SEMANTIC_FRAME_VERSION;
  language: string;
  operation: CommerceSemanticOperation;
  intent: string;
  topic: string | null;
  entities: CommerceSemanticEntity[];
  referents: CommerceSemanticReferent[];
  customer_correction: boolean;
  additive: boolean;
  explicit_negations: string[];
  requested_facts: string[];
  confidence: number;
}

const OPERATIONS = new Set<CommerceSemanticOperation>([
  "ADD_ITEM", "SET_QUANTITY", "UPDATE_ITEM", "REMOVE_ITEM", "CANCEL_ITEM",
  "RESERVE", "REQUEST_QUOTE", "ASK_FACT", "ASK_CALCULATION", "CONFIRM",
  "DEFER", "NO_STATE_CHANGE",
]);
const KINDS = new Set<CommerceSemanticKind>([
  "physical_product", "digital_good", "service", "rental", "subscription",
  "ticket", "custom_item", "b2b_product", "unknown",
]);

export const COMMERCE_SEMANTIC_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    version: { type: "string", enum: [COMMERCE_SEMANTIC_FRAME_VERSION] },
    language: { type: "string" },
    operation: { type: "string", enum: [...OPERATIONS] },
    intent: { type: "string" },
    topic: { type: ["string", "null"] },
    entities: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          entity_ref: { type: "string" },
          name: { type: "string" },
          kind: { type: "string", enum: [...KINDS] },
          category_hint: { type: ["string", "null"] },
          sku: { type: ["string", "null"] },
          model: { type: ["string", "null"] },
          quantity: { type: ["number", "null"], minimum: 0 },
          unit: { type: ["string", "null"] },
          attributes: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
          constraints: { type: "object", additionalProperties: { type: ["string", "number", "boolean", "null"] } },
          capabilities: {
            type: "object",
            properties: {
              requires_delivery: { type: "boolean" },
              supports_pickup: { type: "boolean" },
              requires_installation: { type: "boolean" },
              requires_booking: { type: "boolean" },
              requires_quote: { type: "boolean" },
              requires_site_check: { type: "boolean" },
              digital_fulfilment: { type: "boolean" },
              recurring_billing: { type: "boolean" },
              rental_return: { type: "boolean" },
              customization: { type: "boolean" },
            },
            required: [
              "requires_delivery", "supports_pickup", "requires_installation",
              "requires_booking", "requires_quote", "requires_site_check",
              "digital_fulfilment", "recurring_billing", "rental_return", "customization",
            ],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: [
          "entity_ref", "name", "kind", "category_hint", "sku", "model",
          "quantity", "unit", "attributes", "constraints", "capabilities", "confidence",
        ],
      },
    },
    referents: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        properties: {
          ref: { type: "string" },
          source: { type: "string", enum: ["current_turn", "prior_turn", "persistent_state", "unknown"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["ref", "source", "confidence"],
      },
    },
    customer_correction: { type: "boolean" },
    additive: { type: "boolean" },
    explicit_negations: { type: "array", items: { type: "string" }, maxItems: 20 },
    requested_facts: { type: "array", items: { type: "string" }, maxItems: 20 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "version", "language", "operation", "intent", "topic", "entities", "referents",
    "customer_correction", "additive", "explicit_negations", "requested_facts", "confidence",
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clean(value: unknown, max = 300): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function primitiveMap(value: unknown): Record<string, string | number | boolean | null> {
  if (!isRecord(value)) return {};
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 40)) {
    const k = clean(key, 80);
    if (!k) continue;
    if (raw === null || typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      out[k] = typeof raw === "string" ? clean(raw, 300) : raw;
    }
  }
  return out;
}

function bool(value: unknown): boolean { return value === true; }

function normalizeCapabilities(raw: unknown): CommerceSemanticCapabilities {
  const r = isRecord(raw) ? raw : {};
  return {
    requires_delivery: bool(r.requires_delivery),
    supports_pickup: bool(r.supports_pickup),
    requires_installation: bool(r.requires_installation),
    requires_booking: bool(r.requires_booking),
    requires_quote: bool(r.requires_quote),
    requires_site_check: bool(r.requires_site_check),
    digital_fulfilment: bool(r.digital_fulfilment),
    recurring_billing: bool(r.recurring_billing),
    rental_return: bool(r.rental_return),
    customization: bool(r.customization),
  };
}

export function normalizeCommerceSemanticFrame(value: unknown): CommerceSemanticFrame | null {
  if (!isRecord(value)) return null;
  const operation = clean(value.operation, 40) as CommerceSemanticOperation;
  if (!OPERATIONS.has(operation)) return null;

  const entities: CommerceSemanticEntity[] = [];
  for (const raw of Array.isArray(value.entities) ? value.entities.slice(0, 12) : []) {
    if (!isRecord(raw)) continue;
    const kind = clean(raw.kind, 40) as CommerceSemanticKind;
    if (!KINDS.has(kind)) continue;
    const name = clean(raw.name, 200);
    if (!name) continue;
    const q = raw.quantity === null ? null : Number(raw.quantity);
    const quantity = q === null || !Number.isFinite(q) || q < 0 ? null : q;
    entities.push({
      entity_ref: clean(raw.entity_ref, 120) || `semantic:${entities.length + 1}`,
      name,
      kind,
      category_hint: raw.category_hint === null ? null : clean(raw.category_hint, 120) || null,
      sku: raw.sku === null ? null : clean(raw.sku, 120) || null,
      model: raw.model === null ? null : clean(raw.model, 120) || null,
      quantity,
      unit: raw.unit === null ? null : clean(raw.unit, 60) || null,
      attributes: primitiveMap(raw.attributes),
      constraints: primitiveMap(raw.constraints),
      capabilities: normalizeCapabilities(raw.capabilities),
      confidence: clampConfidence(raw.confidence),
    });
  }

  const referents: CommerceSemanticReferent[] = [];
  for (const raw of Array.isArray(value.referents) ? value.referents.slice(0, 12) : []) {
    if (!isRecord(raw)) continue;
    const source = clean(raw.source, 40) as CommerceSemanticReferent["source"];
    if (!["current_turn", "prior_turn", "persistent_state", "unknown"].includes(source)) continue;
    const ref = clean(raw.ref, 160);
    if (!ref) continue;
    referents.push({ ref, source, confidence: clampConfidence(raw.confidence) });
  }

  return {
    version: COMMERCE_SEMANTIC_FRAME_VERSION,
    language: clean(value.language, 40) || "und",
    operation,
    intent: clean(value.intent, 160) || "unknown",
    topic: value.topic === null ? null : clean(value.topic, 160) || null,
    entities,
    referents,
    customer_correction: value.customer_correction === true,
    additive: value.additive === true,
    explicit_negations: (Array.isArray(value.explicit_negations) ? value.explicit_negations : []).map((x) => clean(x, 200)).filter(Boolean).slice(0, 20),
    requested_facts: (Array.isArray(value.requested_facts) ? value.requested_facts : []).map((x) => clean(x, 200)).filter(Boolean).slice(0, 20),
    confidence: clampConfidence(value.confidence),
  };
}
