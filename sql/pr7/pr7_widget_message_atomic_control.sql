-- PR-7 Website Widget message + AI-control atomic transaction.
-- SOURCE ONLY. Do not apply to production without explicit Director authorization.

BEGIN;

CREATE OR REPLACE FUNCTION public.receive_widget_message_tx(
  p_conversation_id uuid,
  p_session_token text,
  p_content text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_session_id uuid;
  v_message_id uuid;
  v_thinking_id uuid;
  v_human_control boolean;
  v_now timestamptz := now();
BEGIN
  IF p_conversation_id IS NULL
     OR p_session_token IS NULL
     OR length(p_session_token) < 32
     OR length(p_session_token) > 256
     OR p_content IS NULL
     OR btrim(p_content) = ''
     OR length(btrim(p_content)) > 2000 THEN
    RETURN jsonb_build_object('result', 'invalid_input');
  END IF;

  SELECT vs.id
    INTO v_session_id
  FROM public.visitor_session vs
  WHERE vs.session_token = p_session_token
  LIMIT 1;

  IF v_session_id IS NULL THEN
    RETURN jsonb_build_object('result', 'invalid_session');
  END IF;

  SELECT
    c.id,
    c.status,
    c.assigned_agent_id,
    c.visitor_session_id
  INTO v_conv
  FROM public.conversations c
  WHERE c.id = p_conversation_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_conv.visitor_session_id IS DISTINCT FROM v_session_id THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- Resolved/closed is checked while holding the same conversation row lock
  -- used by assignment/return/handoff/AI-commit control transitions.
  IF v_conv.status IN ('resolved', 'closed') THEN
    RETURN jsonb_build_object('result', 'resolved');
  END IF;

  v_human_control :=
    v_conv.assigned_agent_id IS NOT NULL
    OR v_conv.status IN (
      'pending',
      'transferred',
      'human_needed',
      'human_control',
      'escalation_risk',
      'unresolved'
    );

  INSERT INTO public.messages(
    conversation_id,
    role,
    content,
    status,
    is_recalled
  )
  VALUES (
    p_conversation_id,
    'visitor',
    btrim(p_content),
    'delivered',
    false
  )
  RETURNING id INTO v_message_id;

  UPDATE public.visitor_session
  SET last_seen_at = v_now
  WHERE id = v_session_id;

  UPDATE public.conversations
  SET updated_at = v_now
  WHERE id = p_conversation_id;

  IF v_human_control THEN
    RETURN jsonb_build_object(
      'result', 'human_control',
      'message_id', v_message_id
    );
  END IF;

  -- This is the same source-scoped claim contract as begin_ai_reply_tx, but
  -- performed inside the same transaction as the visitor message insert.
  SELECT id
    INTO v_thinking_id
  FROM public.messages
  WHERE conversation_id = p_conversation_id
    AND content = '__THINKING__'
    AND COALESCE(metadata->>'source_message_id', '') = v_message_id::text
    AND is_recalled = false
  LIMIT 1;

  IF v_thinking_id IS NULL THEN
    INSERT INTO public.messages(
      conversation_id,
      role,
      content,
      status,
      is_recalled,
      metadata
    )
    VALUES (
      p_conversation_id,
      'assistant',
      '__THINKING__',
      'sending',
      false,
      jsonb_build_object(
        'source_message_id', v_message_id::text,
        'control_claim', 'ai'
      )
    )
    RETURNING id INTO v_thinking_id;
  END IF;

  RETURN jsonb_build_object(
    'result', 'success',
    'message_id', v_message_id,
    'thinking_message_id', v_thinking_id
  );
END;
$function$;

ALTER FUNCTION public.receive_widget_message_tx(
  uuid,text,text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.receive_widget_message_tx(
  uuid,text,text
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.receive_widget_message_tx(
  uuid,text,text
) TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.receive_widget_message_tx(uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'ASSERT: authenticated cannot invoke receive_widget_message_tx';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.receive_widget_message_tx(uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'ASSERT: service_role execute missing for receive_widget_message_tx';
  END IF;
END
$assert$;

COMMIT;
