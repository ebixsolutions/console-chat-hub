-- Product-ready closure: Widget Live Test conversations are test data and must
-- never participate in the production human-support queue or ETA metrics.
-- They may retain conversation.status='pending' to exercise handoff UI/state.

create or replace function public.sync_human_support_queue_from_conversation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_human boolean;
  v_reentered boolean;
  v_is_widget_live_test boolean;
begin
  v_is_widget_live_test := coalesce((new.metadata_source ->> 'widget_live_test')::boolean, false)
    or coalesce(new.metadata_source ->> 'source', '') = 'widget_live_test';

  -- Test conversations must not enter or remain in the real customer queue.
  if v_is_widget_live_test then
    update public.human_support_queue
       set state = 'closed',
           assigned_agent_id = null,
           closed_at = coalesce(closed_at, now()),
           updated_at = now()
     where conversation_id = new.id
       and state <> 'closed';
    return new;
  end if;

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
$function$;

create or replace function public.get_human_support_queue_snapshot(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  q public.human_support_queue%rowtype;
  v_position integer;
  v_ahead integer;
  v_active_agents integer;
  v_history_count integer;
  v_avg_seconds numeric;
  v_eta_minutes integer;
  v_is_widget_live_test boolean;
begin
  select coalesce((c.metadata_source ->> 'widget_live_test')::boolean, false)
      or coalesce(c.metadata_source ->> 'source', '') = 'widget_live_test'
    into v_is_widget_live_test
    from public.conversations c
   where c.id = p_conversation_id;

  if coalesce(v_is_widget_live_test, false) then
    return jsonb_build_object(
      'state','none',
      'queue_position',null,
      'customers_ahead',null,
      'estimated_wait_minutes',null,
      'estimate_confidence','test_conversation_excluded'
    );
  end if;

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
    join public.conversations xc on xc.id = x.conversation_id
   where x.company_id = q.company_id
     and x.state = 'waiting'
     and not (
       coalesce((xc.metadata_source ->> 'widget_live_test')::boolean, false)
       or coalesce(xc.metadata_source ->> 'source', '') = 'widget_live_test'
     )
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
     and not (
       coalesce((c.metadata_source ->> 'widget_live_test')::boolean, false)
       or coalesce(c.metadata_source ->> 'source', '') = 'widget_live_test'
     )
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
$function$;

-- Repair already-contaminated test queue rows without deleting test conversation history.
update public.human_support_queue q
   set state = 'closed',
       assigned_agent_id = null,
       closed_at = coalesce(q.closed_at, now()),
       updated_at = now()
  from public.conversations c
 where c.id = q.conversation_id
   and (
     coalesce((c.metadata_source ->> 'widget_live_test')::boolean, false)
     or coalesce(c.metadata_source ->> 'source', '') = 'widget_live_test'
   )
   and q.state <> 'closed';
