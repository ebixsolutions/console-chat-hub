CREATE OR REPLACE FUNCTION public.initiate_evaluation(p_cid uuid, p_ver text, p_kb text, p_pol text, p_model text, p_prompt text, p_hash text, p_src text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"ok":true}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.complete_evaluation(p_attempt uuid, p_scores jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"ok":true}'::jsonb $$;
CREATE OR REPLACE FUNCTION public.fail_evaluation(p_attempt uuid, p_error text) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"ok":true}'::jsonb $$;
CREATE TABLE IF NOT EXISTS public.company_backfill_contract (id int PRIMARY KEY DEFAULT 1 CHECK (id=1), state text NOT NULL DEFAULT 'awaiting_owner_mapping' CHECK (state IN ('awaiting_owner_mapping','mapping_in_progress','complete')), authority text NOT NULL DEFAULT 'production_owner', unassigned_conversations bigint, notes text NOT NULL DEFAULT 'Existing rows must not be assigned by inference.', created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO public.company_backfill_contract (id,state) VALUES (1,'awaiting_owner_mapping') ON CONFLICT DO NOTHING;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
