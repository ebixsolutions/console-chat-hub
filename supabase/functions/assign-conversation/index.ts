import { corsHeaders, json } from "../_shared/cors.ts";
import { validateAgent } from "../_shared/agent.ts";

const ELEVATED = new Set(["manager", "admin", "super_admin"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const result = await validateAgent(req);
    if (result instanceof Response) return result;
    const { agent, supabaseAdmin } = result;

    if (!ELEVATED.has(agent.role)) {
      return json({ error: "Insufficient permissions. Manager or above required." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const conversation_id = body?.conversation_id;
    const target_agent_id = body?.target_agent_id;

    if (!conversation_id || !target_agent_id) {
      return json({ error: "conversation_id and target_agent_id required" }, 400);
    }

    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversation_id)
      .single();

    if (convErr || !conversation) return json({ error: "Conversation not found" }, 404);

    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc("assign_conversation_tx", {
      p_conversation_id: conversation_id,
      p_target_agent_id: target_agent_id,
      p_actor_agent_id: agent.id,
      p_expected_status: conversation.status,
      p_expected_owner: conversation.assigned_agent_id,
    });

    if (rpcErr) {
      console.error("[assign-conversation] RPC error:", rpcErr.message, conversation_id);
      return json({ error: "Internal error" }, 500);
    }

    const resultValue = rpcResult?.result ?? rpcResult;

    switch (resultValue) {
      case "not_found":
        return json({ error: "Conversation not found" }, 404);
      case "resolved":
        return json({ error: "Cannot assign a resolved conversation" }, 400);
      case "target_not_found":
        return json({ error: "Target agent not found" }, 404);
      case "target_inactive":
        return json({ error: "Target agent is not active" }, 400);
      case "stale_state":
        return json(
          {
            success: false,
            error: "Conversation was modified by another operation. Please refresh and try again.",
            error_type: "stale_state",
          },
          409,
        );
      case "already_assigned":
        return json({ success: true, already_assigned: true, conversation_id }, 200);
      case "success":
        return json({ success: true, assignment_id: rpcResult?.assignment_id ?? null }, 200);
      default:
        console.error("[assign-conversation] unexpected RPC result:", resultValue, conversation_id);
        return json({ error: "Unexpected result" }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
