BEGIN;

DROP FUNCTION IF EXISTS public.receive_widget_message_tx(
  uuid,text,text
);

COMMIT;
