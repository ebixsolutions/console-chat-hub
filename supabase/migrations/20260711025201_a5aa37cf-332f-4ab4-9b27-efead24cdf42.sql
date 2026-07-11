CREATE OR REPLACE FUNCTION public.takeover_conversation_tx(
  p_conversation_id UUID,
  p_agent_id UUID,
  p_expected_status TEXT,
  p_expected_owner UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_conv RECORD;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  SELECT id, status, assigned_agent_id INTO v_conv FROM conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_conv.status = 'resolved' THEN RETURN jsonb_build_object('result', 'resolved'); END IF;
  IF v_conv.status = 'pending' AND v_conv.assigned_agent_id = p_agent_id THEN RETURN jsonb_build_object('result', 'already_owner', 'conversation_id', p_conversation_id); END IF;
  IF v_conv.status IS DISTINCT FROM p_expected_status THEN RETURN jsonb_build_object('result', 'race_conflict'); END IF;
  IF p_expected_owner IS NULL THEN
    IF v_conv.assigned_agent_id IS NOT NULL THEN RETURN jsonb_build_object('result', 'race_conflict'); END IF;
  ELSE
    IF v_conv.assigned_agent_id IS DISTINCT FROM p_expected_owner THEN RETURN jsonb_build_object('result', 'race_conflict'); END IF;
  END IF;
  UPDATE conversations SET assigned_agent_id = p_agent_id, status = 'pending', updated_at = v_now WHERE id = p_conversation_id;
  UPDATE conversation_assignment SET is_active = false, unassigned_at = v_now WHERE conversation_id = p_conversation_id AND is_active = true;
  INSERT INTO conversation_assignment (conversation_id, agent_id, assigned_by, is_active) VALUES (p_conversation_id, p_agent_id, p_agent_id, true);
  IF v_conv.status IS DISTINCT FROM 'pending' THEN
    INSERT INTO conversation_status_log (conversation_id, old_status, new_status, changed_by, changed_by_type, reason) VALUES (p_conversation_id, v_conv.status, 'pending', p_agent_id, 'agent', 'Agent takeover');
  END IF;
  INSERT INTO handoff_event (conversation_id, handoff_type, from_agent_id, to_agent_id, handoff_reason) VALUES (p_conversation_id, 'agent_to_agent', v_conv.assigned_agent_id, p_agent_id, 'Agent takeover');
  INSERT INTO audit_log (actor_id, actor_type, action, resource_type, resource_id, diff) VALUES (p_agent_id, 'agent', 'take_over_conversation', 'conversations', p_conversation_id, jsonb_build_object('old_status', v_conv.status, 'new_status', 'pending', 'old_agent_id', v_conv.assigned_agent_id, 'new_agent_id', p_agent_id));
  RETURN jsonb_build_object('result', 'success');
END;
$$;

REVOKE EXECUTE ON FUNCTION public.takeover_conversation_tx(UUID, UUID, TEXT, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.takeover_conversation_tx(UUID, UUID, TEXT, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.takeover_conversation_tx(UUID, UUID, TEXT, UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.takeover_conversation_tx(UUID, UUID, TEXT, UUID) TO service_role;