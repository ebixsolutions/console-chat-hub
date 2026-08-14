-- Workflow 6 / Task 6.1 — Widget appearance theme rollback
-- Fail closed if a non-default theme has already been selected.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.widget_config
    WHERE appearance_theme IS DISTINCT FROM 'classic'
  ) THEN
    RAISE EXCEPTION
      'WIDGET_THEME_ROLLBACK_BLOCKED: modern/non-default theme is in use';
  END IF;
END
$$;

ALTER TABLE public.widget_config
  DROP CONSTRAINT IF EXISTS widget_config_appearance_theme_check;

ALTER TABLE public.widget_config
  DROP COLUMN IF EXISTS appearance_theme;

COMMIT;
