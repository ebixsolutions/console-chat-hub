/**
 * Demo Role Override Layer — type definitions
 *
 * P1 Rescue scope: Provide a console-only demo role mapping that lets the
 * ConsoleLayout demo role switcher drive child-route permission guards
 * WITHOUT modifying production auth (useCurrentRole.ts / AppRole enum /
 * Supabase user_roles).
 *
 * This type set is intentionally NOT the production AppRole enum.
 * Do NOT import it into any auth service, Supabase function, or backend
 * layer. Production AppRole stays 'admin' | 'supervisor' | 'agent'.
 *
 * Approved: Director ruling 2026-07-03
 */

/** Values emitted by the ConsoleLayout demo role switcher UI. */
export type DemoRole =
  | 'admin'
  | 'supervisor'
  | 'customer_service'
  | 'qa_reviewer';

/**
 * Canonical role model used by console permission guards.
 * Superset of production AppRole; 'qa' is reachable only via demo override
 * in this round and does NOT enter production auth.
 */
export type EffectiveRole = 'admin' | 'supervisor' | 'agent' | 'qa';

/**
 * Map a demo switcher value to the effective console role.
 * Unknown inputs default to 'agent' (safest read-only baseline).
 */
export function mapDemoRoleToEffective(demoRole: string): EffectiveRole {
  switch (demoRole) {
    case 'admin':
      return 'admin';
    case 'supervisor':
      return 'supervisor';
    case 'customer_service':
      return 'agent';
    case 'qa_reviewer':
      return 'qa';
    // Pass-through for values that are already effective roles
    case 'agent':
      return 'agent';
    case 'qa':
      return 'qa';
    default:
      return 'agent';
  }
}

/**
 * Shape provided by EffectiveRoleProvider to consumer hooks/components.
 * Named ConsoleOutletContext for backward compatibility with prompt
 * documentation, but is now delivered via React Context (not router outlet).
 */
export type ConsoleOutletContext = {
  effectiveRole: EffectiveRole;
  demoRole: string;
};
