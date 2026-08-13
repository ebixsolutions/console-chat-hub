BEGIN;

DROP FUNCTION IF EXISTS public.create_widget_session_tx(
  uuid,text,text,jsonb,text
);

COMMIT;
