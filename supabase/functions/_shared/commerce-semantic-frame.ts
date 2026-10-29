import {
  decisionContextSchema,
  DecisionContextLimitError,
  DECISION_CONTEXT_LIMITS,
  type DecisionContextLimitDiagnostic,
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
    confidence: { type: "number", minimum: 0, maximum: 1 },
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
          confidence: { type: "number", minimum: 0, maximum: 1 },
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
          confidence: { type: "number", minimum: 0, maximum: 1 },
          entity_ref: { type: "string" },
          category_hint: { type: "string", nullable: true },
          sku: { type: "string", nullable: true },
          model: { type: "string", nullable: true },
          quantity: { type: "number", nullable: true, minimum: 0 },
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
// The semantic grammar and canonical context validator share their limits and
// depth convention; do not maintain a second, narrower leaf vocabulary here.
const semanticContextObject = () => ({ type: "object", maxProperties: DECISION_CONTEXT_LIMITS.fields,
  propertyNames: {minLength: 1, maxLength: 80}, additionalProperties: decisionContextSchema() });
compactEntity.properties.attributes = semanticContextObject();
compactEntity.properties.constraints = semanticContextObject();
export const COMMERCE_SEMANTIC_DELTA_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    ...compactDeltaProperties,
    customer_facts: { type: "array", maxItems: 16, items: {
      type: "object", required: ["key", "value"],
      properties: { key: { type: "string",minLength:1,maxLength:120 }, value: decisionContextSchema() },
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
  "For each attributes/constraints object, its root is depth 0; scalars may be at depth 3, but no value/container may occur deeper. " +
  "Use at most 40 fields per object, 12 entries per array, 96 scalar leaves per complete attributes/constraints object, 80 characters per key and 300 normalized characters per string. " +
  "A measurement can be {\"amount\":80,\"unit\":\"sq_ft\"}; do not wrap it in repeated value/measurement/requirements objects or copy the persistent state. " +
  "Customer-owned background measurements/counts are named customer_facts with native typed values; they are not new commerce items. Preserve the supplied entity association, and leave an unresolved association unassigned for clarification. " +
  "Example: " + JSON.stringify({operation:"UPDATE_ITEM",confidence:0.97,customer_correction:true,
    customer_facts:[{key:"maximum_depth",value:{amount:560,unit:"mm"}},{key:"auto_renew",value:false}]}) +
  ". Canonical JSON grammar: " + JSON.stringify(COMMERCE_SEMANTIC_NATIVE_SCHEMA);

// Fixed provider fields avoid unsupported dynamic-key schemas. Paths describe
// the original value; they are not extra wrappers in the canonical context.
// No JSON-in-a-string, guessed flattening, truncation or relaxed depth limit.
const typedNodesSchema = (maxDepth: number) => ({
  type: "array", items: { type: "object", required: ["path", "kind"],
    properties: {
      path: {type: "array", items: {type: "string"}, maxItems: maxDepth},
      kind: {type: "string", enum: ["object", "array", "string", "number", "boolean", "null"]},
      text: {type: "string"}, number: {type: "number"}, boolean: {type: "boolean"},
    }, propertyOrdering: ["path", "kind", "text", "number", "boolean"],
  },
});
const typedProperties = structuredClone(COMMERCE_SEMANTIC_WIRE_SCHEMA.properties) as Record<string, any>;
for (const key of ["attributes", "constraints"]) {
  delete typedProperties.entities.items.properties[key + "_json"];
  typedProperties.entities.items.properties[key + "_nodes"] = typedNodesSchema(DECISION_CONTEXT_LIMITS.depth);
}
typedProperties.customer_facts.items = {type: "object", required: ["key", "value_nodes"],
  properties: {key: {type: "string"}, value_nodes: typedNodesSchema(DECISION_CONTEXT_LIMITS.depth - 1)}};
// Vertex compiles optional object fields into grammar branches. The previous
// whole-frame grammar was rejected before inference (Hosted d268773f, HTTP400).
// Require the already-supported canonical defaults instead of multiplying
// optional branches. Keep typed scalar slots optional: the strict node decoder
// requires exactly the value field matching kind, never fabricated dummy data.
function orderSemanticTransport(schema: Record<string, any>): void {
  if (schema.properties) {
    const keys = Object.keys(schema.properties);
    const typedNode = keys.includes("path") && keys.includes("kind");
    if (!typedNode) schema.required = keys;
    schema.propertyOrdering = keys;
    for (const child of Object.values(schema.properties)) orderSemanticTransport(child as Record<string, any>);
  }
  if (schema.items) orderSemanticTransport(schema.items);
}
export const COMMERCE_SEMANTIC_TYPED_SCHEMA: Record<string, unknown> = {
  type: "object", required: ["context_encoding", "operation", "confidence"],
  propertyOrdering: ["context_encoding", "operation", "confidence"],
  properties: {context_encoding: {type: "string", enum: ["typed_paths_v1"]}, ...typedProperties},
};
orderSemanticTransport(COMMERCE_SEMANTIC_TYPED_SCHEMA);
export const COMMERCE_SEMANTIC_TYPED_INSTRUCTIONS =
  "Return one native JSON object. Follow the supplied response schema. context_encoding is typed_paths_v1. Emit only current-turn semantic changes, not a copy of prior state. " +
  "Dynamic customer contexts use attributes_nodes, constraints_nodes, and customer_facts {key,value_nodes}. " +
  "Each nodes list contains exactly one root node at path [], then explicitly declared parents and children; order is irrelevant. " +
  "Object children append the original field name; array children append a contiguous zero-based decimal index. " +
  "kind is object/array/string/number/boolean/null. Only string has text, number has number, boolean has boolean; null/object/array have no scalar value field. " +
  "Preserve false, zero, null, empty objects/arrays, quantities, units, customer sources, entity association and latest correction. Never turn missing data into a fact. " +
  "attributes/constraints root must be object; their original path depth is at most 3. A customer fact value has path depth at most 2 because canonical storage adds its fact wrapper. " +
  "Use at most 40 fields per object, 12 entries per array, 96 scalar leaves, 80 characters per key and 300 normalized characters per string. " +
  "Represent measurements directly with amount and unit under the relevant fact/entity. Do not add redundant measurement/value/requirements wrappers. " +
  "Customer background measurements/counts are customer_facts, not new commerce items. Keep a supplied room/entity name; an unresolved association stays unknown for targeted clarification. " +
  "All frame/entity/ambiguity/capability fields are required in fixed schema order. For unchanged or unspecified fields use only existing neutral defaults: [] for lists, false for correction/additive/capabilities unless explicitly supported, unknown for transaction/payment/booking/fulfillment state, und for unknown language, unknown for unknown intent, null for nullable text/quantity, and an empty string for an unresolved entity_ref. " +
  "An empty attributes_nodes or constraints_nodes context is one object root node at path [], not an empty list. Ambiguity defaults are is_ambiguous=false, reasons=[], clarification_question=null. These defaults are not customer-provided facts: never invent customer_facts or entities. " +
  "Typed nodes still emit only path, kind and the single matching scalar value field; never fill inactive scalar slots with dummy values. Do not omit facts to satisfy a limit, encode JSON into strings, emit raw attributes/constraints/value or mix legacy encodings. Canonical validation independently rejects invalid proposals.";

/** One shallow provider grammar for the entire delta. Commerce fields live in
 * typed paths, not an expanded recursive provider schema. The original native
 * grammar and canonical validator still validate the reconstructed proposal.
 * No neutral entity/fact/lifecycle fields are generated just to fill a schema. */
export const COMMERCE_SEMANTIC_PROVIDER_V2_SCHEMA: Record<string, unknown> = {
  type: "object", required: ["context_encoding", "operation", "confidence", "nodes"],
  propertyOrdering: ["context_encoding", "operation", "confidence", "nodes"],
  properties: {
    context_encoding: {type:"string", enum:["semantic_paths_v2"]},
    operation: {type:"string", enum:[...OPERATIONS]},
    confidence: {type:"number"},
    // The old independent optional scalar slots admitted {kind:number} with
    // no number, or a string carrying a boolean. Encode the same strict node
    // alternatives the decoder accepts; never fill/strip invalid scalar slots.
    // Keep the older typed_paths_v1 schema unchanged for existing consumers.
    nodes: { type: "array", items: { anyOf: [
      ...["object", "array", "null"].map(kind => ({
        type: "object", required: ["path", "kind"],
        properties: { path: {type:"array",items:{type:"string"},maxItems:6}, kind:{type:"string",enum:[kind]} },
        propertyOrdering: ["path", "kind"],
      })),
      ...[["string", "text"], ["number", "number"], ["boolean", "boolean"]].map(([kind, field]) => ({
        type: "object", required: ["path", "kind", field],
        properties: { path:{type:"array",items:{type:"string"},maxItems:6}, kind:{type:"string",enum:[kind]}, [field]:{type:kind} },
        propertyOrdering: ["path", "kind", field],
      })),
    ] } },
  },
};
export const COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V2 =
  "Follow the supplied response schema. Return context_encoding=semantic_paths_v2, operation, confidence, nodes, in that order. " +
  "nodes is a flat typed tree containing ONLY this turn's optional semantic delta. Root is exactly {path:[],kind:object}. " +
  "Use the canonical field names below as root child paths. Do NOT put operation/confidence/context_encoding in nodes. " +
  "Declare every object/array parent explicitly. Object children append the original key; array children append contiguous zero-based decimal indices. " +
  "kind is object/array/string/number/boolean/null. Only string has text, only number has number, only boolean has boolean. Null and containers have no scalar field. " +
  "No dummy scalar slots, JSON encoded inside strings, neutral facts, copied historical fields or truncated requirements. " +
  "For example a newly supplied customer fact of zero seats has nodes " +
  JSON.stringify([{path:[],kind:"object"},{path:["customer_facts"],kind:"array"},{path:["customer_facts","0"],kind:"object"},
    {path:["customer_facts","0","key"],kind:"string",text:"seats"},{path:["customer_facts","0","value"],kind:"number",number:0}]) + ". " +
  "Arrays, false, zero, null, entity association, quantities, units and latest corrections retain their actual types. " +
  "For attributes/constraints their object root is depth 0 and canonical context depth remains at most 3; fact values have at most 2 further levels. " +
  "Canonical limits remain 40 fields, 12 array entries, 96 scalar leaves, 80 characters per key, 300 normalized characters per context string. " +
  "Canonical validation independently rejects invalid proposals. The following is semantic vocabulary for reconstruction, NOT the provider response schema: " +
  JSON.stringify(COMMERCE_SEMANTIC_DELTA_SCHEMA);

/** Fixed semantic fields keep their canonical types/enums at generation time.
 * Only open customer contexts use paths. Four homogeneous node arrays avoid
 * recursive provider schemas, optional scalar slots and anyOf branch growth.
 * Older transports remain readable; canonical admission is still independent. */
const providerFields = structuredClone(COMMERCE_SEMANTIC_WIRE_SCHEMA.properties) as Record<string, any>;
delete providerFields.entities.items.properties.attributes_json;
delete providerFields.entities.items.properties.constraints_json;
providerFields.customer_facts.items = { type: "object", properties: { key: { type: "string" } } };
const providerContextNodes = (field: string, value: Record<string, unknown>) => ({
  // Keep the large total-node budget in the decoder, not in the provider's
  // grammar compiler. Each node still has a small, bounded path grammar.
  type: "array", items: { type: "object", required: ["path", field], properties: {
    path: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 }, [field]: value,
  } },
});
export const COMMERCE_SEMANTIC_PROVIDER_SCHEMA: Record<string, unknown> = {
  type: "object", properties: {
    context_encoding: { type: "string", enum: ["semantic_fields_v3"] },
    ...providerFields,
    containers: providerContextNodes("kind", { type: "string", enum: ["object", "array", "null"] }),
    strings: providerContextNodes("text", { type: "string" }),
    numbers: providerContextNodes("number", { type: "number" }),
    booleans: providerContextNodes("boolean", { type: "boolean" }),
  },
};
orderSemanticTransport(COMMERCE_SEMANTIC_PROVIDER_SCHEMA);
export const COMMERCE_SEMANTIC_PROVIDER_INSTRUCTIONS_V3 =
  "Follow the supplied response schema and its property order. Return context_encoding=semantic_fields_v3. " +
  "Fixed semantic fields are native JSON, not typed-tree paths. The required neutral values are transport defaults, not customer facts: " +
  "[] for empty lists, false for unsupported correction/additive/capabilities, unknown for unchanged lifecycle states, und for unknown language, unknown for unknown intent, " +
  "null for unspecified nullable text/quantity, and an empty entity_ref when unresolved. Never create a customer fact or entity to fill a required list. " +
  "customer_facts entries declare only their key; each value is carried by context paths. " +
  "Only attributes, constraints and customer fact values use the four context arrays: containers has object/array/null nodes, strings has text, numbers has number, booleans has boolean. " +
  "Their full paths start with [entities, entity index, attributes or constraints] or [customer_facts, fact index, value]. Use zero-based decimal index strings for declared entries. " +
  "Declare every context object/array parent, including its context root, once. Context paths cannot write fixed fields, another undeclared entity/fact, or the frame root. " +
  "Entity attributes/constraints roots must be objects. Every customer fact needs exactly one value root, of its actual type. " +
  "An absent entity context means no new context; a supplied empty object/array is represented explicitly and kept. " +
  "No duplicate paths across arrays, inactive scalar slots, JSON encoded inside strings, copied historical facts, credentials or truncated requirements. " +
  "Preserve false, zero, null, empty containers, entity association and latest corrections. " +
  "For attributes/constraints their root is depth 0; no value/container may be deeper than 3. Customer fact values have at most 2 further levels. " +
  "At the depth limit an object/array must be empty. Use at most 40 fields per object, 12 entries per array, 96 scalar leaves, 80 characters per key and 300 normalized characters per context string. " +
  "Do not repeat the response schema in output. Invalid proposals are rejected without retry or a partial state change.";

// Diagnostic labels come only from this fixed vocabulary, never from a model's
// customer-authored keys, text, paths, enum values or Error.message.
type SemanticFieldClass =
  | "frame" | "operation" | "confidence" | "language" | "intent" | "topic"
  | "customer_correction" | "additive" | "transaction_state" | "payment_state"
  | "booking_state" | "fulfillment_state" | "requested_facts" | "explicit_negations"
  | "entities" | "entity" | "entity_name" | "entity_kind" | "entity_confidence"
  | "entity_ref" | "entity_text" | "entity_quantity" | "entity_capabilities"
  | "entity_attributes" | "entity_constraints" | "customer_facts" | "customer_fact"
  | "customer_fact_key" | "customer_fact_value" | "referents" | "referent"
  | "referent_ref" | "referent_source" | "referent_confidence" | "ambiguity"
  | "ambiguity_flag" | "ambiguity_reasons" | "clarification_question"
  | "context_encoding" | "context_nodes" | "context_node" | "context_path"
  | "context_kind" | "context_scalar";
type SemanticVocabularyDiagnostic = {
  field_class: SemanticFieldClass;
  reason: "type" | "required" | "enum" | "range" | "bounds" | "field";
};
const rootFieldClasses: Record<string, SemanticFieldClass> = {
  operation:"operation", confidence:"confidence", language:"language", intent:"intent", topic:"topic",
  customer_correction:"customer_correction", additive:"additive", transaction_state:"transaction_state",
  payment_state:"payment_state", booking_state:"booking_state", fulfillment_state:"fulfillment_state",
  requested_facts:"requested_facts", explicit_negations:"explicit_negations", context_encoding:"context_encoding",
};
function semanticFieldClass(path: string[]): SemanticFieldClass {
  const [root,,field] = path;
  if (root === "entities") {
    if (path.length < 3) return path.length === 1 ? "entities" : "entity";
    const fields: Record<string, SemanticFieldClass> = {
      name:"entity_name", kind:"entity_kind", confidence:"entity_confidence", entity_ref:"entity_ref",
      category_hint:"entity_text", sku:"entity_text", model:"entity_text", unit:"entity_text",
      quantity:"entity_quantity", capabilities:"entity_capabilities", attributes:"entity_attributes", constraints:"entity_constraints",
    };
    return Object.hasOwn(fields,field) ? fields[field] : "entity";
  }
  if (root === "customer_facts") return path.length === 1 ? "customer_facts" : path.length === 2 ? "customer_fact"
    : field === "key" ? "customer_fact_key" : field === "value" ? "customer_fact_value" : "customer_fact";
  if (root === "referents") return path.length === 1 ? "referents" : path.length === 2 ? "referent"
    : field === "ref" ? "referent_ref" : field === "source" ? "referent_source" : field === "confidence" ? "referent_confidence" : "referent";
  if (root === "ambiguity") return path[1] === "is_ambiguous" ? "ambiguity_flag" : path[1] === "reasons" ? "ambiguity_reasons"
    : path[1] === "clarification_question" ? "clarification_question" : "ambiguity";
  if (["containers","strings","numbers","booleans"].includes(root)) return path.length === 1 ? "context_nodes"
    : path.length === 2 ? "context_node" : field === "path" ? "context_path" : field === "kind" ? "context_kind" : "context_scalar";
  return Object.hasOwn(rootFieldClasses,root) ? rootFieldClasses[root] : "frame";
}
/** Type/required/enum validation must precede the canonical normalizer, which
 * intentionally supplies defaults. Return only a safe reason and field class.
 * Provider checks also close every fixed object and enforce scalar/list ranges;
 * canonical context bounds retain their original detailed validator below. */
function semanticSchemaMismatch(value: unknown, schema: any, path: string[] = [], provider = false): SemanticVocabularyDiagnostic | null {
  const mismatch = (reason: SemanticVocabularyDiagnostic["reason"], at = path): SemanticVocabularyDiagnostic => ({field_class:semanticFieldClass(at),reason});
  if (value === null && schema.nullable === true) return null;
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const typeMatches = (s: any) => (Array.isArray(s.type) ? s.type : [s.type]).includes(type);
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((branch:any) => semanticSchemaMismatch(value,branch,path,provider));
    if (attempts.some((attempt:SemanticVocabularyDiagnostic|null) => attempt === null)) return null;
    const sameType = schema.anyOf.findIndex(typeMatches);
    return sameType < 0 ? mismatch("type") : attempts[sameType];
  }
  if (!typeMatches(schema) || type === "number" && !Number.isFinite(value)) return mismatch("type");
  if (schema.enum && !schema.enum.includes(value)) return mismatch("enum");
  if (type === "number" && provider &&
      (schema.minimum !== undefined && (value as number) < schema.minimum || schema.maximum !== undefined && (value as number) > schema.maximum)) return mismatch("range");
  if (type === "array") {
    const array = value as unknown[];
    if ((provider || schema.maxItems === 0) &&
        (schema.minItems !== undefined && array.length < schema.minItems || schema.maxItems !== undefined && array.length > schema.maxItems)) return mismatch("bounds");
    for (const [index, item] of array.entries()) {
      const error = semanticSchemaMismatch(item,schema.items,[...path,String(index)],provider);
      if (error) return error;
    }
  } else if (type === "object") {
    const object = value as Record<string, unknown>;
    const missing = (schema.required ?? []).find((key:string) => !Object.hasOwn(object,key));
    if (missing !== undefined) return mismatch("required",[...path,missing]);
    if (schema.maxProperties === 0 && Object.keys(object).length) return mismatch("bounds");
    for (const [key, child] of Object.entries(object)) {
      if (schema.properties && Object.hasOwn(schema.properties,key)) {
        const error = semanticSchemaMismatch(child,schema.properties[key],[...path,key],provider);
        if (error) return error;
      } else if (schema.additionalProperties === false || provider) return mismatch("field");
      else if (typeof schema.additionalProperties === "object") {
        const error = semanticSchemaMismatch(child,schema.additionalProperties,[...path,key],provider);
        if (error) return error;
      }
    }
  }
  return null;
}

type SemanticWireStage = "envelope" | "node_path" | "node_kind" | "node_fields" | "scalar_value" |
  "duplicate_path" | "root" | "parent" | "array_index" | "object_key" | "sparse_array" |
  "delta_fields" | "entity_fields" | "capability_fields" | "fact_fields" | "referent_fields" |
  "ambiguity_fields" | "canonical_vocabulary" | "canonical_range";
class SemanticWireError extends Error {
  constructor(readonly diagnostic: {container:"wire_nodes";stage:SemanticWireStage;node_index?:number;node_count:number} & Partial<SemanticVocabularyDiagnostic>) {
    super("wire_context_nodes");
  }
}
function decodeProviderSemanticTree(value: Record<string, unknown>): Record<string, unknown> {
  let index: number | undefined;
  const fail = (stage:SemanticWireStage, detail?:SemanticVocabularyDiagnostic): never => {throw new SemanticWireError({container:"wire_nodes",stage,
    ...(index===undefined?{}:{node_index:index}),node_count:Array.isArray(value.nodes)?Math.min(value.nodes.length,32769):0,...detail});};
  if (Object.keys(value).some(k=>!["context_encoding","operation","confidence","nodes"].includes(k)) ||
      value.context_encoding!=="semantic_paths_v2" || !Array.isArray(value.nodes) ||
      !value.nodes.length || value.nodes.length>32768) return fail("envelope");
  const nodes=new Map<string,{path:string[];kind:string;value:unknown}>();
  for(const [i,raw] of value.nodes.entries()) {
    index=i;
    if(!isRecord(raw) || !Array.isArray(raw.path) || raw.path.length>6 || raw.path.some(k=>typeof k!=="string" || !k || k.length>80 || ["__proto__","prototype","constructor"].includes(k)))return fail("node_path");
    if(typeof raw.kind!=="string")return fail("node_kind");
    const kind=raw.kind,field=kind==="string"?"text":kind==="number"?"number":kind==="boolean"?"boolean":null;
    if(!["object","array","string","number","boolean","null"].includes(kind))return fail("node_kind");
    if(Object.keys(raw).some(k=>!["path","kind",...(field?[field]:[])].includes(k)))return fail("node_fields");
    if(field && (typeof raw[field]!==kind || kind==="number"&&!Number.isFinite(raw[field])))return fail("scalar_value");
    const key=JSON.stringify(raw.path);if(nodes.has(key))return fail("duplicate_path");
    nodes.set(key,{path:raw.path as string[],kind,value:kind==="object"?Object.create(null):kind==="array"?[]:kind==="null"?null:raw[field!]});
  }
  index=undefined;
  const root=nodes.get("[]");if(root?.kind!=="object")return fail("root");
  for(const node of [...nodes.values()].sort((a,b)=>a.path.length-b.path.length)) {
    if(!node.path.length)continue;
    const parent=nodes.get(JSON.stringify(node.path.slice(0,-1))),key=node.path.at(-1)!;
    if(!parent || !["object","array"].includes(parent.kind))return fail("parent");
    if(parent.kind==="array") {
      // No sparse/unbounded allocations. Original per-field array limits are
      // checked by the unchanged canonical validator after reconstruction.
      if(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=20)return fail("array_index");
      (parent.value as unknown[])[Number(key)]=node.value;
    } else {
      const clean=(s:string)=>s.normalize("NFKC").replace(/\s+/g," ").trim();
      if(!clean(key)||["__proto__","prototype","constructor"].includes(clean(key))||Object.keys(parent.value as object).some(k=>clean(k)===clean(key)))return fail("object_key");
      (parent.value as Record<string,unknown>)[key]=node.value;
    }
  }
  for(const n of nodes.values())if(n.kind==="array"&&Object.keys(n.value as object).length!==(n.value as unknown[]).length)return fail("sparse_array");
  const delta=root.value as Record<string,unknown>;
  if(Object.keys(delta).some(k=>!Object.hasOwn(COMMERCE_SEMANTIC_DELTA_SCHEMA.properties,k)))return fail("delta_fields");
  const closed=(v:unknown,keys:string[])=>isRecord(v)&&Object.keys(v).every(k=>keys.includes(k));
  if(Array.isArray(delta.entities))for(const entity of delta.entities) {
    if(!closed(entity,Object.keys(compactEntity.properties)))return fail("entity_fields");
    if(isRecord(entity)&&entity.capabilities!==undefined&&!closed(entity.capabilities,Object.keys(typedProperties.entities.items.properties.capabilities.properties)))return fail("capability_fields");
  }
  if(Array.isArray(delta.customer_facts)&&delta.customer_facts.some(f=>!closed(f,["key","value"])))return fail("fact_fields");
  if(Array.isArray(delta.referents)&&delta.referents.some(r=>!closed(r,["ref","source","confidence"])))return fail("referent_fields");
  if(delta.ambiguity!==undefined&&!closed(delta.ambiguity,["is_ambiguous","reasons","clarification_question"]))return fail("ambiguity_fields");
  // The small provider grammar types nodes, not Commerce fields. Reapply the
  // native vocabulary's types/required fields/enums BEFORE normalization can
  // coerce a malformed quantity or turn a string context into an empty object.
  // Canonical bounds, sanitization and business authority remain unchanged.
  const vocabulary = semanticSchemaMismatch(delta,COMMERCE_SEMANTIC_DELTA_SCHEMA);
  if(vocabulary)return fail("canonical_vocabulary",vocabulary);
  for(const entry of [...(Array.isArray(delta.entities)?delta.entities:[]),...(Array.isArray(delta.referents)?delta.referents:[])]) {
    if(isRecord(entry)&&(typeof entry.confidence!=="number"||entry.confidence<0||entry.confidence>1 ||
      entry.quantity!==undefined&&entry.quantity!==null&&(typeof entry.quantity!=="number"||entry.quantity<0)))return fail("canonical_range");
  }
  return {...delta,operation:value.operation,confidence:value.confidence};
}

function decodeProviderSemanticFields(value: Record<string, unknown>): Record<string, unknown> {
  const collections = ["containers","strings","numbers","booleans"] as const;
  const count = collections.reduce((n,key) => n + (Array.isArray(value[key]) ? value[key].length : 0),0);
  const fail = (stage:SemanticWireStage, detail?:SemanticVocabularyDiagnostic): never => {
    throw new SemanticWireError({container:"wire_nodes",stage,node_count:Math.min(count,32769),...detail});
  };
  if (count > 32768) return fail("envelope");
  const vocabulary = semanticSchemaMismatch(value,COMMERCE_SEMANTIC_PROVIDER_SCHEMA,[],true);
  if (vocabulary) return fail(vocabulary.reason === "range" ? "canonical_range" : "canonical_vocabulary",vocabulary);

  const delta = {...value};
  for (const key of ["context_encoding","operation","confidence",...collections]) delete delta[key];
  type Node = {path:string[];kind:string;text?:string;number?:number;boolean?:boolean};
  const encode = (v:unknown,path:string[]=[]):Node[] => {
    const kind = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    const node:Node = {path,kind,...(kind === "string" ? {text:v as string} : kind === "number" ? {number:v as number} : kind === "boolean" ? {boolean:v as boolean} : {})};
    return [node,...(kind === "object" || kind === "array" ? Object.entries(v as object).flatMap(([key,child]) => encode(child,[...path,key])) : [])];
  };
  const nodes = encode(delta);
  const fixedNodeCount = nodes.length;
  const entities = delta.entities as unknown[];
  const facts = delta.customer_facts as unknown[];
  for (const collection of collections) for (const raw of value[collection] as Record<string,unknown>[]) {
    const path = raw.path as string[];
    const [root,index,field] = path;
    const canonicalIndex = /^(0|[1-9][0-9]*)$/.test(index);
    const entityContext = root === "entities" && canonicalIndex && Number(index) < entities.length && ["attributes","constraints"].includes(field);
    const factContext = root === "customer_facts" && canonicalIndex && Number(index) < facts.length && field === "value";
    if (!entityContext && !factContext) return fail("node_path",{field_class:semanticFieldClass(path),reason:"field"});
    if (factContext && path.length > 5) return fail("node_path",{field_class:"customer_fact_value",reason:"bounds"});
    const kind = collection === "containers" ? raw.kind as string : collection === "strings" ? "string" : collection === "numbers" ? "number" : "boolean";
    nodes.push({path,kind,...(kind === "string" ? {text:raw.text as string} : kind === "number" ? {number:raw.number as number} : kind === "boolean" ? {boolean:raw.boolean as boolean} : {})});
  }
  try {
    // Reuse the original closed tree/identity/duplicate/array checks and strict
    // canonical admission; context paths cannot replace any native fixed node.
    return decodeProviderSemanticTree({context_encoding:"semantic_paths_v2",operation:value.operation,confidence:value.confidence,nodes});
  } catch (error) {
    if (!(error instanceof SemanticWireError)) throw error;
    const {node_index,...diagnostic} = error.diagnostic;
    throw new SemanticWireError({...diagnostic,node_count:Math.min(count,32769),
      ...(node_index !== undefined && node_index >= fixedNodeCount ? {node_index:node_index-fixedNodeCount} : {})});
  }
}

function decodeContextNodes(raw: unknown, depthLimit: number): unknown {
  const fail = (): never => { throw new Error("wire_context_nodes"); };
  // The finite canonical tree cannot contain more nodes than this bound.
  const maxNodes = Array.from({length: depthLimit + 1}, (_, d) => DECISION_CONTEXT_LIMITS.fields ** d).reduce((a,b) => a+b, 0);
  if (!Array.isArray(raw) || !raw.length || raw.length > maxNodes) return fail();
  const nodes = new Map<string, {path: string[]; value: unknown; kind: string}>();
  for (const node of raw) {
    if (!isRecord(node) || !Array.isArray(node.path) || node.path.length > depthLimit || node.path.some(p => typeof p !== "string" || !p || p.length > 80 || ["__proto__", "prototype", "constructor"].includes(p))) return fail();
    const kind = node.kind;
    const field = kind === "string" ? "text" : kind === "number" ? "number" : kind === "boolean" ? "boolean" : null;
    if (!["object","array","string","number","boolean","null"].includes(String(kind)) || Object.keys(node).some(k => !["path","kind",...(field ? [field] : [])].includes(k))) return fail();
    if (field && (typeof node[field] !== kind || kind === "number" && !Number.isFinite(node[field]))) return fail();
    const key = JSON.stringify(node.path);
    if (nodes.has(key)) return fail();
    nodes.set(key, {path: node.path as string[], kind: kind as string,
      value: kind === "object" ? Object.create(null) : kind === "array" ? [] : kind === "null" ? null : node[field!]});
  }
  const root = nodes.get("[]"); if (!root) return fail();
  for (const node of [...nodes.values()].sort((a,b) => a.path.length-b.path.length)) {
    if (!node.path.length) continue;
    const parent = nodes.get(JSON.stringify(node.path.slice(0,-1))), key = node.path.at(-1)!;
    if (!parent || !["object","array"].includes(parent.kind)) return fail();
    if (parent.kind === "array") {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= DECISION_CONTEXT_LIMITS.items) return fail();
      (parent.value as unknown[])[Number(key)] = node.value;
    } else {
      const normalized = key.normalize("NFKC").replace(/\s+/g," ").trim();
      if (!normalized || Object.keys(parent.value as object).some(k => k.normalize("NFKC").replace(/\s+/g," ").trim() === normalized)) return fail();
      (parent.value as Record<string,unknown>)[key] = node.value;
    }
  }
  for (const n of nodes.values()) if (n.kind === "array" && Object.keys(n.value as object).length !== (n.value as unknown[]).length) return fail();
  return root.value;
}

function decodeTypedContextFrame(value: Record<string, unknown>): Record<string, unknown> {
  if (value.context_encoding !== "typed_paths_v1" || Object.keys(value).some(k => !Object.hasOwn(COMMERCE_SEMANTIC_TYPED_SCHEMA.properties as object,k))) throw new Error("wire_context_nodes");
  const out = {...value}; delete out.context_encoding;
  if (Array.isArray(value.entities)) out.entities = value.entities.map(entity => {
    if (!isRecord(entity) || Object.keys(entity).some(k => !Object.hasOwn(typedProperties.entities.items.properties,k))) throw new Error("wire_context_nodes");
    const e = {...entity};
    for (const key of ["attributes","constraints"]) if (Object.hasOwn(entity,key+"_nodes")) {
      const context = decodeContextNodes(entity[key+"_nodes"], DECISION_CONTEXT_LIMITS.depth);
      if (!isRecord(context)) throw new Error("wire_context_nodes");
      e[key] = context; delete e[key+"_nodes"];
    }
    return e;
  });
  if (Array.isArray(value.customer_facts)) out.customer_facts = value.customer_facts.map(fact => {
    if (!isRecord(fact) || Object.keys(fact).some(k => !["key","value_nodes"].includes(k)) || !Object.hasOwn(fact,"value_nodes")) throw new Error("wire_context_nodes");
    return {key: fact.key, value: decodeContextNodes(fact.value_nodes, DECISION_CONTEXT_LIMITS.depth-1)};
  });
  return out;
}

export type SemanticContractRejection =
  | "wire_object" | "wire_outer_fields" | "wire_delta_size_or_type"
  | "wire_delta_json" | "wire_delta_fields" | "wire_value_json"
  | "wire_entity_object" | "canonical_object" | "canonical_operation"
  | "wire_context_nodes"
  | "canonical_confidence" | "canonical_array_bounds" | "canonical_fact"
  | "canonical_fact_bounds" | "canonical_entity" | "canonical_entity_kind"
  | "canonical_entity_name" | "canonical_entity_bounds";
export type SemanticContractDiagnostic = SemanticWireError["diagnostic"] | {
  container: "attributes" | "constraints" | "customer_fact";
  entity_index?: number;
  violation: DecisionContextLimitDiagnostic;
};
type RejectSemantic = (reason: SemanticContractRejection, diagnostic?: SemanticContractDiagnostic) => void;

export function decodeCommerceSemanticWire(value: unknown, onReject?: RejectSemantic): unknown {
  const reject = (reason: SemanticContractRejection, diagnostic?:SemanticContractDiagnostic): null => { onReject?.(reason,diagnostic); return null; };
  if (!isRecord(value)) return reject("wire_object");
  if (Object.hasOwn(value, "context_encoding")) {
    try { value = value.context_encoding==="semantic_fields_v3" ? decodeProviderSemanticFields(value)
      : value.context_encoding==="semantic_paths_v2" ? decodeProviderSemanticTree(value) : decodeTypedContextFrame(value); } catch (error) {
      // Only fixed stage/field/reason enums and bounded counts: never keys, paths, values,
      // model payloads or Error.message (which could contain customer data).
      return reject("wire_context_nodes",error instanceof SemanticWireError?error.diagnostic:undefined);
    }
  }
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
  const reject = (reason: SemanticContractRejection, diagnostic?: SemanticContractDiagnostic): null => { onReject?.(reason, diagnostic); return null; };
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
      if (error instanceof DecisionContextLimitError) return reject("canonical_fact_bounds", error.diagnostic ? {container:"customer_fact",violation:error.diagnostic} : undefined);
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
    const contexts: Record<string, Record<string, DecisionValue>> = {};
    for (const container of ["attributes", "constraints"] as const) {
      try { contexts[container] = normalizeDecisionContext(raw[container]); }
      catch (error) {
        if (error instanceof DecisionContextLimitError) return reject("canonical_entity_bounds", error.diagnostic ?
          {container, entity_index:entities.length, violation:error.diagnostic} : undefined);
        throw error;
      }
    }
    attributes = contexts.attributes;
    constraints = contexts.constraints;
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
