-- PR-7 recall-message atomic transaction guard rollback.
-- SOURCE ONLY.

BEGIN;

DROP FUNCTION IF EXISTS public.recall_message_tx(
  uuid, uuid, uuid, uuid, text
);

COMMIT;
