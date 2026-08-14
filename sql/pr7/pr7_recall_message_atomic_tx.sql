-- PR-7 recall-message atomic transaction guard.
-- SOURCE ONLY. Do not apply to production without explicit Director authorization.

BEGIN;

CREATE OR REPLACE FUNCTION public.recall_message_tx(
  p_message_id uuid,
  p_company_id uuid,
  p_actor_user_id uuid,
  p_actor_agent_id uuid,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_msg record;
  v_conv record;
  v_role public.app_role;
  v_owner_id uuid;
  v_now timestamptz := now();
  v_meta jsonb;
BEGIN
  PERFORM 1
  FROM public.agent_profile ap
  WHERE ap.id = p_actor_agent_id
    AND ap.user_id = p_actor_user_id
    AND ap.status = 'active';

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'actor_not_found');
  END IF;

  SELECT cm.role
    INTO v_role
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

  SELECT m.id, m.role, m.metadata, m.conversation_id, m.is_recalled
    INTO v_msg
  FROM public.messages m
  WHERE m.id = p_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  SELECT c.id, c.company_id
    INTO v_conv
  FROM public.conversations c
  WHERE c.id = v_msg.conversation_id
  FOR SHARE;

  IF NOT FOUND OR v_conv.company_id IS DISTINCT FROM p_company_id THEN
    RETURN jsonb_build_object('result', 'not_found');
  END IF;

  IF COALESCE(v_msg.is_recalled, false) THEN
    RETURN jsonb_build_object('result', 'already_recalled');
  END IF;

  IF v_msg.role = 'visitor' THEN
    IF v_role IS DISTINCT FROM 'admin'::public.app_role THEN
      RETURN jsonb_build_object('result', 'visitor_admin_required');
    END IF;
  ELSIF v_msg.role = 'agent' THEN
    BEGIN
      v_owner_id := NULLIF(v_msg.metadata->>'agent_id', '')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      v_owner_id := NULL;
    END;

    IF v_owner_id IS DISTINCT FROM p_actor_agent_id
       AND v_role NOT IN ('admin'::public.app_role, 'supervisor'::public.app_role) THEN
      RETURN jsonb_build_object('result', 'not_message_owner');
    END IF;
  ELSIF v_msg.role <> 'assistant' THEN
    RETURN jsonb_build_object('result', 'unsupported_role');
  END IF;

  v_meta := COALESCE(v_msg.metadata, '{}'::jsonb)
    || jsonb_build_object(
      'recalled_by', p_actor_agent_id,
      'recalled_at', v_now,
      'recall_reason', p_reason,
      'original_content_preserved', true
    );

  UPDATE public.messages
  SET is_recalled = true,
      status = 'recalled',
      metadata = v_meta,
      updated_at = v_now
  WHERE id = p_message_id
    AND conversation_id = v_msg.conversation_id;

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
    'recall_message',
    'messages',
    p_message_id,
    jsonb_build_object(
      'company_id', p_company_id,
      'conversation_id', v_msg.conversation_id,
      'role', v_msg.role,
      'reason', p_reason
    )
  );

  RETURN jsonb_build_object('result', 'success');
END;
$function$;

ALTER FUNCTION public.recall_message_tx(uuid,uuid,uuid,uuid,text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.recall_message_tx(uuid,uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.recall_message_tx(uuid,uuid,uuid,uuid,text)
  TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.recall_message_tx(uuid,uuid,uuid,uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated cannot invoke recall_message_tx';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.recall_message_tx(uuid,uuid,uuid,uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: service_role execute missing';
  END IF;
END
$assert$;

COMMIT;
