import { corsHeaders, json } from "../_shared/cors.ts";
import { resolveAgentCompanyScope, validateAgent } from "../_shared/agent.ts";

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
    if (!conversation_id) return json({ error: "conversation_id required" }, 400);

    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversation_id)
      .eq("company_id", scope.companyId)
      .maybeSingle();
    if (convErr) return json({ error: "Conversation lookup failed" }, 500);
    if (!conversation) return json({ error: "Conversation not found" }, 404);

    if (conversation.status === "resolved") {
      return json({ error: "Cannot take over a resolved conversation" }, 400);
    }

    if (!ELEVATED.has(scope.companyRole)) {
      if (conversation.assigned_agent_id && conversation.assigned_agent_id !== agent.id) {
        return json(
          { error: "You can only take over unassigned conversations or those assigned to you" },
          403,
        );
      }
    }

    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc(
      "takeover_conversation_tx",
      {
        p_conversation_id: conversation_id,
        p_agent_id: agent.id,
        p_expected_status: conversation.status,
        p_expected_owner: conversation.assigned_agent_id,
      },
    );

    if (rpcErr) {
      console.error("[take-over-conversation] RPC error:", rpcErr.message, conversation_id);
      return json({ error: "Internal error" }, 500);
    }

    const rpcResultVal = rpcResult?.result ?? rpcResult;

    switch (rpcResultVal) {
      case "not_found":
        return json({ error: "Conversation not found" }, 404);
      case "resolved":
        return json({ error: "Cannot take over a resolved conversation" }, 400);
      case "already_owner":
        return json({ success: true, already_owner: true, conversation_id }, 200);
      case "race_conflict":
        return json({
          success: false,
          error: "Conversation was modified by another operation. Please refresh.",
          error_type: "race_conflict",
        }, 409);
      case "success":
        return json({ success: true, assigned_to: agent.display_name }, 200);
      default:
        console.error("[take-over-conversation] unexpected RPC result:", rpcResultVal);
        return json({ error: "Unexpected result" }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
