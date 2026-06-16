import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { json } from "./cors.ts";

export type Agent = {
  id: string;
  role: string;
  status: string;
  display_name: string;
};

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
    .select("id, role, status, display_name")
    .eq("user_id", user.id)
    .single();
  if (agentError || !agent) return json({ error: "Agent profile not found" }, 403);
  if (agent.status !== "active") return json({ error: "Agent account is inactive" }, 403);

  return { agent: agent as Agent, supabaseAdmin };
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
