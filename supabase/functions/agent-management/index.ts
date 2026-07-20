import { corsHeaders, json } from "../_shared/cors.ts";
import { validateAgent } from "../_shared/agent.ts";

const MGMT_ROLES = new Set(["admin", "super_admin", "supervisor"]);
const ADMIN_ROLES = new Set(["admin", "super_admin"]);
const VALID_ROLES = new Set(["admin", "supervisor", "agent"]);
const VALID_ACTIONS = new Set(["list_agents", "find_user", "add_agent", "change_role", "deactivate", "reactivate"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed", error_type: "validation" }, 405);

  try {
    const result = await validateAgent(req);
    if (result instanceof Response) return result;
    const { agent, supabaseAdmin } = result;

    if (!MGMT_ROLES.has(agent.role)) {
      return json({ success: false, error: "Insufficient permissions", error_type: "forbidden" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = body?.action;
    if (!action || !VALID_ACTIONS.has(action)) {
      return json({ success: false, error: "Invalid action", error_type: "validation" }, 400);
    }

    const { data: callerProfile, error: cpErr } = await supabaseAdmin
      .from("agent_profile").select("user_id").eq("id", agent.id).single();
    if (cpErr || !callerProfile?.user_id) {
      return json({ success: false, error: "Caller not linked to auth user", error_type: "forbidden" }, 403);
    }
    const callerId: string = callerProfile.user_id;
    const isAdmin = ADMIN_ROLES.has(agent.role);

    switch (action) {
      case "list_agents": {
        const { data, error } = await supabaseAdmin
          .from("agent_profile")
          .select("id, user_id, display_name, email, role, status, created_at, updated_at")
          .order("display_name");
        if (error) {
          console.error("[agent-management] list error:", error.message);
          return json({ success: false, error: "Failed to load agents", error_type: "server_error" }, 500);
        }
        return json({ success: true, data: { agents: data || [] } });
      }

      case "find_user": {
        const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
        if (!email || !email.includes("@")) {
          return json({ success: false, error: "Valid email required", error_type: "validation" }, 400);
        }
        const { data, error } = await supabaseAdmin.rpc("find_auth_user_by_email", { p_email: email });
        if (error) {
          console.error("[agent-management] find_user error:", error.message);
          return json({ success: false, error: "Lookup failed", error_type: "server_error" }, 500);
        }
        return json({ success: true, data });
      }

      case "add_agent": {
        const { target_user_id, app_role, display_name } = body;
        if (!target_user_id || !app_role) {
          return json({ success: false, error: "target_user_id and app_role required", error_type: "validation" }, 400);
        }
        if (!VALID_ROLES.has(app_role)) {
          return json({ success: false, error: "Invalid role", error_type: "validation" }, 400);
        }
        if (!isAdmin && app_role !== "agent") {
          return json({ success: false, error: "Supervisors can only add agents", error_type: "forbidden" }, 403);
        }
        const { data, error } = await supabaseAdmin.rpc("safe_add_agent", {
          p_caller_id: callerId, p_target_user_id: target_user_id,
          p_app_role: app_role, p_display_name: display_name || null,
        });
        if (error) {
          console.error("[agent-management] add error:", error.message);
          return json({ success: false, error: "Add agent failed", error_type: "server_error" }, 500);
        }
        if (data && data.success === false) {
          const code = data.error_code || "conflict";
          const httpMap: Record<string, number> = {
            caller_not_authorized: 403, caller_profile_not_found: 403, insufficient_privilege: 403,
            target_user_not_found: 404, already_active: 409, inactive_profile_exists: 409, already_has_role: 409,
          };
          return json({ success: false, error: data.error_message || "Add failed", error_type: code }, httpMap[code] || 409);
        }
        return json({ success: true, data });
      }

      case "change_role": {
        if (!isAdmin) {
          return json({ success: false, error: "Only admins can change roles", error_type: "forbidden" }, 403);
        }
        const { target_user_id, new_role } = body;
        if (!target_user_id || !new_role) {
          return json({ success: false, error: "target_user_id and new_role required", error_type: "validation" }, 400);
        }
        if (!VALID_ROLES.has(new_role)) {
          return json({ success: false, error: "Invalid role", error_type: "validation" }, 400);
        }
        const { data, error } = await supabaseAdmin.rpc("safe_change_role", {
          p_caller_id: callerId, p_target_user_id: target_user_id, p_new_app_role: new_role,
        });
        if (error) {
          console.error("[agent-management] change_role error:", error.message);
          return json({ success: false, error: "Change role failed", error_type: "server_error" }, 500);
        }
        if (data && data.success === false) {
          const code = data.error_code || "conflict";
          const httpMap: Record<string, number> = {
            caller_not_authorized: 403, self_change_denied: 403, target_not_found: 404,
            target_not_active: 409, target_no_role: 409, same_role: 409, last_admin: 409,
          };
          return json({ success: false, error: data.error_message || "Change failed", error_type: code }, httpMap[code] || 409);
        }
        return json({ success: true, data });
      }

      case "deactivate": {
        const agentId = body.agent_id;
        if (!agentId) {
          return json({ success: false, error: "agent_id required", error_type: "validation" }, 400);
        }
        const { data: target, error: tErr } = await supabaseAdmin
          .from("agent_profile").select("id, role, status, user_id").eq("id", agentId).single();
        if (tErr || !target) {
          return json({ success: false, error: "Agent not found", error_type: "not_found" }, 404);
        }
        if (!isAdmin && target.role !== "agent") {
          return json({ success: false, error: "Supervisors can only manage agents", error_type: "forbidden" }, 403);
        }
        const { data, error } = await supabaseAdmin.rpc("safe_deactivate_agent", {
          p_caller_id: callerId, p_target_agent_id: agentId,
        });
        if (error) {
          console.error("[agent-management] deactivate error:", error.message);
          return json({ success: false, error: "Deactivate failed", error_type: "server_error" }, 500);
        }
        if (data && data.success === false) {
          const code = data.error_code || "conflict";
          const httpMap: Record<string, number> = {
            caller_not_authorized: 403, self_deactivation_denied: 403, insufficient_privilege: 403,
            target_not_found: 404, target_not_active: 409, last_admin: 409,
          };
          return json({ success: false, error: data.error_message || "Deactivate failed", error_type: code }, httpMap[code] || 409);
        }
        return json({ success: true, data });
      }

      case "reactivate": {
        const agentId = body.agent_id;
        if (!agentId) {
          return json({ success: false, error: "agent_id required", error_type: "validation" }, 400);
        }
        const { data: target, error: tErr } = await supabaseAdmin
          .from("agent_profile").select("id, role, status, user_id").eq("id", agentId).single();
        if (tErr || !target) {
          return json({ success: false, error: "Agent not found", error_type: "not_found" }, 404);
        }
        if (target.status !== "inactive") {
          return json({ success: false, error: "Agent is not inactive", error_type: "conflict" }, 409);
        }
        const reactRole = isAdmin ? (body.app_role || "agent") : "agent";
        if (!VALID_ROLES.has(reactRole)) {
          return json({ success: false, error: "Invalid role", error_type: "validation" }, 400);
        }
        if (!isAdmin) {
          if (reactRole !== "agent") {
            return json({ success: false, error: "Supervisors can only reactivate as agent", error_type: "forbidden" }, 403);
          }
          if (target.role !== "agent") {
            return json({ success: false, error: "Supervisors cannot reactivate non-agent profiles", error_type: "forbidden" }, 403);
          }
        }
        const { data, error } = await supabaseAdmin.rpc("safe_reactivate_agent", {
          p_caller_id: callerId, p_target_agent_id: agentId, p_app_role: reactRole,
        });
        if (error) {
          console.error("[agent-management] reactivate error:", error.message);
          return json({ success: false, error: "Reactivate failed", error_type: "server_error" }, 500);
        }
        if (data && data.success === false) {
          const code = data.error_code || "conflict";
          const httpMap: Record<string, number> = {
            caller_not_authorized: 403, insufficient_privilege: 403,
            target_not_found: 404, not_inactive: 409, unlinked_profile: 409, role_already_exists: 409,
          };
          return json({ success: false, error: data.error_message || "Reactivate failed", error_type: code }, httpMap[code] || 409);
        }
        return json({ success: true, data });
      }

      default:
        return json({ success: false, error: "Unknown action", error_type: "validation" }, 400);
    }
  } catch (e) {
    console.error("[agent-management] unexpected:", (e as Error).message);
    return json({ success: false, error: "Internal server error", error_type: "server_error" }, 500);
  }
});
