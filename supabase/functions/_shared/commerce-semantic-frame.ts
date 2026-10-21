import {
  decisionContextSchema,
  DecisionContextLimitError,
  normalizeDecisionContext,
  type DecisionValue,
} from "./bounded-decision-context.ts";
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

export type CommerceSemanticTransactionState =
  "none" | "draft" | "pending_confirmation" | "confirmed" | "completed" | "cancelled" | "unknown";

export type CommerceSemanticPaymentState =
  | "none"
  | "pending_quote"
  | "pending_payment"
  | "paid"
  | "failed"
  | "refunded"
  | "partially_refunded"
  | "unknown";

export type CommerceSemanticBookingState =
  "none" | "requested" | "pending" | "booked" | "completed" | "cancelled" | "unknown";

export type CommerceSemanticFulfillmentState =
  | "none"
  | "requested"
  | "pending"
  | "scheduled"
  | "in_progress"
  | "fulfilled"
  | "cancelled"
  | "unknown";

export interface CommerceSemanticAmbiguity {
  is_ambiguous: boolean;
  reasons: string[];
  clarification_question: string | null;
}

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
  attributes: Record<string, DecisionValue>;
  constraints: Record<string, DecisionValue>;
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
  customer_facts?: { key: string; value: DecisionValue }[];
  topic: string | null;
  entities: CommerceSemanticEntity[];
  referents: CommerceSemanticReferent[];
  customer_correction: boolean;
  additive: boolean;
  explicit_negations: string[];
  requested_facts: string[];
  transaction_state: CommerceSemanticTransactionState;
  payment_state: CommerceSemanticPaymentState;
  booking_state: CommerceSemanticBookingState;
  fulfillment_state: CommerceSemanticFulfillmentState;
  ambiguity: CommerceSemanticAmbiguity;
  confidence: number;
}

const OPERATIONS = new Set<CommerceSemanticOperation>([
  "ADD_ITEM",
  "SET_QUANTITY",
  "UPDATE_ITEM",
  "REMOVE_ITEM",
  "CANCEL_ITEM",
  "RESERVE",
  "REQUEST_QUOTE",
  "ASK_FACT",
  "ASK_CALCULATION",
  "CONFIRM",
  "DEFER",
  "NO_STATE_CHANGE",
]);
const KINDS = new Set<CommerceSemanticKind>([
  "physical_product",
  "digital_good",
  "service",
  "rental",
  "subscription",
  "ticket",
  "custom_item",
  "b2b_product",
  "unknown",
]);
const TRANSACTION_STATES = new Set<CommerceSemanticTransactionState>([
  "none",
  "draft",
  "pending_confirmation",
  "confirmed",
  "completed",
  "cancelled",
  "unknown",
]);
const PAYMENT_STATES = new Set<CommerceSemanticPaymentState>([
  "none",
  "pending_quote",
  "pending_payment",
  "paid",
  "failed",
  "refunded",
  "partially_refunded",
  "unknown",
]);
const BOOKING_STATES = new Set<CommerceSemanticBookingState>([
  "none",
  "requested",
  "pending",
  "booked",
  "completed",
  "cancelled",
  "unknown",
]);
const FULFILLMENT_STATES = new Set<CommerceSemanticFulfillmentState>([
  "none",
  "requested",
  "pending",
  "scheduled",
  "in_progress",
  "fulfilled",
  "cancelled",
  "unknown",
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
          attributes: { type: "object", additionalProperties: decisionContextSchema() },
          constraints: { type: "object", additionalProperties: decisionContextSchema() },
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
              "requires_delivery",
              "supports_pickup",
              "requires_installation",
              "requires_booking",
              "requires_quote",
              "requires_site_check",
              "digital_fulfilment",
              "recurring_billing",
              "rental_return",
              "customization",
            ],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: [
          "entity_ref",
          "name",
          "kind",
          "category_hint",
          "sku",
          "model",
          "quantity",
          "unit",
          "attributes",
          "constraints",
          "capabilities",
          "confidence",
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
          source: {
            type: "string",
            enum: ["current_turn", "prior_turn", "persistent_state", "unknown"],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["ref", "source", "confidence"],
      },
    },
    customer_correction: { type: "boolean" },
    additive: { type: "boolean" },
    explicit_negations: { type: "array", items: { type: "string" }, maxItems: 20 },
    requested_facts: { type: "array", items: { type: "string" }, maxItems: 20 },
    transaction_state: { type: "string", enum: [...TRANSACTION_STATES] },
    payment_state: { type: "string", enum: [...PAYMENT_STATES] },
    booking_state: { type: "string", enum: [...BOOKING_STATES] },
    fulfillment_state: { type: "string", enum: [...FULFILLMENT_STATES] },
    ambiguity: {
      type: "object",
      properties: {
        is_ambiguous: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" }, maxItems: 12 },
        clarification_question: { type: ["string", "null"] },
      },
      required: ["is_ambiguous", "reasons", "clarification_question"],
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "version",
    "language",
    "operation",
    "intent",
    "topic",
    "entities",
    "referents",
    "customer_correction",
    "additive",
    "explicit_negations",
    "requested_facts",
    "transaction_state",
    "payment_state",
    "booking_state",
    "fulfillment_state",
    "ambiguity",
    "confidence",
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Closed provider wire schema: dynamic typed properties are encoded as JSON
 * strings, then decoded under the unchanged canonical limits and validator. */
export const COMMERCE_SEMANTIC_WIRE_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["operation", "confidence"],
  properties: {
    operation: { type: "string", enum: [...OPERATIONS] },
    confidence: { type: "number" },
    language: { type: "string" },
    intent: { type: "string" },
    topic: { type: "string", nullable: true },
    customer_correction: { type: "boolean" },
    additive: { type: "boolean" },
    transaction_state: { type: "string", enum: [...TRANSACTION_STATES] },
    payment_state: { type: "string", enum: [...PAYMENT_STATES] },
    booking_state: { type: "string", enum: [...BOOKING_STATES] },
    fulfillment_state: { type: "string", enum: [...FULFILLMENT_STATES] },
    requested_facts: { type: "array", items: { type: "string" }, maxItems: 20 },
    explicit_negations: { type: "array", items: { type: "string" }, maxItems: 20 },
    customer_facts: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        required: ["key", "value_json"],
        properties: { key: { type: "string" }, value_json: { type: "string" } },
      },
    },
    referents: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        required: ["ref", "source", "confidence"],
        properties: {
          ref: { type: "string" },
          source: {
            type: "string",
            enum: ["current_turn", "prior_turn", "persistent_state", "unknown"],
          },
          confidence: { type: "number" },
        },
      },
    },
    ambiguity: {
      type: "object",
      properties: {
        is_ambiguous: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" }, maxItems: 12 },
        clarification_question: { type: "string", nullable: true },
      },
    },
    entities: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        required: ["name", "kind", "confidence"],
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: [...KINDS] },
          confidence: { type: "number" },
          entity_ref: { type: "string" },
          category_hint: { type: "string", nullable: true },
          sku: { type: "string", nullable: true },
          model: { type: "string", nullable: true },
          quantity: { type: "number", nullable: true },
          unit: { type: "string", nullable: true },
          attributes_json: { type: "string" },
          constraints_json: { type: "string" },
          capabilities: {
            type: "object",
            properties: Object.fromEntries(
              [
                "requires_delivery",
                "supports_pickup",
                "requires_installation",
                "requires_booking",
                "requires_quote",
                "requires_site_check",
                "digital_fulfilment",
                "recurring_billing",
                "rental_return",
                "customization",
              ].map((key) => [key, { type: "boolean" }]),
            ),
          },
        },
      },
    },
  },
};

/** Flatten only the provider grammar. All semantic fields remain typed and
 * bounded by the same decoder/canonical validator after JSON decoding. */
export const COMMERCE_SEMANTIC_COMPACT_WIRE_SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  required: ["operation", "confidence", "delta_json"],
  propertyOrdering: ["operation", "confidence", "delta_json"],
  properties: {
    operation: { type: "STRING", enum: [...OPERATIONS] },
    confidence: { type: "NUMBER", minimum: 0, maximum: 1 },
    delta_json: { type: "STRING", description: "JSON-encoded object containing this turn's optional semantic fields only; {} when none." },
  },
};

/** The outer schema owns operation/confidence. They are forbidden in the inner
 * delta, including its advertised grammar, not merely stripped after decode. */
const compactDeltaProperties = Object.fromEntries(Object.entries(
  COMMERCE_SEMANTIC_WIRE_SCHEMA.properties as Record<string, unknown>,
).filter(([key]) => !["operation", "confidence"].includes(key)));
const compactEntity = structuredClone((compactDeltaProperties.entities as {
  items: { properties: Record<string, unknown> };
}).items);
delete compactEntity.properties.attributes_json;
delete compactEntity.properties.constraints_json;
compactEntity.properties.attributes = { type: "object", additionalProperties: decisionContextSchema() };
compactEntity.properties.constraints = { type: "object", additionalProperties: decisionContextSchema() };
export const COMMERCE_SEMANTIC_DELTA_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    ...compactDeltaProperties,
    customer_facts: { type: "array", maxItems: 16, items: {
      type: "object", required: ["key", "value"],
      properties: { key: { type: "string" }, value: decisionContextSchema() },
    } },
    entities: { type: "array", maxItems: 12, items: compactEntity },
  },
};

/** The inner grammar and prompt share one source of truth. Never advertise aliases
 * that strict decoding rejects, and never repair provider data by guessing. */
export const COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS =
  "Outer JSON has exactly operation, confidence, delta_json in that order. " +
  "delta_json is a JSON-encoded object with only current-turn optional fields from the following wire schema; " +
  "omit operation/confidence from it and omit unchanged/default fields. Use the string {} when empty. " +
  "Encode only the delta object as delta_json. INSIDE that decoded object, customer_facts use {key,value} with native typed JSON values, " +
  "and entities use native attributes/constraints objects. Do not use value_json, attributes_json or constraints_json inside delta_json. " +
  "Strings are ordinary JSON strings; numbers, objects, arrays, false, zero and null stay native values. Do not add a second JSON encoding layer. " +
  "Valid outer example: " + JSON.stringify({operation:"ASK_FACT",confidence:0.97,delta_json:JSON.stringify({customer_facts:[{key:"priority",value:"quiet operation"},{key:"maximum_depth",value:{amount:560,unit:"mm"}},{key:"auto_renew",value:false},{key:"seats",value:0},{key:"date",value:null}]})}) + ". " +
  "Use customer_correction, explicit_negations and the four separate *_state fields exactly as named; " +
  "there are no lifecycle, correction or negations aliases. Schema: " +
  JSON.stringify(COMMERCE_SEMANTIC_DELTA_SCHEMA);

/** Native JSON transport avoids asking the model to serialize a second JSON
 * document inside a string. The canonical validator below remains the only
 * admission to business state; JSON syntax alone is never semantic authority.
 * Keep the older wire decoder for compatibility, including its strict rejects. */
export const COMMERCE_SEMANTIC_NATIVE_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["operation", "confidence"],
  properties: {
    operation: { type: "string", enum: [...OPERATIONS] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    ...COMMERCE_SEMANTIC_DELTA_SCHEMA.properties,
  },
};
export const COMMERCE_SEMANTIC_NATIVE_INSTRUCTIONS =
  "Return one native JSON object, not JSON encoded inside a string. " +
  "Put operation, confidence and this turn's optional fields directly in that object. " +
  "Do not emit delta_json, value_json, attributes_json or constraints_json. " +
  "customer_facts use {key,value}; value and entity attributes/constraints retain native typed JSON, including false, zero, null, arrays and bounded objects. " +
  "Omit unchanged/default fields. Never repair an invalid value by dropping a constraint. " +
  "Example: " + JSON.stringify({operation:"UPDATE_ITEM",confidence:0.97,customer_correction:true,
    customer_facts:[{key:"maximum_depth",value:{amount:560,unit:"mm"}},{key:"auto_renew",value:false}]}) +
  ". Canonical JSON grammar: " + JSON.stringify(COMMERCE_SEMANTIC_NATIVE_SCHEMA);

export type SemanticContractRejection =
  | "wire_object" | "wire_outer_fields" | "wire_delta_size_or_type"
  | "wire_delta_json" | "wire_delta_fields" | "wire_value_json"
  | "wire_entity_object" | "canonical_object" | "canonical_operation"
  | "canonical_confidence" | "canonical_array_bounds" | "canonical_fact"
  | "canonical_fact_bounds" | "canonical_entity" | "canonical_entity_kind"
  | "canonical_entity_name" | "canonical_entity_bounds";
type RejectSemantic = (reason: SemanticContractRejection) => void;

export function decodeCommerceSemanticWire(value: unknown, onReject?: RejectSemantic): unknown {
  const reject = (reason: SemanticContractRejection): null => { onReject?.(reason); return null; };
  if (!isRecord(value)) return reject("wire_object");
  if (Object.hasOwn(value, "delta_json")) {
    try {
      if (Object.keys(value).some(k => !["operation", "confidence", "delta_json"].includes(k))) return reject("wire_outer_fields");
      if (typeof value.delta_json !== "string" || value.delta_json.length > 24_000) return reject("wire_delta_size_or_type");
      const delta: unknown = JSON.parse(value.delta_json);
      if (!isRecord(delta) || Object.keys(delta).some(k =>
        !Object.hasOwn(COMMERCE_SEMANTIC_DELTA_SCHEMA.properties, k) ||
        ["operation", "confidence"].includes(k))) return reject("wire_delta_fields");
      value = { ...delta, operation: value.operation, confidence: value.confidence };
    } catch { return reject("wire_delta_json"); }
  } else if (Object.keys(value).some(key =>
    !Object.hasOwn(COMMERCE_SEMANTIC_NATIVE_SCHEMA.properties, key))) {
    // JSON MIME mode does not enforce semantic property names. Preserve the
    // compact grammar's closed-field boundary before canonical normalization.
    return reject("wire_delta_fields");
  }
  if (!isRecord(value)) return reject("wire_object");
  const decode = (raw: unknown): unknown => {
    if (typeof raw !== "string" || raw.length > 12_000)
      throw new Error("wire_value_json");
    try { return JSON.parse(raw); } catch { throw new Error("wire_value_json"); }
  };
  try {
    return {
      ...value,
      ...(Array.isArray(value.entities)
        ? {
            entities: value.entities.map((entity) => {
              if (!isRecord(entity)) return entity;
              const out = { ...entity };
              for (const key of ["attributes", "constraints"])
                if (Object.hasOwn(entity, key + "_json")) {
                  if (Object.hasOwn(entity, key)) throw new Error("wire_entity_object");
                  const decoded = decode(entity[key + "_json"]);
                  if (!isRecord(decoded)) throw new Error("wire_entity_object");
                  out[key] = decoded;
                }
              return out;
            }),
          }
        : {}),
      ...(Array.isArray(value.customer_facts)
        ? {
            customer_facts: value.customer_facts.map((fact) => {
              if (!isRecord(fact) || !Object.hasOwn(fact, "value_json")) return fact;
              if (Object.hasOwn(fact, "value")) throw new Error("wire_value_json");
              return { ...fact, value: decode(fact.value_json) };
            }),
          }
        : {}),
    };
  } catch (error) {
    return reject(error instanceof Error && error.message === "wire_entity_object" ? "wire_entity_object" : "wire_value_json");
  }
}

function clean(value: unknown, max = 300): string {
  return typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function bool(value: unknown): boolean {
  return value === true;
}

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

function enumValue<T extends string>(value: unknown, allowed: Set<T>, fallback: T): T {
  const normalized = clean(value, 60) as T;
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeAmbiguity(value: unknown, confidence: number): CommerceSemanticAmbiguity {
  const raw = isRecord(value) ? value : {};
  const reasons = (Array.isArray(raw.reasons) ? raw.reasons : [])
    .map((x) => clean(x, 200))
    .filter(Boolean)
    .slice(0, 12);
  const lowConfidence = confidence < 0.62;
  const explicitAmbiguous = raw.is_ambiguous === true;
  if (lowConfidence && !reasons.includes("low_confidence")) reasons.push("low_confidence");
  return {
    is_ambiguous: explicitAmbiguous || lowConfidence,
    reasons,
    clarification_question:
      raw.clarification_question === null ? null : clean(raw.clarification_question, 400) || null,
  };
}

export function normalizeCommerceSemanticFrame(value: unknown, onReject?: RejectSemantic): CommerceSemanticFrame | null {
  const reject = (reason: SemanticContractRejection): null => { onReject?.(reason); return null; };
  if (!isRecord(value)) return reject("canonical_object");
  const rawOperation = clean(value.operation, 40) as CommerceSemanticOperation;
  if (!OPERATIONS.has(rawOperation)) return reject("canonical_operation");

  if (
    typeof value.confidence !== "number" ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  )
    return reject("canonical_confidence");
  // No sliced partial state proposal. An oversized/malformed wire delta is rejected.
  for (const key of [
    "entities",
    "referents",
    "customer_facts",
    "requested_facts",
    "explicit_negations",
  ]) {
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) ||
        value[key].length >
          (key === "customer_facts"
            ? 16
            : ["requested_facts", "explicit_negations"].includes(key)
              ? 20
              : 12))
    )
      return reject("canonical_array_bounds");
  }
  const customerFacts: { key: string; value: DecisionValue }[] = [];
  for (const raw of Array.isArray(value.customer_facts) ? value.customer_facts : []) {
    if (
      !isRecord(raw) ||
      typeof raw.key !== "string" ||
      !raw.key.trim() ||
      raw.key.length > 120 ||
      !Object.hasOwn(raw, "value") ||
      raw.value === undefined
    )
      return reject("canonical_fact");
    try {
      customerFacts.push({
        key: raw.key,
        value: normalizeDecisionContext({ fact: raw.value }).fact,
      });
    } catch (error) {
      if (error instanceof DecisionContextLimitError) return reject("canonical_fact_bounds");
      throw error;
    }
  }
  const entities: CommerceSemanticEntity[] = [];
  for (const raw of Array.isArray(value.entities) ? value.entities.slice(0, 12) : []) {
    if (!isRecord(raw)) return reject("canonical_entity");
    const kind = clean(raw.kind, 40) as CommerceSemanticKind;
    if (!KINDS.has(kind)) return reject("canonical_entity_kind");
    const name = clean(raw.name, 200);
    if (!name) return reject("canonical_entity_name");
    const q = raw.quantity == null ? null : Number(raw.quantity);
    const quantity = q === null || !Number.isFinite(q) || q < 0 ? null : q;
    let attributes: Record<string, DecisionValue>, constraints: Record<string, DecisionValue>;
    try {
      attributes = normalizeDecisionContext(raw.attributes);
      constraints = normalizeDecisionContext(raw.constraints);
    } catch (error) {
      if (error instanceof DecisionContextLimitError) return reject("canonical_entity_bounds");
      throw error;
    }
    entities.push({
      entity_ref: clean(raw.entity_ref, 120) || `semantic:${entities.length + 1}`,
      name,
      kind,
      category_hint: raw.category_hint === null ? null : clean(raw.category_hint, 120) || null,
      sku: raw.sku === null ? null : clean(raw.sku, 120) || null,
      model: raw.model === null ? null : clean(raw.model, 120) || null,
      quantity,
      unit: raw.unit === null ? null : clean(raw.unit, 60) || null,
      attributes,
      constraints,
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

  const confidence = clampConfidence(value.confidence);
  const ambiguity = normalizeAmbiguity(value.ambiguity, confidence);
  const operation: CommerceSemanticOperation = ambiguity.is_ambiguous
    ? "NO_STATE_CHANGE"
    : rawOperation;

  return {
    version: COMMERCE_SEMANTIC_FRAME_VERSION,
    language: clean(value.language, 40) || "und",
    operation,
    intent: clean(value.intent, 160) || "unknown",
    customer_facts: customerFacts,
    topic: value.topic === null ? null : clean(value.topic, 160) || null,
    entities,
    referents,
    customer_correction: value.customer_correction === true,
    additive: value.additive === true,
    explicit_negations: (Array.isArray(value.explicit_negations) ? value.explicit_negations : [])
      .map((x) => clean(x, 200))
      .filter(Boolean)
      .slice(0, 20),
    requested_facts: (Array.isArray(value.requested_facts) ? value.requested_facts : [])
      .map((x) => clean(x, 200))
      .filter(Boolean)
      .slice(0, 20),
    transaction_state: enumValue(value.transaction_state, TRANSACTION_STATES, "unknown"),
    payment_state: enumValue(value.payment_state, PAYMENT_STATES, "unknown"),
    booking_state: enumValue(value.booking_state, BOOKING_STATES, "unknown"),
    fulfillment_state: enumValue(value.fulfillment_state, FULFILLMENT_STATES, "unknown"),
    ambiguity,
    confidence,
  };
}
