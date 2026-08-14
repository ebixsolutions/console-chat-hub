-- PR-7 config/profile RPC tenant isolation guard rollback.
-- SOURCE ONLY. This rollback restores the legacy function bodies that existed
-- before PR7-config-rpc-tenant-guard-v1. It is intentionally NOT run by apply.command.
--
-- IMPORTANT: the legacy bodies use global role checks and are not tenant-safe.
-- Run only as an emergency rollback with explicit Director authorization.

BEGIN;

-- Rather than silently recreating insecure legacy logic in a generic local apply,
-- rollback is fail-closed at source level. Production rollback must restore the
-- authoritative pre-change definitions captured in migration:
--   supabase/migrations/20260623004906_e46adcc1-c762-40c2-a0ff-9ba22e0c5709.sql
--
-- We intentionally abort if someone tries to apply this rollback without
-- explicitly replacing this guard with the frozen pre-change definitions.
DO $$
BEGIN
  RAISE EXCEPTION
    'PR7_CONFIG_RPC_ROLLBACK_REQUIRES_EXPLICIT_FROZEN_PRECHANGE_DEFINITIONS';
END
$$;

ROLLBACK;
