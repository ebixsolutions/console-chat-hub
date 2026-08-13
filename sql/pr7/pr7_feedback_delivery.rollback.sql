BEGIN;
DROP FUNCTION IF EXISTS public.finish_feedback_delivery_tx(
  uuid,text,text,text,timestamptz,timestamptz,timestamptz
);
DROP FUNCTION IF EXISTS public.claim_feedback_delivery_tx();
COMMIT;
