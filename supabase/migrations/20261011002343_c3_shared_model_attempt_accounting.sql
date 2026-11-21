-- Source-only C3 migration. One shared counter; no historic usage rewrite.
BEGIN;
CREATE SCHEMA IF NOT EXISTS c3_model_accounting;
REVOKE ALL ON SCHEMA c3_model_accounting FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE c3_model_accounting.run (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES public.company(id),
 label text NOT NULL UNIQUE, ceiling integer NOT NULL CHECK(ceiling BETWEEN 1 AND 3520),
 reserved integer NOT NULL DEFAULT 0 CHECK(reserved BETWEEN 0 AND ceiling),
 state text NOT NULL DEFAULT 'paused' CHECK(state IN ('paused','active','closed')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,company_id)
);
CREATE UNIQUE INDEX c3_one_open_model_run ON c3_model_accounting.run(company_id) WHERE state <> 'closed';
CREATE TABLE c3_model_accounting.attempt (
 run_id uuid NOT NULL, company_id uuid NOT NULL, identity text NOT NULL CHECK(length(identity) BETWEEN 1 AND 256),
 conversation_id uuid REFERENCES public.conversations(id), operation_id text NOT NULL,
 provider text NOT NULL, purpose text NOT NULL, request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','response','unknown')),
 reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(), finalized_at timestamptz,
 http_status integer CHECK(http_status BETWEEN 0 AND 599),
 PRIMARY KEY(run_id,identity), FOREIGN KEY(run_id,company_id) REFERENCES c3_model_accounting.run(id,company_id)
);
ALTER TABLE c3_model_accounting.run ENABLE ROW LEVEL SECURITY;
ALTER TABLE c3_model_accounting.attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA c3_model_accounting FROM PUBLIC,anon,authenticated,service_role;
-- Only postgres may provision/activate a run. The service cannot raise/reset its cap.
CREATE FUNCTION public.c3_reserve_model_attempt(p_company_id uuid,p_conversation_id uuid,
 p_identity text,p_operation_id text,p_provider text,p_purpose text,p_request_sha256 text,p_run_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r c3_model_accounting.run%ROWTYPE; a c3_model_accounting.attempt%ROWTYPE;
BEGIN
 IF current_setting('role',true) <> 'service_role' THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_CALLER_DENIED' USING ERRCODE='42501'; END IF;
 IF p_company_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.company WHERE id=p_company_id) OR (p_conversation_id IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM public.conversations WHERE id=p_conversation_id AND company_id=p_company_id))
 THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_TENANT_DENIED' USING ERRCODE='42501'; END IF;
 IF p_identity IS NULL OR length(p_identity) NOT BETWEEN 1 AND 256 OR
 p_operation_id IS NULL OR length(p_operation_id) NOT BETWEEN 1 AND 256 OR
 p_provider IS NULL OR length(p_provider) NOT BETWEEN 1 AND 120 OR
 p_purpose IS NULL OR length(p_purpose) NOT BETWEEN 1 AND 120 OR
 p_request_sha256 IS NULL OR p_request_sha256 !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_INVALID_INPUT'; END IF;
 SELECT * INTO r FROM c3_model_accounting.run WHERE company_id=p_company_id AND state<>'closed' FOR UPDATE;
 -- Companies outside the explicitly provisioned validation scope retain existing routing.
 -- This is a scope result, never an error fallback; scoped failures always deny.
 IF NOT FOUND THEN
   IF p_company_id='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'::uuid OR p_run_id IS NOT NULL OR EXISTS(SELECT 1 FROM c3_model_accounting.run WHERE company_id=p_company_id) THEN
     RAISE EXCEPTION 'MODEL_ACCOUNTING_RUN_MISSING';
   END IF;
   RETURN jsonb_build_object('scoped',false,'dispatch',true);
 END IF;
 IF p_run_id IS NOT NULL AND p_run_id<>r.id THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_RUN_DENIED' USING ERRCODE='42501'; END IF;
 SELECT * INTO a FROM c3_model_accounting.attempt WHERE run_id=r.id AND identity=p_identity;
 IF FOUND THEN
   IF a.company_id<>p_company_id OR a.conversation_id IS DISTINCT FROM p_conversation_id OR
      a.operation_id<>p_operation_id OR a.provider<>p_provider OR a.purpose<>p_purpose OR a.request_sha256<>p_request_sha256
   THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_IDENTITY_CONFLICT'; END IF;
   RETURN jsonb_build_object('scoped',true,'dispatch',false,'run_id',r.id,'state',a.state,'reserved',r.reserved,'ceiling',r.ceiling);
 END IF;
 IF r.state<>'active' THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_RUN_INACTIVE'; END IF;
 IF r.reserved>=r.ceiling THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_LIMIT_REACHED'; END IF;
 INSERT INTO c3_model_accounting.attempt(run_id,company_id,identity,conversation_id,operation_id,provider,purpose,request_sha256)
 VALUES(r.id,p_company_id,p_identity,p_conversation_id,p_operation_id,p_provider,p_purpose,p_request_sha256);
 UPDATE c3_model_accounting.run SET reserved=reserved+1 WHERE id=r.id;
 RETURN jsonb_build_object('scoped',true,'dispatch',true,'run_id',r.id,'state','reserved','reserved',r.reserved+1,'ceiling',r.ceiling);
END $$;
CREATE FUNCTION public.c3_finalize_model_attempt(p_company_id uuid,p_run_id uuid,p_identity text,p_state text,p_http_status integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a c3_model_accounting.attempt%ROWTYPE;
BEGIN
 IF current_setting('role',true)<>'service_role' THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_CALLER_DENIED' USING ERRCODE='42501'; END IF;
 IF p_state IS NULL OR p_state NOT IN ('response','unknown') OR p_http_status IS NULL OR p_http_status NOT BETWEEN 0 AND 599
 THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_INVALID_FINALIZATION'; END IF;
 SELECT * INTO a FROM c3_model_accounting.attempt WHERE run_id=p_run_id AND identity=p_identity FOR UPDATE;
 IF NOT FOUND OR a.company_id<>p_company_id THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_TENANT_RUN_DENIED' USING ERRCODE='42501'; END IF;
 IF a.state<>'reserved' THEN
   IF a.state<>p_state OR a.http_status IS DISTINCT FROM p_http_status THEN RAISE EXCEPTION 'MODEL_ACCOUNTING_FINALIZATION_CONFLICT'; END IF;
   RETURN jsonb_build_object('state',a.state,'idempotent',true);
 END IF;
 UPDATE c3_model_accounting.attempt SET state=p_state,http_status=p_http_status,finalized_at=clock_timestamp()
 WHERE run_id=p_run_id AND identity=p_identity;
 -- Reserved counter is NEVER decremented, including crashes, unknown outcomes and timeouts.
 RETURN jsonb_build_object('state',p_state,'idempotent',false);
END $$;
REVOKE ALL ON FUNCTION public.c3_reserve_model_attempt(uuid,uuid,text,text,text,text,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.c3_finalize_model_attempt(uuid,uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.c3_reserve_model_attempt(uuid,uuid,text,text,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.c3_finalize_model_attempt(uuid,uuid,text,text,integer) TO service_role;
INSERT INTO c3_model_accounting.run(id,company_id,label,ceiling,state) VALUES
 ('a0a8c36e-42b5-4d9f-bbee-095ddc731520','4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec','C3-df1ca5f-successor-Section15-Quality95-future-only',3520,'paused');
COMMIT;
