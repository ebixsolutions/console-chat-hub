begin;

create or replace function public.receive_widget_message_tx(
  p_conversation_id uuid,
  p_session_token text,
  p_content text,
  p_client_message_id text
) returns jsonb
language plpgsql
security definer
set search_path='public','pg_temp'
as $$
declare
  v_conv record; v_session record; v_message_id uuid; v_thinking_id uuid;
  v_human_control boolean; v_now timestamptz:=now(); v_client_id text;
begin
  if p_conversation_id is null or p_session_token is null or length(p_session_token)<32 or length(p_session_token)>256 or p_content is null or btrim(p_content)='' or length(btrim(p_content))>2000 then
    return jsonb_build_object('result','invalid_input');
  end if;
  v_client_id:=nullif(btrim(coalesce(p_client_message_id,'')),'');
  if v_client_id is not null and v_client_id !~ '^[0-9a-fA-F-]{36}$' then return jsonb_build_object('result','invalid_client_message_id'); end if;

  select vs.id,vs.channel_config_id,vs.visitor_metadata->>'origin' as origin into v_session
  from public.visitor_session vs where vs.session_token=p_session_token limit 1;
  if not found then return jsonb_build_object('result','invalid_session'); end if;

  select c.id,c.status,c.assigned_agent_id,c.visitor_session_id,c.channel_config_id into v_conv
  from public.conversations c where c.id=p_conversation_id for update;
  if not found or v_conv.visitor_session_id is distinct from v_session.id or v_conv.channel_config_id is distinct from v_session.channel_config_id then
    return jsonb_build_object('result','not_found');
  end if;
  if v_conv.status in ('resolved','closed') then return jsonb_build_object('result','resolved'); end if;

  if v_client_id is not null then
    select id into v_message_id from public.messages
    where conversation_id=p_conversation_id and role='visitor' and coalesce(is_recalled,false)=false
      and metadata->>'client_message_id'=v_client_id limit 1;
    if found then
      return jsonb_build_object('result','idempotent','message_id',v_message_id,'ai_reply_pending',
        exists(select 1 from public.messages where conversation_id=p_conversation_id and content='__THINKING__'
          and metadata->>'source_message_id'=v_message_id::text and coalesce(is_recalled,false)=false));
    end if;
  end if;

  -- Must stay exactly aligned with commit_ai_reply_tx. Once any human-control
  -- state is active, persist the visitor message but never claim AI generation.
  v_human_control:=v_conv.assigned_agent_id is not null or v_conv.status in (
    'pending','transferred','human_needed','human_control','escalation_risk','unresolved'
  );

  insert into public.messages(conversation_id,role,content,status,is_recalled,metadata)
  values(p_conversation_id,'visitor',btrim(p_content),'delivered',false,
    case when v_client_id is null then '{}'::jsonb else jsonb_build_object('client_message_id',v_client_id) end)
  returning id into v_message_id;
  update public.visitor_session set last_seen_at=v_now where id=v_session.id;
  update public.conversations set updated_at=v_now where id=p_conversation_id;

  if v_human_control then return jsonb_build_object('result','human_control','message_id',v_message_id); end if;

  insert into public.messages(conversation_id,role,content,status,is_recalled,metadata)
  values(p_conversation_id,'assistant','__THINKING__','sending',false,
    jsonb_build_object('source_message_id',v_message_id::text,'control_claim','ai'))
  returning id into v_thinking_id;
  return jsonb_build_object('result','success','message_id',v_message_id,'thinking_message_id',v_thinking_id);
exception when unique_violation then
  if v_client_id is not null then
    select id into v_message_id from public.messages where conversation_id=p_conversation_id and role='visitor'
      and metadata->>'client_message_id'=v_client_id limit 1;
    return jsonb_build_object('result','idempotent','message_id',v_message_id);
  end if;
  raise;
end;
$$;

revoke all on function public.receive_widget_message_tx(uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.receive_widget_message_tx(uuid,text,text,text) to service_role;

commit;
