CREATE OR REPLACE FUNCTION public.agent_send_reply_tx(p_conversation_id uuid, p_agent_id uuid, p_content text, p_agent_name text DEFAULT NULL::text)
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
$function$
;
REVOKE ALL ON FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.agent_send_reply_tx(uuid,uuid,text,text) TO service_role;
