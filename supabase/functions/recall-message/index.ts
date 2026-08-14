import { corsHeaders, json } from "../_shared/cors.ts";
import {
  resolveAgentCompanyScope,
  validateAgent,
  writeAudit,
} from "../_shared/agent.ts";

const ELEVATED = new Set(["admin", "supervisor"]);
const ADMIN_ONLY = new Set(["admin"]);

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
    const reason = body?.reason || null;
    if (!message_id) return json({ error: "message_id required" }, 400);

    const { data: message, error: mErr } = await supabaseAdmin
      .from("messages")
      .select("id, role, metadata, conversation_id")
      .eq("id", message_id)
      .maybeSingle();
    if (mErr) return json({ error: "Message lookup failed" }, 500);
    if (!message) return json({ error: "Message not found" }, 404);

    const { data: scopedConversation, error: convErr } = await supabaseAdmin
      .from("conversations")
      .select("id")
      .eq("id", message.conversation_id)
      .eq("company_id", scope.companyId)
      .maybeSingle();
    if (convErr) return json({ error: "Conversation lookup failed" }, 500);
    if (!scopedConversation) return json({ error: "Message not found" }, 404);

    if (message.role === "visitor") {
      if (!ADMIN_ONLY.has(scope.companyRole)) {
        return json({ error: "Only company admins can recall visitor messages" }, 403);
      }
    } else if (message.role === "agent") {
      const ownerId = (message.metadata as Record<string, unknown> | null)?.agent_id;
      const isOwn = ownerId === agent.id;
      if (!isOwn && !ELEVATED.has(scope.companyRole)) {
        return json({ error: "Cannot recall another agent's message" }, 403);
      }
    }
    // assistant role: any active agent in the same company is allowed.

    const existingMeta = (message.metadata as Record<string, unknown> | null) || {};
    const { error: uErr } = await supabaseAdmin
      .from("messages")
      .update({
        is_recalled: true,
        status: "recalled",
        metadata: {
          ...existingMeta,
          recalled_by: agent.id,
          recalled_at: new Date().toISOString(),
          recall_reason: reason,
          original_content_preserved: true,
        },
      })
      .eq("id", message_id)
      .eq("conversation_id", message.conversation_id);
    if (uErr) return json({ error: uErr.message }, 500);

    await writeAudit(supabaseAdmin, agent.id, "recall_message", "messages", message_id, {
      role: message.role,
      reason,
      company_id: scope.companyId,
    });

    return json({ success: true });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
