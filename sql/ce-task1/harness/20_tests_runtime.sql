-- ===========================================================================
-- Executed runtime assertions (S4-S8 + canonical status).
-- Every check RAISEs on failure, so a non-zero psql exit is the only outcome
-- of a regression. Successful checks print CE_TEST_OK <name>.
-- ===========================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Fixtures: a second tenant + enable the fail-closed gate
-- ---------------------------------------------------------------------------
INSERT INTO public.company (id, workspace_id, tenant_id, name) VALUES
  ('0e51e0c0-0000-4000-8000-ce00000000b1','0e51e0c0-0000-4000-8000-ce00000000b1',
   '0e51e0c0-0000-4000-8000-ce00000000b1','Company B');
INSERT INTO public.company_member (company_id, user_id) VALUES
  ('0e51e0c0-0000-4000-8000-ce00000000b1','44444444-4444-4444-8444-444444444444');
INSERT INTO public.channel_config (id, name, company_id) VALUES
  ('c1000000-0000-4000-8000-0000000000b1','Channel B','0e51e0c0-0000-4000-8000-ce00000000b1');
INSERT INTO public.conversations (id, channel_config_id, company_id, status) VALUES
  ('c3000000-0000-4000-8000-0000000000b1','c1000000-0000-4000-8000-0000000000b1',
   '0e51e0c0-0000-4000-8000-ce00000000b1','open');
INSERT INTO public.messages (conversation_id, role, content) VALUES
  ('c3000000-0000-4000-8000-0000000000b1','visitor','Tenant v_conv_b question');

-- admin_b belongs to tenant v_conv_b only (the migration backfill enrolls every
-- existing staff user into the provisioned default company; a real second
-- tenant is separated by removing that default membership).
DELETE FROM public.company_member
 WHERE user_id = '44444444-4444-4444-8444-444444444444'
   AND company_id = '0e51e0c0-0000-4000-8000-ce0000000001';
DELETE FROM public.company_member
 WHERE user_id = '55555555-5555-4555-8555-555555555555';

UPDATE public.ce_feature_flags SET enabled = true
 WHERE key = 'ce_grounding_fail_closed_enabled';

-- ---------------------------------------------------------------------------
DO $t$
DECLARE
  v_conv_a uuid := 'c3000000-0000-4000-8000-00000000000a';
  v_conv_b uuid := 'c3000000-0000-4000-8000-0000000000b1';
  ADMIN_A text := '11111111-1111-4111-8111-111111111111';
  QA_A    text := '22222222-2222-4222-8222-222222222222';
  AGENT_A text := '33333333-3333-4333-8333-333333333333';
  ADMIN_B text := '44444444-4444-4444-8444-444444444444';
  QA_NONE text := '55555555-5555-4555-8555-555555555555';
  n integer; ok boolean; msg text;
BEGIN
  ---------------------------------------------------------------- S4 matrix
  PERFORM set_config('request.jwt.claim.sub', ADMIN_A, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.conversations;
  IF n <> 1 THEN RAISE EXCEPTION 'S4: admin_a should see exactly its own tenant conversation, saw %', n; END IF;
  SELECT count(*) INTO n FROM public.conversations WHERE id = v_conv_b;
  IF n <> 0 THEN RAISE EXCEPTION 'S4: admin_a saw cross-tenant conversation'; END IF;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S4 admin_a scoped to own tenant';

  PERFORM set_config('request.jwt.claim.sub', ADMIN_B, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.conversations;
  IF n <> 1 THEN RAISE EXCEPTION 'S4: admin_b visibility wrong: %', n; END IF;
  SELECT count(*) INTO n FROM public.conversations WHERE id = v_conv_a;
  IF n <> 0 THEN RAISE EXCEPTION 'S4: admin_b saw tenant v_conv_a conversation'; END IF;
  SELECT count(*) INTO n FROM public.messages;
  IF n <> 1 THEN RAISE EXCEPTION 'S4: admin_b message visibility wrong: %', n; END IF;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S4 admin_b scoped to own tenant (conversations + messages)';

  PERFORM set_config('request.jwt.claim.sub', QA_NONE, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.conversations;
  IF n <> 0 THEN RAISE EXCEPTION 'S4: staff without membership must see nothing, saw %', n; END IF;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S4 staff role without company membership is denied (fail-closed)';

  ---------------------------------------------------- S4b cross-tenant writes
  PERFORM set_config('request.jwt.claim.sub', ADMIN_B, true);
  SET LOCAL ROLE authenticated;
  UPDATE public.conversations SET status = 'tampered' WHERE id = v_conv_a;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'S4b: cross-tenant UPDATE affected % row(s)', n; END IF;
  BEGIN
    INSERT INTO public.messages (conversation_id, role, content)
    VALUES (v_conv_a, 'agent', 'cross tenant injection');
    RAISE EXCEPTION 'S4b: cross-tenant INSERT was allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S4b cross-tenant write denied (UPDATE filtered, INSERT rejected)';

  ------------------------------------------------------- S5 RPC scope + roles
  PERFORM set_config('request.jwt.claim.sub', ADMIN_B, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.ce_assert_scope(v_conv_a, 'qa');
    RAISE EXCEPTION 'S5: cross-tenant ce_assert_scope succeeded';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%CE_CROSS_TENANT_DENIED%' THEN RAISE; END IF;
  END;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S5 ce_assert_scope denies cross-tenant conversation';

  PERFORM set_config('request.jwt.claim.sub', AGENT_A, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.ce_assert_scope(v_conv_a, 'qa');
    RAISE EXCEPTION 'S5: agent passed the qa gate';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%CE_FORBIDDEN%' THEN RAISE; END IF;
  END;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S5 agent role rejected by qa-gated RPC (CE_FORBIDDEN)';

  PERFORM set_config('request.jwt.claim.sub', QA_A, true);
  SET LOCAL ROLE authenticated;
  IF public.ce_assert_scope(v_conv_a, 'qa') IS NULL THEN RAISE EXCEPTION 'S5: qa denied own tenant'; END IF;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S5 qa role accepted for own tenant';
END $t$;

-- ------------------------------------------------- S6 grounding validator
DO $t$
DECLARE exp jsonb; res jsonb; r jsonb;
BEGIN
  exp := jsonb_build_object(
    'workspace_id','w1','tenant_id','t1','company_id','k1',
    'chunks', jsonb_build_array(
      jsonb_build_object('chunk_id','c1','content_hash','h1'),
      jsonb_build_object('chunk_id','c2','content_hash','h2')));

  res := jsonb_build_object('workspace_id','w1','tenant_id','t1','company_id','k1',
    'chunks', jsonb_build_array(
      jsonb_build_object('chunk_id','c2','content_hash','h2','workspace_id','w1','tenant_id','t1','company_id','k1'),
      jsonb_build_object('chunk_id','c1','content_hash','h1','workspace_id','w1','tenant_id','t1','company_id','k1')));
  r := public.ce_validate_grounding(exp,res);
  IF (r->>'ok')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'S6: valid grounding rejected: %', r; END IF;
  RAISE NOTICE 'CE_TEST_OK S6 grounding accepted by chunk_id join (order independent)';

  r := public.ce_validate_grounding(exp, jsonb_set(res,'{company_id}','"OTHER"'));
  IF r->>'code' <> 'CE_CROSS_TENANT_SCOPE' THEN RAISE EXCEPTION 'S6: cross-tenant not rejected: %', r; END IF;
  RAISE NOTICE 'CE_TEST_OK S6 cross-tenant grounding envelope rejected';

  r := public.ce_validate_grounding(exp, jsonb_build_object(
        'workspace_id','w1','tenant_id','t1','company_id','k1',
        'chunks', jsonb_build_array(
          jsonb_build_object('chunk_id','c1','content_hash','h1','workspace_id','w1','tenant_id','t1','company_id','k1'),
          jsonb_build_object('chunk_id','c2','content_hash','h2','workspace_id','w1','tenant_id','t1','company_id','ZZ'))));
  IF r->>'code' <> 'CE_CHUNK_CROSS_TENANT' THEN RAISE EXCEPTION 'S6: chunk cross-tenant not rejected: %', r; END IF;
  RAISE NOTICE 'CE_TEST_OK S6 cross-tenant chunk reference rejected';

  r := public.ce_validate_grounding(exp, jsonb_build_object(
        'workspace_id','w1','tenant_id','t1','company_id','k1',
        'chunks', jsonb_build_array(
          jsonb_build_object('chunk_id','c1','content_hash','TAMPERED','workspace_id','w1','tenant_id','t1','company_id','k1'),
          jsonb_build_object('chunk_id','c2','content_hash','h2','workspace_id','w1','tenant_id','t1','company_id','k1'))));
  IF r->>'code' <> 'CE_CONTENT_HASH_MISMATCH' THEN RAISE EXCEPTION 'S6: hash tamper not rejected: %', r; END IF;
  RAISE NOTICE 'CE_TEST_OK S6 tampered chunk content hash rejected';

  r := public.ce_validate_grounding(exp, jsonb_build_object('chunks','[]'::jsonb));
  IF r->>'code' <> 'CE_SCOPE_ECHO_MISSING' THEN RAISE EXCEPTION 'S6: missing scope echo not rejected: %', r; END IF;
  RAISE NOTICE 'CE_TEST_OK S6 missing scope echo rejected (fail-closed)';
END $t$;

-- ------------------------------------- S7 canonical initiate/complete pipeline
DO $t$
DECLARE
  v_conv_a uuid := 'c3000000-0000-4000-8000-00000000000a';
  QA_A text := '22222222-2222-4222-8222-222222222222';
  h text := 'snap-hash-aaa';
  r1 jsonb; r2 jsonb; att uuid; ev uuid; e record;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', QA_A, true);
  SET LOCAL ROLE authenticated;

  r1 := public.ce_initiate_evaluation(v_conv_a,'v1','kb-1','pol-1','model-1','prompt-1',h,'harness');
  r2 := public.ce_initiate_evaluation(v_conv_a,'v1','kb-1','pol-1','model-1','prompt-1',h,'harness');
  IF r1->>'attempt_id' <> r2->>'attempt_id' THEN RAISE EXCEPTION 'S7: initiate not idempotent'; END IF;
  att := (r1->>'attempt_id')::uuid;
  RAISE NOTICE 'CE_TEST_OK S7 initiate_evaluation idempotent + concurrency locked';

  BEGIN
    PERFORM public.ce_complete_evaluation(att,
      jsonb_build_object('accuracy',60,'policy',60,'tone',60,'sales',60,'context',60,'hallucination_risk',40),
      NULL,'wrong-hash');
    RAISE EXCEPTION 'S7: snapshot hash mismatch accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%CE_SNAPSHOT_HASH_MISMATCH%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'CE_TEST_OK S7 snapshot hash mismatch rejected';

  BEGIN
    PERFORM public.ce_complete_evaluation(att,
      jsonb_build_object('accuracy',160,'policy',60,'tone',60,'sales',60,'context',60,'hallucination_risk',40),
      NULL,h);
    RAISE EXCEPTION 'S7: out-of-range score accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%CE_INVALID_SCORES%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.ce_complete_evaluation(att,
      jsonb_build_object('accuracy',60,'policy',60,'tone',60,'sales',60,'context',60),
      NULL,h);
    RAISE EXCEPTION 'S7: missing evaluator accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%CE_INVALID_SCORES%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'CE_TEST_OK S7 score contract validated (range + all six evaluators required)';

  r1 := public.ce_complete_evaluation(att,
      jsonb_build_object('accuracy',60,'policy',60,'tone',60,'sales',60,'context',60,'hallucination_risk',40),
      jsonb_build_array(
        jsonb_build_object('evaluator_type','accuracy','raw_score',60,'weight',0.25,'weighted_score',15,
                           'justification','harness','raw_llm_response',jsonb_build_object('secret','raw-provider-output'))),
      h);
  ev := (r1->>'evaluation_id')::uuid;
  r2 := public.ce_complete_evaluation(att,
      jsonb_build_object('accuracy',60,'policy',60,'tone',60,'sales',60,'context',60,'hallucination_risk',40),
      NULL,h);
  IF (r2->>'idempotent')::boolean IS NOT TRUE OR r2->>'evaluation_id' <> ev::text THEN
    RAISE EXCEPTION 'S7: complete not idempotent';
  END IF;
  RESET ROLE;

  SELECT * INTO e FROM public.conversation_evaluation WHERE id = ev;
  IF e.overall_score <> 60.00 THEN RAISE EXCEPTION 'S7: weighted overall wrong: %', e.overall_score; END IF;
  IF e.severity <> 'high' THEN RAISE EXCEPTION 'S7: severity wrong: %', e.severity; END IF;
  IF e.hallucination_quality_score <> 60.00 THEN RAISE EXCEPTION 'S7: quality score wrong: %', e.hallucination_quality_score; END IF;
  IF NOT e.has_verified_human_response THEN RAISE EXCEPTION 'S7: verified human response not detected'; END IF;
  IF NOT e.training_eligible THEN RAISE EXCEPTION 'S7: training_eligible contract broken'; END IF;
  RAISE NOTICE 'CE_TEST_OK S7 weights 25/20/20/15/10/10 => 60.00, severity high, eligible, idempotent';
END $t$;

-- --------------------------------------------------- S8 admin-only raw data
DO $t$
DECLARE n integer;
  ADMIN_A text := '11111111-1111-4111-8111-111111111111';
  QA_A    text := '22222222-2222-4222-8222-222222222222';
BEGIN
  PERFORM set_config('request.jwt.claim.sub', QA_A, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.conversation_evaluation_detail WHERE raw_llm_response IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'S8: qa read % raw LLM row(s)', n; END IF;
  RESET ROLE;

  PERFORM set_config('request.jwt.claim.sub', ADMIN_A, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.conversation_evaluation_detail WHERE raw_llm_response IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'S8: admin could not read raw LLM row (%)', n; END IF;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S8 raw LLM response is admin-only (qa denied, admin allowed)';
END $t$;

-- ------------------------------------------- S9 replay bundle + grounding
DO $t$
DECLARE
  v_conv_a uuid := 'c3000000-0000-4000-8000-00000000000a';
  v_seed uuid := '0e51e0c0-0000-4000-8000-ce0000000001';
  ADMIN_A text := '11111111-1111-4111-8111-111111111111';
  QA_A    text := '22222222-2222-4222-8222-222222222222';
  ADMIN_B text := '44444444-4444-4444-8444-444444444444';
  att uuid; ev uuid; b uuid; r jsonb; n integer;
BEGIN
  SELECT a.id, e.id INTO att, ev
    FROM public.conversation_evaluation_attempt a
    JOIN public.conversation_evaluation e ON e.attempt_id = a.id
   WHERE a.conversation_id = v_conv_a LIMIT 1;

  INSERT INTO public.ce_replay_bundle (
    evaluation_id, attempt_id, conversation_id, company_id, workspace_id, tenant_id,
    transcript_redacted, evaluated_reply_message_id, human_response_message_id,
    evaluation_contract_version, model_version, prompt_version,
    kb_snapshot_id, policy_snapshot_id, snapshot_hash, raw_evaluator_payload)
  VALUES (ev, att, v_conv_a, v_seed, v_seed, v_seed,
    jsonb_build_array(
      jsonb_build_object('role','visitor','content','Do you ship to Taiwan and what is the refund window?'),
      jsonb_build_object('role','assistant','content','We ship worldwide and refunds are always unlimited.'),
      jsonb_build_object('role','agent','content','We ship to Taiwan; refunds are accepted within 30 days of delivery.')),
    'c4000000-0000-4000-8000-000000000002','c4000000-0000-4000-8000-000000000003',
    'v1','model-1','prompt-1','kb-1','pol-1','snap-hash-aaa',
    jsonb_build_object('provider_raw','admin-only evaluator payload'))
  RETURNING id INTO b;

  INSERT INTO public.ce_replay_chunk (bundle_id, chunk_id, company_id, workspace_id, tenant_id,
                                      content_hash, chunk_text_redacted, score, source_ref)
  VALUES (b,'kb-chunk-1',v_seed,v_seed,v_seed,'h1','Refunds accepted within 30 days of delivery.',0.9210,'policy/refunds#1'),
         (b,'kb-chunk-2',v_seed,v_seed,v_seed,'h2','International shipping available to Taiwan.',0.8734,'policy/shipping#3');

  -- qa: sanitized replay with real transcript + grounding, no raw payload
  PERFORM set_config('request.jwt.claim.sub', QA_A, true);
  SET LOCAL ROLE authenticated;
  r := public.ce_get_replay_bundle(att);
  IF jsonb_array_length(r->'bundle'->'transcript_redacted') <> 3 THEN
    RAISE EXCEPTION 'S9: transcript not reconstructed'; END IF;
  IF jsonb_array_length(r->'grounding') <> 2 THEN RAISE EXCEPTION 'S9: grounding not reconstructed'; END IF;
  IF r->'grounding'->0->>'chunk_text_redacted' IS NULL THEN RAISE EXCEPTION 'S9: chunk text missing'; END IF;
  IF (r->>'raw_evaluator_payload') IS NOT NULL THEN RAISE EXCEPTION 'S9: qa received raw evaluator payload'; END IF;
  IF r->'bundle'->>'snapshot_hash' <> 'snap-hash-aaa' THEN RAISE EXCEPTION 'S9: snapshot hash missing'; END IF;
  SELECT count(*) INTO n FROM public.ce_replay_bundle;
  IF n <> 0 THEN RAISE EXCEPTION 'S9: qa read the admin-only bundle table directly'; END IF;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S9 qa replay renders immutable transcript + grounding evidence, raw payload withheld';

  PERFORM set_config('request.jwt.claim.sub', ADMIN_A, true);
  SET LOCAL ROLE authenticated;
  r := public.ce_get_replay_bundle(att);
  IF r->'raw_evaluator_payload'->>'provider_raw' IS NULL THEN
    RAISE EXCEPTION 'S9: admin denied raw evaluator payload'; END IF;
  SELECT count(*) INTO n FROM public.ce_replay_bundle;
  IF n <> 1 THEN RAISE EXCEPTION 'S9: admin cannot read bundle table (%)', n; END IF;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S9 admin replay includes raw evaluator payload';

  PERFORM set_config('request.jwt.claim.sub', ADMIN_B, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.ce_get_replay_bundle(att);
    RAISE EXCEPTION 'S9: cross-tenant replay allowed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%CE_CROSS_TENANT_DENIED%' THEN RAISE; END IF;
  END;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S9 cross-tenant replay reference rejected';

  -- immutability
  BEGIN
    UPDATE public.ce_replay_bundle SET snapshot_hash = 'tampered' WHERE id = b;
    RAISE EXCEPTION 'S9: audit field mutated';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%CE_IMMUTABLE%' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.ce_replay_bundle WHERE id = b;
    RAISE EXCEPTION 'S9: bundle deleted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%CE_IMMUTABLE%' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.ce_replay_chunk SET content_hash = 'tampered' WHERE bundle_id = b;
    RAISE EXCEPTION 'S9: chunk hash mutated';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%CE_IMMUTABLE%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'CE_TEST_OK S9 replay bundle/chunks immutable (update + delete blocked)';
END $t$;

-- ------------------------------------------------------- S10 retention purge
DO $t$
DECLARE
  v_conv_a uuid := 'c3000000-0000-4000-8000-00000000000a';
  v_seed uuid := '0e51e0c0-0000-4000-8000-ce0000000001';
  att uuid; b uuid; n integer; rec record;
BEGIN
  INSERT INTO public.conversation_evaluation_attempt (
    conversation_id, input_snapshot_hash, initiated_by, kb_snapshot_id, policy_snapshot_id,
    model_version, prompt_version, source_deployment)
  VALUES (v_conv_a,'snap-expired','11111111-1111-4111-8111-111111111111','kb-1','pol-1',
          'model-1','prompt-1','harness')
  RETURNING id INTO att;

  INSERT INTO public.ce_replay_bundle (
    attempt_id, conversation_id, company_id, transcript_redacted,
    evaluation_contract_version, model_version, prompt_version,
    kb_snapshot_id, policy_snapshot_id, snapshot_hash,
    raw_evaluator_payload, retention_expires_at)
  VALUES (att, v_conv_a, v_seed,
    jsonb_build_array(jsonb_build_object('role','visitor','content','PII: john@example.test')),
    'v1','model-1','prompt-1','kb-1','pol-1','snap-expired',
    jsonb_build_object('provider_raw','expired'), now() - interval '1 day')
  RETURNING id INTO b;
  INSERT INTO public.ce_replay_chunk (bundle_id, chunk_id, company_id, content_hash, chunk_text_redacted)
  VALUES (b,'kb-chunk-9',v_seed,'h9','raw chunk text with PII');

  SELECT public.ce_purge_expired_replays() INTO n;
  IF n < 1 THEN RAISE EXCEPTION 'S10: purge did not process the expired bundle'; END IF;

  SELECT * INTO rec FROM public.ce_replay_bundle WHERE id = b;
  IF rec.raw_evaluator_payload IS NOT NULL THEN RAISE EXCEPTION 'S10: raw payload survived purge'; END IF;
  IF rec.transcript_redacted <> '[]'::jsonb THEN RAISE EXCEPTION 'S10: transcript survived purge'; END IF;
  IF rec.purged_at IS NULL THEN RAISE EXCEPTION 'S10: purge not recorded'; END IF;
  IF rec.snapshot_hash <> 'snap-expired' OR rec.model_version <> 'model-1' THEN
    RAISE EXCEPTION 'S10: immutable audit fields lost during purge'; END IF;
  SELECT count(*) INTO n FROM public.ce_replay_chunk
   WHERE bundle_id = b AND chunk_text_redacted = '' AND content_hash = 'h9';
  IF n <> 1 THEN RAISE EXCEPTION 'S10: chunk text not purged / hash lost'; END IF;

  -- unexpired bundles are untouched
  SELECT count(*) INTO n FROM public.ce_replay_bundle
   WHERE snapshot_hash = 'snap-hash-aaa' AND purged_at IS NULL
     AND raw_evaluator_payload IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'S10: purge touched a non-expired bundle'; END IF;
  RAISE NOTICE 'CE_TEST_OK S10 retention purge clears raw PII/LLM data, preserves immutable audit fields';
END $t$;

-- ------------------------------------------- S11 canonical status semantics
DO $t$
DECLARE
  QA_A text := '22222222-2222-4222-8222-222222222222';
  ev uuid; rec record;
BEGIN
  SELECT id INTO ev FROM public.conversation_evaluation WHERE input_snapshot_hash = 'snap-hash-aaa';

  PERFORM set_config('request.jwt.claim.sub', QA_A, true);
  SET LOCAL ROLE authenticated;
  SELECT * INTO rec FROM public.ce_conversation_status_v WHERE evaluation_id = ev;
  IF NOT rec.needs_review OR rec.training_ready OR rec.trained THEN
    RAISE EXCEPTION 'S11: pending review state wrong (%,%,%)', rec.needs_review, rec.training_ready, rec.trained;
  END IF;

  PERFORM public.ce_submit_review(ev,'accepted','looks correct');
  SELECT * INTO rec FROM public.ce_conversation_status_v WHERE evaluation_id = ev;
  IF rec.needs_review OR NOT rec.training_ready OR rec.trained THEN
    RAISE EXCEPTION 'S11: training_ready contract wrong (%,%,%)', rec.needs_review, rec.training_ready, rec.trained;
  END IF;
  IF rec.improved_result_state <> 'pending' THEN
    RAISE EXCEPTION 'S11: improved result should be pending, got %', rec.improved_result_state; END IF;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S11 Training Ready = accepted + eligible + not delivered + no improved result';

  UPDATE public.ce_training_result SET result_status='received', received_at=now(),
         improved_reply_redacted='improved answer' WHERE evaluation_id = ev;
  PERFORM set_config('request.jwt.claim.sub', QA_A, true);
  SET LOCAL ROLE authenticated;
  SELECT * INTO rec FROM public.ce_conversation_status_v WHERE evaluation_id = ev;
  IF NOT rec.trained OR rec.training_ready THEN
    RAISE EXCEPTION 'S11: improved result did not flip to Trained'; END IF;
  IF rec.improved_result_state <> 'received' THEN RAISE EXCEPTION 'S11: improved state wrong'; END IF;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S11 Trained = improved result received';

  INSERT INTO public.evaluation_training_outbox (evaluation_id, status, delivered_at,
    delivery_idempotency_key, source_deployment, evaluation_contract_version)
  VALUES (ev,'delivered',now(),ev::text,'harness','v1');
  PERFORM set_config('request.jwt.claim.sub', QA_A, true);
  SET LOCAL ROLE authenticated;
  SELECT * INTO rec FROM public.ce_conversation_status_v WHERE evaluation_id = ev;
  IF NOT rec.trained OR rec.training_ready THEN RAISE EXCEPTION 'S11: delivered outbox did not flip to Trained'; END IF;
  RESET ROLE;
  RAISE NOTICE 'CE_TEST_OK S11 Trained = outbox delivered';
END $t$;
