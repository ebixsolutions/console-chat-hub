CREATE OR REPLACE FUNCTION public.c3_commit_conversation_memory_tx(p_conversation_id uuid, p_company_id uuid, p_source_message_id uuid, p_expected_commerce_revision bigint, p_expected_memory_revision bigint, p_memory jsonb, p_markdown_projection text, p_updated_from_turn bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_conversation_company uuid;
  v_latest_source_id uuid;
  v_source record;
  v_commerce_revision bigint;
  v_existing public.conversation_memory_state%rowtype;
  v_receipt public.conversation_memory_state_event%rowtype;
  v_hash text;
  v_revision bigint;
BEGIN
  IF p_conversation_id IS NULL OR p_company_id IS NULL OR p_source_message_id IS NULL
     OR p_expected_memory_revision IS NULL OR p_expected_memory_revision < 0
     OR p_updated_from_turn IS NULL OR p_updated_from_turn < 0
     OR p_memory IS NULL OR jsonb_typeof(p_memory) IS DISTINCT FROM 'object'
     OR p_memory->>'version' IS DISTINCT FROM 'conversation-memory-1.0.0'
     OR p_markdown_projection IS NULL OR octet_length(p_markdown_projection) > 32768
     OR octet_length(p_memory::text) > 65536 THEN
    RETURN jsonb_build_object('result','invalid_input');
  END IF;

  SELECT c.company_id INTO v_conversation_company
  FROM public.conversations c WHERE c.id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result','conversation_not_found'); END IF;
  IF v_conversation_company IS NULL THEN RETURN jsonb_build_object('result','conversation_company_unresolved'); END IF;
  IF v_conversation_company IS DISTINCT FROM p_company_id THEN RETURN jsonb_build_object('result','tenant_mismatch'); END IF;

  SELECT m.conversation_id, m.role, m.is_recalled, m.created_at INTO v_source
  FROM public.messages m WHERE m.id = p_source_message_id FOR SHARE;
  IF NOT FOUND OR v_source.conversation_id IS DISTINCT FROM p_conversation_id
     OR lower(coalesce(v_source.role,'')) NOT IN ('visitor','customer','user')
     OR coalesce(v_source.is_recalled,false) THEN
    RETURN jsonb_build_object('result','source_message_invalid');
  END IF;
  SELECT m.id INTO v_latest_source_id FROM public.messages m
  WHERE m.conversation_id = p_conversation_id
    AND lower(m.role) IN ('visitor','customer','user')
    AND coalesce(m.is_recalled,false) = false AND m.content <> '__THINKING__'
  ORDER BY m.created_at DESC, m.id DESC LIMIT 1;
  IF v_latest_source_id IS DISTINCT FROM p_source_message_id THEN
    RETURN jsonb_build_object('result','superseded_source');
  END IF;

  SELECT s.revision INTO v_commerce_revision
  FROM public.conversation_commerce_state s
  WHERE s.conversation_id = p_conversation_id AND s.company_id = p_company_id FOR SHARE;
  IF FOUND THEN
    IF p_expected_commerce_revision IS NULL OR v_commerce_revision IS DISTINCT FROM p_expected_commerce_revision THEN
      RETURN jsonb_build_object('result','stale_commerce_revision','current_revision',v_commerce_revision);
    END IF;
  ELSIF p_expected_commerce_revision IS NOT NULL THEN
    RETURN jsonb_build_object('result','stale_commerce_revision','current_revision',NULL);
  END IF;

  IF p_memory->>'conversation_id' IS DISTINCT FROM p_conversation_id::text
     OR p_memory->>'company_id' IS DISTINCT FROM p_company_id::text
     OR p_memory->>'source_message_id' IS DISTINCT FROM p_source_message_id::text
     OR (CASE WHEN p_expected_commerce_revision IS NULL
          THEN p_memory->>'commerce_state_revision' IS NOT NULL
          ELSE (p_memory->>'commerce_state_revision')::bigint IS DISTINCT FROM p_expected_commerce_revision END)
     OR (p_memory->>'memory_revision')::bigint IS DISTINCT FROM p_expected_memory_revision + 1
     OR (p_memory->>'updated_from_turn')::bigint IS DISTINCT FROM p_updated_from_turn THEN
    RETURN jsonb_build_object('result','lineage_invalid');
  END IF;
  v_hash := encode(extensions.digest(p_memory::text, 'sha256'), 'hex');

  SELECT * INTO v_receipt FROM public.conversation_memory_state_event e
  WHERE e.source_message_id = p_source_message_id;
  IF FOUND THEN
    IF v_receipt.conversation_id IS DISTINCT FROM p_conversation_id
       OR v_receipt.company_id IS DISTINCT FROM p_company_id
       OR v_receipt.memory_hash IS DISTINCT FROM v_hash THEN
      RETURN jsonb_build_object('result','source_message_replay_conflict','applied_revision',v_receipt.applied_revision);
    END IF;
    RETURN jsonb_build_object('result','success','idempotent',true,'applied_revision',v_receipt.applied_revision,
      'current_revision',(SELECT revision FROM public.conversation_memory_state WHERE conversation_id=p_conversation_id),
      'memory_hash',v_hash);
  END IF;

  SELECT * INTO v_existing FROM public.conversation_memory_state s
  WHERE s.conversation_id = p_conversation_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.company_id IS DISTINCT FROM p_company_id THEN RETURN jsonb_build_object('result','tenant_mismatch'); END IF;
    IF v_existing.revision IS DISTINCT FROM p_expected_memory_revision THEN
      RETURN jsonb_build_object('result','revision_conflict','actual_revision',v_existing.revision);
    END IF;
    v_revision := v_existing.revision + 1;
    UPDATE public.conversation_memory_state SET
      revision=v_revision, source_message_id=p_source_message_id,
      commerce_state_revision=p_expected_commerce_revision, memory=p_memory,
      markdown_projection=p_markdown_projection, memory_hash=v_hash,
      updated_from_turn=p_updated_from_turn, updated_at=now()
    WHERE conversation_id=p_conversation_id;
  ELSE
    IF p_expected_memory_revision <> 0 THEN
      RETURN jsonb_build_object('result','revision_conflict','actual_revision',0);
    END IF;
    v_revision := 1;
    INSERT INTO public.conversation_memory_state(
      conversation_id,company_id,revision,source_message_id,commerce_state_revision,
      memory,markdown_projection,memory_hash,updated_from_turn
    ) VALUES (
      p_conversation_id,p_company_id,v_revision,p_source_message_id,p_expected_commerce_revision,
      p_memory,p_markdown_projection,v_hash,p_updated_from_turn
    );
  END IF;
  INSERT INTO public.conversation_memory_state_event(
    source_message_id,conversation_id,company_id,applied_revision,commerce_state_revision,memory_hash
  ) VALUES (
    p_source_message_id,p_conversation_id,p_company_id,v_revision,p_expected_commerce_revision,v_hash
  );
  RETURN jsonb_build_object('result','success','idempotent',false,'applied_revision',v_revision,
    'current_revision',v_revision,'memory_hash',v_hash);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.c3_enforce_conversation_memory_lineage_tg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_conversation_company uuid;
  v_message_conversation uuid;
  v_message_role text;
BEGIN
  SELECT c.company_id INTO v_conversation_company
  FROM public.conversations c WHERE c.id = NEW.conversation_id;
  IF NOT FOUND OR v_conversation_company IS NULL OR v_conversation_company IS DISTINCT FROM NEW.company_id THEN
    RAISE EXCEPTION 'C3_MEMORY_TENANT_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  SELECT m.conversation_id, m.role INTO v_message_conversation, v_message_role
  FROM public.messages m WHERE m.id = NEW.source_message_id;
  IF NOT FOUND OR v_message_conversation IS DISTINCT FROM NEW.conversation_id
     OR lower(coalesce(v_message_role,'')) NOT IN ('visitor','customer','user') THEN
    RAISE EXCEPTION 'C3_MEMORY_SOURCE_MISMATCH' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.memory->>'conversation_id' IS DISTINCT FROM NEW.conversation_id::text
     OR NEW.memory->>'company_id' IS DISTINCT FROM NEW.company_id::text
     OR NEW.memory->>'source_message_id' IS DISTINCT FROM NEW.source_message_id::text
     OR (NEW.memory->>'memory_revision')::bigint IS DISTINCT FROM NEW.revision
     OR (CASE WHEN NEW.commerce_state_revision IS NULL
          THEN NEW.memory->>'commerce_state_revision' IS NOT NULL
          ELSE (NEW.memory->>'commerce_state_revision')::bigint IS DISTINCT FROM NEW.commerce_state_revision END) THEN
    RAISE EXCEPTION 'C3_MEMORY_LINEAGE_INVALID' USING ERRCODE = 'P0001';
  END IF;
  NEW.memory_hash := encode(extensions.digest(NEW.memory::text, 'sha256'), 'hex');
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$
;