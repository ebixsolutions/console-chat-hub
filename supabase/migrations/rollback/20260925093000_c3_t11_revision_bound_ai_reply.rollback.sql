-- Restore exact pre-T11 four-argument RPC.
CREATE OR REPLACE FUNCTION public.commit_ai_reply_tx(p_conversation_id uuid, p_source_message_id uuid, p_content text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_source record;
  v_existing record;
  v_message_id uuid;
  v_now timestamptz := now();
BEGIN
  IF p_content IS NULL OR btrim(p_content) = '' OR p_content = '__THINKING__' OR length(p_content) > 4000 THEN
    RETURN jsonb_build_object('result', 'invalid_content');
  END IF;

  SELECT id, status, assigned_agent_id
    INTO v_conv
    FROM public.conversations
   WHERE id = p_conversation_id
   FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;

  IF v_conv.status IN ('resolved', 'closed') THEN
    DELETE FROM public.messages
     WHERE conversation_id = p_conversation_id
       AND content = '__THINKING__'
       AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;
    RETURN jsonb_build_object('result', 'resolved');
  END IF;

  IF v_conv.assigned_agent_id IS NOT NULL
     OR v_conv.status IN ('pending', 'transferred', 'human_needed', 'human_control', 'escalation_risk', 'unresolved') THEN
    DELETE FROM public.messages
     WHERE conversation_id = p_conversation_id
       AND content = '__THINKING__'
       AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;
    RETURN jsonb_build_object('result', 'human_control');
  END IF;

  SELECT id, conversation_id, role, is_recalled, created_at
    INTO v_source
    FROM public.messages
   WHERE id = p_source_message_id
   FOR SHARE;
  IF NOT FOUND
     OR v_source.conversation_id IS DISTINCT FROM p_conversation_id
     OR v_source.role IS DISTINCT FROM 'visitor'
     OR v_source.is_recalled IS TRUE THEN
    DELETE FROM public.messages
     WHERE conversation_id = p_conversation_id
       AND content = '__THINKING__'
       AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;
    RETURN jsonb_build_object('result', 'invalid_source_message');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.handoff_event h
     WHERE h.conversation_id = p_conversation_id
       AND h.handoff_type = 'agent_to_agent'
       AND h.created_at >= v_source.created_at
  ) THEN
    DELETE FROM public.messages
     WHERE conversation_id = p_conversation_id
       AND content = '__THINKING__'
       AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;
    RETURN jsonb_build_object('result', 'superseded_source');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.messages newer
     WHERE newer.conversation_id = p_conversation_id
       AND newer.role = 'visitor'
       AND newer.is_recalled = false
       AND newer.content <> '__THINKING__'
       AND (
         newer.created_at > v_source.created_at
         OR (newer.created_at = v_source.created_at AND newer.id > v_source.id)
       )
  ) THEN
    DELETE FROM public.messages
     WHERE conversation_id = p_conversation_id
       AND content = '__THINKING__'
       AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;
    RETURN jsonb_build_object('result', 'superseded_source');
  END IF;

  SELECT id, content
    INTO v_existing
    FROM public.messages
   WHERE conversation_id = p_conversation_id
     AND role = 'assistant'
     AND is_recalled = false
     AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text
     AND content <> '__THINKING__'
   ORDER BY created_at ASC, id ASC
   LIMIT 1;
  IF FOUND THEN
    DELETE FROM public.messages
     WHERE conversation_id = p_conversation_id
       AND content = '__THINKING__'
       AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;
    IF v_existing.content = p_content THEN
      RETURN jsonb_build_object('result', 'idempotent', 'message_id', v_existing.id);
    END IF;
    RETURN jsonb_build_object('result', 'source_already_replied', 'message_id', v_existing.id);
  END IF;

  DELETE FROM public.messages
   WHERE conversation_id = p_conversation_id
     AND content = '__THINKING__'
     AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;

  INSERT INTO public.messages(conversation_id, role, content, status, is_recalled, metadata)
  VALUES (
    p_conversation_id, 'assistant', p_content, 'delivered', false,
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object('source_message_id', p_source_message_id::text, 'control_commit', 'ai')
  ) RETURNING id INTO v_message_id;

  UPDATE public.conversations SET updated_at = v_now WHERE id = p_conversation_id;
  RETURN jsonb_build_object('result', 'success', 'message_id', v_message_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.commit_ai_reply_tx(uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.commit_ai_reply_tx(uuid,uuid,text,jsonb) TO service_role;
