-- PR-7 conversation resolution atomic transaction guard rollback.
-- SOURCE ONLY. Safe before deployment: remove the forward source file.
-- After deployment, explicit Director authorization is required.

BEGIN;

DROP FUNCTION IF EXISTS public.set_conversation_resolution_tx(
  uuid, uuid, uuid, uuid, text, text
);

COMMIT;
