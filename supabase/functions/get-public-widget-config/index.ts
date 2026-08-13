import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";
import { validateWidgetOrigin } from "../_shared/widget-origin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const url = new URL(req.url);
    const channelId = url.searchParams.get("channel_id");

    if (
      !channelId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        channelId,
      )
    ) {
      return json({ success: false, error: "invalid_channel_id" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase
      .from("channel_config")
      .select(
        "id, name, channel_type, is_active, company_id, allowed_origins, widget_config:widget_config_id(*)",
      )
      .eq("id", channelId)
      .eq("is_active", true)
      .eq("channel_type", "web_widget")
      .maybeSingle();

    if (error) {
      console.error("[get-public-widget-config] channel lookup failed", error.code);
      return json({ success: false, error: "channel_lookup_failed" }, 500);
    }

    if (!data || !data.widget_config) {
      return json({ success: false, error: "channel_not_found" }, 404);
    }

    if (!data.company_id) {
      return json(
        { success: false, error: "channel_company_scope_not_configured" },
        409,
      );
    }

    const { data: company, error: companyError } = await supabase
      .from("company")
      .select("id, is_active")
      .eq("id", data.company_id)
      .maybeSingle();

    if (companyError) {
      return json({ success: false, error: "company_lookup_failed" }, 500);
    }
    if (!company || company.is_active !== true) {
      return json({ success: false, error: "company_inactive" }, 409);
    }

    const originCheck = validateWidgetOrigin(req, data.allowed_origins);
    if (!originCheck.ok) {
      return json({ success: false, error: originCheck.error }, 403);
    }

    // Do not expose allowed_origins or company_id in the public response.
    return json({
      success: true,
      data: {
        id: data.id,
        name: data.name,
        channel_type: data.channel_type,
        is_active: data.is_active,
        widget_config: data.widget_config,
      },
    });
  } catch (e) {
    console.error("[get-public-widget-config] unexpected", (e as Error).name);
    return json({ success: false, error: "internal_error" }, 500);
  }
});
