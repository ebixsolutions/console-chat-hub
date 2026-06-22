// ============================================================================
// C3 Customer360 Adapter — L4c Gate A (shell only)
// Source of truth: Contract 06 v1.1 FROZEN + Contract 03 §4.1 + Contract 08 F-04/F-05
//
// HARD CONSTRAINTS enforced in this file:
//  - INTERNAL-ONLY. Fail-closed unless X-Internal-Service-Token matches
//    Supabase secret CUSTOMER360_INTERNAL_TOKEN. No CORS. Browser/widget/console
//    direct calls return 401.
//  - No customer profile / PII / order / payment data is persisted by this
//    adapter. upstream_call_log writes contain only sanitized metadata
//    (request_id, latency, status, generic error_code). No PII in error_message.
//  - No conversations.customer_ref write in Gate A.
//  - No final_prompt_trace write in Gate A (only conceptual mapping in comments).
//  - No new tables / columns / enums / migrations.
//  - caller_type / caller_role / masking_level from request body are stripped
//    before processing and never logged, echoed, or used for any decision.
//    masking_level is server-side derived ONLY (internal token → system_auto).
//  - customer_ref must match an approved opaque format. Email / phone / address /
//    order_id-like values are REJECTED (never hashed-and-stored as customer_ref).
//  - Missing CUSTOMER360_API_URL / TOKEN → safe degraded response. No fetch.
//    No env / secret names in any client-facing message or log.
//  - NEVER-RETURN fields (payment card/token, raw IP, device fingerprint,
//    auth identifiers) are filtered before any response.
//  - ENABLE_CUSTOMER360_ADAPTER feature flag default false; no in-app callers.
//  - No hardcoded upstream URLs. URL solely from Deno.env.get.
// ============================================================================

// deno-lint-ignore-file no-explicit-any
// @ts-nocheck — runs in Deno/Edge runtime; types resolved at deploy

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface Customer360AdapterInput {
  customer_ref: string;
  workspace_id: string;
  tenant_id: string;
  conversation_id: string;
  fields_requested?: string[];
  // Any caller_type / caller_role / masking_level keys in body are STRIPPED.
}

type MaskingLevel = "minimal" | "masked" | "full";

interface Customer360AdapterOutput {
  success: boolean;
  source: "upstream" | "fallback";
  masking_level: MaskingLevel;
  customer_context: null; // Gate A: always null (no upstream, no mock data)
  handoff_required: boolean;
  customer_context_degraded: boolean;
  customer_context_ref: string;
  request_id: string;
  error?: {
    error_code: string;
    message_safe: string;
    retryable: boolean;
  };
}

// ----------------------------------------------------------------------------
// Allowlists (reference, Gate B/C enforcement)
// ----------------------------------------------------------------------------

const MASKING_ALLOWLIST: Record<MaskingLevel, readonly string[]> = {
  minimal: [
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
  ],
  masked: [
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
    "masked_name",
    "masked_email",
    "masked_phone",
    "tier_since",
    "masked_order_summary",
    "preferences_sanitized",
    "past_complaints_sanitized",
    "emotion_stage",
    "follow_up_plan_sanitized",
  ],
  full: [
    // Gate B/C only — enumerated by Contract 06 §2
  ],
} as const;

// NEVER returned to any caller at any masking level (incl. admin/supervisor)
const NEVER_RETURN: readonly string[] = [
  "payment_card",
  "payment_token",
  "raw_ip",
  "raw_device_fingerprint",
  "auth_identifiers",
  "password_hash",
  "session_token",
];

// Request-body keys that must be stripped before processing
const CALLER_BODY_KEYS_FORBIDDEN: readonly string[] = [
  "caller_type",
  "caller_role",
  "masking_level",
];

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function jsonNoCors(status: number, body: unknown): Response {
  // Intentionally NO Access-Control-Allow-Origin. POST-only, internal-only.
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function newRequestId(): string {
  return (globalThis.crypto?.randomUUID?.() ??
    `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * customer_ref opaque validation (Blocker 4).
 * Reject anything that looks like email/phone/address/order_id/raw external ID.
 * Only allow an approved opaque format:
 *   - "cus_" + 16..64 url-safe chars, OR
 *   - bare uuid
 * Rejected values are NEVER hashed-and-stored as conversations.customer_ref.
 */
function isApprovedOpaqueCustomerRef(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const v = raw.trim();
  if (v.length === 0 || v.length > 128) return false;

  // Reject email-like
  if (/@/.test(v)) return false;
  // Reject phone-like (digits / + / spaces / dashes / parens, mostly digits)
  const digitCount = (v.match(/\d/g) ?? []).length;
  if (/^[+()\-\s\d]+$/.test(v) && digitCount >= 6) return false;
  // Reject address-like (whitespace inside, or street keywords)
  if (/\s/.test(v)) return false;
  if (/\b(street|st|road|rd|ave|avenue|lane|blvd|floor|room|district)\b/i.test(v)) {
    return false;
  }
  // Reject order_id-like (e.g. "ORD-1234", "#12345", "order_...")
  if (/^#?\d+$/.test(v)) return false;
  if (/^(ord|order|inv|invoice|po)[-_]/i.test(v)) return false;

  // Approved opaque forms
  if (/^cus_[A-Za-z0-9_-]{16,64}$/.test(v)) return true;
  if (isUuid(v)) return true;

  return false;
}

/**
 * Strip the forbidden caller-* keys from request body BEFORE processing.
 * Stripped keys are not logged, not echoed, not used for any decision.
 */
function stripForbiddenCallerKeys(body: Record<string, unknown>): {
  cleaned: Record<string, unknown>;
  stripped: boolean;
} {
  let stripped = false;
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (CALLER_BODY_KEYS_FORBIDDEN.includes(k)) {
      stripped = true;
      continue;
    }
    cleaned[k] = v;
  }
  return { cleaned, stripped };
}

/** Intersect requested fields with masking allowlist; drop unknown silently. */
function filterFieldsRequested(
  fields: unknown,
  level: MaskingLevel,
): string[] {
  if (!Array.isArray(fields)) return [];
  const allow = new Set(MASKING_ALLOWLIST[level]);
  const out: string[] = [];
  for (const f of fields) {
    if (typeof f !== "string") continue;
    if (NEVER_RETURN.includes(f)) continue;
    if (allow.has(f)) out.push(f);
  }
  return out;
}

/**
 * Strip NEVER_RETURN + privileged keys from any object before returning to caller.
 * (Defense-in-depth: nothing in Gate A produces such an object, but the
 * function is the single output choke point for Gate B/C reuse.)
 */
function applyNeverReturnFilter<T extends Record<string, unknown> | null>(
  ctx: T,
): T {
  if (!ctx) return ctx;
  for (const k of NEVER_RETURN) {
    if (k in (ctx as Record<string, unknown>)) {
      delete (ctx as Record<string, unknown>)[k];
    }
  }
  return ctx;
}

function safeErrorMessage(_code: string): string {
  // Single generic phrase. No env names, no secret names, no stack info.
  return "Customer information temporarily unavailable.";
}

function getServiceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * upstream_call_log write — sanitized metadata ONLY.
 * Existing columns only (no new enum / no schema change). No PII. No customer_ref.
 */
async function writeUpstreamLog(params: {
  conversation_id: string | null;
  request_id: string;
  status: number;
  latency_ms: number;
  error_code: string | null;
}): Promise<void> {
  try {
    const sb = getServiceClient();
    if (!sb) return;
    if (!isUuid(params.conversation_id)) {
      // upstream_call_log.conversation_id is uuid; skip when not a real uuid
      // (e.g. unauthorized calls have no conversation context).
      return;
    }
    await sb.from("upstream_call_log").insert({
      conversation_id: params.conversation_id,
      upstream_service: "customer360",
      // request_payload: sanitized metadata only — NO PII, NO customer_ref,
      // NO fields_requested raw values.
      request_payload: {
        request_id: params.request_id,
        ts: new Date().toISOString(),
      },
      response_status: params.status,
      response_latency_ms: params.latency_ms,
      error_message: params.error_code
        ? safeErrorMessage(params.error_code)
        : null,
    });
  } catch {
    // best-effort; never throw to caller
  }
}

// ============================================================================
// CONCEPTUAL — Gate B/C ONLY. NOT executed in Gate A.
//
// final_prompt_trace mapping (when L5/B7 integrates this adapter):
//   {
//     // customer_context_ref: <opaque customer_ref> (NEVER raw email/phone/order_id)
//     // masking_level: 'minimal' | 'masked' | 'full'
//     // customer_context_degraded: boolean
//     // request_id: <link to upstream_call_log.request_payload.request_id>
//     // ❌ NEVER store: full customer_context JSON / name / email / phone /
//     //                 address / order details / payment data
//   }
//
// LLM redaction rule (L5 scope, NOT wired here):
//   - customer_ref / order_id → replace with [CUSTOMER_REF] / [ORDER_ID]
//   - trust_score / churn_risk → tone hints only, never numeric in prompt
//   - full PII → never in prompt, even for admin callers
// ============================================================================

// ----------------------------------------------------------------------------
// Handler
// ----------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const startedAt = Date.now();
  const requestId = newRequestId();

  // Method gate — POST only. No OPTIONS handler (no CORS).
  if (req.method !== "POST") {
    return jsonNoCors(405, {
      success: false,
      error: {
        error_code: "METHOD_NOT_ALLOWED",
        message_safe: safeErrorMessage("METHOD_NOT_ALLOWED"),
        retryable: false,
      },
      request_id: requestId,
    });
  }

  // ── Fail-closed internal auth ──────────────────────────────────────────────
  const presentedToken = req.headers.get("X-Internal-Service-Token");
  const expectedToken = Deno.env.get("CUSTOMER360_INTERNAL_TOKEN");
  if (!expectedToken || !presentedToken || presentedToken !== expectedToken) {
    // No business-table writes on unauthorized.
    // Log only sanitized metadata; no IP, no headers, no body, no PII.
    console.warn(
      JSON.stringify({
        request_id: requestId,
        ts: new Date().toISOString(),
        reason: "unauthorized_internal_adapter_call",
      }),
    );
    return jsonNoCors(401, {
      success: false,
      error: {
        error_code: "UNAUTHORIZED",
        message_safe: "Unauthorized.",
        retryable: false,
      },
      request_id: requestId,
    });
  }

  // ── Parse + strip forbidden caller-* keys BEFORE any processing ────────────
  let rawBody: Record<string, unknown> = {};
  try {
    rawBody = (await req.json()) as Record<string, unknown>;
    if (!rawBody || typeof rawBody !== "object") rawBody = {};
  } catch {
    rawBody = {};
  }
  const { cleaned: body } = stripForbiddenCallerKeys(rawBody);

  // ── Server-side derive masking_level ────────────────────────────────────────
  // Internal token caller → system_auto = "minimal".
  // Authenticated agent session would be resolved here in Gate B/C and may
  // promote to "masked" / "full" based on current_agent().role server-side.
  // body.masking_level is NEVER consulted.
  const maskingLevel: MaskingLevel = "minimal";

  const conversationId = typeof body.conversation_id === "string"
    ? body.conversation_id
    : null;

  // ── Validate customer_ref against approved opaque format ──────────────────
  const customerRefRaw = (body as Customer360AdapterInput).customer_ref;
  if (!isApprovedOpaqueCustomerRef(customerRefRaw)) {
    // Reject. Do NOT hash and store. Do NOT write conversations.customer_ref.
    await writeUpstreamLog({
      conversation_id: conversationId,
      request_id: requestId,
      status: 400,
      latency_ms: Date.now() - startedAt,
      error_code: "C360_INVALID_CUSTOMER_REF",
    });
    const out: Customer360AdapterOutput = {
      success: false,
      source: "fallback",
      masking_level: maskingLevel,
      customer_context: null,
      handoff_required: true,
      customer_context_degraded: true,
      customer_context_ref: "",
      request_id: requestId,
      error: {
        error_code: "C360_INVALID_CUSTOMER_REF",
        message_safe: safeErrorMessage("C360_INVALID_CUSTOMER_REF"),
        retryable: false,
      },
    };
    return jsonNoCors(400, out);
  }
  const customerRef = (customerRefRaw as string).trim();

  // Validate fields_requested against allowlist (raw value never logged/echoed).
  const _allowedFields = filterFieldsRequested(
    (body as Customer360AdapterInput).fields_requested,
    maskingLevel,
  );

  // ── Feature flag short-circuit ─────────────────────────────────────────────
  const enabled = (Deno.env.get("ENABLE_CUSTOMER360_ADAPTER") ?? "false")
    .toLowerCase() === "true";

  // ── Config-missing short-circuit (Gate A primary path) ────────────────────
  // URL solely from env. No hardcoded Base44 / upstream host anywhere.
  const c360Url = Deno.env.get("CUSTOMER360_API_URL");
  const c360Token = Deno.env.get("CUSTOMER360_API_TOKEN");

  if (!enabled || !c360Url || !c360Token) {
    // No fetch() attempted. No env / secret names in response.
    await writeUpstreamLog({
      conversation_id: conversationId,
      request_id: requestId,
      status: 503,
      latency_ms: Date.now() - startedAt,
      error_code: "C360_CONFIG_MISSING",
    });
    const out: Customer360AdapterOutput = applyNeverReturnFilter({
      success: false,
      source: "fallback",
      masking_level: maskingLevel,
      customer_context: null, // Gate A: never a real profile
      handoff_required: true,
      customer_context_degraded: true,
      customer_context_ref: customerRef, // opaque ref only
      request_id: requestId,
      error: {
        error_code: "C360_CONFIG_MISSING",
        message_safe: safeErrorMessage("C360_CONFIG_MISSING"),
        retryable: true,
      },
    }) as Customer360AdapterOutput;
    return jsonNoCors(200, out);
  }

  // ── Gate B/C placeholder ───────────────────────────────────────────────────
  // Actual upstream Customer360 fetch + masking is implemented in Gate B.
  // For Gate A defense-in-depth (should be unreachable while flag is false
  // and URL/token unset) return a safe fallback without performing a fetch.
  await writeUpstreamLog({
    conversation_id: conversationId,
    request_id: requestId,
    status: 501,
    latency_ms: Date.now() - startedAt,
    error_code: "C360_NOT_IMPLEMENTED_GATE_A",
  });
  const fallback: Customer360AdapterOutput = applyNeverReturnFilter({
    success: false,
    source: "fallback",
    masking_level: maskingLevel,
    customer_context: null,
    handoff_required: true,
    customer_context_degraded: true,
    customer_context_ref: customerRef,
    request_id: requestId,
    error: {
      error_code: "C360_NOT_IMPLEMENTED_GATE_A",
      message_safe: safeErrorMessage("C360_NOT_IMPLEMENTED_GATE_A"),
      retryable: true,
    },
  }) as Customer360AdapterOutput;
  return jsonNoCors(200, fallback);
});
