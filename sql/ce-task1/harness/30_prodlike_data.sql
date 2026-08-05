-- Production-like CE data used to prove the rollback fails closed.
INSERT INTO public.conversation_evaluation_attempt (
  conversation_id, input_snapshot_hash, initiated_by, kb_snapshot_id, policy_snapshot_id,
  model_version, prompt_version, source_deployment)
VALUES ('c3000000-0000-4000-8000-00000000000a','snap-prod',
        '11111111-1111-4111-8111-111111111111','kb-1','pol-1','model-1','prompt-1','prodlike');

INSERT INTO public.ce_replay_bundle (
  attempt_id, conversation_id, company_id, transcript_redacted,
  evaluation_contract_version, model_version, prompt_version,
  kb_snapshot_id, policy_snapshot_id, snapshot_hash)
SELECT a.id, a.conversation_id, '0e51e0c0-0000-4000-8000-ce0000000001',
       jsonb_build_array(jsonb_build_object('role','visitor','content','prod-like transcript')),
       'v1','model-1','prompt-1','kb-1','pol-1','snap-prod'
  FROM public.conversation_evaluation_attempt a WHERE a.input_snapshot_hash = 'snap-prod';
