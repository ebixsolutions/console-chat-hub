import { resolveKBEndpoint, resolveTenantScope, fetchKBRag } from "../_shared/kb-client.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const MAX_QUERY_LENGTH = 500;
const MAX_TOP_K = 3;

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
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
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
    // Auth layer 1: JWT
    const supabaseAuth = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
    );
    const { data: { user }, error: authErr } = await supabaseAuth.auth.getUser();
    if (authErr || !user) {
      return jsonResponse({ error: "unauthorized" }, 401, req);
    }

    // Auth layer 2: role check
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

    // Parse body
    const body = await req.json().catch(() => ({}));

    // REJECT frontend tenant spoofing
    if (body?.company_id !== undefined || body?.industry !== undefined || body?.language !== undefined) {
      return jsonResponse(
        { error: "invalid_request", detail: "company_id, industry, and language must not be provided by client" },
        400, req,
      );
    }

    // Validate query
    const rawQuery = body?.query;
    if (typeof rawQuery !== "string") {
      return jsonResponse({ error: "invalid_request", detail: "query required" }, 400, req);
    }
    const query = rawQuery.trim();
    if (query.length === 0) {
      return jsonResponse({ error: "invalid_request", detail: "query empty" }, 400, req);
    }
    if (query.length > MAX_QUERY_LENGTH) {
      return jsonResponse({ error: "invalid_request", detail: "query too long (max 500)" }, 400, req);
    }
    const topK = Math.max(1, Math.min(MAX_TOP_K, parseInt(String(body?.top_k), 10) || 3));

    // Validate conversation_id (optional but used for tenant resolution)
    const conversationId = body?.conversation_id;
    if (conversationId !== undefined && !isUuid(conversationId)) {
      return jsonResponse({ error: "invalid_request", detail: "invalid conversation_id" }, 400, req);
    }

    // Resolve KB endpoint config
    const endpointCfg = resolveKBEndpoint();
    if (!endpointCfg) {
      console.error("[kb-search-proxy] KB endpoint config missing — fail closed");
      return jsonResponse({ error: "kb_config_missing" }, 500, req);
    }

    // Canonical tenant scope resolution
    const tenantResult = await resolveTenantScope(conversationId ?? null);
    if (!tenantResult.resolved) {
      console.error("[kb-search-proxy] tenant scope unresolved:", tenantResult.reason);
      return jsonResponse({ error: "kb_tenant_unresolved", detail: tenantResult.reason }, 503, req);
    }

    // Canonical KB fetch
    const kbResult = await fetchKBRag({ query, top_k: topK }, tenantResult.scope, endpointCfg);
    if (!kbResult.success) {
      if (kbResult.error_code === "KB_TIMEOUT") {
        console.error("[kb-search-proxy] KB API timeout");
        return jsonResponse({ error: "kb_api_timeout" }, 504, req);
      }
      console.error("[kb-search-proxy] KB API error:", kbResult.error_code);
      return jsonResponse({ error: "kb_api_error" }, 502, req);
    }

    return jsonResponse({ success: true, results: kbResult.citations }, 200, req);
  } catch (e) {
    console.error("[kb-search-proxy] unexpected error:", (e as Error).name);
    return jsonResponse({ error: "internal_error" }, 500, req);
  }
});
