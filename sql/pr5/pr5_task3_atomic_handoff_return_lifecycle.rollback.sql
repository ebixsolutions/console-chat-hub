-- PR-5 Task 3 rollback.
-- Restores the authoritative pre-Task3 function bodies read from live DB on 2026-08-15.
-- No table/data deletion.

BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.assign_conversation_tx(p_conversation_id uuid, p_target_agent_id uuid, p_actor_agent_id uuid, p_expected_status text, p_expected_owner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv RECORD;
  v_target RECORD;
  v_now timestamptz := now();
  v_assignment_id uuid;
BEGIN
  SELECT id, status, assigned_agent_id INTO v_conv FROM public.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_conv.status = 'resolved' THEN RETURN jsonb_build_object('result', 'resolved'); END IF;
  IF v_conv.status IS DISTINCT FROM p_expected_status OR v_conv.assigned_agent_id IS DISTINCT FROM p_expected_owner THEN RETURN jsonb_build_object('result', 'stale_state'); END IF;
  SELECT id, status INTO v_target FROM public.agent_profile WHERE id = p_target_agent_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'target_not_found'); END IF;
  IF v_target.status IS DISTINCT FROM 'active' THEN RETURN jsonb_build_object('result', 'target_inactive'); END IF;
  IF v_conv.assigned_agent_id = p_target_agent_id THEN RETURN jsonb_build_object('result', 'already_assigned', 'conversation_id', p_conversation_id); END IF;
  UPDATE public.conversation_assignment SET is_active = false, unassigned_at = v_now WHERE conversation_id = p_conversation_id AND is_active = true;
  INSERT INTO public.conversation_assignment (conversation_id, agent_id, assigned_by, is_active)
  VALUES (p_conversation_id, p_target_agent_id, p_actor_agent_id, true) RETURNING id INTO v_assignment_id;
  UPDATE public.conversations SET assigned_agent_id = p_target_agent_id, updated_at = v_now WHERE id = p_conversation_id;
  INSERT INTO public.handoff_event (conversation_id, handoff_type, from_agent_id, to_agent_id, handoff_reason)
  VALUES (p_conversation_id, 'agent_to_agent', v_conv.assigned_agent_id, p_target_agent_id, 'Assign conversation');
  INSERT INTO public.audit_log (actor_id, actor_type, action, resource_type, resource_id, diff)
  VALUES (p_actor_agent_id, 'agent', 'assign_conversation', 'conversation_assignment', v_assignment_id,
    jsonb_build_object('conversation_id', p_conversation_id, 'from_agent_id', v_conv.assigned_agent_id, 'to_agent_id', p_target_agent_id, 'status', v_conv.status));
  RETURN jsonb_build_object('result', 'success', 'assignment_id', v_assignment_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.takeover_conversation_tx(p_conversation_id uuid, p_agent_id uuid, p_expected_status text, p_expected_owner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_conv RECORD; v_now TIMESTAMPTZ := NOW();
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
  IF v_conv.status IS DISTINCT FROM 'pending' THEN INSERT INTO conversation_status_log (conversation_id, old_status, new_status, changed_by, changed_by_type, reason) VALUES (p_conversation_id, v_conv.status, 'pending', p_agent_id, 'agent', 'Agent takeover'); END IF;
  INSERT INTO handoff_event (conversation_id, handoff_type, from_agent_id, to_agent_id, handoff_reason) VALUES (p_conversation_id, 'agent_to_agent', v_conv.assigned_agent_id, p_agent_id, 'Agent takeover');
  INSERT INTO audit_log (actor_id, actor_type, action, resource_type, resource_id, diff) VALUES (p_agent_id, 'agent', 'take_over_conversation', 'conversations', p_conversation_id, jsonb_build_object('old_status', v_conv.status, 'new_status', 'pending', 'old_agent_id', v_conv.assigned_agent_id, 'new_agent_id', p_agent_id));
  RETURN jsonb_build_object('result', 'success');
END;
$function$;

CREATE OR REPLACE FUNCTION public.transfer_conversation_tx(p_conversation_id uuid, p_from_agent_id uuid, p_to_agent_id uuid, p_expected_assigned_agent_id uuid, p_reason text DEFAULT 'Agent transfer'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_conv RECORD; v_target RECORD; v_now timestamptz := now(); v_handoff_id uuid; v_deactivated_count int;
BEGIN
  SELECT id, status, assigned_agent_id INTO v_conv FROM public.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_conv.status = 'resolved' THEN RETURN jsonb_build_object('result', 'resolved'); END IF;
  IF v_conv.assigned_agent_id IS DISTINCT FROM p_expected_assigned_agent_id THEN RETURN jsonb_build_object('result', 'stale_assignment'); END IF;
  IF v_conv.assigned_agent_id = p_to_agent_id THEN RETURN jsonb_build_object('result', 'already_assigned', 'conversation_id', p_conversation_id); END IF;
  SELECT id, status INTO v_target FROM public.agent_profile WHERE id = p_to_agent_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'target_not_found'); END IF;
  IF v_target.status != 'active' THEN RETURN jsonb_build_object('result', 'target_inactive'); END IF;
  INSERT INTO public.handoff_event (conversation_id, handoff_type, from_agent_id, to_agent_id, handoff_reason, ai_summary)
  VALUES (p_conversation_id, 'agent_to_agent', v_conv.assigned_agent_id, p_to_agent_id, p_reason, NULL) RETURNING id INTO v_handoff_id;
  UPDATE public.conversation_assignment SET is_active = false, unassigned_at = v_now WHERE conversation_id = p_conversation_id AND is_active = true;
  GET DIAGNOSTICS v_deactivated_count = ROW_COUNT;
  INSERT INTO public.conversation_assignment (conversation_id, agent_id, assigned_by, is_active)
  VALUES (p_conversation_id, p_to_agent_id, p_from_agent_id, true);
  UPDATE public.conversations SET assigned_agent_id = p_to_agent_id, status = 'pending', updated_at = v_now WHERE id = p_conversation_id;
  IF v_conv.status IS DISTINCT FROM 'pending' THEN INSERT INTO public.conversation_status_log (conversation_id, old_status, new_status, changed_by, changed_by_type, reason) VALUES (p_conversation_id, v_conv.status, 'pending', p_from_agent_id, 'agent', p_reason); END IF;
  INSERT INTO public.audit_log (actor_id, actor_type, action, resource_type, resource_id, diff)
  VALUES (p_from_agent_id, 'agent', 'transfer_conversation', 'handoff_event', v_handoff_id,
    jsonb_build_object('conversation_id', p_conversation_id, 'from_agent_id', v_conv.assigned_agent_id, 'to_agent_id', p_to_agent_id, 'old_status', v_conv.status, 'new_status', 'pending', 'deactivated_assignments', v_deactivated_count));
  RETURN jsonb_build_object('result', 'success');
END;
$function$;

CREATE OR REPLACE FUNCTION public.return_to_ai_tx(p_conversation_id uuid, p_actor_agent_id uuid, p_expected_status text, p_expected_owner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_conv RECORD; v_now timestamptz := now();
BEGIN
  SELECT id, status, assigned_agent_id INTO v_conv FROM public.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('result', 'not_found'); END IF;
  IF v_conv.status = 'resolved' THEN RETURN jsonb_build_object('result', 'resolved'); END IF;
  IF v_conv.status IS DISTINCT FROM p_expected_status OR v_conv.assigned_agent_id IS DISTINCT FROM p_expected_owner THEN RETURN jsonb_build_object('result', 'stale_state'); END IF;
  IF v_conv.assigned_agent_id IS NULL AND v_conv.status = 'open' THEN RETURN jsonb_build_object('result', 'already_ai', 'conversation_id', p_conversation_id); END IF;
  UPDATE public.conversation_assignment SET is_active = false, unassigned_at = v_now WHERE conversation_id = p_conversation_id AND is_active = true;
  UPDATE public.conversations SET assigned_agent_id = NULL, status = 'open', updated_at = v_now WHERE id = p_conversation_id;
  IF v_conv.status IS DISTINCT FROM 'open' THEN INSERT INTO public.conversation_status_log (conversation_id, old_status, new_status, changed_by, changed_by_type, reason) VALUES (p_conversation_id, v_conv.status, 'open', p_actor_agent_id, 'agent', 'Return to AI'); END IF;
  INSERT INTO public.handoff_event (conversation_id, handoff_type, from_agent_id, to_agent_id, handoff_reason)
  VALUES (p_conversation_id, 'agent_to_agent', v_conv.assigned_agent_id, NULL, 'Return to AI');
  INSERT INTO public.audit_log (actor_id, actor_type, action, resource_type, resource_id, diff)
  VALUES (p_actor_agent_id, 'agent', 'return_to_ai', 'conversations', p_conversation_id,
    jsonb_build_object('old_status', v_conv.status, 'new_status', 'open', 'old_agent_id', v_conv.assigned_agent_id, 'new_agent_id', NULL));
  RETURN jsonb_build_object('result', 'success');
END;
$function$;

ALTER FUNCTION public.assign_conversation_tx(uuid,uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.takeover_conversation_tx(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.transfer_conversation_tx(uuid,uuid,uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.return_to_ai_tx(uuid,uuid,text,uuid) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.assign_conversation_tx(uuid,uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.takeover_conversation_tx(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transfer_conversation_tx(uuid,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.return_to_ai_tx(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_conversation_tx(uuid,uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.takeover_conversation_tx(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.transfer_conversation_tx(uuid,uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.return_to_ai_tx(uuid,uuid,text,uuid) TO service_role;

COMMIT;
