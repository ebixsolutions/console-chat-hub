begin;

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
