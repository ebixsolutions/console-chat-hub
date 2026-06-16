import { corsHeaders, json } from "../_shared/cors.ts";
import { validateAgent, writeAudit } from "../_shared/agent.ts";

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

    // MicroPatch 2: fetch conversation explicitly
    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversation_id)
      .single();
    if (convErr || !conversation) return json({ error: "Conversation not found" }, 404);

    // MicroPatch 2: plain agent can only transfer own conversations
    if (!ELEVATED.has(agent.role) && conversation.assigned_agent_id !== agent.id) {
      return json(
        { error: "You can only transfer conversations assigned to you" },
        403,
      );
    }

    const { data: target, error: tErr } = await supabaseAdmin
      .from("agent_profile")
      .select("id, status")
      .eq("id", to_agent_id)
      .single();
    if (tErr || !target) return json({ error: "Target agent not found" }, 404);
    if (target.status !== "active") return json({ error: "Target agent is not active" }, 400);

    const now = new Date().toISOString();

    const { data: handoff, error: hErr } = await supabaseAdmin
      .from("handoff_event")
      .insert({
        conversation_id,
        handoff_type: "agent_to_agent",
        from_agent_id: agent.id,
        to_agent_id,
        handoff_reason: reason,
        ai_summary: null,
      })
      .select("id")
      .single();
    if (hErr || !handoff) return json({ error: hErr?.message || "handoff failed" }, 500);

    await supabaseAdmin
      .from("conversation_assignment")
      .update({ is_active: false, unassigned_at: now })
      .eq("conversation_id", conversation_id)
      .eq("is_active", true);

    await supabaseAdmin.from("conversation_assignment").insert({
      conversation_id,
      agent_id: to_agent_id,
      assigned_by: agent.id,
      is_active: true,
    });

    const newStatus = "pending";
    await supabaseAdmin
      .from("conversations")
      .update({
        assigned_agent_id: to_agent_id,
        status: newStatus,
        updated_at: now,
      })
      .eq("id", conversation_id);

    if (conversation.status !== newStatus) {
      await supabaseAdmin.from("conversation_status_log").insert({
        conversation_id,
        old_status: conversation.status,
        new_status: newStatus,
        changed_by: agent.id,
        changed_by_type: "agent",
        reason,
      });
    }

    await writeAudit(supabaseAdmin, agent.id, "transfer_conversation", "handoff_event", handoff.id, {
      conversation_id,
      from_agent_id: agent.id,
      to_agent_id,
    });

    return json({ success: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
