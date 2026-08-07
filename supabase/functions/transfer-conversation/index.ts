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

    const body = await req.json().catch(() => ({}));
    const conversation_id = body?.conversation_id;
    const to_agent_id = body?.to_agent_id;
    const reason = body?.reason || "Agent transfer";
    if (!conversation_id || !to_agent_id) {
      return json({ error: "conversation_id and to_agent_id required" }, 400);
    }

    // Pre-RPC fetch for ownership check (EF-level auth guard)
    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversation_id)
      .single();
    if (convErr || !conversation) return json({ error: "Conversation not found" }, 404);

    // AM-D0: Block transfer of resolved conversations
    if (conversation.status === "resolved") {
      return json({ error: "Cannot transfer a resolved conversation" }, 400);
    }

    // Ownership check: plain agent can only transfer own conversations
    if (!ELEVATED.has(agent.role) && conversation.assigned_agent_id !== agent.id) {
      return json({ error: "You can only transfer conversations assigned to you" }, 403);
    }

    // Atomic RPC: all writes in one transaction
    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
      "transfer_conversation_tx",
      {
        p_conversation_id: conversation_id,
        p_to_agent_id: to_agent_id,
        p_from_agent_id: agent.id,
        p_expected_assigned_agent_id: conversation.assigned_agent_id,
        p_reason: reason,
      },
    );

    if (rpcErr) {
      console.error("[transfer-conversation] RPC error:", rpcErr.message, conversation_id);
      return json({ error: "Internal error" }, 500);
    }

    const rpcResultVal = rpcResult?.result ?? rpcResult;

    switch (rpcResultVal) {
      case "not_found":
        return json({ error: "Conversation not found" }, 404);
      case "resolved":
        return json({ error: "Cannot transfer a resolved conversation" }, 400);
      case "stale_assignment":
        return json({
          success: false,
          error: "Conversation was modified by another operation. Please refresh and try again.",
          error_type: "stale_assignment",
        }, 409);
      case "already_assigned":
        return json({ success: true, already_assigned: true, conversation_id }, 200);
      case "target_not_found":
        return json({ error: "Target agent not found" }, 404);
      case "target_inactive":
        return json({ error: "Target agent is not active" }, 400);
      case "success":
        return json({ success: true });
      default:
        console.error("[transfer-conversation] unexpected RPC result:", rpcResultVal);
        return json({ error: "Unexpected result" }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
