-- Workflow 6 / Task 6.2 — Modern Assistant Panel becomes default widget theme.
-- Must run after pr7_widget_theme_contract.sql.

BEGIN;
SET LOCAL lock_timeout='10s';

CREATE TABLE IF NOT EXISTS public.pr7_widget_theme_default_modern_provenance (
  widget_id uuid PRIMARY KEY REFERENCES public.widget_config(id) ON DELETE RESTRICT,
  previous_theme text NOT NULL,
  previous_updated_at timestamptz,
  applied_updated_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='widget_config'
      AND column_name='appearance_theme'
  ) THEN
    RAISE EXCEPTION 'WIDGET_THEME_DEFAULT_MODERN_REQUIRES_TASK_6_1';
  END IF;
END
$$;

ALTER TABLE public.widget_config
  ALTER COLUMN appearance_theme SET DEFAULT 'modern';

WITH candidates AS (
  SELECT id, appearance_theme, updated_at
  FROM public.widget_config
  WHERE appearance_theme='classic'
    AND NOT EXISTS (
      SELECT 1
      FROM public.pr7_widget_theme_default_modern_provenance p
      WHERE p.widget_id=widget_config.id
    )
),
stamped AS (
  SELECT id, appearance_theme, updated_at, clock_timestamp() AS applied_updated_at
  FROM candidates
),
recorded AS (
  INSERT INTO public.pr7_widget_theme_default_modern_provenance(
    widget_id,previous_theme,previous_updated_at,applied_updated_at
  )
  SELECT id,appearance_theme,updated_at,applied_updated_at
  FROM stamped
  ON CONFLICT (widget_id) DO NOTHING
  RETURNING widget_id,applied_updated_at
)
UPDATE public.widget_config w
SET appearance_theme='modern',
    updated_at=r.applied_updated_at
FROM recorded r
WHERE w.id=r.widget_id
  AND w.appearance_theme='classic';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.widget_config
    WHERE appearance_theme IS NULL
       OR appearance_theme NOT IN ('classic','modern')
  ) THEN
    RAISE EXCEPTION 'WIDGET_THEME_DEFAULT_MODERN_INVALID_THEME';
  END IF;
END
$$;

COMMIT;
