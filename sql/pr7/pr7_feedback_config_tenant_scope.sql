-- PR-7 — tenant-scoped feedback automation configuration.
-- SOURCE ONLY. Do not apply to production without explicit Director authorization.
--
-- Existing legacy rows remain company_id NULL and become inert. We do NOT guess
-- their owner. Each company gets its own explicit config row on the next admin save.
--
-- Rollback provenance records the pre-existing policies so rollback can recreate
-- them exactly instead of assuming their names/definitions.

BEGIN;

CREATE TABLE IF NOT EXISTS public.pr7_feedback_config_policy_prov (
  policyname text PRIMARY KEY,
  permissive text NOT NULL,
  roles text[] NOT NULL,
  cmd text NOT NULL,
  qual text,
  with_check text
);

TRUNCATE public.pr7_feedback_config_policy_prov;

INSERT INTO public.pr7_feedback_config_policy_prov(
  policyname, permissive, roles, cmd, qual, with_check
)
SELECT
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'feedback_automation_config';

ALTER TABLE public.feedback_automation_config
  ADD COLUMN IF NOT EXISTS company_id uuid
  REFERENCES public.company(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_automation_config_company
  ON public.feedback_automation_config(company_id)
  WHERE company_id IS NOT NULL;

ALTER TABLE public.feedback_automation_config ENABLE ROW LEVEL SECURITY;

DO $drop$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'feedback_automation_config'
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.feedback_automation_config',
      p.policyname
    );
  END LOOP;
END
$drop$;

CREATE POLICY feedback_config_company_select
ON public.feedback_automation_config
FOR SELECT
TO authenticated
USING (
  company_id IS NOT NULL
  AND public.is_company_member(company_id, auth.uid())
);

CREATE POLICY feedback_config_company_insert
ON public.feedback_automation_config
FOR INSERT
TO authenticated
WITH CHECK (
  company_id IS NOT NULL
  AND public.has_company_role(company_id, auth.uid(), 'admin'::public.app_role)
);

CREATE POLICY feedback_config_company_update
ON public.feedback_automation_config
FOR UPDATE
TO authenticated
USING (
  company_id IS NOT NULL
  AND public.has_company_role(company_id, auth.uid(), 'admin'::public.app_role)
)
WITH CHECK (
  company_id IS NOT NULL
  AND public.has_company_role(company_id, auth.uid(), 'admin'::public.app_role)
);

CREATE POLICY feedback_config_company_delete
ON public.feedback_automation_config
FOR DELETE
TO authenticated
USING (
  company_id IS NOT NULL
  AND public.has_company_role(company_id, auth.uid(), 'admin'::public.app_role)
);

REVOKE ALL ON public.feedback_automation_config FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feedback_automation_config TO authenticated;
GRANT ALL ON public.feedback_automation_config TO service_role;

DO $assert$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM pg_policies
  WHERE schemaname='public'
    AND tablename='feedback_automation_config'
    AND policyname IN (
      'feedback_config_company_select',
      'feedback_config_company_insert',
      'feedback_config_company_update',
      'feedback_config_company_delete'
    );
  IF v_count <> 4 THEN
    RAISE EXCEPTION 'ASSERT: expected 4 scoped feedback config policies, got %', v_count;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.feedback_automation_config
    WHERE company_id IS NULL
      AND id IN (
        SELECT id FROM public.feedback_automation_config
        WHERE company_id IS NULL
      )
  ) THEN
    -- Legacy NULL rows are intentionally allowed to remain in storage;
    -- scoped policies make them invisible to authenticated application users.
    NULL;
  END IF;
END
$assert$;

COMMIT;
