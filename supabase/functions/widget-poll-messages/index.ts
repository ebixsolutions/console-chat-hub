import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "GET") return json({ success: false, error: "Method not allowed" }, 405);

  try {
    const url = new URL(req.url);
    const conversation_id = url.searchParams.get("conversation_id");
    const session_token = url.searchParams.get("session_token");
    const after_message_id = url.searchParams.get("after_message_id");
    if (!conversation_id || !session_token) {
      return json({ success: false, error: "Missing params" }, 400);
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
      .select("id, status, visitor_session_id, assigned_agent_id")
      .eq("id", conversation_id)
      .maybeSingle();
    if (!conv || conv.visitor_session_id !== session.id) {
      return json({ success: false, error: "Conversation not found" }, 404);
    }

    // Check for THINKING placeholder
    const { data: thinking } = await supabase
      .from("messages")
      .select("id")
      .eq("conversation_id", conversation_id)
      .eq("content", "__THINKING__")
      .eq("is_recalled", false)
      .limit(1);
    const ai_generating = !!(thinking && thinking.length > 0);

    let query = supabase
      .from("messages")
      .select("id, role, content, status, created_at, metadata")
      .eq("conversation_id", conversation_id)
      .eq("is_recalled", false)
      .neq("content", "__THINKING__")
      .order("created_at", { ascending: true });

    if (after_message_id) {
      const { data: anchor } = await supabase
        .from("messages")
        .select("created_at")
        .eq("id", after_message_id)
        .maybeSingle();
      if (anchor?.created_at) query = query.gt("created_at", anchor.created_at);
    }

    const { data: messages, error: mErr } = await query;
    if (mErr) return json({ success: false, error: mErr.message }, 500);

    const humanStatuses = new Set([
      "pending",
      "transferred",
      "human_needed",
      "escalation_risk",
      "unresolved",
    ]);
    const humanSupportState = humanStatuses.has(conv.status)
      ? (conv.assigned_agent_id ? "assigned" : "waiting")
      : "none";

    return json({
      success: true,
      data: {
        messages: messages ?? [],
        conversation_status: conv.status,
        ai_generating,
        human_support: {
          state: humanSupportState,
          agent_assigned: Boolean(conv.assigned_agent_id),
        },
      },
    });
  } catch (e) {
    return json({ success: false, error: (e as Error).message }, 500);
  }
});
