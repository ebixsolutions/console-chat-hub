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

  const workerId = `cron:${crypto.randomUUID()}`;
  try {
    const fingerprint = await ensureCurrentMethodology(admin);
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
