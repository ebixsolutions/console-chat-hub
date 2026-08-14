-- Workflow 6 / Task 6.1 — Widget appearance theme persistence contract
-- SOURCE ONLY. No production apply without explicit authorization.

BEGIN;
SET LOCAL lock_timeout='10s';

ALTER TABLE public.widget_config
  ADD COLUMN IF NOT EXISTS appearance_theme text;

UPDATE public.widget_config
SET appearance_theme='classic'
WHERE appearance_theme IS NULL;

ALTER TABLE public.widget_config
  ALTER COLUMN appearance_theme SET DEFAULT 'classic',
  ALTER COLUMN appearance_theme SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid='public.widget_config'::regclass
      AND conname='widget_config_appearance_theme_check'
  ) THEN
    ALTER TABLE public.widget_config
      ADD CONSTRAINT widget_config_appearance_theme_check
      CHECK (appearance_theme IN ('classic','modern'));
  END IF;
END
$$;

COMMENT ON COLUMN public.widget_config.appearance_theme IS
  'Presentation-only widget theme. classic and modern share the same authoritative chat.js runtime and backend behavior.';

COMMIT;
