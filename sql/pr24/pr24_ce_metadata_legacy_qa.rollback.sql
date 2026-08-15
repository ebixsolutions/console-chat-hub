BEGIN;
SET LOCAL lock_timeout='10s';

DO $$
BEGIN
  IF EXISTS(
    SELECT 1 FROM public.ce_legacy_qa_metric LIMIT 1
  ) OR EXISTS(
    SELECT 1 FROM public.conversations
    WHERE customer_tier IS NOT NULL
       OR intent IS NOT NULL
       OR language IS NOT NULL
       OR metadata_source <> '{}'::jsonb
       OR metadata_updated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PR24_ROLLBACK_BLOCKED_METADATA_EXISTS';
  END IF;
END
$$;

DROP TRIGGER IF EXISTS ce_legacy_qa_company_guard_t
ON public.ce_legacy_qa_metric;
DROP FUNCTION IF EXISTS public.ce_legacy_qa_company_guard();
DROP TABLE IF EXISTS public.ce_legacy_qa_metric;

ALTER TABLE public.conversations
  DROP COLUMN IF EXISTS metadata_updated_at,
  DROP COLUMN IF EXISTS metadata_source,
  DROP COLUMN IF EXISTS language,
  DROP COLUMN IF EXISTS intent,
  DROP COLUMN IF EXISTS customer_tier;

NOTIFY pgrst, 'reload schema';
COMMIT;
