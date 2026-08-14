-- PR-7 conversation resolution atomic transaction guard.
-- SOURCE ONLY. Do not apply to production without explicit Director authorization.

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
  v_membership_role public.app_role;
  v_now timestamptz := now();
  v_old_status text;
  v_new_status text;
BEGIN
  IF p_target_state NOT IN ('resolved', 'unresolved') THEN
    RETURN jsonb_build_object('result', 'invalid_target_state');
  END IF;

  -- Actor identity must match the agent profile used for audit/ownership.
  PERFORM 1
  FROM public.agent_profile ap
  WHERE ap.id = p_actor_agent_id
    AND ap.user_id = p_actor_user_id
    AND ap.status = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'actor_not_found');
  END IF;

  SELECT cm.role
    INTO v_membership_role
  FROM public.company_membership cm
  JOIN public.company c
    ON c.id = cm.company_id
   AND c.is_active = true
  WHERE cm.user_id = p_actor_user_id
    AND cm.company_id = p_company_id
    AND cm.is_active = true
  ORDER BY CASE cm.role
    WHEN 'admin'::public.app_role THEN 1
    WHEN 'supervisor'::public.app_role THEN 2
    WHEN 'agent'::public.app_role THEN 3
    WHEN 'qa'::public.app_role THEN 4
    ELSE 9
  END
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'tenant_forbidden');
  END IF;

  SELECT id, company_id, status, assigned_agent_id, resolved_at
    INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  -- Cross-tenant IDs are intentionally indistinguishable from not-found.
  IF v_conv.company_id IS DISTINCT FROM p_company_id THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF v_membership_role NOT IN ('admin'::public.app_role, 'supervisor'::public.app_role)
     AND v_conv.assigned_agent_id IS DISTINCT FROM p_actor_agent_id THEN
    RETURN jsonb_build_object('result', 'not_conversation_owner');
  END IF;

  v_old_status := v_conv.status;
  v_new_status := p_target_state;

  IF p_target_state = 'resolved' AND v_conv.status = 'resolved' THEN
    RETURN jsonb_build_object(
      'result', 'already_in_state',
      'status', 'resolved'
    );
  END IF;

  IF p_target_state = 'unresolved' AND v_conv.status = 'unresolved' THEN
    RETURN jsonb_build_object(
      'result', 'already_in_state',
      'status', 'unresolved'
    );
  END IF;

  UPDATE public.conversations
  SET status = v_new_status,
      resolved_at = CASE WHEN v_new_status = 'resolved' THEN v_now ELSE NULL END,
      updated_at = v_now
  WHERE id = p_conversation_id
    AND company_id = p_company_id;

  INSERT INTO public.conversation_status_log (
    conversation_id,
    old_status,
    new_status,
    changed_by,
    changed_by_type,
    reason
  )
  VALUES (
    p_conversation_id,
    v_old_status,
    v_new_status,
    p_actor_agent_id,
    'agent',
    p_reason
  );

  INSERT INTO public.audit_log (
    actor_id,
    actor_type,
    action,
    resource_type,
    resource_id,
    diff
  )
  VALUES (
    p_actor_agent_id,
    'agent',
    CASE
      WHEN v_new_status = 'resolved' THEN 'resolve_conversation'
      ELSE 'mark_unresolved'
    END,
    'conversations',
    p_conversation_id,
    jsonb_build_object(
      'company_id', p_company_id,
      'old_status', v_old_status,
      'new_status', v_new_status,
      'reason', p_reason
    )
  );

  RETURN jsonb_build_object(
    'result', 'success',
    'old_status', v_old_status,
    'new_status', v_new_status
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
