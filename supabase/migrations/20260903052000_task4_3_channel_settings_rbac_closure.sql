-- Task 4.3 — Channel Settings / Origin RBAC closure
-- Source-only migration. Production application requires the existing deployment authorization gate.
-- Frozen authorization contract:
--   Admin/Supervisor: read channel + widget settings for their active company.
--   Admin: write settings.
--   Agent/QA/Roleless: no protected settings read.

begin;

drop policy if exists channel_config_read on public.channel_config;
create policy channel_config_read
on public.channel_config
for select
to authenticated
using (
  company_id is not null
  and exists (
    select 1
    from public.company_membership cm
    join public.company co on co.id = cm.company_id and co.is_active = true
    where cm.company_id = channel_config.company_id
      and cm.user_id = auth.uid()
      and cm.is_active = true
      and cm.role::text in ('admin', 'supervisor')
  )
);

drop policy if exists widget_config_read on public.widget_config;
create policy widget_config_read
on public.widget_config
for select
to authenticated
using (
  exists (
    select 1
    from public.channel_config cc
    join public.company_membership cm on cm.company_id = cc.company_id
    join public.company co on co.id = cm.company_id and co.is_active = true
    where cc.widget_config_id = widget_config.id
      and cc.company_id is not null
      and cm.user_id = auth.uid()
      and cm.is_active = true
      and cm.role::text in ('admin', 'supervisor')
  )
);

commit;
