-- PR22 rollback is intentionally non-destructive.
-- The additive columns/table are shared with PR20 canonical rebinding and may
-- already be referenced by source. Do not drop them during a runtime rollback.
-- Roll back the Edge deployment to the previous Git commit instead.
BEGIN;
SELECT 1;
COMMIT;
