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
    const issueResolved = body?.closure_checklist?.issue_resolved === true;
    const lowRiskFollowup = body?.closure_checklist?.low_risk_followup === true;

    if (!conversation_id) return json({ error: "conversation_id required" }, 400);
    if (!issueResolved || !lowRiskFollowup) {
      return json(
        {
          success: false,
          error: "closure_checklist_required",
          detail: "Return to AI requires issue_resolved=true and low_risk_followup=true",
        },
        409,
      );
    }

    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversation_id)
      .eq("company_id", scope.companyId)
      .maybeSingle();

    if (convErr) return json({ error: "Conversation lookup failed" }, 500);
    if (!conversation) return json({ error: "Conversation not found" }, 404);

    if (conversation.status !== "pending" || !conversation.assigned_agent_id) {
      return json(
        { success: false, error: "human_control_required", detail: "Conversation must be under active human control" },
        409,
      );
    }

    if (!ELEVATED.has(scope.companyRole) && conversation.assigned_agent_id !== agent.id) {
      return json({ error: "You can only return conversations assigned to you" }, 403);
    }

    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc("return_to_ai_tx", {
      p_conversation_id: conversation_id,
      p_actor_agent_id: agent.id,
      p_expected_status: conversation.status,
      p_expected_owner: conversation.assigned_agent_id,
    });

    if (rpcErr) {
      console.error("[return-to-ai] RPC error:", rpcErr.message, conversation_id);
      return json({ error: "Internal error" }, 500);
    }

    const resultValue = rpcResult?.result ?? rpcResult;

    switch (resultValue) {
      case "not_found":
        return json({ error: "Conversation not found" }, 404);
      case "resolved":
        return json({ error: "Cannot return a resolved conversation to AI" }, 400);
      case "stale_state":
        return json(
          {
            success: false,
            error: "Conversation was modified by another operation. Please refresh and try again.",
            error_type: "stale_state",
          },
          409,
        );
      case "already_ai":
        return json({ success: true, already_ai: true, conversation_id }, 200);
      case "success":
        return json({ success: true }, 200);
      default:
        console.error("[return-to-ai] unexpected RPC result:", resultValue, conversation_id);
        return json({ error: "Unexpected result" }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
