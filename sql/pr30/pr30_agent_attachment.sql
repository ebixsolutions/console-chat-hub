-- Task 3.3 (E) — authenticated console agent attachment send.
-- SOURCE ONLY. Do not apply to production without explicit Director authorization.
--
-- Mirrors public.agent_send_reply_tx exactly for control/ownership semantics:
--   * conversation row is locked FIRST, then re-validated
--   * status must not be resolved/closed
--   * conversation must be assigned to the calling agent (takeover guard)
--   * status must be 'pending' (human control)
--   * agent profile must exist and be active
-- Only then is the customer-visible attachment message inserted, carrying
-- content_type plus storage metadata (bucket/path/original_name/mime_type/size).
--
-- The private 'widget-attachments' bucket is reused (see sql/pr15). Nothing here
-- grants storage access to anon/authenticated: object reads happen only through
-- the authenticated console signed-URL path in agent-attachment.

BEGIN;

CREATE OR REPLACE FUNCTION public.agent_send_attachment_tx(
  p_conversation_id uuid,
  p_agent_id uuid,
  p_content_type text,
  p_storage_path text,
  p_original_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_agent_name text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_agent record;
  v_message_id uuid;
  v_now timestamptz := now();
BEGIN
  IF p_content_type NOT IN ('image', 'video', 'file') THEN
    RETURN jsonb_build_object('result', 'invalid_content_type');
  END IF;
  IF p_size_bytes IS NULL OR p_size_bytes <= 0 OR p_size_bytes > 10485760 THEN
    RETURN jsonb_build_object('result', 'invalid_size');
  END IF;
  IF p_storage_path IS NULL
     OR btrim(p_storage_path) = ''
     OR position('..' in p_storage_path) > 0 THEN
    RETURN jsonb_build_object('result', 'invalid_storage_path');
  END IF;
  IF p_mime_type IS NULL OR btrim(p_mime_type) = '' THEN
    RETURN jsonb_build_object('result', 'invalid_mime_type');
  END IF;

  SELECT id, status, assigned_agent_id
    INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_conv.status IN ('resolved', 'closed') THEN
    RETURN jsonb_build_object('result', 'resolved');
  END IF;

  IF v_conv.assigned_agent_id IS NULL THEN
    RETURN jsonb_build_object('result', 'takeover_required');
  END IF;

  IF v_conv.assigned_agent_id IS DISTINCT FROM p_agent_id THEN
    RETURN jsonb_build_object('result', 'owned_by_another_agent');
  END IF;

  IF v_conv.status IS DISTINCT FROM 'pending' THEN
    RETURN jsonb_build_object('result', 'human_control_required');
  END IF;

  SELECT id, status INTO v_agent
  FROM public.agent_profile
  WHERE id = p_agent_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'agent_not_found');
  END IF;
  IF v_agent.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('result', 'agent_inactive');
  END IF;

  INSERT INTO public.messages (
    conversation_id,
    role,
    content,
    content_type,
    status,
    sender_id,
    is_recalled,
    metadata
  )
  VALUES (
    p_conversation_id,
    'agent',
    CASE p_content_type
      WHEN 'image' THEN '[Image]'
      WHEN 'video' THEN '[Video]'
      ELSE '[File]'
    END,
    p_content_type,
    'delivered',
    p_agent_id,
    false,
    jsonb_build_object(
      'agent_id', p_agent_id,
      'agent_name', COALESCE(p_agent_name, ''),
      'control_commit', 'human',
      'storage_bucket', 'widget-attachments',
      'storage_path', p_storage_path,
      'original_name', left(COALESCE(p_original_name, ''), 255),
      'mime_type', p_mime_type,
      'size_bytes', p_size_bytes
    )
  )
  RETURNING id INTO v_message_id;

  UPDATE public.conversations
  SET updated_at = v_now
  WHERE id = p_conversation_id;

  INSERT INTO public.audit_log (
    actor_id, actor_type, action, resource_type, resource_id, diff
  )
  VALUES (
    p_agent_id,
    'agent',
    'agent_send_attachment',
    'messages',
    v_message_id,
    jsonb_build_object(
      'conversation_id', p_conversation_id,
      'content_type', p_content_type,
      'mime_type', p_mime_type,
      'size_bytes', p_size_bytes,
      'control_state', 'pending',
      'owner_agent_id', p_agent_id
    )
  );

  RETURN jsonb_build_object('result', 'success', 'message_id', v_message_id);
END;
$function$;

ALTER FUNCTION public.agent_send_attachment_tx(uuid,uuid,text,text,text,text,bigint,text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.agent_send_attachment_tx(uuid,uuid,text,text,text,text,bigint,text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.agent_send_attachment_tx(uuid,uuid,text,text,text,text,bigint,text)
  TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.agent_send_attachment_tx(uuid,uuid,text,text,text,text,bigint,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated cannot invoke agent_send_attachment_tx';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.agent_send_attachment_tx(uuid,uuid,text,text,text,text,bigint,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: service_role execute missing';
  END IF;
END
$assert$;

COMMIT;
