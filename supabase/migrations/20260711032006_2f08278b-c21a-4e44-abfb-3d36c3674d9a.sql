DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'sandbox_exec'
  ) THEN
    REVOKE EXECUTE ON FUNCTION
      public.takeover_conversation_tx(UUID, UUID, TEXT, UUID)
    FROM sandbox_exec;
  END IF;
END
$$;
