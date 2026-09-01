begin;

-- Task 6.3 rollback for the Task 6.2 realtime CE DB activation only.
-- Edge-function rollback is performed by redeploying the captured pre-deploy live bundles/hashes.

drop trigger if exists trg_zz_ce_realtime_assistant_dispatch on public.messages;
drop function if exists public.ce_realtime_assistant_message_trigger_v1();
drop function if exists public.ce_dispatch_realtime_evaluation_v1(uuid);

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
begin
  perform pg_advisory_xact_lock(hashtextextended('ce-job-claim',0));
  perform public.ce_reap_expired_jobs_v1();
  select * into v_cfg from public.ce_automation_runtime where singleton=true;
  if not coalesce(v_cfg.enabled,false) then return jsonb_build_object('result','disabled'); end if;
  select * into v_job from public.ce_evaluation_job where id=p_job_id for update;
  if v_job.id is null then return jsonb_build_object('result','not_found'); end if;
  if v_job.status='running' then return jsonb_build_object('result','already_running','job_id',v_job.id); end if;
  if v_job.status<>'queued' or v_job.available_at>now() then return jsonb_build_object('result','not_claimable','status',v_job.status); end if;
  select count(*) into v_global from public.ce_evaluation_job where status='running';
  if v_global>=v_cfg.global_concurrency then return jsonb_build_object('result','global_busy'); end if;
  select count(*) into v_bucket_running
  from public.ce_evaluation_job j
  where j.status='running'
    and coalesce(j.company_id::text,'__preactivation__')=coalesce(v_job.company_id::text,'__preactivation__');
  if v_bucket_running>=v_cfg.per_company_concurrency then return jsonb_build_object('result','company_busy'); end if;
  update public.ce_evaluation_job
  set status='running', lease_owner=p_worker_id, lease_expires_at=now()+interval '10 minutes',
      started_at=coalesce(started_at,now()), attempts=attempts+1, error_code=null, updated_at=now()
  where id=p_job_id;
  return jsonb_build_object('result','claimed','job_id',p_job_id);
end;
$function$;

revoke all on function public.ce_claim_specific_job_v1(uuid,text) from public, anon, authenticated;
grant execute on function public.ce_claim_specific_job_v1(uuid,text) to service_role;

commit;
