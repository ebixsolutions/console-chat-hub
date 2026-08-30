import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";
import { validateWidgetOrigin } from "../_shared/widget-origin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);
  try {
    const { conversation_id, session_token, after_message_id } = await req.json().catch(() => ({}));
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof conversation_id !== "string" || !uuid.test(conversation_id) || typeof session_token !== "string" || session_token.length < 32 || session_token.length > 256 || (after_message_id != null && (typeof after_message_id !== "string" || !uuid.test(after_message_id)))) {
      return json({ success: false, error: "invalid_request" }, 400);
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, getSupabaseAdminKey());
    const { data: session, error: sessionError } = await supabase.from("visitor_session")
      .select("id, channel_config:channel_config_id(id, is_active, channel_type, allowed_origins)")
      .eq("session_token", session_token).maybeSingle();
    if (sessionError) return json({ success: false, error: "session_scope_lookup_failed" }, 500);
    if (!session) return json({ success: false, error: "Invalid session" }, 401);
    const channel = session.channel_config as { id?: string; is_active?: boolean; channel_type?: string; allowed_origins?: string[] | null } | null;
    if (!channel || channel.is_active !== true || channel.channel_type !== "web_widget") return json({ success: false, error: "widget_channel_unavailable" }, 403);
    const originCheck = validateWidgetOrigin(req, channel.allowed_origins);
    if (!originCheck.ok) return json({ success: false, error: originCheck.error }, 403);
    const { data: conv, error: convError } = await supabase.from("conversations")
      .select("id, status, visitor_session_id, assigned_agent_id").eq("id", conversation_id).maybeSingle();
    if (convError) return json({ success: false, error: "conversation_lookup_failed" }, 500);
    if (!conv || conv.visitor_session_id !== session.id) return json({ success: false, error: "Conversation not found" }, 404);
    const { data: thinking, error: thinkingError } = await supabase.from("messages").select("id")
      .eq("conversation_id", conversation_id).eq("content", "__THINKING__").eq("is_recalled", false).limit(1);
    if (thinkingError) return json({ success: false, error: "thinking_lookup_failed" }, 500);
    let query = supabase.from("messages").select("id, role, content, content_type, status, created_at, metadata")
      .eq("conversation_id", conversation_id).eq("is_recalled", false).neq("content", "__THINKING__")
      .order("created_at", { ascending: true }).order("id", { ascending: true });
    if (after_message_id) {
      const { data: anchor, error: anchorError } = await supabase.from("messages").select("created_at")
        .eq("id", after_message_id).eq("conversation_id", conversation_id).maybeSingle();
      if (anchorError) return json({ success: false, error: "anchor_lookup_failed" }, 500);
      if (anchor?.created_at) query = query.gte("created_at", anchor.created_at);
    }
    const { data: messages, error: messageError } = await query;
    if (messageError) return json({ success: false, error: "message_poll_failed" }, 500);

    const humanStatuses = new Set(["pending", "transferred", "unresolved"]);
    const humanSupportState = humanStatuses.has(conv.status) ? (conv.assigned_agent_id ? "assigned" : "waiting") : "none";
    let queueSnapshot: Record<string, unknown> = {
      state: humanSupportState,
      queue_position: humanSupportState === "assigned" ? 0 : null,
      customers_ahead: humanSupportState === "assigned" ? 0 : null,
      estimated_wait_minutes: humanSupportState === "assigned" ? 0 : null,
      estimate_confidence: humanSupportState === "assigned" ? "assigned" : "unavailable",
    };
    if (humanSupportState !== "none") {
      const { data: queueData, error: queueError } = await supabase.rpc("get_human_support_queue_snapshot", { p_conversation_id: conversation_id });
      if (queueError) return json({ success: false, error: "human_queue_lookup_failed" }, 500);
      if (queueData && typeof queueData === "object") queueSnapshot = queueData as Record<string, unknown>;
    }

    return json({
      success: true,
      data: {
        messages: messages ?? [],
        conversation_status: conv.status,
        ai_generating: Boolean(thinking?.length),
        human_support: {
          state: humanSupportState,
          agent_assigned: Boolean(conv.assigned_agent_id),
          queue_position: queueSnapshot.queue_position ?? null,
          customers_ahead: queueSnapshot.customers_ahead ?? null,
          estimated_wait_minutes: queueSnapshot.estimated_wait_minutes ?? null,
          estimate_confidence: queueSnapshot.estimate_confidence ?? "unavailable",
        },
      },
    });
  } catch (e) {
    console.error("[widget-poll-messages] unexpected", (e as Error).name);
    return json({ success: false, error: "internal_error" }, 500);
  }
});
