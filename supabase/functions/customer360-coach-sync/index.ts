// Workflow 5 / Task 5.3 — Customer360 ↔ SU CoachAI canonical sync
// Internal-only. Server-resolved tenant/customer identity. Replay-safe.
// Sends only sanitized Customer360 signals; never raw PII/order/payment/auth data.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const C360_FIELDS = [
  "masked_summary",
  "tier",
  "language_preference",
  "sentiment",
  "sentiment_trend",
  "trust_score",
  "churn_risk",
  "sensitive_to",
  "privacy_flags",
  "context_quality",
  "predicted_csat",
  "escalation_score",
  "p1_provider_version",
] as const;

const COACH_SIGNAL_ALLOWLIST = new Set([
  "coaching_summary",
  "recommended_tone",
  "risk_flags",
  "training_opportunity",
  "next_best_action",
  "coach_model_version",
]);

const FORBIDDEN_KEYS = new Set([
  "name","email","phone","address","order_id","orders","payments",
  "payment_card","payment_token","raw_ip","raw_device_fingerprint",
  "auth_identifiers","password_hash","session_token"
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

function isUuid(v: unknown): v is string {
  return typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(
    (k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`,
  ).join(",")}}`;
}

function containsForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(k)) return true;
    if (containsForbiddenKey(v)) return true;
  }
  return false;
}

function sanitizeCoachSignals(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (containsForbiddenKey(raw)) return null;

  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of COACH_SIGNAL_ALLOWLIST) {
    const value = input[key];
    if (value === undefined) continue;

    if (["coaching_summary","recommended_tone","next_best_action","coach_model_version"].includes(key)) {
      if (typeof value === "string" && value.trim()) {
        out[key] = value.trim().slice(0, key === "coaching_summary" ? 1000 : 200);
      }
      continue;
    }

    if (key === "risk_flags") {
      if (Array.isArray(value)) {
        out[key] = value
          .filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
          .slice(0, 10)
          .map((v) => v.trim().slice(0, 80));
      }
      continue;
    }

    if (key === "training_opportunity") {
      if (typeof value === "boolean") out[key] = value;
      continue;
    }
  }

  return out;
}

async function callCustomer360Adapter(
  conversationId: string,
  internalToken: string,
  supabaseUrl: string,
): Promise<
  | { ok: true; customerRef: string; context: Record<string, unknown> }
  | { ok: false; code: string; status: number }
> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const response = await fetch(
      `${supabaseUrl.replace(/\/+$/, "")}/functions/v1/customer360-adapter`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Service-Token": internalToken,
        },
        body: JSON.stringify({
          conversation_id: conversationId,
          fields_requested: C360_FIELDS,
        }),
        signal: ctrl.signal,
      },
    );

    if (!response.ok) return { ok: false, code: `C360_HTTP_${response.status}`, status: 502 };
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, code: "C360_INVALID_RESPONSE", status: 502 };
    }

    const obj = data as Record<string, unknown>;
    if (obj.success !== true) {
      const err = obj.error && typeof obj.error === "object"
        ? obj.error as Record<string, unknown>
        : {};
      return {
        ok: false,
        code: typeof err.error_code === "string"
          ? err.error_code.slice(0, 80)
          : "C360_DEGRADED",
        status: 503,
      };
    }

    if (typeof obj.customer_ref !== "string" || !obj.customer_ref.trim()) {
      return { ok: false, code: "C360_CUSTOMER_REF_MISSING", status: 502 };
    }
    if (!obj.customer_context || typeof obj.customer_context !== "object" ||
        Array.isArray(obj.customer_context)) {
      return { ok: false, code: "C360_CONTEXT_INVALID", status: 502 };
    }
    if (containsForbiddenKey(obj.customer_context)) {
      return { ok: false, code: "C360_FORBIDDEN_FIELD", status: 502 };
    }

    return {
      ok: true,
      customerRef: obj.customer_ref.trim(),
      context: obj.customer_context as Record<string, unknown>,
    };
  } catch (e) {
    return {
      ok: false,
      code: e instanceof DOMException && e.name === "AbortError"
        ? "C360_TIMEOUT"
        : "C360_FETCH_EXCEPTION",
      status: 503,
    };
  } finally {
    clearTimeout(t);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return jsonNoCors(405, { error: "method_not_allowed" });

  const expected = Deno.env.get("C360_COACH_SYNC_INTERNAL_TOKEN");
  const presented = req.headers.get("X-Internal-Service-Token");
  if (!expected || !presented || presented !== expected) {
    return jsonNoCors(401, { error: "unauthorized" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const c360InternalToken = Deno.env.get("CUSTOMER360_INTERNAL_TOKEN");
  const coachUrl = Deno.env.get("COACH_C360_SYNC_API_URL");
  const coachToken = Deno.env.get("COACH_C360_SYNC_API_TOKEN");
  const outboundVersion =
    (Deno.env.get("C360_COACH_SYNC_CONTRACT_VERSION") ?? "c360-coach-v1").trim();

  if (!supabaseUrl || !c360InternalToken || !coachUrl || !coachToken || !outboundVersion) {
    return jsonNoCors(503, { error: "sync_config_missing" });
  }

  let body: Record<string, unknown>;
  try {
    const parsed = await req.json();
    body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return jsonNoCors(400, { error: "invalid_request" });
  }

  for (const forbidden of [
    "company_id","tenant_id","customer_ref","customer_context",
    "email","phone","name","order_id","workspace_id",
  ]) {
    if (forbidden in body) return jsonNoCors(400, { error: "caller_scope_forbidden" });
  }

  const conversationId = body.conversation_id;
  if (!isUuid(conversationId)) {
    return jsonNoCors(400, { error: "invalid_conversation_id" });
  }

  const sb = serviceClient();
  if (!sb) return jsonNoCors(503, { error: "server_config_missing" });

  const { data: conv, error: convErr } = await sb
    .from("conversations")
    .select("id, company_id")
    .eq("id", conversationId)
    .maybeSingle();

  if (convErr || !conv?.company_id) {
    return jsonNoCors(404, { error: "conversation_not_found" });
  }
  const companyId = String(conv.company_id);

  const c360 = await callCustomer360Adapter(
    conversationId,
    c360InternalToken,
    supabaseUrl,
  );
  if (!c360.ok) {
    return jsonNoCors(c360.status, { error: c360.code });
  }

  const customerRefHash = await sha256Hex(c360.customerRef);
  const outboundPayload = {
    contract_version: outboundVersion,
    ai_company_id: companyId,
    customer_ref: c360.customerRef,
    customer_context: c360.context,
  };
  if (containsForbiddenKey(outboundPayload.customer_context)) {
    return jsonNoCors(502, { error: "forbidden_customer_context" });
  }

  const outboundHash = await sha256Hex(canonicalJson(outboundPayload));

  const { data: existing, error: existingErr } = await sb
    .from("customer360_coach_sync_state")
    .select("id, outbound_payload_sha256, outbound_version, last_status, coaching_signals, inbound_payload_sha256, inbound_version")
    .eq("company_id", companyId)
    .eq("customer_ref_sha256", customerRefHash)
    .maybeSingle();

  if (existingErr) return jsonNoCors(500, { error: "sync_state_lookup_failed" });

  if (
    existing &&
    existing.outbound_payload_sha256 === outboundHash &&
    existing.outbound_version === outboundVersion &&
    existing.last_status === "applied"
  ) {
    return jsonNoCors(200, {
      success: true,
      idempotent: true,
      status: "no_op",
      coaching_signals: existing.coaching_signals ?? {},
      inbound_version: existing.inbound_version ?? null,
    });
  }

  let parsedCoachUrl: URL;
  try {
    parsedCoachUrl = new URL(coachUrl);
    const local = parsedCoachUrl.hostname === "localhost" ||
      parsedCoachUrl.hostname === "127.0.0.1";
    if (parsedCoachUrl.protocol !== "https:" && !local) {
      return jsonNoCors(503, { error: "coach_sync_config_invalid" });
    }
  } catch {
    return jsonNoCors(503, { error: "coach_sync_config_invalid" });
  }

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 10000);
  let coachResp: Response;

  try {
    coachResp = await fetch(parsedCoachUrl.toString(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${coachToken}`,
        "Content-Type": "application/json",
        "X-AI-Company-ID": companyId,
      },
      body: JSON.stringify({
        operation: "sync_customer_coaching_context",
        idempotency_key: outboundHash,
        contract_version: outboundVersion,
        customer_ref: c360.customerRef,
        customer_context: c360.context,
      }),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    return jsonNoCors(503, {
      error: e instanceof DOMException && e.name === "AbortError"
        ? "coach_sync_timeout"
        : "coach_sync_unreachable",
    });
  }
  clearTimeout(timeout);

  if (!coachResp.ok) {
    return jsonNoCors(502, { error: `coach_sync_http_${coachResp.status}` });
  }

  const coachRaw = await coachResp.json().catch(() => null);
  if (!coachRaw || typeof coachRaw !== "object" || Array.isArray(coachRaw)) {
    return jsonNoCors(502, { error: "coach_sync_invalid_json" });
  }

  const coach = coachRaw as Record<string, unknown>;
  if (coach.success !== true) {
    return jsonNoCors(502, { error: "coach_sync_rejected" });
  }
  if (
    coach.ai_company_id !== undefined &&
    String(coach.ai_company_id) !== companyId
  ) {
    return jsonNoCors(502, { error: "coach_sync_company_mismatch" });
  }
  if (
    typeof coach.customer_ref !== "string" ||
    coach.customer_ref.trim() !== c360.customerRef
  ) {
    return jsonNoCors(502, { error: "coach_sync_customer_mismatch" });
  }

  const signals = sanitizeCoachSignals(coach.coaching_signals);
  if (!signals) {
    return jsonNoCors(502, { error: "coach_sync_forbidden_or_invalid_signals" });
  }

  const inboundVersion =
    typeof coach.version === "string" && coach.version.trim()
      ? coach.version.trim().slice(0, 120)
      : "unknown";
  const inboundHash = await sha256Hex(canonicalJson({
    version: inboundVersion,
    coaching_signals: signals,
  }));

  const row = {
    company_id: companyId,
    customer_ref_sha256: customerRefHash,
    outbound_payload_sha256: outboundHash,
    outbound_version: outboundVersion,
    inbound_payload_sha256: inboundHash,
    inbound_version: inboundVersion,
    coaching_signals: signals,
    last_status: "applied",
    last_error_code: null,
    synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error: upsertErr } = await sb
    .from("customer360_coach_sync_state")
    .upsert(row, {
      onConflict: "company_id,customer_ref_sha256",
      ignoreDuplicates: false,
    });

  if (upsertErr) return jsonNoCors(500, { error: "sync_state_write_failed" });

  return jsonNoCors(200, {
    success: true,
    idempotent: false,
    status: "applied",
    coaching_signals: signals,
    inbound_version: inboundVersion,
  });
});
