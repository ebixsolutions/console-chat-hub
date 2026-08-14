import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { json } from "./cors.ts";

export type Agent = {
  id: string;
  user_id: string;
  role: string;
  status: string;
  display_name: string;
};

export type AgentCompanyRole = "admin" | "supervisor" | "agent" | "qa";

export type AgentCompanyScope = {
  companyId: string;
  companyRole: AgentCompanyRole;
};

const COMPANY_ROLE_PRECEDENCE: AgentCompanyRole[] = [
  "admin",
  "supervisor",
  "agent",
  "qa",
];

export function getClients(req: Request): { supabaseAuth: SupabaseClient; supabaseAdmin: SupabaseClient } {
  const supabaseAuth = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  return { supabaseAuth, supabaseAdmin };
}

export async function validateAgent(
  req: Request,
): Promise<{ agent: Agent; supabaseAdmin: SupabaseClient } | Response> {
  const { supabaseAuth, supabaseAdmin } = getClients(req);
  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
  if (authError || !user) return json({ error: "Unauthorized" }, 401);

  const { data: agent, error: agentError } = await supabaseAdmin
    .from("agent_profile")
    .select("id, user_id, role, status, display_name")
    .eq("user_id", user.id)
    .single();
  if (agentError || !agent) return json({ error: "Agent profile not found" }, 403);
  if (agent.status !== "active") return json({ error: "Agent account is inactive" }, 403);
  if (!agent.user_id) return json({ error: "Agent identity is not linked" }, 403);

  return { agent: agent as Agent, supabaseAdmin };
}

/**
 * Resolve the single active company boundary for a signed-in agent.
 *
 * The current console has no explicit company-switch context, so ambiguous
 * multi-company membership is fail-closed rather than guessed.
 */
export async function resolveAgentCompanyScope(
  supabaseAdmin: SupabaseClient,
  agent: Agent,
): Promise<AgentCompanyScope | Response> {
  const { data: memberships, error: membershipError } = await supabaseAdmin
    .from("company_membership")
    .select("company_id, role")
    .eq("user_id", agent.user_id)
    .eq("is_active", true);

  if (membershipError) {
    console.error("[agent-scope] company membership lookup failed", membershipError.code);
    return json({ error: "Company scope lookup failed" }, 500);
  }

  const rows = memberships ?? [];
  const companyIds = [...new Set(rows.map((row) => String(row.company_id)))];

  if (companyIds.length === 0) {
    return json({ error: "Company scope is not configured", error_type: "company_scope_unresolved" }, 403);
  }
  if (companyIds.length !== 1) {
    return json({ error: "Company scope is ambiguous", error_type: "company_scope_ambiguous" }, 409);
  }

  const companyId = companyIds[0];
  const roles = rows
    .filter((row) => String(row.company_id) === companyId)
    .map((row) => String(row.role) as AgentCompanyRole);

  const companyRole = COMPANY_ROLE_PRECEDENCE.find((candidate) => roles.includes(candidate));
  if (!companyRole) {
    return json({ error: "Company role is not configured", error_type: "company_role_unresolved" }, 403);
  }

  const { data: company, error: companyError } = await supabaseAdmin
    .from("company")
    .select("id, is_active")
    .eq("id", companyId)
    .maybeSingle();

  if (companyError) {
    console.error("[agent-scope] company lookup failed", companyError.code);
    return json({ error: "Company scope lookup failed" }, 500);
  }
  if (!company || company.is_active !== true) {
    return json({ error: "Company is inactive", error_type: "company_inactive" }, 403);
  }

  return { companyId, companyRole };
}

/**
 * Resolve a target agent only when that agent is active and belongs to the
 * actor's already-resolved company boundary.
 */
export async function validateTargetAgentInCompany(
  supabaseAdmin: SupabaseClient,
  targetAgentId: string,
  companyId: string,
): Promise<{ id: string; user_id: string; status: string; display_name: string } | Response> {
  const { data: target, error: targetError } = await supabaseAdmin
    .from("agent_profile")
    .select("id, user_id, status, display_name")
    .eq("id", targetAgentId)
    .maybeSingle();

  if (targetError) {
    console.error("[agent-scope] target agent lookup failed", targetError.code);
    return json({ error: "Target agent lookup failed" }, 500);
  }
  if (!target || !target.user_id) return json({ error: "Target agent not found" }, 404);
  if (target.status !== "active") return json({ error: "Target agent is not active" }, 400);

  const { data: membership, error: membershipError } = await supabaseAdmin
    .from("company_membership")
    .select("id")
    .eq("user_id", target.user_id)
    .eq("company_id", companyId)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (membershipError) {
    console.error("[agent-scope] target membership lookup failed", membershipError.code);
    return json({ error: "Target agent lookup failed" }, 500);
  }
  if (!membership) {
    // Deliberately 404 so callers cannot enumerate agents from other tenants.
    return json({ error: "Target agent not found" }, 404);
  }

  return target as { id: string; user_id: string; status: string; display_name: string };
}

export async function writeAudit(
  supabaseAdmin: SupabaseClient,
  actorId: string,
  action: string,
  resourceType: string,
  resourceId: string,
  diff: Record<string, unknown> = {},
) {
  await supabaseAdmin.from("audit_log").insert({
    actor_id: actorId,
    actor_type: "agent",
    action,
    resource_type: resourceType,
    resource_id: resourceId,
    diff,
  });
}
