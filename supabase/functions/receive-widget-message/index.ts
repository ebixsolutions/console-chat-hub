import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";
import { validateWidgetOrigin } from "../_shared/widget-origin.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  try {
    const { conversation_id, session_token, content } = await req
      .json()
      .catch(() => ({}));

    if (
      typeof conversation_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        conversation_id,
      ) ||
      typeof session_token !== "string" ||
      session_token.length < 32 ||
      session_token.length > 256 ||
      typeof content !== "string"
    ) {
      return json({ success: false, error: "invalid_request" }, 400);
    }

    const normalizedContent = content.trim();
    if (!normalizedContent) {
      return json({ success: false, error: "invalid_content" }, 400);
    }
    if (normalizedContent.length > 2000) {
      return json({ success: false, error: "message_too_long" }, 400);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: sessionScope, error: sessionScopeError } = await supabase
      .from("visitor_session")
      .select(
        "id, channel_config:channel_config_id(id, is_active, channel_type, allowed_origins)",
      )
      .eq("session_token", session_token)
      .maybeSingle();

    if (sessionScopeError) {
      console.error(
        "[receive-widget-message] session origin scope lookup failed",
        sessionScopeError.code,
      );
      return json({ success: false, error: "session_scope_lookup_failed" }, 500);
    }
    if (!sessionScope) {
      return json({ success: false, error: "Invalid session" }, 401);
    }

    const channel = sessionScope.channel_config as {
      id?: string;
      is_active?: boolean;
      channel_type?: string;
      allowed_origins?: string[] | null;
    } | null;

    if (
      !channel ||
      channel.is_active !== true ||
      channel.channel_type !== "web_widget"
    ) {
      return json({ success: false, error: "widget_channel_unavailable" }, 403);
    }

    const originCheck = validateWidgetOrigin(req, channel.allowed_origins);
    if (!originCheck.ok) {
      return json({ success: false, error: originCheck.error }, 403);
    }

    const { data: txData, error: txError } = await supabase.rpc(
      "receive_widget_message_tx",
      {
        p_conversation_id: conversation_id,
        p_session_token: session_token,
        p_content: normalizedContent,
      },
    );

    if (txError) {
      console.error(
        "[receive-widget-message] receive_widget_message_tx failed",
        txError.code,
        conversation_id,
      );
      return json(
        {
          success: false,
          error: "widget_message_transaction_failed",
        },
        500,
      );
    }

    const result = String(txData?.result ?? "unknown");

    if (result === "invalid_session") {
      return json({ success: false, error: "Invalid session" }, 401);
    }
    if (result === "not_found") {
      return json({ success: false, error: "Conversation not found" }, 404);
    }
    if (result === "resolved") {
      return json({ success: false, error: "Conversation is resolved" }, 403);
    }
    if (result !== "success" && result !== "human_control") {
      return json({ success: false, error: "widget_message_rejected" }, 409);
    }

    const messageId = String(txData?.message_id ?? "");
    if (!messageId) {
      return json({ success: false, error: "widget_message_missing_id" }, 500);
    }

    if (result === "human_control") {
      return json({
        success: true,
        data: {
          message_id: messageId,
          ai_reply_pending: false,
          control_state: "human_control",
        },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    fetch(`${supabaseUrl}/functions/v1/generate-reply`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conversation_id,
        source_message_id: messageId,
      }),
    }).catch((err) =>
      console.error("[receive-widget-message] generate-reply invoke error", err),
    );

    return json({
      success: true,
      data: {
        message_id: messageId,
        ai_reply_pending: true,
        control_state: "ai",
      },
    });
  } catch (e) {
    console.error("[receive-widget-message] unexpected", (e as Error).name);
    return json({ success: false, error: "internal_error" }, 500);
  }
});
