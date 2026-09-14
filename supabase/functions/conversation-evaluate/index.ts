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
import {
  CE_EVALUATOR_MAX_TOKENS,
  validateCeProviderResponse,
} from "../_shared/ce-provider-response.ts";
import { fetchGrounding, type GroundingBundle } from "../_shared/ce-grounding.ts";
import {
  buildCanonicalBundle,
  compareMessageOrder,
  isStrictlyAfterMessage,
  normalizeRole,
  sha256Hex,
  MAX_MESSAGE_CHARS,
  MAX_TRANSCRIPT_CHARS,
  MAX_TRANSCRIPT_MESSAGES,
  CE_DIMENSIONS,
  type CeDimension,
  deriveDiscrepancies,
  DIMENSION_TO_EVALUATOR_TYPE,
  EVALUATOR_PROMPT_VERSION,
  EVALUATOR_SYSTEM_PROMPT,
  SIGNALS_SYSTEM_PROMPT,
  type CanonicalBundle,
  type SnapshotConversation,
  type SnapshotMessage,
  type TranscriptEntry,
  validateSignalsOutput,
  EVALUATOR_RESPONSE_SCHEMA,
} from "../_shared/ce-contract.ts";
import {
  alignB3EvaluatorOutput,
  bindConversionRealityToBundle,
  loadCeConversionReality,
  revalidateCeConversionReality,
  type CeConversionReality,
} from "../_shared/ce-conversion-reality.ts";

const CE_EDGE_RUNTIME_VERSION = "ce-conversation-first-1.0.0";
const PREVIEW_PROJECT_ID = "4dbf593e-577e-4af4-a553-460441c34473";
const PUBLISHED_CONSOLE_ORIGIN = "https://console-chat-hub.lovable.app";

function isApprovedConsoleOrigin(origin: string): boolean {
  if (!origin) return true;
  if (origin === PUBLISHED_CONSOLE_ORIGIN) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.port || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    const lovableProjectHost = `${PREVIEW_PROJECT_ID}.lovableproject.com`;
    if (host === lovableProjectHost) return true;
    const projectSuffix = `--${lovableProjectHost}`;
    if (host.endsWith(projectSuffix)) {
      const prefix = host.slice(0, -projectSuffix.length);
      if (/^[a-z0-9][a-z0-9-]*$/.test(prefix)) return true;
    }
    const legacySuffix = `--${PREVIEW_PROJECT_ID}.lovable.app`;
    if (host.endsWith(legacySuffix)) {
      const prefix = host.slice(0, -legacySuffix.length);
      if (/^id-preview(?:-[a-z0-9-]+)?$/.test(prefix)) return true;
    }
  } catch {
    return false;
  }
  return false;
}
const EVALUATE_ROLES = new Set(["admin", "supervisor", "qa"]);
const REVIEW_ROLES = new Set(["admin", "supervisor"]);
const MAX_BODY_BYTES = 8 * 1024;
const MAX_MESSAGES = 400;
const MAX_NOTE_CHARS = 1000;
// Gemini charges reasoning tokens against maxOutputTokens, so the budget must
// cover thinking plus the JSON object or the reply truncates mid-object.
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
    "Access-Control-Allow-Origin": isApprovedConsoleOrigin(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
function ok(body: Record<string, unknown>, req: Request, operationId: string): Response {
  return new Response(
    JSON.stringify({
      ...body,
      operation_id: operationId,
      runtime_version: CE_EDGE_RUNTIME_VERSION,
    }),
    {
      status: 200,
      headers: { ...corsFor(req), "Content-Type": "application/json" },
    },
  );
}
function fail(error: PublicError, req: Request, operationId: string, detail?: string): Response {
  return new Response(
    JSON.stringify({
      error,
      detail: detail ?? null,
      operation_id: operationId,
      runtime_version: CE_EDGE_RUNTIME_VERSION,
    }),
    {
      status: PUBLIC_ERRORS[error],
      headers: { ...corsFor(req), "Content-Type": "application/json" },
    },
  );
}
function isUuid(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
  );
}
function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header.trim());
  if (!m) return null;
  const token = m[1];
  if (token.length < 20 || token.length > 4096) return null;
  return token;
}
async function readBoundedJson(
  req: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: "too_large" | "unparsable" }> {
  const declared = req.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) return { ok: false, reason: "too_large" };
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES)
    return { ok: false, reason: "too_large" };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: "unparsable" };
  }
}
function log(fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({ component: "conversation-evaluate", ts: new Date().toISOString(), ...fields }),
  );
}

interface TenantContext {
  conversation: SnapshotConversation;
  company: { company_id: string; external_workspace_id: string; external_tenant_id: string };
  roles: string[];
}

const LOCAL_EVALUATOR_SYSTEM_PROMPT: Record<CeDimension, string> = {
  accuracy:
    "Evaluate factual and conversational ACCURACY using only the transcript and any verified human correction. " +
    "Do not assume facts outside the conversation. Penalize contradictions, unsupported specifics, or failure to answer the customer. " +
    "If no verified human correction exists, judge internal consistency and whether the answer directly follows the available conversation evidence. " +
    "Return ONLY JSON with score, justification, grounding_refs, evidence, recommended_correction. grounding_refs MUST be an empty array.",
  policy:
    "Evaluate POLICY / SERVICE-COMPLIANCE using only rules, promises, limits, or constraints stated inside the conversation. " +
    "Do not invent an external policy. If the conversation contains no policy-relevant requirement, judge whether the AI avoided unsupported commitments and unsafe promises. " +
    "Return ONLY JSON with score, justification, grounding_refs, evidence, recommended_correction. grounding_refs MUST be an empty array.",
  tone:
    "Evaluate TONE: professionalism, empathy, clarity and register relative to the customer's state in the transcript. " +
    "Return ONLY JSON with score, justification, grounding_refs, evidence, recommended_correction. grounding_refs MUST be an empty array.",
  sales:
    "Evaluate SALES EFFECTIVENESS against the latest customer correction and current conversation reality: reuse known needs, preserve the current conversion stage, ask only the minimum necessary question, and never reward pressure or unsupported claims. " +
    "Do not penalize a concise support answer or absence of upsell when that is the correct next step. Missing commercial data is unknown, not negative evidence. " +
    "Return ONLY JSON with score, justification, grounding_refs, evidence, recommended_correction. grounding_refs MUST be an empty array.",
  context:
    "Evaluate CONTEXT RETENTION using the latest valid customer correction: known facts must be retained; superseded and cancelled values suppressed; products, entities and regions isolated; quotation, order and action states kept distinct; and the current topic must outrank stale history. " +
    "Return ONLY JSON with score, justification, grounding_refs, evidence, recommended_correction. grounding_refs MUST be an empty array.",
  hallucination_risk:
    "Evaluate HALLUCINATION RISK where higher is worse. A specific claim not supported by the transcript or a verified human correction increases risk. " +
    "Do not require external KB or policy evidence in conversation-local mode. " +
    "Return ONLY JSON with score, justification, grounding_refs, evidence, recommended_correction. grounding_refs MUST be an empty array.",
};

interface EvaluationScope {
  mode: "canonical" | "conversation_local";
  conversation:
    | SnapshotConversation
    | (Omit<SnapshotConversation, "company_id"> & { company_id: string | null });
  company: { company_id: string; external_workspace_id: string; external_tenant_id: string } | null;
  roles: string[];
}

async function resolveEvaluationScope(
  admin: SupabaseClient,
  conversationId: string,
  userId: string,
): Promise<{ ok: true; ctx: EvaluationScope } | { ok: false; error: PublicError; detail: string }> {
  const { data: conv, error: convErr } = await admin
    .from("conversations")
    .select(
      "id, company_id, status, priority, channel_config_id, created_at, resolved_at, assigned_agent_id",
    )
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
    if (channelErr)
      return { ok: false, error: "internal_error", detail: "channel_company_lookup_failed" };
    channelCompanyId = channel?.company_id ? String(channel.company_id) : null;
  }

  const conversationCompanyId = conv.company_id ? String(conv.company_id) : null;
  if (conversationCompanyId && channelCompanyId && conversationCompanyId !== channelCompanyId) {
    return { ok: false, error: "conflict", detail: "tenant_identity_conflict" };
  }
  const resolvedCompanyId = conversationCompanyId ?? channelCompanyId;

  if (resolvedCompanyId) {
    const { data: company, error: coErr } = await admin
      .from("company")
      .select("id, external_workspace_id, external_tenant_id, is_active")
      .eq("id", resolvedCompanyId)
      .maybeSingle();
    if (coErr) return { ok: false, error: "internal_error", detail: "company_lookup_failed" };
    if (!company || !company.is_active)
      return { ok: false, error: "forbidden", detail: "company_inactive" };

    const { data: members, error: memErr } = await admin
      .from("company_membership")
      .select("role")
      .eq("company_id", resolvedCompanyId)
      .eq("user_id", userId)
      .eq("is_active", true);
    if (memErr) return { ok: false, error: "internal_error", detail: "membership_lookup_failed" };
    if (!members || members.length === 0)
      return { ok: false, error: "forbidden", detail: "not_a_member" };

    return {
      ok: true,
      ctx: {
        mode: "canonical",
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

  const { data: flag, error: flagErr } = await admin
    .from("ce_feature_flags")
    .select("enabled")
    .eq("key", "ce_conversation_first_enabled")
    .maybeSingle();
  if (flagErr)
    return { ok: false, error: "internal_error", detail: "conversation_first_flag_lookup_failed" };
  if (!flag?.enabled)
    return { ok: false, error: "unavailable", detail: "conversation_first_disabled" };

  const { data: rolesRows, error: roleErr } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  if (roleErr) return { ok: false, error: "internal_error", detail: "local_role_lookup_failed" };
  const roles = (rolesRows ?? []).map((r: { role: string }) => String(r.role));
  if (!roles.some((r) => EVALUATE_ROLES.has(r))) {
    return { ok: false, error: "forbidden", detail: "role_not_permitted" };
  }

  return {
    ok: true,
    ctx: {
      mode: "conversation_local",
      conversation: { ...conv, company_id: null },
      company: null,
      roles,
    },
  };
}

async function buildConversationOnlyBundle(args: {
  conversation: EvaluationScope["conversation"];
  messages: SnapshotMessage[];
  userId: string;
  roles: string[];
  contractVersion: string;
}): Promise<CanonicalBundle> {
  const ordered = args.messages
    .filter((m) => !m.is_recalled && m.content !== "__THINKING__")
    .slice()
    .sort(compareMessageOrder);

  const entries: TranscriptEntry[] = [];
  let used = 0;

  for (let i = 0; i < ordered.length; i++) {
    const m = ordered[i];
    const role = normalizeRole(m.role);
    const original = m.content.length;
    let body = m.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    let included = true;
    let drop: string | null = null;

    if (i >= MAX_TRANSCRIPT_MESSAGES) {
      included = false;
      drop = "message_limit";
      body = "";
    } else {
      if (body.length > MAX_MESSAGE_CHARS) {
        body = body.slice(0, MAX_MESSAGE_CHARS);
        drop = "message_truncated";
      }
      if (used + body.length > MAX_TRANSCRIPT_CHARS) {
        const room = MAX_TRANSCRIPT_CHARS - used;
        if (room <= 0) {
          included = false;
          drop = "transcript_limit";
          body = "";
        } else {
          body = body.slice(0, room);
          drop = "transcript_truncated";
        }
      }
      if (included) used += body.length;
    }

    entries.push({
      id: m.id,
      role,
      raw_role: m.role,
      created_at: m.created_at,
      content: body,
      content_sha256: await sha256Hex(body),
      original_chars: original,
      used_chars: body.length,
      included,
      drop_reason: drop,
      verified_human:
        role === "human_agent" && m.sender_id !== null && m.sender_identity_verified_at !== null,
    });
  }

  const kept = entries.filter((e) => e.included);
  const aiTurns = kept.filter((e) => e.role === "ai");
  const evaluatedAi = aiTurns.length ? aiTurns[aiTurns.length - 1] : null;
  if (!kept.some((e) => e.role === "customer") || !evaluatedAi) {
    throw new Error("CONVERSATION_NOT_EVALUABLE");
  }

  const humanAfter = kept.find((e) => e.verified_human && isStrictlyAfterMessage(e, evaluatedAi));

  const lines = [
    `CE-BUNDLE/${args.contractVersion}`,
    "## authorization",
    "scope_mode=conversation_local",
    `actor_user_id=${args.userId}`,
    `actor_roles=${[...args.roles].sort().join("|")}`,
    "## conversation",
    `conversation_id=${args.conversation.id}`,
    `channel_config_id=${args.conversation.channel_config_id ?? ""}`,
    `status=${args.conversation.status}`,
    `priority=${args.conversation.priority ?? ""}`,
    `created_at=${args.conversation.created_at}`,
    `resolved_at=${args.conversation.resolved_at ?? ""}`,
    "## evaluated_ai_reply",
    `message_id=${evaluatedAi.id}`,
    `created_at=${evaluatedAi.created_at}`,
    `content_sha256=${evaluatedAi.content_sha256}`,
    "content:",
    evaluatedAi.content,
    "## verified_human_response",
    `message_id=${humanAfter?.id ?? ""}`,
    `created_at=${humanAfter?.created_at ?? ""}`,
    `content_sha256=${humanAfter?.content_sha256 ?? ""}`,
    "content:",
    humanAfter?.content ?? "",
    "## transcript",
    `message_count=${kept.length}`,
  ];
  for (const e of kept) {
    lines.push(
      `#${e.id}`,
      `role=${e.role}`,
      `created_at=${e.created_at}`,
      "content:",
      e.content,
      "--",
    );
  }
  lines.push(
    "## evaluation_evidence",
    "mode=conversation_only",
    "No external KB or policy source is required in this pre-activation mode.",
    "## end",
  );

  const text = lines.join("\n") + "\n";
  const transcriptHash = await sha256Hex(
    kept.map((e) => `${e.id}:${e.content_sha256}`).join("\n") + "\n",
  );

  return {
    text,
    bundle_hash: await sha256Hex(text),
    transcript_hash: transcriptHash,
    transcript: entries,
    evaluated_ai_reply: {
      id: evaluatedAi.id,
      created_at: evaluatedAi.created_at,
      content_sha256: evaluatedAi.content_sha256,
    },
    verified_human_response: humanAfter
      ? {
          id: humanAfter.id,
          created_at: humanAfter.created_at,
          content_sha256: humanAfter.content_sha256,
        }
      : null,
    truncation: {
      messages_returned: entries.length,
      messages_included: kept.length,
      messages_dropped: entries.length - kept.length,
      chars_used: used,
      truncated: entries.some((e) => e.drop_reason !== null),
    },
  };
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
    if (channelErr)
      return { ok: false, error: "internal_error", detail: "channel_company_lookup_failed" };
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
  if (!company || !company.is_active)
    return { ok: false, error: "forbidden", detail: "company_inactive" };

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
  if (!members || members.length === 0)
    return { ok: false, error: "forbidden", detail: "not_a_member" };

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
  companyId: string | null,
  conversationId: string,
  systemOverride?: string,
): Promise<
  | {
      ok: true;
      score: number;
      justification: string;
      evidence: string[];
      grounding_refs: string[];
      recommended_correction: string;
      model: string;
      raw: Record<string, unknown>;
    }
  | { ok: false; code: string }
> {
  const res = await callModel({
    purpose: "evaluation",
    system: systemOverride ?? EVALUATOR_SYSTEM_PROMPT[dimension],
    user: bundleText,
    maxTokens: CE_EVALUATOR_MAX_TOKENS,
    operationId: `${operationId}:${dimension}`,
    companyId,
    conversationId,
    tag: `ce:${dimension}`,
    responseFormat: "json",
    responseSchema: EVALUATOR_RESPONSE_SCHEMA,
  });
  if (!res.ok) return { ok: false, code: toCeErrorCode(res.code) };
  const validated = validateCeProviderResponse(res.text, knownChunkIds);
  if (!validated.ok) {
    // Shape-only diagnosis; never provider text or customer content.
    log({
      event: "evaluator_output_invalid",
      dimension,
      operation_id: operationId,
      reason: validated.reason,
    });
    return { ok: false, code: "CE_PROVIDER_INVALID_OUTPUT" };
  }
  return {
    ok: true,
    ...validated.value,
    model: res.model,
    raw: validated.raw,
  };
}

async function runSignals(
  bundleText: string,
  transcript: Parameters<typeof validateSignalsOutput>[1],
  operationId: string,
  companyId: string | null,
  conversationId: string,
): Promise<ReturnType<typeof validateSignalsOutput>> {
  const res = await callModel({
    purpose: "evaluation",
    system: SIGNALS_SYSTEM_PROMPT,
    user: bundleText,
    maxTokens: CE_EVALUATOR_MAX_TOKENS,
    operationId: `${operationId}:signals`,
    companyId,
    conversationId,
    tag: "ce:signals",
    responseFormat: "json",
  });
  if (!res.ok) {
    log({ event: "signals_unavailable", code: res.code, operation_id: operationId });
    return null;
  }
  const signals = validateSignalsOutput(parseJsonObject(res.text), transcript);
  if (!signals) log({ event: "signals_invalid", operation_id: operationId });
  return signals;
}

async function terminateAttempt(
  admin: SupabaseClient,
  attemptId: string,
  code: string,
  operationId: string,
): Promise<void> {
  const { data, error } = await admin.rpc("fail_evaluation", {
    p_attempt_id: attemptId,
    p_error: code,
  });
  const result = String(((data ?? {}) as Record<string, unknown>).result ?? "");
  if (error || result !== "failed") {
    log({
      event: "fail_rpc_unconfirmed",
      attempt_id: attemptId,
      result,
      operation_id: operationId,
    });
    await admin.rpc("reap_stale_evaluation_attempts", { p_older_than: "0 minutes" }).then(
      () => undefined,
      () => undefined,
    );
  }
}
async function readBackEvaluation(
  admin: SupabaseClient,
  attemptId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from("conversation_evaluation")
    .select(
      "id, conversation_id, overall_score, severity, review_status, training_eligible, has_verified_human_response, input_snapshot_hash, bundle_hash, evaluation_contract_version, created_at",
    )
    .eq("attempt_id", attemptId)
    .maybeSingle();
  return (data as unknown as Record<string, unknown>) ?? null;
}

async function readBackLocalEvaluation(
  admin: SupabaseClient,
  attemptId: string,
): Promise<Record<string, unknown> | null> {
  const { data } = await admin
    .from("ce_local_evaluation")
    .select(
      "id, conversation_id, overall_score, severity, review_status, has_verified_human_response, input_snapshot_hash, bundle_hash, evaluation_contract_version, created_at",
    )
    .eq("attempt_id", attemptId)
    .maybeSingle();
  return data
    ? { ...(data as Record<string, unknown>), evaluation_source: "conversation_local" }
    : null;
}

/** True when a Postgres error is the attempt uniqueness violation. */
function isDuplicateAttempt(error: unknown): boolean {
  const e = (error ?? {}) as { code?: string; message?: string };
  return (
    e.code === "23505" ||
    String(e.message ?? "").includes("ce_local_evaluation_attempt_conversation_id_input_snapshot_")
  );
}

/**
 * Delete a spent (`failed`, no evaluation row) local attempt so an identical
 * snapshot can be re-evaluated. Running or succeeded attempts are never
 * touched, so in-flight and already-evaluated semantics are unchanged.
 */
async function clearSpentLocalAttempt(
  admin: SupabaseClient,
  conversationId: string,
  inputSnapshotHash: string,
): Promise<boolean> {
  const { data: attempt, error } = await admin
    .from("ce_local_evaluation_attempt")
    .select("id, status")
    .eq("conversation_id", conversationId)
    .eq("input_snapshot_hash", inputSnapshotHash)
    .maybeSingle();
  if (error || !attempt || String(attempt.status) !== "failed") return false;

  const attemptId = String(attempt.id);
  const { data: existing } = await admin
    .from("ce_local_evaluation")
    .select("id")
    .eq("attempt_id", attemptId)
    .maybeSingle();
  if (existing) return false;

  const { error: delError } = await admin
    .from("ce_local_evaluation_attempt")
    .delete()
    .eq("id", attemptId)
    .eq("status", "failed");
  return !delError;
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

  const scope = await resolveEvaluationScope(admin, conversationId, userId);
  if (!scope.ok) return fail(scope.error, req, operationId, scope.detail);
  const { conversation, company, roles, mode } = scope.ctx;

  if (!roles.some((r) => EVALUATE_ROLES.has(r))) {
    return fail("forbidden", req, operationId, "role_not_permitted");
  }

  const { data: msgs, error: msgErr } = await admin
    .from("messages")
    .select(
      "id, role, content, created_at, is_recalled, sender_id, sender_identity_verified_at, metadata",
    )
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_MESSAGES + 1);

  if (msgErr) return fail("internal_error", req, operationId, "messages_lookup_failed");
  if (!msgs || msgs.length === 0) return fail("conflict", req, operationId, "conversation_empty");
  if (msgs.length > MAX_MESSAGES)
    return fail("payload_too_large", req, operationId, "conversation_too_long");

  let bundle: CanonicalBundle;
  let knownChunkIds = new Set<string>();
  let kbSnapshotId = "conversation-only";
  let policySnapshotId = "conversation-only";
  let groundingManifest: Record<string, unknown> = { mode: "conversation_only" };
  let conversionReality: CeConversionReality | null = null;
  let evaluatedAssistantMetadata: Record<string, unknown> | null = null;

  if (mode === "canonical") {
    const lastCustomer = [...(msgs as SnapshotMessage[])]
      .reverse()
      .find(
        (m) => !m.is_recalled && ["visitor", "customer", "user"].includes(m.role.toLowerCase()),
      );
    const grounding = await fetchGrounding({
      conversationId,
      messageId: lastCustomer?.id,
      company: company!,
      query: redact(lastCustomer?.content ?? ""),
      riskLevel: "high",
      requirePolicyEvidence: true,
    });
    if (!grounding.ok) {
      log({ event: "grounding_failed", code: grounding.code, operation_id: operationId });
      return fail("unavailable", req, operationId, "grounding_unavailable");
    }
    const bundleGrounding: GroundingBundle = grounding.bundle;
    try {
      bundle = await buildCanonicalBundle({
        conversation: conversation as SnapshotConversation,
        messages: msgs as SnapshotMessage[],
        actor: { user_id: userId, company_id: company!.company_id, roles },
        grounding: bundleGrounding,
        contractVersion,
      });
      const evaluatedAssistant = (msgs as SnapshotMessage[]).find(
        (message) => message.id === bundle.evaluated_ai_reply?.id,
      );
      const reality = await loadCeConversionReality(
        admin as unknown as Parameters<typeof loadCeConversionReality>[0],
        {
          conversation_id: conversationId,
          company_id: company!.company_id,
          conversation_status: String(conversation.status ?? ""),
          assigned_agent_id: conversation.assigned_agent_id ?? null,
          evaluated_assistant: {
            id: bundle.evaluated_ai_reply?.id ?? "",
            metadata: evaluatedAssistant?.metadata ?? null,
          },
        },
      );
      if (!reality.ok) {
        return fail("conflict", req, operationId, reality.code.toLowerCase());
      }
      conversionReality = reality.reality;
      evaluatedAssistantMetadata = evaluatedAssistant?.metadata ?? null;
      bundle = await bindConversionRealityToBundle(bundle, conversionReality);
    } catch {
      return fail("forbidden", req, operationId, "tenant_mismatch");
    }
    kbSnapshotId = bundleGrounding.kb_snapshot_id;
    policySnapshotId = bundleGrounding.policy_snapshot_id;
    groundingManifest = bundleGrounding.manifest as unknown as Record<string, unknown>;
    knownChunkIds = new Set(
      [...bundleGrounding.kb_chunks, ...bundleGrounding.policy_chunks]
        .filter((c) => c.included)
        .map((c) => c.chunk_id),
    );
  } else {
    try {
      bundle = await buildConversationOnlyBundle({
        conversation,
        messages: msgs as SnapshotMessage[],
        userId,
        roles,
        contractVersion,
      });
    } catch {
      return fail("conflict", req, operationId, "conversation_not_evaluable");
    }
  }

  let attemptId: string;

  if (mode === "canonical") {
    await admin
      .rpc("reap_stale_evaluation_attempts", {
        p_older_than: `${STALE_ATTEMPT_MINUTES} minutes`,
      })
      .then(
        () => undefined,
        () => undefined,
      );

    const { data: initRaw, error: initErr } = await admin.rpc("initiate_evaluation_v2", {
      p_conversation_id: conversationId,
      p_contract_version: contractVersion,
      p_kb_snapshot_id: kbSnapshotId,
      p_policy_snapshot_id: policySnapshotId,
      p_model_version: Deno.env.get("LLM_MODEL_EVALUATION") ?? "",
      p_prompt_version: EVALUATOR_PROMPT_VERSION,
      p_input_snapshot_hash: bundle.transcript_hash,
      p_bundle_hash: bundle.bundle_hash,
      p_grounding_manifest: groundingManifest,
      p_initiated_by: userId,
      p_source_deployment: sourceDeployment,
    });
    if (initErr) return fail("internal_error", req, operationId, "initiate_failed");
    const init = (initRaw ?? {}) as Record<string, unknown>;
    const initResult = String(init.result ?? "");
    if (initResult === "already_evaluated") {
      if (conversionReality) {
        const current = await revalidateCeConversionReality(
          admin as unknown as Parameters<typeof revalidateCeConversionReality>[0],
          conversionReality,
        );
        if (!current.ok) return fail("conflict", req, operationId, current.code.toLowerCase());
      }
      const { data: existing } = await admin
        .from("conversation_evaluation")
        .select("id, conversation_id, overall_score, severity, review_status, created_at")
        .eq("id", String(init.evaluation_id ?? ""))
        .maybeSingle();
      return ok({ status: "already_evaluated", evaluation: existing ?? null }, req, operationId);
    }
    if (initResult === "already_in_progress")
      return fail("conflict", req, operationId, "already_in_progress");
    if (initResult === "feature_disabled")
      return fail("unavailable", req, operationId, "feature_disabled");
    if (initResult === "tenant_unresolved")
      return fail("conflict", req, operationId, "tenant_unresolved");
    if (initResult === "tenant_identity_conflict")
      return fail("conflict", req, operationId, "tenant_identity_conflict");
    if (initResult === "tenant_forbidden")
      return fail("forbidden", req, operationId, "tenant_forbidden");
    if (initResult !== "initiated" || !isUuid(init.attempt_id))
      return fail("conflict", req, operationId, "initiate_rejected");
    attemptId = init.attempt_id as string;
  } else {
    const localInitiateArgs = {
      p_conversation_id: conversationId,
      p_contract_version: contractVersion,
      p_input_snapshot_hash: bundle.transcript_hash,
      p_bundle_hash: bundle.bundle_hash,
      p_model_version: Deno.env.get("LLM_MODEL_EVALUATION") ?? "",
      p_prompt_version: EVALUATOR_PROMPT_VERSION,
      p_initiated_by: userId,
      p_source_deployment: sourceDeployment,
    };

    let { data: initRaw, error: initErr } = await admin.rpc(
      "initiate_local_evaluation_v1",
      localInitiateArgs,
    );

    // `ce_local_evaluation_attempt` is unique on (conversation_id,
    // input_snapshot_hash). A terminal `failed` attempt for the same snapshot
    // therefore permanently blocked every retry with a raw unique violation.
    // Clearing that spent attempt (only when it is `failed` and produced no
    // evaluation row) restores retryability without touching canonical
    // behaviour, company binding or evaluation contracts.
    if (initErr && isDuplicateAttempt(initErr)) {
      log({
        event: "local_initiate_duplicate_attempt",
        code: (initErr as { code?: string }).code ?? "",
        operation_id: operationId,
      });
      const cleared = await clearSpentLocalAttempt(admin, conversationId, bundle.transcript_hash);
      if (cleared) {
        const retry = await admin.rpc("initiate_local_evaluation_v1", localInitiateArgs);
        initRaw = retry.data;
        initErr = retry.error;
      }
    }

    if (initErr) {
      log({
        event: "local_initiate_failed",
        code: (initErr as { code?: string }).code ?? "",
        operation_id: operationId,
      });
      return fail("internal_error", req, operationId, "local_initiate_failed");
    }

    const init = (initRaw ?? {}) as Record<string, unknown>;
    const result = String(init.result ?? "");
    if (result === "already_evaluated") {
      const { data: existing } = await admin
        .from("ce_local_evaluation")
        .select("id, conversation_id, overall_score, severity, review_status, created_at")
        .eq("id", String(init.evaluation_id ?? ""))
        .maybeSingle();
      return ok(
        {
          status: "already_evaluated",
          evaluation: existing ? { ...existing, evaluation_source: "conversation_local" } : null,
        },
        req,
        operationId,
      );
    }
    if (result === "already_in_progress")
      return fail("conflict", req, operationId, "already_in_progress");
    if (result === "feature_disabled")
      return fail("unavailable", req, operationId, "feature_disabled");
    if (result === "forbidden") return fail("forbidden", req, operationId, "role_not_permitted");
    if (result === "conversation_not_evaluable")
      return fail("conflict", req, operationId, "conversation_not_evaluable");
    if (result !== "initiated" || !isUuid(init.attempt_id)) {
      return fail("conflict", req, operationId, "local_initiate_rejected");
    }
    attemptId = init.attempt_id as string;
  }

  const settled = await Promise.all(
    CE_DIMENSIONS.map((d) =>
      runEvaluator(
        d,
        bundle.text,
        knownChunkIds,
        operationId,
        company?.company_id ?? null,
        conversationId,
        mode === "conversation_local" ? LOCAL_EVALUATOR_SYSTEM_PROMPT[d] : undefined,
      ),
    ),
  );

  const firstFailure = settled.find((r) => !r.ok) as { ok: false; code: string } | undefined;
  if (firstFailure) {
    if (mode === "canonical") {
      await terminateAttempt(admin, attemptId, firstFailure.code, operationId);
    } else {
      await admin
        .rpc("fail_local_evaluation_v1", {
          p_attempt_id: attemptId,
          p_error: firstFailure.code,
        })
        .then(
          () => undefined,
          () => undefined,
        );
    }
    return fail("provider_failed", req, operationId, firstFailure.code);
  }

  const aiText = bundle.evaluated_ai_reply
    ? (bundle.transcript.find((e) => e.id === bundle.evaluated_ai_reply!.id)?.content ?? "")
    : "";
  const evaluated = settled.map((result, index) => {
    if (!result.ok || !conversionReality) return result;
    const dimension = CE_DIMENSIONS[index];
    if (dimension !== "sales" && dimension !== "context") return result;
    const aligned = alignB3EvaluatorOutput(
      dimension,
      result,
      aiText,
      conversionReality,
      evaluatedAssistantMetadata,
    );
    return { ...result, ...aligned };
  });

  const scores: Record<string, number> = {};
  const details: Record<string, unknown> = {};
  CE_DIMENSIONS.forEach((dimension, i) => {
    const r = evaluated[i] as Extract<(typeof evaluated)[number], { ok: true }>;
    scores[dimension] = r.score;
    details[DIMENSION_TO_EVALUATOR_TYPE[dimension]] = {
      evaluator_type: DIMENSION_TO_EVALUATOR_TYPE[dimension],
      raw_score: r.score,
      weight:
        dimension === "accuracy"
          ? 0.25
          : dimension === "policy"
            ? 0.2
            : dimension === "tone"
              ? 0.2
              : dimension === "sales"
                ? 0.15
                : 0.1,
      weighted_score:
        dimension === "hallucination_risk"
          ? (100 - r.score) * 0.1
          : r.score *
            (dimension === "accuracy"
              ? 0.25
              : dimension === "policy"
                ? 0.2
                : dimension === "tone"
                  ? 0.2
                  : dimension === "sales"
                    ? 0.15
                    : 0.1),
      justification: r.justification,
      recommended_correction: r.recommended_correction,
      model_version: r.model,
      prompt_version: EVALUATOR_PROMPT_VERSION,
      grounding_refs: r.grounding_refs,
      raw_llm_response: {
        dimension,
        score: r.score,
        evidence: r.evidence,
        grounding_refs: r.grounding_refs,
        provider_output: r.raw,
      },
    };
  });

  const signals = await runSignals(
    bundle.text,
    bundle.transcript,
    operationId,
    company?.company_id ?? null,
    conversationId,
  );

  const humanText = bundle.verified_human_response
    ? (bundle.transcript.find((e) => e.id === bundle.verified_human_response!.id)?.content ?? "")
    : "";

  const discrepancies = deriveDiscrepancies({
    evaluatedAiReply: aiText,
    verifiedHumanResponse: humanText,
    perDimension: CE_DIMENSIONS.map((dimension, i) => {
      const r = evaluated[i] as Extract<(typeof evaluated)[number], { ok: true }>;
      return {
        evaluatorType: DIMENSION_TO_EVALUATOR_TYPE[dimension],
        score: r.score,
        recommendedCorrection: r.recommended_correction,
        groundingRefs: r.grounding_refs,
      };
    }),
  });

  const snapshot = {
    transcript_hash: bundle.transcript_hash,
    canonical_input: redact(bundle.text),
    normalized_transcript: bundle.transcript
      .filter((e) => e.included)
      .map((e) => ({
        id: e.id,
        role: e.role,
        raw_role: e.raw_role,
        created_at: e.created_at,
        content: redact(e.content),
        content_sha256: e.content_sha256,
        original_chars: e.original_chars,
        used_chars: e.used_chars,
      })),
    evaluated_ai_reply: bundle.evaluated_ai_reply
      ? { ...bundle.evaluated_ai_reply, content: redact(aiText) }
      : null,
    verified_human_response: bundle.verified_human_response
      ? { ...bundle.verified_human_response, content: redact(humanText) }
      : null,
    grounding_evidence:
      mode === "conversation_local"
        ? { mode: "conversation_only" }
        : {
            kb_snapshot_id: kbSnapshotId,
            policy_snapshot_id: policySnapshotId,
            b3_conversion_reality: conversionReality,
          },
    truncation_manifest: bundle.truncation,
  };

  const derived = {
    emotion: signals?.emotion ?? [],
    next_steps: signals?.next_steps ?? [],
    discrepancies,
  };

  if (conversionReality) {
    const current = await revalidateCeConversionReality(
      admin as unknown as Parameters<typeof revalidateCeConversionReality>[0],
      conversionReality,
    );
    if (!current.ok) {
      await terminateAttempt(admin, attemptId, current.code, operationId);
      return fail("conflict", req, operationId, current.code.toLowerCase());
    }
  }

  if (mode === "conversation_local") {
    const { data: doneRaw, error: doneErr } = await admin.rpc("complete_local_evaluation_v1", {
      p_attempt_id: attemptId,
      p_scores: scores,
      p_details: details,
      p_bundle_hash: bundle.bundle_hash,
      p_snapshot: snapshot,
      p_derived: derived,
    });
    if (
      doneErr ||
      String((doneRaw as Record<string, unknown> | null)?.result ?? "") !== "success"
    ) {
      const readBack = await readBackLocalEvaluation(admin, attemptId);
      if (readBack) return ok({ status: "completed", evaluation: readBack }, req, operationId);
      await admin
        .rpc("fail_local_evaluation_v1", {
          p_attempt_id: attemptId,
          p_error: "CE_LOCAL_PERSISTENCE_ERROR",
        })
        .then(
          () => undefined,
          () => undefined,
        );
      return fail("internal_error", req, operationId, "local_persist_failed");
    }
    const evaluation = await readBackLocalEvaluation(admin, attemptId);
    if (!evaluation) return fail("internal_error", req, operationId, "local_persist_unverified");
    return ok(
      {
        status: "completed",
        evaluation,
        evaluation_source: "conversation_local",
        grounding: { mode: "conversation_only" },
      },
      req,
      operationId,
    );
  }

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
  return ok({ status: "completed", evaluation }, req, operationId);
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
    if (trimmed.length > MAX_NOTE_CHARS)
      return fail("invalid_request", req, operationId, "note_too_long");
    note = trimmed.length > 0 ? trimmed : null;
  }
  if (decision === "reject" && !note)
    return fail("invalid_request", req, operationId, "note_required");

  const tenant = await resolveTenant(admin, conversationId as string, userId);
  if (!tenant.ok) return fail(tenant.error, req, operationId, tenant.detail);
  if (!tenant.ctx.roles.some((r) => REVIEW_ROLES.has(r)))
    return fail("forbidden", req, operationId, "role_not_permitted");

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
    return ok(
      {
        status: "reviewed",
        from: out.from,
        to: out.to,
        reviewed_at: out.reviewed_at,
        training_eligible: out.training_eligible,
        outbox_created: out.outbox_created,
      },
      req,
      operationId,
    );
  }
  if (result === "not_found") return fail("not_found", req, operationId, "not_found");
  if (result === "scope_mismatch") return fail("conflict", req, operationId, "scope_mismatch");
  if (result === "invalid_transition")
    return fail("conflict", req, operationId, "invalid_transition");
  if (result === "forbidden") return fail("forbidden", req, operationId, "role_not_permitted");
  if (result === "tenant_unresolved")
    return fail("conflict", req, operationId, "tenant_unresolved");
  if (result === "note_required") return fail("invalid_request", req, operationId, "note_required");
  return fail("conflict", req, operationId, "review_rejected");
}

Deno.serve(async (req) => {
  const operationId = crypto.randomUUID();
  const origin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") {
    if (!isApprovedConsoleOrigin(origin)) return new Response(null, { status: 403 });
    return new Response(null, { headers: corsFor(req) });
  }
  if (req.method !== "POST") return fail("invalid_request", req, operationId, "method_not_allowed");
  if (origin && !isApprovedConsoleOrigin(origin)) {
    return new Response(
      JSON.stringify({
        error: "forbidden",
        detail: "origin",
        operation_id: operationId,
        runtime_version: CE_EDGE_RUNTIME_VERSION,
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      },
    );
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
    if (!body || typeof body !== "object" || Array.isArray(body))
      return fail("invalid_request", req, operationId, "body_shape");
    const record = body as Record<string, unknown>;
    const action = typeof record.action === "string" ? record.action : "evaluate";
    const allowed = ALLOWED_FIELDS[action];
    if (!allowed) return fail("invalid_request", req, operationId, "action");
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) return fail("invalid_request", req, operationId, "unknown_field");
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    if (action === "evaluate") {
      if (!isUuid(record.conversation_id))
        return fail("invalid_request", req, operationId, "conversation_id");
      return await handleEvaluate(
        req,
        admin,
        userId,
        record.conversation_id as string,
        operationId,
      );
    }
    return await handleReview(req, admin, caller, userId, record, operationId);
  } catch (e) {
    log({ event: "unhandled", name: (e as Error).name, operation_id: operationId });
    return fail("internal_error", req, operationId, "internal_error");
  }
});
