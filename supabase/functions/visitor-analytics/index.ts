import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  applyCompanyScope,
  resolveCallerScope,
  type ResolvedScope,
} from "../_shared/pre-activation-scope.ts";

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
// Pre-activation analytics is a null-company functional mode only.
const PRE_ACTIVATION_ROLES: ReadonlySet<string> = new Set(["admin", "supervisor"]);

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

function scopeDescriptor(scope: ResolvedScope) {
  return { company_id: scope.companyId, mode: scope.mode };
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
    const auth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization") ?? "" },
        },
      },
    );
    const {
      data: { user },
      error: authError,
    } = await auth.auth.getUser();
    if (authError || !user) {
      return jsonResponse({ error: "unauthorized" }, 401, req);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: userRoles, error: roleError } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    if (
      roleError ||
      !userRoles?.some((row: { role: string }) => ALLOWED_ROLES.has(row.role))
    ) {
      return jsonResponse({ error: "forbidden" }, 403, req);
    }

    const scopeResult = await resolveCallerScope(admin, {
      userId: user.id,
      preActivationRoles: PRE_ACTIVATION_ROLES,
    });
    if (!scopeResult.ok) {
      return jsonResponse({ error: scopeResult.error }, scopeResult.status, req);
    }
    const scope = scopeResult.scope;

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse(
        { error: "invalid_request", detail: "JSON body required" },
        400,
        req,
      );
    }

    const allowedKeys = new Set(["mode", "visitor_session_id"]);
    for (const key of Object.keys(body)) {
      if (!allowedKeys.has(key)) {
        return jsonResponse(
          { error: "invalid_request", detail: "unknown field" },
          400,
          req,
        );
      }
    }

    const mode = body.mode;
    const visitorSessionId = body.visitor_session_id;
    const hasMode = mode !== undefined;
    const hasVisitor = visitorSessionId !== undefined;

    if (hasMode === hasVisitor) {
      return jsonResponse(
        {
          error: "invalid_request",
          detail: "provide exactly one of mode or visitor_session_id",
        },
        400,
        req,
      );
    }

    if (hasMode && mode !== "summary") {
      return jsonResponse(
        { error: "invalid_request", detail: "mode must be 'summary'" },
        400,
        req,
      );
    }

    if (mode === "summary") {
      // Tenant boundary is conversations.company_id in canonical mode, and
      // company_id IS NULL in pre-activation mode. Every downstream metric is
      // derived exclusively from this scoped conversation set.
      const { data: conversations, error: conversationError } = await applyCompanyScope(
        admin
          .from("conversations")
          .select(
            "id, visitor_session_id, status, created_at, updated_at, resolved_at",
          ),
        scope,
      );

      if (conversationError) {
        console.error(
          "[visitor-analytics] scoped conversations query failed",
          conversationError.code,
        );
        return jsonResponse({ error: "analytics_query_failed" }, 500, req);
      }

      const convRows = conversations ?? [];
      const conversationIds = convRows.map((row) => String(row.id));
      const sessionIds = [
        ...new Set(
          convRows
            .map((row) =>
              row.visitor_session_id ? String(row.visitor_session_id) : null
            )
            .filter((id): id is string => Boolean(id)),
        ),
      ];

      const statusCounts: Record<string, number> = {};
      for (const row of convRows) {
        statusCounts[String(row.status)] =
          (statusCounts[String(row.status)] ?? 0) + 1;
      }

      let totalMessages = 0;
      let feedbackRows: Array<{ conversation_id: string; rating: number | null }> =
        [];

      if (conversationIds.length > 0) {
        const { count, error } = await admin
          .from("messages")
          .select("id", { count: "exact", head: true })
          .in("conversation_id", conversationIds)
          .neq("content", "__THINKING__")
          .eq("is_recalled", false);
        if (error) {
          return jsonResponse({ error: "analytics_query_failed" }, 500, req);
        }
        totalMessages = count ?? 0;

        const { data, error: feedbackError } = await admin
          .from("feedback_request")
          .select("conversation_id, rating")
          .in("conversation_id", conversationIds)
          .not("rating", "is", null);
        if (feedbackError) {
          return jsonResponse({ error: "analytics_query_failed" }, 500, req);
        }
        feedbackRows = (data ?? []) as Array<{
          conversation_id: string;
          rating: number | null;
        }>;
      }

      const feedbackCount = feedbackRows.length;
      const averageRating =
        feedbackCount > 0
          ? Math.round(
              (feedbackRows.reduce(
                (sum, row) => sum + Number(row.rating ?? 0),
                0,
              ) /
                feedbackCount) *
                10,
            ) / 10
          : null;

      const sessionsById = new Map<
        string,
        {
          id: string;
          firstSeen: string | null;
          lastSeen: string | null;
          conversationCount: number;
          lastStatus: string;
          lastUpdatedAt: string | null;
        }
      >();

      for (const row of convRows) {
        if (!row.visitor_session_id) continue;
        const sessionId = String(row.visitor_session_id);
        const existing = sessionsById.get(sessionId);
        const createdAt = row.created_at ? String(row.created_at) : null;
        const updatedAt = row.updated_at ? String(row.updated_at) : createdAt;

        if (!existing) {
          sessionsById.set(sessionId, {
            id: sessionId,
            firstSeen: createdAt,
            lastSeen: updatedAt,
            conversationCount: 1,
            lastStatus: String(row.status),
            lastUpdatedAt: updatedAt,
          });
          continue;
        }

        existing.conversationCount += 1;
        if (
          createdAt &&
          (!existing.firstSeen ||
            new Date(createdAt).getTime() <
              new Date(existing.firstSeen).getTime())
        ) {
          existing.firstSeen = createdAt;
        }
        if (
          updatedAt &&
          (!existing.lastUpdatedAt ||
            new Date(updatedAt).getTime() >
              new Date(existing.lastUpdatedAt).getTime())
        ) {
          existing.lastSeen = updatedAt;
          existing.lastUpdatedAt = updatedAt;
          existing.lastStatus = String(row.status);
        }
      }

      // Session timestamps are metadata only. Read only sessions proven to
      // belong to this company by the scoped conversation relationship.
      const sessionMeta = new Map<
        string,
        { created_at: string | null; last_seen_at: string | null }
      >();
      if (sessionIds.length > 0) {
        const { data, error } = await admin
          .from("visitor_session")
          .select("id, created_at, last_seen_at")
          .in("id", sessionIds);
        if (error) {
          return jsonResponse({ error: "analytics_query_failed" }, 500, req);
        }
        for (const row of data ?? []) {
          sessionMeta.set(String(row.id), {
            created_at: row.created_at ? String(row.created_at) : null,
            last_seen_at: row.last_seen_at ? String(row.last_seen_at) : null,
          });
        }
      }

      const recentSessions = [...sessionsById.values()]
        .map((session) => {
          const meta = sessionMeta.get(session.id);
          return {
            session_ref: toSessionRef(session.id),
            first_seen: meta?.created_at ?? session.firstSeen,
            last_seen: meta?.last_seen_at ?? session.lastSeen,
            conversation_count: session.conversationCount,
            last_status: session.lastStatus,
          };
        })
        .sort((a, b) => {
          const at = a.last_seen ? new Date(a.last_seen).getTime() : 0;
          const bt = b.last_seen ? new Date(b.last_seen).getTime() : 0;
          return bt - at;
        })
        .slice(0, MAX_RECENT);

      return jsonResponse(
        {
          success: true,
          scope: scopeDescriptor(scope),
          summary: {
            total_sessions: sessionIds.length,
            total_conversations: convRows.length,
            status_counts: statusCounts,
            total_messages: totalMessages,
            feedback_count: feedbackCount,
            average_rating: averageRating,
            recent_sessions: recentSessions,
          },
        },
        200,
        req,
      );
    }

    if (!isUuid(visitorSessionId)) {
      return jsonResponse(
        {
          error: "invalid_request",
          detail: "visitor_session_id must be valid UUID",
        },
        400,
        req,
      );
    }

    // Cross-tenant protection: a visitor session is visible only if it has at
    // least one conversation inside the resolved scope.
    const { data: scopedConversations, error: scopedError } = await applyCompanyScope(
      admin
        .from("conversations")
        .select("id, status, created_at, resolved_at, updated_at"),
      scope,
    )
      .eq("visitor_session_id", visitorSessionId)
      .order("created_at", { ascending: false });

    if (scopedError) {
      return jsonResponse({ error: "analytics_query_failed" }, 500, req);
    }
    if (!scopedConversations || scopedConversations.length === 0) {
      // Return 404 rather than revealing that the session may exist elsewhere.
      return jsonResponse({ error: "not_found" }, 404, req);
    }

    const { data: visitor, error: visitorError } = await admin
      .from("visitor_session")
      .select("id, created_at, last_seen_at")
      .eq("id", visitorSessionId)
      .maybeSingle();

    if (visitorError || !visitor) {
      return jsonResponse({ error: "not_found" }, 404, req);
    }

    const conversationIds = scopedConversations.map((row) => String(row.id));
    const { data: messages, error: messageError } = await admin
      .from("messages")
      .select("conversation_id, id, content, is_recalled")
      .in("conversation_id", conversationIds)
      .neq("content", "__THINKING__")
      .eq("is_recalled", false);

    if (messageError) {
      return jsonResponse({ error: "analytics_query_failed" }, 500, req);
    }

    const { data: feedback, error: feedbackError } = await admin
      .from("feedback_request")
      .select("conversation_id, rating")
      .in("conversation_id", conversationIds)
      .not("rating", "is", null);

    if (feedbackError) {
      return jsonResponse({ error: "analytics_query_failed" }, 500, req);
    }

    const messageCount = new Map<string, number>();
    for (const row of messages ?? []) {
      const id = String(row.conversation_id);
      messageCount.set(id, (messageCount.get(id) ?? 0) + 1);
    }

    const ratingByConversation = new Map<string, number>();
    for (const row of feedback ?? []) {
      const id = String(row.conversation_id);
      if (!ratingByConversation.has(id) && row.rating != null) {
        ratingByConversation.set(id, Number(row.rating));
      }
    }

    return jsonResponse(
      {
        success: true,
        scope: scopeDescriptor(scope),
        visitor: {
          session_ref: toSessionRef(String(visitor.id)),
          first_seen: visitor.created_at,
          last_seen: visitor.last_seen_at,
          conversations: scopedConversations.map((conversation) => {
            const id = String(conversation.id);
            return {
              status: conversation.status,
              created_at: conversation.created_at,
              resolved_at: conversation.resolved_at,
              message_count: messageCount.get(id) ?? 0,
              has_feedback: ratingByConversation.has(id),
              rating: ratingByConversation.get(id) ?? null,
            };
          }),
        },
      },
      200,
      req,
    );
  } catch (error) {
    console.error(
      "[visitor-analytics] unexpected error:",
      (error as Error).name,
    );
    return jsonResponse({ error: "internal_error" }, 500, req);
  }
});
