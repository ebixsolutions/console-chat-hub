DO $$
DECLARE
  target_user_id uuid;
  existing_role_count integer;
  existing_profile_count integer;
  uid_column_type text;
  uid_prefix text;
BEGIN
  SELECT id INTO target_user_id
  FROM auth.users
  WHERE email = 'frankien.mega001@gmail.com';

  IF target_user_id IS NULL THEN
    RAISE EXCEPTION 'STOP: auth user with email frankien.mega001@gmail.com not found. Do not create auth user.';
  END IF;

  uid_prefix := LEFT(target_user_id::text, 8);
  RAISE NOTICE 'Found auth user: %...', uid_prefix;

  SELECT COUNT(*) INTO existing_role_count
  FROM public.user_roles
  WHERE user_id = target_user_id;

  RAISE NOTICE 'Existing user_roles rows: %', existing_role_count;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (target_user_id, 'admin')
  ON CONFLICT (user_id, role) DO NOTHING;

  RAISE NOTICE 'user_roles admin row ensured';

  SELECT data_type INTO uid_column_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'agent_profile'
    AND column_name = 'user_id';

  IF uid_column_type IS NULL THEN
    RAISE EXCEPTION 'STOP: agent_profile.user_id column not found in information_schema.';
  END IF;

  RAISE NOTICE 'agent_profile.user_id data type: %', uid_column_type;

  IF uid_column_type NOT IN ('uuid', 'text', 'character varying') THEN
    RAISE EXCEPTION 'STOP: unexpected agent_profile.user_id type "%". Expected uuid, text, or character varying.', uid_column_type;
  END IF;

  SELECT COUNT(*) INTO existing_profile_count
  FROM public.agent_profile
  WHERE user_id::text = target_user_id::text;

  RAISE NOTICE 'Existing agent_profile rows for this user: %', existing_profile_count;

  IF existing_profile_count > 1 THEN
    RAISE EXCEPTION 'STOP: % agent_profile rows found for user %... — expected 0 or 1. Manual review required.', existing_profile_count, uid_prefix;
  END IF;

  IF existing_profile_count = 0 THEN
    IF uid_column_type = 'uuid' THEN
      INSERT INTO public.agent_profile (user_id, display_name, email, role, status)
      VALUES (target_user_id, 'Frankie Ng', 'frankien.mega001@gmail.com', 'admin', 'active');
    ELSE
      INSERT INTO public.agent_profile (user_id, display_name, email, role, status)
      VALUES (target_user_id::text, 'Frankie Ng', 'frankien.mega001@gmail.com', 'admin', 'active');
    END IF;
    RAISE NOTICE 'agent_profile created for Frankie Ng';
  ELSE
    UPDATE public.agent_profile
    SET display_name = 'Frankie Ng',
        email = 'frankien.mega001@gmail.com',
        role = 'admin',
        status = 'active',
        updated_at = now()
    WHERE user_id::text = target_user_id::text;
    RAISE NOTICE 'agent_profile updated for Frankie Ng';
  END IF;

  PERFORM 1 FROM public.user_roles
  WHERE user_id = target_user_id AND role = 'admin'::public.app_role;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: user_roles admin row not found after operation';
  END IF;

  PERFORM 1 FROM public.agent_profile
  WHERE user_id::text = target_user_id::text
    AND display_name = 'Frankie Ng'
    AND email = 'frankien.mega001@gmail.com'
    AND role = 'admin'
    AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VERIFICATION FAILED: agent_profile row not found or values mismatch after operation';
  END IF;

  RAISE NOTICE 'All verifications passed. Identity seed complete for user %...', uid_prefix;
END $$;