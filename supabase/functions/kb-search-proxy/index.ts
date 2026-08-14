import {
  resolveKBEndpoint,
  resolveTenantScope,
  fetchKBRag,
  type KBResolvedScope,
} from "../_shared/kb-client.ts";
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
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
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
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      v,
    )
  );
}

function parseTenantMap():
  | { ok: true; value: Record<string, string> }
  | { ok: false } {
  const raw = Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON");
  if (!raw) return { ok: true, value: {} };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false };
    }

    const out: Record<string, string> = {};
    for (const [companyId, tenantId] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (
        !isUuid(companyId) ||
        typeof tenantId !== "string" ||
        tenantId.trim().length === 0
      ) {
        return { ok: false };
      }
      out[companyId] = tenantId.trim();
    }
    return { ok: true, value: out };
  } catch {
    return { ok: false };
  }
}

type MembershipRow = {
  company_id: string;
  role: string;
};

async function loadEligibleMemberships(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
): Promise<
  | { ok: true; rows: MembershipRow[] }
  | { ok: false; error: "membership_lookup_failed" }
> {
  const { data, error } = await supabaseAdmin
    .from("company_membership")
    .select("company_id, role")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (error) {
    console.error("[kb-search-proxy] company membership lookup failed", {
      user_id: userId,
      code: error.code,
    });
    return { ok: false, error: "membership_lookup_failed" };
  }

  const rows = (data ?? [])
    .filter(
      (row: { company_id?: unknown; role?: unknown }) =>
        typeof row.company_id === "string" &&
        typeof row.role === "string" &&
        ALLOWED_ROLES.has(row.role),
    )
    .map((row: { company_id: string; role: string }) => ({
      company_id: row.company_id,
      role: row.role,
    }));

  return { ok: true, rows };
}

async function requireActiveCompany(
  supabaseAdmin: ReturnType<typeof createClient>,
  companyId: string,
): Promise<boolean | null> {
  const { data, error } = await supabaseAdmin
    .from("company")
    .select("id, is_active")
    .eq("id", companyId)
    .maybeSingle();

  if (error) {
    console.error("[kb-search-proxy] company lookup failed", {
      company_id: companyId,
      code: error.code,
    });
    return null;
  }
  return !!data && data.is_active === true;
}

async function resolveStandaloneScope(
  supabaseAdmin: ReturnType<typeof createClient>,
  eligibleMemberships: MembershipRow[],
): Promise<
  | { ok: true; scope: KBResolvedScope }
  | {
      ok: false;
      status: number;
      error:
        | "forbidden"
        | "company_membership_ambiguous"
        | "company_inactive"
        | "kb_tenant_mapping_invalid"
        | "kb_tenant_unresolved";
    }
> {
  const companyIds = [
    ...new Set(eligibleMemberships.map((row) => row.company_id)),
  ];

  if (companyIds.length === 0) {
    return { ok: false, status: 403, error: "forbidden" };
  }
  if (companyIds.length !== 1) {
    return {
      ok: false,
      status: 409,
      error: "company_membership_ambiguous",
    };
  }

  const companyId = companyIds[0];
  const active = await requireActiveCompany(supabaseAdmin, companyId);
  if (active === null) {
    return {
      ok: false,
      status: 500,
      error: "kb_tenant_unresolved",
    };
  }
  if (!active) {
    return { ok: false, status: 403, error: "company_inactive" };
  }

  const tenantMap = parseTenantMap();
  if (!tenantMap.ok) {
    return {
      ok: false,
      status: 500,
      error: "kb_tenant_mapping_invalid",
    };
  }

  const singaporeTenantId = tenantMap.value[companyId]?.trim();
  if (!singaporeTenantId) {
    return {
      ok: false,
      status: 503,
      error: "kb_tenant_unresolved",
    };
  }

  return {
    ok: true,
    scope: {
      aiCompanyId: companyId,
      singaporeTenantId,
    },
  };
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

    const membershipResult = await loadEligibleMemberships(
      supabaseAdmin,
      user.id,
    );
    if (!membershipResult.ok) {
      return jsonResponse({ error: "tenant_authorization_failed" }, 500, req);
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

    const rawConversationId = body?.conversation_id;
    let scope: KBResolvedScope;
    let conversationId: string | null = null;

    if (rawConversationId !== undefined && rawConversationId !== null) {
      if (!isUuid(rawConversationId)) {
        return jsonResponse(
          { error: "invalid_request", detail: "invalid conversation_id" },
          400,
          req,
        );
      }

      conversationId = rawConversationId;

      const { data: conversation, error: conversationErr } = await supabaseAdmin
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .maybeSingle();

      if (conversationErr) {
        console.error("[kb-search-proxy] conversation lookup failed", {
          conversation_id: conversationId,
          code: conversationErr.code,
        });
        return jsonResponse(
          { error: "conversation_lookup_failed" },
          500,
          req,
        );
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

      scope = tenantResult.scope;

      const authorizedInConversationCompany = membershipResult.rows.some(
        (row) => row.company_id === scope.aiCompanyId,
      );

      if (!authorizedInConversationCompany) {
        return jsonResponse({ error: "forbidden_tenant_role" }, 403, req);
      }

      const companyActive = await requireActiveCompany(
        supabaseAdmin,
        scope.aiCompanyId,
      );
      if (companyActive === null) {
        return jsonResponse({ error: "tenant_authorization_failed" }, 500, req);
      }
      if (!companyActive) {
        return jsonResponse({ error: "forbidden_tenant" }, 403, req);
      }
    } else {
      const standalone = await resolveStandaloneScope(
        supabaseAdmin,
        membershipResult.rows,
      );
      if (!standalone.ok) {
        return jsonResponse({ error: standalone.error }, standalone.status, req);
      }
      scope = standalone.scope;
    }

    const endpointCfg = resolveKBEndpoint();
    if (!endpointCfg) {
      console.error(
        "[kb-search-proxy] KB endpoint config missing — fail closed",
      );
      return jsonResponse({ error: "kb_config_missing" }, 500, req);
    }

    const kbResult = await fetchKBRag(
      { query, top_k: topK },
      scope,
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
        console.error(
          "[kb-search-proxy] cross-document aggregation mismatch",
          {
            conversation_id: conversationId,
            company_id: scope.aiCompanyId,
            selected_document_id: selectedDocumentId,
          },
        );
        return jsonResponse({ error: "kb_contract_mismatch" }, 502, req);
      }
    }

    const policyEvidence =
      kbResult.llm_context?.full_content_evidence
        ?.filter(
          (item) =>
            typeof item.source_type === "string" &&
            item.source_type.toLowerCase().includes("policy") &&
            typeof item.content === "string" &&
            item.content.trim().length > 0,
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
        results: kbResult.citations,
        llm_context: kbResult.llm_context ?? null,
        meta: kbResult.meta ?? null,
        selected_document_id: selectedDocumentId ?? null,
        policy_evidence: policyEvidence,
      },
      200,
      req,
    );
  } catch (e) {
    console.error(
      "[kb-search-proxy] unexpected error",
      (e as Error).name,
    );
    return jsonResponse({ error: "internal_error" }, 500, req);
  }
});
