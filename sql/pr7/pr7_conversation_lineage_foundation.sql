-- PR7 Workflow 3 / Task 3.2 — conversation + direct lineage backfill foundation
-- SOURCE-ONLY. No production apply without explicit authorization.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS public.pr7_conversation_lineage_run (
  run_id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rolled_back_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.pr7_conversation_lineage_row (
  run_id uuid NOT NULL
    REFERENCES public.pr7_conversation_lineage_run(run_id) ON DELETE CASCADE,
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  previous_company_id uuid,
  assigned_company_id uuid NOT NULL,
  lineage_source text NOT NULL
    CHECK (lineage_source IN ('channel','explicit_orphan_confirmation','conversation')),
  PRIMARY KEY(run_id,table_name,row_id)
);

COMMIT;
