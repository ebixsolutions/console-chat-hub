-- CE Task 2 Edge contract LOCAL TEST HARNESS ONLY.
-- Loaded only into disposable Supabase/PostgreSQL test runtimes by ce-task2-edge-contract.sh.
-- It is intentionally NOT a production migration.

CREATE TABLE IF NOT EXISTS public.ce_test_case_runtime_state (
  case_id text PRIMARY KEY,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION public.ce_test_prepare_case(p_case_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  IF p_case_id !~ '^E-(AUTH|HTTP|BODY|TENANT|GROUND|LLM|RPC)-[0-9]{2}$' THEN
    RAISE EXCEPTION 'unknown CE case %', p_case_id;
  END IF;
  INSERT INTO public.ce_test_case_runtime_state(case_id,snapshot)
  VALUES (p_case_id, jsonb_build_object('attempts_before',
    COALESCE((SELECT count(*) FROM public.conversation_evaluation_attempt),0),
    'evaluations_before',COALESCE((SELECT count(*) FROM public.conversation_evaluation),0),
    'details_before',COALESCE((SELECT count(*) FROM public.conversation_evaluation_detail),0),
    'outbox_before',COALESCE((SELECT count(*) FROM public.evaluation_training_outbox),0)))
  ON CONFLICT(case_id) DO UPDATE SET prepared_at=now(),snapshot=EXCLUDED.snapshot;
  SELECT snapshot INTO v FROM public.ce_test_case_runtime_state WHERE case_id=p_case_id;
  RETURN jsonb_build_object('prepared',true,'case_id',p_case_id,'snapshot',v);
END $$;

CREATE OR REPLACE FUNCTION public.ce_test_case_request(p_case_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
BEGIN
  -- Request bodies that do not require tenant/user fixture IDs are declared here.
  -- Tenant/RPC/GROUND cases use the deterministic runtime fixture IDs injected by
  -- the Python runner through CE_TEST_* environment variables and request overrides.
  CASE p_case_id
    WHEN 'E-AUTH-01' THEN RETURN jsonb_build_object('method','POST','auth','none','body','{}');
    WHEN 'E-AUTH-02' THEN RETURN jsonb_build_object('method','POST','auth','basic','body','{}');
    WHEN 'E-AUTH-03' THEN RETURN jsonb_build_object('method','POST','auth','invalid','body','{"action":"evaluate","conversation_id":"00000000-0000-0000-0000-000000000001"}');
    WHEN 'E-AUTH-04' THEN RETURN jsonb_build_object('method','POST','auth','expired','body','{"action":"evaluate","conversation_id":"00000000-0000-0000-0000-000000000001"}');
    WHEN 'E-HTTP-01' THEN RETURN jsonb_build_object('method','OPTIONS','auth','none','origin','https://console-chat-hub.lovable.app');
    WHEN 'E-HTTP-02' THEN RETURN jsonb_build_object('method','OPTIONS','auth','none','origin',NULL);
    WHEN 'E-HTTP-03' THEN RETURN jsonb_build_object('method','GET','auth','none');
    WHEN 'E-HTTP-05' THEN RETURN jsonb_build_object('method','POST','auth','none','origin','https://evil.invalid','body','{}');
    WHEN 'E-BODY-01' THEN RETURN jsonb_build_object('method','POST','auth','A','body','not-json');
    WHEN 'E-BODY-02' THEN RETURN jsonb_build_object('method','POST','auth','A','body','null');
    WHEN 'E-BODY-03' THEN RETURN jsonb_build_object('method','POST','auth','A','body','[1,2]');
    WHEN 'E-BODY-04' THEN RETURN jsonb_build_object('method','POST','auth','A','body','42');
    WHEN 'E-BODY-05' THEN RETURN jsonb_build_object('method','POST','auth','A','body','{"action":"evaluate"}');
    WHEN 'E-BODY-06' THEN RETURN jsonb_build_object('method','POST','auth','A','body','{"action":"evaluate","conversation_id":"xxx"}');
    WHEN 'E-BODY-07' THEN RETURN jsonb_build_object('method','POST','auth','A','body','{"action":"evaluate","conversation_id":"00000000-0000-0000-0000-000000000001","extra":"x"}');
    WHEN 'E-BODY-08' THEN RETURN jsonb_build_object('method','POST','auth','A','body',jsonb_build_object('oversized',true));
    ELSE RETURN jsonb_build_object('method','POST','auth','A','body',jsonb_build_object('case_id',p_case_id));
  END CASE;
END $$;

CREATE OR REPLACE FUNCTION public.ce_test_assert_case(p_case_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE s jsonb; a0 bigint; e0 bigint; d0 bigint; o0 bigint; a1 bigint; e1 bigint; d1 bigint; o1 bigint;
BEGIN
  SELECT snapshot INTO s FROM public.ce_test_case_runtime_state WHERE case_id=p_case_id;
  IF s IS NULL THEN RETURN jsonb_build_object('pass',false,'reason','missing_setup_snapshot'); END IF;
  a0 := COALESCE((s->>'attempts_before')::bigint,0); e0 := COALESCE((s->>'evaluations_before')::bigint,0);
  d0 := COALESCE((s->>'details_before')::bigint,0); o0 := COALESCE((s->>'outbox_before')::bigint,0);
  SELECT count(*) INTO a1 FROM public.conversation_evaluation_attempt;
  SELECT count(*) INTO e1 FROM public.conversation_evaluation;
  SELECT count(*) INTO d1 FROM public.conversation_evaluation_detail;
  SELECT count(*) INTO o1 FROM public.evaluation_training_outbox;
  -- Failure-path contract: canonical tables may not acquire orphan rows.
  IF p_case_id IN ('E-LLM-01','E-LLM-02','E-LLM-03','E-LLM-04','E-LLM-05','E-LLM-06','E-LLM-07','E-LLM-08','E-LLM-09','E-RPC-04','E-RPC-05','E-RPC-09') THEN
    RETURN jsonb_build_object('pass', e1=e0 AND d1=d0 AND o1=o0,
      'before',jsonb_build_array(a0,e0,d0,o0),'after',jsonb_build_array(a1,e1,d1,o1));
  END IF;
  RETURN jsonb_build_object('pass',true,'before',jsonb_build_array(a0,e0,d0,o0),'after',jsonb_build_array(a1,e1,d1,o1));
END $$;

CREATE OR REPLACE FUNCTION public.ce_test_cleanup_case(p_case_id text)
RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.ce_test_case_runtime_state WHERE case_id=p_case_id;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.ce_test_fixture_leaks(p_case_id text)
RETURNS integer LANGUAGE sql AS $$
  SELECT count(*)::integer FROM public.ce_test_case_runtime_state WHERE case_id=p_case_id
$$;
