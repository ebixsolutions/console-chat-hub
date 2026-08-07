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

    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status, assigned_agent_id")
      .eq("id", conversation_id)
      .single();
    if (convErr || !conv) return json({ error: "Conversation not found" }, 404);

    if (!ELEVATED.has(agent.role)) {
      if (conv.assigned_agent_id !== agent.id) {
        return json(
          { error: "You can only resolve conversations assigned to you", error_type: "not_conversation_owner" },
          403,
        );
      }
    }



    const now = new Date().toISOString();
    const { error: uErr } = await supabaseAdmin
      .from("conversations")
      .update({ status: "resolved", resolved_at: now, updated_at: now })
      .eq("id", conversation_id);
    if (uErr) return json({ error: uErr.message }, 500);

    await supabaseAdmin.from("conversation_status_log").insert({
      conversation_id,
      old_status: conv.status,
      new_status: "resolved",
      changed_by: agent.id,
      changed_by_type: "agent",
    });

    await writeAudit(supabaseAdmin, agent.id, "resolve_conversation", "conversations", conversation_id, {
      old_status: conv.status,
      new_status: "resolved",
    });

    return json({ success: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
