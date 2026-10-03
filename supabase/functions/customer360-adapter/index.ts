// Customer360 canonical upstream adapter — Workflow 5 / Task 5.1
// INTERNAL ONLY. No CORS. Read-only upstream fetch. No raw PII persistence.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  isC3NonproductionProject,
  resolveServerSecret,
} from "../_shared/nonproduction-secret.ts";

type MaskingLevel = "minimal";

type MinimalCustomerContext = {
  customer_ref?: string;
  tier?: string;
  language_preference?: string;
  sentiment?: string;
  sentiment_trend?: string;
  trust_score?: string;
  churn_risk?: number;
  sensitive_to?: string[];
  privacy_flags?: Record<string, boolean>;
  context_quality?: string;
  masked_summary?: string;
  predicted_csat?: number;
  escalation_score?: number;
  p1_provider_version?: string;
};

type AdapterSuccess = {
  success: true;
  source: "upstream";
  masking_level: MaskingLevel;
  customer_context: MinimalCustomerContext;
  customer_ref: string;
  customer_context_ref: string;
  customer_context_degraded: false;
  handoff_required: false;
  request_id: string;
  trusted_customer_context: {
    source: "customer360-adapter";
    company_id: string;
    conversation_id: string;
    customer_ref: string;
    request_id: string;
    source_identity: string;
    degraded: false;
    entitlements: Array<{
      name: string;
      value: string;
      scope: string;
      status: "active" | "inactive";
      valid_from: string;
      valid_until: string;
    }>;
  };
};

type AdapterFailure = {
  success: false;
  source: "fallback";
  masking_level: MaskingLevel;
  customer_context: null;
  customer_ref?: string;
  customer_context_ref: string;
  customer_context_degraded: true;
  handoff_required: boolean;
  request_id: string;
  error: {
    error_code: string;
    message_safe: string;
    retryable: boolean;
  };
};

const MASKING_LEVEL: MaskingLevel = "minimal";
const MAX_FIELDS = 20;
const MAX_RESPONSE_BYTES = 256_000;
const DEFAULT_TIMEOUT_MS = 5000;

const MINIMAL_ALLOWLIST = new Set([
  "customer_ref",
  "tier",
  "language_preference",
  "sentiment",
  "sentiment_trend",
  "trust_score",
  "churn_risk",
  "sensitive_to",
  "privacy_flags",
  "context_quality",
  "masked_summary",
  "predicted_csat",
  "escalation_score",
  "p1_provider_version",
]);

const NEVER_RETURN = new Set([
  "name",
  "email",
  "phone",
  "address",
  "payment_card",
  "payment_token",
  "raw_ip",
  "raw_device_fingerprint",
  "auth_identifiers",
  "password_hash",
  "session_token",
  "order_id",
  "orders",
  "payments",
]);

function jsonNoCors(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function requestId(): string {
  return crypto.randomUUID();
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isApprovedOpaqueCustomerRef(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const value = raw.trim();
  if (!value || value.length > 128) return false;
  if (/@/.test(value)) return false;
  const digitCount = (value.match(/\d/g) ?? []).length;
  if (/^[+()\-\s\d]+$/.test(value) && digitCount >= 6) return false;
  if (/\s/.test(value)) return false;
  if (/^#?\d+$/.test(value)) return false;
  if (/^(ord|order|inv|invoice|po)[-_]/i.test(value)) return false;
  return /^cus_[A-Za-z0-9_-]{16,64}$/.test(value) || isUuid(value);
}

function safeMessage(): string {
  return "Customer information temporarily unavailable.";
}

function failure(
  id: string,
  code: string,
  retryable: boolean,
  customerRef = "",
  status = 200,
): Response {
  const out: AdapterFailure = {
    success: false,
    source: "fallback",
    masking_level: MASKING_LEVEL,
    customer_context: null,
    ...(customerRef ? { customer_ref: customerRef } : {}),
    customer_context_ref: customerRef,
    customer_context_degraded: true,
    handoff_required: code !== "C360_IDENTITY_UNRESOLVED",
    request_id: id,
    error: {
      error_code: code,
      message_safe: safeMessage(),
      retryable,
    },
  };
  return jsonNoCors(status, out);
}

function parseTimeout(): number {
  const raw = Number.parseInt(Deno.env.get("CUSTOMER360_TIMEOUT_MS") ?? "", 10);
  return Number.isInteger(raw) && raw >= 1000 && raw <= 15000
    ? raw
    : DEFAULT_TIMEOUT_MS;
}

function selectRequestedFields(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...MINIMAL_ALLOWLIST];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    if (!MINIMAL_ALLOWLIST.has(value) || NEVER_RETURN.has(value)) continue;
    if (!out.includes(value)) out.push(value);
    if (out.length >= MAX_FIELDS) break;
  }
  return out.length ? out : [...MINIMAL_ALLOWLIST];
}

function sanitizeCustomerContext(raw: unknown): MinimalCustomerContext | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of MINIMAL_ALLOWLIST) {
    if (!(key in input) || NEVER_RETURN.has(key)) continue;
    const value = input[key];

    if (["tier", "language_preference", "sentiment", "sentiment_trend",
         "trust_score", "context_quality", "masked_summary",
         "p1_provider_version"].includes(key)) {
      if (typeof value === "string" && value.trim()) {
        out[key] = value.trim().slice(0, key === "masked_summary" ? 1000 : 200);
      }
      continue;
    }

    if (key === "predicted_csat") {
      if (typeof value === "number" && Number.isFinite(value) &&
          value >= 1 && value <= 5) {
        out[key] = value;
      }
      continue;
    }

    if (key === "churn_risk" || key === "escalation_score") {
      if (typeof value === "number" && Number.isFinite(value) &&
          value >= 0 && value <= 1) {
        out[key] = value;
      }
      continue;
    }

    if (key === "sensitive_to") {
      if (Array.isArray(value)) {
        out[key] = value
          .filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
          .slice(0, 10)
          .map((v) => v.trim().slice(0, 100));
      }
      continue;
    }

    if (key === "privacy_flags") {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const flags: Record<string, boolean> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (typeof v === "boolean" && k.length <= 64) flags[k] = v;
        }
        out[key] = flags;
      }
      continue;
    }
  }

  return out as MinimalCustomerContext;
}

function sanitizeEntitlements(raw: unknown): AdapterSuccess["trusted_customer_context"]["entitlements"] | null {
  if (!Array.isArray(raw)) return null;
  const out: AdapterSuccess["trusted_customer_context"]["entitlements"] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name.trim().slice(0, 80) : "";
    const value = typeof row.value === "string" ? row.value.trim().slice(0, 120) : "";
    const scope = typeof row.scope === "string" ? row.scope.trim().slice(0, 120) : "";
    const status = row.status;
    const validFrom = typeof row.valid_from === "string" ? row.valid_from.trim() : "";
    const validUntil = typeof row.valid_until === "string" ? row.valid_until.trim() : "";
    if (
      !name || !value || !scope || (status !== "active" && status !== "inactive") ||
      !validFrom || !validUntil || !Number.isFinite(Date.parse(validFrom)) ||
      !Number.isFinite(Date.parse(validUntil))
    ) return null;
    out.push({ name, value, scope, status, valid_from: validFrom, valid_until: validUntil });
  }
  return out;
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function writeSanitizedLog(args: {
  conversationId: string;
  companyId: string | null;
  requestId: string;
  status: number;
  latencyMs: number;
  errorCode: string | null;
}): Promise<void> {
  try {
    const sb = serviceClient();
    if (!sb) return;
    await sb.from("upstream_call_log").insert({
      conversation_id: args.conversationId,
      company_id: args.companyId,
      upstream_service: "customer360",
      request_payload: {
        request_id: args.requestId,
        operation: "read_customer_context",
      },
      response_status: args.status,
      response_latency_ms: args.latencyMs,
      error_message: args.errorCode ? "Customer360 request failed." : null,
    });
  } catch {
    // Secondary telemetry only. Never expose or override primary result.
  }
}

Deno.serve(async (req: Request) => {
  const started = Date.now();
  const id = requestId();

  if (req.method !== "POST") {
    return jsonNoCors(405, {
      success: false,
      error: { error_code: "METHOD_NOT_ALLOWED", message_safe: "Unauthorized.", retryable: false },
      request_id: id,
    });
  }

  const expectedInternalToken = await resolveServerSecret(
    "CUSTOMER360_INTERNAL_TOKEN",
    "c3_customer360_internal_token",
  );
  const presentedInternalToken = req.headers.get("X-Internal-Service-Token");
  if (!expectedInternalToken || !presentedInternalToken ||
      presentedInternalToken !== expectedInternalToken) {
    return jsonNoCors(401, {
      success: false,
      error: { error_code: "UNAUTHORIZED", message_safe: "Unauthorized.", retryable: false },
      request_id: id,
    });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return failure(id, "C360_INVALID_REQUEST", false, "", 400);
  }

  // Caller may identify ONLY the AI Chatbot conversation and requested safe
  // fields. Company, tenant, customer_ref, role and masking level are resolved
  // server-side and cannot be supplied by the caller.
  for (const forbidden of [
    "company_id",
    "tenant_id",
    "workspace_id",
    "customer_ref",
    "caller_type",
    "caller_role",
    "masking_level",
    "tier",
    "entitlement",
    "entitlements",
    "source_identity",
    "request_id",
  ]) {
    if (forbidden in body) {
      return failure(id, "C360_CALLER_SCOPE_FORBIDDEN", false, "", 400);
    }
  }

  const conversationId = body.conversation_id;
  if (!isUuid(conversationId)) {
    return failure(id, "C360_INVALID_CONVERSATION", false, "", 400);
  }

  const sb = serviceClient();
  if (!sb) return failure(id, "C360_SERVER_CONFIG_MISSING", true);

  const { data: conversation, error: convErr } = await sb
    .from("conversations")
    .select("id, company_id, visitor_session_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (convErr) {
    await writeSanitizedLog({
      conversationId,
      companyId: null,
      requestId: id,
      status: 500,
      latencyMs: Date.now() - started,
      errorCode: "C360_CONVERSATION_LOOKUP_FAILED",
    });
    return failure(id, "C360_CONVERSATION_LOOKUP_FAILED", true);
  }

  if (!conversation?.company_id || !conversation.visitor_session_id) {
    return failure(id, "C360_IDENTITY_UNRESOLVED", false);
  }

  const companyId = String(conversation.company_id);
  const { data: company, error: companyErr } = await sb
    .from("company")
    .select("id, is_active")
    .eq("id", companyId)
    .maybeSingle();

  if (companyErr || !company || company.is_active !== true) {
    return failure(id, "C360_COMPANY_UNRESOLVED", false);
  }

  const { data: visitor, error: visitorErr } = await sb
    .from("visitor_session")
    .select("id, visitor_metadata")
    .eq("id", conversation.visitor_session_id)
    .maybeSingle();

  if (visitorErr || !visitor) {
    return failure(id, "C360_IDENTITY_UNRESOLVED", false);
  }

  const metadata =
    visitor.visitor_metadata &&
    typeof visitor.visitor_metadata === "object" &&
    !Array.isArray(visitor.visitor_metadata)
      ? visitor.visitor_metadata as Record<string, unknown>
      : {};

  const customerRefRaw = metadata.customer_ref;
  if (!isApprovedOpaqueCustomerRef(customerRefRaw)) {
    await writeSanitizedLog({
      conversationId,
      companyId,
      requestId: id,
      status: 422,
      latencyMs: Date.now() - started,
      errorCode: "C360_IDENTITY_UNRESOLVED",
    });
    return failure(id, "C360_IDENTITY_UNRESOLVED", false);
  }
  const customerRef = customerRefRaw.trim();

  const nonproduction = isC3NonproductionProject();
  const enabled = nonproduction ||
    (Deno.env.get("ENABLE_CUSTOMER360_ADAPTER") ?? "false").toLowerCase() === "true";
  const projectUrl = Deno.env.get("SUPABASE_URL")?.trim().replace(/\/+$/, "");
  const upstreamUrl = nonproduction && projectUrl
    ? `${projectUrl}/functions/v1/customer360-nonproduction-upstream`
    : Deno.env.get("CUSTOMER360_API_URL")?.trim();
  const upstreamToken = await resolveServerSecret(
    "CUSTOMER360_API_TOKEN",
    "c3_customer360_upstream_token",
  );

  if (!enabled || !upstreamUrl || !upstreamToken) {
    await writeSanitizedLog({
      conversationId,
      companyId,
      requestId: id,
      status: 503,
      latencyMs: Date.now() - started,
      errorCode: "C360_CONFIG_MISSING",
    });
    return failure(id, "C360_CONFIG_MISSING", true, customerRef);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(upstreamUrl);
    const local = parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1";
    if (parsedUrl.protocol !== "https:" && !local) {
      return failure(id, "C360_CONFIG_INVALID", false, customerRef);
    }
  } catch {
    return failure(id, "C360_CONFIG_INVALID", false, customerRef);
  }

  const fieldsRequested = selectRequestedFields(body.fields_requested);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), parseTimeout());

  let response: Response;
  try {
    response = await fetch(parsedUrl.toString(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${upstreamToken}`,
        "Content-Type": "application/json",
        "X-AI-Company-ID": companyId,
        "X-Request-ID": id,
        "X-Source-Identity": nonproduction
          ? "ai-chatbot-c3-nonproduction"
          : "ai-chatbot-customer360-adapter",
      },
      body: JSON.stringify({
        operation: "read_customer_context",
        conversation_id: conversationId,
        customer_ref: customerRef,
        fields_requested: fieldsRequested,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const code =
      error instanceof DOMException && error.name === "AbortError"
        ? "C360_TIMEOUT"
        : "C360_UPSTREAM_UNREACHABLE";
    await writeSanitizedLog({
      conversationId,
      companyId,
      requestId: id,
      status: code === "C360_TIMEOUT" ? 504 : 502,
      latencyMs: Date.now() - started,
      errorCode: code,
    });
    return failure(id, code, true, customerRef);
  }
  clearTimeout(timeout);

  if (!response.ok) {
    const status = response.status;
    await writeSanitizedLog({
      conversationId,
      companyId,
      requestId: id,
      status,
      latencyMs: Date.now() - started,
      errorCode: "C360_UPSTREAM_NON_2XX",
    });
    return failure(
      id,
      "C360_UPSTREAM_NON_2XX",
      status === 429 || status >= 500,
      customerRef,
    );
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    return failure(id, "C360_RESPONSE_TOO_LARGE", false, customerRef);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return failure(id, "C360_RESPONSE_INVALID_JSON", false, customerRef);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return failure(id, "C360_RESPONSE_SCHEMA_INVALID", false, customerRef);
  }

  const upstream = raw as Record<string, unknown>;
  if (upstream.success !== true) {
    return failure(id, "C360_UPSTREAM_REJECTED", false, customerRef);
  }

  if (
    typeof upstream.customer_ref !== "string" ||
    upstream.customer_ref.trim() !== customerRef
  ) {
    return failure(id, "C360_CUSTOMER_IDENTITY_MISMATCH", false, customerRef);
  }

  if (
    String(upstream.company_id ?? upstream.ai_company_id ?? "") !== companyId ||
    String(upstream.conversation_id ?? "") !== conversationId ||
    String(upstream.request_id ?? "") !== id ||
    typeof upstream.source_identity !== "string" ||
    !upstream.source_identity.trim() ||
    (nonproduction && upstream.source_identity.trim() !== "c3-customer360-db-v1")
  ) {
    return failure(id, "C360_TRUST_ENVELOPE_MISMATCH", false, customerRef);
  }

  const entitlements = sanitizeEntitlements(upstream.entitlements);
  if (!entitlements) {
    return failure(id, "C360_ENTITLEMENT_SCHEMA_INVALID", false, customerRef);
  }

  if (
    upstream.ai_company_id !== undefined &&
    String(upstream.ai_company_id) !== companyId
  ) {
    return failure(id, "C360_TENANT_IDENTITY_MISMATCH", false, customerRef);
  }

  const context = sanitizeCustomerContext(upstream.customer_context);
  if (!context) {
    return failure(id, "C360_RESPONSE_SCHEMA_INVALID", false, customerRef);
  }

  context.customer_ref = customerRef;

  await writeSanitizedLog({
    conversationId,
    companyId,
    requestId: id,
    status: 200,
    latencyMs: Date.now() - started,
    errorCode: null,
  });

  const out: AdapterSuccess = {
    success: true,
    source: "upstream",
    masking_level: MASKING_LEVEL,
    customer_context: context,
    customer_ref: customerRef,
    customer_context_ref: customerRef,
    customer_context_degraded: false,
    handoff_required: false,
    request_id: id,
    trusted_customer_context: {
      source: "customer360-adapter",
      company_id: companyId,
      conversation_id: conversationId,
      customer_ref: customerRef,
      request_id: id,
      source_identity: upstream.source_identity.trim().slice(0, 160),
      degraded: false,
      entitlements,
    },
  };
  return jsonNoCors(200, out);
});
