-- PR7 Workflow 3 / Task 3.1 — legacy channel ownership foundation
-- SOURCE-ONLY. No production apply without explicit authorization.
--
-- Scope:
--   Bind legacy public.channel_config rows to the already-established canonical
--   SU Platform company. Do NOT write public.conversations in this task.

BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.pr7_channel_ownership_run (
  run_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rolled_back_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.pr7_channel_ownership_row (
  run_id uuid NOT NULL
    REFERENCES public.pr7_channel_ownership_run(run_id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  previous_company_id uuid,
  assigned_company_id uuid NOT NULL,
  PRIMARY KEY(run_id,channel_id)
);

DO $assert$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='channel_config'
      AND column_name='company_id'
      AND udt_name='uuid'
  ) THEN
    RAISE EXCEPTION 'ASSERT: channel_config.company_id UUID column missing';
  END IF;
END
$assert$;

COMMIT;
