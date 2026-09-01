begin;

-- Task 7.2: a CE result is current only when revision, methodology and the
-- canonical message snapshot are all still current at commit time.
create or replace function public.ce_finalize_evaluation_freshness_v1(
  p_conversation_id uuid,
  p_evaluation_id uuid,
  p_evaluation_source text,
  p_snapshot_hash text,
  p_evaluation_fingerprint text,
  p_expected_revision bigint,
  p_success_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_state public.ce_evaluation_state;
  v_current_fingerprint text;
  v_current_snapshot_hash text;
  v_eval_matches boolean := false;
  v_revision_current boolean;
  v_methodology_current boolean;
  v_snapshot_current boolean;
begin
  if p_evaluation_source not in ('canonical','conversation_local')
     or p_conversation_id is null
     or p_evaluation_id is null
     or nullif(trim(coalesce(p_snapshot_hash,'')),'') is null
     or coalesce(p_evaluation_fingerprint,'') !~ '^[0-9a-f]{64}$'
     or p_expected_revision is null
     or p_expected_revision < 0 then
    return jsonb_build_object('result','invalid_input');
  end if;

  if p_evaluation_source='canonical' then
    select exists(
      select 1 from public.conversation_evaluation e
      where e.id=p_evaluation_id
        and e.conversation_id=p_conversation_id
        and e.evaluation_fingerprint=p_evaluation_fingerprint
    ) into v_eval_matches;
  else
    select exists(
      select 1 from public.ce_local_evaluation e
      where e.id=p_evaluation_id
        and e.conversation_id=p_conversation_id
        and e.evaluation_fingerprint=p_evaluation_fingerprint
    ) into v_eval_matches;
  end if;
  if not v_eval_matches then
    return jsonb_build_object('result','evaluation_not_found_or_lineage_mismatch');
  end if;

  select * into v_state
  from public.ce_evaluation_state
  where conversation_id=p_conversation_id
  for update;
  if v_state.conversation_id is null then
    return jsonb_build_object('result','state_not_initialized');
  end if;

  v_current_fingerprint := public.ce_current_evaluation_fingerprint();
  v_current_snapshot_hash := public.ce_trigger_snapshot_hash_v1(p_conversation_id);
  if v_current_fingerprint is null then
    return jsonb_build_object('result','methodology_not_configured');
  end if;

  v_revision_current := v_state.revision=p_expected_revision;
  v_methodology_current := p_evaluation_fingerprint=v_current_fingerprint;
  v_snapshot_current := p_snapshot_hash=v_current_snapshot_hash;

  if v_revision_current and v_methodology_current and v_snapshot_current then
    update public.conversation_evaluation
       set freshness='superseded'
     where conversation_id=p_conversation_id
       and id<>p_evaluation_id
       and freshness='current';
    update public.ce_local_evaluation
       set freshness='superseded'
     where conversation_id=p_conversation_id
       and id<>p_evaluation_id
       and freshness='current';

    if p_evaluation_source='canonical' then
      update public.conversation_evaluation
         set evaluation_fingerprint=p_evaluation_fingerprint,
             freshness='current'
       where id=p_evaluation_id;
    else
      update public.ce_local_evaluation
         set evaluation_fingerprint=p_evaluation_fingerprint,
             freshness='current'
       where id=p_evaluation_id;
    end if;

    update public.ce_evaluation_state
       set state='up_to_date',
           current_snapshot_hash=v_current_snapshot_hash,
           current_evaluation_fingerprint=v_current_fingerprint,
           last_success_evaluation_id=p_evaluation_id,
           last_success_source=p_evaluation_source,
           last_success_snapshot_hash=p_snapshot_hash,
           last_success_fingerprint=p_evaluation_fingerprint,
           last_success_at=coalesce(p_success_at,now()),
           dirty_since=null,
           queued_at=null,
           evaluating_started_at=null,
           last_error_code=null,
           updated_at=now()
     where conversation_id=p_conversation_id;

    return jsonb_build_object('result','current');
  end if;

  if p_evaluation_source='canonical' then
    update public.conversation_evaluation
       set evaluation_fingerprint=p_evaluation_fingerprint,
           freshness='superseded'
     where id=p_evaluation_id;
  else
    update public.ce_local_evaluation
       set evaluation_fingerprint=p_evaluation_fingerprint,
           freshness='superseded'
     where id=p_evaluation_id;
  end if;

  -- Never let an obsolete completion overwrite a newer queue/running state or
  -- replace last_success_* lineage. Only the still-current revision may be
  -- transitioned back to dirty/stale_version.
  update public.ce_evaluation_state
     set state=case
           when revision<>p_expected_revision then state
           when not v_methodology_current then 'stale_version'
           else 'dirty'
         end,
         current_snapshot_hash=v_current_snapshot_hash,
         current_evaluation_fingerprint=v_current_fingerprint,
         dirty_since=case
           when revision=p_expected_revision then coalesce(dirty_since,now())
           else dirty_since
         end,
         updated_at=now()
   where conversation_id=p_conversation_id;

  return jsonb_build_object(
    'result', case
      when not v_revision_current then 'superseded_revision'
      when not v_methodology_current then 'superseded_methodology'
      else 'superseded_snapshot'
    end,
    'current_revision',v_state.revision,
    'evaluated_revision',p_expected_revision,
    'current_fingerprint',v_current_fingerprint,
    'evaluated_fingerprint',p_evaluation_fingerprint
  );
end;
$$;

-- Terminal conversations are immutable across every human-control transition.
create or replace function public.return_to_ai_tx(
  p_conversation_id uuid,
  p_actor_agent_id uuid,
  p_expected_status text,
  p_expected_owner uuid default null
) returns jsonb
language plpgsql
security definer
set search_path='public','pg_temp'
as $$
declare v_conv record; v_now timestamptz:=now();
begin
  select id,status,assigned_agent_id into v_conv
  from public.conversations where id=p_conversation_id for update;
  if not found then return jsonb_build_object('result','not_found'); end if;
  if v_conv.status in ('resolved','closed') then return jsonb_build_object('result','resolved'); end if;
  if v_conv.status is distinct from p_expected_status
     or v_conv.assigned_agent_id is distinct from p_expected_owner then
    return jsonb_build_object('result','stale_state');
  end if;
  if v_conv.assigned_agent_id is null and v_conv.status='open' then
    return jsonb_build_object('result','already_ai','conversation_id',p_conversation_id);
  end if;

  update public.conversation_assignment set is_active=false,unassigned_at=v_now
   where conversation_id=p_conversation_id and is_active=true;
  update public.conversations set assigned_agent_id=null,status='open',updated_at=v_now
   where id=p_conversation_id;
  if v_conv.status is distinct from 'open' then
    insert into public.conversation_status_log(conversation_id,old_status,new_status,changed_by,changed_by_type,reason)
    values(p_conversation_id,v_conv.status,'open',p_actor_agent_id,'agent','Return to AI');
  end if;
  insert into public.handoff_event(conversation_id,handoff_type,from_agent_id,to_agent_id,handoff_reason)
  values(p_conversation_id,'agent_to_agent',v_conv.assigned_agent_id,null,'Return to AI');
  insert into public.audit_log(actor_id,actor_type,action,resource_type,resource_id,diff)
  values(p_actor_agent_id,'agent','return_to_ai','conversations',p_conversation_id,
    jsonb_build_object('old_status',v_conv.status,'new_status','open','old_agent_id',v_conv.assigned_agent_id,'new_agent_id',null));
  return jsonb_build_object('result','success');
end;
$$;

create or replace function public.takeover_conversation_tx(
  p_conversation_id uuid,
  p_agent_id uuid,
  p_expected_status text,
  p_expected_owner uuid default null
) returns jsonb
language plpgsql
security definer
set search_path='public','pg_temp'
as $$
declare v_conv record; v_now timestamptz:=now();
begin
  select id,status,assigned_agent_id into v_conv
  from public.conversations where id=p_conversation_id for update;
  if not found then return jsonb_build_object('result','not_found'); end if;
  if v_conv.status in ('resolved','closed') then return jsonb_build_object('result','resolved'); end if;
  if v_conv.status='pending' and v_conv.assigned_agent_id=p_agent_id then
    return jsonb_build_object('result','already_owner','conversation_id',p_conversation_id);
  end if;
  if v_conv.status is distinct from p_expected_status then return jsonb_build_object('result','race_conflict'); end if;
  if p_expected_owner is null then
    if v_conv.assigned_agent_id is not null then return jsonb_build_object('result','race_conflict'); end if;
  elsif v_conv.assigned_agent_id is distinct from p_expected_owner then
    return jsonb_build_object('result','race_conflict');
  end if;

  update public.conversations set assigned_agent_id=p_agent_id,status='pending',updated_at=v_now
   where id=p_conversation_id;
  update public.conversation_assignment set is_active=false,unassigned_at=v_now
   where conversation_id=p_conversation_id and is_active=true;
  insert into public.conversation_assignment(conversation_id,agent_id,assigned_by,is_active)
  values(p_conversation_id,p_agent_id,p_agent_id,true);
  if v_conv.status is distinct from 'pending' then
    insert into public.conversation_status_log(conversation_id,old_status,new_status,changed_by,changed_by_type,reason)
    values(p_conversation_id,v_conv.status,'pending',p_agent_id,'agent','Agent takeover');
  end if;
  insert into public.handoff_event(conversation_id,handoff_type,from_agent_id,to_agent_id,handoff_reason)
  values(p_conversation_id,'agent_to_agent',v_conv.assigned_agent_id,p_agent_id,'Agent takeover');
  insert into public.audit_log(actor_id,actor_type,action,resource_type,resource_id,diff)
  values(p_agent_id,'agent','take_over_conversation','conversations',p_conversation_id,
    jsonb_build_object('old_status',v_conv.status,'new_status','pending','old_agent_id',v_conv.assigned_agent_id,'new_agent_id',p_agent_id));
  return jsonb_build_object('result','success');
end;
$$;

create or replace function public.assign_conversation_tx(
  p_conversation_id uuid,
  p_target_agent_id uuid,
  p_actor_agent_id uuid,
  p_expected_status text,
  p_expected_owner uuid default null
) returns jsonb
language plpgsql
security definer
set search_path='public','pg_temp'
as $$
declare
  v_conv record;
  v_target record;
  v_now timestamptz:=now();
  v_assignment_id uuid;
  v_new_status text;
begin
  select id,status,assigned_agent_id into v_conv
  from public.conversations where id=p_conversation_id for update;
  if not found then return jsonb_build_object('result','not_found'); end if;
  if v_conv.status in ('resolved','closed') then return jsonb_build_object('result','resolved'); end if;
  if v_conv.status is distinct from p_expected_status
     or v_conv.assigned_agent_id is distinct from p_expected_owner then
    return jsonb_build_object('result','stale_state');
  end if;

  select id,status into v_target from public.agent_profile where id=p_target_agent_id;
  if not found then return jsonb_build_object('result','target_not_found'); end if;
  if v_target.status is distinct from 'active' then return jsonb_build_object('result','target_inactive'); end if;
  if v_conv.assigned_agent_id=p_target_agent_id then
    return jsonb_build_object('result','already_assigned','conversation_id',p_conversation_id);
  end if;

  v_new_status := case
    when v_conv.status in ('pending','transferred','unresolved','human_needed','human_control') then v_conv.status
    else 'pending'
  end;

  update public.conversation_assignment set is_active=false,unassigned_at=v_now
   where conversation_id=p_conversation_id and is_active=true;
  insert into public.conversation_assignment(conversation_id,agent_id,assigned_by,is_active)
  values(p_conversation_id,p_target_agent_id,p_actor_agent_id,true)
  returning id into v_assignment_id;
  update public.conversations
     set assigned_agent_id=p_target_agent_id,status=v_new_status,updated_at=v_now
   where id=p_conversation_id;
  if v_conv.status is distinct from v_new_status then
    insert into public.conversation_status_log(conversation_id,old_status,new_status,changed_by,changed_by_type,reason)
    values(p_conversation_id,v_conv.status,v_new_status,p_actor_agent_id,'agent','Assign conversation');
  end if;
  insert into public.handoff_event(conversation_id,handoff_type,from_agent_id,to_agent_id,handoff_reason)
  values(p_conversation_id,'agent_to_agent',v_conv.assigned_agent_id,p_target_agent_id,'Assign conversation');
  insert into public.audit_log(actor_id,actor_type,action,resource_type,resource_id,diff)
  values(p_actor_agent_id,'agent','assign_conversation','conversation_assignment',v_assignment_id,
    jsonb_build_object('conversation_id',p_conversation_id,'from_agent_id',v_conv.assigned_agent_id,
      'to_agent_id',p_target_agent_id,'old_status',v_conv.status,'new_status',v_new_status));
  return jsonb_build_object('result','success','assignment_id',v_assignment_id);
end;
$$;

-- Legacy KB fail-closed handoff is also a state transition and must obey the
-- same terminal-state boundary.
create or replace function public.kb_fallback_handoff_tx(
  p_conversation_id uuid,
  p_safe_reply_content text,
  p_branch_tag text,
  p_source_message_id uuid
) returns jsonb
language plpgsql
security definer
set search_path='public','pg_temp'
as $$
declare
  v_conv record;
  v_now timestamptz:=now();
  v_msg_id uuid;
  v_thinking_deleted int;
  v_existing_branch text;
  v_allowed_branches text[]:=array['KB_SCOPE_GATE','KB_API_FAIL','KB_EMPTY','KB_LOW_SCORE_HIGH_RISK','KB_LOW_SCORE_STANDARD'];
begin
  if not(p_branch_tag=any(v_allowed_branches)) then return jsonb_build_object('result','invalid_branch','branch',p_branch_tag); end if;
  select id,status,assigned_agent_id into v_conv from public.conversations where id=p_conversation_id for update;
  if not found then return jsonb_build_object('result','not_found'); end if;
  perform 1 from public.messages where id=p_source_message_id and conversation_id=p_conversation_id and role='visitor';
  if not found then
    delete from public.messages where conversation_id=p_conversation_id and content='__THINKING__'
      and metadata @> jsonb_build_object('source_message_id',p_source_message_id::text);
    return jsonb_build_object('result','invalid_source_message','source_message_id',p_source_message_id);
  end if;
  if v_conv.status in ('resolved','closed') then
    delete from public.messages where conversation_id=p_conversation_id and content='__THINKING__'
      and metadata @> jsonb_build_object('source_message_id',p_source_message_id::text);
    return jsonb_build_object('result','already_resolved');
  end if;
  if (v_conv.status='pending' and v_conv.assigned_agent_id is not null)
     or v_conv.status in ('transferred','human_needed','human_control') then
    delete from public.messages where conversation_id=p_conversation_id and content='__THINKING__'
      and metadata @> jsonb_build_object('source_message_id',p_source_message_id::text);
    return jsonb_build_object('result','already_under_human_control');
  end if;
  select metadata->>'kb_fallback_branch' into v_existing_branch
  from public.messages
  where conversation_id=p_conversation_id and role='assistant' and content is distinct from '__THINKING__'
    and metadata @> jsonb_build_object('source_message_id',p_source_message_id::text)
    and metadata?'kb_fallback_branch' limit 1;
  if found then
    delete from public.messages where conversation_id=p_conversation_id and content='__THINKING__'
      and metadata @> jsonb_build_object('source_message_id',p_source_message_id::text);
    return jsonb_build_object('result','already_handled','source_message_id',p_source_message_id,
      'existing_branch',v_existing_branch,'requested_branch',p_branch_tag);
  end if;
  delete from public.messages where conversation_id=p_conversation_id and content='__THINKING__'
    and metadata @> jsonb_build_object('source_message_id',p_source_message_id::text);
  get diagnostics v_thinking_deleted=row_count;
  insert into public.messages(conversation_id,role,content,status,is_recalled,metadata)
  values(p_conversation_id,'assistant',p_safe_reply_content,'delivered',false,
    jsonb_build_object('source_message_id',p_source_message_id::text,'kb_fallback_branch',p_branch_tag))
  returning id into v_msg_id;
  if v_conv.status is distinct from 'pending' then
    update public.conversations set status='pending',updated_at=v_now where id=p_conversation_id;
    insert into public.conversation_status_log(conversation_id,old_status,new_status,changed_by,changed_by_type,reason)
    values(p_conversation_id,v_conv.status,'pending',null,'ai','KB fallback: '||p_branch_tag);
  else
    update public.conversations set updated_at=v_now where id=p_conversation_id;
  end if;
  insert into public.handoff_event(conversation_id,handoff_type,from_agent_id,to_agent_id,handoff_reason)
  values(p_conversation_id,'ai_to_agent',null,null,'KB fallback: '||p_branch_tag);
  return jsonb_build_object('result','success','message_id',v_msg_id,'old_status',v_conv.status,
    'new_status','pending','thinking_deleted',v_thinking_deleted);
end;
$$;

-- Queue state must be derived from the same human-control truth used by the AI
-- commit gate. Assigned agent always means human control. Synthetic widget-live
-- test conversations remain excluded from operational queues.
create or replace function public.sync_human_support_queue_from_conversation()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  v_human boolean;
  v_reentered boolean;
  v_excluded boolean;
begin
  v_excluded := coalesce(new.metadata_source->>'source','')='widget_live_test'
    and coalesce((new.metadata_source->>'widget_live_test')::boolean,false)=true
    and coalesce((new.metadata_source->>'exclude_training')::boolean,false)=true;
  v_human := not v_excluded
    and new.company_id is not null
    and (
      new.assigned_agent_id is not null
      or new.status in ('pending','transferred','unresolved','human_needed','human_control')
    );
  v_reentered := tg_op='INSERT'
    or old.status is distinct from new.status
    or old.assigned_agent_id is distinct from new.assigned_agent_id;

  if v_human then
    insert into public.human_support_queue(
      conversation_id,company_id,queued_at,state,assigned_agent_id,assigned_at,closed_at,updated_at
    ) values(
      new.id,new.company_id,now(),
      case when new.assigned_agent_id is null then 'waiting' else 'assigned' end,
      new.assigned_agent_id,
      case when new.assigned_agent_id is null then null else now() end,
      null,now()
    )
    on conflict(conversation_id) do update set
      company_id=excluded.company_id,
      queued_at=case
        when public.human_support_queue.state='closed' or v_reentered then excluded.queued_at
        else public.human_support_queue.queued_at end,
      state=excluded.state,
      assigned_agent_id=excluded.assigned_agent_id,
      assigned_at=case
        when excluded.assigned_agent_id is null then null
        when public.human_support_queue.assigned_agent_id is distinct from excluded.assigned_agent_id then now()
        else coalesce(public.human_support_queue.assigned_at,now()) end,
      closed_at=null,
      updated_at=now();
  else
    update public.human_support_queue
       set state='closed',assigned_agent_id=null,closed_at=coalesce(closed_at,now()),updated_at=now()
     where conversation_id=new.id and state<>'closed';
  end if;
  return new;
end;
$$;

-- Reconcile any existing split-brain rows after the trigger contract changes.
insert into public.human_support_queue(
  conversation_id,company_id,queued_at,priority,state,assigned_agent_id,assigned_at,closed_at,updated_at
)
select c.id,c.company_id,coalesce(c.updated_at,c.created_at,now()),100,
  case when c.assigned_agent_id is null then 'waiting' else 'assigned' end,
  c.assigned_agent_id,
  case when c.assigned_agent_id is null then null else coalesce(c.updated_at,now()) end,
  null,now()
from public.conversations c
where c.company_id is not null
  and not (
    coalesce(c.metadata_source->>'source','')='widget_live_test'
    and coalesce((c.metadata_source->>'widget_live_test')::boolean,false)=true
    and coalesce((c.metadata_source->>'exclude_training')::boolean,false)=true
  )
  and (c.assigned_agent_id is not null or c.status in ('pending','transferred','unresolved','human_needed','human_control'))
on conflict(conversation_id) do update set
  company_id=excluded.company_id,
  state=excluded.state,
  assigned_agent_id=excluded.assigned_agent_id,
  assigned_at=excluded.assigned_at,
  closed_at=null,
  updated_at=now();

update public.human_support_queue q
   set state='closed',assigned_agent_id=null,closed_at=coalesce(q.closed_at,now()),updated_at=now()
 where q.state<>'closed'
   and not exists(
     select 1 from public.conversations c
     where c.id=q.conversation_id
       and c.company_id is not null
       and not (
         coalesce(c.metadata_source->>'source','')='widget_live_test'
         and coalesce((c.metadata_source->>'widget_live_test')::boolean,false)=true
         and coalesce((c.metadata_source->>'exclude_training')::boolean,false)=true
       )
       and (c.assigned_agent_id is not null or c.status in ('pending','transferred','unresolved','human_needed','human_control'))
   );

revoke all on function public.ce_finalize_evaluation_freshness_v1(uuid,uuid,text,text,text,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.ce_finalize_evaluation_freshness_v1(uuid,uuid,text,text,text,bigint,timestamptz) to service_role;
revoke all on function public.return_to_ai_tx(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.return_to_ai_tx(uuid,uuid,text,uuid) to service_role;
revoke all on function public.takeover_conversation_tx(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.takeover_conversation_tx(uuid,uuid,text,uuid) to service_role;
revoke all on function public.assign_conversation_tx(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.assign_conversation_tx(uuid,uuid,uuid,text,uuid) to service_role;
revoke all on function public.kb_fallback_handoff_tx(uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.kb_fallback_handoff_tx(uuid,text,text,uuid) to service_role;
revoke all on function public.sync_human_support_queue_from_conversation() from public,anon,authenticated;
grant execute on function public.sync_human_support_queue_from_conversation() to service_role;

-- Structural fail-closed assertions.
do $$
declare v_def text;
begin
  select pg_get_functiondef('public.return_to_ai_tx(uuid,uuid,text,uuid)'::regprocedure) into v_def;
  if position('in (''resolved'',''closed'')' in lower(v_def))=0 then raise exception 'return_to_ai terminal guard missing'; end if;
  select pg_get_functiondef('public.takeover_conversation_tx(uuid,uuid,text,uuid)'::regprocedure) into v_def;
  if position('in (''resolved'',''closed'')' in lower(v_def))=0 then raise exception 'takeover terminal guard missing'; end if;
  select pg_get_functiondef('public.assign_conversation_tx(uuid,uuid,uuid,text,uuid)'::regprocedure) into v_def;
  if position('in (''resolved'',''closed'')' in lower(v_def))=0 then raise exception 'assign terminal guard missing'; end if;
  if position('status=v_new_status' in lower(v_def))=0 then raise exception 'assign human-control status transition missing'; end if;
  select pg_get_functiondef('public.ce_finalize_evaluation_freshness_v1(uuid,uuid,text,text,text,bigint,timestamptz)'::regprocedure) into v_def;
  if position('v_methodology_current' in v_def)=0 or position('v_snapshot_current' in v_def)=0 then
    raise exception 'CE three-way freshness guard missing';
  end if;
end $$;

commit;
