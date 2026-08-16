import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * LLM runtime telemetry read path.
 *
 * Scope semantics are identical to the frozen pre-activation contract:
 *   - canonical membership ALWAYS wins; telemetry is filtered on that company.
 *   - pre_activation is permitted ONLY when the caller has zero membership rows
 *     at all, and it may only read `company_id IS NULL` telemetry rows.
 *   - an inactive membership, an inactive company, or ambiguous multi-company
 *     identity fails closed.
 *   - no company id is ever fabricated.
 * Provider credentials and model environment variables are never read here.
 */

export type LlmRuntimeRole = "admin" | "supervisor";
const ALLOWED_ROLES: readonly string[] = ["admin", "supervisor"];

export interface LlmRuntimeLogRow {
  id: string;
  created_at: string;
  response_status: number | null;
  response_latency_ms: number | null;
  error_message: string | null;
  request_payload: unknown;
}

export interface LlmRuntimeResult {
  ok: boolean;
  error?: string;
  data?: {
    mode: "canonical" | "pre_activation";
    rows: LlmRuntimeLogRow[];
  };
}

type Scope =
  | { ok: true; mode: "canonical"; companyId: string }
  | { ok: true; mode: "pre_activation"; companyId: null }
  | { ok: false; error: string };

async function resolveTelemetryScope(
  db: any,
  userId: string,
): Promise<Scope> {
  const { data: membershipRows, error: membershipError } = await db
    .from("company_membership")
    .select("company_id, role, is_active")
    .eq("user_id", userId);
  if (membershipError) return { ok: false, error: "company_membership_lookup_failed" };

  const memberships = (membershipRows ?? []) as {
    company_id: string | null;
    role: string | null;
    is_active: boolean | null;
  }[];

  const companyIds: string[] = [
    ...new Set(
      memberships
        .map((row) => row.company_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  if (companyIds.length > 1) return { ok: false, error: "company_membership_ambiguous" };

  if (companyIds.length === 1) {
    const companyId = companyIds[0];
    const active = memberships.filter(
      (row) => row.company_id === companyId && row.is_active === true,
    );
    if (active.length === 0) return { ok: false, error: "not_a_member" };

    const { data: company, error: companyError } = await db
      .from("company")
      .select("id, is_active")
      .eq("id", companyId)
      .maybeSingle();
    if (companyError) return { ok: false, error: "company_lookup_failed" };
    if (!company || company.is_active !== true) return { ok: false, error: "company_inactive" };

    const roles = active.map((row) => String(row.role ?? ""));
    if (!roles.some((role) => ALLOWED_ROLES.includes(role))) {
      return { ok: false, error: "forbidden" };
    }
    return { ok: true, mode: "canonical", companyId };
  }

  // Reachable only after proving the caller has zero canonical membership rows.
  if (memberships.length > 0) return { ok: false, error: "not_a_member" };

  const { data: roleRows, error: roleError } = await db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (roleError) return { ok: false, error: "role_lookup_failed" };

  const roles = ((roleRows ?? []) as { role: string | null }[]).map((r) =>
    String(r.role ?? ""),
  );
  if (!roles.some((role) => ALLOWED_ROLES.includes(role))) {
    return { ok: false, error: "forbidden" };
  }
  return { ok: true, mode: "pre_activation", companyId: null };
}

export const getLlmRuntimeTelemetryFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<LlmRuntimeResult> => {
    const db = context.supabase as any;
    const scope = await resolveTelemetryScope(db, String(context.userId));
    if (!scope.ok) return { ok: false, error: scope.error };

    let query = db
      .from("upstream_call_log")
      .select(
        "id, created_at, response_status, response_latency_ms, error_message, request_payload",
      )
      .eq("upstream_service", "llm");

    query = scope.mode === "canonical"
      ? query.eq("company_id", scope.companyId)
      : query.is("company_id", null);

    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(100);

    if (error) return { ok: false, error: "llm_runtime_log_query_failed" };

    return {
      ok: true,
      data: {
        mode: scope.mode,
        rows: (data ?? []) as LlmRuntimeLogRow[],
      },
    };
  });
