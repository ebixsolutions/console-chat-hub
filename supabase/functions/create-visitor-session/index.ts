import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const { channel_id, visitor_fingerprint, visitor_metadata } = body ?? {};
    if (!channel_id) return json({ success: false, error: "channel_id required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: channel, error: chErr } = await supabase
      .from("channel_config")
      .select("id, is_active, channel_type")
      .eq("id", channel_id)
      .eq("is_active", true)
      .eq("channel_type", "web_widget")
      .maybeSingle();
    if (chErr) return json({ success: false, error: chErr.message }, 500);
    if (!channel) return json({ success: false, error: "Channel not found, inactive, or not a web widget channel" }, 404);

    // TODO L2.1: Uncomment below to enforce allowed_origins before production
    // Origin validation skeleton — currently dev-bypassed

    const origin = req.headers.get("origin") || req.headers.get("referer") || null;
    const userAgent = req.headers.get("user-agent") || null;
    const metadata = { ...(visitor_metadata || {}), origin, user_agent: userAgent };

    const sessionToken = crypto.randomUUID() + "." + crypto.randomUUID().replace(/-/g, "");

    const { data: session, error: sErr } = await supabase
      .from("visitor_session")
      .insert({
        session_token: sessionToken,
        channel_config_id: channel_id,
        visitor_fingerprint: visitor_fingerprint ?? null,
        visitor_metadata: metadata,
        last_seen_at: new Date().toISOString(),
      })
      .select("id, session_token")
      .single();
    if (sErr || !session) return json({ success: false, error: sErr?.message || "session failed" }, 500);

    const { data: conv, error: cErr } = await supabase
      .from("conversations")
      .insert({
        visitor_session_id: session.id,
        channel_config_id: channel_id,
        status: "open",
      })
      .select("id")
      .single();
    if (cErr || !conv) return json({ success: false, error: cErr?.message || "conversation failed" }, 500);

    await supabase.from("widget_session_event").insert({
      visitor_session_id: session.id,
      event_type: "widget_open",
      event_data: { conversation_id: conv.id },
      page_url: origin,
    });

    return json({
      success: true,
      data: {
        session_token: session.session_token,
        session_id: session.id,
        conversation_id: conv.id,
      },
    });
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
