begin;

do $$
declare
  existing_job bigint;
begin
  select jobid into existing_job from cron.job where jobname='task5_1_attachment_gc' limit 1;
  if existing_job is not null then
    perform cron.unschedule(existing_job);
  end if;
end $$;

select cron.schedule(
  'task5_1_attachment_gc',
  '*/10 * * * *',
  $cron$
    select net.http_post(
      url := 'https://nrfxhqabwblzxoushgnm.supabase.co/functions/v1/attachment-gc',
      headers := jsonb_build_object('Content-Type','application/json'),
      body := '{}'::jsonb,
      timeout_milliseconds := 15000
    );
  $cron$
);

do $$
begin
  if not exists (select 1 from cron.job where jobname='task5_1_attachment_gc' and active=true) then
    raise exception 'attachment GC cron missing or inactive';
  end if;
end $$;

commit;
