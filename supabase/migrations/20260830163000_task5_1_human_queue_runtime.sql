begin;

create table if not exists public.human_support_queue (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  company_id uuid not null,
  queued_at timestamptz not null default now(),
  priority integer not null default 100,
  state text not null default 'waiting',
  assigned_agent_id uuid null references public.agent_profile(id) on delete set null,
  assigned_at timestamptz null,
  closed_at timestamptz null,
  updated_at timestamptz not null default now(),
  constraint human_support_queue_state_check check (state in ('waiting','assigned','closed')),
  constraint human_support_queue_priority_check check (priority between 0 and 1000)
);

create index if not exists human_support_queue_company_wait_idx
  on public.human_support_queue(company_id, state, priority, queued_at, conversation_id);

alter table public.human_support_queue enable row level security;
revoke all on public.human_support_queue from public, anon, authenticated;
grant select, insert, update, delete on public.human_support_queue to service_role;

create or replace function public.sync_human_support_queue_from_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_human boolean;
  v_reentered boolean;
begin
  v_human := new.status in ('pending','transferred','unresolved');
  v_reentered := tg_op = 'INSERT'
    or old.status is distinct from new.status
    or (old.assigned_agent_id is not null and new.assigned_agent_id is null);

  if v_human then
    insert into public.human_support_queue(
      conversation_id, company_id, queued_at, state, assigned_agent_id, assigned_at, closed_at, updated_at
    ) values (
      new.id,
      new.company_id,
      now(),
      case when new.assigned_agent_id is null then 'waiting' else 'assigned' end,
      new.assigned_agent_id,
      case when new.assigned_agent_id is null then null else now() end,
      null,
      now()
    )
    on conflict (conversation_id) do update set
      company_id = excluded.company_id,
      queued_at = case
        when public.human_support_queue.state = 'closed' or v_reentered then excluded.queued_at
        else public.human_support_queue.queued_at
      end,
      state = excluded.state,
      assigned_agent_id = excluded.assigned_agent_id,
      assigned_at = case
        when excluded.assigned_agent_id is null then null
        when public.human_support_queue.assigned_agent_id is distinct from excluded.assigned_agent_id then now()
        else coalesce(public.human_support_queue.assigned_at, now())
      end,
      closed_at = null,
      updated_at = now();
  else
    update public.human_support_queue
       set state = 'closed',
           assigned_agent_id = null,
           closed_at = coalesce(closed_at, now()),
           updated_at = now()
     where conversation_id = new.id
       and state <> 'closed';
  end if;

  return new;
end;
$$;

revoke all on function public.sync_human_support_queue_from_conversation() from public, anon, authenticated;
grant execute on function public.sync_human_support_queue_from_conversation() to service_role;

drop trigger if exists trg_sync_human_support_queue on public.conversations;
create trigger trg_sync_human_support_queue
after insert or update of status, assigned_agent_id, company_id on public.conversations
for each row execute function public.sync_human_support_queue_from_conversation();

insert into public.human_support_queue(
  conversation_id, company_id, queued_at, priority, state, assigned_agent_id, assigned_at, closed_at, updated_at
)
select
  c.id,
  c.company_id,
  coalesce(c.updated_at, c.created_at, now()),
  100,
  case when c.assigned_agent_id is null then 'waiting' else 'assigned' end,
  c.assigned_agent_id,
  case when c.assigned_agent_id is null then null else coalesce(c.updated_at, now()) end,
  null,
  now()
from public.conversations c
where c.status in ('pending','transferred','unresolved')
  and c.company_id is not null
on conflict (conversation_id) do update set
  company_id = excluded.company_id,
  state = excluded.state,
  assigned_agent_id = excluded.assigned_agent_id,
  assigned_at = excluded.assigned_at,
  closed_at = null,
  updated_at = now();

create or replace function public.get_human_support_queue_snapshot(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.human_support_queue%rowtype;
  v_position integer;
  v_ahead integer;
  v_active_agents integer;
  v_history_count integer;
  v_avg_seconds numeric;
  v_eta_minutes integer;
begin
  select * into q
    from public.human_support_queue
   where conversation_id = p_conversation_id;

  if not found or q.state = 'closed' then
    return jsonb_build_object(
      'state','none',
      'queue_position',null,
      'customers_ahead',null,
      'estimated_wait_minutes',null,
      'estimate_confidence','unavailable'
    );
  end if;

  if q.state = 'assigned' then
    return jsonb_build_object(
      'state','assigned',
      'queue_position',0,
      'customers_ahead',0,
      'estimated_wait_minutes',0,
      'estimate_confidence','assigned',
      'assigned_agent_id',q.assigned_agent_id
    );
  end if;

  select count(*)::integer + 1 into v_position
    from public.human_support_queue x
   where x.company_id = q.company_id
     and x.state = 'waiting'
     and (x.priority, x.queued_at, x.conversation_id) < (q.priority, q.queued_at, q.conversation_id);
  v_ahead := greatest(v_position - 1, 0);

  select count(distinct ap.id)::integer into v_active_agents
    from public.agent_profile ap
    join public.company_membership cm on cm.user_id = ap.user_id
   where ap.status = 'active'
     and cm.company_id = q.company_id
     and cm.is_active = true;

  select count(*)::integer,
         avg(extract(epoch from (ca.unassigned_at - ca.assigned_at)))
    into v_history_count, v_avg_seconds
    from public.conversation_assignment ca
    join public.conversations c on c.id = ca.conversation_id
   where c.company_id = q.company_id
     and ca.assigned_at is not null
     and ca.unassigned_at is not null
     and ca.unassigned_at > ca.assigned_at
     and ca.unassigned_at >= now() - interval '30 days';

  if v_active_agents > 0 and v_history_count >= 3 and v_avg_seconds is not null then
    v_eta_minutes := greatest(1, ceil((v_ahead::numeric / v_active_agents::numeric) * v_avg_seconds / 60.0)::integer);
  else
    v_eta_minutes := null;
  end if;

  return jsonb_build_object(
    'state','waiting',
    'queue_position',v_position,
    'customers_ahead',v_ahead,
    'estimated_wait_minutes',v_eta_minutes,
    'estimate_confidence',case when v_eta_minutes is null then 'unavailable' else 'historical_average' end,
    'active_agents',v_active_agents,
    'history_samples',v_history_count
  );
end;
$$;

revoke all on function public.get_human_support_queue_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.get_human_support_queue_snapshot(uuid) to service_role;

-- Structural assertions.
do $$
declare
  bad integer;
begin
  select count(*) into bad
    from public.human_support_queue q
    join public.conversations c on c.id=q.conversation_id
   where q.company_id is distinct from c.company_id;
  if bad <> 0 then raise exception 'human_support_queue company lineage mismatch: %', bad; end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid='public.conversations'::regclass
      and tgname='trg_sync_human_support_queue'
      and not tgisinternal
  ) then raise exception 'human queue trigger missing'; end if;
end $$;

commit;
