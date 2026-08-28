-- Task 3.3 emergency rollback for residual write-policy closure.
-- WARNING: restores the immediately preceding broader policies.
BEGIN;

DROP POLICY IF EXISTS widget_config_write_admin ON public.widget_config;
CREATE POLICY widget_config_write_admin ON public.widget_config
FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'::public.app_role))
WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

DROP POLICY IF EXISTS feedback_request_insert_supervisor ON public.feedback_request;
CREATE POLICY feedback_request_insert_supervisor ON public.feedback_request
FOR INSERT TO authenticated
WITH CHECK (public.has_role(auth.uid(), 'supervisor'::public.app_role));

COMMIT;
