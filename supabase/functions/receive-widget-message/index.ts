import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const { conversation_id, session_token, content } = await req.json().catch(() => ({}));
    if (!conversation_id || !session_token || !content) {
      return json({ success: false, error: "Missing fields" }, 400);
    }
    if (typeof content !== "string" || content.length === 0) {
      return json({ success: false, error: "Invalid content" }, 400);
    }
    if (content.length > 2000) {
      return json({ success: false, error: "Message too long (max 2000)" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: session } = await supabase
      .from("visitor_session")
      .select("id")
      .eq("session_token", session_token)
      .maybeSingle();
    if (!session) return json({ success: false, error: "Invalid session" }, 401);

    const { data: conv } = await supabase
      .from("conversations")
      .select("id, status, visitor_session_id")
      .eq("id", conversation_id)
      .maybeSingle();
    if (!conv || conv.visitor_session_id !== session.id) {
      return json({ success: false, error: "Conversation not found" }, 404);
    }
    if (conv.status === "resolved") {
      return json({ success: false, error: "Conversation is resolved" }, 403);
    }

    const { data: msg, error: mErr } = await supabase
      .from("messages")
      .insert({
        conversation_id,
        role: "visitor",
        content,
        status: "delivered",
      })
      .select("id")
      .single();
    if (mErr || !msg) return json({ success: false, error: mErr?.message || "insert failed" }, 500);

    // ── Dev21 Batch 1: Human-handling guard ──────────────────────────────
    // When status is 'pending' or 'transferred', a human agent is handling
    // this conversation. Accept the visitor message (inserted above) but do
    // NOT insert __THINKING__, do NOT set ai_generating=true, and do NOT
    // invoke generate-reply. The human agent will see the new message via
    // normal polling. Update conversations.updated_at so Console queue
    // refreshes and shows new activity. Clear ai_generating as safety.
    if (conv.status === "pending" || conv.status === "transferred") {
      console.log("[receive-widget-message] human-handling guard: skipping AI for status:", conv.status, conversation_id);
      await supabase
        .from("conversations")
        .update({
          updated_at: new Date().toISOString(),
        })
        .eq("id", conversation_id);
      await supabase
        .from("visitor_session")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", session.id);
      return json({ success: true, data: { message_id: msg.id, ai_reply_pending: false } });
    }
    // ── End Dev21 Batch 1 guard ─────────────────────────────────────────

    await supabase.from("messages").insert({
      conversation_id,
      role: "assistant",
      content: "__THINKING__",
      status: "sending",
    });

    await supabase
      .from("conversations")
      .update({ ai_generating: true })
      .eq("id", conversation_id);

    await supabase
      .from("visitor_session")
      .update({ last_seen_at: new Date().toISOString() })
      .eq("id", session.id);

    // Fire-and-forget: invoke generate-reply asynchronously
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    fetch(`${supabaseUrl}/functions/v1/generate-reply`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ conversation_id }),
    }).catch((err) => console.error("[NexusAI] generate-reply invoke error:", err));

    return json({ success: true, data: { message_id: msg.id, ai_reply_pending: true } });
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
