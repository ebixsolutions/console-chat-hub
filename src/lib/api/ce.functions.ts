/**
 * CE read/write server functions — PR-4 Round 2.
 *
 * R1: Every query checks error explicitly; query error never becomes empty.
 * R2: needs_review from canonical ce_conversation_status_v, not re-derived.
 * R3: evaluation_available server-derived from conversation.company_id.
 * R4: Search on resolved customer_label + conversation_id + latest_preview.
 * R5: Active path has zero training references.
 * R6: Recalled messages preserved with is_recalled flag.
 * R7: Counts from full authorized result set.
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

// ─── Shared customer label resolver (Inbox semantics) ────────────────────────

function resolveCustomerLabel(
  visitorSession: { id: string; visitor_metadata?: unknown } | null,
  conversationId: string,
  channelName: string | null,
): string {
  const rawMeta = visitorSession?.visitor_metadata;
  const meta =
    rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta) ? (rawMeta as Record<string, unknown>) : {};
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  const email = typeof meta.email === "string" ? meta.email.trim() : "";
  const shortId = (visitorSession?.id || conversationId).slice(0, 8);
  const channel = channelName || "Visitor";
  if (name) return name;
  if (email) return email;
  return `${channel} Visitor #${shortId}`;
}

// ─── Active CE list row ─────────────────────────────────────────────────────

export interface CeConversationRow {
  conversation_id: string;
  conversation_status: string;
  priority: string | null;
  created_at: string | null;
  updated_at: string | null;
  channel_name: string | null;
  customer_label: string;
  latest_preview: string;
  evaluation_id: string | null;
  overall_score: number | null;
  severity: string | null;
  review_status: string | null;
  evaluated_at: string | null;
  needs_review: boolean;
  evaluation_available: boolean;
  evaluation_unavailable_reason: string | null;
}

export interface CeListCounts {
  total: number;
  evaluated: number;
  not_evaluated: number;
  needs_review: number;
}

export interface CeListResult {
  rows: CeConversationRow[];
  counts: CeListCounts;
}

// ─── Active CE list: conversations-first ─────────────────────────────────────

const listConvInput = z.object({
  pill: z.enum(["all", "evaluated", "not_evaluated", "needs_review"]).default("all"),
  search: z.string().trim().max(200).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  limit: z.number().int().min(1).max(500).default(200),
});

export const listConversationsForCeFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listConvInput)
  .handler(async ({ data, context }): Promise<CeResult<CeListResult>> => {
    const loose = context.supabase as unknown as LooseClient;

    // ── Step 1: conversations (REQUIRED — error = whole list FAIL)
    let q = loose
      .from("conversations")
      .select(
        "id, status, priority, created_at, updated_at, company_id, " +
          "channel_config:channel_config_id(name), " +
          "visitor_session:visitor_session_id(id, visitor_metadata)",
      )
      .order("updated_at", { ascending: false })
      .limit(data.limit);

    if (data.fromDate) q = q.gte("created_at", data.fromDate);
    if (data.toDate) q = q.lte("created_at", data.toDate);

    const { data: convs, error: convErr } = await q;
    if (convErr) return { ok: false, error: `conversations: ${convErr.message}` };
    if (!convs) return { ok: false, error: "conversations: null response" };

    const convRows = convs as any[];
    const convIds = convRows.map((c) => c.id as string);

    // ── Step 2: evaluations (REQUIRED — error = whole list FAIL)
    let evalMap: Record<string, any> = {};
    if (convIds.length > 0) {
      const { data: evals, error: evalErr } = await loose
        .from("conversation_evaluation")
        .select("id, conversation_id, overall_score, severity, review_status, created_at")
        .in("conversation_id", convIds)
        .order("created_at", { ascending: false });
      if (evalErr) return { ok: false, error: `conversation_evaluation: ${evalErr.message}` };
      if (!evals) return { ok: false, error: "conversation_evaluation: null response" };
      for (const ev of evals as any[]) {
        if (!evalMap[ev.conversation_id]) evalMap[ev.conversation_id] = ev;
      }
    }

    // ── Step 3: canonical needs_review from ce_conversation_status_v (REQUIRED for evaluated)
    const evalIds = Object.values(evalMap).map((ev: any) => ev.id as string);
    let canonicalNeedsReview: Record<string, boolean> = {};
    if (evalIds.length > 0) {
      const { data: statusRows, error: statusErr } = await loose
        .from("ce_conversation_status_v")
        .select("evaluation_id, needs_review")
        .in("evaluation_id", evalIds);
      if (statusErr) return { ok: false, error: `ce_conversation_status_v: ${statusErr.message}` };
      if (!statusRows) return { ok: false, error: "ce_conversation_status_v: null response" };
      for (const s of statusRows as any[]) {
        canonicalNeedsReview[s.evaluation_id] = Boolean(s.needs_review);
      }
      // If canonical status row missing for an existing evaluation → integrity error
      for (const eid of evalIds) {
        if (!(eid in canonicalNeedsReview)) {
          return { ok: false, error: `ce_status_integrity: evaluation ${eid.slice(0, 8)} has no canonical status row` };
        }
      }
    }

    // ── Step 4: latest message preview (REQUIRED — error = whole list FAIL)
    let previewMap: Record<string, string> = {};
    if (convIds.length > 0) {
      const { data: msgs, error: msgsErr } = await loose
        .from("messages")
        .select("conversation_id, content, is_recalled")
        .in("conversation_id", convIds)
        .neq("content", "__THINKING__")
        .order("created_at", { ascending: false })
        .limit(500);
      if (msgsErr) return { ok: false, error: `messages_preview: ${msgsErr.message}` };
      if (!msgs) return { ok: false, error: "messages_preview: null response" };
      for (const m of msgs as any[]) {
        if (!previewMap[m.conversation_id]) {
          previewMap[m.conversation_id] = m.is_recalled ? "[訊息已撤回]" : String(m.content).slice(0, 80);
        }
      }
    }

    // ── Step 5: Build resolved list
    const allRows: CeConversationRow[] = convRows.map((c: any) => {
      const ev = evalMap[c.id] ?? null;
      const channelName = (c.channel_config as { name: string } | null)?.name ?? null;
      const customerLabel = resolveCustomerLabel(
        c.visitor_session as { id: string; visitor_metadata?: unknown } | null,
        c.id,
        channelName,
      );
      const hasCompanyId = c.company_id !== null && c.company_id !== undefined;
      return {
        conversation_id: c.id,
        conversation_status: c.status,
        priority: c.priority,
        created_at: c.created_at,
        updated_at: c.updated_at,
        channel_name: channelName,
        customer_label: customerLabel,
        latest_preview: previewMap[c.id] || "(no messages)",
        evaluation_id: ev?.id ?? null,
        overall_score: ev ? Number(ev.overall_score) : null,
        severity: ev?.severity ?? null,
        review_status: ev?.review_status ?? null,
        evaluated_at: ev?.created_at ?? null,
        needs_review: ev ? (canonicalNeedsReview[ev.id] ?? false) : false,
        evaluation_available: hasCompanyId,
        evaluation_unavailable_reason: hasCompanyId ? null : "platform_company_identity_unresolved",
      };
    });

    // ── Step 6: Counts from FULL resolved set (before search/pill/severity filter)
    const counts: CeListCounts = {
      total: allRows.length,
      evaluated: allRows.filter((r) => r.evaluation_id !== null).length,
      not_evaluated: allRows.filter((r) => r.evaluation_id === null).length,
      needs_review: allRows.filter((r) => r.needs_review).length,
    };

    // ── Step 7: Apply search on resolved fields (R4)
    let filtered = allRows;
    const searchLower = (data.search ?? "").trim().toLowerCase();
    if (searchLower) {
      filtered = filtered.filter(
        (r) =>
          r.conversation_id.toLowerCase().includes(searchLower) ||
          r.customer_label.toLowerCase().includes(searchLower) ||
          r.latest_preview.toLowerCase().includes(searchLower),
      );
    }

    // ── Step 8: Apply pill filter
    if (data.pill === "evaluated") filtered = filtered.filter((r) => r.evaluation_id !== null);
    if (data.pill === "not_evaluated") filtered = filtered.filter((r) => r.evaluation_id === null);
    if (data.pill === "needs_review") filtered = filtered.filter((r) => r.needs_review);

    // ── Step 9: Apply severity filter
    if (data.severity) filtered = filtered.filter((r) => r.severity === data.severity);

    return { ok: true, data: { rows: filtered, counts } };
  });

// ─── Active CE detail: conversation-first ────────────────────────────────────

export interface CeDetailSectionError {
  section: string;
  message: string;
}

export const getCeConversationDetailFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ conversationId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const loose = context.supabase as unknown as LooseClient;

    // ── Conversation (REQUIRED)
    const { data: conv, error: convErr } = await loose
      .from("conversations")
      .select(
        "id, status, priority, created_at, updated_at, company_id, " +
          "channel_config:channel_config_id(name), " +
          "visitor_session:visitor_session_id(id, visitor_metadata)",
      )
      .eq("id", data.conversationId)
      .maybeSingle();
    if (convErr) return { ok: false, error: `conversation: ${convErr.message}` };
    if (!conv) return { ok: false, error: "conversation_not_found" };

    const channelName = ((conv as any).channel_config as { name: string } | null)?.name ?? null;
    const customerLabel = resolveCustomerLabel(
      (conv as any).visitor_session as { id: string; visitor_metadata?: unknown } | null,
      data.conversationId,
      channelName,
    );
    const hasCompanyId = (conv as any).company_id !== null && (conv as any).company_id !== undefined;

    // ── Messages (REQUIRED — includes recalled with is_recalled flag, R6)
    const { data: messages, error: msgsErr } = await loose
      .from("messages")
      .select("id, role, content, created_at, is_recalled, metadata, sender_id, sender_identity_verified_at")
      .eq("conversation_id", data.conversationId)
      .neq("content", "__THINKING__")
      .order("created_at", { ascending: true })
      .limit(300);
    if (msgsErr) return { ok: false, error: `messages: ${msgsErr.message}` };
    if (!messages) return { ok: false, error: "messages: null response" };

    // ── Evaluation (REQUIRED — to distinguish not-evaluated from error)
    const { data: evals, error: evalErr } = await loose
      .from("conversation_evaluation")
      .select(
        "id, conversation_id, attempt_id, company_id, evaluation_contract_version, input_snapshot_hash, bundle_hash, " +
          "accuracy_score, policy_score, tone_score, sales_score, context_score, hallucination_risk_score, " +
          "hallucination_quality_score, overall_score, severity, has_verified_human_response, " +
          "model_version, prompt_version, kb_snapshot_id, policy_snapshot_id, source_deployment, " +
          "review_status, review_note, reviewed_by, reviewed_at, grounding_manifest, created_at",
      )
      .eq("conversation_id", data.conversationId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (evalErr) return { ok: false, error: `conversation_evaluation: ${evalErr.message}` };
    if (!evals) return { ok: false, error: "conversation_evaluation: null response" };

    const evaluation = evals.length > 0 ? evals[0] : null;
    const evaluationId = (evaluation as any)?.id ?? null;

    // ── CE detail tables (only when evaluation exists; each error tracked)
    const sectionErrors: CeDetailSectionError[] = [];
    let details: any[] = [];
    let emotion: any[] = [];
    let nextSteps: any[] = [];
    let discrepancies: any[] = [];
    let rootCauses: any[] = [];
    let qaCases: any[] = [];
    let snapshot: any = null;

    if (evaluationId) {
      const { data: d1, error: e1 } = await loose
        .from("conversation_evaluation_detail")
        .select(
          "evaluator_type, raw_score, weight, weighted_score, justification, " +
            "recommended_correction, evaluator_model_version, evaluator_prompt_version, grounding_refs",
        )
        .eq("evaluation_id", evaluationId);
      if (e1) sectionErrors.push({ section: "details", message: e1.message });
      else details = d1 ?? [];

      const { data: d2, error: e2 } = await loose
        .from("ce_emotion_point")
        .select("id, evaluation_id, message_id, turn_index, occurred_at, sentiment, sentiment_score, trigger_label")
        .eq("evaluation_id", evaluationId)
        .order("turn_index", { ascending: true });
      if (e2) sectionErrors.push({ section: "emotion", message: e2.message });
      else emotion = d2 ?? [];

      const { data: d3, error: e3 } = await loose
        .from("ce_next_step")
        .select("id, evaluation_id, ordinal, title, detail, owner_role, status")
        .eq("evaluation_id", evaluationId)
        .order("ordinal", { ascending: true });
      if (e3) sectionErrors.push({ section: "nextSteps", message: e3.message });
      else nextSteps = d3 ?? [];

      const { data: d4, error: e4 } = await loose
        .from("ce_discrepancy")
        .select(
          "id, evaluation_id, dimension, ai_claim, human_claim, grounded_claim, divergence_kind, severity, grounding_refs",
        )
        .eq("evaluation_id", evaluationId);
      if (e4) sectionErrors.push({ section: "discrepancies", message: e4.message });
      else discrepancies = d4 ?? [];

      const { data: d5, error: e5 } = await loose
        .from("ce_root_cause")
        .select(
          "id, evaluation_id, category, summary, evidence_refs, recorded_by, remote_sync_state, remote_ref, created_at",
        )
        .eq("evaluation_id", evaluationId)
        .order("created_at", { ascending: false });
      if (e5) sectionErrors.push({ section: "rootCauses", message: e5.message });
      else rootCauses = d5 ?? [];

      const { data: d6, error: e6 } = await loose
        .from("ce_qa_case")
        .select(
          "id, evaluation_id, case_number, title, description, status, priority, remote_sync_state, remote_ref, created_at",
        )
        .eq("evaluation_id", evaluationId)
        .order("created_at", { ascending: false });
      if (e6) sectionErrors.push({ section: "qaCases", message: e6.message });
      else qaCases = d6 ?? [];

      // Replay bundle
      const attemptId = (evaluation as any)?.attempt_id;
      if (attemptId) {
        const { data: snap, error: snapErr } = await loose
          .from("ce_bundle_snapshot")
          .select(
            "id, attempt_id, conversation_id, company_id, bundle_hash, transcript_hash, " +
              "evaluation_contract_version, model_version, prompt_version, kb_snapshot_id, policy_snapshot_id, " +
              "canonical_input, normalized_transcript, evaluated_ai_reply, verified_human_response, " +
              "grounding_evidence, grounding_manifest, truncation_manifest, redaction_applied, " +
              "retention_expires_at, created_at",
          )
          .eq("attempt_id", attemptId)
          .maybeSingle();
        if (snapErr) sectionErrors.push({ section: "replay", message: snapErr.message });
        else snapshot = snap;
      }
    }

    return {
      ok: true,
      data: {
        conversation: {
          id: (conv as any).id,
          status: (conv as any).status,
          priority: (conv as any).priority,
          created_at: (conv as any).created_at,
          updated_at: (conv as any).updated_at,
          company_id: (conv as any).company_id,
          channel_name: channelName,
          customer_label: customerLabel,
        },
        evaluation,
        evaluation_available: hasCompanyId,
        evaluation_unavailable_reason: hasCompanyId ? null : "platform_company_identity_unresolved",
        details,
        messages: messages as any[],
        emotion,
        nextSteps,
        discrepancies,
        rootCauses,
        qaCases,
        snapshot,
        sectionErrors,
      },
    };
  });

// ─── Legacy functions (kept for backward compatibility — NOT used by active CE route) ──

/** @deprecated Use listConversationsForCeFn instead. */
export const listCeEvaluationsFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      tab: z.enum(["all", "needs_review", "training_ready", "trained"]).default("all"),
      search: z.string().trim().max(200).optional(),
      severity: z.enum(["critical", "high", "medium", "low"]).optional(),
      fromDate: z.string().optional(),
      toDate: z.string().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
  )
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

/** @deprecated Use getCeConversationDetailFn instead. */
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
          "review_status, review_note, reviewed_by, reviewed_at, grounding_manifest, created_at",
      )
      .eq("id", data.evaluationId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!evaluation) return { ok: false, error: "not_found" };
    const { data: details } = await loose
      .from("conversation_evaluation_detail")
      .select(
        "evaluator_type, raw_score, weight, weighted_score, justification, " +
          "recommended_correction, evaluator_model_version, evaluator_prompt_version, grounding_refs",
      )
      .eq("evaluation_id", data.evaluationId);
    const { data: messages } = await loose
      .from("messages")
      .select("id, role, content, created_at, is_recalled, sender_id, sender_identity_verified_at")
      .eq("conversation_id", (evaluation as any).conversation_id)
      .order("created_at", { ascending: true })
      .limit(300);
    const { data: emotion } = await loose
      .from("ce_emotion_point")
      .select("id, evaluation_id, message_id, turn_index, occurred_at, sentiment, sentiment_score, trigger_label")
      .eq("evaluation_id", data.evaluationId)
      .order("turn_index", { ascending: true });
    const { data: nextSteps } = await loose
      .from("ce_next_step")
      .select("id, evaluation_id, ordinal, title, detail, owner_role, status")
      .eq("evaluation_id", data.evaluationId)
      .order("ordinal", { ascending: true });
    const { data: discrepancies } = await loose
      .from("ce_discrepancy")
      .select(
        "id, evaluation_id, dimension, ai_claim, human_claim, grounded_claim, divergence_kind, severity, grounding_refs",
      )
      .eq("evaluation_id", data.evaluationId);
    const { data: rootCauses } = await loose
      .from("ce_root_cause")
      .select(
        "id, evaluation_id, category, summary, evidence_refs, recorded_by, remote_sync_state, remote_ref, created_at",
      )
      .eq("evaluation_id", data.evaluationId)
      .order("created_at", { ascending: false });
    const { data: qaCases } = await loose
      .from("ce_qa_case")
      .select(
        "id, evaluation_id, case_number, title, description, status, priority, remote_sync_state, remote_ref, created_at",
      )
      .eq("evaluation_id", data.evaluationId)
      .order("created_at", { ascending: false });
    return {
      ok: true,
      data: {
        evaluation,
        details: details ?? [],
        messages: messages ?? [],
        emotion: emotion ?? [],
        nextSteps: nextSteps ?? [],
        discrepancies: discrepancies ?? [],
        rootCauses: rootCauses ?? [],
        qaCases: qaCases ?? [],
      },
    };
  });

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
          "retention_expires_at, created_at",
      )
      .eq("attempt_id", data.attemptId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!snapshot) return { ok: false, error: "replay_bundle_unavailable" };
    return { ok: true, data: { snapshot } };
  });

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

export const recordCeRootCauseFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    z.object({
      evaluationId: z.string().uuid(),
      conversationId: z.string().uuid(),
      category: z.enum([
        "kb_gap",
        "kb_stale",
        "policy_gap",
        "prompt_defect",
        "model_limitation",
        "routing_error",
        "human_error",
        "unknown",
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
