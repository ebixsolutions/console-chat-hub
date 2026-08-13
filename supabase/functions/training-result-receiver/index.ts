/**
 * PR-6B — SU CoachAI -> AI Chatbot training-result receiver.
 *
 * Local authoritative receiver contract:
 * POST /functions/v1/training-result-receiver
 * Header: X-SU-CoachAI-Result-Token: <server-side secret>
 *
 * Body:
 * {
 *   contract_version: "SU_COACHAI_TRAINING_RESULT_V1",
 *   evaluation_id: uuid,
 *   company_id: uuid,
 *   idempotency_key: string,
 *   decision: "trained" | "not_trained" | "rejected",
 *   remote_ref?: string,
 *   result: object
 * }
 *
 * The Edge Function performs authentication + shape validation only.
 * Tenant, evaluation, outbox-delivery and idempotency invariants are enforced
 * atomically by record_coachai_training_result_tx().
 */

import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const RESULT_CONTRACT = "SU_COACHAI_TRAINING_RESULT_V1";
const VALID_DECISIONS = new Set(["trained", "not_trained", "rejected"]);
const MAX_RESULT_BYTES = 64 * 1024;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function constantTimeEqual(aText: string, bText: string): boolean {
  const a = new TextEncoder().encode(aText);
  const b = new TextEncoder().encode(bText);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  const expected = Deno.env.get("SU_COACHAI_RESULT_TOKEN")?.trim() ?? "";
  const actual = req.headers.get("X-SU-CoachAI-Result-Token")?.trim() ?? "";
  if (!expected || !actual || !constantTimeEqual(expected, actual)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const raw = await req.text();
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_RESULT_BYTES) {
    return json({ ok: false, error: "payload_size_invalid" }, 413);
  }

  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  if (body.contract_version !== RESULT_CONTRACT) {
    return json({ ok: false, error: "contract_version_mismatch" }, 409);
  }
  if (!validUuid(body.evaluation_id) || !validUuid(body.company_id)) {
    return json({ ok: false, error: "identity_invalid" }, 400);
  }
  if (
    typeof body.idempotency_key !== "string" ||
    body.idempotency_key.length < 1 ||
    body.idempotency_key.length > 200
  ) {
    return json({ ok: false, error: "idempotency_key_invalid" }, 400);
  }
  if (typeof body.decision !== "string" || !VALID_DECISIONS.has(body.decision)) {
    return json({ ok: false, error: "decision_invalid" }, 400);
  }
  if (
    body.remote_ref !== undefined &&
    (typeof body.remote_ref !== "string" || body.remote_ref.length > 500)
  ) {
    return json({ ok: false, error: "remote_ref_invalid" }, 400);
  }
  if (
    !body.result ||
    typeof body.result !== "object" ||
    Array.isArray(body.result)
  ) {
    return json({ ok: false, error: "result_invalid" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!supabaseUrl || !serviceRole) {
    return json({ ok: false, error: "database_not_configured" }, 503);
  }

  const admin = createClient(supabaseUrl, serviceRole);
  const { data, error } = await admin.rpc("record_coachai_training_result_tx", {
    p_contract_version: RESULT_CONTRACT,
    p_evaluation_id: body.evaluation_id,
    p_company_id: body.company_id,
    p_idempotency_key: body.idempotency_key,
    p_decision: body.decision,
    p_remote_ref: body.remote_ref ?? null,
    p_result: body.result,
  });

  if (error) {
    console.error("[training-result-receiver] RPC failure", {
      code: error.code,
      evaluation_id: body.evaluation_id,
    });
    return json({ ok: false, error: "result_commit_failed" }, 500);
  }

  const result = data as Record<string, unknown> | null;
  const state = String(result?.result ?? "unknown");
  if (state === "success" || state === "idempotent") {
    return json({
      ok: true,
      result: state,
      evaluation_id: body.evaluation_id,
    });
  }

  const httpMap: Record<string, number> = {
    evaluation_not_found: 404,
    company_mismatch: 409,
    outbox_not_delivered: 409,
    idempotency_mismatch: 409,
    contract_mismatch: 409,
    invalid_decision: 400,
  };
  return json(
    { ok: false, error: state },
    httpMap[state] ?? 409,
  );
});
