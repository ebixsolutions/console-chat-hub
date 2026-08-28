-- Task 3.3 — restore the atomic conversation resolution RPC required by
-- resolve-conversation and mark-unresolved.
--
-- Security / integrity contract:
--   * service-role invocation only
--   * caller identity is revalidated against agent_profile + company_membership
--   * conversation is tenant-bound and row-locked before state transition
--   * non-elevated agents may only resolve/unresolve conversations they own
--   * status change + status log + audit log are one transaction

BEGIN;

CREATE OR REPLACE FUNCTION public.set_conversation_resolution_tx(
  p_conversation_id uuid,
  p_company_id uuid,
  p_actor_user_id uuid,
  p_actor_agent_id uuid,
  p_target_state text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_conv record;
  v_agent record;
  v_role text;
  v_now timestamptz := now();
  v_reason text;
BEGIN
  IF p_target_state NOT IN ('resolved', 'unresolved') THEN
    RETURN jsonb_build_object('result', 'invalid_target_state');
  END IF;

  SELECT id, user_id, status
    INTO v_agent
  FROM public.agent_profile
  WHERE id = p_actor_agent_id
    AND user_id = p_actor_user_id;

  IF NOT FOUND OR v_agent.status IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('result', 'actor_not_found');
  END IF;

  SELECT cm.role
    INTO v_role
  FROM public.company_membership cm
  JOIN public.company co
    ON co.id = cm.company_id
   AND co.is_active = true
  WHERE cm.user_id = p_actor_user_id
    AND cm.company_id = p_company_id
    AND cm.is_active = true
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'tenant_forbidden');
  END IF;

  SELECT id, status, assigned_agent_id, company_id
    INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_conv.company_id IS DISTINCT FROM p_company_id THEN
    RETURN jsonb_build_object('result', 'tenant_forbidden');
  END IF;

  IF COALESCE(v_role, '') NOT IN ('admin', 'supervisor')
     AND v_conv.assigned_agent_id IS DISTINCT FROM p_actor_agent_id THEN
    RETURN jsonb_build_object('result', 'not_conversation_owner');
  END IF;

  IF v_conv.status IS NOT DISTINCT FROM p_target_state THEN
    RETURN jsonb_build_object(
      'result', 'already_in_state',
      'conversation_id', p_conversation_id,
      'status', p_target_state
    );
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_reason, '')), '');
  IF v_reason IS NULL THEN
    v_reason := CASE p_target_state
      WHEN 'resolved' THEN 'Resolve conversation'
      ELSE 'Mark conversation unresolved'
    END;
  ELSE
    v_reason := left(v_reason, 1000);
  END IF;

  UPDATE public.conversations
  SET status = p_target_state,
      updated_at = v_now
  WHERE id = p_conversation_id;

  INSERT INTO public.conversation_status_log (
    conversation_id,
    old_status,
    new_status,
    changed_by,
    changed_by_type,
    reason
  ) VALUES (
    p_conversation_id,
    v_conv.status,
    p_target_state,
    p_actor_agent_id,
    'agent',
    v_reason
  );

  INSERT INTO public.audit_log (
    actor_id,
    actor_type,
    action,
    resource_type,
    resource_id,
    diff
  ) VALUES (
    p_actor_agent_id,
    'agent',
    CASE p_target_state
      WHEN 'resolved' THEN 'resolve_conversation'
      ELSE 'mark_unresolved'
    END,
    'conversations',
    p_conversation_id,
    jsonb_build_object(
      'company_id', p_company_id,
      'old_status', v_conv.status,
      'new_status', p_target_state,
      'assigned_agent_id', v_conv.assigned_agent_id,
      'reason', v_reason
    )
  );

  RETURN jsonb_build_object(
    'result', 'success',
    'conversation_id', p_conversation_id,
    'old_status', v_conv.status,
    'new_status', p_target_state
  );
END;
$function$;

ALTER FUNCTION public.set_conversation_resolution_tx(uuid,uuid,uuid,uuid,text,text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.set_conversation_resolution_tx(uuid,uuid,uuid,uuid,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_conversation_resolution_tx(uuid,uuid,uuid,uuid,text,text)
  TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.set_conversation_resolution_tx(uuid,uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated cannot invoke set_conversation_resolution_tx';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.set_conversation_resolution_tx(uuid,uuid,uuid,uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: service_role execute missing';
  END IF;
END
$assert$;

COMMIT;
