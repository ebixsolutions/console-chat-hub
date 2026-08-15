BEGIN;

INSERT INTO storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
VALUES (
  'widget-attachments','widget-attachments',false,10485760,
  ARRAY[
    'image/jpeg','image/png','image/gif','image/webp',
    'video/mp4','video/webm','video/quicktime',
    'application/pdf','text/plain','application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public=false,
  file_size_limit=10485760,
  allowed_mime_types=EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION public.receive_widget_attachment_tx(
  p_conversation_id uuid,p_session_token text,p_content_type text,p_storage_path text,
  p_original_name text,p_mime_type text,p_size_bytes bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE
  v_session_id uuid;
  v_conv public.conversations%ROWTYPE;
  v_message_id uuid;
BEGIN
  IF p_content_type NOT IN ('image','video','file') THEN RETURN jsonb_build_object('result','invalid_content_type'); END IF;
  IF p_size_bytes <= 0 OR p_size_bytes > 10485760 THEN RETURN jsonb_build_object('result','invalid_size'); END IF;
  IF p_storage_path IS NULL OR p_storage_path='' OR position('..' in p_storage_path)>0 THEN RETURN jsonb_build_object('result','invalid_storage_path'); END IF;

  SELECT id INTO v_session_id FROM public.visitor_session WHERE session_token=p_session_token FOR SHARE;
  IF v_session_id IS NULL THEN RETURN jsonb_build_object('result','invalid_session'); END IF;

  SELECT * INTO v_conv FROM public.conversations WHERE id=p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found'); END IF;
  IF v_conv.visitor_session_id IS DISTINCT FROM v_session_id THEN RETURN jsonb_build_object('result','invalid_session'); END IF;
  IF v_conv.status='resolved' THEN RETURN jsonb_build_object('result','resolved'); END IF;

  INSERT INTO public.messages(conversation_id,role,content,content_type,metadata,status)
  VALUES(
    p_conversation_id,'visitor',
    CASE p_content_type WHEN 'image' THEN '[Image]' WHEN 'video' THEN '[Video]' ELSE '[File]' END,
    p_content_type,
    jsonb_build_object(
      'storage_bucket','widget-attachments','storage_path',p_storage_path,
      'original_name',left(p_original_name,255),'mime_type',p_mime_type,'size_bytes',p_size_bytes
    ),
    'sent'
  )
  RETURNING id INTO v_message_id;

  UPDATE public.visitor_session SET last_seen_at=now() WHERE id=v_session_id;
  RETURN jsonb_build_object('result','success','message_id',v_message_id);
END;
$$;

REVOKE ALL ON FUNCTION public.receive_widget_attachment_tx(uuid,text,text,text,text,text,bigint)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.receive_widget_attachment_tx(uuid,text,text,text,text,text,bigint)
TO service_role;

COMMIT;
