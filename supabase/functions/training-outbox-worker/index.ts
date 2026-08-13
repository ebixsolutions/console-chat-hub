/**
 * PR-6 — AI Chatbot canonical evaluation -> SU CoachAI outbox delivery worker.
 *
 * This worker deliberately does NOT invent the remote CoachAI API contract.
 * Endpoint and auth header/value are runtime configuration owned by the verified
 * SU CoachAI intake contract. Until they exist, the worker fails closed without
 * claiming or mutating outbox rows.
 *
 * Delivery semantics:
 * - internal-token protected worker invocation
 * - stale in_progress recovery
 * - pending -> in_progress compare-and-set claim
 * - one delivery attempt per successful claim
 * - redacted CE snapshot only; never raw provider output
 * - Idempotency-Key header = outbox.delivery_idempotency_key
 * - any HTTP 2xx = transport accepted; receiver owns semantic idempotency
 * - failure returns to pending until max_attempts, then failed
 */

import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const CONTRACT_VERSION = "AI_CHATBOT_CE_HANDOFF_V1";
const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;
const STALE_IN_PROGRESS_MINUTES = 15;

type OutboxRow = {
  id: string;
  evaluation_id: string;
  company_id: string | null;
  status: string;
  delivery_attempts: number;
  max_attempts: number;
  delivery_idempotency_key: string;
  source_app: string;
  source_deployment: string;
  evaluation_contract_version: string;
  last_attempt_at: string | null;
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function positiveIntEnv(name: string, fallback: number, max: number): number {
  const raw = Number.parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isInteger(raw) && raw > 0 && raw <= max ? raw : fallback;
}

function resolveRemoteConfig():
  | {
      ok: true;
      endpoint: string;
      authHeader: string;
      authValue: string;
      timeoutMs: number;
    }
  | { ok: false; reason: string } {
  const endpointRaw = Deno.env.get("SU_COACHAI_EVALUATION_ENDPOINT")?.trim() ?? "";
  const authHeader = Deno.env.get("SU_COACHAI_AUTH_HEADER")?.trim() ?? "";
  const authValue = Deno.env.get("SU_COACHAI_AUTH_VALUE")?.trim() ?? "";

  if (!endpointRaw || !authHeader || !authValue) {
    return { ok: false, reason: "coachai_contract_not_configured" };
  }

  let endpoint: URL;
  try {
    endpoint = new URL(endpointRaw);
  } catch {
    return { ok: false, reason: "coachai_endpoint_invalid" };
  }
  if (endpoint.protocol !== "https:") {
    return { ok: false, reason: "coachai_endpoint_must_be_https" };
  }

  // Header name is runtime contract, but constrain it to a single safe HTTP
  // token and prevent overriding worker-owned protocol headers.
  if (!/^[A-Za-z0-9-]{1,64}$/.test(authHeader)) {
    return { ok: false, reason: "coachai_auth_header_invalid" };
  }
  const reserved = new Set(["content-type", "idempotency-key"]);
  if (reserved.has(authHeader.toLowerCase())) {
    return { ok: false, reason: "coachai_auth_header_reserved" };
  }

  return {
    ok: true,
    endpoint: endpoint.toString(),
    authHeader,
    authValue,
    timeoutMs: positiveIntEnv(
      "SU_COACHAI_DELIVERY_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
  };
}

function verifyWorkerToken(req: Request): boolean {
  const expected = Deno.env.get("TRAINING_OUTBOX_INTERNAL_TOKEN")?.trim() ?? "";
  const actual = req.headers.get("X-Training-Outbox-Token")?.trim() ?? "";
  if (!expected || !actual) return false;

  // Constant-time-ish comparison over equal-length byte arrays.
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(actual);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function compactError(code: string): string {
  return code.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160);
}

async function loadPayload(
  admin: ReturnType<typeof createClient>,
  row: OutboxRow,
): Promise<
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const { data: evaluation, error: evalErr } = await admin
    .from("conversation_evaluation")
    .select(
      "id, conversation_id, company_id, evaluation_contract_version, input_snapshot_hash, bundle_hash, " +
        "accuracy_score, policy_score, tone_score, sales_score, context_score, " +
        "hallucination_risk_score, hallucination_quality_score, overall_score, severity, " +
        "has_verified_human_response, model_version, prompt_version, kb_snapshot_id, " +
        "policy_snapshot_id, source_deployment, review_status, created_at",
    )
    .eq("id", row.evaluation_id)
    .maybeSingle();

  if (evalErr || !evaluation) {
    return { ok: false, error: "evaluation_missing" };
  }
  if (!evaluation.company_id || !row.company_id) {
    return { ok: false, error: "company_identity_missing" };
  }
  if (String(evaluation.company_id) !== String(row.company_id)) {
    return { ok: false, error: "company_identity_mismatch" };
  }
  if (
    String(evaluation.evaluation_contract_version) !==
      String(row.evaluation_contract_version)
  ) {
    return { ok: false, error: "evaluation_contract_mismatch" };
  }

  const { data: details, error: detailsErr } = await admin
    .from("conversation_evaluation_detail")
    .select(
      "evaluator_type, raw_score, weight, weighted_score, justification, " +
        "recommended_correction, evaluator_model_version, evaluator_prompt_version, grounding_refs",
    )
    .eq("evaluation_id", row.evaluation_id)
    .order("evaluator_type", { ascending: true });
  if (detailsErr || !details || details.length !== 6) {
    return { ok: false, error: "evaluation_details_incomplete" };
  }

  const expectedTypes = ["accuracy", "context", "hallucination", "policy", "sales", "tone"];
  const actualTypes = details.map((d) => String(d.evaluator_type)).sort();
  if (JSON.stringify(actualTypes) !== JSON.stringify(expectedTypes)) {
    return { ok: false, error: "evaluation_details_contract_mismatch" };
  }

  const { data: snapshot, error: snapshotErr } = await admin
    .from("ce_bundle_snapshot")
    .select(
      "attempt_id, conversation_id, company_id, bundle_hash, transcript_hash, " +
        "evaluation_contract_version, model_version, prompt_version, kb_snapshot_id, " +
        "policy_snapshot_id, normalized_transcript, evaluated_ai_reply, verified_human_response, " +
        "grounding_manifest, truncation_manifest, redaction_applied, created_at",
    )
    .eq("attempt_id", evaluation.attempt_id)
    .maybeSingle();

  // Older SELECT schemas may not expose attempt_id on evaluation above. Resolve
  // it explicitly, rather than silently sending a non-replayable payload.
  let canonicalSnapshot = snapshot;
  if (snapshotErr || !canonicalSnapshot) {
    const { data: evalAttempt, error: attemptErr } = await admin
      .from("conversation_evaluation")
      .select("attempt_id")
      .eq("id", row.evaluation_id)
      .maybeSingle();
    if (attemptErr || !evalAttempt?.attempt_id) {
      return { ok: false, error: "evaluation_attempt_missing" };
    }
    const { data: retrySnapshot, error: retrySnapshotErr } = await admin
      .from("ce_bundle_snapshot")
      .select(
        "attempt_id, conversation_id, company_id, bundle_hash, transcript_hash, " +
          "evaluation_contract_version, model_version, prompt_version, kb_snapshot_id, " +
          "policy_snapshot_id, normalized_transcript, evaluated_ai_reply, verified_human_response, " +
          "grounding_manifest, truncation_manifest, redaction_applied, created_at",
      )
      .eq("attempt_id", evalAttempt.attempt_id)
      .maybeSingle();
    if (retrySnapshotErr || !retrySnapshot) {
      return { ok: false, error: "evaluation_snapshot_missing" };
    }
    canonicalSnapshot = retrySnapshot;
  }

  if (canonicalSnapshot.redaction_applied !== true) {
    return { ok: false, error: "snapshot_not_redacted" };
  }
  if (
    String(canonicalSnapshot.company_id) !== String(row.company_id) ||
    String(canonicalSnapshot.conversation_id) !== String(evaluation.conversation_id)
  ) {
    return { ok: false, error: "snapshot_scope_mismatch" };
  }

  return {
    ok: true,
    payload: {
      contract_version: CONTRACT_VERSION,
      idempotency_key: row.delivery_idempotency_key,
      source: {
        app: row.source_app,
        deployment: row.source_deployment,
      },
      evaluation: {
        id: evaluation.id,
        conversation_id: evaluation.conversation_id,
        company_id: evaluation.company_id,
        evaluation_contract_version: evaluation.evaluation_contract_version,
        input_snapshot_hash: evaluation.input_snapshot_hash,
        bundle_hash: evaluation.bundle_hash,
        scores: {
          accuracy: evaluation.accuracy_score,
          policy: evaluation.policy_score,
          tone: evaluation.tone_score,
          sales: evaluation.sales_score,
          context: evaluation.context_score,
          hallucination_risk: evaluation.hallucination_risk_score,
          hallucination_quality: evaluation.hallucination_quality_score,
          overall: evaluation.overall_score,
        },
        severity: evaluation.severity,
        has_verified_human_response: evaluation.has_verified_human_response,
        model_version: evaluation.model_version,
        prompt_version: evaluation.prompt_version,
        kb_snapshot_id: evaluation.kb_snapshot_id,
        policy_snapshot_id: evaluation.policy_snapshot_id,
        review_status: evaluation.review_status,
        created_at: evaluation.created_at,
      },
      evaluator_details: details,
      replay: {
        transcript_hash: canonicalSnapshot.transcript_hash,
        normalized_transcript: canonicalSnapshot.normalized_transcript,
        evaluated_ai_reply: canonicalSnapshot.evaluated_ai_reply,
        verified_human_response: canonicalSnapshot.verified_human_response,
        grounding_manifest: canonicalSnapshot.grounding_manifest,
        truncation_manifest: canonicalSnapshot.truncation_manifest,
        redaction_applied: true,
      },
    },
  };
}

async function markFailure(
  admin: ReturnType<typeof createClient>,
  row: OutboxRow,
  attempts: number,
  code: string,
): Promise<void> {
  const terminal = attempts >= row.max_attempts;
  await admin
    .from("evaluation_training_outbox")
    .update({
      status: terminal ? "failed" : "pending",
      last_error: compactError(code),
    })
    .eq("id", row.id)
    .eq("status", "in_progress");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!verifyWorkerToken(req)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const remote = resolveRemoteConfig();
  if (!remote.ok) {
    // Critical: do this before stale reset or row claim. Missing/unverified
    // remote contract must cause zero outbox mutations.
    return json({ ok: false, error: remote.reason }, 503);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!supabaseUrl || !serviceRole) {
    return json({ ok: false, error: "database_not_configured" }, 503);
  }
  const admin = createClient(supabaseUrl, serviceRole);

  const batchSize = positiveIntEnv(
    "TRAINING_OUTBOX_BATCH_SIZE",
    DEFAULT_BATCH_SIZE,
    MAX_BATCH_SIZE,
  );

  const staleCutoff = new Date(
    Date.now() - STALE_IN_PROGRESS_MINUTES * 60_000,
  ).toISOString();

  // Recover abandoned claims. Attempts are not decremented.
  await admin
    .from("evaluation_training_outbox")
    .update({ status: "pending", last_error: "stale_claim_recovered" })
    .eq("status", "in_progress")
    .lt("last_attempt_at", staleCutoff);

  const { data: pending, error: readErr } = await admin
    .from("evaluation_training_outbox")
    .select(
      "id, evaluation_id, company_id, status, delivery_attempts, max_attempts, " +
        "delivery_idempotency_key, source_app, source_deployment, " +
        "evaluation_contract_version, last_attempt_at",
    )
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (readErr) {
    console.error("[training-outbox-worker] pending read failed", readErr.code);
    return json({ ok: false, error: "outbox_read_failed" }, 500);
  }

  const summary = {
    scanned: pending?.length ?? 0,
    claimed: 0,
    delivered: 0,
    retried: 0,
    failed: 0,
    skipped_race: 0,
  };

  for (const candidate of (pending ?? []) as OutboxRow[]) {
    const nextAttempt = Number(candidate.delivery_attempts ?? 0) + 1;
    const now = new Date().toISOString();

    // Race-safe compare-and-set claim.
    const { data: claimed, error: claimErr } = await admin
      .from("evaluation_training_outbox")
      .update({
        status: "in_progress",
        delivery_attempts: nextAttempt,
        last_attempt_at: now,
        last_error: null,
      })
      .eq("id", candidate.id)
      .eq("status", "pending")
      .select(
        "id, evaluation_id, company_id, status, delivery_attempts, max_attempts, " +
          "delivery_idempotency_key, source_app, source_deployment, " +
          "evaluation_contract_version, last_attempt_at",
      )
      .maybeSingle();

    if (claimErr) {
      console.error("[training-outbox-worker] claim failed", {
        outbox_id: candidate.id,
        code: claimErr.code,
      });
      continue;
    }
    if (!claimed) {
      summary.skipped_race++;
      continue;
    }
    summary.claimed++;

    const row = claimed as OutboxRow;
    const built = await loadPayload(admin, row);
    if (!built.ok) {
      await markFailure(admin, row, nextAttempt, built.error);
      if (nextAttempt >= row.max_attempts) summary.failed++;
      else summary.retried++;
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remote.timeoutMs);
    let response: Response | null = null;
    let transportError: string | null = null;
    try {
      response = await fetch(remote.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [remote.authHeader]: remote.authValue,
          "Idempotency-Key": row.delivery_idempotency_key,
          "X-AI-Chatbot-Contract": CONTRACT_VERSION,
        },
        body: JSON.stringify(built.payload),
        signal: controller.signal,
      });
    } catch (e) {
      transportError =
        e instanceof DOMException && e.name === "AbortError"
          ? "coachai_timeout"
          : "coachai_unreachable";
    } finally {
      clearTimeout(timer);
    }

    if (!response || !response.ok) {
      const code = transportError ??
        `coachai_http_${response?.status ?? "unknown"}`;
      await markFailure(admin, row, nextAttempt, code);
      if (nextAttempt >= row.max_attempts) summary.failed++;
      else summary.retried++;
      continue;
    }

    // The remote response body is intentionally not persisted. Until the
    // verified receiver contract exists, a 2xx transport acceptance is the only
    // assumption this worker makes.
    const { data: delivered, error: deliveredErr } = await admin
      .from("evaluation_training_outbox")
      .update({
        status: "delivered",
        delivered_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", row.id)
      .eq("status", "in_progress")
      .select("id")
      .maybeSingle();

    if (deliveredErr || !delivered) {
      // Do not mark pending here: the receiver may already have accepted it.
      // Leave in_progress; stale recovery will safely retry using the same
      // idempotency key.
      console.error("[training-outbox-worker] delivery commit ambiguous", {
        outbox_id: row.id,
        code: deliveredErr?.code ?? "row_not_updated",
      });
      continue;
    }
    summary.delivered++;
  }

  return json({ ok: true, contract_version: CONTRACT_VERSION, ...summary });
});
