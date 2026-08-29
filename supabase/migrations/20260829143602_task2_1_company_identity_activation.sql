-- Task 2.1 — Company Identity Activation
-- Final desired state: durable auth-backed company memberships, canonical platform-company
-- identity uniqueness, fixed two-tenant isolation assertions, and fail-closed runtime helpers.

ALTER TABLE public.company_membership
  DROP CONSTRAINT IF EXISTS company_membership_user_id_fkey;

ALTER TABLE public.company_membership
  ADD CONSTRAINT company_membership_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE NOT VALID;

ALTER TABLE public.company_membership
  VALIDATE CONSTRAINT company_membership_user_id_fkey;

ALTER TABLE public.company
  DROP CONSTRAINT IF EXISTS company_platform_company_id_positive_check;
ALTER TABLE public.company
  ADD CONSTRAINT company_platform_company_id_positive_check
  CHECK (platform_company_id > 0) NOT VALID;
ALTER TABLE public.company
  VALIDATE CONSTRAINT company_platform_company_id_positive_check;

CREATE UNIQUE INDEX IF NOT EXISTS company_platform_company_id_uq
  ON public.company(platform_company_id);

DO $task21$
DECLARE
  v_company_count integer;
  v_orphan_memberships integer;
  v_cross_memberships integer;
  v_legacy_role_mismatch integer;
  v_company_channel_mismatch integer;
  v_session_channel_mismatch integer;
  v_tenant2_conversations integer;
  v_tenant2_wrong_company integer;
BEGIN
  SELECT count(*) INTO v_company_count
  FROM public.company
  WHERE is_active
    AND platform_company_id IS NOT NULL
    AND btrim(external_workspace_id) <> ''
    AND btrim(external_tenant_id) <> '';
  IF v_company_count <> 2 THEN
    RAISE EXCEPTION 'TASK2_1_ACTIVE_COMPANY_COUNT:%', v_company_count;
  END IF;

  SELECT count(*) INTO v_orphan_memberships
  FROM public.company_membership cm
  LEFT JOIN auth.users u ON u.id = cm.user_id
  WHERE u.id IS NULL;
  IF v_orphan_memberships <> 0 THEN
    RAISE EXCEPTION 'TASK2_1_ORPHAN_MEMBERSHIPS:%', v_orphan_memberships;
  END IF;

  SELECT count(*) INTO v_cross_memberships
  FROM (
    SELECT user_id
    FROM public.company_membership
    WHERE is_active
    GROUP BY user_id
    HAVING count(DISTINCT company_id) > 1
  ) x;
  IF v_cross_memberships <> 0 THEN
    RAISE EXCEPTION 'TASK2_1_CROSS_MEMBERSHIPS:%', v_cross_memberships;
  END IF;

  SELECT count(*) INTO v_legacy_role_mismatch
  FROM public.company_membership cm
  WHERE cm.is_active
    AND NOT EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = cm.user_id AND ur.role = cm.role
    );
  IF v_legacy_role_mismatch <> 0 THEN
    RAISE EXCEPTION 'TASK2_1_LEGACY_ROLE_MISMATCH:%', v_legacy_role_mismatch;
  END IF;

  SELECT count(*) INTO v_company_channel_mismatch
  FROM public.conversations c
  JOIN public.channel_config cc ON cc.id = c.channel_config_id
  WHERE c.company_id IS DISTINCT FROM cc.company_id;
  IF v_company_channel_mismatch <> 0 THEN
    RAISE EXCEPTION 'TASK2_1_COMPANY_CHANNEL_MISMATCH:%', v_company_channel_mismatch;
  END IF;

  SELECT count(*) INTO v_session_channel_mismatch
  FROM public.conversations c
  JOIN public.visitor_session vs ON vs.id = c.visitor_session_id
  WHERE c.channel_config_id IS NOT NULL
    AND vs.channel_config_id IS DISTINCT FROM c.channel_config_id;
  IF v_session_channel_mismatch <> 0 THEN
    RAISE EXCEPTION 'TASK2_1_SESSION_CHANNEL_MISMATCH:%', v_session_channel_mismatch;
  END IF;

  SELECT count(*) INTO v_tenant2_conversations
  FROM public.conversations c
  JOIN public.company co ON co.id = c.company_id
  WHERE co.platform_company_id = 5;
  IF v_tenant2_conversations <> 1 THEN
    RAISE EXCEPTION 'TASK2_1_TENANT2_CONVERSATION_COUNT:%', v_tenant2_conversations;
  END IF;

  SELECT count(*) INTO v_tenant2_wrong_company
  FROM public.conversations c
  WHERE c.id = (
    SELECT c2.id
    FROM public.conversations c2
    JOIN public.company co2 ON co2.id = c2.company_id
    WHERE co2.platform_company_id = 5
    LIMIT 1
  )
  AND c.company_id IS DISTINCT FROM (
    SELECT id FROM public.company WHERE platform_company_id = 5
  );
  IF v_tenant2_wrong_company <> 0 THEN
    RAISE EXCEPTION 'TASK2_1_TENANT2_BINDING_MISMATCH:%', v_tenant2_wrong_company;
  END IF;
END
$task21$;
