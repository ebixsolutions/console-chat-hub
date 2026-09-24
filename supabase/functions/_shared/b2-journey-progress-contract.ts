import type { ConversationCommerceState } from "./commerce-state-contract.ts";
import type { ScopedCustomerValue } from "./contextual-customer-update.ts";
import type { CustomerJourneyResponseIntent } from "./customer-journey-orchestration.ts";

export interface B2JourneyTransactionBoundary {
  quotes: ConversationCommerceState["quotes"];
  delivery_confirmed: boolean;
  confirmed_installation_items:
    ConversationCommerceState["installation"]["items"];
  quotation_status: string;
  order_status: string;
  payment_status: string;
}

export function b2JourneyTransactionBoundary(
  state: ConversationCommerceState,
): B2JourneyTransactionBoundary {
  return {
    quotes: structuredClone(state.quotes),
    delivery_confirmed: state.delivery.confirmed,
    confirmed_installation_items: structuredClone(
      state.installation.items.filter((item) => item.status === "confirmed"),
    ),
    quotation_status: state.conversion.quotation_status,
    order_status: state.conversion.order_status,
    payment_status: state.conversion.payment_status,
  };
}

interface B2TrustedJourneyProgressBase {
  contract: "journey-progress-after-accepted-update-v1";
  company_id: string;
  source_message_id: string;
  source_text: string;
  previous_revision: number;
  committed_revision: number;
  entity_id: string;
  category: string;
  journey_stage: string;
  next_missing_slot: string | null;
  response_decision: CustomerJourneyResponseIntent;
  response_route: "product_guidance" | "contextual_scoped_update";
  response_reason: string;
  reply: string;
  transaction_before: B2JourneyTransactionBoundary;
  transaction_after: B2JourneyTransactionBoundary;
}

export interface B2TrustedGoalJourneyProgress
  extends B2TrustedJourneyProgressBase {
  update_kind: "customer_goal";
  previous_collected: string[];
  committed_collected: string[];
  previous_missing: string[];
  committed_missing: string[];
  accepted_slots: string[];
  accepted_corrections: string[];
}

export interface B2TrustedScopedJourneyProgress
  extends B2TrustedJourneyProgressBase {
  update_kind: "contextual_scoped_update";
  response_decision: "confirm_controlled_update";
  accepted_updates: ScopedCustomerValue[];
  committed_updates: ScopedCustomerValue[];
  aggregate_quantity?: number;
}

/** Private server-to-server evidence; never request or assistant metadata. */
export type B2TrustedJourneyProgress =
  | B2TrustedGoalJourneyProgress
  | B2TrustedScopedJourneyProgress;
