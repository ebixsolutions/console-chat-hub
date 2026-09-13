/**
 * PR29 Task 2 — shared automatic Conversation Evaluation engine.
 *
 * All model calls still go through _shared/llm-router.ts. This engine exists so
 * cron and authenticated CE dwell/manual requests execute the same queue job.
 * It never accepts a browser-supplied company id.
 */
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";
import { callModel, parseJsonObject, redact, toCeErrorCode } from "./llm-router.ts";
import { fetchGrounding, type GroundingBundle } from "./ce-grounding.ts";
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
  DIMENSION_TO_EVALUATOR_TYPE,
  DIMENSION_WEIGHT,
  EVALUATOR_PROMPT_VERSION,
  EVALUATOR_SYSTEM_PROMPT,
  SIGNALS_SYSTEM_PROMPT,
  EVALUATOR_RESPONSE_SCHEMA,
  validateEvaluatorOutput,
  validateSignalsOutput,
  deriveDiscrepancies,
  type CeDimension,
  type CanonicalBundle,
  type SnapshotConversation,
  type SnapshotMessage,
  type TranscriptEntry,
} from "./ce-contract.ts";
import {
  alignB3EvaluatorOutput,
  bindConversionRealityToBundle,
  loadCeConversionReality,
  revalidateCeConversionReality,
  type CeConversionReality,
} from "./ce-conversion-reality.ts";

const MAX_MESSAGES = 400;
const EVALUATOR_MAX_TOKENS = 2600;
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000001";
export const AUTOMATION_SOURCE_DEPLOYMENT = "nexusai-pr29-task2-auto-eval-1.0.0";

type Db = SupabaseClient;

export const LOCAL_EVALUATOR_SYSTEM_PROMPT: Record<CeDimension, string> = {
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

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function computeMethodology() {
  const promptManifest = {
    version: EVALUATOR_PROMPT_VERSION,
    canonical: EVALUATOR_SYSTEM_PROMPT,
    local: LOCAL_EVALUATOR_SYSTEM_PROMPT,
    signals: SIGNALS_SYSTEM_PROMPT,
  };
  const promptHash = await sha256Hex(stable(promptManifest));
  const scoringHash = await sha256Hex(stable(DIMENSION_WEIGHT));
  const schemaHash = await sha256Hex(stable(EVALUATOR_RESPONSE_SCHEMA));
  return {
    promptHash,
    scoringHash,
    schemaHash,
    promptVersion: EVALUATOR_PROMPT_VERSION,
  };
}

export async function ensureCurrentMethodology(admin: Db): Promise<string> {
  const contractVersion = Deno.env.get("CE_CONTRACT_VERSION") ?? "";
  if (!contractVersion.trim()) throw new Error("CE_CONTRACT_VERSION_MISSING");
  const m = await computeMethodology();
  const { data, error } = await admin.rpc("ce_activate_evaluation_methodology_v1", {
    p_contract_version: contractVersion,
    p_prompt_version: m.promptVersion,
    p_prompt_hash: m.promptHash,
    p_scoring_config_hash: m.scoringHash,
    p_evaluator_schema_hash: m.schemaHash,
    p_mark_existing_stale: false,
  });
  if (error || String((data as Record<string, unknown> | null)?.result ?? "") !== "success") {
    throw new Error("CE_METHODOLOGY_ACTIVATION_FAILED");
  }
  return String((data as Record<string, unknown>).evaluation_fingerprint);
}

async function buildLocalBundle(args: {
  conversation: Omit<SnapshotConversation, "company_id"> & { company_id: string | null };
  messages: SnapshotMessage[];
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
    `actor_user_id=${SYSTEM_ACTOR}`,
    "actor_roles=automation",
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

async function runEvaluator(
  dimension: CeDimension,
  bundle: string,
  knownChunkIds: ReadonlySet<string>,
  operationId: string,
  companyId: string | null,
  conversationId: string,
  local: boolean,
) {
  const res = await callModel({
    purpose: "evaluation",
    system: local ? LOCAL_EVALUATOR_SYSTEM_PROMPT[dimension] : EVALUATOR_SYSTEM_PROMPT[dimension],
    user: bundle,
    maxTokens: EVALUATOR_MAX_TOKENS,
    operationId: `${operationId}:${dimension}`,
    companyId,
    conversationId,
    tag: `ce:auto:${dimension}`,
    responseFormat: "json",
    responseSchema: EVALUATOR_RESPONSE_SCHEMA,
  });
  if (!res.ok) return { ok: false as const, code: toCeErrorCode(res.code) };
  const parsed = parseJsonObject(res.text);
  const out = validateEvaluatorOutput(parsed, knownChunkIds);
  if (!out) return { ok: false as const, code: "CE_PROVIDER_INVALID_OUTPUT" };
  return { ok: true as const, ...out, model: res.model, raw: parsed! };
}

async function runSignals(
  bundle: string,
  transcript: TranscriptEntry[],
  operationId: string,
  companyId: string | null,
  conversationId: string,
) {
  const res = await callModel({
    purpose: "evaluation",
    system: SIGNALS_SYSTEM_PROMPT,
    user: bundle,
    maxTokens: EVALUATOR_MAX_TOKENS,
    operationId: `${operationId}:signals`,
    companyId,
    conversationId,
    tag: "ce:auto:signals",
    responseFormat: "json",
  });
  if (!res.ok) return null;
  return validateSignalsOutput(parseJsonObject(res.text), transcript);
}

async function failAttempt(admin: Db, local: boolean, attemptId: string, code: string) {
  if (local) {
    await admin
      .rpc("fail_local_evaluation_v1", {
        p_attempt_id: attemptId,
        p_error: code,
      })
      .then(
        () => undefined,
        () => undefined,
      );
  } else {
    await admin
      .rpc("fail_evaluation", {
        p_attempt_id: attemptId,
        p_error: code,
      })
      .then(
        () => undefined,
        () => undefined,
      );
  }
}

async function readEvaluation(admin: Db, local: boolean, attemptId: string) {
  const table = local ? "ce_local_evaluation" : "conversation_evaluation";
  const { data } = await admin
    .from(table)
    .select("id, conversation_id, input_snapshot_hash, evaluation_fingerprint, created_at")
    .eq("attempt_id", attemptId)
    .maybeSingle();
  return data as Record<string, unknown> | null;
}

export interface AutomationJob {
  id: string;
  conversation_id: string;
  company_id: string | null;
  snapshot_hash: string;
  evaluation_fingerprint: string;
  expected_revision: number;
  source: string;
  attempts: number;
  max_attempts: number;
}

export async function processEvaluationJob(
  admin: Db,
  job: AutomationJob,
): Promise<{ ok: boolean; code?: string; evaluationId?: string; freshness?: string }> {
  const operationId = `auto:${job.id}:${crypto.randomUUID()}`;
  const contractVersion = Deno.env.get("CE_CONTRACT_VERSION") ?? "";
  const sourceDeployment = Deno.env.get("CE_SOURCE_DEPLOYMENT") ?? AUTOMATION_SOURCE_DEPLOYMENT;
  const model = Deno.env.get("LLM_MODEL_EVALUATION") ?? "";

  try {
    const { data: conv, error: convErr } = await admin
      .from("conversations")
      .select(
        "id, company_id, status, priority, channel_config_id, created_at, resolved_at, assigned_agent_id",
      )
      .eq("id", job.conversation_id)
      .maybeSingle();
    if (convErr || !conv) throw new Error("conversation_lookup_failed");

    let channelCompany: string | null = null;
    if (conv.channel_config_id) {
      const { data: ch } = await admin
        .from("channel_config")
        .select("company_id")
        .eq("id", conv.channel_config_id)
        .maybeSingle();
      channelCompany = ch?.company_id ? String(ch.company_id) : null;
    }
    const companyId = conv.company_id ? String(conv.company_id) : channelCompany;
    if (
      companyId &&
      channelCompany &&
      conv.company_id &&
      String(conv.company_id) !== channelCompany
    ) {
      throw new Error("tenant_identity_conflict");
    }
    if ((job.company_id ?? null) !== (companyId ?? null)) throw new Error("tenant_job_mismatch");

    const { data: messages, error: msgErr } = await admin
      .from("messages")
      .select(
        "id, role, content, created_at, is_recalled, sender_id, sender_identity_verified_at, metadata",
      )
      .eq("conversation_id", job.conversation_id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(MAX_MESSAGES + 1);
    if (msgErr || !messages || messages.length === 0) throw new Error("messages_lookup_failed");
    if (messages.length > MAX_MESSAGES) throw new Error("conversation_too_long");

    let bundle: CanonicalBundle;
    let knownChunkIds = new Set<string>();
    let kbSnapshotId = "conversation-only";
    let policySnapshotId = "conversation-only";
    let groundingManifest: Record<string, unknown> = { mode: "conversation_only" };
    const local = companyId === null;
    let conversionReality: CeConversionReality | null = null;
    let evaluatedAssistantMetadata: Record<string, unknown> | null = null;

    if (local) {
      bundle = await buildLocalBundle({
        conversation: { ...conv, company_id: null },
        messages: messages as SnapshotMessage[],
        contractVersion,
      });
    } else {
      const canonicalCompanyId = companyId;
      if (!canonicalCompanyId) throw new Error("canonical_company_unresolved");

      const { data: company, error: companyErr } = await admin
        .from("company")
        .select("id, external_workspace_id, external_tenant_id, is_active")
        .eq("id", canonicalCompanyId)
        .maybeSingle();
      if (companyErr || !company || !company.is_active) throw new Error("company_unavailable");

      const lastCustomer = [...(messages as SnapshotMessage[])]
        .reverse()
        .find(
          (m) => !m.is_recalled && ["visitor", "customer", "user"].includes(m.role.toLowerCase()),
        );
      const grounding = await fetchGrounding({
        conversationId: job.conversation_id,
        messageId: lastCustomer?.id,
        company: {
          company_id: String(company.id),
          external_workspace_id: String(company.external_workspace_id),
          external_tenant_id: String(company.external_tenant_id),
        },
        query: redact(lastCustomer?.content ?? ""),
        // Missing applicable policy evidence is a governed policy-gap signal,
        // not a reason to suppress the other realtime CE dimensions. The
        // grounding manifest preserves policy_gap=true for the policy evaluator.
        riskLevel: "high",
        requirePolicyEvidence: false,
      });
      if (!grounding.ok) throw new Error(`grounding:${grounding.code}`);
      const g: GroundingBundle = grounding.bundle;
      bundle = await buildCanonicalBundle({
        conversation: { ...conv, company_id: canonicalCompanyId } as SnapshotConversation,
        messages: messages as SnapshotMessage[],
        actor: { user_id: SYSTEM_ACTOR, company_id: canonicalCompanyId, roles: ["automation"] },
        grounding: g,
        contractVersion,
      });
      const evaluatedAssistant = (messages as SnapshotMessage[]).find(
        (message) => message.id === bundle.evaluated_ai_reply?.id,
      );
      const reality = await loadCeConversionReality(
        admin as unknown as Parameters<typeof loadCeConversionReality>[0],
        {
          conversation_id: job.conversation_id,
          company_id: canonicalCompanyId,
          conversation_status: String(conv.status ?? ""),
          assigned_agent_id: conv.assigned_agent_id ? String(conv.assigned_agent_id) : null,
          evaluated_assistant: {
            id: bundle.evaluated_ai_reply?.id ?? "",
            metadata: evaluatedAssistant?.metadata ?? null,
          },
        },
      );
      if (!reality.ok) throw new Error(reality.code);
      conversionReality = reality.reality;
      evaluatedAssistantMetadata = evaluatedAssistant?.metadata ?? null;
      bundle = await bindConversionRealityToBundle(bundle, conversionReality);
      kbSnapshotId = g.kb_snapshot_id;
      policySnapshotId = g.policy_snapshot_id;
      groundingManifest = g.manifest as unknown as Record<string, unknown>;
      knownChunkIds = new Set(
        [...g.kb_chunks, ...g.policy_chunks].filter((c) => c.included).map((c) => c.chunk_id),
      );
    }

    const init = local
      ? await admin.rpc("ce_automation_initiate_local_v1", {
          p_job_id: job.id,
          p_contract_version: contractVersion,
          p_input_snapshot_hash: bundle.transcript_hash,
          p_bundle_hash: bundle.bundle_hash,
          p_model_version: model,
          p_prompt_version: EVALUATOR_PROMPT_VERSION,
          p_source_deployment: sourceDeployment,
        })
      : await admin.rpc("ce_automation_initiate_canonical_v1", {
          p_job_id: job.id,
          p_contract_version: contractVersion,
          p_input_snapshot_hash: bundle.transcript_hash,
          p_bundle_hash: bundle.bundle_hash,
          p_kb_snapshot_id: kbSnapshotId,
          p_policy_snapshot_id: policySnapshotId,
          p_grounding_manifest: groundingManifest,
          p_model_version: model,
          p_prompt_version: EVALUATOR_PROMPT_VERSION,
          p_source_deployment: sourceDeployment,
        });
    if (init.error) throw new Error("initiate_failed");
    const initData = (init.data ?? {}) as Record<string, unknown>;
    const initResult = String(initData.result ?? "");
    if (initResult === "already_evaluated") {
      const evaluationId = String(initData.evaluation_id ?? "");
      if (conversionReality) {
        const current = await revalidateCeConversionReality(
          admin as unknown as Parameters<typeof revalidateCeConversionReality>[0],
          conversionReality,
        );
        if (!current.ok) throw new Error(current.code);
      }
      const { data: fresh } = await admin.rpc("ce_finalize_evaluation_freshness_v1", {
        p_conversation_id: job.conversation_id,
        p_evaluation_id: evaluationId,
        p_evaluation_source: local ? "conversation_local" : "canonical",
        p_snapshot_hash: job.snapshot_hash,
        p_evaluation_fingerprint: job.evaluation_fingerprint,
        p_expected_revision: job.expected_revision,
        p_success_at: new Date().toISOString(),
      });
      await admin.rpc("ce_complete_job_v1", { p_job_id: job.id });
      return {
        ok: true,
        evaluationId,
        freshness: String((fresh as Record<string, unknown> | null)?.result ?? "current"),
      };
    }
    if (initResult === "already_in_progress") throw new Error("already_in_progress");
    if (initResult !== "initiated") throw new Error(initResult || "initiate_rejected");
    const attemptId = String(initData.attempt_id);

    const settled = await Promise.all(
      CE_DIMENSIONS.map((d) =>
        runEvaluator(
          d,
          bundle.text,
          knownChunkIds,
          operationId,
          companyId,
          job.conversation_id,
          local,
        ),
      ),
    );
    const failure = settled.find((x) => !x.ok) as { ok: false; code: string } | undefined;
    if (failure) {
      await failAttempt(admin, local, attemptId, failure.code);
      throw new Error(failure.code);
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
      const weight = DIMENSION_WEIGHT[dimension];
      scores[dimension] = r.score;
      details[DIMENSION_TO_EVALUATOR_TYPE[dimension]] = {
        evaluator_type: DIMENSION_TO_EVALUATOR_TYPE[dimension],
        raw_score: r.score,
        weight,
        weighted_score:
          dimension === "hallucination_risk" ? (100 - r.score) * weight : r.score * weight,
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
      companyId,
      job.conversation_id,
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
      grounding_evidence: local
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
        await failAttempt(admin, local, attemptId, current.code);
        throw new Error(current.code);
      }
    }

    const complete = local
      ? await admin.rpc("complete_local_evaluation_v1", {
          p_attempt_id: attemptId,
          p_scores: scores,
          p_details: details,
          p_bundle_hash: bundle.bundle_hash,
          p_snapshot: snapshot,
          p_derived: derived,
        })
      : await admin.rpc("complete_evaluation_v2", {
          p_attempt_id: attemptId,
          p_scores: scores,
          p_details: details,
          p_bundle_hash: bundle.bundle_hash,
          p_snapshot: snapshot,
          p_derived: derived,
        });
    if (
      complete.error ||
      String((complete.data as Record<string, unknown> | null)?.result ?? "") !== "success"
    ) {
      const readBack = await readEvaluation(admin, local, attemptId);
      if (!readBack) {
        await failAttempt(admin, local, attemptId, "CE_AUTOMATION_PERSISTENCE_ERROR");
        throw new Error("persist_failed");
      }
    }

    const evaluation = await readEvaluation(admin, local, attemptId);
    if (!evaluation?.id) throw new Error("persist_unverified");

    const { data: fresh, error: freshErr } = await admin.rpc(
      "ce_finalize_evaluation_freshness_v1",
      {
        p_conversation_id: job.conversation_id,
        p_evaluation_id: String(evaluation.id),
        p_evaluation_source: local ? "conversation_local" : "canonical",
        p_snapshot_hash: job.snapshot_hash,
        p_evaluation_fingerprint: job.evaluation_fingerprint,
        p_expected_revision: job.expected_revision,
        p_success_at: new Date().toISOString(),
      },
    );
    if (freshErr) throw new Error("freshness_finalize_failed");

    await admin.rpc("ce_complete_job_v1", { p_job_id: job.id });
    return {
      ok: true,
      evaluationId: String(evaluation.id),
      freshness: String((fresh as Record<string, unknown> | null)?.result ?? "current"),
    };
  } catch (e) {
    const code = e instanceof Error ? e.message.slice(0, 120) : "unknown";
    await admin.rpc("ce_fail_job_v1", { p_job_id: job.id, p_error_code: code }).then(
      () => undefined,
      () => undefined,
    );
    return { ok: false, code };
  }
}

export function serviceClient(): Db {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}
