import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const url = new URL(req.url);
    const channelId = url.searchParams.get("channel_id");
    if (!channelId) return json({ success: false, error: "channel_id required" }, 400);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase
      .from("channel_config")
      .select("id, name, channel_type, is_active, allowed_origins, widget_config:widget_config_id(*)")
      .eq("id", channelId)
      .eq("is_active", true)
      .eq("channel_type", "web_widget")
      .maybeSingle();

    if (error) return json({ success: false, error: error.message }, 500);
    if (!data || !data.widget_config) return json({ success: false, error: "Channel not found" }, 404);

    return json({ success: true, data });
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
