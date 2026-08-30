begin;

create or replace function public.receive_widget_attachment_tx(
  p_conversation_id uuid,
  p_session_token text,
  p_content_type text,
  p_storage_path text,
  p_original_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_client_message_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_conv public.conversations%rowtype;
  v_message_id uuid;
begin
  if p_content_type not in ('image','video','file') then return jsonb_build_object('result','invalid_content_type'); end if;
  if p_size_bytes <= 0 or p_size_bytes > 10485760 then return jsonb_build_object('result','invalid_size'); end if;
  if p_storage_path is null or p_storage_path='' or position('..' in p_storage_path)>0 then return jsonb_build_object('result','invalid_storage_path'); end if;
  if p_mime_type is null or length(p_mime_type) > 255 then return jsonb_build_object('result','invalid_mime_type'); end if;

  select id into v_session_id from public.visitor_session where session_token=p_session_token for share;
  if v_session_id is null then return jsonb_build_object('result','invalid_session'); end if;

  select * into v_conv from public.conversations where id=p_conversation_id for update;
  if not found then return jsonb_build_object('result','not_found'); end if;
  if v_conv.visitor_session_id is distinct from v_session_id then return jsonb_build_object('result','invalid_session'); end if;
  if v_conv.company_id is null then return jsonb_build_object('result','tenant_unresolved'); end if;
  if v_conv.status in ('resolved','closed') then return jsonb_build_object('result','resolved'); end if;

  if p_client_message_id is not null then
    select id into v_message_id
      from public.messages
     where conversation_id=p_conversation_id
       and role='visitor'
       and coalesce(is_recalled,false)=false
       and metadata->>'client_message_id'=p_client_message_id::text
     limit 1;
    if v_message_id is not null then
      return jsonb_build_object('result','idempotent','message_id',v_message_id);
    end if;
  end if;

  begin
    insert into public.messages(conversation_id,role,content,content_type,metadata,status,is_recalled)
    values(
      p_conversation_id,
      'visitor',
      case p_content_type when 'image' then '[Image]' when 'video' then '[Video]' else '[File]' end,
      p_content_type,
      jsonb_strip_nulls(jsonb_build_object(
        'original_name',left(coalesce(p_original_name,''),255),
        'mime_type',p_mime_type,
        'size_bytes',p_size_bytes,
        'client_message_id',case when p_client_message_id is null then null else p_client_message_id::text end
      )),
      'delivered',false
    ) returning id into v_message_id;
  exception when unique_violation then
    if p_client_message_id is null then raise; end if;
    select id into v_message_id from public.messages
     where conversation_id=p_conversation_id
       and role='visitor'
       and coalesce(is_recalled,false)=false
       and metadata->>'client_message_id'=p_client_message_id::text
     limit 1;
    if v_message_id is null then raise; end if;
    return jsonb_build_object('result','idempotent','message_id',v_message_id);
  end;

  insert into public.message_attachment_private(message_id,conversation_id,company_id,storage_bucket,storage_path)
  values(v_message_id,p_conversation_id,v_conv.company_id,'widget-attachments',p_storage_path);

  update public.visitor_session set last_seen_at=now() where id=v_session_id;
  update public.conversations set updated_at=now() where id=p_conversation_id;
  return jsonb_build_object('result','success','message_id',v_message_id);
end;
$$;

revoke all on function public.receive_widget_attachment_tx(uuid,text,text,text,text,text,bigint,uuid) from public, anon, authenticated;
grant execute on function public.receive_widget_attachment_tx(uuid,text,text,text,text,text,bigint,uuid) to service_role;

commit;
