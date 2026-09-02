-- Task 3.2 — Agent Console Runtime
-- Completes the service-role-only text reply RPC expected by agent-send-reply
-- and prevents an AI generation started before a human-control transition from
-- committing after a later Return to AI.

CREATE OR REPLACE FUNCTION public.agent_send_reply_tx(
  p_conversation_id uuid,
  p_agent_id uuid,
  p_content text,
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
  v_content text;
  v_now timestamptz := now();
BEGIN
  v_content := btrim(COALESCE(p_content, ''));
  IF v_content = '' OR v_content = '__THINKING__' OR length(v_content) > 4000 THEN
    RETURN jsonb_build_object('result', 'invalid_content');
  END IF;

  SELECT id, status, assigned_agent_id, company_id
    INTO v_conv
    FROM public.conversations
   WHERE id = p_conversation_id
   FOR UPDATE;

  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_conv.company_id IS NULL THEN RETURN jsonb_build_object('result', 'tenant_unresolved'); END IF;
  IF v_conv.status IN ('resolved', 'closed') THEN RETURN jsonb_build_object('result', 'resolved'); END IF;
  IF v_conv.assigned_agent_id IS NULL THEN RETURN jsonb_build_object('result', 'takeover_required'); END IF;
  IF v_conv.assigned_agent_id IS DISTINCT FROM p_agent_id THEN RETURN jsonb_build_object('result', 'owned_by_another_agent'); END IF;
  IF v_conv.status IS DISTINCT FROM 'pending' THEN RETURN jsonb_build_object('result', 'human_control_required'); END IF;

  SELECT id, status INTO v_agent FROM public.agent_profile WHERE id = p_agent_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'agent_not_found'); END IF;
  IF v_agent.status IS DISTINCT FROM 'active' THEN RETURN jsonb_build_object('result', 'agent_inactive'); END IF;

  DELETE FROM public.messages
   WHERE conversation_id = p_conversation_id
     AND content = '__THINKING__';

  INSERT INTO public.messages(
    conversation_id, role, content, content_type, status,
    sender_id, is_recalled, metadata
  ) VALUES (
    p_conversation_id, 'agent', v_content, 'text', 'delivered',
    p_agent_id, false,
    jsonb_build_object(
      'agent_id', p_agent_id,
      'agent_name', COALESCE(p_agent_name, ''),
      'control_commit', 'human'
    )
  ) RETURNING id INTO v_message_id;

  UPDATE public.conversations SET updated_at = v_now WHERE id = p_conversation_id;

  INSERT INTO public.audit_log(actor_id, actor_type, action, resource_type, resource_id, diff)
  VALUES (
    p_agent_id, 'agent', 'agent_send_reply', 'messages', v_message_id,
    jsonb_build_object(
      'conversation_id', p_conversation_id,
      'control_state', 'pending',
      'owner_agent_id', p_agent_id
    )
  );

  RETURN jsonb_build_object('result', 'success', 'message_id', v_message_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.agent_send_reply_tx(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_send_reply_tx(uuid, uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.agent_send_reply_tx(uuid, uuid, text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.agent_send_reply_tx(uuid, uuid, text, text) TO service_role;

-- Preserve Task 2.3 atomic/idempotent semantics while adding one control-boundary
-- assertion: an AI generation cannot cross an agent-to-agent control transition.
CREATE OR REPLACE FUNCTION public.commit_ai_reply_tx(
  p_conversation_id uuid,
  p_source_message_id uuid,
  p_content text,
  p_metadata jsonb DEFAULT NULL
)
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

  -- Existing generate-reply already treats superseded_source as a safe skip.
  -- Reuse that frozen result code for a control-epoch invalidation.
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

REVOKE ALL ON FUNCTION public.commit_ai_reply_tx(uuid, uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_ai_reply_tx(uuid, uuid, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.commit_ai_reply_tx(uuid, uuid, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.commit_ai_reply_tx(uuid, uuid, text, jsonb) TO service_role;
