import { ORIGINAL_PREVIEW_ACCOUNTS, originalPreviewActor, originalPreviewCandidate, originalPreviewMetadata, signOriginalPreview, verifyOriginalPreview } from "../_shared/original-widget-preview.ts";
import { classifyNonFactualConversation } from "../_shared/conversational-routing.ts";
import { isExplicitHandoffRequest } from "../_shared/handoff-intent.ts";
import { executionFailure } from "../_shared/execution-failure.ts";
import { uatExecutionReadiness } from "../_shared/uat-execution-readiness.ts";
import { FRANKIE_DEMO_COMPANY } from "../_shared/uat-execution-contract.ts";

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";
import { supabaseCorsHeaders } from "../_shared/supabase-cors.ts";

const MAX_QUERY_LENGTH = 500;
const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const PROJECT_ID = "4dbf593e-577e-4af4-a553-460441c34473";
const PRODUCTION_ORIGIN = "https://console-chat-hub.lovable.app";
// Existing Frankie-owned production company/channel, never a browser-supplied scope.
const FRANKIE_DEMO_CHANNEL = "b0000000-0000-0000-0000-000000000001";
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
    return { ok: true, companyId, scopeMode: "canonical", role: activeRoles.includes("admin") ? "admin" : "supervisor" } as any;
  }

  return { ok: false, status: 403, error: "forbidden" };
}

function isTestConversationOwned(metadataSource: unknown, userId: string): boolean {
  if (!metadataSource || typeof metadataSource !== "object" || Array.isArray(metadataSource)) {
    return false;
  }
  const m = metadataSource as Record<string, unknown>;
  return originalPreviewMetadata(m,userId) || m.source === "c3_uat_widget" &&
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
  if (data.metadata_source?.execution_class === "authenticated_admin_preview" && !await verifyOriginalPreview(admin,data,undefined,false)) return {ok:false,status:403,error:"original_preview_authority_denied"};
  return { ok: true, conversation: data };
}

async function loadTestMessages(admin: QueryClient, conversationId: string, archiveScope?: {userId:string;companyId:string;channelId?:string}) {
  // The archive's message query joins its parent and Session in one database
  // snapshot. An ownership/session change between earlier reads cannot expose a
  // different Tenant's message rows through the service client.
  const fields = "id,role,content,created_at,metadata" + (archiveScope
    ? ",archive:conversations!inner(id,company_id,channel_config_id,visitor_session_id,metadata_source,archive_session:visitor_session!inner(id,channel_config_id,visitor_fingerprint,visitor_metadata))" : "");
  const { data, error } = await admin
    .from("messages")
    .select(fields)
    .eq("conversation_id", conversationId)
    .eq("is_recalled", false)
    .neq("content", "__THINKING__")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1000);
  // Over 100 turns require more than 200 persisted visitor/AI/system/agent rows.
  // This is a read window, never a maximum on new turns or on message persistence.
  if (error) throw new Error("test_messages_lookup_failed");
  if (archiveScope?.channelId) {
    const rows=data ?? [],parent=rows[0]?.archive;
    if(rows.some((m:any)=>m.archive?.id!==conversationId || m.archive.company_id!==archiveScope.companyId || m.archive.channel_config_id!==archiveScope.channelId ||
      !originalPreviewMetadata(m.archive.metadata_source,archiveScope.userId) || JSON.stringify(m.archive)!==JSON.stringify(parent))) throw new Error("original_preview_read_scope_changed");
    if(parent && (!await verifyOriginalPreview(admin,parent,undefined,false) || parent.archive_session?.id!==parent.visitor_session_id ||
      parent.archive_session?.channel_config_id!==archiveScope.channelId || parent.archive_session?.visitor_fingerprint!==`widget-live-test:${archiveScope.userId}` ||
      parent.archive_session?.visitor_metadata?.source!=="widget_live_test" || parent.archive_session?.visitor_metadata?.owner_user_id!==archiveScope.userId ||
      parent.archive_session?.visitor_metadata?.test_mode!==true || parent.archive_session?.visitor_metadata?.exclude_training!==true || parent.archive_session?.visitor_metadata?.scope_mode!=="canonical")) throw new Error("original_preview_read_scope_changed");
  } else {
  if (archiveScope && (data ?? []).some((m:any) => m.archive?.id !== conversationId ||
    !legacyPreviewOwned(m.archive,archiveScope.userId,archiveScope.companyId) ||
    !legacyPreviewSessionMatches(m.archive.archive_session,m.archive,archiveScope.userId))) throw new Error("legacy_preview_read_scope_changed");
  }
  return [...new Map<string,any>((data ?? []).map((m: any) => [m.id, m])).values()]
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

// The original authenticated Preview stored a null-channel session. That is an
// archival format, not authority to attach it to today's channel or dispatch AI.
function legacyPreviewOwned(c: any, userId: string, companyId: string): boolean {
  const m = c?.metadata_source;
  return isUuid(c?.id) && c.company_id === companyId && c.channel_config_id === null &&
    isUuid(c.visitor_session_id) && m?.source === "widget_live_test" &&
    m.widget_live_test === true && m.synthetic !== true && m.exclude_training === true &&
    ((m.scope_mode === "canonical" && m.canonical_company_attached === true) ||
      (m.scope_mode === "pre_activation" && m.canonical_company_attached === false)) && m.owner_user_id === userId;
}

async function legacyPreviewSessionValid(admin: QueryClient, c: any, userId: string): Promise<boolean> {
  const { data: session, error } = await admin.from("visitor_session")
    .select("id,channel_config_id,visitor_fingerprint,visitor_metadata")
    .eq("id", c.visitor_session_id).is("channel_config_id", null).maybeSingle();
  if (error) throw new Error("legacy_preview_session_lookup_failed");
  return legacyPreviewSessionMatches(session,c,userId);
}

function legacyPreviewSessionMatches(session: any, c: any, userId: string): boolean {
  const m = session?.visitor_metadata;
  return session?.id === c.visitor_session_id && session.channel_config_id === null &&
    session.visitor_fingerprint === `widget-live-test:${userId}` &&
    m?.source === "widget_live_test" && m.test_mode === true && m.exclude_training === true &&
    m.scope_mode === c.metadata_source.scope_mode && m.owner_user_id === userId;
}

async function loadLegacyPreview(admin: QueryClient, id: string, userId: string, companyId: string) {
  if (!isUuid(id)) return null;
  const {data, error} = await admin.from("conversations")
    .select("id,company_id,channel_config_id,visitor_session_id,metadata_source,status,assigned_agent_id")
    .eq("id", id).eq("company_id", companyId).is("channel_config_id", null)
    .eq("metadata_source->>source", "widget_live_test")
    .eq("metadata_source->>owner_user_id", userId).maybeSingle();
  if (error) throw new Error("legacy_preview_lookup_failed");
  if (!legacyPreviewOwned(data, userId, companyId) || !await legacyPreviewSessionValid(admin, data, userId)) return null;
  return data;
}

async function testConversationId(userId:string,channelId:string,clientMessageId:string,original=false): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`${original ? "original-preview:" : ""}${userId}:${channelId}:${clientMessageId}`)));
  const hex = [...bytes].map(b=>b.toString(16).padStart(2,"0")).join("").slice(0,32);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20)}`;
}

async function createTestConversation(
  admin: QueryClient,
  userId: string,
  resolved: { companyId: string; channelId: string; scopeMode: "canonical" },
  clientMessageId: string,
  originalUser?: any,
): Promise<
  | { ok: true; conversationId: string }
  | { ok: false; status: number; error: string }
> {
  const conversationId = await testConversationId(userId,resolved.channelId,clientMessageId,Boolean(originalUser));
  const existing = await loadOwnedTestConversation(admin,conversationId,userId,resolved);
  if (existing.ok) return {ok:true,conversationId};
  if (existing.status !== 404) return existing;
  if (!originalUser) {
  const {count,error: countError} = await admin.from("conversations").select("id",{count:"exact",head:true}).eq("metadata_source->>source","c3_uat_widget");
  if (countError || typeof count !== "number") return {ok:false,status:503,error:"fixture_budget_unavailable"};
  if (count >= 200) return {ok:false,status:409,error:"fixture_budget_exhausted"};
  }
  const sessionToken = `preview-test.${crypto.randomUUID()}.${crypto.randomUUID().replace(/-/g, "")}`;
  const visitorMetadata = {
    name: "Widget Live Test",
    source: originalUser ? "widget_live_test" : "c3_uat_widget",
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
    source: originalUser ? "widget_live_test" : "c3_uat_widget",
    ...(originalUser ? {widget_live_test:true,test_mode:true,execution_class:"authenticated_admin_preview",original_preview_authority:await signOriginalPreview(originalUser,resolved.companyId,resolved.channelId,conversationId,session.id)} : {synthetic:true}),
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
      tags: originalUser ? ["widget_live_test","manual_admin_preview","exclude_training"] : ["c3_uat", "synthetic", "exclude_training"],
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

// Keep every ownership/session/message-snapshot check, but do not serialize
// independent tickets. Four workers bound DB load and preserve input order.
async function mapHistory<T,R>(items: T[], read: (item:T)=>Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({length:Math.min(4,items.length)},async()=>{
    while(next<items.length) {
      const index=next++;
      results[index]=await read(items[index]);
    }
  }));
  return results;
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

  const {data: legacy, error: legacyError} = await admin.from("conversations")
    .select("id,company_id,channel_config_id,visitor_session_id,created_at,updated_at,metadata_source")
    .eq("company_id", scope.companyId).is("channel_config_id", null)
    .eq("metadata_source->>source", "widget_live_test")
    .eq("metadata_source->>owner_user_id", userId)
    .order("updated_at", {ascending:false}).limit(100);
  if (legacyError) throw new Error("legacy_preview_history_lookup_failed");
  const candidates = (data ?? []).filter((x: any) => isTestConversationOwned(x.metadata_source, userId)).slice(0,10)
    .map((c: any) => ({...c, read_only:false}));
  const archives = await mapHistory<any,any>((legacy ?? []),async c=>
    legacyPreviewOwned(c,userId,scope.companyId) && await legacyPreviewSessionValid(admin,c,userId) ? {...c,read_only:true} : null);
  candidates.push(...archives.filter(Boolean));
  const ordered = [...new Map<string,any>(candidates.map((c: any) => [c.id,c])).values()]
    .sort((a: any,b: any) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")) || String(a.id).localeCompare(String(b.id)));
  const out = await mapHistory<any,any>(ordered,async c=>{
    if(c.metadata_source?.execution_class === "authenticated_admin_preview") {
      const owned=await loadOwnedTestConversation(admin,c.id,userId,scope);
      if(!owned.ok) return null;
    }
    const messages = await loadTestMessages(admin, String(c.id), c.read_only ? {userId,companyId:scope.companyId} : c.metadata_source?.execution_class === "authenticated_admin_preview" ? {userId,companyId:scope.companyId,channelId:scope.channelId} : undefined);
    const latest = [...messages].reverse().find((m) => m.content.trim().length > 0);
    return {
      conversation_id: String(c.id),
      created_at: typeof c.created_at === "string" ? c.created_at : null,
      updated_at: typeof c.updated_at === "string" ? c.updated_at : null,
      latest_preview: latest?.content.slice(0, 120) ?? "(no messages)",
      message_count: messages.length,
      read_only: c.read_only,
    };
  });
  return out.filter(Boolean);
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
  const requestStarted = Date.now();
  let readAction: "readiness" | "history" | null = null;
  let readStage = "admission";
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
    // Recover the existing own-company read/control scope without borrowing C3's
    // B12 synthetic authority. Any paid AI/KB dispatch remains admission-denied.
    const ownCompany = membership.companyId === FRANKIE_DEMO_COMPANY;
    let scopedChannelId: string;
    const originalChannel=ORIGINAL_PREVIEW_ACCOUNTS.find(a=>originalPreviewCandidate(authData.user,a.company,a.channel) && a.company===membership.companyId && (membership as any).role==="admin")?.channel;
    if (originalChannel) {
      scopedChannelId=originalChannel;
    } else if (ownCompany) {
      scopedChannelId = FRANKIE_DEMO_CHANNEL;
    } else {
      // The C3 path retains its exact authenticated B12 registration.
      const {data: isolation, error: isolationError} = await auth.rpc("c3_uat_feedback_config_context");
      const config = isolation?.config;
      if (isolationError || isolation?.isolated !== true || !config || config.company_id !== membership.companyId || !isUuid(config.channel_id)) {
        if ((body as any).action === "history" && !isolationError) return json(req,{success:true,mode:"persistent_live_ai_test",history:[],isolation_ready:false});
        diagnostic("synthetic_scope", isolationError, 503);
        return json(req,{success:false,error:"synthetic_scope_not_ready",correlation_id:correlationId},503);
      }
      scopedChannelId = String(config.channel_id);
    }
    const resolved = {companyId: String(membership.companyId), channelId: scopedChannelId, scopeMode: "canonical" as const};
    const {data: channel,error: channelError} = await admin.from("channel_config").select("id,company_id,is_active,channel_type,allowed_origins").eq("id",resolved.channelId).eq("company_id",resolved.companyId).maybeSingle();
    if (channelError || !channel || channel.is_active !== true || channel.channel_type !== "web_widget" || !Array.isArray(channel.allowed_origins) || !channel.allowed_origins.includes(origin)) return json(req,{success:false,error:"synthetic_channel_unavailable"},503);

    const action = typeof (body as Record<string, unknown>).action === "string"
      ? String((body as Record<string, unknown>).action)
      : "send";

    // Both tenants use separate, server-verified admission; never use a
    // non-UAT default or browser field to authorize synthetic paid traffic.
    const originalCandidate = originalPreviewCandidate(authData.user,resolved.companyId,resolved.channelId) && (membership as any).role === "admin";
    const originalRoute = action !== "send" && action !== "open_authorized";
    const original = originalRoute && originalPreviewActor(authData.user,resolved.companyId,resolved.channelId,deps.env) &&
      (membership as any).role === "admin";
    const execution = original ? {ready:true as const,remote_ready:false,allowed_conversations:[] as string[]} :
      originalCandidate && originalRoute ? {ready:false as const,failure:executionFailure("ORIGINAL_PREVIEW_AUTHORIZATION_REQUIRED")} :
      await uatExecutionReadiness(admin as any,resolved.companyId,deps.env,{actorId:authData.user.id,channelId:resolved.channelId});
    if (action === "readiness" || action === "history") {
      readAction = action;
      // Admission is independent of archive retrieval. History retains the
      // existing response fields for older clients, but cannot authorize the
      // new client's Send state.
      const admission = {
        success: true,
        mode: "persistent_live_ai_test",
        isolation_ready: true,
        runtime_contract: "c3-widget-control-v2",
        actor_id: authData.user.id,
        execution_class: originalCandidate && originalRoute ? "authenticated_admin_preview" : "synthetic_uat",
        execution_ready: execution.ready,
        authorized_preview_available: execution.ready && execution.allowed_conversations.length > 0,
        execution_failure: execution.ready ? null : execution.failure,
        remote_ready: execution.ready && execution.remote_ready,
        company_id: resolved.companyId,
        channel_id: resolved.channelId,
        admission_action: action,
        correlation_id: correlationId,
      };
      if (action === "readiness") {
        deps.log({endpoint:"widget-live-ai-test",action,stage:"admission_complete",status:200,elapsed_ms:Date.now()-requestStarted,correlation_id:correlationId});
        return json(req, admission);
      }
      readStage = "history";
      const history = await listOwnedTestHistory(admin, authData.user.id, resolved);
      deps.log({endpoint:"widget-live-ai-test",action,stage:"history_complete",status:200,elapsed_ms:Date.now()-requestStarted,correlation_id:correlationId});
      return json(req, {...admission, history});
    }

    let requestedConversationId =
      typeof (body as Record<string, unknown>).test_conversation_id === "string"
        ? String((body as Record<string, unknown>).test_conversation_id)
        : "";

    if (action === "reconcile") {
      if (!isUuid((body as any).client_message_id)) return json(req,{success:false,error:"invalid_client_message_id"},400);
      // Deterministic lookup only. A missing row is not proof of non-delivery.
      requestedConversationId = await testConversationId(authData.user.id, resolved.channelId, String((body as any).client_message_id));
      if(originalCandidate) {
        const manualId=await testConversationId(authData.user.id,resolved.channelId,String((body as any).client_message_id),true);
        const old=await loadOwnedTestConversation(admin,requestedConversationId,authData.user.id,resolved);
        const manual=await loadOwnedTestConversation(admin,manualId,authData.user.id,resolved);
        if((!old.ok && old.status>=500) || (!manual.ok && manual.status>=500)) return json(req,{success:false,error:"test_conversation_lookup_failed"},500);
        if(old.ok && manual.ok) return json(req,{success:false,error:"reconciliation_ambiguous"},409);
        if(manual.ok)requestedConversationId=manualId;
      }
    }
    if (action === "open_authorized") {
      // A bounded lease names existing tickets. A random new-draft ID cannot
      // inherit that authority. Resolve only from the server's allowlist, then
      // apply the same persisted actor/Tenant/Channel checks as an explicit load.
      if (!execution.ready) return json(req,{success:false,error:"live_ai_execution_unavailable",failure:execution.failure,retryable:false},503);
      requestedConversationId = "";
      for (const id of execution.allowed_conversations) {
        const candidate = await loadOwnedTestConversation(admin,id,authData.user.id,resolved);
        if (!candidate.ok) {
          if (candidate.status >= 500) return json(req,{success:false,error:candidate.error},candidate.status);
          continue;
        }
        if (candidate.conversation.status !== "open" || candidate.conversation.assigned_agent_id) continue;
        requestedConversationId = id;
        break;
      }
      if (!requestedConversationId) return json(req,{success:false,error:"authorized_preview_unavailable",retryable:false},409);
    }
    if (action === "load" || action === "reconcile" || action === "open_authorized") {
      const owned = await loadOwnedTestConversation(
        admin,
        requestedConversationId,
        authData.user.id,
        resolved,
      );
      if (!owned.ok) {
        // Only explicit reads may access the old null-channel format. Send and
        // reconciliation keep their existing synthetic ownership/admission rules.
        if (action === "load" && owned.status === 404) {
          const legacy = await loadLegacyPreview(admin,requestedConversationId,authData.user.id,resolved.companyId);
          if (legacy) return json(req, {
            success:true, mode:"persistent_live_ai_test", scope_mode:"canonical",
            conversation_id:legacy.id, company_id:resolved.companyId, channel_id:resolved.channelId,
            read_only:true, execution_class:"historical_widget_live_test",
            conversation_status:legacy.status, assigned_agent_id:legacy.assigned_agent_id ?? null,
            human_control:HUMAN_CONTROL_STATUSES.has(String(legacy.status)) || Boolean(legacy.assigned_agent_id),
            messages:await loadTestMessages(admin,legacy.id,{userId:authData.user.id,companyId:resolved.companyId}), ai_generating:false,
          });
        }
        return json(req, { success: false, error: owned.error }, owned.status);
      }
      const {data: session,error: sessionError} = await admin.from("visitor_session").select("id,channel_config_id,visitor_fingerprint,visitor_metadata,session_token").eq("id",owned.conversation.visitor_session_id).eq("channel_config_id",resolved.channelId).maybeSingle();
      if (sessionError || !session?.session_token) return json(req,{success:false,error:"test_session_lookup_failed"},500);
      if (action === "open_authorized" && (session.id !== owned.conversation.visitor_session_id || session.channel_config_id !== resolved.channelId ||
        session.visitor_fingerprint !== `widget-live-test:${authData.user.id}` || session.visitor_metadata?.source !== "c3_uat_widget" ||
        session.visitor_metadata?.owner_user_id !== authData.user.id || session.visitor_metadata?.test_mode !== true ||
        session.visitor_metadata?.exclude_training !== true || session.visitor_metadata?.scope_mode !== "canonical"))
        return json(req,{success:false,error:"authorized_preview_session_denied"},403);
      const poll = await widgetRequest(supabaseUrl,serviceKey,tokenMatch[1],origin,"widget-poll-messages",{conversation_id:requestedConversationId,session_token:session.session_token});
      return json(req, {
        success: true,
        mode: "persistent_live_ai_test",
        read_only: owned.conversation.metadata_source?.execution_class === "authenticated_admin_preview" ? !original : original,
        read_only_reason: owned.conversation.metadata_source?.execution_class === "authenticated_admin_preview" ? (!original ? "original_preview_authorization_required" : null) : (original ? "synthetic_uat_start_new_original_preview" : null),
        scope_mode: resolved.scopeMode,
        conversation_id: requestedConversationId,
        ...(action === "reconcile" ? {reconciled_client_message_id: String((body as any).client_message_id)} : {}),
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

    if (action !== "send" && action !== "original_preview_send") {
      return json(req, { success: false, error: "invalid_action" }, 400);
    }

    if(action === "original_preview_send" && !originalCandidate) return json(req,{success:false,error:"original_preview_actor_denied",retryable:false},403);
    const query = typeof (body as Record<string, unknown>).query === "string"
      ? String((body as Record<string, unknown>).query).trim()
      : "";
    if (!query || query.length > MAX_QUERY_LENGTH) {
      return json(req, { success: false, error: "invalid_query" }, 400);
    }

    if (!isUuid((body as any).client_message_id)) return json(req,{success:false,error:"invalid_client_message_id"},400);
    // Do not create a visitor/session merely to discover that the execution
    // environment is not activated. Human-controlled messages and explicit R1
    // remain ordinary widget operations and never require model admission.
    const existingControl = requestedConversationId ? await loadOwnedTestConversation(admin,requestedConversationId,authData.user.id,resolved) : null;
    const underHumanControl = existingControl?.ok && (HUMAN_CONTROL_STATUSES.has(String(existingControl.conversation.status)) || Boolean(existingControl.conversation.assigned_agent_id));
    const controlOnly = isExplicitHandoffRequest(query);
    const localConversation = classifyNonFactualConversation(query) !== null;
    if(original && !underHumanControl && !controlOnly && !localConversation && existingControl?.ok && existingControl.conversation.metadata_source?.execution_class !== "authenticated_admin_preview")
      return json(req,{success:false,error:"original_preview_new_conversation_required",retryable:false},403);
    if(originalCandidate && originalRoute && !original && !requestedConversationId) return json(req,{success:false,error:"live_ai_execution_unavailable",failure:executionFailure("ORIGINAL_PREVIEW_AUTHORIZATION_REQUIRED"),retryable:false},503);
    if (!execution.ready && !underHumanControl && !controlOnly && !localConversation) return json(req,{success:false,error:"live_ai_execution_unavailable",failure:execution.failure,retryable:false,correlation_id:correlationId},503);
    if (execution.ready && execution.allowed_conversations.length && !execution.allowed_conversations.includes(requestedConversationId || await testConversationId(authData.user.id,resolved.channelId,String((body as any).client_message_id))) && !underHumanControl && !controlOnly) return json(req,{success:false,error:"live_ai_conversation_not_authorized",retryable:false,correlation_id:correlationId},403);

    let conversationId = requestedConversationId;
    if (conversationId) {
      const owned = await loadOwnedTestConversation(admin, conversationId, authData.user.id, resolved);
      if (!owned.ok) return json(req, { success: false, error: owned.error }, owned.status);
      if (owned.conversation.status === "resolved" || owned.conversation.status === "closed") {
        return json(req, { success: false, error: "test_conversation_resolved" }, 409);
      }

    } else {
      const created = await createTestConversation(admin, authData.user.id, resolved, String((body as any).client_message_id),original ? authData.user : undefined);
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
    const receiveStarted=Date.now();
    const sent = await widgetRequest(supabaseUrl, serviceKey, tokenMatch[1], origin, "receive-widget-message", {
      conversation_id:conversationId, session_token:session.session_token, content:query, client_message_id:clientMessageId,
    });
    const receiveMs=Date.now()-receiveStarted;
    if (!isUuid(sent.message_id)) return json(req,{success:false,error:"visitor_receipt_unverified"},503);
    const pollStarted=Date.now();
    let receiptState:any=null;
    let poll:any;
    if(original) {
      // Confirm only the exact durable Visitor row. Do not put another HTTP
      // poll/full transcript read on the send ACK path. The original client
      // polling mechanism still owns eventual AI/Agent delivery.
      const receipt=await admin.from("messages").select("id,role,content,created_at,metadata,archive:conversations!inner(id,company_id,channel_config_id,visitor_session_id,metadata_source,status,assigned_agent_id,archive_session:visitor_session!inner(id,channel_config_id,visitor_fingerprint,visitor_metadata))")
        .eq("id",sent.message_id).eq("conversation_id",conversationId).eq("role","visitor").eq("is_recalled",false).maybeSingle();
      const row=receipt.data as Record<string,any>|null,parent=row?.archive,s=parent?.archive_session,sm=s?.visitor_metadata;
      if(receipt.error || !row || row.id!==sent.message_id || row.role!=="visitor" || row.content!==query || row.metadata?.client_message_id!==clientMessageId ||
        parent?.id!==conversationId || parent.company_id!==resolved.companyId || parent.channel_config_id!==resolved.channelId ||
        !originalPreviewMetadata(parent.metadata_source,authData.user.id) || s?.id!==parent.visitor_session_id || s.channel_config_id!==resolved.channelId ||
        s.visitor_fingerprint!==`widget-live-test:${authData.user.id}` || sm?.source!=="widget_live_test" || sm.owner_user_id!==authData.user.id || sm.test_mode!==true || sm.exclude_training!==true || sm.scope_mode!=="canonical")
        return json(req,{success:false,error:"visitor_receipt_unverified"},503);
      if(!await verifyOriginalPreview(admin,parent,undefined,false))return json(req,{success:false,error:"original_preview_authority_denied"},403);
      receiptState=parent;
      const human=HUMAN_CONTROL_STATUSES.has(String(parent.status)) || Boolean(parent.assigned_agent_id);
      poll={messages:[{id:row.id,role:row.role,content:row.content,created_at:row.created_at,metadata:{client_message_id:clientMessageId}}],ai_generating:!human && sent.ai_reply_pending===true,
        human_support:{state:human ? parent.assigned_agent_id ? "assigned" : "waiting" : "none"}};
    } else {
      poll = await widgetRequest(supabaseUrl,serviceKey,tokenMatch[1],origin,"widget-poll-messages",{
        conversation_id:conversationId,session_token:session.session_token,
      });
    }
    const receiptReadMs=Date.now()-pollStarted;
    const pollMs=original ? 0 : receiptReadMs;
    // The existing receive transaction and EdgeRuntime.waitUntil own durable
    // dispatch. The exact scoped Visitor read verifies persistence; the existing
    // client poll delivers the eventual answer without server waiting.
    const messages = poll.messages ?? [];
    if (original && !messages.some((m:any)=>m.id===sent.message_id && m.role==="visitor" && m.content===query))
      return json(req,{success:false,error:"visitor_receipt_unverified"},503);
    const {data: state,error: stateError} = receiptState ? {data:receiptState,error:null} : await admin.from("conversations").select("status,assigned_agent_id").eq("id",conversationId).eq("company_id",resolved.companyId).eq("channel_config_id",resolved.channelId).maybeSingle();
    if (stateError || !state) return json(req,{success:false,error:"test_conversation_lookup_failed"},500);
    const latestAssistant = [...messages].reverse().find((m:any) => m.role === "assistant" && m.metadata?.source_message_id === sent.message_id);
    const humanControl=HUMAN_CONTROL_STATUSES.has(String(state.status ?? "")) || Boolean(state.assigned_agent_id) ||
      Boolean(poll.human_support?.state && poll.human_support.state!=="none");
    deps.log({endpoint:"widget-live-ai-test",action,stage:"visitor_receipt_verified",source_message_id:sent.message_id,
      conversation_id:conversationId,correlation_id:correlationId,elapsed_ms:Date.now()-requestStarted,
      receive_ms:receiveMs,poll_ms:pollMs,receipt_read_ms:original ? receiptReadMs : 0,reply_persisted:Boolean(latestAssistant),generation_pending:sent.ai_reply_pending===true && !latestAssistant && !humanControl});
    return json(req, {
      success: true,
      mode: "persistent_live_ai_test",
      scope_mode: resolved.scopeMode,
      conversation_id: conversationId,
      delivery_receipt: {persisted:true,conversation_id:conversationId,client_message_id:String((body as any).client_message_id),visitor_message_id:String(sent.message_id)},
      conversation_status: state?.status ?? null,
      assigned_agent_id: state?.assigned_agent_id ?? null,
      human_control:
        HUMAN_CONTROL_STATUSES.has(String(state?.status ?? "")) ||
        Boolean(state?.assigned_agent_id),
      handoff_persisted: (poll.human_support?.state && poll.human_support.state !== "none"),
      human_support: poll.human_support,
      ai_generating: !humanControl && !latestAssistant && (poll.ai_generating===true || sent.ai_reply_pending===true),
      idempotent: sent.idempotent === true,
      answer: latestAssistant?.content ?? "",
      generation_success: latestAssistant ? latestAssistant.metadata?.generation_success !== false && latestAssistant.metadata?.degraded !== true : false,
      degraded: latestAssistant?.metadata?.degraded === true,
      execution_failure: latestAssistant?.metadata?.execution_failure ?? null,
      messages,
    });
  } catch (e) {
    if (readAction) deps.log({endpoint:"widget-live-ai-test",action:readAction,stage:readStage,status:500,elapsed_ms:Date.now()-requestStarted,correlation_id:correlationId});
    diagnostic("unexpected", null, 500);
    return json(req, { success: false, error: "internal_error" }, 500);
  }
};
}

Deno.serve(createWidgetLiveHandler());
