import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";
import { validateWidgetOrigin } from "../_shared/widget-origin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const { channel_id, visitor_fingerprint, visitor_metadata } = body ?? {};

    if (
      typeof channel_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        channel_id,
      )
    ) {
      return json({ success: false, error: "invalid_channel_id" }, 400);
    }

    if (
      visitor_metadata != null &&
      (
        typeof visitor_metadata !== "object" ||
        Array.isArray(visitor_metadata)
      )
    ) {
      return json({ success: false, error: "invalid_visitor_metadata" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Preflight public embed policy. The atomic RPC revalidates channel/company
    // state inside the transaction before creating any row.
    const { data: channel, error: chErr } = await supabase
      .from("channel_config")
      .select("id, is_active, channel_type, company_id, allowed_origins")
      .eq("id", channel_id)
      .eq("is_active", true)
      .eq("channel_type", "web_widget")
      .maybeSingle();

    if (chErr) {
      console.error("[create-visitor-session] channel lookup failed", chErr.code);
      return json({ success: false, error: "channel_lookup_failed" }, 500);
    }
    if (!channel) {
      return json({ success: false, error: "channel_not_found" }, 404);
    }
    if (!channel.company_id) {
      return json({ success: false, error: "channel_company_scope_not_configured" }, 409);
    }

    const originCheck = validateWidgetOrigin(req, channel.allowed_origins);
    if (!originCheck.ok) {
      return json({ success: false, error: originCheck.error }, 403);
    }

    const sessionToken =
      crypto.randomUUID() + "." + crypto.randomUUID().replace(/-/g, "");

    const userAgent = req.headers.get("user-agent") || null;
    const metadata = {
      ...(visitor_metadata ?? {}),
      origin: originCheck.origin,
      user_agent: userAgent,
    };

    const { data: result, error: txError } = await supabase.rpc(
      "create_widget_session_tx",
      {
        p_channel_id: channel_id,
        p_session_token: sessionToken,
        p_visitor_fingerprint:
          typeof visitor_fingerprint === "string"
            ? visitor_fingerprint.slice(0, 512)
            : null,
        p_visitor_metadata: metadata,
        p_page_url: originCheck.origin,
      },
    );

    if (txError) {
      console.error(
        "[create-visitor-session] create_widget_session_tx failed",
        txError.code,
      );
      return json({ success: false, error: "widget_session_create_failed" }, 500);
    }

    const txResult = String(result?.result ?? "unknown");
    if (txResult !== "success") {
      const status =
        txResult === "channel_not_found"
          ? 404
          : txResult === "channel_company_unresolved" ||
              txResult === "company_inactive"
            ? 409
            : 400;

      return json(
        {
          success: false,
          error: `widget_session_${txResult}`,
        },
        status,
      );
    }

    return json({
      success: true,
      data: {
        session_token: sessionToken,
        session_id: result.session_id,
        conversation_id: result.conversation_id,
      },
    });
  } catch (e) {
    console.error("[create-visitor-session] unexpected", (e as Error).name);
    return json({ success: false, error: "internal_error" }, 500);
  }
});
