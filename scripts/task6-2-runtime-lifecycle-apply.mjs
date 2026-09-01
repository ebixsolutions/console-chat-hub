import fs from 'node:fs';

function mustReplace(path, from, to) {
  const s = fs.readFileSync(path, 'utf8');
  if (!s.includes(from)) throw new Error(`MISSING_MARKER ${path}: ${from.slice(0,120)}`);
  fs.writeFileSync(path, s.replace(from, to));
}

fs.writeFileSync('supabase/functions/_shared/runtime-signal-lifecycle.ts', `export interface HistoricalSentimentSignal {
  sentiment_score?: number;
  sentiment_trend?: number[];
  evaluation_id?: string;
  provider_version?: string;
}
export interface RealtimeSentimentSignal extends HistoricalSentimentSignal {
  anger_flag?: true;
  sentiment_recovered_same_turn?: true;
}

const STRONG_ANGER = /(嬲|憤怒|愤怒|火大|離譜|离谱|垃圾|廢物|废物|荒謬|荒谬|angry|furious|irate|rage|ridiculous|unacceptable|bullshit)/i;
const NEGATIVE = /(失望|不滿|不满|很差|太差|煩|烦|frustrated|annoyed|upset|disappointed|terrible|awful)/i;
const POSITIVE_RECOVERY = /(明白了|明白啦|好的現在|好的现在|而家明白|现在明白|謝謝|谢谢|thanks|thank you|got it|that helps|understand now)/i;

export function classifyCurrentTurnEmotion(text: string): { anger_flag?: true; sentiment_score?: number; provider_version: string } {
  const t = String(text ?? '').normalize('NFKC').trim();
  if (!t) return { provider_version: 'current-turn-emotion-v1.0' };
  if (STRONG_ANGER.test(t)) return { anger_flag: true, sentiment_score: -0.85, provider_version: 'current-turn-emotion-v1.0' };
  if (NEGATIVE.test(t)) return { sentiment_score: -0.5, provider_version: 'current-turn-emotion-v1.0' };
  if (POSITIVE_RECOVERY.test(t)) return { sentiment_score: 0.35, provider_version: 'current-turn-emotion-v1.0' };
  return { provider_version: 'current-turn-emotion-v1.0' };
}

export function buildRealtimeR3SentimentSignals(text: string, historical?: HistoricalSentimentSignal): RealtimeSentimentSignal | undefined {
  const current = classifyCurrentTurnEmotion(text);
  const currentScore = current.sentiment_score;
  if (currentScore === undefined && current.anger_flag !== true) return undefined;

  const base = Array.isArray(historical?.sentiment_trend)
    ? historical!.sentiment_trend!.filter(Number.isFinite).slice(-4)
    : (typeof historical?.sentiment_score === 'number' && Number.isFinite(historical.sentiment_score) ? [historical.sentiment_score] : []);
  const trend = currentScore === undefined ? base : [...base, currentScore].slice(-5);
  const previous = base.length ? base[base.length - 1] : undefined;
  const recovered = typeof previous === 'number' && previous < -0.2 && typeof currentScore === 'number' && currentScore >= 0.2;

  return {
    ...(current.anger_flag ? { anger_flag: true as const } : {}),
    ...(typeof currentScore === 'number' ? { sentiment_score: currentScore } : {}),
    ...(trend.length >= 2 ? { sentiment_trend: trend } : {}),
    ...(recovered ? { sentiment_recovered_same_turn: true as const } : {}),
    ...(historical?.evaluation_id ? { evaluation_id: historical.evaluation_id } : {}),
    provider_version: [current.provider_version, historical?.provider_version].filter(Boolean).join('+'),
  };
}
`);

const workerPath = 'supabase/functions/ce-evaluation-worker/index.ts';
mustReplace(workerPath,
`  const workerId = \`cron:\${crypto.randomUUID()}\`;
  try {
    const fingerprint = await ensureCurrentMethodology(admin);
    const { data: sweep, error: sweepErr } = await admin.rpc("ce_scheduler_enqueue_due_v1");`,
`  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const realtimeJobId = typeof body.job_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.job_id) ? body.job_id : null;
  const realtime = body.source === "realtime" && realtimeJobId !== null;
  const workerId = \`\${realtime ? "realtime" : "cron"}:\${crypto.randomUUID()}\`;
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
    const { data: sweep, error: sweepErr } = await admin.rpc("ce_scheduler_enqueue_due_v1");`);

const genPath = 'supabase/functions/generate-reply/index.ts';
mustReplace(genPath,
`import { selectGroundedDocument } from "../_shared/kb-grounding.ts";`,
`import { selectGroundedDocument } from "../_shared/kb-grounding.ts";\nimport { buildRealtimeR3SentimentSignals } from "../_shared/runtime-signal-lifecycle.ts";`);

mustReplace(genPath,
`  const _pr5R3Sentiment = await loadAuthoritativeR3SentimentSignals(
    supabaseAdmin,
    conversation_id,
    _pr5ExpectedTenantId,
  );`,
`  const _pr5HistoricalR3Sentiment = await loadAuthoritativeR3SentimentSignals(
    supabaseAdmin,
    conversation_id,
    _pr5ExpectedTenantId,
  );
  const _pr5R3Sentiment = buildRealtimeR3SentimentSignals(
    _h1LastMsg,
    _pr5HistoricalR3Sentiment,
  );`);

const strict = `  if (
    freshnessError ||
    !freshness ||
    freshness.state !== "up_to_date" ||
    freshness.last_success_source !== "canonical" ||
    !freshness.last_success_evaluation_id ||
    !freshness.last_success_fingerprint ||
    !freshness.current_evaluation_fingerprint ||
    freshness.last_success_fingerprint !== freshness.current_evaluation_fingerprint
  ) {
    return undefined;
  }

  if (freshness.last_activity_at && freshness.last_success_at) {
    const activityAt = Date.parse(String(freshness.last_activity_at));
    const successAt = Date.parse(String(freshness.last_success_at));
    if (
      !Number.isFinite(activityAt) ||
      !Number.isFinite(successAt) ||
      activityAt > successAt
    ) {
      return undefined;
    }
  }`;
const historical = `  // A new visitor turn correctly marks CE dirty before generation. The last
  // canonical evaluation is therefore historical context, not current-turn
  // truth. We may use its bounded trajectory only when lineage/tenant are valid;
  // current-turn polarity is supplied separately by the deterministic classifier.
  if (
    freshnessError ||
    !freshness ||
    freshness.last_success_source !== "canonical" ||
    !freshness.last_success_evaluation_id ||
    !freshness.last_success_fingerprint
  ) {
    return undefined;
  }`;
mustReplace(genPath, strict, historical);

const evalFresh = `.eq("company_id", expected_tenant_id)
    .eq("freshness", "current")
    .eq("evaluation_fingerprint", freshness.last_success_fingerprint)`;
mustReplace(genPath, evalFresh, `.eq("company_id", expected_tenant_id)
    .eq("evaluation_fingerprint", freshness.last_success_fingerprint)`);

const pv = `provider_version: \`ce-emotion-point-v1.1:\${String(evaluation.evaluation_fingerprint).slice(0, 12)}\`,`;
mustReplace(genPath, pv, `provider_version: \`ce-emotion-history-v1.0:\${String(evaluation.evaluation_fingerprint).slice(0, 12)}\`,`);

fs.writeFileSync('supabase/migrations/20260901062000_task6_2_realtime_ce_dispatch.sql', `begin;

create or replace function public.ce_claim_specific_job_v1(p_job_id uuid, p_worker_id text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_cfg public.ce_automation_runtime;
  v_job public.ce_evaluation_job;
  v_global integer;
  v_bucket_running integer;
  v_interactive boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('ce-job-claim',0));
  perform public.ce_reap_expired_jobs_v1();
  select * into v_cfg from public.ce_automation_runtime where singleton=true;
  select * into v_job from public.ce_evaluation_job where id=p_job_id for update;
  if v_job.id is null then return jsonb_build_object('result','not_found'); end if;
  if v_job.status='running' then return jsonb_build_object('result','already_running','job_id',v_job.id); end if;
  v_interactive := v_job.source in ('manual','ce_dwell','resolved','verified_correction');
  if not coalesce(v_cfg.enabled,false) and not v_interactive then return jsonb_build_object('result','disabled'); end if;
  if v_job.status<>'queued' or v_job.available_at>now() then return jsonb_build_object('result','not_claimable','status',v_job.status); end if;
  select count(*) into v_global from public.ce_evaluation_job where status='running';
  if v_global>=v_cfg.global_concurrency then return jsonb_build_object('result','global_busy'); end if;
  select count(*) into v_bucket_running from public.ce_evaluation_job j where j.status='running' and coalesce(j.company_id::text,'__preactivation__')=coalesce(v_job.company_id::text,'__preactivation__');
  if v_bucket_running>=v_cfg.per_company_concurrency then return jsonb_build_object('result','company_busy'); end if;
  update public.ce_evaluation_job set status='running',lease_owner=p_worker_id,lease_expires_at=now()+interval '10 minutes',started_at=coalesce(started_at,now()),attempts=attempts+1,error_code=null,updated_at=now() where id=p_job_id;
  return jsonb_build_object('result','claimed','job_id',p_job_id);
end;
$function$;
revoke all on function public.ce_claim_specific_job_v1(uuid,text) from public, anon, authenticated;
grant execute on function public.ce_claim_specific_job_v1(uuid,text) to service_role;

create or replace function public.ce_dispatch_realtime_evaluation_v1(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_enqueue jsonb;
  v_job_id uuid;
  v_cfg public.ce_automation_runtime;
  v_token text;
  v_request_id bigint;
begin
  v_enqueue := public.ce_enqueue_current_snapshot_v1(p_conversation_id,'ce_dwell',now());
  if coalesce(v_enqueue->>'result','') not in ('queued','already_queued') then
    return v_enqueue;
  end if;
  v_job_id := nullif(v_enqueue->>'job_id','')::uuid;
  if v_job_id is null then return jsonb_build_object('result','job_id_missing'); end if;
  select * into v_cfg from public.ce_automation_runtime where singleton=true;
  if nullif(trim(coalesce(v_cfg.worker_url,'')),'') is null or v_cfg.worker_secret_id is null then
    return jsonb_build_object('result','worker_not_configured','job_id',v_job_id);
  end if;
  select ds.decrypted_secret into v_token from vault.decrypted_secrets ds where ds.id=v_cfg.worker_secret_id;
  if nullif(coalesce(v_token,''),'') is null then return jsonb_build_object('result','worker_token_missing','job_id',v_job_id); end if;
  select net.http_post(
    url:=v_cfg.worker_url,
    headers:=jsonb_build_object('Content-Type','application/json','X-CE-Worker-Token',v_token),
    body:=jsonb_build_object('source','realtime','job_id',v_job_id),
    timeout_milliseconds:=5000
  ) into v_request_id;
  return jsonb_build_object('result','dispatched','job_id',v_job_id,'request_id',v_request_id);
end;
$function$;
revoke all on function public.ce_dispatch_realtime_evaluation_v1(uuid) from public, anon, authenticated;
grant execute on function public.ce_dispatch_realtime_evaluation_v1(uuid) to service_role;

create or replace function public.ce_realtime_assistant_message_trigger_v1()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if new.role='assistant' and coalesce(new.is_recalled,false)=false and coalesce(new.content,'')<>'__THINKING__' then
    perform public.ce_dispatch_realtime_evaluation_v1(new.conversation_id);
  end if;
  return new;
end;
$function$;
revoke all on function public.ce_realtime_assistant_message_trigger_v1() from public, anon, authenticated;
grant execute on function public.ce_realtime_assistant_message_trigger_v1() to service_role;

drop trigger if exists trg_zz_ce_realtime_assistant_dispatch on public.messages;
create trigger trg_zz_ce_realtime_assistant_dispatch
after insert on public.messages
for each row execute function public.ce_realtime_assistant_message_trigger_v1();

commit;
`);

console.log('TASK6_2_APPLY=PASS');
