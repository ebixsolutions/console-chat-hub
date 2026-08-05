/**
 * Canonical CE status semantics.
 *
 * The DB view public.ce_conversation_status_v is the single source of truth.
 * This module only maps its boolean columns to UI tabs; it must never
 * re-derive the states with independent frontend predicates.
 */

export const CE_TABS = ["all", "needs_review", "training_ready", "trained"] as const;
export type CeTab = (typeof CE_TABS)[number];

export type CeStatusRow = {
  evaluation_id: string;
  conversation_id: string;
  company_id: string | null;
  overall_score: number;
  severity: string;
  training_eligible: boolean;
  has_verified_human_response: boolean;
  evaluated_at: string;
  outbox_status: string | null;
  delivered_at: string | null;
  needs_review: boolean;
  training_ready: boolean;
  trained: boolean;
};

/** Column of ce_conversation_status_v that backs each tab (null = no filter). */
export function tabColumn(tab: CeTab): "needs_review" | "training_ready" | "trained" | null {
  switch (tab) {
    case "needs_review":
      return "needs_review";
    case "training_ready":
      return "training_ready";
    case "trained":
      return "trained";
    default:
      return null;
  }
}

/** Improved-result contract surfaced next to the Trained state. */
export type ImprovedResultState = "not_applicable" | "pending" | "received";

export function improvedResultState(row: Pick<CeStatusRow, "trained" | "training_ready">): ImprovedResultState {
  if (row.trained) return "received";
  if (row.training_ready) return "pending";
  return "not_applicable";
}
