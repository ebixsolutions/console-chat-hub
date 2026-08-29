-- Task 1.3 — Widget Conversational Runtime final source closure
-- Final desired state: atomic origin validation, tenant/session binding, inbound idempotency,
-- attachment schema parity, legacy compatibility wrapper, service-role-only transaction RPCs.
-- Rollback: restore prior function definitions/constraint/index only from the immediately
-- preceding authoritative migration state. Do not broaden public RPC grants or wildcard origins.

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_content_type_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_content_type_check
  CHECK (content_type = ANY (ARRAY['text'::text,'image'::text,'video'::text,'file'::text,'quick_reply'::text]));

CREATE UNIQUE INDEX IF NOT EXISTS messages_widget_client_message_id_uq
ON public.messages (conversation_id, (metadata->>'client_message_id'))
WHERE role='visitor' AND COALESCE(metadata->>'client_message_id','')<>'' AND COALESCE(is_recalled,false)=false;

CREATE OR REPLACE FUNCTION public.create_widget_session_tx(
  p_channel_id uuid,
  p_session_token text,
  p_visitor_fingerprint text,
  p_visitor_metadata jsonb,
  p_page_url text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_channel record;
  v_session_id uuid;
  v_conversation_id uuid;
  v_origin text;
BEGIN
  IF p_channel_id IS NULL OR p_session_token IS NULL OR length(p_session_token)<32 OR length(p_session_token)>256 THEN
    RETURN jsonb_build_object('result','invalid_input');
  END IF;
  v_origin:=lower(regexp_replace(COALESCE(p_page_url,''), '/$', ''));
  IF v_origin='' OR v_origin !~ '^https://[a-z0-9.-]+(:[0-9]+)?$' THEN
    RETURN jsonb_build_object('result','origin_invalid');
  END IF;
  SELECT id,company_id,is_active,channel_type,allowed_origins INTO v_channel
  FROM public.channel_config WHERE id=p_channel_id FOR SHARE;
  IF NOT FOUND OR v_channel.is_active IS DISTINCT FROM true OR v_channel.channel_type IS DISTINCT FROM 'web_widget' THEN
    RETURN jsonb_build_object('result','channel_not_found');
  END IF;
  IF v_channel.company_id IS NULL THEN RETURN jsonb_build_object('result','channel_company_unresolved'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=v_channel.company_id AND c.is_active=true) THEN
    RETURN jsonb_build_object('result','company_inactive');
  END IF;
  IF v_channel.allowed_origins IS NULL OR cardinality(v_channel.allowed_origins)=0 OR
     EXISTS(SELECT 1 FROM unnest(v_channel.allowed_origins) a WHERE a IS NULL OR btrim(a)='' OR btrim(a)='*') THEN
    RETURN jsonb_build_object('result','allowed_origins_unconfigured');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM unnest(v_channel.allowed_origins) a
    WHERE lower(regexp_replace(btrim(a), '/$', ''))=v_origin
      AND lower(regexp_replace(btrim(a), '/$', '')) ~ '^https://[a-z0-9.-]+(:[0-9]+)?$'
  ) THEN
    RETURN jsonb_build_object('result','origin_not_allowed');
  END IF;
  INSERT INTO public.visitor_session(session_token,channel_config_id,visitor_fingerprint,visitor_metadata,last_seen_at)
  VALUES(p_session_token,p_channel_id,NULLIF(left(p_visitor_fingerprint,512),''),COALESCE(p_visitor_metadata,'{}'::jsonb)||jsonb_build_object('origin',v_origin),now())
  RETURNING id INTO v_session_id;
  INSERT INTO public.conversations(visitor_session_id,channel_config_id,company_id,status)
  VALUES(v_session_id,p_channel_id,v_channel.company_id,'open') RETURNING id INTO v_conversation_id;
  INSERT INTO public.widget_session_event(visitor_session_id,event_type,event_data,page_url)
  VALUES(v_session_id,'widget_open',jsonb_build_object('conversation_id',v_conversation_id),v_origin);
  RETURN jsonb_build_object('result','success','session_id',v_session_id,'conversation_id',v_conversation_id);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('result','session_token_conflict');
END;
$function$;

CREATE OR REPLACE FUNCTION public.receive_widget_message_tx(
  p_conversation_id uuid,
  p_session_token text,
  p_content text,
  p_client_message_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE
  v_conv record; v_session record; v_message_id uuid; v_thinking_id uuid;
  v_human_control boolean; v_now timestamptz:=now(); v_client_id text;
BEGIN
  IF p_conversation_id IS NULL OR p_session_token IS NULL OR length(p_session_token)<32 OR length(p_session_token)>256 OR p_content IS NULL OR btrim(p_content)='' OR length(btrim(p_content))>2000 THEN
    RETURN jsonb_build_object('result','invalid_input');
  END IF;
  v_client_id:=NULLIF(btrim(COALESCE(p_client_message_id,'')),'');
  IF v_client_id IS NOT NULL AND v_client_id !~ '^[0-9a-fA-F-]{36}$' THEN RETURN jsonb_build_object('result','invalid_client_message_id'); END IF;
  SELECT vs.id,vs.channel_config_id,vs.visitor_metadata->>'origin' AS origin INTO v_session
  FROM public.visitor_session vs WHERE vs.session_token=p_session_token LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','invalid_session'); END IF;
  SELECT c.id,c.status,c.assigned_agent_id,c.visitor_session_id,c.channel_config_id INTO v_conv
  FROM public.conversations c WHERE c.id=p_conversation_id FOR UPDATE;
  IF NOT FOUND OR v_conv.visitor_session_id IS DISTINCT FROM v_session.id OR v_conv.channel_config_id IS DISTINCT FROM v_session.channel_config_id THEN
    RETURN jsonb_build_object('result','not_found');
  END IF;
  IF v_conv.status IN ('resolved','closed') THEN RETURN jsonb_build_object('result','resolved'); END IF;
  IF v_client_id IS NOT NULL THEN
    SELECT id INTO v_message_id FROM public.messages
    WHERE conversation_id=p_conversation_id AND role='visitor' AND COALESCE(is_recalled,false)=false
      AND metadata->>'client_message_id'=v_client_id LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('result','idempotent','message_id',v_message_id,'ai_reply_pending',
        EXISTS(SELECT 1 FROM public.messages WHERE conversation_id=p_conversation_id AND content='__THINKING__' AND metadata->>'source_message_id'=v_message_id::text AND COALESCE(is_recalled,false)=false));
    END IF;
  END IF;
  v_human_control:=v_conv.assigned_agent_id IS NOT NULL OR v_conv.status IN ('pending','transferred','unresolved');
  INSERT INTO public.messages(conversation_id,role,content,status,is_recalled,metadata)
  VALUES(p_conversation_id,'visitor',btrim(p_content),'delivered',false,
    CASE WHEN v_client_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('client_message_id',v_client_id) END)
  RETURNING id INTO v_message_id;
  UPDATE public.visitor_session SET last_seen_at=v_now WHERE id=v_session.id;
  UPDATE public.conversations SET updated_at=v_now WHERE id=p_conversation_id;
  IF v_human_control THEN RETURN jsonb_build_object('result','human_control','message_id',v_message_id); END IF;
  INSERT INTO public.messages(conversation_id,role,content,status,is_recalled,metadata)
  VALUES(p_conversation_id,'assistant','__THINKING__','sending',false,jsonb_build_object('source_message_id',v_message_id::text,'control_claim','ai'))
  RETURNING id INTO v_thinking_id;
  RETURN jsonb_build_object('result','success','message_id',v_message_id,'thinking_message_id',v_thinking_id);
EXCEPTION WHEN unique_violation THEN
  IF v_client_id IS NOT NULL THEN
    SELECT id INTO v_message_id FROM public.messages WHERE conversation_id=p_conversation_id AND role='visitor' AND metadata->>'client_message_id'=v_client_id LIMIT 1;
    RETURN jsonb_build_object('result','idempotent','message_id',v_message_id);
  END IF;
  RAISE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.receive_widget_message_tx(
  p_conversation_id uuid,
  p_session_token text,
  p_content text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
  SELECT public.receive_widget_message_tx(p_conversation_id,p_session_token,p_content,NULL::text);
$function$;

CREATE OR REPLACE FUNCTION public.receive_widget_attachment_tx(
  p_conversation_id uuid,
  p_session_token text,
  p_content_type text,
  p_storage_path text,
  p_original_name text,
  p_mime_type text,
  p_size_bytes bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_session_id uuid; v_conv public.conversations%ROWTYPE; v_message_id uuid;
BEGIN
  IF p_content_type NOT IN ('image','video','file') THEN RETURN jsonb_build_object('result','invalid_content_type'); END IF;
  IF p_size_bytes<=0 OR p_size_bytes>10485760 THEN RETURN jsonb_build_object('result','invalid_size'); END IF;
  IF p_storage_path IS NULL OR p_storage_path='' OR position('..' in p_storage_path)>0 THEN RETURN jsonb_build_object('result','invalid_storage_path'); END IF;
  SELECT id INTO v_session_id FROM public.visitor_session WHERE session_token=p_session_token FOR SHARE;
  IF v_session_id IS NULL THEN RETURN jsonb_build_object('result','invalid_session'); END IF;
  SELECT * INTO v_conv FROM public.conversations WHERE id=p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF v_conv.visitor_session_id IS DISTINCT FROM v_session_id THEN RETURN jsonb_build_object('result','invalid_session'); END IF;
  IF v_conv.status IN ('resolved','closed') THEN RETURN jsonb_build_object('result','resolved'); END IF;
  INSERT INTO public.messages(conversation_id,role,content,content_type,metadata,status,is_recalled)
  VALUES(p_conversation_id,'visitor',CASE p_content_type WHEN 'image' THEN '[Image]' WHEN 'video' THEN '[Video]' ELSE '[File]' END,p_content_type,
    jsonb_build_object('storage_bucket','widget-attachments','storage_path',p_storage_path,'original_name',left(p_original_name,255),'mime_type',p_mime_type,'size_bytes',p_size_bytes),
    'delivered',false)
  RETURNING id INTO v_message_id;
  UPDATE public.visitor_session SET last_seen_at=now() WHERE id=v_session_id;
  UPDATE public.conversations SET updated_at=now() WHERE id=p_conversation_id;
  RETURN jsonb_build_object('result','success','message_id',v_message_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_widget_session_tx(uuid,text,text,jsonb,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.receive_widget_message_tx(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.receive_widget_message_tx(uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.receive_widget_attachment_tx(uuid,text,text,text,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_widget_session_tx(uuid,text,text,jsonb,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.receive_widget_message_tx(uuid,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.receive_widget_message_tx(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.receive_widget_attachment_tx(uuid,text,text,text,text,text,bigint) TO service_role;