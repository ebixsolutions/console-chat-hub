BEGIN;
SET LOCAL lock_timeout='10s';

DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.ce_local_canonical_map LIMIT 1)
     OR EXISTS(
       SELECT 1 FROM public.ce_local_evaluation
       WHERE canonical_evaluation_id IS NOT NULL OR rebound_at IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'PR20_ROLLBACK_BLOCKED_CANONICAL_REBIND_EXISTS';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.rebind_local_evaluations_v1(uuid,uuid,uuid);
DROP FUNCTION IF EXISTS public.finalize_local_evaluation_tenant_scope_v1(uuid,uuid);

DROP TABLE IF EXISTS public.ce_local_canonical_map;

ALTER TABLE public.ce_local_bundle_snapshot
  DROP COLUMN IF EXISTS rebound_at,
  DROP COLUMN IF EXISTS rebound_run_id;

ALTER TABLE public.ce_local_evaluation
  DROP COLUMN IF EXISTS rebound_at,
  DROP COLUMN IF EXISTS rebound_run_id,
  DROP COLUMN IF EXISTS canonical_evaluation_id;

ALTER TABLE public.ce_local_evaluation_attempt
  DROP COLUMN IF EXISTS rebound_at,
  DROP COLUMN IF EXISTS rebound_run_id,
  DROP COLUMN IF EXISTS company_id;

COMMIT;
