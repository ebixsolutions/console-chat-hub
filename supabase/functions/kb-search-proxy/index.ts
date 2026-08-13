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
    Vary: "Origin",
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      console.error("[kb-search-proxy] Supabase config missing");
      return jsonResponse({ error: "server_config_missing" }, 500, req);
    }

    const supabaseAuth = createClient(supabaseUrl, anonKey, {
      global: {
        headers: { Authorization: req.headers.get("Authorization") ?? "" },
      },
    });

    const {
      data: { user },
      error: authErr,
    } = await supabaseAuth.auth.getUser();
    if (authErr || !user) {
      return jsonResponse({ error: "unauthorized" }, 401, req);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

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

    const body = await req.json().catch(() => ({}));

    if (
      body?.company_id !== undefined ||
      body?.industry !== undefined ||
      body?.language !== undefined ||
      body?.tenant_id !== undefined ||
      body?.workspace_id !== undefined
    ) {
      return jsonResponse(
        {
          error: "invalid_request",
          detail:
            "tenant/company/industry/language/workspace scope must not be provided by client",
        },
        400,
        req,
      );
    }

    const rawQuery = body?.query;
    if (typeof rawQuery !== "string") {
      return jsonResponse(
        { error: "invalid_request", detail: "query required" },
        400,
        req,
      );
    }

    const query = rawQuery.trim();
    if (query.length === 0) {
      return jsonResponse(
        { error: "invalid_request", detail: "query empty" },
        400,
        req,
      );
    }

    if (query.length > MAX_QUERY_LENGTH) {
      return jsonResponse(
        { error: "invalid_request", detail: "query too long (max 500)" },
        400,
        req,
      );
    }

    const topK = Math.max(
      1,
      Math.min(
        MAX_TOP_K,
        Number.parseInt(String(body?.top_k), 10) || 3,
      ),
    );

    // Production console KB is conversation-scoped: required, never optional.
    const conversationId = body?.conversation_id;
    if (!isUuid(conversationId)) {
      return jsonResponse(
        { error: "invalid_request", detail: "valid conversation_id required" },
        400,
        req,
      );
    }

    const { data: conversation, error: conversationErr } = await supabaseAdmin
      .from("conversations")
      .select("id, company_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (conversationErr) {
      console.error("[kb-search-proxy] conversation lookup failed", {
        conversation_id: conversationId,
        code: conversationErr.code,
      });
      return jsonResponse({ error: "conversation_lookup_failed" }, 500, req);
    }

    if (!conversation) {
      return jsonResponse({ error: "conversation_not_found" }, 404, req);
    }

    const tenantResult = await resolveTenantScope(conversationId);
    if (!tenantResult.resolved) {
      console.error("[kb-search-proxy] tenant scope unresolved", {
        conversation_id: conversationId,
        reason: tenantResult.reason,
      });
      return jsonResponse(
        { error: "kb_tenant_unresolved", detail: tenantResult.reason },
        503,
        req,
      );
    }
    const resolvedCompanyId = tenantResult.scope.aiCompanyId;

    // Authoritative membership helper checks:
    // company_id + user_id + membership.is_active + company.is_active.
    const { data: isMember, error: membershipErr } =
      await supabaseAdmin.rpc("is_company_member", {
        p_company_id: resolvedCompanyId,
        p_user_id: user.id,
      });

    if (membershipErr) {
      console.error("[kb-search-proxy] company membership check failed", {
        conversation_id: conversationId,
        company_id: resolvedCompanyId,
        code: membershipErr.code,
      });
      return jsonResponse({ error: "tenant_authorization_failed" }, 500, req);
    }

    if (isMember !== true) {
      return jsonResponse({ error: "forbidden_tenant" }, 403, req);
    }

    const endpointCfg = resolveKBEndpoint();
    if (!endpointCfg) {
      console.error("[kb-search-proxy] KB endpoint config missing — fail closed");
      return jsonResponse({ error: "kb_config_missing" }, 500, req);
    }

    const kbResult = await fetchKBRag(
      { query, top_k: topK },
      tenantResult.scope,
      endpointCfg,
    );

    if (!kbResult.success) {
      if (kbResult.error_code === "KB_TIMEOUT") {
        return jsonResponse({ error: "kb_api_timeout" }, 504, req);
      }
      console.error("[kb-search-proxy] KB API error", {
        code: kbResult.error_code,
      });
      return jsonResponse({ error: "kb_api_error" }, 502, req);
    }

    // Defense in depth: every returned citation must belong to the same
    // selected document as the structured LLM context. A mismatch is treated
    // as an upstream contract failure, never silently mixed.
    const selectedDocumentId =
      kbResult.llm_context?.selected_document_id ??
      kbResult.selected_document_id;

    if (selectedDocumentId) {
      const crossDocument = kbResult.citations.some(
        (citation) =>
          citation.document_id !== undefined &&
          citation.document_id !== selectedDocumentId,
      );
      if (crossDocument) {
        console.error("[kb-search-proxy] cross-document aggregation mismatch", {
          conversation_id: conversationId,
          selected_document_id: selectedDocumentId,
        });
        return jsonResponse({ error: "kb_contract_mismatch" }, 502, req);
      }
    }

    const policyEvidence =
      kbResult.llm_context?.full_content_evidence
        ?.filter((item) =>
          typeof item.source_type === "string" &&
          item.source_type.toLowerCase().includes("policy") &&
          typeof item.content === "string" &&
          item.content.trim().length > 0
        )
        .slice(0, 3)
        .map((item, index) => ({
          label: `Policy evidence ${index + 1}`,
          content: item.content.slice(0, 800),
          source_type: item.source_type.slice(0, 40),
          document_id: item.document_id,
          ...(item.chunk_id ? { chunk_id: item.chunk_id } : {}),
          score: item.score,
        })) ?? [];

    return jsonResponse(
      {
        success: true,
        // Backward-compatible flattened result list for current Knowledge UI.
        results: kbResult.citations,
        // Canonical v2 structured context for all new callers.
        llm_context: kbResult.llm_context ?? null,
        meta: kbResult.meta ?? null,
        selected_document_id: selectedDocumentId ?? null,
        // Policy caller contract: exact full-content policy evidence only.
        // rag_summary is intentionally excluded from compliance decisions.
        policy_evidence: policyEvidence,
      },
      200,
      req,
    );
  } catch (e) {
    console.error("[kb-search-proxy] unexpected error", (e as Error).name);
    return jsonResponse({ error: "internal_error" }, 500, req);
  }
});
