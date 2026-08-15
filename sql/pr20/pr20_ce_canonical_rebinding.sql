BEGIN;
SET LOCAL lock_timeout='10s';

ALTER TABLE public.ce_local_evaluation_attempt
  ADD COLUMN IF NOT EXISTS company_id uuid,
  ADD COLUMN IF NOT EXISTS rebound_run_id uuid,
  ADD COLUMN IF NOT EXISTS rebound_at timestamptz;

ALTER TABLE public.ce_local_evaluation
  ADD COLUMN IF NOT EXISTS canonical_evaluation_id uuid,
  ADD COLUMN IF NOT EXISTS rebound_run_id uuid,
  ADD COLUMN IF NOT EXISTS rebound_at timestamptz;

ALTER TABLE public.ce_local_bundle_snapshot
  ADD COLUMN IF NOT EXISTS rebound_run_id uuid,
  ADD COLUMN IF NOT EXISTS rebound_at timestamptz;

CREATE TABLE IF NOT EXISTS public.ce_local_canonical_map (
  local_evaluation_id uuid PRIMARY KEY
    REFERENCES public.ce_local_evaluation(id) ON DELETE RESTRICT,
  canonical_evaluation_id uuid NOT NULL UNIQUE
    REFERENCES public.conversation_evaluation(id) ON DELETE RESTRICT,
  company_id uuid NOT NULL REFERENCES public.company(id) ON DELETE RESTRICT,
  rebind_run_id uuid NOT NULL,
  rebound_by uuid NOT NULL,
  rebound_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ce_local_canonical_map ENABLE ROW LEVEL SECURITY;

-- After canonical activation, historical local CE data becomes company scoped.
DROP POLICY IF EXISTS ce_local_evaluation_attempt_staff_read ON public.ce_local_evaluation_attempt;
DROP POLICY IF EXISTS ce_local_evaluation_staff_read ON public.ce_local_evaluation;
DROP POLICY IF EXISTS ce_local_evaluation_detail_staff_read ON public.ce_local_evaluation_detail;
DROP POLICY IF EXISTS ce_local_bundle_snapshot_staff_read ON public.ce_local_bundle_snapshot;
DROP POLICY IF EXISTS ce_local_emotion_point_staff_read ON public.ce_local_emotion_point;
DROP POLICY IF EXISTS ce_local_next_step_staff_read ON public.ce_local_next_step;
DROP POLICY IF EXISTS ce_local_discrepancy_staff_read ON public.ce_local_discrepancy;
DROP POLICY IF EXISTS ce_local_qa_case_staff_read ON public.ce_local_qa_case;
DROP POLICY IF EXISTS ce_local_root_cause_staff_read ON public.ce_local_root_cause;
DROP POLICY IF EXISTS ce_local_canonical_map_tenant_read ON public.ce_local_canonical_map;

CREATE POLICY ce_local_evaluation_tenant_read
ON public.ce_local_evaluation
FOR SELECT TO authenticated
USING (
  company_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.company_membership cm
    WHERE cm.company_id=ce_local_evaluation.company_id
      AND cm.user_id=auth.uid()
      AND cm.is_active
  )
);

CREATE POLICY ce_local_evaluation_attempt_tenant_read
ON public.ce_local_evaluation_attempt
FOR SELECT TO authenticated
USING (
  company_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.company_membership cm
    WHERE cm.company_id=ce_local_evaluation_attempt.company_id
      AND cm.user_id=auth.uid()
      AND cm.is_active
  )
);

CREATE POLICY ce_local_bundle_snapshot_tenant_read
ON public.ce_local_bundle_snapshot
FOR SELECT TO authenticated
USING (
  company_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.company_membership cm
    WHERE cm.company_id=ce_local_bundle_snapshot.company_id
      AND cm.user_id=auth.uid()
      AND cm.is_active
  )
);

CREATE POLICY ce_local_evaluation_detail_tenant_read
ON public.ce_local_evaluation_detail
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.ce_local_evaluation e
    JOIN public.company_membership cm
      ON cm.company_id=e.company_id
     AND cm.user_id=auth.uid()
     AND cm.is_active
    WHERE e.id=ce_local_evaluation_detail.evaluation_id
  )
);

CREATE POLICY ce_local_emotion_point_tenant_read
ON public.ce_local_emotion_point
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.ce_local_evaluation e
    JOIN public.company_membership cm
      ON cm.company_id=e.company_id
     AND cm.user_id=auth.uid()
     AND cm.is_active
    WHERE e.id=ce_local_emotion_point.evaluation_id
  )
);

CREATE POLICY ce_local_next_step_tenant_read
ON public.ce_local_next_step
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.ce_local_evaluation e
    JOIN public.company_membership cm
      ON cm.company_id=e.company_id
     AND cm.user_id=auth.uid()
     AND cm.is_active
    WHERE e.id=ce_local_next_step.evaluation_id
  )
);

CREATE POLICY ce_local_discrepancy_tenant_read
ON public.ce_local_discrepancy
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.ce_local_evaluation e
    JOIN public.company_membership cm
      ON cm.company_id=e.company_id
     AND cm.user_id=auth.uid()
     AND cm.is_active
    WHERE e.id=ce_local_discrepancy.evaluation_id
  )
);

CREATE POLICY ce_local_qa_case_tenant_read
ON public.ce_local_qa_case
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.ce_local_evaluation e
    JOIN public.company_membership cm
      ON cm.company_id=e.company_id
     AND cm.user_id=auth.uid()
     AND cm.is_active
    WHERE e.id=ce_local_qa_case.evaluation_id
  )
);

CREATE POLICY ce_local_root_cause_tenant_read
ON public.ce_local_root_cause
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.ce_local_evaluation e
    JOIN public.company_membership cm
      ON cm.company_id=e.company_id
     AND cm.user_id=auth.uid()
     AND cm.is_active
    WHERE e.id=ce_local_root_cause.evaluation_id
  )
);

CREATE POLICY ce_local_canonical_map_tenant_read
ON public.ce_local_canonical_map
FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.company_membership cm
    WHERE cm.company_id=ce_local_canonical_map.company_id
      AND cm.user_id=auth.uid()
      AND cm.is_active
  )
);

GRANT SELECT ON public.ce_local_canonical_map TO authenticated;
GRANT ALL ON public.ce_local_canonical_map TO service_role;

-- Once canonical activation completes, all user mutations must use canonical
-- evaluation IDs. Historical local records are read-only.
REVOKE EXECUTE ON FUNCTION public.review_local_evaluation_v1(uuid,uuid,text,text)
FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.ce_create_local_qa_case_v1(uuid,uuid,text,text,text)
FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.ce_record_local_root_cause_v1(uuid,uuid,text,text,jsonb)
FROM authenticated;

CREATE OR REPLACE FUNCTION public.rebind_local_evaluations_v1(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_rebind_run_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  le public.ce_local_evaluation;
  a public.ce_local_evaluation_attempt;
  s public.ce_local_bundle_snapshot;
  v_init jsonb;
  v_done jsonb;
  v_attempt_id uuid;
  v_canonical_id uuid;
  v_details jsonb;
  v_scores jsonb;
  v_snapshot jsonb;
  v_derived jsonb;
  v_count integer:=0;
  v_existing integer:=0;
BEGIN
  IF p_company_id IS NULL OR p_actor_user_id IS NULL OR p_rebind_run_id IS NULL THEN
    RETURN jsonb_build_object('result','invalid_parameter');
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.company
    WHERE id=p_company_id AND is_active
  ) THEN
    RETURN jsonb_build_object('result','company_inactive');
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.company_membership
    WHERE company_id=p_company_id
      AND user_id=p_actor_user_id
      AND is_active
      AND role::text IN ('admin','supervisor','qa')
  ) THEN
    RETURN jsonb_build_object('result','actor_not_authorized');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ce-rebind:'||p_company_id::text,0));

  -- Every local evaluation must now resolve to the canonical company through
  -- the already-frozen conversation/channel lineage.
  IF EXISTS(
    SELECT 1
    FROM public.ce_local_evaluation l
    WHERE public.pr7_ce_canonical_company(l.conversation_id) <> p_company_id
  ) THEN
    RETURN jsonb_build_object('result','conversation_company_mismatch');
  END IF;

  UPDATE public.ce_local_evaluation_attempt la
  SET company_id=p_company_id,
      rebound_run_id=p_rebind_run_id,
      rebound_at=now()
  WHERE EXISTS(
    SELECT 1 FROM public.ce_local_evaluation l
    WHERE l.attempt_id=la.id
  )
    AND (la.company_id IS NULL OR la.company_id=p_company_id);

  UPDATE public.ce_local_evaluation l
  SET company_id=p_company_id,
      rebound_run_id=p_rebind_run_id,
      rebound_at=now()
  WHERE l.company_id IS NULL OR l.company_id=p_company_id;

  UPDATE public.ce_local_bundle_snapshot s0
  SET company_id=p_company_id,
      rebound_run_id=p_rebind_run_id,
      rebound_at=now()
  WHERE s0.company_id IS NULL OR s0.company_id=p_company_id;

  FOR le IN
    SELECT *
    FROM public.ce_local_evaluation
    ORDER BY created_at,id
    FOR UPDATE
  LOOP
    IF le.canonical_evaluation_id IS NOT NULL THEN
      INSERT INTO public.ce_local_canonical_map(
        local_evaluation_id,canonical_evaluation_id,company_id,rebind_run_id,rebound_by,rebound_at
      )
      VALUES(
        le.id,le.canonical_evaluation_id,p_company_id,p_rebind_run_id,p_actor_user_id,coalesce(le.rebound_at,now())
      )
      ON CONFLICT(local_evaluation_id) DO NOTHING;
      v_existing:=v_existing+1;
      CONTINUE;
    END IF;

    SELECT * INTO a
    FROM public.ce_local_evaluation_attempt
    WHERE id=le.attempt_id;

    SELECT * INTO s
    FROM public.ce_local_bundle_snapshot
    WHERE attempt_id=le.attempt_id;

    IF a.id IS NULL OR s.id IS NULL THEN
      RAISE EXCEPTION 'PR20_LOCAL_EVALUATION_INCOMPLETE:%',le.id;
    END IF;

    SELECT jsonb_object_agg(
      d.evaluator_type,
      jsonb_build_object(
        'evaluator_type',d.evaluator_type,
        'raw_score',d.raw_score,
        'weight',d.weight,
        'weighted_score',d.weighted_score,
        'justification',d.justification,
        'recommended_correction',d.recommended_correction,
        'model_version',d.evaluator_model_version,
        'prompt_version',d.evaluator_prompt_version,
        'grounding_refs',d.grounding_refs,
        'raw_llm_response',jsonb_build_object('migration','conversation_local_rebind')
      )
    )
    INTO v_details
    FROM public.ce_local_evaluation_detail d
    WHERE d.evaluation_id=le.id;

    IF v_details IS NULL THEN
      RAISE EXCEPTION 'PR20_LOCAL_DETAILS_MISSING:%',le.id;
    END IF;

    v_scores:=jsonb_build_object(
      'accuracy',le.accuracy_score,
      'policy',le.policy_score,
      'tone',le.tone_score,
      'sales',le.sales_score,
      'context',le.context_score,
      'hallucination_risk',le.hallucination_risk_score
    );

    v_snapshot:=jsonb_build_object(
      'transcript_hash',s.transcript_hash,
      'canonical_input',s.canonical_input,
      'normalized_transcript',s.normalized_transcript,
      'evaluated_ai_reply',s.evaluated_ai_reply,
      'verified_human_response',s.verified_human_response,
      'grounding_evidence',s.grounding_evidence,
      'truncation_manifest',s.truncation_manifest
    );

    v_derived:=jsonb_build_object(
      'emotion',coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'message_id',e.message_id,
          'turn_index',e.turn_index,
          'occurred_at',e.occurred_at,
          'sentiment',e.sentiment,
          'sentiment_score',e.sentiment_score,
          'trigger_label',e.trigger_label
        ) ORDER BY e.turn_index)
        FROM public.ce_local_emotion_point e
        WHERE e.evaluation_id=le.id
      ),'[]'::jsonb),
      'next_steps',coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'ordinal',n.ordinal,
          'title',n.title,
          'detail',n.detail,
          'owner_role',n.owner_role
        ) ORDER BY n.ordinal)
        FROM public.ce_local_next_step n
        WHERE n.evaluation_id=le.id
      ),'[]'::jsonb),
      'discrepancies',coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'dimension',x.dimension,
          'ai_claim',x.ai_claim,
          'human_claim',x.human_claim,
          'grounded_claim',x.grounded_claim,
          'divergence_kind',x.divergence_kind,
          'severity',x.severity,
          'grounding_refs',x.grounding_refs
        ))
        FROM public.ce_local_discrepancy x
        WHERE x.evaluation_id=le.id
      ),'[]'::jsonb)
    );

    SELECT public.initiate_evaluation_v2(
      le.conversation_id,
      le.evaluation_contract_version,
      le.kb_snapshot_id,
      le.policy_snapshot_id,
      le.model_version,
      le.prompt_version,
      le.input_snapshot_hash,
      le.bundle_hash,
      le.grounding_manifest,
      p_actor_user_id,
      le.source_deployment
    ) INTO v_init;

    IF v_init->>'result'='already_evaluated' THEN
      v_canonical_id:=(v_init->>'evaluation_id')::uuid;
    ELSIF v_init->>'result'='initiated' THEN
      v_attempt_id:=(v_init->>'attempt_id')::uuid;

      SELECT public.complete_evaluation_v2(
        v_attempt_id,
        v_scores,
        v_details,
        le.bundle_hash,
        v_snapshot,
        v_derived
      ) INTO v_done;

      IF coalesce(v_done->>'result','') <> 'success' THEN
        RAISE EXCEPTION 'PR20_CANONICAL_COMPLETE_FAILED:%:%',le.id,coalesce(v_done->>'result','unknown');
      END IF;

      v_canonical_id:=(v_done->>'evaluation_id')::uuid;
      IF v_canonical_id IS NULL THEN
        SELECT id INTO v_canonical_id
        FROM public.conversation_evaluation
        WHERE attempt_id=v_attempt_id;
      END IF;
    ELSE
      RAISE EXCEPTION 'PR20_CANONICAL_INIT_FAILED:%:%',le.id,coalesce(v_init->>'result','unknown');
    END IF;

    IF v_canonical_id IS NULL THEN
      RAISE EXCEPTION 'PR20_CANONICAL_ID_MISSING:%',le.id;
    END IF;

    UPDATE public.conversation_evaluation
    SET review_status=le.review_status,
        review_note=le.review_note,
        reviewed_by=le.reviewed_by,
        reviewed_at=le.reviewed_at
    WHERE id=v_canonical_id
      AND conversation_id=le.conversation_id
      AND company_id=p_company_id;

    INSERT INTO public.ce_local_canonical_map(
      local_evaluation_id,canonical_evaluation_id,company_id,rebind_run_id,rebound_by
    )
    VALUES(le.id,v_canonical_id,p_company_id,p_rebind_run_id,p_actor_user_id);

    UPDATE public.ce_local_evaluation
    SET canonical_evaluation_id=v_canonical_id,
        company_id=p_company_id,
        rebound_run_id=p_rebind_run_id,
        rebound_at=now()
    WHERE id=le.id;

    UPDATE public.ce_local_qa_case
    SET remote_sync_state='canonical_mapped'
    WHERE evaluation_id=le.id;

    UPDATE public.ce_local_root_cause
    SET remote_sync_state='canonical_mapped'
    WHERE evaluation_id=le.id;

    v_count:=v_count+1;
  END LOOP;

  IF EXISTS(
    SELECT 1 FROM public.ce_local_evaluation
    WHERE company_id IS DISTINCT FROM p_company_id
       OR canonical_evaluation_id IS NULL
  ) THEN
    RAISE EXCEPTION 'PR20_REBIND_INCOMPLETE';
  END IF;

  IF EXISTS(
    SELECT 1
    FROM public.ce_local_canonical_map m
    JOIN public.conversation_evaluation e ON e.id=m.canonical_evaluation_id
    WHERE m.company_id<>p_company_id
       OR e.company_id<>p_company_id
  ) THEN
    RAISE EXCEPTION 'PR20_CANONICAL_LINEAGE_MISMATCH';
  END IF;

  RETURN jsonb_build_object(
    'result','success',
    'migrated',v_count,
    'already_mapped',v_existing
  );
END
$$;

ALTER FUNCTION public.rebind_local_evaluations_v1(uuid,uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.rebind_local_evaluations_v1(uuid,uuid,uuid)
FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rebind_local_evaluations_v1(uuid,uuid,uuid)
TO service_role;

COMMIT;
