#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MIG="supabase/migrations/20260905143000_hf3_quality_learning_workload_closure.sql"
WORKER="supabase/functions/hf3-training-outbox-worker/index.ts"
RECEIVER="supabase/functions/hf3-training-result-receiver/index.ts"
FILES=("$MIG" "$WORKER" "$RECEIVER" "scripts/hf3-source-final-gate.sh")

for f in "${FILES[@]}"; do
  test -s "$f" || { echo "HF3_FILE_EMPTY=$f"; exit 1; }
done
echo "HF3_FILES_NONEMPTY=PASS"

python3 - <<'PY'
from pathlib import Path
m=Path('supabase/migrations/20260905143000_hf3_quality_learning_workload_closure.sql').read_text()
w=Path('supabase/functions/hf3-training-outbox-worker/index.ts').read_text()
r=Path('supabase/functions/hf3-training-result-receiver/index.ts').read_text()
required_m=[
 'hf3_learning_case','hf3_workload_snapshot','hf3_closed_loop_proof',
 'hf3_refresh_learning_case_tx','hf3_claim_training_outbox_tx','hf3_finish_training_outbox_tx',
 'hf3_capture_workload_snapshot_tx','hf3_compare_workload_snapshots_tx','hf3_record_closed_loop_proof_tx',
 "h.escalation_rule IN ('E1','E2','R1','S0')", "h.escalation_rule = 'R2'",
 "e.review_status = 'accepted'", 'e.has_verified_human_response',
 'hf3_not_approved_learning_candidate', 'extensions.digest',
 'REVOKE ALL ON public.hf3_learning_case FROM PUBLIC, anon, authenticated',
]
for x in required_m:
    assert x in m, x
assert 'UPDATE public.conversations' not in m
assert 'INSERT INTO public.handoff_event' not in m
assert 'UPDATE public.handoff_event' not in m
assert 'UPDATE public.feedback_request' not in m
assert '/api/entities/KBDocument' not in m
for x in ['getSupabaseAdminKey','hf3_claim_training_outbox_tx','hf3_finish_training_outbox_tx',
          'review_status !== "accepted"','training_candidate !== true','post_hoc_only: true']:
    assert x in w, x
for x in ['getSupabaseAdminKey','record_coachai_training_result_tx','hf3_learning_case',
          'training_candidate !== true','review_status !== "accepted"','hf3_refresh_learning_case_tx']:
    assert x in r, x
assert 'SUPABASE_SERVICE_ROLE_KEY' not in w
assert 'SUPABASE_SERVICE_ROLE_KEY' not in r
print('HF3_SOURCE_ASSERTIONS=PASS')
PY

CID="hf3-gate-$RANDOM-$RANDOM"
cleanup(){ docker rm -f "$CID" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$CID" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=hf3 -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
PORT="$(docker port "$CID" 5432/tcp | awk -F: '{print $NF}')"
export PGPASSWORD=postgres
for _ in $(seq 1 90); do
  if psql -h 127.0.0.1 -p "$PORT" -U postgres -d hf3 -Atqc 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
psql -h 127.0.0.1 -p "$PORT" -U postgres -d hf3 -Atqc 'select 1' >/dev/null
echo "HF3_DISPOSABLE_DB_READY=PASS"

psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres -d hf3 <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
SET search_path TO public,extensions;

CREATE TABLE public.conversations(
 id uuid PRIMARY KEY, company_id uuid, intent text, created_at timestamptz default now(), status text default 'open'
);
CREATE TABLE public.conversation_evaluation_attempt(
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL, company_id uuid NOT NULL, status text NOT NULL,
 bundle_hash text, evaluation_contract_version text NOT NULL
);
CREATE TABLE public.ce_bundle_snapshot(
 attempt_id uuid PRIMARY KEY, conversation_id uuid NOT NULL, company_id uuid NOT NULL,
 bundle_hash text, transcript_hash text, evaluation_contract_version text NOT NULL,
 model_version text, prompt_version text, kb_snapshot_id text, policy_snapshot_id text,
 normalized_transcript jsonb, evaluated_ai_reply jsonb, verified_human_response jsonb,
 grounding_manifest jsonb, truncation_manifest jsonb, redaction_applied boolean default true
);
CREATE TABLE public.conversation_evaluation(
 id uuid PRIMARY KEY default extensions.gen_random_uuid(), attempt_id uuid NOT NULL,
 conversation_id uuid NOT NULL, company_id uuid NOT NULL,
 evaluation_contract_version text NOT NULL, input_snapshot_hash text NOT NULL default 'i', bundle_hash text,
 accuracy_score numeric NOT NULL default 80, policy_score numeric NOT NULL default 80,
 tone_score numeric NOT NULL default 80, sales_score numeric NOT NULL default 80,
 context_score numeric NOT NULL default 80, hallucination_risk_score numeric NOT NULL default 10,
 hallucination_quality_score numeric NOT NULL default 90, overall_score numeric NOT NULL,
 severity text NOT NULL default 'low', has_verified_human_response boolean NOT NULL default false,
 training_eligible boolean NOT NULL default false, model_version text NOT NULL default 'm',
 prompt_version text NOT NULL default 'p', kb_snapshot_id text NOT NULL default 'kb',
 policy_snapshot_id text NOT NULL default 'pol', source_deployment text NOT NULL default 'gate',
 evaluated_by uuid NOT NULL default '00000000-0000-4000-8000-000000000001',
 created_at timestamptz NOT NULL default now(), review_status text NOT NULL default 'pending',
 freshness text NOT NULL default 'current'
);
CREATE TABLE public.conversation_evaluation_detail(
 id uuid primary key default extensions.gen_random_uuid(), evaluation_id uuid not null,
 evaluator_type text not null, raw_score numeric not null, weight numeric not null, weighted_score numeric not null,
 justification text, recommended_correction text, evaluator_model_version text, evaluator_prompt_version text, grounding_refs jsonb
);
CREATE TABLE public.ce_discrepancy(
 id uuid primary key default extensions.gen_random_uuid(), evaluation_id uuid not null,
 dimension text, divergence_kind text, severity text, ai_claim text, human_claim text, grounded_claim text, grounding_refs jsonb
);
CREATE TABLE public.feedback_request(
 id uuid primary key default extensions.gen_random_uuid(), conversation_id uuid not null,
 status text, rating integer, feedback_text text, rating_type text not null default 'nps',
 responded_at timestamptz, created_at timestamptz not null default now()
);
CREATE TABLE public.handoff_event(
 id uuid primary key default extensions.gen_random_uuid(), conversation_id uuid not null,
 escalation_rule text, handoff_reason text, handoff_type text not null default 'ai_to_human', created_at timestamptz default now()
);
CREATE TABLE public.evaluation_training_outbox(
 id uuid primary key default extensions.gen_random_uuid(), evaluation_id uuid not null unique,
 status text not null default 'pending', delivery_attempts integer not null default 0,
 max_attempts integer not null default 3, last_attempt_at timestamptz, last_error text,
 delivered_at timestamptz, delivery_idempotency_key text not null,
 source_app text not null default 'ai_chatbot', source_deployment text not null,
 evaluation_contract_version text not null, created_at timestamptz not null default now(), company_id uuid not null
);
CREATE TABLE public.ce_training_link(
 id uuid primary key default extensions.gen_random_uuid(), evaluation_id uuid not null, company_id uuid not null,
 link_kind text not null, local_state text not null default 'proposed', payload jsonb not null default '{}'::jsonb,
 improved_result jsonb, improved_state text not null default 'pending', remote_sync_state text not null default 'pending',
 remote_ref text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
CREATE TABLE public.ce_kb_publish_state(
 id uuid primary key default extensions.gen_random_uuid(), evaluation_id uuid not null, company_id uuid not null,
 action text not null, state text not null, remote_sync_state text not null, kb_document_ref text,
 remote_ref text, last_error text, updated_at timestamptz not null default now()
);
CREATE TABLE public.messages(
 id uuid primary key default extensions.gen_random_uuid(), conversation_id uuid not null,
 role text not null, content text, metadata jsonb default '{}'::jsonb, created_at timestamptz default now()
);

CREATE OR REPLACE FUNCTION public.pr6_enqueue_canonical_evaluation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $$
BEGIN
 INSERT INTO public.evaluation_training_outbox(evaluation_id,status,delivery_idempotency_key,source_app,source_deployment,evaluation_contract_version,company_id)
 VALUES(NEW.id,'pending',NEW.id::text,'ai_chatbot',NEW.source_deployment,NEW.evaluation_contract_version,NEW.company_id)
 ON CONFLICT(evaluation_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER trg_pr6_enqueue_canonical_evaluation
AFTER INSERT ON public.conversation_evaluation DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.pr6_enqueue_canonical_evaluation();
SQL

psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres -d hf3 -f "$MIG" >/tmp/hf3-migration.log
echo "HF3_MIGRATION_COMPILE=PASS"

psql -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U postgres -d hf3 <<'SQL'
SET search_path TO public,extensions;
DO $$
DECLARE
 c1 uuid:='10000000-0000-4000-8000-000000000001';
 c2 uuid:='10000000-0000-4000-8000-000000000002';
 c3 uuid:='10000000-0000-4000-8000-000000000003';
 e1 uuid:='20000000-0000-4000-8000-000000000001';
 e2 uuid:='20000000-0000-4000-8000-000000000002';
 e3 uuid:='20000000-0000-4000-8000-000000000003';
 a1 uuid:='30000000-0000-4000-8000-000000000001';
 a2 uuid:='30000000-0000-4000-8000-000000000002';
 a3 uuid:='30000000-0000-4000-8000-000000000003';
 co uuid:='40000000-0000-4000-8000-000000000001';
 r jsonb; n int;
BEGIN
 INSERT INTO conversations(id,company_id,intent,created_at) VALUES
 (c1,co,'refund status',now()-interval '3 days'),
 (c2,co,'refund status',now()-interval '2 days'),
 (c3,co,'refund status',now()-interval '1 day');

 INSERT INTO conversation_evaluation_attempt(id,conversation_id,company_id,status,bundle_hash,evaluation_contract_version) VALUES
 (a1,c1,co,'complete','b1','v1'),(a2,c2,co,'complete','b2','v1'),(a3,c3,co,'complete','b3','v1');
 INSERT INTO ce_bundle_snapshot(attempt_id,conversation_id,company_id,bundle_hash,transcript_hash,evaluation_contract_version,normalized_transcript,evaluated_ai_reply,verified_human_response,redaction_applied) VALUES
 (a1,c1,co,'b1','t1','v1','[]','{"content":"ai bad"}','{"content":"human good"}',true),
 (a2,c2,co,'b2','t2','v1','[]','{"content":"ai"}',null,true),
 (a3,c3,co,'b3','t3','v1','[]','{"content":"ai"}','{"content":"human"}',true);

 -- Low CE + verified human: candidate, but pending review must NOT queue.
 INSERT INTO conversation_evaluation(id,attempt_id,conversation_id,company_id,evaluation_contract_version,bundle_hash,overall_score,has_verified_human_response,training_eligible,review_status)
 VALUES(e1,a1,c1,co,'v1','b1',55,true,true,'pending');
 SELECT count(*) INTO n FROM evaluation_training_outbox WHERE evaluation_id=e1 AND status IN('pending','in_progress');
 IF n<>0 THEN RAISE EXCEPTION 'HF3_PENDING_REVIEW_QUEUED'; END IF;
 SELECT training_candidate INTO r FROM hf3_learning_case WHERE evaluation_id=e1;
 IF r::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'HF3_CANDIDATE_MISSING'; END IF;

 -- R2 same unresolved + correction is potentially avoidable.
 INSERT INTO handoff_event(conversation_id,escalation_rule,handoff_reason) VALUES(c1,'R2','same intent unresolved');
 SELECT handoff_classification INTO r FROM hf3_learning_case WHERE evaluation_id=e1;
 IF trim(both '"' from r::text) <> 'potentially_avoidable' THEN RAISE EXCEPTION 'HF3_R2_CLASSIFICATION'; END IF;

 -- Accepted review queues exactly once; repeated refresh stays exactly once.
 UPDATE conversation_evaluation SET review_status='accepted' WHERE id=e1;
 SELECT count(*) INTO n FROM evaluation_training_outbox WHERE evaluation_id=e1 AND status='pending';
 IF n<>1 THEN RAISE EXCEPTION 'HF3_ACCEPTED_CANDIDATE_NOT_QUEUED'; END IF;
 PERFORM hf3_refresh_learning_case_tx(e1);
 SELECT count(*) INTO n FROM evaluation_training_outbox WHERE evaluation_id=e1;
 IF n<>1 THEN RAISE EXCEPTION 'HF3_OUTBOX_NOT_IDEMPOTENT'; END IF;

 -- R1 is protected/unavoidable, never an avoidability target.
 INSERT INTO handoff_event(conversation_id,escalation_rule,handoff_reason) VALUES(c1,'R1','explicit human request');
 SELECT handoff_classification INTO r FROM hf3_learning_case WHERE evaluation_id=e1;
 IF trim(both '"' from r::text) <> 'unavoidable' THEN RAISE EXCEPTION 'HF3_R1_NOT_PROTECTED'; END IF;

 -- Negative feedback without verified human correction is quality signal only, never training candidate.
 INSERT INTO conversation_evaluation(id,attempt_id,conversation_id,company_id,evaluation_contract_version,bundle_hash,overall_score,has_verified_human_response,training_eligible,review_status)
 VALUES(e2,a2,c2,co,'v1','b2',85,false,false,'accepted');
 INSERT INTO feedback_request(conversation_id,status,rating,rating_type,responded_at) VALUES(c2,'responded',2,'nps',now());
 SELECT training_candidate INTO r FROM hf3_learning_case WHERE evaluation_id=e2;
 IF r::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'HF3_NO_HUMAN_NEGATIVE_FEEDBACK_QUEUED'; END IF;
 SELECT count(*) INTO n FROM evaluation_training_outbox WHERE evaluation_id=e2 AND status IN('pending','in_progress');
 IF n<>0 THEN RAISE EXCEPTION 'HF3_NO_HUMAN_OUTBOX'; END IF;

 -- AI-human discrepancy + verified human + accepted review becomes candidate even when CE threshold alone did not.
 INSERT INTO conversation_evaluation(id,attempt_id,conversation_id,company_id,evaluation_contract_version,bundle_hash,overall_score,has_verified_human_response,training_eligible,review_status)
 VALUES(e3,a3,c3,co,'v1','b3',82,true,false,'accepted');
 INSERT INTO ce_discrepancy(evaluation_id,dimension,divergence_kind,severity) VALUES(e3,'accuracy','human_correction','medium');
 SELECT training_candidate INTO r FROM hf3_learning_case WHERE evaluation_id=e3;
 IF r::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'HF3_DELTA_CANDIDATE_MISSING'; END IF;
 SELECT count(*) INTO n FROM evaluation_training_outbox WHERE evaluation_id=e3 AND status='pending';
 IF n<>1 THEN RAISE EXCEPTION 'HF3_DELTA_CANDIDATE_NOT_QUEUED'; END IF;

 -- Atomic claim: two eligible candidates are claimable, non-candidate is not.
 SELECT count(*) INTO n FROM hf3_claim_training_outbox_tx(50);
 IF n<>2 THEN RAISE EXCEPTION 'HF3_CLAIM_COUNT_%',n; END IF;
 SELECT count(*) INTO n FROM hf3_claim_training_outbox_tx(50);
 IF n<>0 THEN RAISE EXCEPTION 'HF3_DOUBLE_CLAIM'; END IF;

 -- Finish e1 success exactly once.
 SELECT hf3_finish_training_outbox_tx(id,true,null) INTO r FROM evaluation_training_outbox WHERE evaluation_id=e1;
 IF r->>'status'<>'delivered' THEN RAISE EXCEPTION 'HF3_FINISH_DELIVERY'; END IF;
 SELECT hf3_finish_training_outbox_tx(id,true,null) INTO r FROM evaluation_training_outbox WHERE evaluation_id=e1;
 IF r->>'result'<>'idempotent' THEN RAISE EXCEPTION 'HF3_FINISH_NOT_IDEMPOTENT'; END IF;

 -- e3 transport failure returns pending while attempts remain.
 SELECT hf3_finish_training_outbox_tx(id,false,'network') INTO r FROM evaluation_training_outbox WHERE evaluation_id=e3;
 IF r->>'status'<>'pending' THEN RAISE EXCEPTION 'HF3_RETRY_STATE'; END IF;

 -- Workload snapshots are tenant+intent scoped and comparable.
 PERFORM hf3_capture_workload_snapshot_tx(co,'refund status',now()-interval '4 days',now()-interval '36 hours','before');
 PERFORM hf3_capture_workload_snapshot_tx(co,'refund status',now()-interval '36 hours',now()+interval '1 hour','after');
 SELECT hf3_compare_workload_snapshots_tx(
   (SELECT id FROM hf3_workload_snapshot WHERE snapshot_label='before' ORDER BY created_at DESC LIMIT 1),
   (SELECT id FROM hf3_workload_snapshot WHERE snapshot_label='after' ORDER BY created_at DESC LIMIT 1)
 ) INTO r;
 IF r->>'result'<>'success' THEN RAISE EXCEPTION 'HF3_WORKLOAD_COMPARE'; END IF;
END $$;

DO $$
DECLARE n int;
BEGIN
 SELECT count(*) INTO n
 FROM information_schema.routine_privileges
 WHERE routine_schema='public'
   AND routine_name IN ('hf3_refresh_learning_case_tx','hf3_claim_training_outbox_tx','hf3_finish_training_outbox_tx','hf3_capture_workload_snapshot_tx','hf3_compare_workload_snapshots_tx','hf3_record_closed_loop_proof_tx')
   AND grantee IN ('anon','authenticated');
 IF n<>0 THEN RAISE EXCEPTION 'HF3_UNSAFE_RPC_GRANTS_%',n; END IF;
END $$;
SQL

echo "HF3_DB_TRANSACTION_ASSERTIONS=PASS"

deno check "$WORKER" "$RECEIVER" >/dev/null
echo "HF3_DENO_CHECK=PASS"

npm ci >/dev/null
npm run build >/dev/null
echo "HF3_BUILD_GATE=PASS"
echo "HF3_SOURCE_FINAL_GATE=PASS"
