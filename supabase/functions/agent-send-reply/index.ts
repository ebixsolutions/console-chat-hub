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
    const content = typeof body?.content === "string" ? body.content.trim() : "";

    if (!conversation_id) return json({ error: "conversation_id required" }, 400);
    if (!content) return json({ error: "Message content is required" }, 400);
    if (content.length > 4000) return json({ error: "Message too long (max 4000 chars)" }, 400);

    // Tenant boundary must be checked before the service-role RPC is invoked.
    const { data: scopedConversation, error: scopeError } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("id", conversation_id)
      .eq("company_id", scope.companyId)
      .maybeSingle();

    if (scopeError) return json({ error: "Conversation lookup failed" }, 500);
    if (!scopedConversation) return json({ error: "Conversation not found" }, 404);

    // PR-3: customer-visible human reply is committed atomically with a fresh
    // conversation row lock. This prevents a stale ownership/status pre-read
    // from sending after Return to AI / transfer / reassignment wins the race.
    const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc(
      "agent_send_reply_tx",
      {
        p_conversation_id: conversation_id,
        p_agent_id: agent.id,
        p_content: content,
        p_agent_name: agent.display_name ?? null,
      },
    );

    if (rpcErr) {
      console.error("[agent-send-reply] RPC error:", {
        conversation_id,
        code: rpcErr.code,
      });
      return json({ error: "Internal error" }, 500);
    }

    const payload = rpcData ?? {};
    const rpcResult = String(payload.result ?? rpcData ?? "unknown");

    switch (rpcResult) {
      case "success":
        return json({
          success: true,
          data: {
            message_id:
              typeof payload.message_id === "string"
                ? payload.message_id
                : null,
          },
        });

      case "resolved":
        return json(
          {
            error: "Conversation is resolved",
            error_type: "conversation_resolved",
          },
          409,
        );

      case "takeover_required":
        return json(
          {
            error: "Take over this conversation before sending",
            error_type: "takeover_required",
          },
          409,
        );

      case "owned_by_another_agent":
        return json(
          {
            error: "This conversation is assigned to another agent",
            error_type: "conversation_owned_by_another_agent",
          },
          403,
        );

      case "human_control_required":
        return json(
          {
            error: "Conversation is not under human control",
            error_type: "human_control_required",
          },
          409,
        );

      case "agent_not_found":
        return json({ error: "Agent profile not found" }, 404);

      case "agent_inactive":
        return json({ error: "Agent is inactive" }, 403);

      case "invalid_content":
        return json({ error: "Invalid message content" }, 400);

      case "not_found":
        return json({ error: "Conversation not found" }, 404);

      default:
        console.error(
          "[agent-send-reply] unexpected RPC result:",
          rpcResult,
          conversation_id,
        );
        return json({ error: "Unexpected result" }, 500);
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
