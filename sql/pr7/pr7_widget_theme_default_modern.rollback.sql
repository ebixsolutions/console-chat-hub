-- Workflow 6 / Task 6.2 — exact rollback of default-modern promotion.
-- Stops if a promoted row was modified after this migration.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.pr7_widget_theme_default_modern_provenance p
    JOIN public.widget_config w ON w.id=p.widget_id
    WHERE w.appearance_theme IS DISTINCT FROM 'modern'
       OR w.updated_at IS DISTINCT FROM p.applied_updated_at
  ) THEN
    RAISE EXCEPTION
      'WIDGET_THEME_DEFAULT_MODERN_ROLLBACK_BLOCKED: user/runtime theme state changed after promotion';
  END IF;
END
$$;

UPDATE public.widget_config w
SET appearance_theme=p.previous_theme,
    updated_at=p.previous_updated_at
FROM public.pr7_widget_theme_default_modern_provenance p
WHERE w.id=p.widget_id;

ALTER TABLE public.widget_config
  ALTER COLUMN appearance_theme SET DEFAULT 'classic';

DROP TABLE public.pr7_widget_theme_default_modern_provenance;

COMMIT;
