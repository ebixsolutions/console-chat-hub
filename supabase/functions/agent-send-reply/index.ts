import { corsHeaders, json } from "../_shared/cors.ts";
import { validateAgent, writeAudit } from "../_shared/agent.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const result = await validateAgent(req);
    if (result instanceof Response) return result;
    const { agent, supabaseAdmin } = result;

    const body = await req.json().catch(() => ({}));
    const conversation_id = body?.conversation_id;
    const content = typeof body?.content === "string" ? body.content.trim() : "";

    if (!conversation_id) return json({ error: "conversation_id required" }, 400);
    if (!content) return json({ error: "Message content is required" }, 400);
    if (content.length > 4000) return json({ error: "Message too long (max 4000 chars)" }, 400);

    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversation_id)
      .single();
    if (convErr || !conv) return json({ error: "Conversation not found" }, 404);
    // ── Dev22-F1: Strict ownership enforcement ──────────────────────────
    // Director contract: agent may send ONLY when status=pending AND
    // assigned_agent_id=current agent. No elevated-role bypass.
    if (conv.status === "resolved") {
      return json({ error: "Conversation is resolved", error_type: "conversation_resolved" }, 409);
    }
    if (!conv.assigned_agent_id) {
      return json({ error: "Take over this conversation before sending", error_type: "takeover_required" }, 409);
    }
    if (conv.assigned_agent_id !== agent.id) {
      return json({ error: "This conversation is assigned to another agent", error_type: "conversation_owned_by_another_agent" }, 403);
    }
    if (conv.status !== "pending") {
      return json({ error: "Conversation is not under human control", error_type: "human_control_required" }, 409);
    }
    // ── End Dev22-F1 ────────────────────────────────────────────────────

    const { data: msg, error: mErr } = await supabaseAdmin
      .from("messages")
      .insert({
        conversation_id,
        role: "agent",
        content,
        status: "delivered",
        metadata: { agent_id: agent.id, agent_name: agent.display_name },
      })
      .select("id")
      .single();
    if (mErr || !msg) return json({ error: mErr?.message || "insert failed" }, 500);

    // Clear __THINKING__ placeholders
    await supabaseAdmin
      .from("messages")
      .update({
        is_recalled: true,
        status: "failed",
        metadata: { resolved_by: "agent_reply", agent_id: agent.id },
      })
      .eq("conversation_id", conversation_id)
      .eq("content", "__THINKING__");

    await supabaseAdmin
      .from("conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversation_id);

    await writeAudit(supabaseAdmin, agent.id, "agent_send_reply", "messages", msg.id, {
      conversation_id,
      length: content.length,
    });

    return json({ success: true, data: { message_id: msg.id } });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
