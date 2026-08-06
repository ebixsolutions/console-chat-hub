-- Pre-existing functions for rollback testing
-- ALL FIVE RPCs + view with diverse owners/ACLs/grant options

DROP FUNCTION IF EXISTS public.fail_evaluation(uuid,text);
CREATE FUNCTION public.fail_evaluation(p_attempt_id uuid, p_error text) RETURNS text LANGUAGE sql AS $orig$ SELECT 'original_fail'::text $orig$;
GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid,text) TO service_role WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid,text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid,text) TO test_arb_role WITH GRANT OPTION;

DROP FUNCTION IF EXISTS public.reap_stale_evaluation_attempts(interval);
CREATE FUNCTION public.reap_stale_evaluation_attempts(p_older_than interval DEFAULT '15 minutes') RETURNS text LANGUAGE sql AS $orig$ SELECT 'original_reap'::text $orig$;
GRANT EXECUTE ON FUNCTION public.reap_stale_evaluation_attempts(interval) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.review_evaluation(uuid,uuid,text,text);
CREATE FUNCTION public.review_evaluation(p_evaluation_id uuid, p_expected_conversation_id uuid, p_decision text, p_note text DEFAULT NULL) RETURNS text LANGUAGE sql AS $orig$ SELECT 'original_review'::text $orig$;
GRANT EXECUTE ON FUNCTION public.review_evaluation(uuid,uuid,text,text) TO authenticated WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.review_evaluation(uuid,uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.initiate_evaluation_v2(p_conversation_id uuid,p_contract_version text,p_kb_snapshot_id text,p_policy_snapshot_id text,p_model_version text,p_prompt_version text,p_input_snapshot_hash text,p_bundle_hash text,p_grounding_manifest jsonb,p_initiated_by uuid,p_source_deployment text) RETURNS text LANGUAGE sql AS $orig$ SELECT 'original_init'::text $orig$;
GRANT EXECUTE ON FUNCTION public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text) TO PUBLIC;

CREATE OR REPLACE FUNCTION public.complete_evaluation_v2(p_attempt_id uuid,p_scores jsonb,p_details jsonb,p_bundle_hash text,p_snapshot jsonb,p_derived jsonb) RETURNS text LANGUAGE sql AS $orig$ SELECT 'original_comp'::text $orig$;
GRANT EXECUTE ON FUNCTION public.complete_evaluation_v2(uuid,jsonb,jsonb,text,jsonb,jsonb) TO service_role WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.complete_evaluation_v2(uuid,jsonb,jsonb,text,jsonb,jsonb) TO test_arb_role;

-- Pre-existing view with compatible column signature
CREATE OR REPLACE VIEW public.ce_conversation_status_v AS
  SELECT e.id AS evaluation_id, e.conversation_id, e.company_id,
    e.overall_score, e.severity, e.training_eligible, e.has_verified_human_response,
    e.created_at AS evaluated_at, e.review_status,
    o.status AS outbox_status, o.delivered_at,
    'none'::text AS improved_result_status, NULL::timestamptz AS improved_result_received_at,
    false AS needs_review, false AS training_ready, false AS trained,
    'not_applicable'::text AS improved_result_state
  FROM public.conversation_evaluation e
  LEFT JOIN public.evaluation_training_outbox o ON o.evaluation_id=e.id;
GRANT SELECT ON public.ce_conversation_status_v TO authenticated;
GRANT SELECT ON public.ce_conversation_status_v TO service_role WITH GRANT OPTION;
GRANT SELECT ON public.ce_conversation_status_v TO test_arb_role;
GRANT INSERT ON public.ce_conversation_status_v TO test_arb_role WITH GRANT OPTION;

-- Unrelated overload that must survive rollback
CREATE FUNCTION public.fail_evaluation(p_id uuid) RETURNS text LANGUAGE sql AS $orig$ SELECT 'unrelated_overload'::text $orig$;
GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid) TO authenticated;
