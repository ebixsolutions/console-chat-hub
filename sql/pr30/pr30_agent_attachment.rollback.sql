-- Task 3.3 (E/F) rollback — remove the agent attachment RPC and private locator table.
--
-- PR30 is forward-only source until Director authorizes production application.
-- This rollback intentionally does not delete public.messages, audit rows, or
-- storage objects. If PR30 has been used to create attachment rows, operational
-- rollback must first preserve/remove the corresponding private storage objects.

BEGIN;

DROP FUNCTION IF EXISTS public.agent_send_attachment_tx(
  uuid, uuid, text, text, text, text, bigint, text
);

DROP TABLE IF EXISTS public.message_attachment_private;

COMMIT;
