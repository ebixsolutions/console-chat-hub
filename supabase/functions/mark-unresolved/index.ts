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
    const reason = body?.reason || null;
    if (!conversation_id) return json({ error: "conversation_id required" }, 400);

    const { data: conv, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id, status")
      .eq("id", conversation_id)
      .single();
    if (convErr || !conv) return json({ error: "Conversation not found" }, 404);

    const now = new Date().toISOString();
    const { error: uErr } = await supabaseAdmin
      .from("conversations")
      .update({ status: "unresolved", resolved_at: null, updated_at: now })
      .eq("id", conversation_id);
    if (uErr) return json({ error: uErr.message }, 500);

    await supabaseAdmin.from("conversation_status_log").insert({
      conversation_id,
      old_status: conv.status,
      new_status: "unresolved",
      changed_by: agent.id,
      changed_by_type: "agent",
      reason,
    });

    await writeAudit(supabaseAdmin, agent.id, "mark_unresolved", "conversations", conversation_id, {
      old_status: conv.status,
      new_status: "unresolved",
      reason,
    });

    return json({ success: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
