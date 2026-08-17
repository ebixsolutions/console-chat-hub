import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import {
  ensureCurrentMethodology,
  processEvaluationJob,
  serviceClient,
  type AutomationJob,
} from "../_shared/ce-automation-engine.ts";
import { ceCorsHeaders } from "../_shared/ce-cors.ts";

const EVALUATE_ROLES = new Set(["admin","supervisor","qa"]);

function cors(req: Request) {
  return ceCorsHeaders(req.headers.get("Origin") ?? "");
}
function json(req: Request, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), { status, headers: cors(req) });
}
function bearer(req: Request) {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]{20,4096})$/.exec((req.headers.get("Authorization") ?? "").trim());
  return m?.[1] ?? null;
}
function isUuid(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function authorized(
  admin: ReturnType<typeof serviceClient>,
  userId: string,
  conversationId: string,
) {
  const { data: conv } = await admin
    .from("conversations")
    .select("id, company_id, channel_config_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv) return false;

  let companyId = conv.company_id ? String(conv.company_id) : null;
  if (conv.channel_config_id) {
    const { data: channel } = await admin
      .from("channel_config").select("company_id")
      .eq("id", conv.channel_config_id).maybeSingle();
    const channelCompany = channel?.company_id ? String(channel.company_id) : null;
    if (companyId && channelCompany && companyId !== channelCompany) return false;
    companyId = companyId ?? channelCompany;
  }

  if (companyId) {
    const { data } = await admin
      .from("company_membership").select("role")
      .eq("company_id", companyId).eq("user_id", userId).eq("is_active", true);
    return (data ?? []).some((r) => EVALUATE_ROLES.has(String(r.role).toLowerCase()));
  }

  const { data } = await admin.from("user_roles").select("role").eq("user_id", userId);
  return (data ?? []).some((r) => EVALUATE_ROLES.has(String(r.role).toLowerCase()));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
  if (req.method !== "POST") return json(req, 405, { error: "method_not_allowed" });

  const token = bearer(req);
  if (!token) return json(req, 401, { error: "unauthorized" });

  const caller = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const { data: auth, error: authErr } = await caller.auth.getUser();
  if (authErr || !auth?.user) return json(req, 401, { error: "unauthorized" });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, 400, { error: "invalid_json" }); }

  const conversationId = body.conversation_id;
  const source = body.source;
  if (!isUuid(conversationId)) return json(req, 400, { error: "conversation_id" });
  if (source !== "manual" && source !== "ce_dwell") return json(req, 400, { error: "source" });

  const admin = serviceClient();
  if (!(await authorized(admin, auth.user.id, conversationId))) {
    return json(req, 403, { error: "forbidden" });
  }

  try {
    await ensureCurrentMethodology(admin);
    const { data: enqueue, error: enqueueErr } = await admin.rpc(
      "ce_enqueue_current_snapshot_v1",
      {
        p_conversation_id: conversationId,
        p_source: source,
        p_available_at: new Date().toISOString(),
      },
    );
    if (enqueueErr) return json(req, 500, { error: "enqueue_failed" });

    const e = (enqueue ?? {}) as Record<string, unknown>;
    const result = String(e.result ?? "");
    if (result === "up_to_date") {
      return json(req, 200, { status: "up_to_date" });
    }
    if (result === "conversation_not_evaluable") {
      return json(req, 409, { error: "conversation_not_evaluable" });
    }
    if (!["queued","already_queued"].includes(result)) {
      return json(req, 409, { error: result || "enqueue_rejected" });
    }

    const jobId = String(e.job_id ?? "");
    if (!isUuid(jobId)) return json(req, 500, { error: "job_id_missing" });

    const workerId = `interactive:${auth.user.id}:${crypto.randomUUID()}`;
    const { data: claim, error: claimErr } = await admin.rpc("ce_claim_specific_job_v1", {
      p_job_id: jobId,
      p_worker_id: workerId,
    });
    if (claimErr) return json(req, 500, { error: "claim_failed" });
    const claimResult = String((claim as Record<string, unknown> | null)?.result ?? "");
    if (claimResult !== "claimed") {
      return json(req, 202, { status: "queued", reason: claimResult, job_id: jobId });
    }

    const { data: job, error: jobErr } = await admin
      .from("ce_evaluation_job").select("*").eq("id", jobId).single();
    if (jobErr || !job) return json(req, 500, { error: "job_read_failed" });

    const outcome = await processEvaluationJob(admin, job as AutomationJob);
    if (!outcome.ok) return json(req, 502, { error: "evaluation_failed", detail: outcome.code });
    return json(req, 200, {
      status: "completed",
      evaluation_id: outcome.evaluationId,
      freshness: outcome.freshness,
      job_id: jobId,
    });
  } catch (e) {
    return json(req, 500, { error: e instanceof Error ? e.message : "internal_error" });
  }
});
