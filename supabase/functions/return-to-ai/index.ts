import { corsHeaders, json } from "../_shared/cors.ts";
import { validateAgent, writeAudit } from "../_shared/agent.ts";

const ELEVATED = new Set(["manager", "admin", "super_admin", "supervisor"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const result = await validateAgent(req);
    if (result instanceof Response) return result;
    const { agent, supabaseAdmin } = result;

    const body = await req.json().catch(() => ({}));
    const conversation_id = body?.conversation_id;
    if (!conversation_id) return json({ error: "conversation_id required" }, 400);

    const { data: conversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversation_id)
      .single();
    if (convErr || !conversation) return json({ error: "Conversation not found" }, 404);

    if (conversation.status === "resolved") {
      return json({ error: "Cannot return a resolved conversation to AI" }, 400);
    }

    if (!ELEVATED.has(agent.role)) {
      if (conversation.assigned_agent_id !== agent.id) {
        return json({ error: "You can only return conversations assigned to you" }, 403);
      }
    }

    const now = new Date().toISOString();

    await supabaseAdmin
      .from("conversation_assignment")
      .update({ is_active: false, unassigned_at: now })
      .eq("conversation_id", conversation_id)
      .eq("is_active", true);

    const { error: updateErr } = await supabaseAdmin
      .from("conversations")
      .update({ assigned_agent_id: null, status: "open", updated_at: now })
      .eq("id", conversation_id);
    if (updateErr) {
      console.error(
        "[return-to-ai] CRITICAL: conversation update failed:",
        updateErr.message,
        conversation_id,
      );
    }

    await supabaseAdmin.from("conversation_status_log").insert({
      conversation_id,
      old_status: conversation.status,
      new_status: "open",
      changed_by: agent.id,
      changed_by_type: "agent",
      reason: "Return to AI",
    });

    await writeAudit(
      supabaseAdmin,
      agent.id,
      "return_to_ai",
      "conversations",
      conversation_id,
      {
        old_status: conversation.status,
        new_status: "open",
        old_agent_id: conversation.assigned_agent_id,
        new_agent_id: null,
      },
    );

    return json({ success: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
