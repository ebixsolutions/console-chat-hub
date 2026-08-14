import { corsHeaders, json } from "../_shared/cors.ts";
import {
  resolveAgentCompanyScope,
  validateAgent,
  validateTargetAgentInCompany,
} from "../_shared/agent.ts";

const ELEVATED = new Set(["admin", "supervisor"]);

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
    const to_agent_id = body?.to_agent_id;
    const reason = body?.reason || "Agent transfer";
    if (!conversation_id || !to_agent_id) {
      return json({ error: "conversation_id and to_agent_id required" }, 400);
    }

    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversation_id)
      .eq("company_id", scope.companyId)
      .maybeSingle();
    if (convErr) return json({ error: "Conversation lookup failed" }, 500);
    if (!conversation) return json({ error: "Conversation not found" }, 404);

    if (conversation.status === "resolved") {
      return json({ error: "Cannot transfer a resolved conversation" }, 400);
    }

    if (!ELEVATED.has(scope.companyRole) && conversation.assigned_agent_id !== agent.id) {
      return json({ error: "You can only transfer conversations assigned to you" }, 403);
    }

    const target = await validateTargetAgentInCompany(
      supabaseAdmin,
      String(to_agent_id),
      scope.companyId,
    );
    if (target instanceof Response) return target;

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
        console.error("[transfer-conversation] unexpected RPC result:", rpcResultVal, conversation_id);
        return json({ error: "Unexpected result" }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
