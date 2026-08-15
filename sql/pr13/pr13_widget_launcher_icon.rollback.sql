-- PR13 exact rollback for a migration-owned launcher_icon column.
BEGIN;
SET LOCAL lock_timeout='10s';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.pr13_widget_launcher_icon_provenance WHERE singleton=true
  ) THEN
    RAISE EXCEPTION 'PR13_LAUNCHER_ICON_ROLLBACK_PROVENANCE_MISSING';
  END IF;
END
$$;
ALTER TABLE public.widget_config DROP CONSTRAINT IF EXISTS widget_config_launcher_icon_check;
ALTER TABLE public.widget_config DROP COLUMN IF EXISTS launcher_icon;
DROP TABLE public.pr13_widget_launcher_icon_provenance;
COMMIT;
