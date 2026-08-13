-- PR-3 — human reply / return-to-AI race guard.
-- SOURCE ONLY. Do not apply to production without explicit Director authorization.
--
-- Atomic invariant:
--   agent_send_reply_tx locks conversations first, then re-validates:
--     status = pending
--     assigned_agent_id = p_agent_id
--   and only then inserts the customer-visible agent reply.
--
-- Because return_to_ai_tx / assign / takeover also lock the same conversation row,
-- whichever operation wins the row lock owns the state transition. A stale
-- pre-read can no longer emit a reply after control has changed.

BEGIN;

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
  v_now timestamptz := now();
BEGIN
  IF p_content IS NULL
     OR btrim(p_content) = ''
     OR length(p_content) > 4000 THEN
    RETURN jsonb_build_object('result', 'invalid_content');
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

  SELECT id, status
    INTO v_agent
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
    status,
    sender_id,
    is_recalled,
    metadata
  )
  VALUES (
    p_conversation_id,
    'agent',
    btrim(p_content),
    'delivered',
    p_agent_id,
    false,
    jsonb_build_object(
      'agent_id', p_agent_id,
      'agent_name', COALESCE(p_agent_name, ''),
      'control_commit', 'human'
    )
  )
  RETURNING id INTO v_message_id;

  -- Source-scoped AI placeholders are no longer meaningful after a human reply.
  -- Mark them recalled rather than deleting audit history.
  UPDATE public.messages
  SET is_recalled = true,
      status = 'failed',
      metadata = COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
          'resolved_by', 'agent_reply',
          'agent_id', p_agent_id
        )
  WHERE conversation_id = p_conversation_id
    AND content = '__THINKING__'
    AND is_recalled = false;

  UPDATE public.conversations
  SET updated_at = v_now
  WHERE id = p_conversation_id;

  INSERT INTO public.audit_log (
    actor_id,
    actor_type,
    action,
    resource_type,
    resource_id,
    diff
  )
  VALUES (
    p_agent_id,
    'agent',
    'agent_send_reply',
    'messages',
    v_message_id,
    jsonb_build_object(
      'conversation_id', p_conversation_id,
      'length', length(btrim(p_content)),
      'control_state', 'pending',
      'owner_agent_id', p_agent_id
    )
  );

  RETURN jsonb_build_object(
    'result', 'success',
    'message_id', v_message_id
  );
END;
$function$;

ALTER FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text)
  TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.agent_send_reply_tx(uuid,uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated cannot invoke agent_send_reply_tx';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.agent_send_reply_tx(uuid,uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: service_role execute missing';
  END IF;
END
$assert$;

COMMIT;
