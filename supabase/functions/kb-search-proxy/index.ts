import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ALLOWED_ROLES = new Set(["admin", "supervisor"]);
const MAX_QUERY_LENGTH = 500;
const MAX_TOP_K = 3;
const KB_TIMEOUT_MS = 12000;

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
    const hasAllowedRole = userRoles.some(
      (r: { role: string }) => ALLOWED_ROLES.has(r.role),
    );
    if (!hasAllowedRole) {
      return jsonResponse({ error: "forbidden" }, 403, req);
    }

    const body = await req.json().catch(() => ({}));

    if (body?.company_id !== undefined || body?.industry !== undefined) {
      return jsonResponse(
        { error: "invalid_request", detail: "company_id and industry must not be provided by client" },
        400, req,
      );
    }

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

    const kbEndpoint = Deno.env.get("KB_RAG_ENDPOINT");
    const kbToken = Deno.env.get("KB_RAG_TOKEN");
    const companyIdStr = Deno.env.get("KB_DEMO_COMPANY_ID");
    const industryEnv = Deno.env.get("KB_DEMO_INDUSTRY");
    const language = Deno.env.get("KB_DEMO_LANGUAGE") ?? "zh-TW";

    if (!kbEndpoint || !kbToken || !companyIdStr || !industryEnv) {
      console.error("[kb-search-proxy] KB config missing — fail closed");
      return jsonResponse({ error: "kb_config_missing" }, 500, req);
    }
    const companyId = parseInt(companyIdStr, 10);
    if (isNaN(companyId)) {
      console.error("[kb-search-proxy] KB_DEMO_COMPANY_ID not valid integer");
      return jsonResponse({ error: "kb_config_missing" }, 500, req);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), KB_TIMEOUT_MS);
    let kbResponse: Response;
    try {
      kbResponse = await fetch(`${kbEndpoint}/kb/rag-search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${kbToken}`,
        },
        body: JSON.stringify({
          query,
          company_id: companyId,
          industry: industryEnv,
          language,
          status: "published",
          top_k: topK,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof DOMException && err.name === "AbortError") {
        console.error("[kb-search-proxy] KB API timeout");
        return jsonResponse({ error: "kb_api_timeout" }, 504, req);
      }
      console.error("[kb-search-proxy] KB API fetch error:", (err as Error).name);
      return jsonResponse({ error: "kb_api_error" }, 502, req);
    }
    clearTimeout(timeout);

    if (!kbResponse.ok) {
      console.error("[kb-search-proxy] KB API HTTP error:", kbResponse.status);
      return jsonResponse({ error: "kb_api_error" }, 502, req);
    }

    let kbData: { ok?: boolean; results?: Array<Record<string, unknown>> };
    try {
      kbData = await kbResponse.json();
    } catch {
      console.error("[kb-search-proxy] KB API invalid JSON");
      return jsonResponse({ error: "kb_api_error" }, 502, req);
    }

    if (!kbData.ok || !kbData.results) {
      return jsonResponse({ success: true, results: [] }, 200, req);
    }

    const sanitised = kbData.results
      .filter((r: Record<string, unknown>) => {
        if (r.company_id === undefined || r.company_id === null) return false;
        if (r.industry === undefined || r.industry === null) return false;
        if (r.company_id !== companyId) return false;
        if (r.industry !== industryEnv) return false;
        return true;
      })
      .slice(0, topK)
      .map((r: Record<string, unknown>) => ({
        display_label: typeof r.title === "string" ? (r.title as string).slice(0, 200) : "KB document",
        content: typeof r.content === "string" ? (r.content as string).slice(0, 500) : "",
        score: typeof r.score === "number" ? r.score : 0,
        source_type: typeof r.source_type === "string" ? r.source_type : "unknown",
      }));

    return jsonResponse({ success: true, results: sanitised }, 200, req);
  } catch (e) {
    console.error("[kb-search-proxy] unexpected error:", (e as Error).name);
    return jsonResponse({ error: "internal_error" }, 500, req);
  }
});
