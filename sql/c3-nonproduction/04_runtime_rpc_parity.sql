-- Exact readback of existing production RPC semantics for isolated C3 nonproduction parity.\n-- Production was read-only; this file is applied only to the dedicated Free project.\nBEGIN;\nCREATE OR REPLACE FUNCTION public.commit_ai_reply_tx(p_conversation_id uuid, p_source_message_id uuid, p_content text, p_metadata jsonb DEFAULT NULL::jsonb)
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
$function$;\nREVOKE ALL ON FUNCTION public.commit_ai_reply_tx(uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.commit_ai_reply_tx(uuid,uuid,text,jsonb) TO service_role;\nCREATE OR REPLACE FUNCTION public.required_escalation_clarification_tx(p_conversation_id uuid, p_source_message_id uuid, p_escalation_rule text, p_clarification_content text, p_reason_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_conv record;v_existing record;v_clarification text;v_reason text;v_message_id uuid;v_prior_count integer;BEGIN IF p_conversation_id IS NULL OR p_source_message_id IS NULL THEN RETURN jsonb_build_object('result','invalid_input');END IF;IF p_escalation_rule IS DISTINCT FROM 'R2' THEN RETURN jsonb_build_object('result','invalid_rule');END IF;v_clarification:=trim(COALESCE(p_clarification_content,''));IF v_clarification='' OR char_length(v_clarification)>1200 OR v_clarification='__THINKING__' THEN RETURN jsonb_build_object('result','invalid_input','reason','clarification_content_invalid');END IF;v_reason:=trim(COALESCE(p_reason_code,''));IF v_reason='' OR char_length(v_reason)>200 THEN RETURN jsonb_build_object('result','invalid_input','reason','reason_code_invalid');END IF;SELECT id,status,assigned_agent_id INTO v_conv FROM public.conversations WHERE id=p_conversation_id FOR UPDATE;IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found');END IF;IF v_conv.status IN ('resolved','closed') THEN RETURN jsonb_build_object('result','already_resolved');END IF;IF v_conv.status='transferred' OR (v_conv.status='pending' AND v_conv.assigned_agent_id IS NOT NULL) OR v_conv.assigned_agent_id IS NOT NULL THEN RETURN jsonb_build_object('result','already_under_human_control');END IF;IF NOT EXISTS(SELECT 1 FROM public.messages WHERE id=p_source_message_id AND conversation_id=p_conversation_id AND role='visitor' AND (is_recalled IS NULL OR is_recalled=false)) THEN RETURN jsonb_build_object('result','invalid_source_message');END IF;SELECT id INTO v_existing FROM public.messages WHERE conversation_id=p_conversation_id AND role='assistant' AND COALESCE(is_recalled,false)=false AND metadata->>'source_message_id'=p_source_message_id::text AND metadata->>'escalation_rule'='R2' AND metadata->>'escalation_action'='clarification' ORDER BY created_at ASC LIMIT 1;IF FOUND THEN RETURN jsonb_build_object('result','already_handled','message_id',v_existing.id);END IF;SELECT count(*) INTO v_prior_count FROM public.messages WHERE conversation_id=p_conversation_id AND role='assistant' AND COALESCE(is_recalled,false)=false AND metadata->>'escalation_rule'='R2' AND metadata->>'escalation_action'='clarification';IF v_prior_count>=1 THEN RETURN jsonb_build_object('result','max_clarifications_reached','clarification_attempts',v_prior_count);END IF;INSERT INTO public.messages(conversation_id,role,content,status,is_recalled,metadata) VALUES(p_conversation_id,'assistant',v_clarification,'delivered',false,jsonb_build_object('source_message_id',p_source_message_id::text,'escalation_rule','R2','escalation_action','clarification','reason_code',v_reason)) RETURNING id INTO v_message_id;UPDATE public.conversations SET updated_at=now() WHERE id=p_conversation_id;INSERT INTO public.audit_log(actor_id,actor_type,action,resource_type,resource_id,diff) VALUES(NULL,'ai','required_escalation_clarification','message',v_message_id,jsonb_build_object('conversation_id',p_conversation_id,'source_message_id',p_source_message_id,'escalation_rule','R2','reason_code',v_reason,'clarification_attempt',1));RETURN jsonb_build_object('result','success','message_id',v_message_id,'escalation_rule','R2','clarification_attempt',1);END;$function$;\nREVOKE ALL ON FUNCTION public.required_escalation_clarification_tx(uuid,uuid,text,text,text) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.required_escalation_clarification_tx(uuid,uuid,text,text,text) TO service_role;\nCREATE OR REPLACE FUNCTION public.required_escalation_handoff_tx(p_conversation_id uuid, p_source_message_id uuid, p_escalation_rule text, p_priority text, p_safe_reply_content text, p_reason_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_conv record;v_existing record;v_safe_reply text;v_reason text;v_handoff_id uuid;v_message_id uuid;v_branch_tag text;BEGIN IF p_conversation_id IS NULL THEN RETURN jsonb_build_object('result','invalid_input','reason','conversation_id_null');END IF;IF p_source_message_id IS NULL THEN RETURN jsonb_build_object('result','invalid_input','reason','source_message_id_null');END IF;IF p_escalation_rule IS NULL OR p_escalation_rule NOT IN ('E2','E1','R2') THEN RETURN jsonb_build_object('result','invalid_rule','requested_rule',COALESCE(p_escalation_rule,'NULL'));END IF;IF p_priority IS NULL OR p_priority NOT IN ('normal','high','urgent') THEN RETURN jsonb_build_object('result','invalid_priority','requested_priority',COALESCE(p_priority,'NULL'));END IF;v_safe_reply:=trim(COALESCE(p_safe_reply_content,''));IF v_safe_reply='' OR char_length(v_safe_reply)>2000 OR v_safe_reply='__THINKING__' THEN RETURN jsonb_build_object('result','invalid_input','reason','safe_reply_content_invalid');END IF;v_reason:=trim(COALESCE(p_reason_code,''));IF v_reason='' OR char_length(v_reason)>200 THEN RETURN jsonb_build_object('result','invalid_input','reason','reason_code_invalid');END IF;SELECT id,status,assigned_agent_id,priority INTO v_conv FROM public.conversations WHERE id=p_conversation_id FOR UPDATE;IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found');END IF;SELECT id,escalation_rule,branch_tag INTO v_existing FROM public.handoff_event WHERE conversation_id=p_conversation_id AND source_message_id=p_source_message_id ORDER BY created_at ASC LIMIT 1;IF FOUND THEN RETURN jsonb_build_object('result','already_handled','existing_rule',v_existing.escalation_rule,'existing_branch',v_existing.branch_tag,'requested_rule',p_escalation_rule);END IF;IF v_conv.status IN ('resolved','closed') THEN RETURN jsonb_build_object('result','already_resolved');END IF;IF v_conv.status='transferred' OR (v_conv.status='pending' AND v_conv.assigned_agent_id IS NOT NULL) OR (v_conv.status NOT IN ('pending','transferred') AND v_conv.assigned_agent_id IS NOT NULL) THEN RETURN jsonb_build_object('result','already_under_human_control');END IF;IF NOT EXISTS(SELECT 1 FROM public.messages WHERE id=p_source_message_id AND conversation_id=p_conversation_id AND role='visitor' AND (is_recalled IS NULL OR is_recalled=false)) THEN RETURN jsonb_build_object('result','invalid_source_message');END IF;v_branch_tag:='ESC_'||p_escalation_rule||'_REQUIRED';INSERT INTO public.messages(conversation_id,role,content,status,is_recalled,metadata) VALUES(p_conversation_id,'assistant',v_safe_reply,'delivered',false,jsonb_build_object('source_message_id',p_source_message_id::text,'escalation_rule',p_escalation_rule,'reason_code',v_reason)) RETURNING id INTO v_message_id;UPDATE public.conversations SET status='pending',priority=p_priority,updated_at=now() WHERE id=p_conversation_id;IF v_conv.status IS DISTINCT FROM 'pending' THEN INSERT INTO public.conversation_status_log(conversation_id,old_status,new_status,changed_by,changed_by_type,reason) VALUES(p_conversation_id,v_conv.status,'pending',NULL,'ai',p_escalation_rule||': '||v_reason);END IF;INSERT INTO public.handoff_event(conversation_id,source_message_id,handoff_type,branch_tag,escalation_rule,safe_reply_content,handoff_reason,created_at) VALUES(p_conversation_id,p_source_message_id,'ai_to_agent',v_branch_tag,p_escalation_rule,v_safe_reply,v_reason,now()) RETURNING id INTO v_handoff_id;INSERT INTO public.audit_log(actor_id,actor_type,action,resource_type,resource_id,diff) VALUES(NULL,'ai','required_escalation_handoff','handoff_event',v_handoff_id,jsonb_build_object('conversation_id',p_conversation_id,'source_message_id',p_source_message_id,'escalation_rule',p_escalation_rule,'reason_code',v_reason,'old_status',v_conv.status,'new_status','pending','old_priority',v_conv.priority,'new_priority',p_priority,'message_id',v_message_id));RETURN jsonb_build_object('result','success','handoff_id',v_handoff_id,'message_id',v_message_id,'escalation_rule',p_escalation_rule,'priority',p_priority);END;$function$;\nREVOKE ALL ON FUNCTION public.required_escalation_handoff_tx(uuid,uuid,text,text,text,text) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.required_escalation_handoff_tx(uuid,uuid,text,text,text,text) TO service_role;\nCREATE OR REPLACE FUNCTION public.s0_handoff_tx(p_conversation_id uuid, p_safe_reply_content text, p_source_message_id uuid, p_failure_type text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ DECLARE v_conv record;v_existing record;v_trimmed text;BEGIN IF p_conversation_id IS NULL THEN RETURN jsonb_build_object('result','invalid_input','reason','conversation_id_null');END IF;IF p_source_message_id IS NULL THEN RETURN jsonb_build_object('result','invalid_input','reason','source_message_id_null');END IF;v_trimmed:=trim(COALESCE(p_safe_reply_content,''));IF v_trimmed='' OR char_length(v_trimmed)>2000 THEN RETURN jsonb_build_object('result','invalid_input','reason','safe_reply_content_invalid');END IF;IF v_trimmed='__THINKING__' THEN RETURN jsonb_build_object('result','invalid_input','reason','safe_reply_is_thinking');END IF;IF p_failure_type IS NULL OR p_failure_type NOT IN ('KB_SCOPE_GATE','KB_API_FAIL','LLM_TIMEOUT','LLM_NETWORK_ERROR','LLM_NON_2XX','LLM_EMPTY_RESPONSE') THEN RETURN jsonb_build_object('result','invalid_failure_type','failure_type',COALESCE(p_failure_type,'NULL'));END IF;SELECT id,status,assigned_agent_id INTO v_conv FROM conversations WHERE id=p_conversation_id FOR UPDATE;IF NOT FOUND THEN RETURN jsonb_build_object('result','not_found');END IF;IF v_conv.status IN ('resolved','closed') THEN RETURN jsonb_build_object('result','already_resolved');END IF;IF (v_conv.status='pending' AND v_conv.assigned_agent_id IS NOT NULL) OR v_conv.status='transferred' THEN RETURN jsonb_build_object('result','already_under_human_control');END IF;IF NOT EXISTS(SELECT 1 FROM messages WHERE id=p_source_message_id AND conversation_id=p_conversation_id AND role='visitor' AND (is_recalled IS NULL OR is_recalled=false)) THEN RETURN jsonb_build_object('result','invalid_source_message');END IF;SELECT id,escalation_rule INTO v_existing FROM handoff_event WHERE conversation_id=p_conversation_id AND source_message_id=p_source_message_id LIMIT 1;IF FOUND THEN RETURN jsonb_build_object('result','already_handled','existing_rule',v_existing.escalation_rule,'requested_rule','S0');END IF;INSERT INTO messages(conversation_id,role,content,status,is_recalled) VALUES(p_conversation_id,'assistant',v_trimmed,'delivered',false);IF v_conv.status IS DISTINCT FROM 'pending' THEN UPDATE conversations SET status='pending',updated_at=now() WHERE id=p_conversation_id;INSERT INTO conversation_status_log(conversation_id,old_status,new_status,changed_by,changed_by_type,reason) VALUES(p_conversation_id,v_conv.status,'pending',NULL,'ai','S0: '||p_failure_type);ELSE UPDATE conversations SET updated_at=now() WHERE id=p_conversation_id;END IF;INSERT INTO handoff_event(conversation_id,source_message_id,handoff_type,branch_tag,escalation_rule,safe_reply_content,handoff_reason) VALUES(p_conversation_id,p_source_message_id,'ai_to_agent',p_failure_type,'S0',v_trimmed,'System/upstream failure: '||p_failure_type);RETURN jsonb_build_object('result','success');END;$function$;\nREVOKE ALL ON FUNCTION public.s0_handoff_tx(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.s0_handoff_tx(uuid,text,uuid,text) TO service_role;\nCOMMIT;\n
