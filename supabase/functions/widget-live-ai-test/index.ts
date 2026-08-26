import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { fetchKBRag, resolveKBEndpoint, type KBResolvedScope } from "../_shared/kb-client.ts";
import { callModel } from "../_shared/llm-router.ts";
import { supabaseCorsHeaders } from "../_shared/supabase-cors.ts";

const MAX_QUERY_LENGTH = 500;
const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const PROJECT_ID = "4dbf593e-577e-4af4-a553-460441c34473";
const PRODUCTION_ORIGIN = "https://console-chat-hub.lovable.app";

type QueryClient = { from: (table: string) => any };

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isAllowedConsoleOrigin(raw: string): boolean {
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      return false;
    }
    if (raw === PRODUCTION_ORIGIN) return true;
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

function parseTenantMap(): Record<string, string> | null {
  const raw = Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON");
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out: Record<string, string> = {};
    for (const [companyId, tenantId] of Object.entries(value as Record<string, unknown>)) {
      if (!isUuid(companyId) || typeof tenantId !== "string" || !tenantId.trim()) {
        return null;
      }
      out[companyId] = tenantId.trim();
    }
    return out;
  } catch {
    return null;
  }
}

async function resolveTestScope(
  admin: QueryClient,
  userId: string,
): Promise<
  | { ok: true; scope: KBResolvedScope; companyId: string | null }
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
      .select("id, is_active")
      .eq("id", companyId)
      .maybeSingle();

    if (companyError) return { ok: false, status: 500, error: "company_lookup_failed" };
    if (!company || company.is_active !== true) {
      return { ok: false, status: 403, error: "company_inactive" };
    }

    const tenantMap = parseTenantMap();
    if (tenantMap === null) {
      return { ok: false, status: 500, error: "kb_tenant_mapping_invalid" };
    }
    const singaporeTenantId = tenantMap[companyId];
    if (!singaporeTenantId) {
      return { ok: false, status: 503, error: "kb_tenant_unresolved" };
    }

    return {
      ok: true,
      companyId,
      scope: {
        mode: "canonical",
        aiCompanyId: companyId,
        singaporeTenantId,
      },
    };
  }

  const { data: globalRoles, error: roleError } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);

  if (roleError) return { ok: false, status: 500, error: "role_lookup_failed" };
  if (!(globalRoles ?? []).some((r: any) => ALLOWED_ROLES.has(String(r.role)))) {
    return { ok: false, status: 403, error: "forbidden" };
  }

  if (Deno.env.get("KB_PREACTIVATION_ENABLED") !== "true") {
    return { ok: false, status: 503, error: "kb_preactivation_disabled" };
  }
  const singaporeTenantId = Deno.env.get("KB_PREACTIVATION_TENANT_ID")?.trim();
  if (!singaporeTenantId) {
    return { ok: false, status: 503, error: "kb_preactivation_config_missing" };
  }

  return {
    ok: true,
    companyId: null,
    scope: {
      mode: "pre_activation",
      aiCompanyId: null,
      singaporeTenantId,
    },
  };
}

function referenceList(
  chunks: Array<{
    title?: string;
    source_type?: string;
    chunk_type?: string;
    score?: number;
  }>,
) {
  return chunks
    .slice(0, 4)
    .map((chunk) => ({
      label: typeof chunk.title === "string" && chunk.title.trim()
        ? chunk.title.trim().slice(0, 160)
        : "Knowledge Base document",
      source_type: typeof chunk.source_type === "string" && chunk.source_type.trim()
        ? chunk.source_type.trim().slice(0, 80)
        : "knowledge",
      chunk_type: ["rag_summary", "full_content", "faq_pair", "section"].includes(String(chunk.chunk_type))
        ? String(chunk.chunk_type)
        : "section",
      score: Number.isFinite(Number(chunk.score)) ? Number(chunk.score) : 0,
    }));
}


type TestMessageRow = {
  id: string;
  role: "visitor" | "assistant";
  content: string;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
};

type TestConversationSummary = {
  conversation_id: string;
  created_at: string | null;
  updated_at: string | null;
  latest_preview: string;
  message_count: number;
};

function isTestConversationOwned(
  metadataSource: unknown,
  userId: string,
): boolean {
  if (!metadataSource || typeof metadataSource !== "object" || Array.isArray(metadataSource)) {
    return false;
  }
  const m = metadataSource as Record<string, unknown>;
  return m.widget_live_test === true &&
    m.owner_user_id === userId &&
    m.exclude_training === true;
}

async function loadOwnedTestConversation(
  admin: QueryClient,
  conversationId: string,
  userId: string,
): Promise<
  | { ok: true; conversation: Record<string, any> }
  | { ok: false; status: number; error: string }
> {
  if (!isUuid(conversationId)) {
    return { ok: false, status: 400, error: "invalid_test_conversation_id" };
  }

  const { data, error } = await admin
    .from("conversations")
    .select("id,status,company_id,channel_config_id,visitor_session_id,metadata_source,created_at,updated_at")
    .eq("id", conversationId)
    .maybeSingle();

  if (error) return { ok: false, status: 500, error: "test_conversation_lookup_failed" };
  if (!data || !isTestConversationOwned(data.metadata_source, userId)) {
    return { ok: false, status: 404, error: "test_conversation_not_found" };
  }
  return { ok: true, conversation: data };
}

async function loadTestMessages(
  admin: QueryClient,
  conversationId: string,
): Promise<TestMessageRow[]> {
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
      role: m.role === "visitor" ? "visitor" : "assistant",
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
  resolved: { scope: KBResolvedScope; companyId: string | null },
): Promise<
  | { ok: true; conversationId: string }
  | { ok: false; status: number; error: string }
> {
  const sessionToken = `preview-test.${crypto.randomUUID()}.${crypto.randomUUID().replace(/-/g, "")}`;
  const visitorMetadata = {
    name: "Widget Live Test",
    source: "widget_live_test",
    test_mode: true,
    owner_user_id: userId,
    exclude_training: true,
    scope_mode: resolved.scope.mode,
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
    scope_mode: resolved.scope.mode,
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

async function listOwnedTestHistory(
  admin: QueryClient,
  userId: string,
): Promise<TestConversationSummary[]> {
  const { data, error } = await admin
    .from("conversations")
    .select("id,created_at,updated_at,metadata_source")
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) throw new Error("test_history_lookup_failed");

  const owned = (data ?? [])
    .filter((c: any) => isTestConversationOwned(c.metadata_source, userId))
    .slice(0, 10);

  const out: TestConversationSummary[] = [];
  for (const c of owned) {
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

async function naturalNoEvidenceReply(
  query: string,
  resolved: { scope: KBResolvedScope; companyId: string | null },
  conversationId: string,
): Promise<{
  answer: string;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number; latency_ms: number; attempts: number };
}> {
  const llm = await callModel({
    purpose: "generation",
    system: [
      "You are a friendly customer-service assistant.",
      "The Knowledge Base search did not return authoritative full-content evidence for this request.",
      "Do NOT invent product facts, specifications, prices, policies, or recommendations.",
      "Reply in the same language and script as the user.",
      "Do not mention technical terms such as full_content, RAG, evidence threshold, schema, API, or Knowledge Base internals.",
      "Acknowledge what the customer wants in natural language and ask one or two concise clarifying questions that would help narrow the search.",
      "If the request is broad, offer useful categories to choose from without claiming factual details.",
      "Keep the response under 90 words.",
    ].join("\n"),
    user: query,
    maxTokens: 240,
    operationId: `widget-live-test:no-evidence:${conversationId}:${crypto.randomUUID()}`,
    companyId: resolved.companyId,
    conversationId,
    tag: "widget-live-ai-test-no-evidence",
    responseFormat: "text",
  });

  if (!llm.ok) {
    const zh = /[\u4e00-\u9fff]/.test(query);
    return {
      answer: zh
        ? "可以，我可以幫你找相關資料。你想了解哪一類產品、品牌或型號？如果是冷氣機，也可以告訴我你想看窗口式、分體式，或大約需要的匹數。"
        : "I can help narrow that down. Which product type, brand, or model are you interested in? If you mean air conditioners, tell me whether you want window or split type, or the approximate capacity you need.",
    };
  }

  return { answer: llm.text, model: llm.model, usage: llm.usage };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const origin = req.headers.get("Origin") ?? "";
    if (!isAllowedConsoleOrigin(origin)) return new Response(null, { status: 403 });
    const headers = cors(req);
    if (!headers["Access-Control-Allow-Headers"]) {
      return new Response(null, { status: 403 });
    }
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
    ]) {
      if ((body as Record<string, unknown>)[forbidden] !== undefined) {
        return json(req, {
          success: false,
          error: "invalid_request",
          detail: "tenant/company/key/channel scope is server-derived",
        }, 400);
      }
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json(req, { success: false, error: "server_config_missing" }, 500);
    }

    const auth = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: req.headers.get("Authorization") ?? "",
        },
      },
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
      const history = await listOwnedTestHistory(admin, authData.user.id);
      return json(req, { success: true, mode: "persistent_live_ai_test", history });
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
      );
      if (!owned.ok) return json(req, { success: false, error: owned.error }, owned.status);
      const messages = await loadTestMessages(admin, requestedConversationId);
      return json(req, {
        success: true,
        mode: "persistent_live_ai_test",
        scope_mode: resolved.scope.mode,
        conversation_id: requestedConversationId,
        messages,
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
      if (owned.conversation.status === "resolved") {
        return json(req, { success: false, error: "test_conversation_resolved" }, 409);
      }
    } else {
      const created = await createTestConversation(admin, authData.user.id, resolved);
      if (!created.ok) {
        return json(req, { success: false, error: created.error }, created.status);
      }
      conversationId = created.conversationId;
    }

    const now = new Date().toISOString();
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
      .update({ updated_at: now })
      .eq("id", conversationId);

    const kbEndpoint = resolveKBEndpoint();
    if (!kbEndpoint) {
      return json(req, { success: false, error: "kb_config_missing", conversation_id: conversationId }, 503);
    }

    const kb = await fetchKBRag(
      { query, top_k: 5 },
      resolved.scope,
      kbEndpoint,
      { timeoutMs: 15000 },
    );

    if (!kb.success) {
      return json(req, {
        success: false,
        error: "kb_live_test_failed",
        detail: kb.error_code,
        conversation_id: conversationId,
      }, kb.error_code === "KB_TIMEOUT" ? 504 : 502);
    }

    const references = referenceList(kb.chunks);
    const fullEvidence = kb.llm_context?.full_content_evidence?.filter(
      (item) =>
        typeof item.content === "string" &&
        item.content.trim().length > 0,
    ).slice(0, 3) ?? [];

    let answer = "";
    let model: string | undefined;
    let usage:
      | { input_tokens: number; output_tokens: number; latency_ms: number; attempts: number }
      | undefined;
    let grounded = false;

    if (fullEvidence.length === 0) {
      const fallback = await naturalNoEvidenceReply(
        query,
        resolved,
        conversationId,
      );
      answer = fallback.answer;
      model = fallback.model;
      usage = fallback.usage;
    } else {
      const orientation = kb.llm_context?.orientation_summary?.trim() ?? "";
      const evidenceText = fullEvidence.map((item, index) =>
        `[Full Content Evidence ${index + 1}]\n${item.content.slice(0, 1600)}`
      ).join("\n\n");

      const system = [
        "You are a professional, friendly customer-service assistant.",
        "Answer naturally in the same language and script as the user's question.",
        "Use ONLY the Full Content Evidence below for factual claims.",
        "Do not expose internal retrieval terms or implementation details to the customer.",
        "The Orientation Summary is navigation context only and cannot independently support prices, dates, dimensions, policy conditions, procedures, limits, or other exact facts.",
        "If evidence supports only part of the request, answer the supported part naturally and ask a concise clarifying question for the rest.",
        orientation
          ? `Orientation Summary (context only):\n${orientation.slice(0, 1200)}`
          : "",
        `Full Content Evidence:\n${evidenceText}`,
      ].filter(Boolean).join("\n\n");

      const llm = await callModel({
        purpose: "generation",
        system,
        user: query,
        maxTokens: 600,
        operationId: `widget-live-test:${conversationId}:${crypto.randomUUID()}`,
        companyId: resolved.companyId,
        conversationId,
        tag: "widget-live-ai-test",
        responseFormat: "text",
      });

      if (!llm.ok) {
        return json(req, {
          success: false,
          error: "llm_live_test_failed",
          detail: llm.code,
          conversation_id: conversationId,
        }, llm.code === "LLM_TIMEOUT" ? 504 : 502);
      }

      answer = llm.text;
      model = llm.model;
      usage = llm.usage;
      grounded = true;
    }

    const { error: assistantError } = await admin
      .from("messages")
      .insert({
        conversation_id: conversationId,
        role: "assistant",
        content: answer,
        status: "sent",
        metadata: {
          widget_live_test: true,
          source: "widget_preview",
          exclude_training: true,
          grounded,
          model: model ?? null,
          full_content_evidence_count: fullEvidence.length,
          references,
          source_visitor_message_id: visitorMessage.id,
        },
      });

    if (assistantError) {
      return json(req, {
        success: false,
        error: "test_assistant_message_create_failed",
        conversation_id: conversationId,
      }, 500);
    }

    await admin
      .from("conversations")
      .update({
        updated_at: new Date().toISOString(),
        language: /[\u4e00-\u9fff]/.test(query) ? "zh" : "en",
      })
      .eq("id", conversationId);

    const messages = await loadTestMessages(admin, conversationId);

    return json(req, {
      success: true,
      mode: "persistent_live_ai_test",
      scope_mode: resolved.scope.mode,
      conversation_id: conversationId,
      grounded,
      answer,
      model,
      selected_document_id: kb.llm_context?.selected_document_id ?? null,
      full_content_evidence_count: fullEvidence.length,
      references,
      usage,
      messages,
    });
  } catch (e) {
    console.error(
      "[widget-live-ai-test] unexpected",
      e instanceof Error ? e.message : "unknown_error",
    );
    return json(req, { success: false, error: "internal_error" }, 500);
  }
});
