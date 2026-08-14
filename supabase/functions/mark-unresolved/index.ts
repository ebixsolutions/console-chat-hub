import { corsHeaders, json } from "../_shared/cors.ts";
import { resolveAgentCompanyScope, validateAgent } from "../_shared/agent.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const result = await validateAgent(req);
    if (result instanceof Response) return result;
    const { agent, supabaseAdmin } = result;

    const scope = await resolveAgentCompanyScope(supabaseAdmin, agent);
    if (scope instanceof Response) return scope;

    const body = await req.json().catch(() => ({}));
    const conversation_id = body?.conversation_id;
    const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 1000) : null;
    if (!conversation_id) return json({ error: "conversation_id required" }, 400);

    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc(
      "set_conversation_resolution_tx",
      {
        p_conversation_id: conversation_id,
        p_company_id: scope.companyId,
        p_actor_user_id: agent.user_id,
        p_actor_agent_id: agent.id,
        p_target_state: "unresolved",
        p_reason: reason || null,
      },
    );

    if (rpcErr) {
      console.error("[mark-unresolved] RPC error", {
        conversation_id,
        code: rpcErr.code,
      });
      return json({ error: "Internal error" }, 500);
    }

    const resultValue = String(rpcData?.result ?? rpcData ?? "unknown");
    switch (resultValue) {
      case "success":
      case "already_in_state":
        return json({ success: true, already_unresolved: resultValue === "already_in_state" });
      case "not_found":
        return json({ error: "Conversation not found" }, 404);
      case "not_conversation_owner":
        return json(
          { error: "You can only mark unresolved conversations assigned to you", error_type: "not_conversation_owner" },
          403,
        );
      case "tenant_forbidden":
        return json({ error: "Conversation not found" }, 404);
      case "actor_not_found":
        return json({ error: "Agent account is inactive or unavailable" }, 403);
      case "invalid_target_state":
        return json({ error: "Invalid state transition" }, 400);
      default:
        console.error("[mark-unresolved] unexpected RPC result", resultValue);
        return json({ error: "Unexpected result" }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
