export const COMMERCE_STATE_VERSION = "commerce-state-1.0.0" as const;

export type CommerceEntityStatus =
  | "researching"
  | "tentative"
  | "confirmed"
  | "deferred"
  | "cancelled";

export type CommerceQuoteType =
  | "customer_reported_historical"
  | "staff_reported_historical"
  | "current_verified"
  | "unverified";

export type CommerceQuoteValidity =
  | "unknown"
  | "historical"
  | "current"
  | "expired"
  | "superseded"
  | "invalid";

export type CommerceFunnelStage =
  | "discovery"
  | "research"
  | "consideration"
  | "quotation"
  | "checkout_ready"
  | "order_pending_confirmation"
  | "order_confirmed"
  | "post_purchase";

export type CommerceQuotationStatus =
  | "none"
  | "draft"
  | "pending_verification"
  | "verified"
  | "accepted"
  | "expired"
  | "cancelled";

export type CommerceOrderStatus =
  | "none"
  | "draft"
  | "pending_confirmation"
  | "confirmed"
  | "cancelled"
  | "completed";

export type CommercePaymentStatus =
  | "none"
  | "pending_quote"
  | "pending_payment"
  | "paid"
  | "failed"
  | "refunded"
  | "partially_refunded";

export interface CommerceProvenance {
  source_type:
    | "customer"
    | "human_agent"
    | "kb"
    | "system"
    | "tool"
    | "derived";
  source_message_id?: string | null;
  source_reference?: string | null;
  recorded_at?: string | null;
}

export interface CommerceEntity {
  entity_id: string;
  category: string;
  brand?: string | null;
  model?: string | null;
  quantity: number;
  status: CommerceEntityStatus;
  attributes: Record<string, unknown>;
  constraints: Record<string, unknown>;
  provenance: CommerceProvenance;
}

export interface CommerceQuote {
  quote_id: string;
  entity_id?: string | null;
  amount: number;
  currency: string;
  quote_type: CommerceQuoteType;
  validity_status: CommerceQuoteValidity;
  source_label?: string | null;
  conditions: Record<string, unknown>;
  provenance: CommerceProvenance;
}

export interface CommerceDeliveryState {
  preferred_date?: string | null;
  preferred_window?: string | null;
  address?: string | null;
  recipient_name?: string | null;
  recipient_phone?: string | null;
  confirmed: boolean;
  provenance?: CommerceProvenance | null;
}

export interface CommerceInstallationItem {
  item_id: string;
  kind: string;
  entity_id?: string | null;
  status: "pending" | "confirmed" | "not_required" | "cancelled";
  details: Record<string, unknown>;
  provenance: CommerceProvenance;
}

export interface CommerceInstallationState {
  items: CommerceInstallationItem[];
  site_conditions: Record<string, unknown>;
  pending_checks: string[];
}

export interface CommerceConversionState {
  funnel_stage: CommerceFunnelStage;
  quotation_status: CommerceQuotationStatus;
  order_status: CommerceOrderStatus;
  payment_status: CommercePaymentStatus;
  confirmed_entity_ids: string[];
  tentative_entity_ids: string[];
  cancelled_entity_ids: string[];
  next_best_action?: string | null;
}

export interface ConversationCommerceState {
  version: typeof COMMERCE_STATE_VERSION;
  language?: "zh-TW" | "zh-CN" | "en" | null;
  current_intent?: string | null;
  current_topic?: string | null;
  current_industry?: string | null;
  latest_corrections: string[];
  unresolved_items: string[];
  customer_constraints: Record<string, unknown>;
  entities: CommerceEntity[];
  quotes: CommerceQuote[];
  delivery: CommerceDeliveryState;
  installation: CommerceInstallationState;
  conversion: CommerceConversionState;
  metadata: Record<string, unknown>;
}

export interface PersistedConversationCommerceState {
  conversation_id: string;
  company_id: string;
  revision: number;
  source_message_id: string | null;
  state_hash: string;
  state: ConversationCommerceState;
  created_at: string;
  updated_at: string;
}

export function createEmptyConversationCommerceState(): ConversationCommerceState {
  return {
    version: COMMERCE_STATE_VERSION,
    language: null,
    current_intent: null,
    current_topic: null,
    current_industry: null,
    latest_corrections: [],
    unresolved_items: [],
    customer_constraints: {},
    entities: [],
    quotes: [],
    delivery: { confirmed: false },
    installation: { items: [], site_conditions: {}, pending_checks: [] },
    conversion: {
      funnel_stage: "discovery",
      quotation_status: "none",
      order_status: "none",
      payment_status: "none",
      confirmed_entity_ids: [],
      tentative_entity_ids: [],
      cancelled_entity_ids: [],
      next_best_action: null,
    },
    metadata: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isConversationCommerceState(value: unknown): value is ConversationCommerceState {
  if (!isRecord(value) || value.version !== COMMERCE_STATE_VERSION) return false;
  if (!Array.isArray(value.latest_corrections)) return false;
  if (!Array.isArray(value.unresolved_items)) return false;
  if (!isRecord(value.customer_constraints)) return false;
  if (!Array.isArray(value.entities) || !Array.isArray(value.quotes)) return false;
  if (!isRecord(value.delivery) || !isRecord(value.installation) || !isRecord(value.conversion)) return false;
  if (!isRecord(value.metadata)) return false;
  return true;
}
