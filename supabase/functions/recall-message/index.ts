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
    const message_id = body?.message_id;
    const reason =
      typeof body?.reason === "string" ? body.reason.trim().slice(0, 1000) : null;

    if (!message_id) return json({ error: "message_id required" }, 400);

    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc(
      "recall_message_tx",
      {
        p_message_id: message_id,
        p_company_id: scope.companyId,
        p_actor_user_id: agent.user_id,
        p_actor_agent_id: agent.id,
        p_reason: reason || null,
      },
    );

    if (rpcErr) {
      console.error("[recall-message] RPC error", {
        message_id,
        code: rpcErr.code,
      });
      return json({ error: "Internal error" }, 500);
    }

    const resultValue = String(rpcData?.result ?? rpcData ?? "unknown");

    switch (resultValue) {
      case "success":
      case "already_recalled":
        return json({
          success: true,
          already_recalled: resultValue === "already_recalled",
        });
      case "not_found":
      case "tenant_forbidden":
        return json({ error: "Message not found" }, 404);
      case "visitor_admin_required":
        return json({ error: "Only company admins can recall visitor messages" }, 403);
      case "not_message_owner":
        return json({ error: "Cannot recall another agent's message" }, 403);
      case "actor_not_found":
        return json({ error: "Agent account is inactive or unavailable" }, 403);
      case "unsupported_role":
        return json({ error: "Message role cannot be recalled" }, 400);
      default:
        console.error("[recall-message] unexpected RPC result", resultValue);
        return json({ error: "Unexpected result" }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
