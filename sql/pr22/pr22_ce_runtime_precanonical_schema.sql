-- PR22 Task 1 — pre-canonical CE runtime schema closure.
-- Idempotent additive schema only. No company binding, no local→canonical rebind,
-- no evaluation row creation, and no mutation-authority cutover.

BEGIN;
SET LOCAL lock_timeout='10s';

ALTER TABLE public.ce_local_evaluation_attempt
  ADD COLUMN IF NOT EXISTS company_id uuid,
  ADD COLUMN IF NOT EXISTS rebound_run_id uuid,
  ADD COLUMN IF NOT EXISTS rebound_at timestamptz;

ALTER TABLE public.ce_local_evaluation
  ADD COLUMN IF NOT EXISTS canonical_evaluation_id uuid,
  ADD COLUMN IF NOT EXISTS rebound_run_id uuid,
  ADD COLUMN IF NOT EXISTS rebound_at timestamptz;

ALTER TABLE public.ce_local_bundle_snapshot
  ADD COLUMN IF NOT EXISTS rebound_run_id uuid,
  ADD COLUMN IF NOT EXISTS rebound_at timestamptz;

CREATE TABLE IF NOT EXISTS public.ce_local_canonical_map (
  local_evaluation_id uuid PRIMARY KEY
    REFERENCES public.ce_local_evaluation(id) ON DELETE RESTRICT,
  canonical_evaluation_id uuid NOT NULL UNIQUE
    REFERENCES public.conversation_evaluation(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE RESTRICT,
  rebind_run_id uuid NOT NULL,
  rebound_by uuid NOT NULL,
  rebound_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ce_local_canonical_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ce_local_canonical_map_tenant_read
  ON public.ce_local_canonical_map;
CREATE POLICY ce_local_canonical_map_tenant_read
ON public.ce_local_canonical_map
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.company_membership cm
    WHERE cm.company_id=ce_local_canonical_map.company_id
      AND cm.user_id=auth.uid()
      AND cm.is_active
  )
);

GRANT SELECT ON public.ce_local_canonical_map TO authenticated;
GRANT ALL ON public.ce_local_canonical_map TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
