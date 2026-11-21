-- C3 T11: revision-checked existing reply transaction; no overload or new table.
CREATE OR REPLACE FUNCTION public.commit_ai_reply_tx(p_conversation_id uuid, p_source_message_id uuid, p_content text, p_metadata jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_source record;
  v_state record;
  v_state_found boolean := false;
  v_authorized_revision bigint;
  v_response_hash text;
  v_existing record;
  v_message_id uuid;
  v_now timestamptz := now();
BEGIN
  IF p_content IS NULL OR btrim(p_content) = '' OR p_content = '__THINKING__' OR length(p_content) > 4000 THEN
    RETURN jsonb_build_object('result', 'invalid_content');
  END IF;

  SELECT id, company_id, status, assigned_agent_id
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

  SELECT company_id, revision, source_message_id INTO v_state
    FROM public.conversation_commerce_state
   WHERE conversation_id = p_conversation_id FOR SHARE;
  v_state_found := FOUND;
  IF v_state_found AND v_state.company_id IS DISTINCT FROM v_conv.company_id THEN
    RETURN jsonb_build_object('result','tenant_mismatch');
  END IF;
  IF (v_state_found AND v_state.source_message_id = p_source_message_id)
      OR COALESCE(p_metadata ? 'b2_expected_revision',false) THEN
    IF p_metadata IS NULL
       OR jsonb_typeof(p_metadata->'b2_expected_revision') <> 'number'
       OR COALESCE(p_metadata->>'b2_expected_revision','') !~ '^[0-9]+$'
       OR length(COALESCE(p_metadata->>'b2_expected_revision','')) > 18
       OR p_metadata->>'b2_expected_company_id' IS DISTINCT FROM v_conv.company_id::text
       OR p_metadata->>'b2_source_message_id' IS DISTINCT FROM p_source_message_id::text
       OR p_metadata->>'b2_gate_contract' IS DISTINCT FROM 'executeB2PersistenceGate:allow_after_revalidation'
       OR p_metadata->>'b2_commit_source' IS DISTINCT FROM 'commit_ai_reply_tx'
       OR COALESCE(p_metadata->>'b2_response_hash','') !~ '^[0-9a-f]{64}$'
       OR COALESCE(p_metadata->>'b2_idempotency_key','') !~ '^[0-9a-f]{64}$' THEN
      RETURN jsonb_build_object('result','invalid_b2_revision_proof');
    END IF;
    v_authorized_revision := (p_metadata->>'b2_expected_revision')::bigint;
    v_response_hash := encode(extensions.digest(convert_to(p_content,'UTF8'),'sha256'),'hex');
    IF p_metadata->>'b2_response_hash' IS DISTINCT FROM v_response_hash
       OR p_metadata->>'b2_idempotency_key' IS DISTINCT FROM
         encode(extensions.digest(convert_to(
           v_conv.company_id::text || ':' || p_conversation_id::text || ':' ||
           p_source_message_id::text || ':' || v_authorized_revision::text ||
           ':' || v_response_hash, 'UTF8'), 'sha256'),'hex') THEN
      RETURN jsonb_build_object('result','response_hash_mismatch');
    END IF;
    IF v_authorized_revision IS DISTINCT FROM
       (CASE WHEN v_state_found THEN v_state.revision ELSE 0 END) THEN
      RETURN jsonb_build_object('result','stale_authorized_revision',
        'authorized_revision',v_authorized_revision,
        'current_revision', CASE WHEN v_state_found THEN v_state.revision ELSE 0 END);
    END IF;
  END IF;

  SELECT id, content, metadata
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
    IF v_existing.content = p_content AND (
       NOT COALESCE(p_metadata ? 'b2_expected_revision', false) OR
       (v_existing.metadata->>'b2_response_hash' = p_metadata->>'b2_response_hash'
        AND v_existing.metadata->>'b2_idempotency_key' = p_metadata->>'b2_idempotency_key')
    ) THEN
      RETURN jsonb_build_object('result', 'idempotent', 'message_id', v_existing.id);
    END IF;
    RETURN jsonb_build_object('result', 'response_substitution', 'message_id', v_existing.id);
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
