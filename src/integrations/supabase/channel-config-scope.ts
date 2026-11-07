/** The Widget config reader accepts exactly one active, authorized company.
 * Membership rows must come from the verified user's RLS-scoped query. */
export function authorizeChannelConfigScope(
  memberships: Array<{ company_id: unknown; role: unknown }>,
  company: { id: unknown; is_active: unknown } | null,
  permittedRoles: readonly string[] = ["admin", "supervisor", "agent", "qa"],
): { ok: true; companyId: string; roles: Array<"admin" | "supervisor" | "agent" | "qa"> } |
  { ok: false; error: string } {
  const ids = [...new Set(memberships.map((m) => String(m.company_id)))];
  if (ids.length === 0) return { ok: false, error: "company_membership_unresolved" };
  if (ids.length !== 1) return { ok: false, error: "company_membership_ambiguous" };
  if (!company || company.id !== ids[0] || company.is_active !== true) {
    return { ok: false, error: "company_inactive" };
  }
  const allowed = new Set(["admin", "supervisor", "agent", "qa"]);
  const roles = [...new Set(memberships.map((m) => String(m.role)))]
    .filter((role) => allowed.has(role)) as Array<"admin" | "supervisor" | "agent" | "qa">;
  if (!roles.some((role) => permittedRoles.includes(role))) {
    return { ok: false, error: "forbidden" };
  }
  return { ok: true, companyId: ids[0], roles };
}
