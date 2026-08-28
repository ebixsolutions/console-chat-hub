-- Task 3.3 — complete operational tenant RLS for residual direct-write paths.
BEGIN;

-- widget_config has no company_id. Authenticated clients may update only a widget
-- referenced exclusively by channels belonging to an active company membership.
-- No direct authenticated INSERT/DELETE is granted by this policy.
DROP POLICY IF EXISTS widget_config_write_admin ON public.widget_config;
CREATE POLICY widget_config_write_admin ON public.widget_config
FOR UPDATE TO authenticated
USING (EXISTS (
  SELECT 1
  FROM public.channel_config cc
  JOIN public.company_membership cm
    ON cm.company_id = cc.company_id
   AND cm.user_id = auth.uid()
   AND cm.is_active = true
  JOIN public.company co ON co.id = cm.company_id AND co.is_active = true
  WHERE cc.widget_config_id = widget_config.id
    AND cc.company_id IS NOT NULL
    AND cm.role::text = 'admin'
) AND NOT EXISTS (
  SELECT 1
  FROM public.channel_config other_cc
  WHERE other_cc.widget_config_id = widget_config.id
    AND (other_cc.company_id IS NULL OR NOT public.is_company_member(other_cc.company_id, auth.uid()))
))
WITH CHECK (EXISTS (
  SELECT 1
  FROM public.channel_config cc
  JOIN public.company_membership cm
    ON cm.company_id = cc.company_id
   AND cm.user_id = auth.uid()
   AND cm.is_active = true
  JOIN public.company co ON co.id = cm.company_id AND co.is_active = true
  WHERE cc.widget_config_id = widget_config.id
    AND cc.company_id IS NOT NULL
    AND cm.role::text = 'admin'
) AND NOT EXISTS (
  SELECT 1
  FROM public.channel_config other_cc
  WHERE other_cc.widget_config_id = widget_config.id
    AND (other_cc.company_id IS NULL OR NOT public.is_company_member(other_cc.company_id, auth.uid()))
));

-- Replace global supervisor INSERT with a conversation-tenant supervisor boundary.
DROP POLICY IF EXISTS feedback_request_insert_supervisor ON public.feedback_request;
CREATE POLICY feedback_request_insert_supervisor ON public.feedback_request
FOR INSERT TO authenticated
WITH CHECK (EXISTS (
  SELECT 1
  FROM public.conversations c
  JOIN public.company_membership cm
    ON cm.company_id = c.company_id
   AND cm.user_id = auth.uid()
   AND cm.is_active = true
  JOIN public.company co ON co.id = cm.company_id AND co.is_active = true
  WHERE c.id = feedback_request.conversation_id
    AND cm.role::text = 'supervisor'
));

DO $assert$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='widget_config'
      AND policyname='widget_config_write_admin'
      AND (qual = 'has_role(auth.uid(), ''admin''::app_role)'
           OR with_check = 'has_role(auth.uid(), ''admin''::app_role)')
  ) THEN
    RAISE EXCEPTION 'ASSERT: widget_config global admin write remains';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='feedback_request'
      AND policyname='feedback_request_insert_supervisor'
      AND with_check = 'has_role(auth.uid(), ''supervisor''::app_role)'
  ) THEN
    RAISE EXCEPTION 'ASSERT: feedback_request global supervisor insert remains';
  END IF;
END
$assert$;

COMMIT;
