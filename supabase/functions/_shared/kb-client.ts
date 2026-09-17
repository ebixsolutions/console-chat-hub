// supabase/functions/_shared/kb-client.ts
// Canonical Singapore KB adapter + secure pre-activation scope.
//
// Security invariants:
// - Canonical AI Chatbot company identity always wins locally.
// - A server-side mapping resolves that UUID to Singapore company/tenant identity.
// - Browser request bodies never select company/tenant/key scope.
// - Singapore RAG company_id is emitted only from the trusted server mapping.
// - Pre-activation never fabricates AI Chatbot company_id.
// - Opaque credentials never leave the server.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { getSupabaseAdminKey } from "./supabase-admin-key.ts";
import {
  type KBAuthHeaderMode,
  resolveSingaporeCredential,
  singaporeCredentialHeaders,
} from "./kb-auth.ts";
import {
  type AggregationAuthorityMetadata,
  type AggregationDocumentCandidate,
  parseAggregationResponse,
} from "./kb-aggregation-response.ts";
import { isC3NonproductionProject } from "./nonproduction-secret.ts";

export interface KBQueryInput {
  query: string;
  top_k: number;
}
export type KBScopeMode = "canonical" | "pre_activation" | "demo";
export interface KBResolvedScope {
  mode: KBScopeMode;
  aiCompanyId: string | null;
  singaporeTenantId: string;
}
export interface KBFullChunk {
  document_id: string;
  doc_id?: string;
  chunk_id?: string;
  title?: string;
  content: string;
  score: number;
  chunk_type: "rag_summary" | "full_content" | "faq_pair" | "section";
  source_type: string;
  status: "published" | "historical" | "superseded" | "cancelled" | "draft";
}
export interface KBCitationChunk {
  display_label: string;
  content: string;
  score: number;
  source_type: string;
  document_id?: string;
  chunk_id?: string;
  chunk_type?: string;
}
export interface KBLLMContextEvidence {
  document_id: string;
  chunk_id?: string;
  content: string;
  score: number;
  source_type: string;
}
export interface KBLLMContext {
  selected_document_id: string;
  orientation_summary: string | null;
  full_content_evidence: KBLLMContextEvidence[];
}
export interface KBRagMeta {
  document_score: number;
  highest_chunk_score: number;
  second_highest_chunk_score: number;
  returned_summary_count: number;
  returned_full_content_count: number;
  dropped_without_document_id: number;
  dropped_without_content: number;
}
export interface KBDocumentCandidate {
  document_id: string;
  title: string;
  source_type: string;
  document_score: number;
  chunks: KBFullChunk[];
  citations: KBCitationChunk[];
  llm_context: KBLLMContext;
  meta: KBRagMeta;
  // Optional for backward-compatible in-process callers and old fixtures. The
  // Singapore aggregation parser always supplies this object.
  authority?: AggregationAuthorityMetadata;
}
export interface KBRagResponse {
  success: boolean;
  chunks: KBFullChunk[];
  citations: KBCitationChunk[];
  documents: KBDocumentCandidate[];
  // Backward-compatible single-document fields are populated only when the
  // producer returned exactly one candidate. New callers must use documents[].
  llm_context?: KBLLMContext;
  meta?: KBRagMeta;
  selected_document_id?: string;
  dropped_without_document_id?: number;
  dropped_without_content?: number;
  error_code?: string;
}
export interface KBEndpointConfig {
  baseUrl: string;
  ragUrl: string;
  signingSecret?: string;
  jwtTtlSec: number;
  defaultToken?: string;
  tenantTokens: Record<string, string>;
  tenantApiKeys: Record<string, string>;
  apiKeyHeaderMode: KBAuthHeaderMode;
  localProjectAuth?: boolean;
}
export interface KBPreActivationActor {
  userId: string;
  allowPreActivation: true;
}

const SINGAPORE_KB_DEFAULT_BASE_URL =
  "https://py.ebixmall.com/py-knowledge-base";
const SINGAPORE_RAG_PATH = "/api/v1/rag/context-search";
const KB_DEFAULT_TIMEOUT_MS = 12000;
const KB_MAX_DOCUMENT_CANDIDATES = 5;
const PREACTIVATION_ROLES = new Set(["admin", "supervisor"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type QueryDbClient = { from: (relation: string) => any };

function normalizeBaseUrl(
  raw: string,
): { baseUrl: string; ragUrl: string } | null {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) return null;
  try {
    const url = new URL(value);
    const isLocal = url.hostname === "localhost" ||
      url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !isLocal) return null;
  } catch {
    return null;
  }
  return value.endsWith(SINGAPORE_RAG_PATH)
    ? { baseUrl: value.slice(0, -SINGAPORE_RAG_PATH.length), ragUrl: value }
    : { baseUrl: value, ragUrl: `${value}${SINGAPORE_RAG_PATH}` };
}

export function parseStringMap(
  raw: string | undefined | null,
): Record<string, string> | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const out: Record<string, string> = {};
    for (
      const [key, value] of Object.entries(parsed as Record<string, unknown>)
    ) {
      if (typeof value !== "string" || !key.trim() || !value.trim()) {
        return null;
      }
      out[key.trim()] = value.trim();
    }
    return out;
  } catch {
    return null;
  }
}

export function resolveKBEndpoint(): KBEndpointConfig | null {
  if (isC3NonproductionProject()) {
    const projectUrl = Deno.env.get("SUPABASE_URL")?.trim().replace(/\/+$/, "");
    const normalized = projectUrl
      ? normalizeBaseUrl(`${projectUrl}/functions/v1/kb-nonproduction-runtime`)
      : null;
    if (!normalized) return null;
    return {
      ...normalized,
      jwtTtlSec: 300,
      tenantTokens: {},
      tenantApiKeys: {},
      apiKeyHeaderMode: "authorization",
      localProjectAuth: true,
    };
  }
  const configured = Deno.env.get("KB_SINGAPORE_BASE_URL") ??
    Deno.env.get("KB_RAG_ENDPOINT") ??
    Deno.env.get("KB_RAG_BASE_URL") ??
    SINGAPORE_KB_DEFAULT_BASE_URL;
  const normalized = normalizeBaseUrl(configured);
  if (!normalized) return null;

  const tenantTokens = parseStringMap(
    Deno.env.get("KB_RAG_TENANT_TOKENS_JSON"),
  );
  const tenantApiKeys = parseStringMap(
    Deno.env.get("KB_SINGAPORE_TENANT_API_KEYS_JSON"),
  );
  if (tenantTokens === null || tenantApiKeys === null) return null;

  const headerRaw = (Deno.env.get("KB_SINGAPORE_API_KEY_HEADER") ?? "x-api-key")
    .trim().toLowerCase();
  if (headerRaw !== "authorization" && headerRaw !== "x-api-key") return null;

  const ttlRaw = Number.parseInt(
    Deno.env.get("KB_SINGAPORE_JWT_TTL_SEC") ?? "300",
    10,
  );
  return {
    ...normalized,
    signingSecret: Deno.env.get("KB_SINGAPORE_JWT_SECRET")?.trim() || undefined,
    jwtTtlSec: Number.isInteger(ttlRaw) && ttlRaw >= 60 && ttlRaw <= 900
      ? ttlRaw
      : 300,
    defaultToken: Deno.env.get("KB_RAG_TOKEN")?.trim() || undefined,
    tenantTokens,
    tenantApiKeys,
    apiKeyHeaderMode: headerRaw as KBAuthHeaderMode,
  };
}

export type TenantResolutionReason =
  | "KB_DB_CONFIG_MISSING"
  | "KB_CONVERSATION_LOOKUP_FAILED"
  | "KB_CONVERSATION_NOT_FOUND"
  | "KB_TENANT_MAPPING_CONFIG_INVALID"
  | "KB_TENANT_MAPPING_UNRESOLVED"
  | "KB_TENANT_IDENTITY_CONFLICT"
  | "KB_DEMO_DISABLED"
  | "KB_DEMO_CONFIG_MISSING"
  | "KB_PREACTIVATION_DISABLED"
  | "KB_PREACTIVATION_CONFIG_MISSING"
  | "KB_PREACTIVATION_MEMBERSHIP_PRESENT"
  | "KB_PREACTIVATION_ROLE_LOOKUP_FAILED"
  | "KB_PREACTIVATION_ROLE_FORBIDDEN";

export type TenantResolutionResult =
  | { resolved: true; scope: KBResolvedScope }
  | { resolved: false; reason: TenantResolutionReason };

function trustedWidgetLiveTestActor(
  metadataSource: unknown,
): KBPreActivationActor | undefined {
  if (
    !metadataSource || typeof metadataSource !== "object" ||
    Array.isArray(metadataSource)
  ) return;
  const m = metadataSource as Record<string, unknown>;
  const owner = typeof m.owner_user_id === "string" ? m.owner_user_id : "";
  if (
    m.source !== "widget_live_test" || m.widget_live_test !== true ||
    m.exclude_training !== true || !UUID_RE.test(owner)
  ) return;
  return { userId: owner, allowPreActivation: true };
}

async function resolvePreActivationScope(
  sb: QueryDbClient,
  actor: KBPreActivationActor | undefined,
): Promise<TenantResolutionResult> {
  if (!actor?.allowPreActivation) {
    return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
  }
  if (Deno.env.get("KB_PREACTIVATION_ENABLED") !== "true") {
    return { resolved: false, reason: "KB_PREACTIVATION_DISABLED" };
  }
  const tenantId = Deno.env.get("KB_PREACTIVATION_TENANT_ID")?.trim();
  if (!tenantId) {
    return { resolved: false, reason: "KB_PREACTIVATION_CONFIG_MISSING" };
  }

  const { data: memberships, error: membershipError } = await sb
    .from("company_membership").select("company_id, is_active").eq(
      "user_id",
      actor.userId,
    );
  if (membershipError) {
    return { resolved: false, reason: "KB_PREACTIVATION_ROLE_LOOKUP_FAILED" };
  }
  if ((memberships ?? []).length > 0) {
    return { resolved: false, reason: "KB_PREACTIVATION_MEMBERSHIP_PRESENT" };
  }

  const { data: roles, error: roleError } = await sb
    .from("user_roles").select("role").eq("user_id", actor.userId);
  if (roleError) {
    return { resolved: false, reason: "KB_PREACTIVATION_ROLE_LOOKUP_FAILED" };
  }
  const allowed = (roles ?? []).some((row: { role?: unknown }) =>
    PREACTIVATION_ROLES.has(String(row.role ?? ""))
  );
  if (!allowed) {
    return { resolved: false, reason: "KB_PREACTIVATION_ROLE_FORBIDDEN" };
  }

  return {
    resolved: true,
    scope: {
      mode: "pre_activation",
      aiCompanyId: null,
      singaporeTenantId: tenantId,
    },
  };
}

export async function resolveTenantScope(
  conversationId: string | null,
  actor?: KBPreActivationActor,
): Promise<TenantResolutionResult> {
  if (conversationId) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    let serviceRoleKey = "";
    try {
      serviceRoleKey = getSupabaseAdminKey();
    } catch {
      serviceRoleKey = "";
    }
    if (!supabaseUrl || !serviceRoleKey) {
      return { resolved: false, reason: "KB_DB_CONFIG_MISSING" };
    }
    const sb = createClient(supabaseUrl, serviceRoleKey);
    const { data: conv, error: convErr } = await sb
      .from("conversations")
      .select("company_id, channel_config_id, metadata_source")
      .eq("id", conversationId).maybeSingle();
    if (convErr) {
      return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    }
    if (!conv) return { resolved: false, reason: "KB_CONVERSATION_NOT_FOUND" };

    let channelCompanyId: string | null = null;
    if (conv.channel_config_id) {
      const { data: channel, error: channelErr } = await sb
        .from("channel_config").select("company_id").eq(
          "id",
          conv.channel_config_id,
        ).maybeSingle();
      if (channelErr) {
        return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
      }
      channelCompanyId = channel?.company_id
        ? String(channel.company_id)
        : null;
    }

    const conversationCompanyId = conv.company_id
      ? String(conv.company_id)
      : null;
    if (
      conversationCompanyId && channelCompanyId &&
      conversationCompanyId !== channelCompanyId
    ) {
      return { resolved: false, reason: "KB_TENANT_IDENTITY_CONFLICT" };
    }
    const resolvedCompanyId = conversationCompanyId ?? channelCompanyId;
    if (!resolvedCompanyId) {
      const trustedActor = actor ??
        trustedWidgetLiveTestActor(conv.metadata_source);
      return await resolvePreActivationScope(sb, trustedActor);
    }

    const { data: company, error: companyErr } = await sb
      .from("company").select("id, is_active").eq("id", resolvedCompanyId)
      .maybeSingle();
    if (companyErr) {
      return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
    }
    if (!company || company.is_active !== true) {
      return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    }

    let singaporeTenantId: string | undefined;
    if (isC3NonproductionProject()) {
      const { data: tenant, error: tenantError } = await sb
        .from("c3_nonprod_kb_tenant")
        .select("external_tenant_id,is_active")
        .eq("company_id", String(company.id))
        .maybeSingle();
      if (tenantError) {
        return { resolved: false, reason: "KB_CONVERSATION_LOOKUP_FAILED" };
      }
      singaporeTenantId = tenant?.is_active === true
        ? String(tenant.external_tenant_id ?? "").trim()
        : undefined;
    } else {
      const tenantMap = parseStringMap(
        Deno.env.get("KB_SINGAPORE_TENANT_MAP_JSON"),
      );
      if (tenantMap === null) {
        return { resolved: false, reason: "KB_TENANT_MAPPING_CONFIG_INVALID" };
      }
      singaporeTenantId = tenantMap[String(company.id)]?.trim();
    }
    if (!singaporeTenantId) {
      return { resolved: false, reason: "KB_TENANT_MAPPING_UNRESOLVED" };
    }
    return {
      resolved: true,
      scope: {
        mode: "canonical",
        aiCompanyId: String(company.id),
        singaporeTenantId,
      },
    };
  }

  if (Deno.env.get("KB_DEMO_MODE") !== "true") {
    return { resolved: false, reason: "KB_DEMO_DISABLED" };
  }
  const tenantId = Deno.env.get("KB_DEMO_TENANT_ID")?.trim();
  if (!tenantId) return { resolved: false, reason: "KB_DEMO_CONFIG_MISSING" };
  return {
    resolved: true,
    scope: { mode: "demo", aiCompanyId: null, singaporeTenantId: tenantId },
  };
}

export function singaporeCompanyIdFromScope(
  scope: KBResolvedScope,
): number | null {
  if (!/^[1-9]\d*$/.test(scope.singaporeTenantId)) return null;
  const n = Number(scope.singaporeTenantId);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function mapDocumentCandidate(
  candidate: AggregationDocumentCandidate,
): KBDocumentCandidate {
  const authorityStatus = candidate.authority.publication_state?.toLowerCase();
  const authorityCurrentness = candidate.authority.currentness;
  const chunkStatus: KBFullChunk["status"] =
    authorityStatus === "draft" || authorityStatus === "unpublished"
      ? "draft"
      : authorityCurrentness === "historical" ||
          authorityCurrentness === "superseded" ||
          authorityCurrentness === "cancelled"
      ? authorityCurrentness
      : "published";
  return {
    document_id: candidate.document_id,
    title: candidate.title,
    source_type: candidate.source_type,
    document_score: candidate.document_score,
    chunks: candidate.chunks.map((c) => ({
      document_id: c.document_id,
      doc_id: c.document_id,
      ...(c.chunk_id ? { chunk_id: c.chunk_id } : {}),
      title: c.title,
      content: c.content,
      score: c.score,
      chunk_type: c.chunk_type,
      source_type: c.source_type,
      status: chunkStatus,
    })),
    citations: candidate.citations,
    llm_context: candidate.llm_context,
    meta: candidate.meta,
    authority: candidate.authority,
  };
}

export async function fetchKBRag(
  queryInput: KBQueryInput,
  scope: KBResolvedScope,
  endpointCfg: KBEndpointConfig,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<KBRagResponse> {
  const query = queryInput.query.trim();
  if (!query) {
    return { success: true, chunks: [], citations: [], documents: [] };
  }

  const companyId = singaporeCompanyIdFromScope(scope);
  if (companyId === null) {
    return {
      success: false,
      chunks: [],
      citations: [],
      documents: [],
      error_code: "KB_COMPANY_ID_INVALID",
    };
  }

  const credential = endpointCfg.localProjectAuth
    ? { ok: true as const, kind: "bearer" as const, value: getSupabaseAdminKey() }
    : await resolveSingaporeCredential(scope, endpointCfg);
  if (!credential.ok) {
    return {
      success: false,
      chunks: [],
      citations: [],
      documents: [],
      error_code: credential.error_code,
    };
  }

  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(opts?.signal?.reason);
  if (opts?.signal?.aborted) abortFromRequest();
  else {opts?.signal?.addEventListener("abort", abortFromRequest, {
      once: true,
    });}
  const timeout = setTimeout(
    () => controller.abort(),
    opts?.timeoutMs ?? KB_DEFAULT_TIMEOUT_MS,
  );
  let response: Response;
  try {
    response = await fetch(endpointCfg.ragUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...singaporeCredentialHeaders(credential, endpointCfg),
      },
      body: JSON.stringify({
        query,
        company_id: companyId,
        candidate_top_k: Math.max(queryInput.top_k, 10),
        max_documents: KB_MAX_DOCUMENT_CANDIDATES,
        max_summary_chunks: 1,
        max_full_content_chunks: 3,
        score_threshold: 0.05,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    opts?.signal?.removeEventListener("abort", abortFromRequest);
    return {
      success: false,
      chunks: [],
      citations: [],
      documents: [],
      error_code: err instanceof DOMException && err.name === "AbortError"
        ? "KB_TIMEOUT"
        : "KB_FETCH_ERROR",
    };
  }

  clearTimeout(timeout);
  opts?.signal?.removeEventListener("abort", abortFromRequest);
  if (!response.ok) {
    return {
      success: false,
      chunks: [],
      citations: [],
      documents: [],
      error_code: `KB_HTTP_${response.status}`,
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {
      success: false,
      chunks: [],
      citations: [],
      documents: [],
      error_code: "KB_INVALID_JSON",
    };
  }

  const parsed = parseAggregationResponse(data);
  if (!parsed.ok) {
    return {
      success: false,
      chunks: [],
      citations: [],
      documents: [],
      error_code: parsed.error_code,
    };
  }
  if (!parsed.contextFound) {
    return { success: true, chunks: [], citations: [], documents: [] };
  }

  const documents = parsed.documents.map(mapDocumentCandidate);
  const single = documents.length === 1 ? documents[0] : undefined;
  return {
    success: true,
    chunks: documents.flatMap((d) => d.chunks),
    citations: documents.flatMap((d) => d.citations),
    documents,
    ...(single
      ? {
        llm_context: single.llm_context,
        meta: single.meta,
        selected_document_id: single.document_id,
      }
      : {}),
    dropped_without_document_id: 0,
    dropped_without_content: 0,
  };
}
