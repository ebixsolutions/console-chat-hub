import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";
import { getSupabaseAdminKey } from "../_shared/supabase-admin-key.ts";

const CONTRACT_VERSION = "AI_CHATBOT_HF3_LEARNING_V1";
const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 30000;

type OutboxRow = {
  id: string;
  evaluation_id: string;
  company_id: string;
  delivery_attempts: number;
  max_attempts: number;
  delivery_idempotency_key: string;
  source_app: string;
  source_deployment: string;
  evaluation_contract_version: string;
};

type AdminClient = SupabaseClient<any, "public", any>;

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function intEnv(name: string, fallback: number, max: number): number {
  const n = Number.parseInt(Deno.env.get(name) ?? "", 10);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
}

function constantTimeEqual(aText: string, bText: string): boolean {
  const a = new TextEncoder().encode(aText);
  const b = new TextEncoder().encode(bText);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function verifyWorkerToken(req: Request): boolean {
  const expected = Deno.env.get("TRAINING_OUTBOX_INTERNAL_TOKEN")?.trim() ?? "";
  const actual = req.headers.get("X-Training-Outbox-Token")?.trim() ?? "";
  return Boolean(expected && actual && constantTimeEqual(expected, actual));
}

function remoteConfig():
  | { ok: true; endpoint: string; authHeader: string; authValue: string; timeoutMs: number }
  | { ok: false; error: string } {
  const endpointRaw = Deno.env.get("SU_COACHAI_EVALUATION_ENDPOINT")?.trim() ?? "";
  const authHeader = Deno.env.get("SU_COACHAI_AUTH_HEADER")?.trim() ?? "";
  const authValue = Deno.env.get("SU_COACHAI_AUTH_VALUE")?.trim() ?? "";
  if (!endpointRaw || !authHeader || !authValue) return { ok: false, error: "coachai_contract_not_configured" };
  let endpoint: URL;
  try { endpoint = new URL(endpointRaw); } catch { return { ok: false, error: "coachai_endpoint_invalid" }; }
  if (endpoint.protocol !== "https:") return { ok: false, error: "coachai_endpoint_must_be_https" };
  if (!/^[A-Za-z0-9-]{1,64}$/.test(authHeader)) return { ok: false, error: "coachai_auth_header_invalid" };
  if (["content-type", "idempotency-key"].includes(authHeader.toLowerCase())) {
    return { ok: false, error: "coachai_auth_header_reserved" };
  }
  return {
    ok: true,
    endpoint: endpoint.toString(),
    authHeader,
    authValue,
    timeoutMs: intEnv("SU_COACHAI_DELIVERY_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  };
}

async function loadPayload(admin: AdminClient, row: OutboxRow) {
  const { data: evaluation, error: evalErr } = await admin
    .from("conversation_evaluation")
    .select("id,attempt_id,conversation_id,company_id,evaluation_contract_version,input_snapshot_hash,bundle_hash,accuracy_score,policy_score,tone_score,sales_score,context_score,hallucination_risk_score,hallucination_quality_score,overall_score,severity,has_verified_human_response,training_eligible,model_version,prompt_version,kb_snapshot_id,policy_snapshot_id,source_deployment,review_status,created_at")
    .eq("id", row.evaluation_id)
    .maybeSingle();
  if (evalErr || !evaluation) return { ok: false as const, error: "evaluation_missing" };
  if (String(evaluation.company_id) !== row.company_id) return { ok: false as const, error: "company_identity_mismatch" };
  if (evaluation.review_status !== "accepted") return { ok: false as const, error: "evaluation_not_accepted" };

  const { data: learning, error: learningErr } = await admin
    .from("hf3_learning_case")
    .select("company_id,evaluation_id,handoff_classification,classification_reason_codes,feedback_quality_score,has_negative_feedback,has_verified_human_response,answer_delta_dimensions,training_candidate,candidate_reason_codes")
    .eq("evaluation_id", row.evaluation_id)
    .maybeSingle();
  if (learningErr || !learning) return { ok: false as const, error: "hf3_learning_case_missing" };
  if (String(learning.company_id) !== row.company_id || learning.evaluation_id !== row.evaluation_id) {
    return { ok: false as const, error: "hf3_learning_scope_mismatch" };
  }
  if (learning.training_candidate !== true || learning.has_verified_human_response !== true) {
    return { ok: false as const, error: "hf3_not_training_candidate" };
  }

  const { data: details, error: detailsErr } = await admin
    .from("conversation_evaluation_detail")
    .select("evaluator_type,raw_score,weight,weighted_score,justification,recommended_correction,evaluator_model_version,evaluator_prompt_version,grounding_refs")
    .eq("evaluation_id", row.evaluation_id)
    .order("evaluator_type", { ascending: true });
  if (detailsErr || !details || details.length !== 6) return { ok: false as const, error: "evaluation_details_incomplete" };

  const expectedTypes = ["accuracy", "context", "hallucination", "policy", "sales", "tone"];
  const actualTypes = details.map((d) => String(d.evaluator_type)).sort();
  if (JSON.stringify(actualTypes) !== JSON.stringify(expectedTypes)) {
    return { ok: false as const, error: "evaluation_details_contract_mismatch" };
  }

  const { data: snapshot, error: snapshotErr } = await admin
    .from("ce_bundle_snapshot")
    .select("attempt_id,conversation_id,company_id,bundle_hash,transcript_hash,evaluation_contract_version,model_version,prompt_version,kb_snapshot_id,policy_snapshot_id,normalized_transcript,evaluated_ai_reply,verified_human_response,grounding_manifest,truncation_manifest,redaction_applied,created_at")
    .eq("attempt_id", evaluation.attempt_id)
    .maybeSingle();
  if (snapshotErr || !snapshot) return { ok: false as const, error: "evaluation_snapshot_missing" };
  if (snapshot.redaction_applied !== true) return { ok: false as const, error: "snapshot_not_redacted" };
  if (String(snapshot.company_id) !== row.company_id || String(snapshot.conversation_id) !== String(evaluation.conversation_id)) {
    return { ok: false as const, error: "snapshot_scope_mismatch" };
  }

  return {
    ok: true as const,
    payload: {
      contract_version: CONTRACT_VERSION,
      idempotency_key: row.delivery_idempotency_key,
      source: { app: row.source_app, deployment: row.source_deployment },
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
        review_status: evaluation.review_status,
        model_version: evaluation.model_version,
        prompt_version: evaluation.prompt_version,
        kb_snapshot_id: evaluation.kb_snapshot_id,
        policy_snapshot_id: evaluation.policy_snapshot_id,
        created_at: evaluation.created_at,
      },
      quality_learning: {
        post_hoc_only: true,
        handoff_classification: learning.handoff_classification,
        classification_reason_codes: learning.classification_reason_codes,
        feedback_quality_score: learning.feedback_quality_score,
        has_negative_feedback: learning.has_negative_feedback,
        answer_delta_dimensions: learning.answer_delta_dimensions,
        candidate_reason_codes: learning.candidate_reason_codes,
      },
      evaluator_details: details,
      replay: {
        transcript_hash: snapshot.transcript_hash,
        normalized_transcript: snapshot.normalized_transcript,
        evaluated_ai_reply: snapshot.evaluated_ai_reply,
        verified_human_response: snapshot.verified_human_response,
        grounding_manifest: snapshot.grounding_manifest,
        truncation_manifest: snapshot.truncation_manifest,
        redaction_applied: true,
      },
    },
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!verifyWorkerToken(req)) return json({ ok: false, error: "unauthorized" }, 401);

  const remote = remoteConfig();
  if (!remote.ok) return json({ ok: false, error: remote.error }, 503);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  let adminKey = "";
  try { adminKey = getSupabaseAdminKey(); } catch {}
  if (!supabaseUrl || !adminKey) return json({ ok: false, error: "database_not_configured" }, 503);
  const admin: AdminClient = createClient(supabaseUrl, adminKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const batchSize = intEnv("TRAINING_OUTBOX_BATCH_SIZE", DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
  const { data: claimed, error: claimErr } = await admin.rpc("hf3_claim_training_outbox_tx", { p_max_batch: batchSize });
  if (claimErr) return json({ ok: false, error: "claim_failed" }, 500);

  const rows = (Array.isArray(claimed) ? claimed : []) as OutboxRow[];
  const summary = { scanned: rows.length, delivered: 0, retried: 0, failed: 0 };

  for (const row of rows) {
    const built = await loadPayload(admin, row);
    if (!built.ok) {
      const { data: finished } = await admin.rpc("hf3_finish_training_outbox_tx", {
        p_outbox_id: row.id,
        p_success: false,
        p_error: built.error,
      });
      const status = String((finished as Record<string, unknown> | null)?.status ?? "");
      if (status === "failed") summary.failed++;
      else summary.retried++;
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remote.timeoutMs);
    let resp: Response | null = null;
    let transportError = "";
    try {
      resp = await fetch(remote.endpoint, {
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
    } catch (error) {
      transportError = error instanceof DOMException && error.name === "AbortError"
        ? "coachai_timeout"
        : "coachai_unreachable";
    } finally {
      clearTimeout(timer);
    }

    const ok = Boolean(resp?.ok);
    const code = ok ? null : (transportError || `coachai_http_${resp?.status ?? "unknown"}`);
    const { data: finished, error: finishErr } = await admin.rpc("hf3_finish_training_outbox_tx", {
      p_outbox_id: row.id,
      p_success: ok,
      p_error: code,
    });
    if (finishErr) continue;
    const status = String((finished as Record<string, unknown> | null)?.status ?? "");
    if (ok && status === "delivered") summary.delivered++;
    else if (status === "failed") summary.failed++;
    else summary.retried++;
  }

  return json({ ok: true, contract_version: CONTRACT_VERSION, ...summary });
});
