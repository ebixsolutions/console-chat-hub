-- PR13 Widget launcher icon persistence.
-- Safe finite enum only; no raw HTML/SVG is stored or rendered.
BEGIN;
SET LOCAL lock_timeout='10s';

CREATE TABLE IF NOT EXISTS public.pr13_widget_launcher_icon_provenance (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  applied_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.pr13_widget_launcher_icon_provenance WHERE singleton=true) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='widget_config' AND column_name='launcher_icon'
    ) THEN
      RAISE EXCEPTION 'PR13_LAUNCHER_ICON_PREEXISTING_COLUMN_REFUSED';
    END IF;
    INSERT INTO public.pr13_widget_launcher_icon_provenance(singleton) VALUES(true);
  END IF;
END
$$;

ALTER TABLE public.widget_config ADD COLUMN IF NOT EXISTS launcher_icon text;
UPDATE public.widget_config SET launcher_icon='chat' WHERE launcher_icon IS NULL;
ALTER TABLE public.widget_config ALTER COLUMN launcher_icon SET DEFAULT 'chat';
ALTER TABLE public.widget_config ALTER COLUMN launcher_icon SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.widget_config'::regclass
      AND conname='widget_config_launcher_icon_check'
  ) THEN
    ALTER TABLE public.widget_config
      ADD CONSTRAINT widget_config_launcher_icon_check
      CHECK (launcher_icon IN ('chat','headset','sparkles','bot','mail'));
  END IF;
END
$$;

COMMENT ON COLUMN public.widget_config.launcher_icon IS
  'Safe launcher glyph enum. Never stores raw HTML, SVG, JavaScript, or user markup.';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.widget_config
    WHERE launcher_icon IS NULL
       OR launcher_icon NOT IN ('chat','headset','sparkles','bot','mail')
  ) THEN
    RAISE EXCEPTION 'PR13_LAUNCHER_ICON_INVALID_DATA';
  END IF;
END
$$;
COMMIT;
