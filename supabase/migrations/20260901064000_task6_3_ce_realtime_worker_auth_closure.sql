begin;

do $do$
declare
  v_token text;
  v_secret_id uuid;
begin
  select ds.decrypted_secret into v_token
  from public.ce_automation_runtime r
  left join vault.decrypted_secrets ds on ds.id=r.worker_secret_id
  where r.singleton=true;

  if nullif(v_token,'') is null then
    v_token := encode(extensions.gen_random_bytes(32),'hex');
    select vault.create_secret(v_token, 'ce_realtime_worker_token_'||to_char(clock_timestamp(),'YYYYMMDDHH24MISS'), 'Task 6.3 realtime CE worker token') into v_secret_id;
    update public.ce_automation_runtime
       set worker_secret_id=v_secret_id,
           worker_token_hash=encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex'),
           updated_at=now()
     where singleton=true;
  else
    update public.ce_automation_runtime
       set worker_token_hash=encode(extensions.digest(convert_to(v_token,'UTF8'),'sha256'),'hex'),
           updated_at=now()
     where singleton=true;
  end if;
end
$do$;

create or replace function public.ce_verify_worker_token_v1(p_token text)
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select r.worker_token_hash is not null
     and r.worker_token_hash=encode(extensions.digest(convert_to(coalesce(p_token,''),'UTF8'),'sha256'),'hex')
  from public.ce_automation_runtime r
  where r.singleton=true
$function$;
revoke all on function public.ce_verify_worker_token_v1(text) from public, anon, authenticated;
grant execute on function public.ce_verify_worker_token_v1(text) to service_role;

commit;
