/**
 * CE read/write server functions — PR-4 Director Functional Closure.
 *
 * Active CE path:
 * - conversations-first, complete authorized result set
 * - no hard row caps in list/detail readers
 * - canonical needs_review only
 * - CE child-query failures fail closed
 * - evaluation availability resolved server-side against company + membership
 * - no training fields in active CE list/detail contracts
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

const PAGE_SIZE = 500;
const IN_CHUNK = 100;

function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function fetchAllPages(
  buildQuery: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>,
  label: string,
): Promise<{ ok: true; rows: any[] } | { ok: false; error: string }> {
  const rows: any[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await buildQuery(from, to);
    if (error) return { ok: false, error: `${label}: ${error.message}` };
    if (!data) return { ok: false, error: `${label}: null response` };
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return { ok: true, rows };
}

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

async function resolveEvaluationAvailability(
  loose: LooseClient,
  userId: string,
  companyId: string | null | undefined,
): Promise<{ available: boolean; reason: string | null } | { error: string }> {
  if (!companyId) {
    return { available: false, reason: "platform_company_identity_unresolved" };
  }

  const { data: company, error: companyErr } = await loose
    .from("company")
    .select("id, is_active")
    .eq("id", companyId)
    .maybeSingle();
  if (companyErr) return { error: `company: ${companyErr.message}` };
  if (!company || company.is_active !== true) {
    return { available: false, reason: "platform_company_identity_unresolved" };
  }

  const { data: membership, error: membershipErr } = await loose
    .from("company_membership")
    .select("id, is_active")
    .eq("company_id", companyId)
    .eq("user_id", userId)
    .eq("is_active", true)
    .maybeSingle();
  if (membershipErr) return { error: `company_membership: ${membershipErr.message}` };
  if (!membership) {
    return { available: false, reason: "company_membership_unresolved" };
  }

  return { available: true, reason: null };
}

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

const listConvInput = z.object({
  pill: z.enum(["all", "evaluated", "not_evaluated", "needs_review"]).default("all"),
  search: z.string().trim().max(200).optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  // Kept for backward compatibility with callers. Active CE reads the full
  // authorized result set before applying UI pagination.
  limit: z.number().int().min(1).max(500).optional(),
});

export const listConversationsForCeFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listConvInput)
  .handler(async ({ data, context }): Promise<CeResult<CeListResult>> => {
    const loose = context.supabase as unknown as LooseClient;
    const userId = String(context.userId);

    const convResult = await fetchAllPages(async (from, to) => {
      let q = loose
        .from("conversations")
        .select(
          "id, status, priority, created_at, updated_at, company_id, " +
            "channel_config:channel_config_id(name), " +
            "visitor_session:visitor_session_id(id, visitor_metadata)",
        )
        .order("updated_at", { ascending: false })
        .range(from, to);
      if (data.fromDate) q = q.gte("created_at", data.fromDate);
      if (data.toDate) q = q.lte("created_at", data.toDate);
      return q;
    }, "conversations");
    if (!convResult.ok) return { ok: false, error: convResult.error };

    const convRows = convResult.rows;
    const convIds = convRows.map((c) => String(c.id));

    const evalMap: Record<string, any> = {};
    for (const ids of chunk(convIds)) {
      const result = await fetchAllPages(
        (from, to) =>
          loose
            .from("conversation_evaluation")
            .select("id, conversation_id, overall_score, severity, review_status, created_at")
            .in("conversation_id", ids)
            .order("created_at", { ascending: false })
            .range(from, to),
        "conversation_evaluation",
      );
      if (!result.ok) return { ok: false, error: result.error };
      for (const ev of result.rows) {
        if (!evalMap[ev.conversation_id]) evalMap[ev.conversation_id] = ev;
      }
    }

    const evalIds = Object.values(evalMap).map((ev: any) => String(ev.id));
    const canonicalNeedsReview: Record<string, boolean> = {};
    for (const ids of chunk(evalIds)) {
      const result = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_conversation_status_v")
            .select("evaluation_id, needs_review")
            .in("evaluation_id", ids)
            .range(from, to),
        "ce_conversation_status_v",
      );
      if (!result.ok) return { ok: false, error: result.error };
      for (const row of result.rows) {
        canonicalNeedsReview[String(row.evaluation_id)] = Boolean(row.needs_review);
      }
    }
    for (const evaluationId of evalIds) {
      if (!(evaluationId in canonicalNeedsReview)) {
        return {
          ok: false,
          error: `ce_status_integrity: evaluation ${evaluationId.slice(0, 8)} has no canonical status row`,
        };
      }
    }

    const previewMap: Record<string, string> = {};
    for (const ids of chunk(convIds)) {
      const result = await fetchAllPages(
        (from, to) =>
          loose
            .from("messages")
            .select("conversation_id, content, is_recalled, created_at")
            .in("conversation_id", ids)
            .neq("content", "__THINKING__")
            .order("created_at", { ascending: false })
            .range(from, to),
        "messages_preview",
      );
      if (!result.ok) return { ok: false, error: result.error };
      for (const message of result.rows) {
        const cid = String(message.conversation_id);
        if (!(cid in previewMap)) {
          previewMap[cid] = message.is_recalled ? "[訊息已撤回]" : String(message.content ?? "").slice(0, 80);
        }
      }
    }

    const availabilityByCompany = new Map<string, { available: boolean; reason: string | null }>();
    const rows: CeConversationRow[] = [];

    for (const c of convRows) {
      const ev = evalMap[c.id] ?? null;
      const channelName = (c.channel_config as { name: string } | null)?.name ?? null;
      const companyId = c.company_id ? String(c.company_id) : null;
      const availabilityKey = companyId ?? "__null__";

      let availability = availabilityByCompany.get(availabilityKey);
      if (!availability) {
        const resolved = await resolveEvaluationAvailability(loose, userId, companyId);
        if ("error" in resolved) return { ok: false, error: resolved.error };
        availability = resolved;
        availabilityByCompany.set(availabilityKey, availability);
      }

      rows.push({
        conversation_id: String(c.id),
        conversation_status: String(c.status),
        priority: c.priority ?? null,
        created_at: c.created_at ?? null,
        updated_at: c.updated_at ?? null,
        channel_name: channelName,
        customer_label: resolveCustomerLabel(
          c.visitor_session as { id: string; visitor_metadata?: unknown } | null,
          String(c.id),
          channelName,
        ),
        latest_preview: previewMap[String(c.id)] || "(no messages)",
        evaluation_id: ev?.id ?? null,
        overall_score: ev ? Number(ev.overall_score) : null,
        severity: ev?.severity ?? null,
        review_status: ev?.review_status ?? null,
        evaluated_at: ev?.created_at ?? null,
        needs_review: ev ? canonicalNeedsReview[String(ev.id)] : false,
        evaluation_available: availability.available,
        evaluation_unavailable_reason: availability.reason,
      });
    }

    const counts: CeListCounts = {
      total: rows.length,
      evaluated: rows.filter((r) => r.evaluation_id !== null).length,
      not_evaluated: rows.filter((r) => r.evaluation_id === null).length,
      needs_review: rows.filter((r) => r.needs_review).length,
    };

    let filtered = rows;
    const searchLower = (data.search ?? "").trim().toLowerCase();
    if (searchLower) {
      filtered = filtered.filter(
        (r) =>
          r.conversation_id.toLowerCase().includes(searchLower) ||
          r.customer_label.toLowerCase().includes(searchLower) ||
          r.latest_preview.toLowerCase().includes(searchLower),
      );
    }

    if (data.pill === "evaluated") filtered = filtered.filter((r) => r.evaluation_id !== null);
    if (data.pill === "not_evaluated") filtered = filtered.filter((r) => r.evaluation_id === null);
    if (data.pill === "needs_review") filtered = filtered.filter((r) => r.needs_review);
    if (data.severity) filtered = filtered.filter((r) => r.severity === data.severity);

    return { ok: true, data: { rows: filtered, counts } };
  });

export interface CeDetailSectionError {
  section: string;
  message: string;
}

export const getCeConversationDetailFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ conversationId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const loose = context.supabase as unknown as LooseClient;
    const userId = String(context.userId);

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

    const availability = await resolveEvaluationAvailability(
      loose,
      userId,
      (conv as any).company_id ? String((conv as any).company_id) : null,
    );
    if ("error" in availability) return { ok: false, error: availability.error };

    const messageResult = await fetchAllPages(
      (from, to) =>
        loose
          .from("messages")
          .select("id, role, content, created_at, is_recalled, metadata, sender_id, sender_identity_verified_at")
          .eq("conversation_id", data.conversationId)
          .neq("content", "__THINKING__")
          .order("created_at", { ascending: true })
          .range(from, to),
      "messages",
    );
    if (!messageResult.ok) return { ok: false, error: messageResult.error };

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
    const evaluationId = evaluation?.id ? String(evaluation.id) : null;

    let details: any[] = [];
    let emotion: any[] = [];
    let nextSteps: any[] = [];
    let discrepancies: any[] = [];
    let rootCauses: any[] = [];
    let qaCases: any[] = [];
    let snapshot: any = null;

    if (evaluationId) {
      const detailResult = await fetchAllPages(
        (from, to) =>
          loose
            .from("conversation_evaluation_detail")
            .select(
              "evaluator_type, raw_score, weight, weighted_score, justification, " +
                "recommended_correction, evaluator_model_version, evaluator_prompt_version, grounding_refs",
            )
            .eq("evaluation_id", evaluationId)
            .range(from, to),
        "conversation_evaluation_detail",
      );
      if (!detailResult.ok) return { ok: false, error: detailResult.error };
      details = detailResult.rows;

      const emotionResult = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_emotion_point")
            .select("id, evaluation_id, message_id, turn_index, occurred_at, sentiment, sentiment_score, trigger_label")
            .eq("evaluation_id", evaluationId)
            .order("turn_index", { ascending: true })
            .range(from, to),
        "ce_emotion_point",
      );
      if (!emotionResult.ok) return { ok: false, error: emotionResult.error };
      emotion = emotionResult.rows;

      const nextResult = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_next_step")
            .select("id, evaluation_id, ordinal, title, detail, owner_role, status")
            .eq("evaluation_id", evaluationId)
            .order("ordinal", { ascending: true })
            .range(from, to),
        "ce_next_step",
      );
      if (!nextResult.ok) return { ok: false, error: nextResult.error };
      nextSteps = nextResult.rows;

      const discrepancyResult = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_discrepancy")
            .select(
              "id, evaluation_id, dimension, ai_claim, human_claim, grounded_claim, divergence_kind, severity, grounding_refs",
            )
            .eq("evaluation_id", evaluationId)
            .range(from, to),
        "ce_discrepancy",
      );
      if (!discrepancyResult.ok) return { ok: false, error: discrepancyResult.error };
      discrepancies = discrepancyResult.rows;

      const rootResult = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_root_cause")
            .select(
              "id, evaluation_id, category, summary, evidence_refs, recorded_by, remote_sync_state, remote_ref, created_at",
            )
            .eq("evaluation_id", evaluationId)
            .order("created_at", { ascending: false })
            .range(from, to),
        "ce_root_cause",
      );
      if (!rootResult.ok) return { ok: false, error: rootResult.error };
      rootCauses = rootResult.rows;

      const qaResult = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_qa_case")
            .select(
              "id, evaluation_id, case_number, title, description, status, priority, remote_sync_state, remote_ref, created_at",
            )
            .eq("evaluation_id", evaluationId)
            .order("created_at", { ascending: false })
            .range(from, to),
        "ce_qa_case",
      );
      if (!qaResult.ok) return { ok: false, error: qaResult.error };
      qaCases = qaResult.rows;

      const attemptId = evaluation?.attempt_id;
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
        if (snapErr) return { ok: false, error: `ce_bundle_snapshot: ${snapErr.message}` };
        snapshot = snap;
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
        evaluation_available: availability.available,
        evaluation_unavailable_reason: availability.reason,
        details,
        messages: messageResult.rows,
        emotion,
        nextSteps,
        discrepancies,
        rootCauses,
        qaCases,
        snapshot,
        sectionErrors: [] as CeDetailSectionError[],
      },
    };
  });

// Legacy exports retained only for existing deep links/backward compatibility.
// Active Conversation Evaluation route uses the conversation-first functions above.

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
    return { ok: true, data: { evaluation } };
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
