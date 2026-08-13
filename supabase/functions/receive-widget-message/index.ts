import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";

const HUMAN_HANDLING_STATUSES = new Set([
  "pending",
  "transferred",
  "human_needed",
  "escalation_risk",
  "unresolved",
]);

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

    // PR-3 control race guard: claim AI control under a conversation row lock.
    const { data: beginData, error: beginErr } = await supabase.rpc(
      "begin_ai_reply_tx",
      {
        p_conversation_id: conversation_id,
        p_source_message_id: msg.id,
      },
    );

    if (beginErr) {
      console.error("[receive-widget-message] begin_ai_reply_tx failed:", beginErr.message, conversation_id);
      await supabase
        .from("visitor_session")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", session.id);
      return json({
        success: false,
        error: "AI control check failed",
        data: { message_id: msg.id, ai_reply_pending: false },
      }, 503);
    }

    const beginResult = String(beginData?.result ?? beginData ?? "unknown");
    if (beginResult === "human_control" || beginResult === "resolved") {
      await supabase
        .from("conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", conversation_id);
      await supabase
        .from("visitor_session")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", session.id);
      return json({
        success: true,
        data: {
          message_id: msg.id,
          ai_reply_pending: false,
          control_state: beginResult,
        },
      });
    }

    if (beginResult !== "success") {
      console.error("[receive-widget-message] begin_ai_reply_tx rejected:", beginResult, conversation_id);
      return json({
        success: false,
        error: "AI control claim rejected",
        data: { message_id: msg.id, ai_reply_pending: false },
      }, 409);
    }

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
      body: JSON.stringify({ conversation_id, source_message_id: msg.id }),
    }).catch((err) => console.error("[NexusAI] generate-reply invoke error:", err));

    return json({ success: true, data: { message_id: msg.id, ai_reply_pending: true } });
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
