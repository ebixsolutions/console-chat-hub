import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const MAX_RECENT = 20;

const CONSOLE_ORIGINS = [
  "https://console-chat-hub.lovable.app",
  "https://id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app",
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = CONSOLE_ORIGINS.includes(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function jsonResponse(body: unknown, status: number, req: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
  });
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function toSessionRef(uuid: string): string {
  const clean = uuid.replace(/-/g, "");
  return "vs_" + clean.slice(0, 4) + "..." + clean.slice(-4);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const optOrigin = req.headers.get("Origin") ?? "";
    if (!CONSOLE_ORIGINS.includes(optOrigin)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, { headers: getCorsHeaders(req) });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, req);
  }

  const requestOrigin = req.headers.get("Origin");
  if (requestOrigin && !CONSOLE_ORIGINS.includes(requestOrigin)) {
    return new Response(JSON.stringify({ error: "forbidden_origin" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user }, error: authErr } = await supabaseAuth.auth.getUser();
    if (authErr || !user) {
      return jsonResponse({ error: "unauthorized" }, 401, req);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const { data: userRoles, error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    if (roleErr || !userRoles || userRoles.length === 0) {
      return jsonResponse({ error: "forbidden" }, 403, req);
    }
    if (!userRoles.some((r: { role: string }) => ALLOWED_ROLES.has(r.role))) {
      return jsonResponse({ error: "forbidden" }, 403, req);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "invalid_request", detail: "JSON body required" }, 400, req);
    }

    const bodyKeys = Object.keys(body);
    const mode = body.mode;
    const visitorSessionId = body.visitor_session_id;

    const allowedKeys = new Set(["mode", "visitor_session_id"]);
    for (const k of bodyKeys) {
      if (!allowedKeys.has(k)) {
        return jsonResponse({ error: "invalid_request", detail: "unknown field" }, 400, req);
      }
    }

    const hasMode = mode !== undefined;
    const hasVsId = visitorSessionId !== undefined;

    if (hasMode && hasVsId) {
      return jsonResponse({ error: "invalid_request", detail: "provide mode or visitor_session_id, not both" }, 400, req);
    }
    if (!hasMode && !hasVsId) {
      return jsonResponse({ error: "invalid_request", detail: "provide mode:'summary' or visitor_session_id" }, 400, req);
    }
    if (hasMode && mode !== "summary") {
      return jsonResponse({ error: "invalid_request", detail: "mode must be 'summary'" }, 400, req);
    }

    if (mode === "summary") {
      const { count: totalSessions, error: e1 } = await supabaseAdmin
        .from("visitor_session")
        .select("id", { count: "exact", head: true });
      if (e1) {
        console.error("[visitor-analytics] sessions_count failed");
        return jsonResponse({ error: "analytics_query_failed" }, 500, req);
      }

      const { data: convRows, error: e2 } = await supabaseAdmin
        .from("conversations")
        .select("id, status");
      if (e2) {
        console.error("[visitor-analytics] conversations_query failed");
        return jsonResponse({ error: "analytics_query_failed" }, 500, req);
      }
      const totalConversations = convRows?.length ?? 0;
      const statusCounts: Record<string, number> = {};
      (convRows ?? []).forEach((c: { status: string }) => {
        statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
      });

      const { count: msgCount, error: e3 } = await supabaseAdmin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .neq("content", "__THINKING__")
        .eq("is_recalled", false);
      if (e3) {
        console.error("[visitor-analytics] message_count failed");
        return jsonResponse({ error: "analytics_query_failed" }, 500, req);
      }

      const { data: fbRows, error: e4 } = await supabaseAdmin
        .from("feedback_request")
        .select("rating")
        .not("rating", "is", null);
      if (e4) {
        console.error("[visitor-analytics] feedback_query failed");
        return jsonResponse({ error: "analytics_query_failed" }, 500, req);
      }
      const feedbackCount = fbRows?.length ?? 0;
      let avgRating: number | null = null;
      if (feedbackCount > 0) {
        const sum = (fbRows ?? []).reduce((a: number, r: { rating: number | null }) => a + (r.rating ?? 0), 0);
        avgRating = Math.round((sum / feedbackCount) * 10) / 10;
      }

      const { data: recentSessions, error: e5 } = await supabaseAdmin
        .from("visitor_session")
        .select("id, created_at, last_seen_at")
        .order("last_seen_at", { ascending: false })
        .limit(MAX_RECENT);
      if (e5) {
        console.error("[visitor-analytics] recent_sessions failed");
        return jsonResponse({ error: "analytics_query_failed" }, 500, req);
      }

      const recentList = [];
      for (const vs of (recentSessions ?? [])) {
        const { count: convCount, error: e6 } = await supabaseAdmin
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("visitor_session_id", vs.id);
        if (e6) {
          console.error("[visitor-analytics] session_conv_count failed");
          return jsonResponse({ error: "analytics_query_failed" }, 500, req);
        }
        const { data: lastConv, error: e7 } = await supabaseAdmin
          .from("conversations")
          .select("status")
          .eq("visitor_session_id", vs.id)
          .order("updated_at", { ascending: false })
          .limit(1);
        if (e7) {
          console.error("[visitor-analytics] last_conv_query failed");
          return jsonResponse({ error: "analytics_query_failed" }, 500, req);
        }
        recentList.push({
          session_ref: toSessionRef(vs.id),
          first_seen: vs.created_at,
          last_seen: vs.last_seen_at,
          conversation_count: convCount ?? 0,
          last_status: lastConv?.[0]?.status ?? "unknown",
        });
      }

      return jsonResponse({
        success: true,
        summary: {
          total_sessions: totalSessions ?? 0,
          total_conversations: totalConversations,
          status_counts: statusCounts,
          total_messages: msgCount ?? 0,
          feedback_count: feedbackCount,
          average_rating: avgRating,
          recent_sessions: recentList,
        },
      }, 200, req);
    }

    if (hasVsId) {
      if (!isUuid(visitorSessionId)) {
        return jsonResponse({ error: "invalid_request", detail: "visitor_session_id must be valid UUID" }, 400, req);
      }

      const { data: vs, error: eVs } = await supabaseAdmin
        .from("visitor_session")
        .select("id, created_at, last_seen_at")
        .eq("id", visitorSessionId)
        .maybeSingle();
      if (eVs) {
        console.error("[visitor-analytics] session_lookup failed");
        return jsonResponse({ error: "analytics_query_failed" }, 500, req);
      }
      if (!vs) {
        return jsonResponse({ error: "not_found" }, 404, req);
      }

      const { data: convs, error: eConvs } = await supabaseAdmin
        .from("conversations")
        .select("id, status, created_at, resolved_at, updated_at")
        .eq("visitor_session_id", vs.id)
        .order("created_at", { ascending: false });
      if (eConvs) {
        console.error("[visitor-analytics] visitor_convs failed");
        return jsonResponse({ error: "analytics_query_failed" }, 500, req);
      }

      const convList = [];
      for (const c of (convs ?? [])) {
        const { count: cMsgCount, error: eMc } = await supabaseAdmin
          .from("messages")
          .select("id", { count: "exact", head: true })
          .eq("conversation_id", c.id)
          .neq("content", "__THINKING__")
          .eq("is_recalled", false);
        if (eMc) {
          console.error("[visitor-analytics] detail_msg_count failed");
          return jsonResponse({ error: "analytics_query_failed" }, 500, req);
        }

        const { data: fb, error: eFb } = await supabaseAdmin
          .from("feedback_request")
          .select("rating")
          .eq("conversation_id", c.id)
          .not("rating", "is", null)
          .limit(1);
        if (eFb) {
          console.error("[visitor-analytics] detail_feedback failed");
          return jsonResponse({ error: "analytics_query_failed" }, 500, req);
        }

        convList.push({
          status: c.status,
          created_at: c.created_at,
          resolved_at: c.resolved_at,
          message_count: cMsgCount ?? 0,
          has_feedback: (fb?.length ?? 0) > 0,
          rating: fb?.[0]?.rating ?? null,
        });
      }

      return jsonResponse({
        success: true,
        visitor: {
          session_ref: toSessionRef(vs.id),
          first_seen: vs.created_at,
          last_seen: vs.last_seen_at,
          conversations: convList,
        },
      }, 200, req);
    }

    return jsonResponse({ error: "invalid_request", detail: "provide mode:'summary' or visitor_session_id" }, 400, req);

  } catch (e) {
    console.error("[visitor-analytics] unexpected error:", (e as Error).name);
    return jsonResponse({ error: "internal_error" }, 500, req);
  }
});
