-- PR-7 Agent Management tenant isolation.
-- SOURCE ONLY. Do not deploy without explicit Director authorization.
--
-- New tenant-safe management RPCs are additive. Existing legacy safe_* RPCs
-- remain untouched for rollback compatibility but are no longer called by the
-- production Agent Management Edge function.

BEGIN;

CREATE OR REPLACE FUNCTION public.tenant_find_auth_user_by_email(
  p_caller_id uuid,
  p_company_id uuid,
  p_email text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_caller_role public.app_role;
  v_user record;
  v_profile record;
  v_membership record;
BEGIN
  SELECT cm.role
    INTO v_caller_role
  FROM public.company_membership cm
  JOIN public.company c
    ON c.id = cm.company_id
   AND c.is_active = true
  JOIN public.agent_profile ap
    ON ap.user_id = p_caller_id
   AND ap.status = 'active'
  WHERE cm.user_id = p_caller_id
    AND cm.company_id = p_company_id
    AND cm.is_active = true
  ORDER BY CASE cm.role
    WHEN 'admin'::public.app_role THEN 1
    WHEN 'supervisor'::public.app_role THEN 2
    ELSE 9
  END
  LIMIT 1;

  IF v_caller_role IS NULL
     OR v_caller_role NOT IN ('admin'::public.app_role, 'supervisor'::public.app_role) THEN
    RETURN jsonb_build_object(
      'found', false,
      'error_code', 'caller_not_authorized',
      'error_message', 'Not authorized'
    );
  END IF;

  IF p_email IS NULL OR btrim(p_email) = '' OR char_length(p_email) > 320 THEN
    RETURN jsonb_build_object(
      'found', false,
      'error_code', 'invalid_email',
      'error_message', 'Email is required'
    );
  END IF;

  SELECT u.id, u.email, u.raw_user_meta_data
    INTO v_user
  FROM auth.users u
  WHERE lower(u.email) = lower(btrim(p_email))
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'found', false,
      'error_code', 'user_not_found',
      'error_message', 'No user found'
    );
  END IF;

  SELECT ap.id, ap.display_name, ap.status
    INTO v_profile
  FROM public.agent_profile ap
  WHERE ap.user_id = v_user.id
  LIMIT 1;

  SELECT cm.company_id, cm.role, cm.is_active
    INTO v_membership
  FROM public.company_membership cm
  WHERE cm.user_id = v_user.id
  ORDER BY cm.is_active DESC, cm.created_at DESC
  LIMIT 1;

  IF v_membership.company_id IS NOT NULL
     AND v_membership.company_id IS DISTINCT FROM p_company_id
     AND v_membership.is_active = true THEN
    -- Do not disclose the other company ID or role.
    RETURN jsonb_build_object(
      'found', false,
      'error_code', 'target_company_conflict',
      'error_message', 'User is not available for this company'
    );
  END IF;

  RETURN jsonb_build_object(
    'found', true,
    'user_id', v_user.id,
    'email', v_user.email,
    'display_name', coalesce(
      v_profile.display_name,
      v_user.raw_user_meta_data->>'display_name',
      v_user.raw_user_meta_data->>'full_name',
      split_part(v_user.email, '@', 1)
    ),
    'has_profile', (v_profile.id IS NOT NULL),
    'profile_id', v_profile.id,
    'profile_status', v_profile.status,
    'company_membership_active',
      (v_membership.company_id = p_company_id AND v_membership.is_active = true),
    'current_app_role',
      CASE WHEN v_membership.company_id = p_company_id THEN v_membership.role ELSE NULL END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_safe_add_agent(
  p_caller_id uuid,
  p_company_id uuid,
  p_target_user_id uuid,
  p_app_role public.app_role,
  p_display_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_caller_role public.app_role;
  v_caller_profile uuid;
  v_target record;
  v_existing_profile record;
  v_existing_global_role public.app_role;
  v_existing_memberships int;
  v_profile_id uuid;
  v_profile_role text;
  v_display_name text;
BEGIN
  PERFORM pg_advisory_xact_lock(8439210001);

  SELECT cm.role, ap.id
    INTO v_caller_role, v_caller_profile
  FROM public.company_membership cm
  JOIN public.company c
    ON c.id = cm.company_id
   AND c.is_active = true
  JOIN public.agent_profile ap
    ON ap.user_id = p_caller_id
   AND ap.status = 'active'
  WHERE cm.user_id = p_caller_id
    AND cm.company_id = p_company_id
    AND cm.is_active = true
  ORDER BY CASE cm.role
    WHEN 'admin'::public.app_role THEN 1
    WHEN 'supervisor'::public.app_role THEN 2
    ELSE 9
  END
  LIMIT 1;

  IF v_caller_role IS NULL
     OR v_caller_role NOT IN ('admin'::public.app_role, 'supervisor'::public.app_role) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'caller_not_authorized',
      'error_message', 'Only company admin or supervisor'
    );
  END IF;

  IF v_caller_profile IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'caller_profile_not_found',
      'error_message', 'No active caller profile'
    );
  END IF;

  IF v_caller_role = 'supervisor'::public.app_role
     AND p_app_role <> 'agent'::public.app_role THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'insufficient_privilege',
      'error_message', 'Supervisor can only add agents'
    );
  END IF;

  SELECT u.id, u.email, u.raw_user_meta_data
    INTO v_target
  FROM auth.users u
  WHERE u.id = p_target_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'target_user_not_found',
      'error_message', 'User not found'
    );
  END IF;

  SELECT ap.id, ap.status
    INTO v_existing_profile
  FROM public.agent_profile ap
  WHERE ap.user_id = p_target_user_id
  LIMIT 1;

  IF v_existing_profile.id IS NOT NULL THEN
    IF v_existing_profile.status = 'active' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error_code', 'already_active',
        'error_message', 'Agent profile already active'
      );
    END IF;
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'inactive_profile_exists',
      'error_message', 'Use reactivate',
      'profile_id', v_existing_profile.id
    );
  END IF;

  SELECT ur.role
    INTO v_existing_global_role
  FROM public.user_roles ur
  WHERE ur.user_id = p_target_user_id;

  IF v_existing_global_role IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'already_has_role',
      'error_message', 'User already has a production role'
    );
  END IF;

  SELECT count(*)
    INTO v_existing_memberships
  FROM public.company_membership cm
  WHERE cm.user_id = p_target_user_id
    AND cm.is_active = true;

  IF v_existing_memberships > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'target_company_conflict',
      'error_message', 'User is already active in another company'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.company_membership cm
    WHERE cm.user_id = p_target_user_id
      AND cm.company_id = p_company_id
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'membership_conflict',
      'error_message', 'Existing company membership requires review'
    );
  END IF;

  v_profile_role := p_app_role::text;
  v_display_name := CASE
    WHEN p_display_name IS NOT NULL AND btrim(p_display_name) <> ''
      THEN left(btrim(p_display_name), 100)
    WHEN v_target.raw_user_meta_data->>'display_name' IS NOT NULL
      THEN left(v_target.raw_user_meta_data->>'display_name', 100)
    WHEN v_target.raw_user_meta_data->>'full_name' IS NOT NULL
      THEN left(v_target.raw_user_meta_data->>'full_name', 100)
    ELSE left(split_part(v_target.email, '@', 1), 100)
  END;

  INSERT INTO public.agent_profile (
    user_id, display_name, email, role, status
  )
  VALUES (
    p_target_user_id,
    v_display_name,
    v_target.email,
    v_profile_role,
    'active'
  )
  RETURNING id INTO v_profile_id;

  INSERT INTO public.user_roles(user_id, role)
  VALUES (p_target_user_id, p_app_role);

  INSERT INTO public.company_membership(
    company_id, user_id, role, is_active
  )
  VALUES (
    p_company_id, p_target_user_id, p_app_role, true
  );

  INSERT INTO public.audit_log(
    actor_id, actor_type, action, resource_type, resource_id, diff
  )
  VALUES (
    v_caller_profile,
    'agent',
    'add_agent',
    'agent_profile',
    v_profile_id,
    jsonb_build_object(
      'company_id', p_company_id,
      'caller_company_role', v_caller_role,
      'target_user_id', p_target_user_id,
      'app_role', p_app_role,
      'display_name', v_display_name
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'profile_id', v_profile_id,
    'app_role', p_app_role,
    'profile_role', v_profile_role,
    'email', v_target.email,
    'display_name', v_display_name,
    'company_id', p_company_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_safe_change_role(
  p_caller_id uuid,
  p_company_id uuid,
  p_target_user_id uuid,
  p_new_app_role public.app_role
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_caller_role public.app_role;
  v_caller_profile uuid;
  v_target record;
  v_old_role public.app_role;
  v_membership_count int;
  v_other_active_memberships int;
  v_company_admins int;
BEGIN
  PERFORM pg_advisory_xact_lock(8439210001);

  SELECT cm.role, ap.id
    INTO v_caller_role, v_caller_profile
  FROM public.company_membership cm
  JOIN public.company c
    ON c.id = cm.company_id
   AND c.is_active = true
  JOIN public.agent_profile ap
    ON ap.user_id = p_caller_id
   AND ap.status = 'active'
  WHERE cm.user_id = p_caller_id
    AND cm.company_id = p_company_id
    AND cm.is_active = true
  LIMIT 1;

  IF v_caller_role IS DISTINCT FROM 'admin'::public.app_role THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'caller_not_authorized',
      'error_message', 'Only company admin'
    );
  END IF;

  IF p_caller_id = p_target_user_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'self_change_denied',
      'error_message', 'Cannot change own role'
    );
  END IF;

  SELECT ap.id, ap.user_id, ap.role, ap.status
    INTO v_target
  FROM public.agent_profile ap
  WHERE ap.user_id = p_target_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'target_not_found',
      'error_message', 'No profile'
    );
  END IF;

  IF v_target.status <> 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'target_not_active',
      'error_message', 'Target not active'
    );
  END IF;

  SELECT count(*), min(cm.role)
    INTO v_membership_count, v_old_role
  FROM public.company_membership cm
  WHERE cm.user_id = p_target_user_id
    AND cm.company_id = p_company_id
    AND cm.is_active = true;

  IF v_membership_count <> 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code',
        CASE WHEN v_membership_count = 0 THEN 'target_company_conflict' ELSE 'membership_corrupt' END,
      'error_message', 'Target company membership is invalid'
    );
  END IF;

  SELECT count(*)
    INTO v_other_active_memberships
  FROM public.company_membership cm
  WHERE cm.user_id = p_target_user_id
    AND cm.company_id <> p_company_id
    AND cm.is_active = true;

  IF v_other_active_memberships > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'membership_corrupt',
      'error_message', 'Ambiguous target company membership'
    );
  END IF;

  IF v_old_role = p_new_app_role THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'same_role',
      'error_message', 'Already this role'
    );
  END IF;

  IF v_old_role = 'admin'::public.app_role
     AND p_new_app_role <> 'admin'::public.app_role THEN
    SELECT count(*)
      INTO v_company_admins
    FROM public.company_membership cm
    JOIN public.agent_profile ap
      ON ap.user_id = cm.user_id
     AND ap.status = 'active'
    WHERE cm.company_id = p_company_id
      AND cm.role = 'admin'::public.app_role
      AND cm.is_active = true
      AND cm.user_id <> p_target_user_id;

    IF v_company_admins < 1 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error_code', 'last_admin',
        'error_message', 'Cannot demote the last active company admin'
      );
    END IF;
  END IF;

  UPDATE public.user_roles
  SET role = p_new_app_role
  WHERE user_id = p_target_user_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'target_no_role',
      'error_message', 'Target has no production role'
    );
  END IF;

  UPDATE public.agent_profile
  SET role = p_new_app_role::text,
      updated_at = now()
  WHERE user_id = p_target_user_id;

  UPDATE public.company_membership
  SET role = p_new_app_role
  WHERE user_id = p_target_user_id
    AND company_id = p_company_id
    AND is_active = true;

  INSERT INTO public.audit_log(
    actor_id, actor_type, action, resource_type, resource_id, diff
  )
  VALUES (
    v_caller_profile,
    'agent',
    'change_role',
    'agent_profile',
    v_target.id,
    jsonb_build_object(
      'company_id', p_company_id,
      'old_app_role', v_old_role,
      'new_app_role', p_new_app_role,
      'target_user_id', p_target_user_id
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'old_app_role', v_old_role,
    'new_app_role', p_new_app_role,
    'company_id', p_company_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_safe_deactivate_agent(
  p_caller_id uuid,
  p_company_id uuid,
  p_target_agent_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_caller_role public.app_role;
  v_caller_profile uuid;
  v_target record;
  v_target_role public.app_role;
  v_membership_count int;
  v_other_active_memberships int;
  v_company_admins int;
  v_conversation_ids uuid[];
  v_conversation_count int;
  v_assignment_count int;
  v_update_count int;
BEGIN
  PERFORM pg_advisory_xact_lock(8439210001);

  SELECT cm.role, ap.id
    INTO v_caller_role, v_caller_profile
  FROM public.company_membership cm
  JOIN public.company c
    ON c.id = cm.company_id
   AND c.is_active = true
  JOIN public.agent_profile ap
    ON ap.user_id = p_caller_id
   AND ap.status = 'active'
  WHERE cm.user_id = p_caller_id
    AND cm.company_id = p_company_id
    AND cm.is_active = true
  ORDER BY CASE cm.role
    WHEN 'admin'::public.app_role THEN 1
    WHEN 'supervisor'::public.app_role THEN 2
    ELSE 9
  END
  LIMIT 1;

  IF v_caller_role IS NULL
     OR v_caller_role NOT IN ('admin'::public.app_role, 'supervisor'::public.app_role) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'caller_not_authorized',
      'error_message', 'Only company admin or supervisor'
    );
  END IF;

  SELECT ap.id, ap.user_id, ap.display_name, ap.role, ap.status
    INTO v_target
  FROM public.agent_profile ap
  WHERE ap.id = p_target_agent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'target_not_found',
      'error_message', 'Agent not found'
    );
  END IF;

  IF v_target.status <> 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'target_not_active',
      'error_message', 'Agent already inactive'
    );
  END IF;

  IF v_target.user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'target_company_conflict',
      'error_message', 'Agent is not linked to this company'
    );
  END IF;

  IF p_caller_id = v_target.user_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'self_deactivation_denied',
      'error_message', 'Cannot self-deactivate'
    );
  END IF;

  SELECT count(*), min(cm.role)
    INTO v_membership_count, v_target_role
  FROM public.company_membership cm
  WHERE cm.user_id = v_target.user_id
    AND cm.company_id = p_company_id
    AND cm.is_active = true;

  IF v_membership_count <> 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code',
        CASE WHEN v_membership_count = 0 THEN 'target_company_conflict' ELSE 'membership_corrupt' END,
      'error_message', 'Target company membership is invalid'
    );
  END IF;

  SELECT count(*)
    INTO v_other_active_memberships
  FROM public.company_membership cm
  WHERE cm.user_id = v_target.user_id
    AND cm.company_id <> p_company_id
    AND cm.is_active = true;

  IF v_other_active_memberships > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'membership_corrupt',
      'error_message', 'Ambiguous target company membership'
    );
  END IF;

  IF v_caller_role = 'supervisor'::public.app_role
     AND v_target_role <> 'agent'::public.app_role THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'insufficient_privilege',
      'error_message', 'Supervisor can only deactivate agents'
    );
  END IF;

  IF v_target_role = 'admin'::public.app_role THEN
    SELECT count(*)
      INTO v_company_admins
    FROM public.company_membership cm
    JOIN public.agent_profile ap
      ON ap.user_id = cm.user_id
     AND ap.status = 'active'
    WHERE cm.company_id = p_company_id
      AND cm.role = 'admin'::public.app_role
      AND cm.is_active = true
      AND cm.user_id <> v_target.user_id;

    IF v_company_admins < 1 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error_code', 'last_admin',
        'error_message', 'Cannot deactivate the last active company admin'
      );
    END IF;
  END IF;

  v_conversation_ids := ARRAY(
    SELECT c.id
    FROM public.conversations c
    WHERE c.company_id = p_company_id
      AND c.assigned_agent_id = p_target_agent_id
      AND c.status <> 'resolved'
    ORDER BY c.id
    FOR UPDATE
  );

  v_conversation_count := coalesce(array_length(v_conversation_ids, 1), 0);

  IF v_conversation_count > 0 THEN
    UPDATE public.conversation_assignment ca
    SET is_active = false,
        unassigned_at = now()
    WHERE ca.agent_id = p_target_agent_id
      AND ca.is_active = true
      AND ca.conversation_id = ANY(v_conversation_ids);
    GET DIAGNOSTICS v_assignment_count = ROW_COUNT;

    UPDATE public.conversations c
    SET assigned_agent_id = NULL,
        updated_at = now()
    WHERE c.id = ANY(v_conversation_ids)
      AND c.company_id = p_company_id;
    GET DIAGNOSTICS v_update_count = ROW_COUNT;

    IF v_update_count <> v_conversation_count THEN
      RAISE EXCEPTION
        'tenant_deactivate_conversation_row_mismatch expected=% actual=%',
        v_conversation_count, v_update_count;
    END IF;
  ELSE
    v_assignment_count := 0;
    v_update_count := 0;
  END IF;

  UPDATE public.agent_profile
  SET status = 'inactive',
      updated_at = now()
  WHERE id = p_target_agent_id;

  DELETE FROM public.user_roles
  WHERE user_id = v_target.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_deactivate_missing_global_role';
  END IF;

  UPDATE public.company_membership
  SET is_active = false
  WHERE company_id = p_company_id
    AND user_id = v_target.user_id
    AND is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_deactivate_missing_company_membership';
  END IF;

  INSERT INTO public.audit_log(
    actor_id, actor_type, action, resource_type, resource_id, diff
  )
  VALUES (
    v_caller_profile,
    'agent',
    'deactivate_agent',
    'agent_profile',
    p_target_agent_id,
    jsonb_build_object(
      'company_id', p_company_id,
      'target_user_id', v_target.user_id,
      'target_company_role', v_target_role,
      'conversations_unassigned', v_update_count,
      'assignments_deactivated', v_assignment_count
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'profile_id', p_target_agent_id,
    'company_id', p_company_id,
    'conversations_unassigned', v_update_count,
    'assignments_deactivated', v_assignment_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.tenant_safe_reactivate_agent(
  p_caller_id uuid,
  p_company_id uuid,
  p_target_agent_id uuid,
  p_app_role public.app_role
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_caller_role public.app_role;
  v_caller_profile uuid;
  v_target record;
  v_existing_role public.app_role;
  v_membership_count int;
  v_other_active_memberships int;
BEGIN
  PERFORM pg_advisory_xact_lock(8439210001);

  SELECT cm.role, ap.id
    INTO v_caller_role, v_caller_profile
  FROM public.company_membership cm
  JOIN public.company c
    ON c.id = cm.company_id
   AND c.is_active = true
  JOIN public.agent_profile ap
    ON ap.user_id = p_caller_id
   AND ap.status = 'active'
  WHERE cm.user_id = p_caller_id
    AND cm.company_id = p_company_id
    AND cm.is_active = true
  ORDER BY CASE cm.role
    WHEN 'admin'::public.app_role THEN 1
    WHEN 'supervisor'::public.app_role THEN 2
    ELSE 9
  END
  LIMIT 1;

  IF v_caller_role IS NULL
     OR v_caller_role NOT IN ('admin'::public.app_role, 'supervisor'::public.app_role) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'caller_not_authorized',
      'error_message', 'Only company admin or supervisor'
    );
  END IF;

  SELECT ap.id, ap.user_id, ap.display_name, ap.role, ap.status
    INTO v_target
  FROM public.agent_profile ap
  WHERE ap.id = p_target_agent_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'target_not_found',
      'error_message', 'Agent not found'
    );
  END IF;

  IF v_target.status <> 'inactive' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'not_inactive',
      'error_message', 'Agent is not inactive'
    );
  END IF;

  IF v_target.user_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'unlinked_profile',
      'error_message', 'Agent has no auth user'
    );
  END IF;

  SELECT count(*)
    INTO v_membership_count
  FROM public.company_membership cm
  WHERE cm.user_id = v_target.user_id
    AND cm.company_id = p_company_id
    AND cm.is_active = false;

  IF v_membership_count <> 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code',
        CASE WHEN v_membership_count = 0 THEN 'target_company_conflict' ELSE 'membership_corrupt' END,
      'error_message', 'Inactive target membership is invalid'
    );
  END IF;

  SELECT count(*)
    INTO v_other_active_memberships
  FROM public.company_membership cm
  WHERE cm.user_id = v_target.user_id
    AND cm.company_id <> p_company_id
    AND cm.is_active = true;

  IF v_other_active_memberships > 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'membership_corrupt',
      'error_message', 'Target is active in another company'
    );
  END IF;

  IF v_caller_role = 'supervisor'::public.app_role THEN
    IF p_app_role <> 'agent'::public.app_role OR v_target.role <> 'agent' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error_code', 'insufficient_privilege',
        'error_message', 'Supervisor can only reactivate agents'
      );
    END IF;
  END IF;

  SELECT ur.role
    INTO v_existing_role
  FROM public.user_roles ur
  WHERE ur.user_id = v_target.user_id;

  IF v_existing_role IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error_code', 'role_already_exists',
      'error_message', 'User already has a production role'
    );
  END IF;

  UPDATE public.agent_profile
  SET status = 'active',
      role = p_app_role::text,
      updated_at = now()
  WHERE id = p_target_agent_id;

  INSERT INTO public.user_roles(user_id, role)
  VALUES (v_target.user_id, p_app_role);

  UPDATE public.company_membership
  SET role = p_app_role,
      is_active = true
  WHERE company_id = p_company_id
    AND user_id = v_target.user_id
    AND is_active = false;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'tenant_reactivate_missing_membership';
  END IF;

  INSERT INTO public.audit_log(
    actor_id, actor_type, action, resource_type, resource_id, diff
  )
  VALUES (
    v_caller_profile,
    'agent',
    'reactivate_agent',
    'agent_profile',
    p_target_agent_id,
    jsonb_build_object(
      'company_id', p_company_id,
      'target_user_id', v_target.user_id,
      'new_app_role', p_app_role
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'profile_id', p_target_agent_id,
    'app_role', p_app_role,
    'profile_role', p_app_role::text,
    'company_id', p_company_id
  );
END;
$function$;

ALTER FUNCTION public.tenant_find_auth_user_by_email(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.tenant_safe_add_agent(uuid,uuid,uuid,public.app_role,text) OWNER TO postgres;
ALTER FUNCTION public.tenant_safe_change_role(uuid,uuid,uuid,public.app_role) OWNER TO postgres;
ALTER FUNCTION public.tenant_safe_deactivate_agent(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.tenant_safe_reactivate_agent(uuid,uuid,uuid,public.app_role) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.tenant_find_auth_user_by_email(uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenant_safe_add_agent(uuid,uuid,uuid,public.app_role,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenant_safe_change_role(uuid,uuid,uuid,public.app_role)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenant_safe_deactivate_agent(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tenant_safe_reactivate_agent(uuid,uuid,uuid,public.app_role)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.tenant_find_auth_user_by_email(uuid,uuid,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_safe_add_agent(uuid,uuid,uuid,public.app_role,text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_safe_change_role(uuid,uuid,uuid,public.app_role)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_safe_deactivate_agent(uuid,uuid,uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.tenant_safe_reactivate_agent(uuid,uuid,uuid,public.app_role)
  TO service_role;

DO $assert$
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.tenant_safe_add_agent(uuid,uuid,uuid,app_role,text)',
    'EXECUTE'
  )
  OR has_function_privilege(
    'authenticated',
    'public.tenant_safe_change_role(uuid,uuid,uuid,app_role)',
    'EXECUTE'
  )
  OR has_function_privilege(
    'authenticated',
    'public.tenant_safe_deactivate_agent(uuid,uuid,uuid)',
    'EXECUTE'
  )
  OR has_function_privilege(
    'authenticated',
    'public.tenant_safe_reactivate_agent(uuid,uuid,uuid,app_role)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: authenticated cannot invoke tenant agent management RPCs';
  END IF;

  IF NOT has_function_privilege(
    'service_role',
    'public.tenant_safe_add_agent(uuid,uuid,uuid,app_role,text)',
    'EXECUTE'
  )
  OR NOT has_function_privilege(
    'service_role',
    'public.tenant_safe_change_role(uuid,uuid,uuid,app_role)',
    'EXECUTE'
  )
  OR NOT has_function_privilege(
    'service_role',
    'public.tenant_safe_deactivate_agent(uuid,uuid,uuid)',
    'EXECUTE'
  )
  OR NOT has_function_privilege(
    'service_role',
    'public.tenant_safe_reactivate_agent(uuid,uuid,uuid,app_role)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'ASSERT: service_role execute missing for tenant agent management RPCs';
  END IF;
END
$assert$;

COMMIT;
