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

    if (!ELEVATED.has(agent.role)) {
      return json({ error: "Insufficient permissions. Manager or above required." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const conversation_id = body?.conversation_id;
    const target_agent_id = body?.target_agent_id;
    if (!conversation_id || !target_agent_id) {
      return json({ error: "conversation_id and target_agent_id required" }, 400);
    }

    // MicroPatch 2: fetch conversation explicitly
    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversation_id)
      .single();
    if (convErr || !conversation) return json({ error: "Conversation not found" }, 404);

    const { data: target, error: tErr } = await supabaseAdmin
      .from("agent_profile")
      .select("id, status")
      .eq("id", target_agent_id)
      .single();
    if (tErr || !target) return json({ error: "Target agent not found" }, 404);
    if (target.status !== "active") return json({ error: "Target agent is not active" }, 400);

    const now = new Date().toISOString();

    await supabaseAdmin
      .from("conversation_assignment")
      .update({ is_active: false, unassigned_at: now })
      .eq("conversation_id", conversation_id)
      .eq("is_active", true);

    const { data: newAssign, error: aErr } = await supabaseAdmin
      .from("conversation_assignment")
      .insert({
        conversation_id,
        agent_id: target_agent_id,
        assigned_by: agent.id,
        is_active: true,
      })
      .select("id")
      .single();
    if (aErr || !newAssign) return json({ error: aErr?.message || "assignment failed" }, 500);

    await supabaseAdmin
      .from("conversations")
      .update({ assigned_agent_id: target_agent_id, updated_at: now })
      .eq("id", conversation_id);

    await writeAudit(
      supabaseAdmin,
      agent.id,
      "assign_conversation",
      "conversation_assignment",
      newAssign.id,
      {
        conversation_id,
        from_agent_id: conversation.assigned_agent_id,
        to_agent_id: target_agent_id,
      },
    );

    return json({ success: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
