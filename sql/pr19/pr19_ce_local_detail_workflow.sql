BEGIN;
SET LOCAL lock_timeout='10s';

CREATE TABLE IF NOT EXISTS public.ce_local_qa_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES public.ce_local_evaluation(id) ON DELETE CASCADE,
  case_number text NOT NULL,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description text,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
  priority text NOT NULL DEFAULT 'medium' CHECK(priority IN ('urgent','high','medium','low')),
  created_by uuid NOT NULL,
  remote_sync_state text NOT NULL DEFAULT 'local_only',
  remote_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(evaluation_id,case_number),
  UNIQUE(evaluation_id,title)
);

CREATE TABLE IF NOT EXISTS public.ce_local_root_cause (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evaluation_id uuid NOT NULL REFERENCES public.ce_local_evaluation(id) ON DELETE CASCADE,
  category text NOT NULL CHECK(category IN (
    'kb_gap','kb_stale','policy_gap','prompt_defect','model_limitation',
    'routing_error','human_error','unknown'
  )),
  summary text NOT NULL CHECK(length(summary) BETWEEN 1 AND 2000),
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  recorded_by uuid NOT NULL,
  remote_sync_state text NOT NULL DEFAULT 'local_only',
  remote_ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ce_local_qa_case ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ce_local_root_cause ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ce_local_qa_case_staff_read ON public.ce_local_qa_case;
CREATE POLICY ce_local_qa_case_staff_read ON public.ce_local_qa_case
FOR SELECT TO authenticated
USING (public.is_staff(auth.uid()));

DROP POLICY IF EXISTS ce_local_root_cause_staff_read ON public.ce_local_root_cause;
CREATE POLICY ce_local_root_cause_staff_read ON public.ce_local_root_cause
FOR SELECT TO authenticated
USING (public.is_staff(auth.uid()));

GRANT SELECT ON public.ce_local_qa_case TO authenticated;
GRANT SELECT ON public.ce_local_root_cause TO authenticated;
GRANT ALL ON public.ce_local_qa_case TO service_role;
GRANT ALL ON public.ce_local_root_cause TO service_role;

CREATE OR REPLACE FUNCTION public.ce_local_actor_can_review(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=''
AS $$
  SELECT EXISTS(
    SELECT 1 FROM public.user_roles r
    WHERE r.user_id=p_user_id
      AND r.role::text IN ('admin','supervisor')
  )
$$;

CREATE OR REPLACE FUNCTION public.ce_create_local_qa_case_v1(
  p_evaluation_id uuid,
  p_expected_conversation_id uuid,
  p_title text,
  p_description text DEFAULT NULL,
  p_priority text DEFAULT 'medium'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid:=auth.uid();
  v_case text;
  v_id uuid;
  v_existing uuid;
  v_seq integer;
BEGIN
  IF v_uid IS NULL OR NOT public.ce_local_actor_can_review(v_uid) THEN
    RETURN jsonb_build_object('result','forbidden');
  END IF;
  IF p_priority NOT IN ('urgent','high','medium','low') THEN
    RETURN jsonb_build_object('result','invalid_priority');
  END IF;
  IF nullif(trim(coalesce(p_title,'')),'') IS NULL THEN
    RETURN jsonb_build_object('result','invalid_title');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.ce_local_evaluation
    WHERE id=p_evaluation_id AND conversation_id=p_expected_conversation_id
  ) THEN
    RETURN jsonb_build_object('result','not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('ce-local-qa:'||p_evaluation_id::text,0));

  SELECT id INTO v_existing
  FROM public.ce_local_qa_case
  WHERE evaluation_id=p_evaluation_id AND lower(title)=lower(trim(p_title))
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('result','already_exists','qa_case_id',v_existing);
  END IF;

  SELECT count(*)+1 INTO v_seq
  FROM public.ce_local_qa_case
  WHERE evaluation_id=p_evaluation_id;
  v_case:='LQA-'||substr(replace(p_evaluation_id::text,'-',''),1,8)||'-'||lpad(v_seq::text,3,'0');

  INSERT INTO public.ce_local_qa_case(
    evaluation_id,case_number,title,description,priority,created_by
  ) VALUES(
    p_evaluation_id,v_case,left(trim(p_title),200),
    nullif(left(trim(coalesce(p_description,'')),2000),''),
    p_priority,v_uid
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('result','success','qa_case_id',v_id,'case_number',v_case);
END
$$;

CREATE OR REPLACE FUNCTION public.ce_record_local_root_cause_v1(
  p_evaluation_id uuid,
  p_expected_conversation_id uuid,
  p_category text,
  p_summary text,
  p_evidence jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_uid uuid:=auth.uid();
  v_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.ce_local_actor_can_review(v_uid) THEN
    RETURN jsonb_build_object('result','forbidden');
  END IF;
  IF p_category NOT IN (
    'kb_gap','kb_stale','policy_gap','prompt_defect','model_limitation',
    'routing_error','human_error','unknown'
  ) THEN
    RETURN jsonb_build_object('result','invalid_category');
  END IF;
  IF nullif(trim(coalesce(p_summary,'')),'') IS NULL THEN
    RETURN jsonb_build_object('result','invalid_summary');
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM public.ce_local_evaluation
    WHERE id=p_evaluation_id AND conversation_id=p_expected_conversation_id
  ) THEN
    RETURN jsonb_build_object('result','not_found');
  END IF;
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence)<>'array' THEN
    RETURN jsonb_build_object('result','invalid_evidence');
  END IF;

  INSERT INTO public.ce_local_root_cause(
    evaluation_id,category,summary,evidence_refs,recorded_by
  ) VALUES(
    p_evaluation_id,p_category,left(trim(p_summary),2000),p_evidence,v_uid
  ) RETURNING id INTO v_id;

  RETURN jsonb_build_object('result','success','root_cause_id',v_id);
END
$$;

REVOKE ALL ON FUNCTION public.ce_local_actor_can_review(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ce_local_actor_can_review(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.ce_create_local_qa_case_v1(uuid,uuid,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ce_create_local_qa_case_v1(uuid,uuid,text,text,text)
TO authenticated,service_role;

REVOKE ALL ON FUNCTION public.ce_record_local_root_cause_v1(uuid,uuid,text,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ce_record_local_root_cause_v1(uuid,uuid,text,text,jsonb)
TO authenticated,service_role;

COMMIT;
