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

  if (req.method !== "POST") return json(req, { success: false, error: "method_not_allowed" }, 405);

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
        return json(req, {
          success: false,
          error: "invalid_request",
          detail: "tenant/company/key/channel/conversation scope is server-derived",
        }, 400);
      }
    }

    const query = typeof (body as any).query === "string"
      ? String((body as any).query).trim()
      : "";
    if (!query || query.length > MAX_QUERY_LENGTH) {
      return json(req, { success: false, error: "invalid_query" }, 400);
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

    const kbEndpoint = resolveKBEndpoint();
    if (!kbEndpoint) {
      return json(req, { success: false, error: "kb_config_missing" }, 503);
    }

    const kb = await fetchKBRag(
      { query, top_k: 5 },
      resolved.scope,
      kbEndpoint,
      { timeoutMs: 15000 },
    );

    if (!kb.success) {
      const status = kb.error_code === "KB_TIMEOUT"
        ? 504
        : kb.error_code === "KB_AUTH_TOKEN_MISSING" ||
            kb.error_code === "KB_AUTH_API_KEY_INVALID"
          ? 503
          : 502;
      return json(req, {
        success: false,
        error: "kb_live_test_failed",
        detail: kb.error_code,
      }, status);
    }

    const references = referenceList(kb.chunks);
    const fullEvidence = kb.llm_context?.full_content_evidence?.filter(
      (item) =>
        typeof item.content === "string" &&
        item.content.trim().length > 0,
    ).slice(0, 3) ?? [];

    if (fullEvidence.length === 0) {
      return json(req, {
        success: true,
        mode: "isolated_live_ai_test",
        scope_mode: resolved.scope.mode,
        grounded: false,
        answer:
          "The Knowledge Base returned no authoritative full-content evidence for this query, so no factual AI answer was generated.",
        selected_document_id: kb.llm_context?.selected_document_id ?? null,
        full_content_evidence_count: 0,
        references,
      });
    }

    const orientation = kb.llm_context?.orientation_summary?.trim() ?? "";
    const evidenceText = fullEvidence.map((item, index) =>
      `[Full Content Evidence ${index + 1}]\n${item.content.slice(0, 1600)}`
    ).join("\n\n");

    const system = [
      "You are the production customer-service answer generator running in an isolated Live AI Test.",
      "Answer in the same language and script as the user's question.",
      "Use ONLY the Full Content Evidence below for factual claims.",
      "The Orientation Summary is navigation context only and cannot independently support prices, dates, dimensions, policy conditions, procedures, limits, or other exact facts.",
      "If the Full Content Evidence does not support the requested fact, say the Knowledge Base does not provide enough evidence.",
      "Do not claim that a human handoff occurred; this test mode never changes production conversation state.",
      orientation
        ? `Orientation Summary (context only):\n${orientation.slice(0, 1200)}`
        : "",
      `Full Content Evidence:\n${evidenceText}`,
    ].filter(Boolean).join("\n\n");

    const operationId = `widget-live-test:${crypto.randomUUID()}`;
    const llm = await callModel({
      purpose: "generation",
      system,
      user: query,
      maxTokens: 600,
      operationId,
      companyId: resolved.companyId,
      conversationId: null,
      tag: "widget-live-ai-test",
      responseFormat: "text",
    });

    if (!llm.ok) {
      return json(req, {
        success: false,
        error: "llm_live_test_failed",
        detail: llm.code,
      }, llm.code === "LLM_TIMEOUT" ? 504 : 502);
    }

    return json(req, {
      success: true,
      mode: "isolated_live_ai_test",
      scope_mode: resolved.scope.mode,
      grounded: true,
      answer: llm.text,
      model: llm.model,
      selected_document_id: kb.llm_context?.selected_document_id ?? null,
      full_content_evidence_count: fullEvidence.length,
      references,
      usage: llm.usage,
    });
  } catch (e) {
    console.error("[widget-live-ai-test] unexpected", e instanceof Error ? e.name : "unknown_error");
    return json(req, { success: false, error: "internal_error" }, 500);
  }
});
