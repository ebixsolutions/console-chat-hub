-- PR29 Task 2 safeupdate-fix rollback.
-- Intentionally disabled as an executable downgrade because restoring the prior
-- WHERE-less function would reintroduce the confirmed production blocker.
-- Rollback for this fix is therefore: revert Git commit only before production
-- activation. After production activation, retain this safeupdate-compatible RPC.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';
SELECT 1;
COMMIT;
