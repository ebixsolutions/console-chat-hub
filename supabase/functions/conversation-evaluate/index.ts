/**
 * conversation-evaluate — the only callable surface for Conversation Evaluation.
 *
 * Security posture
 *   - exact Bearer parsing; malformed Authorization is rejected
 *   - bounded/strict request body
 *   - canonical tenant authorization from conversation + channel ownership
 *   - fixed public error vocabulary
 *
 * Reliability posture
 *   - grounding before attempt creation
 *   - provider retry/timeout in governed model router
 *   - completion ambiguity resolved by read-back
 *   - failed attempts terminate/reap
 */

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";
import { callModel, parseJsonObject, redact, toCeErrorCode } from "../_shared/llm-router.ts";
import { fetchGrounding, type GroundingBundle } from "../_shared/ce-grounding.ts";
import {
  buildCanonicalBundle,
  CE_DIMENSIONS,
  type CeDimension,
  deriveDiscrepancies,
  DIMENSION_TO_EVALUATOR_TYPE,
  EVALUATOR_PROMPT_VERSION,
  EVALUATOR_SYSTEM_PROMPT,
  SIGNALS_SYSTEM_PROMPT,
  type SnapshotConversation,
  type SnapshotMessage,
  validateEvaluatorOutput,
  validateSignalsOutput,
} from "../_shared/ce-contract.ts";

const CONSOLE_ORIGINS = [
  "https://console-chat-hub.lovable.app",
  "https://id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app",
];
const EVALUATE_ROLES = new Set(["admin", "supervisor", "qa"]);
const REVIEW_ROLES = new Set(["admin", "supervisor"]);
const MAX_BODY_BYTES = 8 * 1024;
const MAX_MESSAGES = 400;
const MAX_NOTE_CHARS = 1000;
const EVALUATOR_MAX_TOKENS = 1100;
const STALE_ATTEMPT_MINUTES = 15;
const ALLOWED_FIELDS: Record<string, Set<string>> = {
  evaluate: new Set(["action", "conversation_id"]),
  review: new Set(["action", "evaluation_id", "conversation_id", "decision", "note"]),
};
const PUBLIC_ERRORS = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  provider_failed: 502,
  unavailable: 503,
  internal_error: 500,
} as const;
type PublicError = keyof typeof PUBLIC_ERRORS;
const REQUIRED_ENV = ["CE_CONTRACT_VERSION", "CE_SOURCE_DEPLOYMENT"] as const;

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return {
    "Access-Control-Allow-Origin": CONSOLE_ORIGINS.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
function ok(body: Record<string, unknown>, req: Request, operationId: string): Response {
  return new Response(JSON.stringify({ ...body, operation_id: operationId }), {
    status: 200,
    headers: { ...corsFor(req), "Content-Type": "application/json" },
  });
}
function fail(error: PublicError, req: Request, operationId: string, detail?: string): Response {
  return new Response(JSON.stringify({ error, detail: detail ?? null, operation_id: operationId }), {
    status: PUBLIC_ERRORS[error],
    headers: { ...corsFor(req), "Content-Type": "application/json" },
  });
}
function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header.trim());
  if (!m) return null;
  const token = m[1];
  if (token.length < 20 || token.length > 4096) return null;
  return token;
}
async function readBoundedJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; reason: "too_large" | "unparsable" }> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) return { ok: false, reason: "too_large" };
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { ok: false, reason: "too_large" };
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch { return { ok: false, reason: "unparsable" }; }
}
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ component: "conversation-evaluate", ts: new Date().toISOString(), ...fields }));
}

interface TenantContext {
  conversation: SnapshotConversation;
  company: { company_id: string; external_workspace_id: string; external_tenant_id: string };
  roles: string[];
}

async function resolveTenant(
  admin: SupabaseClient,
  conversationId: string,
  userId: string,
): Promise<{ ok: true; ctx: TenantContext } | { ok: false; error: PublicError; detail: string }> {
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select("id, company_id, status, priority, channel_config_id, created_at, resolved_at")
    .eq("id", conversationId)
    .maybeSingle();
  if (convErr) return { ok: false, error: "internal_error", detail: "conversation_lookup_failed" };
  if (!conv) return { ok: false, error: "not_found", detail: "conversation_not_found" };

  let channelCompanyId: string | null = null;
  if (conv.channel_config_id) {
    const { data: channel, error: channelErr } = await admin
      .from("channel_config")
      .select("company_id")
      .eq("id", conv.channel_config_id)
      .maybeSingle();
    if (channelErr) return { ok: false, error: "internal_error", detail: "channel_company_lookup_failed" };
    channelCompanyId = channel?.company_id ? String(channel.company_id) : null;
  }

  const conversationCompanyId = conv.company_id ? String(conv.company_id) : null;
  if (conversationCompanyId && channelCompanyId && conversationCompanyId !== channelCompanyId) {
    return { ok: false, error: "conflict", detail: "tenant_identity_conflict" };
  }
  const resolvedCompanyId = conversationCompanyId ?? channelCompanyId;
  if (!resolvedCompanyId) return { ok: false, error: "conflict", detail: "tenant_unresolved" };

  const { data: company, error: coErr } = await admin
    .from("company")
    .select("id, external_workspace_id, external_tenant_id, is_active")
    .eq("id", resolvedCompanyId)
    .maybeSingle();
  if (coErr) return { ok: false, error: "internal_error", detail: "company_lookup_failed" };
  if (!company || !company.is_active) return { ok: false, error: "forbidden", detail: "company_inactive" };

  // Canonical rule: after resolving ownership from conversation/channel, every
  // downstream authorization lookup MUST use resolvedCompanyId. Never fall back
  // to the nullable legacy conversations.company_id again.
  const { data: members, error: memErr } = await admin
    .from("company_membership")
    .select("role")
    .eq("company_id", resolvedCompanyId)
    .eq("user_id", userId)
    .eq("is_active", true);
  if (memErr) return { ok: false, error: "internal_error", detail: "membership_lookup_failed" };
  if (!members || members.length === 0) return { ok: false, error: "forbidden", detail: "not_a_member" };

  return {
    ok: true,
    ctx: {
      conversation: { ...conv, company_id: resolvedCompanyId } as SnapshotConversation,
      company: {
        company_id: company.id,
        external_workspace_id: company.external_workspace_id,
        external_tenant_id: company.external_tenant_id,
      },
      roles: members.map((m: { role: string }) => m.role),
    },
  };
}

async function runEvaluator(
  dimension: CeDimension,
  bundleText: string,
  knownChunkIds: ReadonlySet<string>,
  operationId: string,
  companyId: string,
  conversationId: string,
): Promise<
  | { ok: true; score: number; justification: string; evidence: string[]; grounding_refs: string[]; recommended_correction: string; model: string; raw: Record<string, unknown> }
  | { ok: false; code: string }
> {
  const res = await callModel({
    purpose: "evaluation",
    system: EVALUATOR_SYSTEM_PROMPT[dimension],
    user: bundleText,
    maxTokens: EVALUATOR_MAX_TOKENS,
    operationId: `${operationId}:${dimension}`,
    companyId,
    conversationId,
    tag: `ce:${dimension}`,
  });
  if (!res.ok) return { ok: false, code: toCeErrorCode(res.code) };
  const parsed = parseJsonObject(res.text);
  const validated = validateEvaluatorOutput(parsed, knownChunkIds);
  if (!validated) {
    log({ event: "evaluator_output_invalid", dimension, operation_id: operationId });
    return { ok: false, code: "CE_PROVIDER_INVALID_OUTPUT" };
  }
  return { ok: true, ...validated, model: res.model, raw: parsed as Record<string, unknown> };
}

async function runSignals(
  bundleText: string,
  transcript: Parameters<typeof validateSignalsOutput>[1],
  operationId: string,
  companyId: string,
  conversationId: string,
): Promise<ReturnType<typeof validateSignalsOutput>> {
  const res = await callModel({
    purpose: "evaluation",
    system: SIGNALS_SYSTEM_PROMPT,
    user: bundleText,
    maxTokens: EVALUATOR_MAX_TOKENS,
    operationId: `${operationId}:signals`,
    companyId,
    conversationId,
    tag: "ce:signals",
  });
  if (!res.ok) {
    log({ event: "signals_unavailable", code: res.code, operation_id: operationId });
    return null;
  }
  const signals = validateSignalsOutput(parseJsonObject(res.text), transcript);
  if (!signals) log({ event: "signals_invalid", operation_id: operationId });
  return signals;
}

async function terminateAttempt(admin: SupabaseClient, attemptId: string, code: string, operationId: string): Promise<void> {
  const { data, error } = await admin.rpc("fail_evaluation", { p_attempt_id: attemptId, p_error: code });
  const result = String(((data ?? {}) as Record<string, unknown>).result ?? "");
  if (error || result !== "failed") {
    log({ event: "fail_rpc_unconfirmed", attempt_id: attemptId, result, operation_id: operationId });
    await admin.rpc("reap_stale_evaluation_attempts", { p_older_than: "0 minutes" }).then(() => undefined, () => undefined);
  }
}
async function readBackEvaluation(admin: SupabaseClient, attemptId: string): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from("conversation_evaluation")
    .select("id, conversation_id, overall_score, severity, review_status, training_eligible, has_verified_human_response, input_snapshot_hash, bundle_hash, evaluation_contract_version, created_at")
    .eq("attempt_id", attemptId)
    .maybeSingle();
  return (data as unknown as Record<string, unknown>) ?? null;
}

async function handleEvaluate(
  req: Request,
  admin: SupabaseClient,
  userId: string,
  conversationId: string,
  operationId: string,
): Promise<Response> {
  const contractVersion = Deno.env.get("CE_CONTRACT_VERSION")!;
  const sourceDeployment = Deno.env.get("CE_SOURCE_DEPLOYMENT")!;
  const tenant = await resolveTenant(admin, conversationId, userId);
  if (!tenant.ok) return fail(tenant.error, req, operationId, tenant.detail);
  const { conversation, company, roles } = tenant.ctx;
  if (!roles.some((r) => EVALUATE_ROLES.has(r))) return fail("forbidden", req, operationId, "role_not_permitted");

  await admin.rpc("reap_stale_evaluation_attempts", { p_older_than: `${STALE_ATTEMPT_MINUTES} minutes` }).then(() => undefined, () => undefined);

  const { data: msgs, error: msgErr } = await admin
    .from("messages")
    .select("id, role, content, created_at, is_recalled, sender_id, sender_identity_verified_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_MESSAGES + 1);
  if (msgErr) return fail("internal_error", req, operationId, "messages_lookup_failed");
  if (!msgs || msgs.length === 0) return fail("conflict", req, operationId, "conversation_empty");
  if (msgs.length > MAX_MESSAGES) return fail("payload_too_large", req, operationId, "conversation_too_long");

  const lastCustomer = [...(msgs as SnapshotMessage[])].reverse().find((m) =>
    !m.is_recalled && ["visitor", "customer", "user"].includes(m.role.toLowerCase())
  );
  const grounding = await fetchGrounding({
    conversationId,
    messageId: lastCustomer?.id,
    company,
    query: redact(lastCustomer?.content ?? ""),
    riskLevel: "high",
    requirePolicyEvidence: true,
  });
  if (!grounding.ok) {
    log({ event: "grounding_failed", code: grounding.code, operation_id: operationId });
    return fail("unavailable", req, operationId, "grounding_unavailable");
  }
  const bundleGrounding: GroundingBundle = grounding.bundle;

  let bundle;
  try {
    bundle = await buildCanonicalBundle({
      conversation,
      messages: msgs as SnapshotMessage[],
      actor: { user_id: userId, company_id: company.company_id, roles },
      grounding: bundleGrounding,
      contractVersion,
    });
  } catch {
    return fail("forbidden", req, operationId, "tenant_mismatch");
  }

  const { data: initRaw, error: initErr } = await admin.rpc("initiate_evaluation_v2", {
    p_conversation_id: conversationId,
    p_contract_version: contractVersion,
    p_kb_snapshot_id: bundleGrounding.kb_snapshot_id,
    p_policy_snapshot_id: bundleGrounding.policy_snapshot_id,
    p_model_version: Deno.env.get("LLM_MODEL_EVALUATION") ?? "",
    p_prompt_version: EVALUATOR_PROMPT_VERSION,
    p_input_snapshot_hash: bundle.transcript_hash,
    p_bundle_hash: bundle.bundle_hash,
    p_grounding_manifest: bundleGrounding.manifest,
    p_initiated_by: userId,
    p_source_deployment: sourceDeployment,
  });
  if (initErr) {
    log({ event: "initiate_rpc_error", operation_id: operationId });
    return fail("internal_error", req, operationId, "initiate_failed");
  }
  const init = (initRaw ?? {}) as Record<string, unknown>;
  const initResult = String(init.result ?? "");
  if (initResult === "already_evaluated") {
    const { data: existing } = await admin.from("conversation_evaluation")
      .select("id, conversation_id, overall_score, severity, review_status, training_eligible, has_verified_human_response, input_snapshot_hash, bundle_hash, evaluation_contract_version, created_at")
      .eq("id", String(init.evaluation_id ?? ""))
      .maybeSingle();
    return ok({ status: "already_evaluated", evaluation: existing ?? null }, req, operationId);
  }
  if (initResult === "already_in_progress") return fail("conflict", req, operationId, "already_in_progress");
  if (initResult === "feature_disabled") return fail("unavailable", req, operationId, "feature_disabled");
  if (initResult === "tenant_unresolved") return fail("conflict", req, operationId, "tenant_unresolved");
  if (initResult === "tenant_identity_conflict") return fail("conflict", req, operationId, "tenant_identity_conflict");
  if (initResult === "tenant_forbidden") return fail("forbidden", req, operationId, "tenant_forbidden");
  if (initResult !== "initiated" || !isUuid(init.attempt_id)) return fail("conflict", req, operationId, "initiate_rejected");
  const attemptId = init.attempt_id as string;

  const knownChunkIds = new Set<string>(
    [...bundleGrounding.kb_chunks, ...bundleGrounding.policy_chunks].filter((c) => c.included).map((c) => c.chunk_id),
  );
  const settled = await Promise.all(
    CE_DIMENSIONS.map((d) => runEvaluator(d, bundle.text, knownChunkIds, operationId, company.company_id, conversationId)),
  );
  const firstFailure = settled.find((r) => !r.ok) as { ok: false; code: string } | undefined;
  if (firstFailure) {
    await terminateAttempt(admin, attemptId, firstFailure.code, operationId);
    return fail("provider_failed", req, operationId, firstFailure.code);
  }

  const scores: Record<string, number> = {};
  const details: Record<string, unknown> = {};
  CE_DIMENSIONS.forEach((dimension, i) => {
    const r = settled[i] as Extract<Awaited<ReturnType<typeof runEvaluator>>, { ok: true }>;
    scores[dimension] = r.score;
    details[DIMENSION_TO_EVALUATOR_TYPE[dimension]] = {
      justification: r.justification,
      recommended_correction: r.recommended_correction,
      model_version: r.model,
      prompt_version: EVALUATOR_PROMPT_VERSION,
      grounding_refs: r.grounding_refs,
      raw_llm_response: { dimension, score: r.score, evidence: r.evidence, grounding_refs: r.grounding_refs, provider_output: r.raw },
    };
  });

  const signals = await runSignals(bundle.text, bundle.transcript, operationId, company.company_id, conversationId);
  const aiText = bundle.evaluated_ai_reply
    ? (bundle.transcript.find((e) => e.id === bundle.evaluated_ai_reply!.id)?.content ?? "")
    : "";
  const humanText = bundle.verified_human_response
    ? (bundle.transcript.find((e) => e.id === bundle.verified_human_response!.id)?.content ?? "")
    : "";
  const discrepancies = deriveDiscrepancies({
    evaluatedAiReply: aiText,
    verifiedHumanResponse: humanText,
    perDimension: CE_DIMENSIONS.map((dimension, i) => {
      const r = settled[i] as Extract<Awaited<ReturnType<typeof runEvaluator>>, { ok: true }>;
      return {
        evaluatorType: DIMENSION_TO_EVALUATOR_TYPE[dimension],
        score: r.score,
        recommendedCorrection: r.recommended_correction,
        groundingRefs: r.grounding_refs,
      };
    }),
  });

  const snapshot = {
    bundle_hash: bundle.bundle_hash,
    canonical_input: redact(bundle.text),
    redaction_applied: true,
    grounding_evidence: {
      kb_block: redact(bundleGrounding.kb_block),
      policy_block: redact(bundleGrounding.policy_block),
      kb_snapshot_id: bundleGrounding.kb_snapshot_id,
      policy_snapshot_id: bundleGrounding.policy_snapshot_id,
    },
    normalized_transcript: bundle.transcript.filter((e) => e.included).map((e) => ({
      id: e.id, role: e.role, raw_role: e.raw_role, created_at: e.created_at,
      content: redact(e.content), content_sha256: e.content_sha256,
      original_chars: e.original_chars, used_chars: e.used_chars,
    })),
    evaluated_ai_reply: bundle.evaluated_ai_reply ? { ...bundle.evaluated_ai_reply, content: redact(aiText) } : null,
    verified_human_response: bundle.verified_human_response ? { ...bundle.verified_human_response, content: redact(humanText) } : null,
    truncation_manifest: bundle.truncation,
  };
  const derived = { emotion: signals?.emotion ?? [], next_steps: signals?.next_steps ?? [], discrepancies };

  const { data: doneRaw, error: doneErr } = await admin.rpc("complete_evaluation_v2", {
    p_attempt_id: attemptId,
    p_scores: scores,
    p_details: details,
    p_bundle_hash: bundle.bundle_hash,
    p_snapshot: snapshot,
    p_derived: derived,
  });
  if (doneErr) {
    const readBack = await readBackEvaluation(admin, attemptId);
    if (readBack) return ok({ status: "completed", evaluation: readBack }, req, operationId);
    await terminateAttempt(admin, attemptId, "CE_PERSISTENCE_RPC_ERROR", operationId);
    return fail("internal_error", req, operationId, "persist_failed");
  }
  const done = (doneRaw ?? {}) as Record<string, unknown>;
  if (String(done.result ?? "") !== "success") {
    const readBack = await readBackEvaluation(admin, attemptId);
    if (readBack) return ok({ status: "completed", evaluation: readBack }, req, operationId);
    await terminateAttempt(admin, attemptId, "CE_PERSISTENCE_ERROR", operationId);
    return fail("conflict", req, operationId, "persist_rejected");
  }
  const evaluation = await readBackEvaluation(admin, attemptId);
  if (!evaluation) {
    await terminateAttempt(admin, attemptId, "CE_PERSISTENCE_ERROR", operationId);
    return fail("internal_error", req, operationId, "persist_unverified");
  }
  return ok({
    status: "completed",
    evaluation,
    grounding: {
      kb_snapshot_id: bundleGrounding.kb_snapshot_id,
      policy_snapshot_id: bundleGrounding.policy_snapshot_id,
      kb_chunks_included: bundleGrounding.manifest.kb.chunks_included,
      policy_chunks_included: bundleGrounding.manifest.policy.chunks_included,
      truncated: bundle.truncation.truncated,
    },
  }, req, operationId);
}

async function handleReview(
  req: Request,
  admin: SupabaseClient,
  caller: SupabaseClient,
  userId: string,
  body: Record<string, unknown>,
  operationId: string,
): Promise<Response> {
  const evaluationId = body.evaluation_id;
  const conversationId = body.conversation_id;
  const decision = body.decision;
  if (!isUuid(evaluationId)) return fail("invalid_request", req, operationId, "evaluation_id");
  if (!isUuid(conversationId)) return fail("invalid_request", req, operationId, "conversation_id");
  if (typeof decision !== "string" || !["accept", "reject", "reopen"].includes(decision)) {
    return fail("invalid_request", req, operationId, "decision");
  }
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string") return fail("invalid_request", req, operationId, "note");
    const trimmed = body.note.trim();
    if (trimmed.length > MAX_NOTE_CHARS) return fail("invalid_request", req, operationId, "note_too_long");
    note = trimmed.length > 0 ? trimmed : null;
  }
  if (decision === "reject" && !note) return fail("invalid_request", req, operationId, "note_required");

  const tenant = await resolveTenant(admin, conversationId as string, userId);
  if (!tenant.ok) return fail(tenant.error, req, operationId, tenant.detail);
  if (!tenant.ctx.roles.some((r) => REVIEW_ROLES.has(r))) return fail("forbidden", req, operationId, "role_not_permitted");

  const { data: raw, error } = await caller.rpc("review_evaluation", {
    p_evaluation_id: evaluationId,
    p_expected_conversation_id: conversationId,
    p_decision: decision,
    p_note: note,
  });
  if (error) {
    log({ event: "review_rpc_error", operation_id: operationId });
    return fail("internal_error", req, operationId, "review_failed");
  }
  const out = (raw ?? {}) as Record<string, unknown>;
  const result = String(out.result ?? "");
  if (result === "success") {
    return ok({
      status: "reviewed",
      from: out.from,
      to: out.to,
      reviewed_at: out.reviewed_at,
      training_eligible: out.training_eligible,
      outbox_created: out.outbox_created,
    }, req, operationId);
  }
  if (result === "not_found") return fail("not_found", req, operationId, "not_found");
  if (result === "scope_mismatch") return fail("conflict", req, operationId, "scope_mismatch");
  if (result === "invalid_transition") return fail("conflict", req, operationId, "invalid_transition");
  if (result === "forbidden") return fail("forbidden", req, operationId, "role_not_permitted");
  if (result === "tenant_unresolved") return fail("conflict", req, operationId, "tenant_unresolved");
  if (result === "note_required") return fail("invalid_request", req, operationId, "note_required");
  return fail("conflict", req, operationId, "review_rejected");
}

Deno.serve(async (req) => {
  const operationId = crypto.randomUUID();
  const origin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") {
    if (!CONSOLE_ORIGINS.includes(origin)) return new Response(null, { status: 403 });
    return new Response(null, { headers: corsFor(req) });
  }
  if (req.method !== "POST") return fail("invalid_request", req, operationId, "method_not_allowed");
  if (origin && !CONSOLE_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ error: "forbidden", detail: "origin", operation_id: operationId }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    for (const key of REQUIRED_ENV) {
      const v = Deno.env.get(key);
      if (!v || v.trim().length === 0) {
        log({ event: "config_missing", key, operation_id: operationId });
        return fail("unavailable", req, operationId, "not_configured");
      }
    }
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(Deno.env.get("CE_SOURCE_DEPLOYMENT")!)) {
      log({ event: "config_invalid", key: "CE_SOURCE_DEPLOYMENT", operation_id: operationId });
      return fail("unavailable", req, operationId, "not_configured");
    }

    const bearer = parseBearer(req.headers.get("Authorization"));
    if (!bearer) return fail("unauthorized", req, operationId, "bearer_malformed");
    const caller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data: userData, error: authErr } = await caller.auth.getUser();
    if (authErr || !userData?.user) return fail("unauthorized", req, operationId, "invalid_token");
    const userId = userData.user.id;

    const parsedBody = await readBoundedJson(req);
    if (!parsedBody.ok) {
      return parsedBody.reason === "too_large"
        ? fail("payload_too_large", req, operationId, "body_too_large")
        : fail("invalid_request", req, operationId, "body_unparsable");
    }
    const body = parsedBody.value;
    if (!body || typeof body !== "object" || Array.isArray(body)) return fail("invalid_request", req, operationId, "body_shape");
    const record = body as Record<string, unknown>;
    const action = typeof record.action === "string" ? record.action : "evaluate";
    const allowed = ALLOWED_FIELDS[action];
    if (!allowed) return fail("invalid_request", req, operationId, "action");
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) return fail("invalid_request", req, operationId, "unknown_field");
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    if (action === "evaluate") {
      if (!isUuid(record.conversation_id)) return fail("invalid_request", req, operationId, "conversation_id");
      return await handleEvaluate(req, admin, userId, record.conversation_id as string, operationId);
    }
    return await handleReview(req, admin, caller, userId, record, operationId);
  } catch (e) {
    log({ event: "unhandled", name: (e as Error).name, operation_id: operationId });
    return fail("internal_error", req, operationId, "internal_error");
  }
});
