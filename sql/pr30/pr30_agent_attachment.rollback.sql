-- Task 3.3 (E) rollback — remove the agent attachment RPC only.
--
-- Non-destructive: no message, storage object or audit row is deleted. Existing
-- attachment messages keep their metadata and remain renderable through the
-- authenticated signed-URL path.

BEGIN;

DROP FUNCTION IF EXISTS public.agent_send_attachment_tx(
  uuid, uuid, text, text, text, text, bigint, text
);

COMMIT;
