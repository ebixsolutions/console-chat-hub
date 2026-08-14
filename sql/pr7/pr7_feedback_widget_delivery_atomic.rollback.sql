-- PR-7 feedback widget delivery atomic completion rollback.
-- SOURCE ONLY.

BEGIN;

DROP FUNCTION IF EXISTS public.complete_widget_feedback_delivery_tx(
  uuid,uuid,uuid,text,timestamptz,timestamptz,timestamptz,text,text,text
);

COMMIT;
