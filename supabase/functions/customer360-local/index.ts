import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, json } from "../_shared/cors.ts";
import {
  applyCompanyScope,
  resolveCallerScope,
  type ResolvedScope,
} from "../_shared/pre-activation-scope.ts";

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
// Pre-activation Customer 360 is a null-company functional mode only.
const PRE_ACTIVATION_ROLES: ReadonlySet<string> = new Set(["admin", "supervisor"]);
const MAX_DIRECTORY = 50;

function safeIdentity(meta: unknown): Record<string, string> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  const m = meta as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ["name", "email", "phone"]) {
    const value = m[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
  }
  return out;
}

function scopeDescriptor(scope: ResolvedScope) {
  return { company_id: scope.companyId, mode: scope.mode };
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const auth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user }, error: authError } = await auth.auth.getUser();
    if (authError || !user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: roles, error: roleError } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    if (
      roleError ||
      !roles?.some((row: { role: string }) => ALLOWED_ROLES.has(row.role))
    ) {
      return json({ error: "forbidden" }, 403);
    }

    const scope = await resolveSingleCompany(admin, user.id);
    if (!scope.ok) return json({ error: scope.error }, scope.status);
    const companyId = scope.companyId;

    const body = await req.json().catch(() => ({}));
    const mode = body?.mode;

    if (mode === "directory") {
      const { data: conversations, error: conversationError } = await admin
        .from("conversations")
        .select("id, visitor_session_id, created_at, updated_at")
        .eq("company_id", companyId)
        .not("visitor_session_id", "is", null)
        .order("updated_at", { ascending: false });

      if (conversationError) return json({ error: "directory_query_failed" }, 500);

      const bySession = new Map<string, { conversation_count: number; last_activity: string | null }>();
      for (const row of conversations ?? []) {
        if (!row.visitor_session_id) continue;
        const id = String(row.visitor_session_id);
        const activity = row.updated_at ? String(row.updated_at) : row.created_at ? String(row.created_at) : null;
        const existing = bySession.get(id);
        if (!existing) {
          bySession.set(id, { conversation_count: 1, last_activity: activity });
        } else {
          existing.conversation_count += 1;
          if (activity && (!existing.last_activity || new Date(activity).getTime() > new Date(existing.last_activity).getTime())) {
            existing.last_activity = activity;
          }
        }
      }

      const sessionIds = [...bySession.keys()];
      if (sessionIds.length === 0) {
        return json({ success: true, scope: { company_id: companyId }, visitors: [] });
      }

      const { data: sessions, error: sessionError } = await admin
        .from("visitor_session")
        .select("id, created_at, last_seen_at, visitor_metadata, channel_config:channel_config_id(name)")
        .in("id", sessionIds);

      if (sessionError) return json({ error: "directory_session_query_failed" }, 500);

      const visitors = (sessions ?? [])
        .map((row) => {
          const id = String(row.id);
          const agg = bySession.get(id);
          return {
            id,
            created_at: row.created_at,
            last_seen_at: row.last_seen_at,
            identity: safeIdentity(row.visitor_metadata),
            channel_name: (row.channel_config as { name?: string } | null)?.name ?? null,
            conversation_count: agg?.conversation_count ?? 0,
            last_activity: agg?.last_activity ?? row.last_seen_at ?? row.created_at,
          };
        })
        .sort((a, b) => {
          const at = a.last_activity ? new Date(a.last_activity).getTime() : 0;
          const bt = b.last_activity ? new Date(b.last_activity).getTime() : 0;
          return bt - at;
        })
        .slice(0, MAX_DIRECTORY);

      return json({ success: true, scope: { company_id: companyId }, visitors });
    }

    if (mode === "detail") {
      const visitorSessionId =
        typeof body?.visitor_session_id === "string" ? body.visitor_session_id.trim() : "";

      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(visitorSessionId)) {
        return json({ error: "invalid_visitor_session_id" }, 400);
      }

      // Prove tenant ownership before reading visitor_session.
      const { data: conversations, error: conversationError } = await admin
        .from("conversations")
        .select("id, status, priority, created_at, channel_config:channel_config_id(name), assigned_agent_id")
        .eq("company_id", companyId)
        .eq("visitor_session_id", visitorSessionId)
        .order("created_at", { ascending: false });

      if (conversationError) return json({ error: "detail_conversation_query_failed" }, 500);
      if (!conversations || conversations.length === 0) {
        return json({ error: "not_found" }, 404);
      }

      const { data: visitor, error: visitorError } = await admin
        .from("visitor_session")
        .select("id, created_at, last_seen_at, visitor_metadata, channel_config:channel_config_id(name)")
        .eq("id", visitorSessionId)
        .maybeSingle();

      if (visitorError || !visitor) return json({ error: "not_found" }, 404);

      const convRows = conversations as Array<{
        id: string;
        status: string;
        priority: string | null;
        created_at: string | null;
        channel_config: { name?: string } | null;
        assigned_agent_id: string | null;
      }>;
      const conversationIds = convRows.map((row) => row.id);
      const agentIds = [
        ...new Set(
          convRows.map((row) => row.assigned_agent_id).filter((id): id is string => Boolean(id)),
        ),
      ];

      const [agentsResult, feedbackResult, evaluationResult] = await Promise.all([
        agentIds.length
          ? admin.from("agent_profile").select("id, display_name").in("id", agentIds)
          : Promise.resolve({ data: [], error: null }),
        admin.from("feedback_request")
          .select("conversation_id, rating, feedback_text, created_at")
          .in("conversation_id", conversationIds),
        admin.from("conversation_evaluation")
          .select("id, conversation_id, overall_score, severity, review_status, created_at")
          .in("conversation_id", conversationIds),
      ]);

      if (agentsResult.error) return json({ error: "agent_query_failed" }, 500);
      if (feedbackResult.error) return json({ error: "feedback_query_failed" }, 500);
      if (evaluationResult.error) return json({ error: "evaluation_query_failed" }, 500);

      const agentMap = new Map<string, string>();
      for (const row of agentsResult.data ?? []) {
        agentMap.set(String(row.id), String(row.display_name ?? ""));
      }

      const evaluations = evaluationResult.data ?? [];
      const evaluationIds = evaluations.map((row) => String(row.id));
      let emotionPoints: unknown[] = [];

      if (evaluationIds.length > 0) {
        const { data, error } = await admin
          .from("ce_emotion_point")
          .select("evaluation_id, turn_index, sentiment, sentiment_score, occurred_at")
          .in("evaluation_id", evaluationIds)
          .order("turn_index", { ascending: true });

        if (error) return json({ error: "emotion_query_failed" }, 500);

        const evalToConversation = new Map<string, string>();
        for (const row of evaluations) {
          evalToConversation.set(String(row.id), String(row.conversation_id));
        }

        emotionPoints = (data ?? []).map((row) => ({
          conversation_id: evalToConversation.get(String(row.evaluation_id)) ?? "",
          turn_index: row.turn_index,
          sentiment: row.sentiment,
          sentiment_score: row.sentiment_score,
          occurred_at: row.occurred_at,
        }));
      }

      return json({
        success: true,
        scope: { company_id: companyId },
        customer: {
          visitor_session_id: visitorSessionId,
          customer_ref: null,
          created_at: visitor.created_at,
          last_seen_at: visitor.last_seen_at,
          channel_name: (visitor.channel_config as { name?: string } | null)?.name ?? null,
          identity: safeIdentity(visitor.visitor_metadata),
          conversations: convRows.map((row) => ({
            id: row.id,
            status: row.status,
            priority: row.priority,
            created_at: row.created_at,
            channel_name: row.channel_config?.name ?? null,
            assigned_agent_name: row.assigned_agent_id ? agentMap.get(row.assigned_agent_id) ?? null : null,
          })),
          feedback: feedbackResult.data ?? [],
          evaluations: evaluations.map((row) => ({
            conversation_id: row.conversation_id,
            overall_score: row.overall_score,
            severity: row.severity,
            review_status: row.review_status,
            created_at: row.created_at,
          })),
          emotion_points: emotionPoints,
        },
      });
    }

    return json({ error: "invalid_mode" }, 400);
  } catch (error) {
    console.error("[customer360-local] unexpected", (error as Error).name);
    return json({ error: "internal_error" }, 500);
  }
});
