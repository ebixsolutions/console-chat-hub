/**
 * CE read/write server functions.
 *
 * All reads go through requireSupabaseAuth so RLS applies as the caller:
 *  - canonical status comes from public.ce_conversation_status_v (never
 *    re-derived on the client)
 *  - replay bundles are read from ce_replay_bundle_sanitized_v for staff;
 *    raw evaluator payload is admin-only and never selected here
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
};

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

export const getCeEvaluationFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ evaluationId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const { data: evaluation, error } = await context.supabase
      .from("conversation_evaluation")
      .select("*")
      .eq("id", data.evaluationId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!evaluation) return { ok: false, error: "not_found" };

    const { data: details } = await context.supabase
      .from("conversation_evaluation_detail")
      .select("evaluator_type, raw_score, weight, weighted_score, justification")
      .eq("evaluation_id", data.evaluationId);

    return { ok: true, data: { evaluation, details: details ?? [] } };
  });

/** Replay Studio: rebuild from the STORED bundle version, sanitized fields only. */
export const getCeReplayBundleFn = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(z.object({ attemptId: z.string().uuid() }))
  .handler(async ({ data, context }): Promise<CeResult<any>> => {
    const loose = context.supabase as unknown as LooseClient;

    const { data: bundle, error } = await loose
      .from("ce_replay_bundle_sanitized_v")
      .select("*")
      .eq("attempt_id", data.attemptId)
      .order("bundle_version", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    if (!bundle) return { ok: false, error: "replay_bundle_unavailable" };

    const { data: chunks } = await loose
      .from("ce_replay_chunk")
      .select("chunk_id, workspace_id, tenant_id, company_id, content_hash, chunk_text_redacted, score, source_ref")
      .eq("bundle_id", (bundle as any).id);

    return { ok: true, data: { bundle, chunks: chunks ?? [] } };
  });
