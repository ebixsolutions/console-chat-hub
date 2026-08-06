/**
 * Console capability matrix — deny by default.
 *
 * Every console capability must be declared here with an explicit allow list.
 * A role that does not appear in a capability's list is denied. There is no
 * wildcard and no implicit inheritance between roles.
 *
 * This file is the single client-side authority for what a role may see or do.
 * It is a convenience layer only: the database RLS policies and the Edge
 * Function role checks remain the enforcing boundary. Nothing here may be
 * treated as a security control on its own.
 */

import type { AppRole } from "@/lib/api/config.service";

export type ConsoleCapability =
  /** Reach the Conversation Evaluation route at all. */
  | "ce.route.view"
  /** Read scores, severity, provenance identifiers and per-dimension justification. */
  | "ce.evaluation.read_sanitized"
  /** Read raw provider payloads, outbox rows and internal error detail. */
  | "ce.evaluation.read_raw"
  /** Start a new evaluation run. */
  | "ce.evaluation.run"
  /** Record accept / reject / reopen. */
  | "ce.review.decide"
  /** Push an evaluation into the training pipeline. */
  | "ce.training.dispatch";

const MATRIX: Record<ConsoleCapability, readonly AppRole[]> = {
  "ce.route.view": ["admin", "supervisor", "qa", "agent"],
  "ce.evaluation.read_sanitized": ["admin", "supervisor", "qa", "agent"],
  "ce.evaluation.read_raw": ["admin"],
  "ce.evaluation.run": ["admin", "supervisor", "qa"],
  "ce.review.decide": ["admin", "supervisor"],
  "ce.training.dispatch": ["admin", "supervisor"],
};

/** True only when at least one held role is explicitly listed for the capability. */
export function can(roles: readonly (AppRole | null | undefined)[], capability: ConsoleCapability): boolean {
  const allowed = MATRIX[capability];
  if (!allowed) return false;
  return roles.some((r): r is AppRole => !!r && allowed.includes(r));
}

/** Convenience for the common single-role case. */
export function roleCan(role: AppRole | null | undefined, capability: ConsoleCapability): boolean {
  return can([role], capability);
}

/** Exposed for tests and for rendering an explain-why panel. */
export function allowedRolesFor(capability: ConsoleCapability): readonly AppRole[] {
  return MATRIX[capability] ?? [];
}

export const ALL_CAPABILITIES = Object.keys(MATRIX) as ConsoleCapability[];
