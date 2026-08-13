-- PR-3 — AI / human-control race guard.
-- SOURCE ONLY. Do not apply to production without explicit Director authorization.

BEGIN;

CREATE OR REPLACE FUNCTION public.begin_ai_reply_tx(
  p_conversation_id uuid,
  p_source_message_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_source record;
  v_thinking_id uuid;
BEGIN
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

  IF v_conv.assigned_agent_id IS NOT NULL
     OR v_conv.status IN (
       'pending','transferred','human_needed','human_control',
       'escalation_risk','unresolved'
     ) THEN
    RETURN jsonb_build_object('result', 'human_control');
  END IF;

  SELECT id, conversation_id, role, is_recalled
    INTO v_source
  FROM public.messages
  WHERE id = p_source_message_id
  FOR SHARE;

  IF NOT FOUND
     OR v_source.conversation_id IS DISTINCT FROM p_conversation_id
     OR v_source.role IS DISTINCT FROM 'visitor'
     OR v_source.is_recalled IS TRUE THEN
    RETURN jsonb_build_object('result', 'invalid_source_message');
  END IF;

  SELECT id
    INTO v_thinking_id
  FROM public.messages
  WHERE conversation_id = p_conversation_id
    AND content = '__THINKING__'
    AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text
    AND is_recalled = false
  LIMIT 1;

  IF v_thinking_id IS NULL THEN
    INSERT INTO public.messages (
      conversation_id, role, content, status, is_recalled, metadata
    )
    VALUES (
      p_conversation_id,
      'assistant',
      '__THINKING__',
      'sending',
      false,
      jsonb_build_object(
        'source_message_id', p_source_message_id::text,
        'control_claim', 'ai'
      )
    )
    RETURNING id INTO v_thinking_id;
  END IF;

  RETURN jsonb_build_object(
    'result', 'success',
    'thinking_message_id', v_thinking_id
  );
END;
$function$;

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
  IF p_content IS NULL
     OR btrim(p_content) = ''
     OR p_content = '__THINKING__'
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
    DELETE FROM public.messages
    WHERE conversation_id = p_conversation_id
      AND content = '__THINKING__'
      AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;
    RETURN jsonb_build_object('result', 'resolved');
  END IF;

  -- Human control always wins over an already-running AI request.
  IF v_conv.assigned_agent_id IS NOT NULL
     OR v_conv.status IN (
       'pending','transferred','human_needed','human_control',
       'escalation_risk','unresolved'
     ) THEN
    DELETE FROM public.messages
    WHERE conversation_id = p_conversation_id
      AND content = '__THINKING__'
      AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;
    RETURN jsonb_build_object('result', 'human_control');
  END IF;

  SELECT id, conversation_id, role, is_recalled
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

  SELECT id, content
    INTO v_existing
  FROM public.messages
  WHERE conversation_id = p_conversation_id
    AND role = 'assistant'
    AND is_recalled = false
    AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text
    AND content <> '__THINKING__'
  ORDER BY created_at ASC
  LIMIT 1;

  IF FOUND THEN
    DELETE FROM public.messages
    WHERE conversation_id = p_conversation_id
      AND content = '__THINKING__'
      AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;

    IF v_existing.content = p_content THEN
      RETURN jsonb_build_object(
        'result', 'idempotent',
        'message_id', v_existing.id
      );
    END IF;

    RETURN jsonb_build_object(
      'result', 'source_already_replied',
      'message_id', v_existing.id
    );
  END IF;

  DELETE FROM public.messages
  WHERE conversation_id = p_conversation_id
    AND content = '__THINKING__'
    AND COALESCE(metadata->>'source_message_id', '') = p_source_message_id::text;

  INSERT INTO public.messages (
    conversation_id, role, content, status, is_recalled, metadata
  )
  VALUES (
    p_conversation_id,
    'assistant',
    p_content,
    'delivered',
    false,
    COALESCE(p_metadata, '{}'::jsonb)
      || jsonb_build_object(
        'source_message_id', p_source_message_id::text,
        'control_commit', 'ai'
      )
  )
  RETURNING id INTO v_message_id;

  UPDATE public.conversations
  SET updated_at = v_now
  WHERE id = p_conversation_id;

  RETURN jsonb_build_object(
    'result', 'success',
    'message_id', v_message_id
  );
END;
$function$;

ALTER FUNCTION public.begin_ai_reply_tx(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.commit_ai_reply_tx(uuid,uuid,text,jsonb) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.begin_ai_reply_tx(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commit_ai_reply_tx(uuid,uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_ai_reply_tx(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.commit_ai_reply_tx(uuid,uuid,text,jsonb) TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.begin_ai_reply_tx(uuid,uuid)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated cannot invoke begin_ai_reply_tx';
  END IF;

  IF has_function_privilege(
    'authenticated',
    'public.commit_ai_reply_tx(uuid,uuid,text,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated cannot invoke commit_ai_reply_tx';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.begin_ai_reply_tx(uuid,uuid)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.commit_ai_reply_tx(uuid,uuid,text,jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: service_role execute missing';
  END IF;
END
$assert$;

COMMIT;
