/**
 * CE read/write server functions.
 *
 * All reads go through requireSupabaseAuth so RLS applies as the caller:
 *  - canonical status comes from public.ce_conversation_status_v (never
 *    re-derived on the client)
 *  - replay bundles are read from ce_bundle_snapshot for staff;
 *    raw evaluator payload is admin-only via ce_raw_provider_output
 *
 * The CE views/tables are introduced by the staged migration in
 * sql/ce-task1/. Until that migration is applied and Supabase types are
 * regenerated, those relations are reached through an untyped view of the
 * authenticated client (`loose`) — RLS still applies as the caller.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type CeResult<T> = { ok: boolean; data?: T; error?: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
type LooseClient = {
  from: (relation: string) => any;
  rpc: (name: string, params: Record<string, unknown>) => any;
};

/* ── List ── */

const listInput = z.object({
  tab: z.enum(["all", "needs_review", "training_ready", "trained"]).default("all"),
  search: z.string().trim().max(200).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const listCeEvaluationsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listInput)
  .handler(async ({ data, context }): Promise<CeResult<any[]>> => {
    const loose = context.supabase as unknown as LooseClient;
    let q = loose
      .from("ce_conversation_status_v")
      .select("*")
      .order("evaluated_at", { ascending: false })
      .limit(data.limit);

    if (data.tab !== "all") q = q.eq(data.tab, true);
    if (data.severity) q = q.eq("severity", data.severity);
    if (data.fromDate) q = q.gte("evaluated_at", data.fromDate);
    if (data.toDate) q = q.lte("evaluated_at", data.toDate);
    if (data.search) q = q.ilike("conversation_id", `%${data.search}%`);

    const { data: rows, error } = await q;
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: (rows ?? []) as any[] };
  });

/* ── Single evaluation + details ── */

export const getCeEvaluationFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ evaluationId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const loose = context.supabase as unknown as LooseClient;

    const { data: evaluation, error } = await loose
      .from("conversation_evaluation")
      .select(
        "id, conversation_id, attempt_id, company_id, evaluation_contract_version, input_snapshot_hash, bundle_hash, " +
        "accuracy_score, policy_score, tone_score, sales_score, context_score, hallucination_risk_score, " +
        "hallucination_quality_score, overall_score, severity, has_verified_human_response, training_eligible, " +
        "model_version, prompt_version, kb_snapshot_id, policy_snapshot_id, source_deployment, " +
        "review_status, review_note, reviewed_by, reviewed_at, grounding_manifest, created_at"
      )
      .eq("id", data.evaluationId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!evaluation) return { ok: false, error: "not_found" };

    // Details — justification is always visible; raw_llm_response is admin-only (separate table)
    const { data: details } = await loose
      .from("conversation_evaluation_detail")
      .select(
        "evaluator_type, raw_score, weight, weighted_score, justification, " +
        "recommended_correction, evaluator_model_version, evaluator_prompt_version, grounding_refs"
      )
      .eq("evaluation_id", data.evaluationId);

    // Conversation transcript (live, for the overview tab)
    const { data: messages } = await loose
      .from("messages")
      .select("id, role, content, created_at, is_recalled, sender_id, sender_identity_verified_at")
      .eq("conversation_id", (evaluation as any).conversation_id)
      .order("created_at", { ascending: true })
      .limit(300);

    // Attempts
    const { data: attempts } = await loose
      .from("conversation_evaluation_attempt")
      .select("id, conversation_id, status, error_message, created_at, updated_at")
      .eq("conversation_id", (evaluation as any).conversation_id)
      .order("created_at", { ascending: false });

    // Outbox
    const { data: outbox } = await loose
      .from("evaluation_training_outbox")
      .select("id, evaluation_id, status, delivery_attempts, max_attempts, delivered_at, created_at")
      .eq("evaluation_id", data.evaluationId);

    // Audit log
    const { data: audit } = await loose
      .from("audit_log")
      .select("id, actor_id, action, resource_type, resource_id, diff, created_at")
      .eq("resource_type", "conversation_evaluation")
      .eq("resource_id", data.evaluationId)
      .order("created_at", { ascending: false });

    // Emotion journey
    const { data: emotion } = await loose
      .from("ce_emotion_point")
      .select("id, evaluation_id, message_id, turn_index, occurred_at, sentiment, sentiment_score, trigger_label")
      .eq("evaluation_id", data.evaluationId)
      .order("turn_index", { ascending: true });

    // Next steps
    const { data: nextSteps } = await loose
      .from("ce_next_step")
      .select("id, evaluation_id, ordinal, title, detail, owner_role, status")
      .eq("evaluation_id", data.evaluationId)
      .order("ordinal", { ascending: true });

    // Discrepancies
    const { data: discrepancies } = await loose
      .from("ce_discrepancy")
      .select("id, evaluation_id, dimension, ai_claim, human_claim, grounded_claim, divergence_kind, severity, grounding_refs")
      .eq("evaluation_id", data.evaluationId);

    // Root causes (admin/supervisor only — RLS enforced)
    const { data: rootCauses } = await loose
      .from("ce_root_cause")
      .select("id, evaluation_id, category, summary, evidence_refs, recorded_by, remote_sync_state, remote_ref, created_at")
      .eq("evaluation_id", data.evaluationId)
      .order("created_at", { ascending: false });

    // QA cases (admin/supervisor only — RLS enforced)
    const { data: qaCases } = await loose
      .from("ce_qa_case")
      .select("id, evaluation_id, case_number, title, description, status, priority, remote_sync_state, remote_ref, created_at")
      .eq("evaluation_id", data.evaluationId)
      .order("created_at", { ascending: false });

    // Training links
    const { data: trainingLinks } = await loose
      .from("ce_training_link")
      .select("id, evaluation_id, link_kind, local_state, payload, improved_result, improved_state, remote_sync_state, remote_ref, updated_at")
      .eq("evaluation_id", data.evaluationId);

    // KB publish state (admin/supervisor only — RLS enforced)
    const { data: kbPublish } = await loose
      .from("ce_kb_publish_state")
      .select("id, evaluation_id, kb_document_ref, action, state, remote_sync_state, remote_ref, last_error, created_at")
      .eq("evaluation_id", data.evaluationId)
      .order("created_at", { ascending: false });

    return {
      ok: true,
      data: {
        evaluation,
        details: details ?? [],
        messages: messages ?? [],
        attempts: attempts ?? [],
        outbox: outbox ?? [],
        audit: audit ?? [],
        emotion: emotion ?? [],
        nextSteps: nextSteps ?? [],
        discrepancies: discrepancies ?? [],
        rootCauses: rootCauses ?? [],
        qaCases: qaCases ?? [],
        trainingLinks: trainingLinks ?? [],
        kbPublish: kbPublish ?? [],
      },
    };
  });

/* ── Replay Studio: immutable stored snapshot ── */

export const getCeReplayBundleFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ attemptId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const loose = context.supabase as unknown as LooseClient;

    const { data: snapshot, error } = await loose
      .from("ce_bundle_snapshot")
      .select(
        "id, attempt_id, conversation_id, company_id, bundle_hash, transcript_hash, " +
        "evaluation_contract_version, model_version, prompt_version, kb_snapshot_id, policy_snapshot_id, " +
        "canonical_input, normalized_transcript, evaluated_ai_reply, verified_human_response, " +
        "grounding_evidence, grounding_manifest, truncation_manifest, redaction_applied, " +
        "retention_expires_at, created_at"
      )
      .eq("attempt_id", data.attemptId)
      .maybeSingle();

    if (error) return { ok: false, error: error.message };
    if (!snapshot) return { ok: false, error: "replay_bundle_unavailable" };

    return { ok: true, data: { snapshot } };
  });

/* ── Review decision ── */

export const submitCeReviewFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      evaluationId: z.string().uuid(),
      conversationId: z.string().uuid(),
      decision: z.enum(["accept", "reject", "reopen"]),
      note: z.string().max(1000).optional(),
    }),
  )
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const loose = context.supabase as unknown as LooseClient;

    const { data: result, error } = await loose.rpc("review_evaluation", {
      p_evaluation_id: data.evaluationId,
      p_expected_conversation_id: data.conversationId,
      p_decision: data.decision,
      p_note: data.note ?? null,
    });

    if (error) return { ok: false, error: error.message };
    const out = (result ?? {}) as Record<string, unknown>;
    if (String(out.result ?? "") !== "success") {
      return { ok: false, error: String(out.result ?? "review_failed") };
    }
    return { ok: true, data: out };
  });

/* ── Create QA case ── */

export const createCeQaCaseFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      evaluationId: z.string().uuid(),
      conversationId: z.string().uuid(),
      title: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      priority: z.enum(["urgent", "high", "medium", "low"]).default("medium"),
    }),
  )
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const loose = context.supabase as unknown as LooseClient;
    const { data: result, error } = await loose.rpc("ce_create_qa_case", {
      p_evaluation_id: data.evaluationId,
      p_expected_conversation_id: data.conversationId,
      p_title: data.title,
      p_description: data.description ?? null,
      p_priority: data.priority,
    });
    if (error) return { ok: false, error: error.message };
    const out = (result ?? {}) as Record<string, unknown>;
    if (String(out.result ?? "") !== "success" && String(out.result ?? "") !== "already_exists") {
      return { ok: false, error: String(out.result ?? "create_failed") };
    }
    return { ok: true, data: out };
  });

/* ── Record root cause ── */

export const recordCeRootCauseFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      evaluationId: z.string().uuid(),
      conversationId: z.string().uuid(),
      category: z.enum([
        "kb_gap", "kb_stale", "policy_gap", "prompt_defect",
        "model_limitation", "routing_error", "human_error", "unknown",
      ]),
      summary: z.string().min(1).max(2000),
    }),
  )
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const loose = context.supabase as unknown as LooseClient;
    const { data: result, error } = await loose.rpc("ce_record_root_cause", {
      p_evaluation_id: data.evaluationId,
      p_expected_conversation_id: data.conversationId,
      p_category: data.category,
      p_summary: data.summary,
      p_evidence: [],
    });
    if (error) return { ok: false, error: error.message };
    const out = (result ?? {}) as Record<string, unknown>;
    if (String(out.result ?? "") !== "success") {
      return { ok: false, error: String(out.result ?? "record_failed") };
    }
    return { ok: true, data: out };
  });
