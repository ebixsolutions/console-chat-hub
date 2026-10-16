-- Preserve saved content/history. Pause this feature; do not drop its rows.
-- Execute only against the verified installation/preimage, never an owner successor.
BEGIN;
REVOKE SELECT,INSERT,UPDATE,DELETE ON public.saved_response FROM authenticated;
COMMIT;
