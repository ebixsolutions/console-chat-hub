CREATE OR REPLACE FUNCTION public.kb_fallback_handoff_tx(
  p_conversation_id uuid,
  p_safe_reply_content text,
  p_branch_tag text,
  p_source_message_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv RECORD;
  v_now TIMESTAMPTZ := NOW();
  v_msg_id uuid;
  v_thinking_deleted int;
  v_existing_branch text;
  v_allowed_branches text[] := ARRAY[
    'KB_SCOPE_GATE', 'KB_API_FAIL', 'KB_EMPTY',
    'KB_LOW_SCORE_HIGH_RISK', 'KB_LOW_SCORE_STANDARD'
  ];
BEGIN
  IF NOT (p_branch_tag = ANY(v_allowed_branches)) THEN
    RETURN jsonb_build_object('result', 'invalid_branch', 'branch', p_branch_tag);
  END IF;
  SELECT id, status, assigned_agent_id INTO v_conv
  FROM conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  PERFORM 1 FROM messages WHERE id = p_source_message_id AND conversation_id = p_conversation_id AND role = 'visitor';
  IF NOT FOUND THEN
    DELETE FROM messages WHERE conversation_id = p_conversation_id AND content = '__THINKING__'
      AND metadata @> jsonb_build_object('source_message_id', p_source_message_id::text);
    RETURN jsonb_build_object('result', 'invalid_source_message', 'source_message_id', p_source_message_id);
  END IF;
  IF v_conv.status = 'resolved' THEN
    DELETE FROM messages WHERE conversation_id = p_conversation_id AND content = '__THINKING__'
      AND metadata @> jsonb_build_object('source_message_id', p_source_message_id::text);
    RETURN jsonb_build_object('result', 'already_resolved');
  END IF;
  IF v_conv.status = 'pending' AND v_conv.assigned_agent_id IS NOT NULL THEN
    DELETE FROM messages WHERE conversation_id = p_conversation_id AND content = '__THINKING__'
      AND metadata @> jsonb_build_object('source_message_id', p_source_message_id::text);
    RETURN jsonb_build_object('result', 'already_under_human_control');
  END IF;
  IF v_conv.status = 'transferred' THEN
    DELETE FROM messages WHERE conversation_id = p_conversation_id AND content = '__THINKING__'
      AND metadata @> jsonb_build_object('source_message_id', p_source_message_id::text);
    RETURN jsonb_build_object('result', 'already_under_human_control');
  END IF;
  SELECT metadata->>'kb_fallback_branch' INTO v_existing_branch FROM messages
  WHERE conversation_id = p_conversation_id AND role = 'assistant'
    AND content IS DISTINCT FROM '__THINKING__'
    AND metadata @> jsonb_build_object('source_message_id', p_source_message_id::text)
    AND metadata ? 'kb_fallback_branch' LIMIT 1;
  IF FOUND THEN
    DELETE FROM messages WHERE conversation_id = p_conversation_id AND content = '__THINKING__'
      AND metadata @> jsonb_build_object('source_message_id', p_source_message_id::text);
    RETURN jsonb_build_object('result', 'already_handled', 'source_message_id', p_source_message_id,
      'existing_branch', v_existing_branch, 'requested_branch', p_branch_tag);
  END IF;
  DELETE FROM messages WHERE conversation_id = p_conversation_id AND content = '__THINKING__'
    AND metadata @> jsonb_build_object('source_message_id', p_source_message_id::text);
  GET DIAGNOSTICS v_thinking_deleted = ROW_COUNT;
  INSERT INTO messages (conversation_id, role, content, status, is_recalled, metadata)
  VALUES (p_conversation_id, 'assistant', p_safe_reply_content, 'delivered', false,
    jsonb_build_object('source_message_id', p_source_message_id::text, 'kb_fallback_branch', p_branch_tag))
  RETURNING id INTO v_msg_id;
  IF v_conv.status IS DISTINCT FROM 'pending' THEN
    UPDATE conversations SET status = 'pending', updated_at = v_now WHERE id = p_conversation_id;
    INSERT INTO conversation_status_log (conversation_id, old_status, new_status, changed_by, changed_by_type, reason)
    VALUES (p_conversation_id, v_conv.status, 'pending', NULL, 'ai', 'KB fallback: ' || p_branch_tag);
  ELSE
    UPDATE conversations SET updated_at = v_now WHERE id = p_conversation_id;
  END IF;
  INSERT INTO handoff_event (conversation_id, handoff_type, from_agent_id, to_agent_id, handoff_reason)
  VALUES (p_conversation_id, 'ai_to_agent', NULL, NULL, 'KB fallback: ' || p_branch_tag);
  RETURN jsonb_build_object('result', 'success', 'message_id', v_msg_id,
    'old_status', v_conv.status, 'new_status', 'pending', 'thinking_deleted', v_thinking_deleted);
END;
$function$;
REVOKE ALL ON FUNCTION public.kb_fallback_handoff_tx(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.kb_fallback_handoff_tx(uuid, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.kb_fallback_handoff_tx(uuid, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.kb_fallback_handoff_tx(uuid, text, text, uuid) TO service_role;