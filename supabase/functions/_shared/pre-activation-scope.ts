import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/**
 * Shared pre-activation scope resolver.
 *
 * Product-ready functional testing must be possible before the real SU Platform
 * canonical company / company_membership rows exist. This module is the single
 * backend authority for that decision. It never fabricates a company id.
 *
 * Semantics (frozen, derived from the authoritative conversation-evaluate
 * `conversation_local` precedent):
 *   - canonical ALWAYS wins. If a resource (or the caller) has resolvable
 *     canonical company identity, the canonical path is taken and canonical
 *     company/membership authorization is enforced exactly as before.
 *   - pre_activation is permitted ONLY when canonical identity is genuinely
 *     absent (company_id NULL / no membership rows at all) AND the caller holds
 *     an authenticated role explicitly allowed by the calling feature.
 *   - pre_activation callers may only touch `company_id IS NULL` records. Any
 *     query executed under pre_activation MUST apply `.is("company_id", null)`.
 *   - a canonical company with no active membership stays forbidden; it never
 *     degrades into pre_activation.
 *   - conflicting conversation.company_id vs channel_config.company_id stays a
 *     fail-closed conflict.
 */

export type ScopeMode = "canonical" | "pre_activation";

export interface CanonicalScope {
  mode: "canonical";
  companyId: string;
  roles: string[];
}

export interface PreActivationScope {
  mode: "pre_activation";
  /** Never a fabricated id. Pre-activation is always a NULL-company scope. */
  companyId: null;
  roles: string[];
}

export type ResolvedScope = CanonicalScope | PreActivationScope;

export type ScopeResult =
  | { ok: true; scope: ResolvedScope }
  | { ok: false; error: ScopeErrorCode; status: number };

export type ScopeErrorCode =
  | "conversation_lookup_failed"
  | "conversation_not_found"
  | "channel_company_lookup_failed"
  | "tenant_identity_conflict"
  | "company_lookup_failed"
  | "company_inactive"
  | "membership_lookup_failed"
  | "not_a_member"
  | "company_membership_ambiguous"
  | "role_lookup_failed"
  | "role_not_permitted";

/** Guard that must wrap every pre-activation read/write helper. */
export function isPreActivation(scope: ResolvedScope): scope is PreActivationScope {
  return scope.mode === "pre_activation";
}

/**
 * `company_id` filter value for a resolved scope.
 * Callers apply `.is("company_id", null)` for pre-activation and
 * `.eq("company_id", companyId)` for canonical. Helper keeps that explicit.
 */
export function applyCompanyScope<T extends {
  eq: (column: string, value: unknown) => T;
  is: (column: string, value: null) => T;
}>(query: T, scope: ResolvedScope, column = "company_id"): T {
  return scope.mode === "canonical"
    ? query.eq(column, scope.companyId)
    : query.is(column, null);
}

async function loadAuthenticatedRoles(
  admin: SupabaseClient,
  userId: string,
): Promise<{ ok: true; roles: string[] } | { ok: false; error: ScopeErrorCode; status: number }> {
  const { data, error } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (error) {
    console.error("[scope] user_roles lookup failed", error.code);
    return { ok: false, error: "role_lookup_failed", status: 500 };
  }
  return { ok: true, roles: (data ?? []).map((r: { role: string }) => String(r.role)) };
}

async function requireActiveCompanyMembership(
  admin: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<ScopeResult> {
  const { data: company, error: companyError } = await admin
    .from("company")
    .select("id, is_active")
    .eq("id", companyId)
    .maybeSingle();
  if (companyError) {
    console.error("[scope] company lookup failed", companyError.code);
    return { ok: false, error: "company_lookup_failed", status: 500 };
  }
  // A canonical company that is missing or inactive is forbidden. It must never
  // degrade to pre-activation, because the record itself is canonical.
  if (!company || company.is_active !== true) {
    return { ok: false, error: "company_inactive", status: 403 };
  }

  const { data: members, error: membershipError } = await admin
    .from("company_membership")
    .select("role")
    .eq("company_id", companyId)
    .eq("user_id", userId)
    .eq("is_active", true);
  if (membershipError) {
    console.error("[scope] company membership lookup failed", membershipError.code);
    return { ok: false, error: "membership_lookup_failed", status: 500 };
  }
  if (!members || members.length === 0) {
    return { ok: false, error: "not_a_member", status: 403 };
  }

  return {
    ok: true,
    scope: {
      mode: "canonical",
      companyId: String(company.id),
      roles: members.map((m: { role: string }) => String(m.role)),
    },
  };
}

/**
 * Resolve the operating scope for a conversation-bound operation.
 *
 * `preActivationRoles` is the feature's own allow-list (each caller preserves
 * its narrower role requirement); an empty set disables pre-activation for that
 * operation entirely (fail closed).
 */
export async function resolveConversationScope(
  admin: SupabaseClient,
  args: {
    conversationId: string;
    userId: string;
    preActivationRoles: ReadonlySet<string>;
  },
): Promise<ScopeResult> {
  const { data: conv, error: convError } = await admin
    .from("conversations")
    .select("id, company_id, channel_config_id")
    .eq("id", args.conversationId)
    .maybeSingle();
  if (convError) {
    console.error("[scope] conversation lookup failed", convError.code);
    return { ok: false, error: "conversation_lookup_failed", status: 500 };
  }
  if (!conv) return { ok: false, error: "conversation_not_found", status: 404 };

  let channelCompanyId: string | null = null;
  if (conv.channel_config_id) {
    const { data: channel, error: channelError } = await admin
      .from("channel_config")
      .select("company_id")
      .eq("id", conv.channel_config_id)
      .maybeSingle();
    if (channelError) {
      console.error("[scope] channel company lookup failed", channelError.code);
      return { ok: false, error: "channel_company_lookup_failed", status: 500 };
    }
    channelCompanyId = channel?.company_id ? String(channel.company_id) : null;
  }

  const conversationCompanyId = conv.company_id ? String(conv.company_id) : null;
  if (conversationCompanyId && channelCompanyId && conversationCompanyId !== channelCompanyId) {
    return { ok: false, error: "tenant_identity_conflict", status: 409 };
  }

  const resolvedCompanyId = conversationCompanyId ?? channelCompanyId;
  if (resolvedCompanyId) {
    // Canonical always wins.
    return await requireActiveCompanyMembership(admin, resolvedCompanyId, args.userId);
  }

  if (args.preActivationRoles.size === 0) {
    return { ok: false, error: "role_not_permitted", status: 403 };
  }

  const roleResult = await loadAuthenticatedRoles(admin, args.userId);
  if (!roleResult.ok) return roleResult;
  if (!roleResult.roles.some((r) => args.preActivationRoles.has(r))) {
    return { ok: false, error: "role_not_permitted", status: 403 };
  }

  return { ok: true, scope: { mode: "pre_activation", companyId: null, roles: roleResult.roles } };
}

/**
 * Resolve the operating scope for a caller-bound (non-resource) operation such
 * as a console directory or analytics roll-up.
 *
 * Canonical when the caller has exactly one active membership. Ambiguous
 * multi-company membership stays fail-closed. Pre-activation only when the
 * caller has no active membership at all, i.e. canonical binding has not
 * happened yet.
 */
export async function resolveCallerScope(
  admin: SupabaseClient,
  args: { userId: string; preActivationRoles: ReadonlySet<string> },
): Promise<ScopeResult> {
  const { data: memberships, error } = await admin
    .from("company_membership")
    .select("company_id")
    .eq("user_id", args.userId)
    .eq("is_active", true);
  if (error) {
    console.error("[scope] company membership lookup failed", error.code);
    return { ok: false, error: "membership_lookup_failed", status: 500 };
  }

  const companyIds = [
    ...new Set(
      (memberships ?? [])
        .map((row: { company_id: string | null }) => row.company_id)
        .filter((id: string | null): id is string => Boolean(id)),
    ),
  ];

  if (companyIds.length > 1) {
    return { ok: false, error: "company_membership_ambiguous", status: 409 };
  }
  if (companyIds.length === 1) {
    // Canonical always wins.
    return await requireActiveCompanyMembership(admin, companyIds[0], args.userId);
  }

  if (args.preActivationRoles.size === 0) {
    return { ok: false, error: "role_not_permitted", status: 403 };
  }

  const roleResult = await loadAuthenticatedRoles(admin, args.userId);
  if (!roleResult.ok) return roleResult;
  if (!roleResult.roles.some((r) => args.preActivationRoles.has(r))) {
    return { ok: false, error: "role_not_permitted", status: 403 };
  }

  return { ok: true, scope: { mode: "pre_activation", companyId: null, roles: roleResult.roles } };
}
