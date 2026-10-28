import { originalPreviewRequest } from "../_shared/original-widget-preview.ts";
import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";
import { validateWidgetOrigin } from "../_shared/widget-origin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);
  try {
    const { conversation_id, session_token, after_message_id, subscribe_events } = await req.json().catch(() => ({}));
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (typeof conversation_id !== "string" || !uuid.test(conversation_id) || typeof session_token !== "string" || session_token.length < 32 || session_token.length > 256 || (after_message_id != null && (typeof after_message_id !== "string" || !uuid.test(after_message_id)))) {
      return json({ success: false, error: "invalid_request" }, 400);
    }
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, getSupabaseAdminKey());
    const { data: session, error: sessionError } = await supabase.from("visitor_session")
      .select("id, channel_config:channel_config_id(id, company_id, is_active, channel_type, allowed_origins)")
      .eq("session_token", session_token).maybeSingle();
    if (sessionError) return json({ success: false, error: "session_scope_lookup_failed" }, 500);
    if (!session) return json({ success: false, error: "Invalid session" }, 401);
    const channel = session.channel_config as { id?: string; company_id?: string; is_active?: boolean; channel_type?: string; allowed_origins?: string[] | null } | null;
    if (!channel || channel.is_active !== true || channel.channel_type !== "web_widget") return json({ success: false, error: "widget_channel_unavailable" }, 403);
    const originCheck = validateWidgetOrigin(req, channel.allowed_origins);
    if (!originCheck.ok) return json({ success: false, error: originCheck.error }, 403);
    const { data: conv, error: convError } = await supabase.from("conversations")
      .select("id, company_id, channel_config_id, metadata_source, status, visitor_session_id, assigned_agent_id").eq("id", conversation_id).maybeSingle();
    if (convError) return json({ success: false, error: "conversation_lookup_failed" }, 500);
    if (!conv || conv.visitor_session_id !== session.id ||
      conv.channel_config_id !== channel.id || conv.company_id !== channel.company_id)
      return json({ success: false, error: "Conversation not found" }, 404);
    if(conv.metadata_source?.execution_class === "authenticated_admin_preview" && !await originalPreviewRequest(req,createClient,supabase,conv,false))
      return json({success:false,error:"original_preview_actor_or_authority_denied"},403);

    if (subscribe_events === true) {
      // The anonymous Widget cannot query staff-only Realtime rows. The
      // existing server validates session/channel/tenant/origin (and original
      // Preview ownership) before subscribing as server-side relay.
      // Only content-free invalidation events cross this stream.
      const encoder = new TextEncoder();
      let teardown: () => void = () => {};
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          let heartbeat: ReturnType<typeof setInterval> | null = null;
          const onAbort = () => teardown();
          const notify = (event: string) => {
            if (closed) return;
            try { controller.enqueue(encoder.encode("data: " + event + "\n\n")); }
            catch { teardown(); }
          };
          // Revalidate exact visitor ownership on each actual database
          // change. No scheduled token refresh / DB read is necessary,
          // and a revoked session may not observe later event activity.
          const verifiedNotify = async () => {
            if (closed) return;
            const { data: liveSession, error: sessionError } = await supabase
              .from("visitor_session")
              .select("id, channel_config:channel_config_id(id,company_id,is_active,channel_type,allowed_origins)")
              .eq("session_token", session_token).maybeSingle();
            const liveChannel = liveSession?.channel_config as {
              id?: string; company_id?: string; is_active?: boolean;
              channel_type?: string; allowed_origins?: string[] | null;
            } | null;
            if (sessionError || liveSession?.id !== session.id || !liveChannel ||
              liveChannel.id !== channel.id || liveChannel.company_id !== channel.company_id ||
              liveChannel.is_active !== true || liveChannel.channel_type !== "web_widget" ||
              !validateWidgetOrigin(req, liveChannel.allowed_origins).ok) { teardown(); return; }
            const { data: current, error: convError } = await supabase
              .from("conversations")
              .select("id,company_id,channel_config_id,visitor_session_id")
              .eq("id", conversation_id).maybeSingle();
            if (convError || !current || current.company_id !== liveChannel.company_id ||
              current.channel_config_id !== liveChannel.id ||
              current.visitor_session_id !== liveSession?.id) { teardown(); return; }
            if (!closed) notify("invalidate");
          };
          const channel = supabase.channel("widget-events-" + conversation_id + "-" + crypto.randomUUID())
            .on("postgres_changes", { event: "*", schema: "public", table: "messages",
              filter: "conversation_id=eq." + conversation_id }, () => { void verifiedNotify(); })
            .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations",
              filter: "id=eq." + conversation_id }, () => { void verifiedNotify(); });
          teardown = () => {
            if (closed) return;
            closed = true;
            if (heartbeat !== null) clearInterval(heartbeat);
            req.signal.removeEventListener("abort", onAbort);
            void supabase.removeChannel(channel);
            try { controller.close(); } catch { /* browser closed stream */ }
          };
          req.signal.addEventListener("abort", onAbort, { once: true });
          // Heartbeat is a comment-only keepalive and performs no database
          // read. Session revocation is checked on actual change events.
          heartbeat = setInterval(() => {
            if (!closed) {
              try { controller.enqueue(encoder.encode(": keep-alive\n\n")); }
              catch { teardown(); }
            }
          }, 25000);
          channel.subscribe(status => {
            if (closed) return;
            if (status === "SUBSCRIBED") notify("ready");
            if (status === "TIMED_OUT" || status === "CHANNEL_ERROR" || status === "CLOSED") teardown();
          });
        },
        cancel() { teardown(); },
      });
      return new Response(stream, { headers: {
        ...corsHeaders, "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no",
      } });
    }

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
          estimate_generated_at: queueSnapshot.estimate_generated_at ?? null,
          estimate_deadline: queueSnapshot.estimate_deadline ?? null,
          estimate_basis: queueSnapshot.estimate_basis ?? null,
          server_now: queueSnapshot.server_now ?? null,
        },
      },
    });
  } catch (e) {
    console.error("[widget-poll-messages] unexpected", (e as Error).name);
    return json({ success: false, error: "internal_error" }, 500);
  }
});
