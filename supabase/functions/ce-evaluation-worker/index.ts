import {
  ensureCurrentMethodology,
  processEvaluationJob,
  serviceClient,
  type AutomationJob,
} from "../_shared/ce-automation-engine.ts";

function out(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return out(405, { error: "method_not_allowed" });

  const token = req.headers.get("X-CE-Worker-Token") ?? "";
  const admin = serviceClient();
  const { data: valid, error: verifyErr } = await admin.rpc("ce_verify_worker_token_v1", {
    p_token: token,
  });
  if (verifyErr || valid !== true) return out(401, { error: "unauthorized" });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const realtimeJobId = typeof body.job_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.job_id) ? body.job_id : null;
  const realtime = body.source === "realtime" && realtimeJobId !== null;
  const workerId = `${realtime ? "realtime" : "cron"}:${crypto.randomUUID()}`;
  try {
    const fingerprint = await ensureCurrentMethodology(admin);
    if (realtime && realtimeJobId) {
      const { data: claim, error: claimErr } = await admin.rpc("ce_claim_specific_job_v1", { p_job_id: realtimeJobId, p_worker_id: workerId });
      if (claimErr) return out(500, { error: "claim_failed" });
      const claimResult = String((claim as Record<string, unknown> | null)?.result ?? "");
      if (claimResult === "already_running") return out(202, { status: "already_running", job_id: realtimeJobId, fingerprint });
      if (claimResult !== "claimed") return out(409, { error: "realtime_claim_rejected", reason: claimResult, job_id: realtimeJobId });
      const { data: job, error: jobErr } = await admin.from("ce_evaluation_job").select("*").eq("id", realtimeJobId).single();
      if (jobErr || !job) return out(500, { error: "job_read_failed" });
      const outcome = await processEvaluationJob(admin, job as AutomationJob);
      if (!outcome.ok) return out(502, { error: "evaluation_failed", detail: outcome.code, job_id: realtimeJobId });
      return out(200, { status: "completed", evaluation_id: outcome.evaluationId, freshness: outcome.freshness, job_id: realtimeJobId, fingerprint });
    }
    const { data: sweep, error: sweepErr } = await admin.rpc("ce_scheduler_enqueue_due_v1");
    if (sweepErr) return out(500, { error: "sweep_failed" });

    const { data: jobs, error: claimErr } = await admin.rpc("ce_claim_evaluation_jobs_v1", {
      p_worker_id: workerId,
      p_limit: 3,
    });
    if (claimErr) return out(500, { error: "claim_failed" });

    const claimed = (jobs ?? []) as AutomationJob[];
    const results = await Promise.all(claimed.map((job) => processEvaluationJob(admin, job)));
    return out(200, {
      status: "ok",
      fingerprint,
      sweep,
      claimed: claimed.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });
  } catch (e) {
    return out(500, { error: e instanceof Error ? e.message : "internal_error" });
  }
});
