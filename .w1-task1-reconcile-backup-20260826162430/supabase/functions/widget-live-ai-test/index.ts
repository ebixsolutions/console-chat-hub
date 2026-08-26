import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { supabaseCorsHeaders } from "../_shared/supabase-cors.ts";

const MAX_QUERY_LENGTH = 500;
const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const PROJECT_ID = "4dbf593e-577e-4af4-a553-460441c34473";
const PRODUCTION_ORIGIN = "https://console-chat-hub.lovable.app";
const HUMAN_CONTROL_STATUSES = new Set(["pending", "transferred", "human_needed", "human_control"]);

type QueryClient = { from: (table: string) => any };

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isAllowedConsoleOrigin(raw: string): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
      return false;
    if (raw === PRODUCTION_ORIGIN) return true;
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return true;
    const projectHost = `${PROJECT_ID}.lovableproject.com`;
    if (url.hostname === projectHost) return true;
    if (url.hostname.endsWith(`--${projectHost}`)) {
      const prefix = url.hostname.slice(0, -`--${projectHost}`.length);
      return /^[a-z0-9][a-z0-9-]*$/.test(prefix);
    }
    const appSuffix = `--${PROJECT_ID}.lovable.app`;
    if (url.hostname.endsWith(appSuffix)) {
      const prefix = url.hostname.slice(0, -appSuffix.length);
      return /^id-preview(?:-[a-z0-9-]+)?$/.test(prefix);
    }
    return false;
  } catch {
    return false;
  }
}

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return supabaseCorsHeaders(
    origin,
    isAllowedConsoleOrigin(origin) ? [origin] : [],
    req.headers.get("Access-Control-Request-Headers") ?? "",
  );
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), "Content-Type": "application/json" },
  });
}

async function resolveTestScope(
  admin: QueryClient,
  userId: string,
): Promise<
  | { ok: true; companyId: string | null; scopeMode: "canonical" | "pre_activation" }
  | { ok: false; status: number; error: string }
> {
  const { data: memberships, error: membershipError } = await admin
    .from("company_membership")
    .select("company_id, role, is_active")
    .eq("user_id", userId);
  if (membershipError) {
    return { ok: false, status: 500, error: "company_membership_lookup_failed" };
  }

  const rows = memberships ?? [];
  const companyIds = [...new Set(rows.map((r: any) => String(r.company_id)))];
  if (companyIds.length > 1) {
    return { ok: false, status: 409, error: "company_membership_ambiguous" };
  }

  if (companyIds.length === 1) {
    const companyId = String(companyIds[0]);
    const activeRoles = rows
      .filter((r: any) => r.is_active === true && String(r.company_id) === companyId)
      .map((r: any) => String(r.role));
    if (!activeRoles.some((role: string) => ALLOWED_ROLES.has(role))) {
      return { ok: false, status: 403, error: "forbidden" };
    }
    const { data: company, error: companyError } = await admin
      .from("company")
      .select("id,is_active")
      .eq("id", companyId)
      .maybeSingle();
    if (companyError) return { ok: false, status: 500, error: "company_lookup_failed" };
    if (!company || company.is_active !== true) {
      return { ok: false, status: 403, error: "company_inactive" };
    }
    return { ok: true, companyId, scopeMode: "canonical" };
  }

  const { data: roles, error: roleError } = await admin.from("user_roles").select("role").eq("user_id", userId);
  if (roleError) return { ok: false, status: 500, error: "role_lookup_failed" };
  if (!(roles ?? []).some((r: any) => ALLOWED_ROLES.has(String(r.role)))) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  if (Deno.env.get("KB_PREACTIVATION_ENABLED") !== "true") {
    return { ok: false, status: 503, error: "kb_preactivation_disabled" };
  }
  if (!Deno.env.get("KB_PREACTIVATION_TENANT_ID")?.trim()) {
    return { ok: false, status: 503, error: "kb_preactivation_config_missing" };
  }
  return { ok: true, companyId: null, scopeMode: "pre_activation" };
}

function isTestConversationOwned(metadataSource: unknown, userId: string): boolean {
  if (!metadataSource || typeof metadataSource !== "object" || Array.isArray(metadataSource)) {
    return false;
  }
  const m = metadataSource as Record<string, unknown>;
  return (
    m.source === "widget_live_test" &&
    m.widget_live_test === true &&
    m.owner_user_id === userId &&
    m.exclude_training === true
  );
}

async function loadOwnedTestConversation(
  admin: QueryClient,
  conversationId: string,
  userId: string,
): Promise<{ ok: true; conversation: Record<string, any> } | { ok: false; status: number; error: string }> {
  if (!isUuid(conversationId)) {
    return { ok: false, status: 400, error: "invalid_test_conversation_id" };
  }
  const { data, error } = await admin
    .from("conversations")
    .select(
      "id,status,assigned_agent_id,company_id,channel_config_id,visitor_session_id,metadata_source,created_at,updated_at",
    )
    .eq("id", conversationId)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: "test_conversation_lookup_failed" };
  if (!data || !isTestConversationOwned(data.metadata_source, userId)) {
    return { ok: false, status: 404, error: "test_conversation_not_found" };
  }
  return { ok: true, conversation: data };
}

async function loadTestMessages(admin: QueryClient, conversationId: string) {
  const { data, error } = await admin
    .from("messages")
    .select("id,role,content,created_at,metadata")
    .eq("conversation_id", conversationId)
    .neq("content", "__THINKING__")
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error("test_messages_lookup_failed");
  return (data ?? [])
    .filter((m: any) => m.role === "visitor" || m.role === "assistant")
    .map((m: any) => ({
      id: String(m.id),
      role: m.role === "visitor" ? ("visitor" as const) : ("assistant" as const),
      content: String(m.content ?? ""),
      created_at: typeof m.created_at === "string" ? m.created_at : null,
      metadata:
        m.metadata && typeof m.metadata === "object" && !Array.isArray(m.metadata)
          ? (m.metadata as Record<string, unknown>)
          : null,
    }));
}

async function createTestConversation(
  admin: QueryClient,
  userId: string,
  resolved: { companyId: string | null; scopeMode: "canonical" | "pre_activation" },
): Promise<{ ok: true; conversationId: string } | { ok: false; status: number; error: string }> {
  const sessionToken = `preview-test.${crypto.randomUUID()}.${crypto.randomUUID().replace(/-/g, "")}`;
  const visitorMetadata = {
    name: "Widget Live Test",
    source: "widget_live_test",
    test_mode: true,
    owner_user_id: userId,
    exclude_training: true,
    scope_mode: resolved.scopeMode,
  };

  const { data: session, error: sessionError } = await admin
    .from("visitor_session")
    .insert({
      session_token: sessionToken,
      visitor_fingerprint: `widget-live-test:${userId}`,
      visitor_metadata: visitorMetadata,
      last_seen_at: new Date().toISOString(),
      channel_config_id: null,
    })
    .select("id")
    .single();

  if (sessionError || !session?.id) {
    return { ok: false, status: 500, error: "test_session_create_failed" };
  }

  const metadataSource = {
    source: "widget_live_test",
    widget_live_test: true,
    owner_user_id: userId,
    exclude_training: true,
    scope_mode: resolved.scopeMode,
    canonical_company_attached: resolved.companyId !== null,
  };

  const { data: conversation, error: conversationError } = await admin
    .from("conversations")
    .insert({
      visitor_session_id: session.id,
      channel_config_id: null,
      company_id: resolved.companyId,
      status: "open",
      priority: "normal",
      tags: ["widget_live_test", "exclude_training"],
      metadata_source: metadataSource,
      language: null,
    })
    .select("id")
    .single();

  if (conversationError || !conversation?.id) {
    await admin.from("visitor_session").delete().eq("id", session.id);
    return { ok: false, status: 500, error: "test_conversation_create_failed" };
  }
  return { ok: true, conversationId: String(conversation.id) };
}

async function listOwnedTestHistory(admin: QueryClient, userId: string) {
  const { data, error } = await admin
    .from("conversations")
    .select("id,created_at,updated_at,metadata_source")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw new Error("test_history_lookup_failed");

  const out = [];
  for (const c of (data ?? []).filter((x: any) => isTestConversationOwned(x.metadata_source, userId)).slice(0, 10)) {
    const messages = await loadTestMessages(admin, String(c.id));
    const latest = [...messages].reverse().find((m) => m.content.trim().length > 0);
    out.push({
      conversation_id: String(c.id),
      created_at: typeof c.created_at === "string" ? c.created_at : null,
      updated_at: typeof c.updated_at === "string" ? c.updated_at : null,
      latest_preview: latest?.content.slice(0, 120) ?? "(no messages)",
      message_count: messages.length,
    });
  }
  return out;
}

async function invokeCanonicalGenerateReply(
  supabaseUrl: string,
  serviceKey: string,
  conversationId: string,
  sourceMessageId: string,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; status: number; error: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/functions/v1/generate-reply`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
      body: JSON.stringify({
        conversation_id: conversationId,
        source_message_id: sourceMessageId,
      }),
      signal: controller.signal,
    });
    let payload: Record<string, unknown> = {};
    try {
      const parsed = await response.json();
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // Keep opaque upstream body out of browser responses.
    }
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error:
          typeof payload.error === "string" ? payload.error.slice(0, 120) : `generate_reply_http_${response.status}`,
      };
    }
    return { ok: true, payload };
  } catch (error) {
    return {
      ok: false,
      status: error instanceof DOMException && error.name === "AbortError" ? 504 : 502,
      error:
        error instanceof DOMException && error.name === "AbortError"
          ? "generate_reply_timeout"
          : "generate_reply_unavailable",
    };
  } finally {
    clearTimeout(timeout);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("Origin") ?? "";
    if (!isAllowedConsoleOrigin(origin)) return new Response(null, { status: 403 });
    const headers = cors(req);
    if (!headers["Access-Control-Allow-Headers"]) return new Response(null, { status: 403 });
    return new Response(null, { status: 200, headers });
  }
  if (req.method !== "POST") {
    return json(req, { success: false, error: "method_not_allowed" }, 405);
  }
  const origin = req.headers.get("Origin") ?? "";
  if (!isAllowedConsoleOrigin(origin)) {
    return json(req, { success: false, error: "forbidden_origin" }, 403);
  }

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(req, { success: false, error: "invalid_request" }, 400);
    }
    for (const forbidden of [
      "company_id",
      "companyId",
      "tenant_id",
      "tenantId",
      "api_key",
      "apiKey",
      "channel_id",
      "conversation_id",
    ]) {
      if ((body as Record<string, unknown>)[forbidden] !== undefined) {
        return json(
          req,
          {
            success: false,
            error: "invalid_request",
            detail: "tenant/company/key/channel/conversation scope is server-derived",
          },
          400,
        );
      }
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json(req, { success: false, error: "server_config_missing" }, 500);
    }

    const auth = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: authData, error: authError } = await auth.auth.getUser();
    if (authError || !authData.user) {
      return json(req, { success: false, error: "unauthorized" }, 401);
    }

    const admin = createClient(supabaseUrl, serviceKey);
    const resolved = await resolveTestScope(admin, authData.user.id);
    if (!resolved.ok) {
      return json(req, { success: false, error: resolved.error }, resolved.status);
    }

    const action =
      typeof (body as Record<string, unknown>).action === "string"
        ? String((body as Record<string, unknown>).action)
        : "send";

    if (action === "history") {
      return json(req, {
        success: true,
        mode: "persistent_live_ai_test",
        history: await listOwnedTestHistory(admin, authData.user.id),
      });
    }

    const requestedConversationId =
      typeof (body as Record<string, unknown>).test_conversation_id === "string"
        ? String((body as Record<string, unknown>).test_conversation_id)
        : "";

    if (action === "load") {
      const owned = await loadOwnedTestConversation(admin, requestedConversationId, authData.user.id);
      if (!owned.ok) return json(req, { success: false, error: owned.error }, owned.status);
      return json(req, {
        success: true,
        mode: "persistent_live_ai_test",
        scope_mode: resolved.scopeMode,
        conversation_id: requestedConversationId,
        conversation_status: owned.conversation.status,
        messages: await loadTestMessages(admin, requestedConversationId),
      });
    }

    if (action !== "send") {
      return json(req, { success: false, error: "invalid_action" }, 400);
    }

    const query =
      typeof (body as Record<string, unknown>).query === "string"
        ? String((body as Record<string, unknown>).query).trim()
        : "";
    if (!query || query.length > MAX_QUERY_LENGTH) {
      return json(req, { success: false, error: "invalid_query" }, 400);
    }

    let conversationId = requestedConversationId;
    if (conversationId) {
      const owned = await loadOwnedTestConversation(admin, conversationId, authData.user.id);
      if (!owned.ok) return json(req, { success: false, error: owned.error }, owned.status);
      if (owned.conversation.status === "resolved" || owned.conversation.status === "closed") {
        return json(req, { success: false, error: "test_conversation_resolved" }, 409);
      }
      if (HUMAN_CONTROL_STATUSES.has(String(owned.conversation.status)) || owned.conversation.assigned_agent_id) {
        return json(
          req,
          {
            success: false,
            error: "test_conversation_under_human_control",
            conversation_id: conversationId,
          },
          409,
        );
      }
    } else {
      const created = await createTestConversation(admin, authData.user.id, resolved);
      if (!created.ok) return json(req, { success: false, error: created.error }, created.status);
      conversationId = created.conversationId;
    }

    const { data: visitorMessage, error: visitorError } = await admin
      .from("messages")
      .insert({
        conversation_id: conversationId,
        role: "visitor",
        content: query,
        status: "sent",
        metadata: {
          widget_live_test: true,
          source: "widget_preview",
          owner_user_id: authData.user.id,
          exclude_training: true,
        },
      })
      .select("id")
      .single();

    if (visitorError || !visitorMessage?.id) {
      return json(req, { success: false, error: "test_visitor_message_create_failed" }, 500);
    }

    await admin
      .from("conversations")
      .update({
        updated_at: new Date().toISOString(),
        language: /[\u4e00-\u9fff]/.test(query) ? "zh" : "en",
      })
      .eq("id", conversationId);

    const generation = await invokeCanonicalGenerateReply(
      supabaseUrl,
      serviceKey,
      conversationId,
      String(visitorMessage.id),
    );

    const messages = await loadTestMessages(admin, conversationId);
    const { data: state } = await admin
      .from("conversations")
      .select("status,assigned_agent_id,updated_at")
      .eq("id", conversationId)
      .maybeSingle();

    if (!generation.ok) {
      return json(
        req,
        {
          success: false,
          error: generation.error,
          conversation_id: conversationId,
          conversation_status: state?.status ?? null,
          messages,
        },
        generation.status,
      );
    }

    const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    return json(req, {
      success: true,
      mode: "persistent_live_ai_test",
      scope_mode: resolved.scopeMode,
      conversation_id: conversationId,
      conversation_status: state?.status ?? null,
      handoff_persisted:
        generation.payload.handoff_persisted === true ||
        generation.payload.escalation_rule === "R1" ||
        generation.payload.escalation_rule === "S0",
      escalation_rule:
        typeof generation.payload.escalation_rule === "string" ? generation.payload.escalation_rule : null,
      answer: latestAssistant?.content ?? "",
      messages,
    });
  } catch (e) {
    console.error("[widget-live-ai-test] unexpected", e instanceof Error ? e.message : "unknown_error");
    return json(req, { success: false, error: "internal_error" }, 500);
  }
});
