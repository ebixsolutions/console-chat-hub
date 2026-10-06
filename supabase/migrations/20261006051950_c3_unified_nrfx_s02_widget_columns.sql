-- s02_widget_columns / nrfxhqabwblzxoushgnm / C3-UNIFIED-NRFX-SCOPED-AUTH-20261006-v1
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns
 WHERE table_schema='public' AND table_name='widget_config'
 AND column_name IN ('appearance_theme','launcher_icon')) THEN
 RAISE EXCEPTION 'REPAIR_WIDGET_PREFLIGHT_CHANGED'; END IF;
END $guard$;
ALTER TABLE public.widget_config
 ADD COLUMN appearance_theme text NOT NULL DEFAULT 'modern',
 ADD COLUMN launcher_icon text NOT NULL DEFAULT 'chat';
ALTER TABLE public.widget_config
 ADD CONSTRAINT widget_config_appearance_theme_check CHECK(appearance_theme IN ('classic','modern')),
 ADD CONSTRAINT widget_config_launcher_icon_check CHECK(launcher_icon IN ('chat','headset','sparkles','bot','mail'));
COMMIT;
