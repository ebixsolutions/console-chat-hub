import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { supabaseCorsHeaders } from "../_shared/supabase-cors.ts";

const MAX_QUERY_LENGTH = 500;
const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const PROJECT_ID = "4dbf593e-577e-4af4-a553-460441c34473";
const PRODUCTION_ORIGIN = "https://console-chat-hub.lovable.app";
const HUMAN_CONTROL_STATUSES = new Set(["pending", "transferred", "human_needed", "human_control"]);

type QueryClient = { from: (table: string) => any };

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isAllowedConsoleOrigin(raw: string): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
    ) return false;
    if (raw === PRODUCTION_ORIGIN || raw === "https://preview--console-chat-hub.lovable.app") return true;
    if (["localhost", "127.0.0.1"].includes(url.hostname)) return true;
    const projectHost = `${PROJECT_ID}.lovableproject.com`;
    if (url.hostname === projectHost) return true;
    if (url.hostname.endsWith(`--${projectHost}`)) {
      const prefix = url.hostname.slice(0, -(`--${projectHost}`).length);
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
  | { ok: true; companyId: string; scopeMode: "canonical" }
  | { ok: false; status: number; error: string }
> {
  const { data: memberships, error: membershipError, status: membershipStatus } = await admin
    .from("company_membership")
    .select("company_id, role, is_active")
    .eq("user_id", userId);
  if (membershipError) {
    return { ok: false, status: 500, error: "company_membership_lookup_failed", provider: {code:membershipError.code,status:membershipStatus} } as any;
  }

  const rows = (memberships ?? []).filter((row: any) => row.is_active === true);
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
    const { data: company, error: companyError, status: companyStatus } = await admin
      .from("company")
      .select("id,is_active")
      .eq("id", companyId)
      .maybeSingle();
    if (companyError) return { ok: false, status: 500, error: "company_lookup_failed", provider: {code:companyError.code,status:companyStatus} } as any;
    if (!company || company.is_active !== true) {
      return { ok: false, status: 403, error: "company_inactive" };
    }
    return { ok: true, companyId, scopeMode: "canonical" };
  }

  return { ok: false, status: 403, error: "forbidden" };
}

function isTestConversationOwned(metadataSource: unknown, userId: string): boolean {
  if (!metadataSource || typeof metadataSource !== "object" || Array.isArray(metadataSource)) {
    return false;
  }
  const m = metadataSource as Record<string, unknown>;
  return m.source === "c3_uat_widget" &&
    m.synthetic === true &&
    m.owner_user_id === userId &&
    m.exclude_training === true;
}

async function loadOwnedTestConversation(
  admin: QueryClient,
  conversationId: string,
  userId: string,
  scope: { companyId: string; channelId: string },
): Promise<
  | { ok: true; conversation: Record<string, any> }
  | { ok: false; status: number; error: string }
> {
  if (!isUuid(conversationId)) {
    return { ok: false, status: 400, error: "invalid_test_conversation_id" };
  }
  const { data, error } = await admin
    .from("conversations")
    .select("id,status,assigned_agent_id,company_id,channel_config_id,visitor_session_id,metadata_source,created_at,updated_at")
    .eq("id", conversationId)
    .eq("company_id", scope.companyId)
    .eq("channel_config_id", scope.channelId)
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
    .filter((m: any) => ["visitor","assistant","agent","system"].includes(m.role))
    .map((m: any) => ({
      id: String(m.id),
      role: m.role,
      content: String(m.content ?? ""),
      created_at: typeof m.created_at === "string" ? m.created_at : null,
      metadata:
        m.metadata && typeof m.metadata === "object" && !Array.isArray(m.metadata)
          ? m.metadata as Record<string, unknown>
          : null,
    }));
}

async function createTestConversation(
  admin: QueryClient,
  userId: string,
  resolved: { companyId: string; channelId: string; scopeMode: "canonical" },
  clientMessageId: string,
): Promise<
  | { ok: true; conversationId: string }
  | { ok: false; status: number; error: string }
> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`${userId}:${resolved.channelId}:${clientMessageId}`)));
  const hex = [...bytes].map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,32);
  const conversationId = `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;
  const existing = await loadOwnedTestConversation(admin,conversationId,userId,resolved);
  if (existing.ok) return {ok:true,conversationId};
  if (existing.status !== 404) return existing;
  const {count,error: countError} = await admin.from("conversations").select("id",{count:"exact",head:true}).eq("metadata_source->>source","c3_uat_widget");
  if (countError || typeof count !== "number") return {ok:false,status:503,error:"fixture_budget_unavailable"};
  if (count >= 200) return {ok:false,status:409,error:"fixture_budget_exhausted"};
  const sessionToken = `preview-test.${crypto.randomUUID()}.${crypto.randomUUID().replace(/-/g, "")}`;
  const visitorMetadata = {
    name: "Widget Live Test",
    source: "c3_uat_widget",
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
      channel_config_id: resolved.channelId,
    })
    .select("id")
    .single();

  if (sessionError || !session?.id) {
    return { ok: false, status: 500, error: "test_session_create_failed" };
  }

  const metadataSource = {
    source: "c3_uat_widget",
    synthetic: true,
    owner_user_id: userId,
    exclude_training: true,
    scope_mode: resolved.scopeMode,
    canonical_company_attached: resolved.companyId !== null,
  };

  const { data: conversation, error: conversationError } = await admin
    .from("conversations")
    .insert({
      id: conversationId,
      visitor_session_id: session.id,
      channel_config_id: resolved.channelId,
      company_id: resolved.companyId,
      status: "open",
      priority: "normal",
      tags: ["c3_uat", "synthetic", "exclude_training"],
      metadata_source: metadataSource,
      language: null,
    })
    .select("id")
    .single();

  if (conversationError || !conversation?.id) {
    await admin.from("visitor_session").delete().eq("id", session.id);
    const raced = await loadOwnedTestConversation(admin,conversationId,userId,resolved);
    if (raced.ok) return {ok:true,conversationId};
    return { ok: false, status: 500, error: "test_conversation_create_failed" };
  }
  return { ok: true, conversationId: String(conversation.id) };
}

async function listOwnedTestHistory(admin: QueryClient, userId: string, scope: {companyId: string; channelId: string}) {
  const { data, error } = await admin
    .from("conversations")
    .select("id,created_at,updated_at,metadata_source")
    .eq("company_id", scope.companyId)
    .eq("channel_config_id", scope.channelId)
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

async function widgetRequest(url: string, key: string, token: string, origin: string, slug: string, body: unknown) {
  const response = await fetch(`${url}/functions/v1/${slug}`, {
    method:"POST", headers:{"Content-Type":"application/json", Authorization:`Bearer ${token}`, apikey:key, Origin:origin},
    body:JSON.stringify(body), signal:AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(()=>null);
  if (!response.ok || payload?.success !== true) throw new Error("canonical_widget_request_failed");
  return payload.data;
}

export function createWidgetLiveHandler(deps = { createClient, getAdminKey: getSupabaseAdminKey, env: (name: string) => Deno.env.get(name), log: (event: unknown) => console.error(JSON.stringify(event)) }) {
return async (req: Request) => {
  const correlationId = crypto.randomUUID();
  const diagnostic = (stage: string, provider: any, status: number) => deps.log({ endpoint: "widget-live-ai-test", stage, provider_code: typeof provider?.code === "string" && (/^(?:PGRST[0-9]{3}|[0-9A-Z]{5})$/.test(provider.code) || ["bad_jwt","jwt_expired","user_not_found","session_not_found","ADMIN_KEY_MISSING"].includes(provider.code)) ? provider.code : "unclassified", http_class: `${Math.floor(status / 100)}xx`, provider_http_class: Number.isInteger(provider?.status) && provider.status>=100 && provider.status<600 ? `${Math.floor(provider.status/100)}xx` : "unavailable", provider_error_class: ["AuthApiError", "AuthSessionMissingError", "AuthRetryableFetchError"].includes(provider?.name) ? provider.name : "unclassified", project_ref: deps.env("SUPABASE_URL") === "https://nrfxhqabwblzxoushgnm.supabase.co" ? "nrfxhqabwblzxoushgnm" : "local_or_unverified_environment", correlation_id: correlationId });
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
      "company_id", "companyId", "tenant_id", "tenantId",
      "api_key", "apiKey", "channel_id", "channelId", "channel_config_id", "conversation_id", "user_id", "userId",
    ]) {
      if ((body as Record<string, unknown>)[forbidden] !== undefined) {
        return json(req, {
          success: false,
          error: "invalid_request",
          detail: "tenant/company/key/channel/conversation scope is server-derived",
        }, 400);
      }
    }

    const tokenMatch = /^Bearer\s+(\S+)$/i.exec(req.headers.get("Authorization") ?? "");
    if (!tokenMatch) { diagnostic("auth_header", null, 401); return json(req, { success: false, error: "unauthorized", correlation_id: correlationId }, 401); }
    const supabaseUrl = deps.env("SUPABASE_URL");
    const anonKey = deps.env("SUPABASE_ANON_KEY");
    let serviceKey: string;
    try { serviceKey = deps.getAdminKey(); } catch { diagnostic("admin_config", {code:"ADMIN_KEY_MISSING"}, 500); return json(req, {success:false,error:"server_config_missing",correlation_id:correlationId},500); }
    // Existing disposable Docker Auth CI only; never a hosted backend alternative.
    const nativeLocal = deps.env("C3_NATIVE_ISOLATED_AUTH") === "local-only" &&
      ["http://kong:8000", "http://127.0.0.1:54321", "http://localhost:54321"].includes(supabaseUrl ?? "");
    if ((!nativeLocal && supabaseUrl !== "https://nrfxhqabwblzxoushgnm.supabase.co") || !supabaseUrl || !anonKey || !serviceKey) return json(req, {success:false,error:"server_config_missing"},500);
    const auth = deps.createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${tokenMatch[1]}` } },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data: authData, error: authError } = await auth.auth.getUser(tokenMatch[1]);
    if (authError || !authData?.user?.id) {
      diagnostic("auth_validation", authError, 401);
      return json(req, { success: false, error: "unauthorized", correlation_id: correlationId }, 401);
    }
    const admin = deps.createClient(supabaseUrl, serviceKey, { auth: {persistSession:false,autoRefreshToken:false,detectSessionInUrl:false} });
    const membership = await resolveTestScope(admin, authData.user.id);
    if (!membership.ok) {
      diagnostic("membership_validation", (membership as any).provider, membership.status);
      return json(req, {success:false,error:membership.error,correlation_id:correlationId},membership.status);
    }
    // The installed authenticated RPC and its config channel FK prove B12 registration.
    // Never infer isolation from a browser flag, channel name or arbitrary metadata.
    const {data: isolation, error: isolationError} = await auth.rpc("c3_uat_feedback_config_context");
    const config = isolation?.config;
    if (isolationError || isolation?.isolated !== true || !config || config.company_id !== membership.companyId || !isUuid(config.channel_id)) {
      if ((body as any).action === "history" && !isolationError) return json(req,{success:true,mode:"persistent_live_ai_test",history:[],isolation_ready:false});
      diagnostic("synthetic_scope", isolationError, 503);
      return json(req,{success:false,error:"synthetic_scope_not_ready",correlation_id:correlationId},503);
    }
    const resolved = {companyId: String(membership.companyId), channelId: String(config.channel_id), scopeMode: "canonical" as const};
    const {data: channel,error: channelError} = await admin.from("channel_config").select("id,company_id,is_active,channel_type,allowed_origins").eq("id",resolved.channelId).eq("company_id",resolved.companyId).maybeSingle();
    if (channelError || !channel || channel.is_active !== true || channel.channel_type !== "web_widget" || !Array.isArray(channel.allowed_origins) || !channel.allowed_origins.includes(origin)) return json(req,{success:false,error:"synthetic_channel_unavailable"},503);

    const action = typeof (body as Record<string, unknown>).action === "string"
      ? String((body as Record<string, unknown>).action)
      : "send";

    if (action === "history") {
      return json(req, {
        success: true,
        mode: "persistent_live_ai_test",
        isolation_ready: true,
        company_id: resolved.companyId,
        channel_id: resolved.channelId,
        history: await listOwnedTestHistory(admin, authData.user.id, resolved),
      });
    }

    const requestedConversationId =
      typeof (body as Record<string, unknown>).test_conversation_id === "string"
        ? String((body as Record<string, unknown>).test_conversation_id)
        : "";

    if (action === "load") {
      const owned = await loadOwnedTestConversation(
        admin,
        requestedConversationId,
        authData.user.id,
        resolved,
      );
      if (!owned.ok) return json(req, { success: false, error: owned.error }, owned.status);
      const {data: session,error: sessionError} = await admin.from("visitor_session").select("session_token").eq("id",owned.conversation.visitor_session_id).eq("channel_config_id",resolved.channelId).maybeSingle();
      if (sessionError || !session?.session_token) return json(req,{success:false,error:"test_session_lookup_failed"},500);
      const poll = await widgetRequest(supabaseUrl,serviceKey,tokenMatch[1],origin,"widget-poll-messages",{conversation_id:requestedConversationId,session_token:session.session_token});
      return json(req, {
        success: true,
        mode: "persistent_live_ai_test",
        scope_mode: resolved.scopeMode,
        conversation_id: requestedConversationId,
        conversation_status: owned.conversation.status,
        assigned_agent_id: owned.conversation.assigned_agent_id ?? null,
        human_control:
          HUMAN_CONTROL_STATUSES.has(String(owned.conversation.status)) ||
          Boolean(owned.conversation.assigned_agent_id),
        messages: poll.messages ?? [],
        human_support: poll.human_support,
        ai_generating: poll.ai_generating,
      });
    }

    if (action !== "send") {
      return json(req, { success: false, error: "invalid_action" }, 400);
    }

    const query = typeof (body as Record<string, unknown>).query === "string"
      ? String((body as Record<string, unknown>).query).trim()
      : "";
    if (!query || query.length > MAX_QUERY_LENGTH) {
      return json(req, { success: false, error: "invalid_query" }, 400);
    }

    if (!isUuid((body as any).client_message_id)) return json(req,{success:false,error:"invalid_client_message_id"},400);
    let conversationId = requestedConversationId;
    if (conversationId) {
      const owned = await loadOwnedTestConversation(admin, conversationId, authData.user.id, resolved);
      if (!owned.ok) return json(req, { success: false, error: owned.error }, owned.status);
      if (owned.conversation.status === "resolved" || owned.conversation.status === "closed") {
        return json(req, { success: false, error: "test_conversation_resolved" }, 409);
      }

    } else {
      const created = await createTestConversation(admin, authData.user.id, resolved, String((body as any).client_message_id));
      if (!created.ok) return json(req, { success: false, error: created.error }, created.status);
      conversationId = created.conversationId;
    }

    // Use the ordinary visitor transaction/poll path, including queue and AI suppression.
    const owned = await loadOwnedTestConversation(admin, conversationId, authData.user.id, resolved);
    if (!owned.ok) return json(req,{success:false,error:owned.error},owned.status);
    const {data: session, error: sessionError} = await admin.from("visitor_session").select("session_token")
      .eq("id", owned.conversation.visitor_session_id).eq("channel_config_id", resolved.channelId).maybeSingle();
    if (sessionError || !session?.session_token) return json(req,{success:false,error:"test_session_lookup_failed"},500);
    const clientMessageId = (body as any).client_message_id;
    if (!isUuid(clientMessageId)) return json(req,{success:false,error:"invalid_client_message_id"},400);
    const sent = await widgetRequest(supabaseUrl, serviceKey, tokenMatch[1], origin, "receive-widget-message", {
      conversation_id:conversationId, session_token:session.session_token, content:query, client_message_id:clientMessageId,
    });
    let poll = await widgetRequest(supabaseUrl,serviceKey,tokenMatch[1],origin,"widget-poll-messages",{
      conversation_id:conversationId,session_token:session.session_token,
    });
    for (let attempt=0; sent.ai_reply_pending && attempt<12; attempt++) {
      if (poll.messages?.some((m:any)=>m.role !== "visitor" && m.metadata?.source_message_id === sent.message_id) || (poll.human_support?.state && poll.human_support.state !== "none")) break;
      await new Promise(resolve=>setTimeout(resolve,1000));
      poll = await widgetRequest(supabaseUrl,serviceKey,tokenMatch[1],origin,"widget-poll-messages",{conversation_id:conversationId,session_token:session.session_token});
    }
    const messages = poll.messages ?? [];
    const {data: state,error: stateError} = await admin.from("conversations").select("status,assigned_agent_id").eq("id",conversationId).eq("company_id",resolved.companyId).eq("channel_config_id",resolved.channelId).maybeSingle();
    if (stateError || !state) return json(req,{success:false,error:"test_conversation_lookup_failed"},500);
    const latestAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    return json(req, {
      success: true,
      mode: "persistent_live_ai_test",
      scope_mode: resolved.scopeMode,
      conversation_id: conversationId,
      conversation_status: state?.status ?? null,
      assigned_agent_id: state?.assigned_agent_id ?? null,
      human_control:
        HUMAN_CONTROL_STATUSES.has(String(state?.status ?? "")) ||
        Boolean(state?.assigned_agent_id),
      handoff_persisted: (poll.human_support?.state && poll.human_support.state !== "none"),
      human_support: poll.human_support,
      ai_generating: poll.ai_generating,
      idempotent: sent.idempotent === true,
      answer: latestAssistant?.content ?? "",
      messages,
    });
  } catch (e) {
    diagnostic("unexpected", null, 500);
    return json(req, { success: false, error: "internal_error" }, 500);
  }
};
}

Deno.serve(createWidgetLiveHandler());
