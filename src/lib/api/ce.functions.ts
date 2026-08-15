/**
 * Conversation Evaluation server functions — Task 1 Conversation-First Core.
 *
 * Canonical tenant-bound evaluations remain authoritative when available.
 * Before SU Platform canonical identity is activated, AI Chatbot conversations
 * may be evaluated into the isolated ce_local_* store. No fake company_id is
 * created and canonical CE lineage triggers are not weakened.
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
const CUSTOMER_ROLES = new Set(["visitor", "customer", "user"]);
const AI_ROLES = new Set(["assistant", "ai", "bot"]);

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
    rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta)
      ? (rawMeta as Record<string, unknown>)
      : {};
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  const email = typeof meta.email === "string" ? meta.email.trim() : "";
  const shortId = (visitorSession?.id || conversationId).slice(0, 8);
  const channel = channelName || "Visitor";
  if (name) return name;
  if (email) return email;
  return `${channel} Visitor #${shortId}`;
}


type MetadataValue = {
  value: string | null;
  source: string | null;
};

export interface CeConversationMetadata {
  customer_tier: MetadataValue;
  intent: MetadataValue;
  language: MetadataValue;
}

function nonEmptyText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function firstMetadataValue(
  directValue: unknown,
  directSource: string,
  visitorMetadata: unknown,
  visitorKeys: string[],
): MetadataValue {
  const direct = nonEmptyText(directValue);
  if (direct) return { value: direct, source: directSource };

  const meta =
    visitorMetadata && typeof visitorMetadata === "object" && !Array.isArray(visitorMetadata)
      ? (visitorMetadata as Record<string, unknown>)
      : {};
  for (const key of visitorKeys) {
    const value = nonEmptyText(meta[key]);
    if (value) return { value, source: `visitor_metadata.${key}` };
  }
  return { value: null, source: null };
}

function resolveConversationMetadata(conv: any): CeConversationMetadata {
  const visitor = conv.visitor_session as { visitor_metadata?: unknown } | null;
  const visitorMetadata = visitor?.visitor_metadata;

  return {
    customer_tier: firstMetadataValue(
      conv.customer_tier,
      "conversations.customer_tier",
      visitorMetadata,
      ["customer_tier", "tier", "customer_segment"],
    ),
    intent: firstMetadataValue(
      conv.intent,
      "conversations.intent",
      visitorMetadata,
      ["intent", "conversation_intent"],
    ),
    language: firstMetadataValue(
      conv.language,
      "conversations.language",
      visitorMetadata,
      ["language", "language_preference", "locale"],
    ),
  };
}

export interface CeLegacyQaMetric {
  quality_score: number;
  empathy_score: number;
  policy_accuracy_score: number;
  vip_awareness_score: number;
  resolution_speed_score: number;
  context_score: number;
  source_system: string;
  source_record_id: string | null;
  recorded_at: string;
}

type Readiness = { available: boolean; reason: string | null };

function readinessForMessages(messages: any[]): Readiness {
  const usable = messages.filter(
    (m) => !m.is_recalled && String(m.content ?? "") !== "__THINKING__",
  );
  const hasCustomer = usable.some((m) =>
    CUSTOMER_ROLES.has(String(m.role ?? "").toLowerCase()),
  );
  const hasAi = usable.some((m) =>
    AI_ROLES.has(String(m.role ?? "").toLowerCase()),
  );
  if (!hasCustomer) return { available: false, reason: "customer_message_required" };
  if (!hasAi) return { available: false, reason: "ai_response_required" };
  return { available: true, reason: null };
}

function latestByConversation(rows: any[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (const row of rows) {
    const id = String(row.conversation_id);
    if (!out[id]) out[id] = row;
  }
  return out;
}

function chooseEvaluation(canonical: any | null, local: any | null): any | null {
  if (!canonical) return local ? { ...local, evaluation_source: "conversation_local" } : null;
  if (!local) return { ...canonical, evaluation_source: "canonical" };

  // Task 3 canonical rebinding: once the local record maps to this canonical
  // evaluation, canonical is authoritative regardless of created_at ordering.
  if (
    local.canonical_evaluation_id &&
    String(local.canonical_evaluation_id) === String(canonical.id)
  ) {
    return { ...canonical, evaluation_source: "canonical" };
  }

  const c = Date.parse(String(canonical.created_at ?? "")) || 0;
  const l = Date.parse(String(local.created_at ?? "")) || 0;
  return l > c
    ? { ...local, evaluation_source: "conversation_local" }
    : { ...canonical, evaluation_source: "canonical" };
}


const SU_COACH_REVIEW_THRESHOLD = 75;

type ReviewFindingFlags = {
  hallucination: boolean;
  policy: boolean;
};

type ReviewTriggerResult = {
  needsReview: boolean;
  reasons: string[];
};

function suCoachReviewTrigger(args: {
  reviewStatus: string | null | undefined;
  overallScore: number | null | undefined;
  conversationStatus: string | null | undefined;
  findings: ReviewFindingFlags;
}): ReviewTriggerResult {
  if (String(args.reviewStatus ?? "pending") !== "pending") {
    return { needsReview: false, reasons: [] };
  }

  const reasons: string[] = [];
  const score = Number(args.overallScore);
  if (Number.isFinite(score) && score < SU_COACH_REVIEW_THRESHOLD) {
    reasons.push("score_below_75");
  }
  if (args.findings.hallucination) reasons.push("hallucination_detected");
  if (args.findings.policy) reasons.push("policy_conflict_detected");

  // SU Coach source used Pending/Escalated. In AI Chatbot the frozen handoff
  // lifecycle represents human-review/escalation control with status=pending.
  if (String(args.conversationStatus ?? "").toLowerCase() === "pending") {
    reasons.push("conversation_pending");
  }

  return { needsReview: reasons.length > 0, reasons };
}

function addFinding(
  map: Record<string, ReviewFindingFlags>,
  evaluationId: unknown,
  dimension: unknown,
): void {
  const id = String(evaluationId ?? "");
  if (!id) return;
  const d = String(dimension ?? "").toLowerCase();
  const flags = (map[id] ??= { hallucination: false, policy: false });
  if (d === "hallucination") flags.hallucination = true;
  if (d === "policy") flags.policy = true;
}

export interface CeConversationRow {
  conversation_id: string;
  conversation_status: string;
  priority: string | null;
  created_at: string | null;
  updated_at: string | null;
  channel_name: string | null;
  customer_label: string;
  customer_tier: string | null;
  intent: string | null;
  language: string | null;
  metadata_sources: {
    customer_tier: string | null;
    intent: string | null;
    language: string | null;
  };
  latest_preview: string;
  evaluation_id: string | null;
  overall_score: number | null;
  severity: string | null;
  review_status: string | null;
  evaluated_at: string | null;
  needs_review: boolean;
  needs_review_reasons: string[];
  evaluation_available: boolean;
  evaluation_unavailable_reason: string | null;
  evaluation_source?: "canonical" | "conversation_local" | null;
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
  limit: z.number().int().min(1).max(500).optional(),
});

export const listConversationsForCeFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(listConvInput)
  .handler(async ({ data, context }): Promise<CeResult<CeListResult>> => {
    const loose = context.supabase as unknown as LooseClient;

    const convResult = await fetchAllPages(async (from, to) => {
      let q = loose
        .from("conversations")
        .select(
          "id, status, priority, created_at, updated_at, company_id, customer_tier, intent, language, metadata_source, " +
            "channel_config:channel_config_id(name, company_id), " +
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

    const canonicalRows: any[] = [];
    const localRows: any[] = [];
    const messageMap: Record<string, any[]> = {};

    for (const ids of chunk(convIds)) {
      const canonical = await fetchAllPages(
        (from, to) =>
          loose
            .from("conversation_evaluation")
            .select("id, conversation_id, overall_score, severity, review_status, created_at")
            .in("conversation_id", ids)
            .order("created_at", { ascending: false })
            .range(from, to),
        "conversation_evaluation",
      );
      if (!canonical.ok) return { ok: false, error: canonical.error };
      canonicalRows.push(...canonical.rows);

      const local = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_local_evaluation")
            .select("id, conversation_id, canonical_evaluation_id, overall_score, severity, review_status, created_at")
            .in("conversation_id", ids)
            .order("created_at", { ascending: false })
            .range(from, to),
        "ce_local_evaluation",
      );
      if (!local.ok) return { ok: false, error: local.error };
      localRows.push(...local.rows);

      const messages = await fetchAllPages(
        (from, to) =>
          loose
            .from("messages")
            .select("conversation_id, content, role, is_recalled, created_at")
            .in("conversation_id", ids)
            .neq("content", "__THINKING__")
            .order("created_at", { ascending: false })
            .range(from, to),
        "messages_preview",
      );
      if (!messages.ok) return { ok: false, error: messages.error };
      for (const m of messages.rows) {
        const cid = String(m.conversation_id);
        (messageMap[cid] ??= []).push(m);
      }
    }

    const canonicalMap = latestByConversation(canonicalRows);
    const localMap = latestByConversation(localRows);

    const canonicalEvalIds = Object.values(canonicalMap).map((ev: any) => String(ev.id));
    const localEvalIds = Object.values(localMap).map((ev: any) => String(ev.id));
    const canonicalFindings: Record<string, ReviewFindingFlags> = {};
    const localFindings: Record<string, ReviewFindingFlags> = {};

    for (const ids of chunk(canonicalEvalIds)) {
      if (ids.length === 0) continue;
      const result = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_discrepancy")
            .select("evaluation_id, dimension")
            .in("evaluation_id", ids)
            .in("dimension", ["hallucination", "policy"])
            .range(from, to),
        "ce_discrepancy_review_findings",
      );
      if (!result.ok) return { ok: false, error: result.error };
      for (const row of result.rows) addFinding(canonicalFindings, row.evaluation_id, row.dimension);
    }

    for (const ids of chunk(localEvalIds)) {
      if (ids.length === 0) continue;
      const result = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_local_discrepancy")
            .select("evaluation_id, dimension")
            .in("evaluation_id", ids)
            .in("dimension", ["hallucination", "policy"])
            .range(from, to),
        "ce_local_discrepancy_review_findings",
      );
      if (!result.ok) return { ok: false, error: result.error };
      for (const row of result.rows) addFinding(localFindings, row.evaluation_id, row.dimension);
    }

    const rows: CeConversationRow[] = convRows.map((c) => {
      const cid = String(c.id);
      const channel = c.channel_config as { name?: string | null } | null;
      const metadata = resolveConversationMetadata(c);
      const messages = messageMap[cid] ?? [];
      const readiness = readinessForMessages(messages);
      const latest = chooseEvaluation(canonicalMap[cid] ?? null, localMap[cid] ?? null);
      const source = latest?.evaluation_source ?? null;
      const reviewTrigger = latest
        ? suCoachReviewTrigger({
            reviewStatus: latest.review_status,
            overallScore: latest.overall_score,
            conversationStatus: c.status,
            findings:
              source === "canonical"
                ? (canonicalFindings[String(latest.id)] ?? { hallucination: false, policy: false })
                : (localFindings[String(latest.id)] ?? { hallucination: false, policy: false }),
          })
        : { needsReview: false, reasons: [] };
      const needsReview = reviewTrigger.needsReview;
      const previewMessage = messages[0];

      return {
        conversation_id: cid,
        conversation_status: String(c.status),
        priority: c.priority ?? null,
        created_at: c.created_at ?? null,
        updated_at: c.updated_at ?? null,
        channel_name: channel?.name ?? null,
        customer_label: resolveCustomerLabel(
          c.visitor_session as { id: string; visitor_metadata?: unknown } | null,
          cid,
          channel?.name ?? null,
        ),
        customer_tier: metadata.customer_tier.value,
        intent: metadata.intent.value,
        language: metadata.language.value,
        metadata_sources: {
          customer_tier: metadata.customer_tier.source,
          intent: metadata.intent.source,
          language: metadata.language.source,
        },
        latest_preview: previewMessage
          ? previewMessage.is_recalled
            ? "[訊息已撤回]"
            : String(previewMessage.content ?? "").slice(0, 80)
          : "(no messages)",
        evaluation_id: latest?.id ?? null,
        overall_score: latest ? Number(latest.overall_score) : null,
        severity: latest?.severity ?? null,
        review_status: latest?.review_status ?? null,
        evaluated_at: latest?.created_at ?? null,
        needs_review: needsReview,
        needs_review_reasons: reviewTrigger.reasons,
        evaluation_available: readiness.available,
        evaluation_unavailable_reason: readiness.reason,
        evaluation_source: source,
      };
    });

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
          (r.intent ?? "").toLowerCase().includes(searchLower) ||
          (r.customer_tier ?? "").toLowerCase().includes(searchLower) ||
          (r.language ?? "").toLowerCase().includes(searchLower) ||
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

    const { data: conv, error: convErr } = await loose
      .from("conversations")
      .select(
        "id, status, priority, created_at, updated_at, company_id, customer_tier, intent, language, metadata_source, " +
          "channel_config:channel_config_id(name, company_id), " +
          "visitor_session:visitor_session_id(id, visitor_metadata)",
      )
      .eq("id", data.conversationId)
      .maybeSingle();
    if (convErr) return { ok: false, error: `conversation: ${convErr.message}` };
    if (!conv) return { ok: false, error: "conversation_not_found" };

    const messageResult = await fetchAllPages(
      (from, to) =>
        loose
          .from("messages")
          .select(
            "id, conversation_id, role, content, created_at, is_recalled, metadata, sender_id, sender_identity_verified_at",
          )
          .eq("conversation_id", data.conversationId)
          .neq("content", "__THINKING__")
          .order("created_at", { ascending: true })
          .range(from, to),
      "messages",
    );
    if (!messageResult.ok) return { ok: false, error: messageResult.error };
    const readiness = readinessForMessages(messageResult.rows);

    const { data: canonicalEvals, error: canonicalErr } = await loose
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
    if (canonicalErr) return { ok: false, error: `conversation_evaluation: ${canonicalErr.message}` };

    const { data: localEvals, error: localErr } = await loose
      .from("ce_local_evaluation")
      .select("*")
      .eq("conversation_id", data.conversationId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (localErr) return { ok: false, error: `ce_local_evaluation: ${localErr.message}` };

    const canonical = canonicalEvals?.[0] ?? null;
    const local = localEvals?.[0] ?? null;
    const evaluation = chooseEvaluation(canonical, local);
    const isLocal = evaluation?.evaluation_source === "conversation_local";
    const evaluationId = evaluation?.id ? String(evaluation.id) : null;

    let details: any[] = [];
    let emotion: any[] = [];
    let nextSteps: any[] = [];
    let discrepancies: any[] = [];
    let rootCauses: any[] = [];
    let qaCases: any[] = [];
    let snapshot: any = null;

    if (evaluationId) {
      if (isLocal) {
        const [detailRes, emotionRes, nextRes, discRes, rootRes, qaRes] = await Promise.all([
          loose.from("ce_local_evaluation_detail").select("*").eq("evaluation_id", evaluationId),
          loose.from("ce_local_emotion_point").select("*").eq("evaluation_id", evaluationId).order("turn_index"),
          loose.from("ce_local_next_step").select("*").eq("evaluation_id", evaluationId).order("ordinal"),
          loose.from("ce_local_discrepancy").select("*").eq("evaluation_id", evaluationId),
          loose.from("ce_local_root_cause").select("*").eq("evaluation_id", evaluationId).order("created_at", { ascending: false }),
          loose.from("ce_local_qa_case").select("*").eq("evaluation_id", evaluationId).order("created_at", { ascending: false }),
        ]);
        if (detailRes.error) return { ok: false, error: `ce_local_evaluation_detail: ${detailRes.error.message}` };
        if (emotionRes.error) return { ok: false, error: `ce_local_emotion_point: ${emotionRes.error.message}` };
        if (nextRes.error) return { ok: false, error: `ce_local_next_step: ${nextRes.error.message}` };
        if (discRes.error) return { ok: false, error: `ce_local_discrepancy: ${discRes.error.message}` };
        if (rootRes.error) return { ok: false, error: `ce_local_root_cause: ${rootRes.error.message}` };
        if (qaRes.error) return { ok: false, error: `ce_local_qa_case: ${qaRes.error.message}` };
        details = detailRes.data ?? [];
        emotion = emotionRes.data ?? [];
        nextSteps = nextRes.data ?? [];
        discrepancies = discRes.data ?? [];
        rootCauses = rootRes.data ?? [];
        qaCases = qaRes.data ?? [];

        const { data: snap, error: snapErr } = await loose
          .from("ce_local_bundle_snapshot")
          .select("*")
          .eq("attempt_id", evaluation.attempt_id)
          .maybeSingle();
        if (snapErr) return { ok: false, error: `ce_local_bundle_snapshot: ${snapErr.message}` };
        snapshot = snap;
      } else {
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

        const tables = [
          ["ce_emotion_point", "emotion", "turn_index"],
          ["ce_next_step", "nextSteps", "ordinal"],
          ["ce_discrepancy", "discrepancies", ""],
          ["ce_root_cause", "rootCauses", "created_at"],
          ["ce_qa_case", "qaCases", "created_at"],
        ] as const;

        for (const [table, key, order] of tables) {
          let q = loose.from(table).select("*").eq("evaluation_id", evaluationId);
          if (order) q = q.order(order, { ascending: key === "emotion" || key === "nextSteps" });
          const { data: child, error } = await q;
          if (error) return { ok: false, error: `${table}: ${error.message}` };
          if (key === "emotion") emotion = child ?? [];
          else if (key === "nextSteps") nextSteps = child ?? [];
          else if (key === "discrepancies") discrepancies = child ?? [];
          else if (key === "rootCauses") rootCauses = child ?? [];
          else qaCases = child ?? [];
        }

        if (evaluation.attempt_id) {
          const { data: snap, error: snapErr } = await loose
            .from("ce_bundle_snapshot")
            .select("*")
            .eq("attempt_id", evaluation.attempt_id)
            .maybeSingle();
          if (snapErr) return { ok: false, error: `ce_bundle_snapshot: ${snapErr.message}` };
          snapshot = snap;
        }

        // Task 3: manual QA / Root Cause work performed before canonical
        // activation remains visible after the evaluation is rebound.
        const { data: localMap, error: mapErr } = await loose
          .from("ce_local_canonical_map")
          .select("local_evaluation_id")
          .eq("canonical_evaluation_id", evaluationId)
          .maybeSingle();
        if (mapErr) return { ok: false, error: `ce_local_canonical_map: ${mapErr.message}` };
        if (localMap?.local_evaluation_id) {
          const [mappedRoot, mappedQa] = await Promise.all([
            loose
              .from("ce_local_root_cause")
              .select("*")
              .eq("evaluation_id", localMap.local_evaluation_id)
              .order("created_at", { ascending: false }),
            loose
              .from("ce_local_qa_case")
              .select("*")
              .eq("evaluation_id", localMap.local_evaluation_id)
              .order("created_at", { ascending: false }),
          ]);
          if (mappedRoot.error) {
            return { ok: false, error: `ce_local_root_cause: ${mappedRoot.error.message}` };
          }
          if (mappedQa.error) {
            return { ok: false, error: `ce_local_qa_case: ${mappedQa.error.message}` };
          }
          rootCauses = [
            ...rootCauses,
            ...(mappedRoot.data ?? []).map((r: any) => ({
              ...r,
              remote_sync_state: r.remote_sync_state ?? "canonical_mapped",
            })),
          ];
          qaCases = [
            ...qaCases,
            ...(mappedQa.data ?? []).map((q: any) => ({
              ...q,
              remote_sync_state: q.remote_sync_state ?? "canonical_mapped",
            })),
          ];
        }
      }
    }

    const channel = conv.channel_config as { name?: string | null; company_id?: string | null } | null;
    const metadata = resolveConversationMetadata(conv);

    const { data: legacyQaRows, error: legacyQaErr } = await loose
      .from("ce_legacy_qa_metric")
      .select(
        "quality_score, empathy_score, policy_accuracy_score, vip_awareness_score, " +
          "resolution_speed_score, context_score, source_system, source_record_id, recorded_at",
      )
      .eq("conversation_id", data.conversationId)
      .order("recorded_at", { ascending: false })
      .limit(1);
    if (legacyQaErr) return { ok: false, error: `ce_legacy_qa_metric: ${legacyQaErr.message}` };
    const legacyQaMetric = (legacyQaRows?.[0] ?? null) as CeLegacyQaMetric | null;

    return {
      ok: true,
      data: {
        conversation: {
          id: conv.id,
          status: conv.status,
          priority: conv.priority,
          created_at: conv.created_at,
          updated_at: conv.updated_at,
          company_id: conv.company_id ?? channel?.company_id ?? null,
          channel_name: channel?.name ?? null,
          customer_label: resolveCustomerLabel(
            conv.visitor_session as { id: string; visitor_metadata?: unknown } | null,
            data.conversationId,
            channel?.name ?? null,
          ),
          customer_tier: metadata.customer_tier.value,
          intent: metadata.intent.value,
          language: metadata.language.value,
          metadata_sources: {
            customer_tier: metadata.customer_tier.source,
            intent: metadata.intent.source,
            language: metadata.language.source,
          },
        },
        legacyQaMetric,
        evaluation,
        evaluation_available: readiness.available,
        evaluation_unavailable_reason: readiness.reason,
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
    const { data: canonical, error: ceErr } = await loose
      .from("conversation_evaluation")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (ceErr) return { ok: false, error: ceErr.message };
    const { data: local, error: localErr } = await loose
      .from("ce_local_evaluation")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(data.limit);
    if (localErr) return { ok: false, error: localErr.message };
    let rows = [
      ...(canonical ?? []).map((r: any) => ({ ...r, evaluation_source: "canonical" })),
      ...(local ?? []).map((r: any) => ({ ...r, evaluation_source: "conversation_local" })),
    ].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    const conversationIds = [...new Set(rows.map((r: any) => String(r.conversation_id)))];
    const conversationStatus: Record<string, string> = {};
    for (const ids of chunk(conversationIds)) {
      if (ids.length === 0) continue;
      const result = await fetchAllPages(
        (from, to) =>
          loose
            .from("conversations")
            .select("id, status")
            .in("id", ids)
            .range(from, to),
        "ce_review_conversation_status",
      );
      if (!result.ok) return { ok: false, error: result.error };
      for (const row of result.rows) conversationStatus[String(row.id)] = String(row.status);
    }

    const canonicalIds = rows
      .filter((r: any) => r.evaluation_source === "canonical")
      .map((r: any) => String(r.id));
    const localIds = rows
      .filter((r: any) => r.evaluation_source === "conversation_local")
      .map((r: any) => String(r.id));
    const canonicalFindings: Record<string, ReviewFindingFlags> = {};
    const localFindings: Record<string, ReviewFindingFlags> = {};

    for (const ids of chunk(canonicalIds)) {
      if (ids.length === 0) continue;
      const result = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_discrepancy")
            .select("evaluation_id, dimension")
            .in("evaluation_id", ids)
            .in("dimension", ["hallucination", "policy"])
            .range(from, to),
        "ce_discrepancy_review_findings",
      );
      if (!result.ok) return { ok: false, error: result.error };
      for (const row of result.rows) addFinding(canonicalFindings, row.evaluation_id, row.dimension);
    }

    for (const ids of chunk(localIds)) {
      if (ids.length === 0) continue;
      const result = await fetchAllPages(
        (from, to) =>
          loose
            .from("ce_local_discrepancy")
            .select("evaluation_id, dimension")
            .in("evaluation_id", ids)
            .in("dimension", ["hallucination", "policy"])
            .range(from, to),
        "ce_local_discrepancy_review_findings",
      );
      if (!result.ok) return { ok: false, error: result.error };
      for (const row of result.rows) addFinding(localFindings, row.evaluation_id, row.dimension);
    }

    rows = rows.map((r: any) => {
      const source = String(r.evaluation_source);
      const trigger = suCoachReviewTrigger({
        reviewStatus: r.review_status,
        overallScore: r.overall_score,
        conversationStatus: conversationStatus[String(r.conversation_id)] ?? null,
        findings:
          source === "canonical"
            ? (canonicalFindings[String(r.id)] ?? { hallucination: false, policy: false })
            : (localFindings[String(r.id)] ?? { hallucination: false, policy: false }),
      });
      return {
        ...r,
        needs_review: trigger.needsReview,
        needs_review_reasons: trigger.reasons,
      };
    });

    if (data.severity) rows = rows.filter((r) => r.severity === data.severity);
    if (data.search) rows = rows.filter((r) => String(r.conversation_id).includes(data.search!));
    if (data.tab === "needs_review") {
      rows = rows.filter((r) => r.needs_review);
    } else if (data.tab !== "all") {
      rows = rows.filter((r) => r.evaluation_source === "canonical");
    }
    return { ok: true, data: rows.slice(0, data.limit) };
  });

export const getCeEvaluationFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ evaluationId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const loose = context.supabase as unknown as LooseClient;
    const { data: canonical, error } = await loose
      .from("conversation_evaluation")
      .select("*")
      .eq("id", data.evaluationId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (canonical) return { ok: true, data: { evaluation: { ...canonical, evaluation_source: "canonical" } } };
    const { data: local, error: localErr } = await loose
      .from("ce_local_evaluation")
      .select("*")
      .eq("id", data.evaluationId)
      .maybeSingle();
    if (localErr) return { ok: false, error: localErr.message };
    if (!local) return { ok: false, error: "not_found" };
    return { ok: true, data: { evaluation: { ...local, evaluation_source: "conversation_local" } } };
  });

export const getCeReplayBundleFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ attemptId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const loose = context.supabase as unknown as LooseClient;
    const { data: canonical, error } = await loose
      .from("ce_bundle_snapshot")
      .select("*")
      .eq("attempt_id", data.attemptId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (canonical) return { ok: true, data: { snapshot: canonical } };
    const { data: local, error: localErr } = await loose
      .from("ce_local_bundle_snapshot")
      .select("*")
      .eq("attempt_id", data.attemptId)
      .maybeSingle();
    if (localErr) return { ok: false, error: localErr.message };
    if (!local) return { ok: false, error: "replay_bundle_unavailable" };
    return { ok: true, data: { snapshot: local } };
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
    const { data: local, error: localLookupErr } = await loose
      .from("ce_local_evaluation")
      .select("id")
      .eq("id", data.evaluationId)
      .eq("conversation_id", data.conversationId)
      .maybeSingle();
    if (localLookupErr) return { ok: false, error: localLookupErr.message };
    if (local) {
      const { data: result, error } = await loose.rpc("review_local_evaluation_v1", {
        p_evaluation_id: data.evaluationId,
        p_expected_conversation_id: data.conversationId,
        p_decision: data.decision,
        p_note: data.note ?? null,
      });
      if (error) return { ok: false, error: error.message };
      const out = (result ?? {}) as Record<string, unknown>;
      return String(out.result ?? "") === "success"
        ? { ok: true, data: out }
        : { ok: false, error: String(out.result ?? "review_failed") };
    }

    const { data: result, error } = await loose.rpc("review_evaluation", {
      p_evaluation_id: data.evaluationId,
      p_expected_conversation_id: data.conversationId,
      p_decision: data.decision,
      p_note: data.note ?? null,
    });
    if (error) return { ok: false, error: error.message };
    const out = (result ?? {}) as Record<string, unknown>;
    return String(out.result ?? "") === "success"
      ? { ok: true, data: out }
      : { ok: false, error: String(out.result ?? "review_failed") };
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
    const { data: local } = await loose
      .from("ce_local_evaluation")
      .select("id")
      .eq("id", data.evaluationId)
      .maybeSingle();
    if (local) {
      const { data: result, error } = await loose.rpc("ce_create_local_qa_case_v1", {
        p_evaluation_id: data.evaluationId,
        p_expected_conversation_id: data.conversationId,
        p_title: data.title,
        p_description: data.description ?? null,
        p_priority: data.priority,
      });
      if (error) return { ok: false, error: error.message };
      const out = (result ?? {}) as Record<string, unknown>;
      return ["success", "already_exists"].includes(String(out.result ?? ""))
        ? { ok: true, data: out }
        : { ok: false, error: String(out.result ?? "create_failed") };
    }

    const { data: result, error } = await loose.rpc("ce_create_qa_case", {
      p_evaluation_id: data.evaluationId,
      p_expected_conversation_id: data.conversationId,
      p_title: data.title,
      p_description: data.description ?? null,
      p_priority: data.priority,
    });
    if (error) return { ok: false, error: error.message };
    const out = (result ?? {}) as Record<string, unknown>;
    return ["success", "already_exists"].includes(String(out.result ?? ""))
      ? { ok: true, data: out }
      : { ok: false, error: String(out.result ?? "create_failed") };
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
    const { data: local } = await loose
      .from("ce_local_evaluation")
      .select("id")
      .eq("id", data.evaluationId)
      .maybeSingle();
    if (local) {
      const { data: result, error } = await loose.rpc("ce_record_local_root_cause_v1", {
        p_evaluation_id: data.evaluationId,
        p_expected_conversation_id: data.conversationId,
        p_category: data.category,
        p_summary: data.summary,
        p_evidence: [],
      });
      if (error) return { ok: false, error: error.message };
      const out = (result ?? {}) as Record<string, unknown>;
      return String(out.result ?? "") === "success"
        ? { ok: true, data: out }
        : { ok: false, error: String(out.result ?? "record_failed") };
    }

    const { data: result, error } = await loose.rpc("ce_record_root_cause", {
      p_evaluation_id: data.evaluationId,
      p_expected_conversation_id: data.conversationId,
      p_category: data.category,
      p_summary: data.summary,
      p_evidence: [],
    });
    if (error) return { ok: false, error: error.message };
    const out = (result ?? {}) as Record<string, unknown>;
    return String(out.result ?? "") === "success"
      ? { ok: true, data: out }
      : { ok: false, error: String(out.result ?? "record_failed") };
  });
