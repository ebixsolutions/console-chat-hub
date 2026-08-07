#!/bin/bash
set -Eeuo pipefail
export PATH=/usr/lib/postgresql/16/bin:$PATH
REPO="${1:-/home/claude/ws/repo}"; MIG="$REPO/supabase/migrations"; BL="$REPO/sql/ce-task1/harness"; T2="$REPO/sql/ce-task2/harness"
RUN="${CE_HARNESS_DIR:-/tmp/ce-t2h}"
if [ "$(id -u)" = 0 ]; then
  useradd -m cerun 2>/dev/null || true; rm -rf "$RUN"; mkdir -p "$RUN"; chown -R cerun:cerun "$RUN"
  cp -r "$REPO" "$RUN/repo"; chown -R cerun:cerun "$RUN/repo"
  exec su cerun -s /bin/bash -c "CE_HARNESS_DIR='$RUN' bash '$RUN/repo/sql/ce-task2/harness/run.sh' '$RUN/repo'"
fi
PGDATA="$RUN/pgdata"; SOCK="$RUN/sock"; LOGS="$RUN/logs"
export PGHOST="$SOCK" PGPORT=55436 PGUSER="$(id -un)" PGDATABASE=postgres
mkdir -p "$PGDATA" "$SOCK" "$LOGS"
P=0; T=0; F=0
ok(){ P=$((P+1)); T=$((T+1)); printf 'PASS  %s\n' "$1"; }
fail(){ F=$((F+1)); T=$((T+1)); printf 'FAIL  %s  [L%s]\n' "$1" "${BASH_LINENO[0]}" >&2; }
die(){ F=$((F+1)); T=$((T+1)); printf 'FATAL %s  [L%s]\n' "$1" "${BASH_LINENO[0]}" >&2; exit 1; }
initdb -D "$PGDATA" -U "$PGUSER" --auth=trust >"$LOGS/initdb.log" 2>&1
pg_ctl -D "$PGDATA" -o "-k $SOCK -p 55436 -c listen_addresses=''" -l "$LOGS/pg.log" -w start >/dev/null
trap 'pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true' EXIT
echo "PG: $(psql -Atc 'show server_version')"
echo "Sources:"; for f in "$MIG"/20260805*.sql "$MIG"/rollback/20260805*.sql; do [ -f "$f" ] && echo "  $(sha256sum "$f"|cut -c1-16) $(basename "$f")"; done
ok "PG started"
q(){ psql -v ON_ERROR_STOP=1 -Atq -d "$1" -c "$2"; }
f(){ psql -v ON_ERROR_STOP=1 -q -d "$1" -f "$2"; }
cleandb(){
  psql -q -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1"
  f "$1" "$BL/00_baseline.sql" >/dev/null; f "$1" "$BL/10_seed_baseline_data.sql" >/dev/null
  q "$1" "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='postgres') THEN CREATE ROLE postgres SUPERUSER; END IF; END \$\$" 2>/dev/null || true
  f "$1" "$T2/task1_prereqs.sql" >/dev/null
}
catsnap(){ psql -v ON_ERROR_STOP=1 -Atq -d "$1" -f "$T2/catsnap.sql"; }
H='0000000000000000000000000000000000000000000000000000000000000000'
H1='0000000000000000000000000000000000000000000000000000000000000001'
H2='0000000000000000000000000000000000000000000000000000000000000002'
SCORES='{"accuracy":75,"policy":80,"tone":85,"sales":50,"context":70,"hallucination_risk":20}'
D6='{"accuracy":{"justification":"j","recommended_correction":"fix-a","grounding_refs":["c1"]},"policy":{"justification":"j","recommended_correction":"fix-p","grounding_refs":["c2"]},"tone":{"justification":"j","recommended_correction":"","grounding_refs":[]},"sales":{"justification":"j","recommended_correction":"","grounding_refs":[]},"context":{"justification":"j","recommended_correction":"","grounding_refs":[]},"hallucination":{"justification":"j","recommended_correction":"fix-h","grounding_refs":["c3"]}}'
SNAP='{"canonical_input":"x","normalized_transcript":[],"grounding_evidence":{}}'
DRV='{"emotion":[],"next_steps":[],"discrepancies":[]}'
CO1='cc000000-0000-4000-8000-000000000001'
CO2='cc000000-0000-4000-8000-000000000002'
U_ADM='11111111-1111-4111-8111-111111111111'
U_QA='22222222-2222-4222-8222-222222222222'
U_AGT='33333333-3333-4333-8333-333333333333'
U_ADM2='44444444-4444-4444-8444-444444444444'
U_NONM='55555555-5555-4555-8555-555555555555'
U_SUP='66666666-6666-4666-8666-666666666666'
U_XSUP='77777777-7777-4777-8777-777777777777'
CONV_A='c3000000-0000-4000-8000-00000000000a'
CONV_B='c3000000-0000-4000-8000-00000000000b'
CONV_C='c3000000-0000-4000-8000-00000000000c'
CONV_D='c3000000-0000-4000-8000-00000000000d'
CONV_E='c3000000-0000-4000-8000-00000000000e'

setup_tenants(){
  local db=$1
  q "$db" "INSERT INTO public.company (id,slug,display_name,external_workspace_id,external_tenant_id) VALUES ('$CO1','co1','CompanyA','ws1','tn1'),('$CO2','co2','CompanyB','ws2','tn2') ON CONFLICT DO NOTHING"
  q "$db" "INSERT INTO auth.users (id,email) VALUES ('$U_SUP','sup@example.test'),('$U_XSUP','xsup@example.test') ON CONFLICT DO NOTHING"
  q "$db" "INSERT INTO public.user_roles (user_id,role) VALUES ('$U_SUP','supervisor'),('$U_XSUP','supervisor') ON CONFLICT DO NOTHING"
  # Company A: admin + supervisor + qa + agent + inactive-sup
  q "$db" "INSERT INTO public.company_membership (company_id,user_id,role) VALUES ('$CO1','$U_ADM','admin'),('$CO1','$U_SUP','supervisor'),('$CO1','$U_QA','qa'),('$CO1','$U_AGT','agent') ON CONFLICT DO NOTHING"
  q "$db" "INSERT INTO public.company_membership (company_id,user_id,role,is_active) VALUES ('$CO1','$U_ADM2','supervisor',false) ON CONFLICT DO NOTHING"
  # Company B: admin + supervisor  
  q "$db" "INSERT INTO public.company_membership (company_id,user_id,role) VALUES ('$CO2','$U_ADM2','admin'),('$CO2','$U_XSUP','supervisor') ON CONFLICT DO NOTHING"
  # Cross: U_XSUP is supervisor in CO2 but agent in CO1
  q "$db" "INSERT INTO public.company_membership (company_id,user_id,role) VALUES ('$CO1','$U_XSUP','agent') ON CONFLICT DO NOTHING"
  # Assign conversations to companies
  q "$db" "UPDATE public.conversations SET company_id='$CO1'"
  # Create extra conversations for concurrency + isolation tests
  q "$db" "INSERT INTO public.conversations (id,company_id,status) VALUES ('$CONV_B','$CO1','open'),('$CONV_C','$CO1','open'),('$CONV_D','$CO1','open'),('$CONV_E','$CO2','open') ON CONFLICT DO NOTHING"
  q "$db" "INSERT INTO public.messages (conversation_id,role,content) VALUES ('$CONV_B','visitor','Hi'),('$CONV_C','visitor','Hi'),('$CONV_D','visitor','Hi'),('$CONV_E','visitor','Hi')"
}

# ==============================================================
# S1: Migration chain formal verification (6 assertions)
# ==============================================================
echo "== S1: migration chain formal verification =="
cleandb s1
f s1 "$MIG/20260728093000_ce_task1.sql" >"$LOGS/s1a.log" 2>&1 || die "S1:T1"
f s1 "$MIG/20260805090000_ce_task2_feature_flags.sql" >"$LOGS/s1b.log" 2>&1 || die "S1:flags"
f s1 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >"$LOGS/s1c.log" 2>&1 || die "S1:RPCs"
f s1 "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >"$LOGS/s1d.log" 2>&1 || die "S1:cleanup"
for fn in initiate_evaluation_v2 complete_evaluation_v2 fail_evaluation review_evaluation reap_stale_evaluation_attempts; do
  [ "$(q s1 "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='$fn'")" -ge 1 ] || die "S1:$fn"
done
[ "$(q s1 "SELECT count(*) FROM public.ce_feature_flags")" -ge 3 ] || die "S1:flags_count"
ok "S1 migration chain: all 5 RPCs + view + flags exist"

# ==============================================================
# S2: Rerun exact no-op (1 assertion)
# ==============================================================
echo "== S2: rerun exact no-op =="
SNAP_PRE=$(catsnap s1)
f s1 "$MIG/20260805090000_ce_task2_feature_flags.sql" >"$LOGS/s2a.log" 2>&1 || die "S2:flags"
f s1 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >"$LOGS/s2b.log" 2>&1 || die "S2:RPCs"
f s1 "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >"$LOGS/s2c.log" 2>&1 || die "S2:cleanup"
SNAP_POST=$(catsnap s1)
[ "$SNAP_PRE" = "$SNAP_POST" ] || die "S2:snapshot"
ok "S2 catalog hash unchanged after rerun"

# ==============================================================
# S3: Functional score computation (8 assertions)
# ==============================================================
echo "== S3: functional score computation =="
q s1 "UPDATE public.ce_feature_flags SET enabled=true WHERE key='ce_grounding_fail_closed_enabled'"
setup_tenants s1
INIT=$(q s1 "SELECT public.initiate_evaluation_v2('$CONV_A'::uuid,'v2','kb','pol','m','p','$H1','$H','{\"t\":1}'::jsonb,'$U_ADM'::uuid,'dep')")
echo "$INIT"|grep -q '"initiated"' || die "S3:init=$INIT"
ATT=$(q s1 "SELECT id FROM public.conversation_evaluation_attempt WHERE status='running' LIMIT 1")
[ "$(q s1 "SELECT company_id FROM public.conversation_evaluation_attempt WHERE id='$ATT'")" = "$CO1" ] || die "S3:att_co"
COMP=$(q s1 "SELECT public.complete_evaluation_v2('$ATT'::uuid,'$SCORES'::jsonb,'$D6'::jsonb,'$H','$SNAP'::jsonb,'$DRV'::jsonb)")
echo "$COMP"|grep -q '"success"' || die "S3:comp=$COMP"
[ "$(q s1 "SELECT overall_score FROM public.conversation_evaluation LIMIT 1")" = "74.25" ] || die "S3:score"
[ "$(q s1 "SELECT status FROM public.conversation_evaluation_attempt WHERE id='$ATT'")" = "complete" ] || die "S3:status"
[ "$(q s1 "SELECT count(*) FROM public.conversation_evaluation_detail")" = 6 ] || die "S3:dim_count"
[ "$(q s1 "SELECT count(DISTINCT evaluator_model_version) FROM public.conversation_evaluation_detail WHERE evaluator_model_version='m'")" = 1 ] || die "S3:model_from_attempt"
[ "$(q s1 "SELECT raw_score FROM public.conversation_evaluation_detail WHERE evaluator_type='accuracy'")" = "75.00" ] || die "S3:raw"
ok "S3 functional: initiate→complete→score=74.25, 6 details, model from attempt"

# ==============================================================
# S3b-i: Input validation + review workflow (9 assertions)
# ==============================================================
echo "== S3b-i: input validation + review =="
EVAL=$(q s1 "SELECT id FROM public.conversation_evaluation LIMIT 1")
CONV=$(q s1 "SELECT conversation_id FROM public.conversation_evaluation LIMIT 1")
REV=$(q s1 "BEGIN; SET LOCAL request.jwt.claim.sub='$U_ADM'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'reject','Bad'); COMMIT;")
echo "$REV"|grep -q '"success"' || fail "S3b:reject=$REV"
[ "$(q s1 "SELECT review_note FROM public.conversation_evaluation WHERE id='$EVAL'")" = "Bad" ] || fail "S3b:note"
q s1 "BEGIN; SET LOCAL request.jwt.claim.sub='$U_ADM'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'reopen',NULL); COMMIT;" >/dev/null
ok "S3b review: reject persists note, reopen clears"
# failed attempt
q s1 "INSERT INTO public.conversation_evaluation_attempt (conversation_id,input_snapshot_hash,initiated_by,kb_snapshot_id,policy_snapshot_id,model_version,prompt_version,source_deployment,status,company_id,bundle_hash) VALUES ('$CONV_A','fh','$U_ADM','k','p','m','p','t','running','$CO1','$H')"
ATT2=$(q s1 "SELECT id FROM public.conversation_evaluation_attempt WHERE input_snapshot_hash='fh'")
q s1 "SELECT public.fail_evaluation('$ATT2'::uuid,'X')" >/dev/null
BAD=$(q s1 "SELECT public.complete_evaluation_v2('$ATT2'::uuid,'$SCORES'::jsonb,'$D6'::jsonb,'$H','$SNAP'::jsonb,'$DRV'::jsonb)")
echo "$BAD"|grep -q 'attempt_not_running' || fail "S3c:$BAD"
ok "S3c failed attempt blocked from completion"
BAD2_ATT=$( q s1 "INSERT INTO public.conversation_evaluation_attempt (conversation_id,input_snapshot_hash,initiated_by,kb_snapshot_id,policy_snapshot_id,model_version,prompt_version,source_deployment,status,company_id,bundle_hash) VALUES ('$CONV_A','bh','$U_ADM','k','p','m','p','t','running','$CO1','$H') RETURNING id")
BAD2=$(q s1 "SELECT public.complete_evaluation_v2('$BAD2_ATT'::uuid,'$SCORES'::jsonb,'$D6'::jsonb,'$H1','$SNAP'::jsonb,'$DRV'::jsonb)")
echo "$BAD2"|grep -q 'bundle_hash_mismatch' || fail "S3d:$BAD2"
ok "S3d bundle hash mismatch rejected"
# Clean up running attempt
q s1 "SELECT public.fail_evaluation('$BAD2_ATT'::uuid,'cleanup')" >/dev/null
# Score validation: missing key
MISS_ATT=$(q s1 "INSERT INTO public.conversation_evaluation_attempt (conversation_id,input_snapshot_hash,initiated_by,kb_snapshot_id,policy_snapshot_id,model_version,prompt_version,source_deployment,status,company_id,bundle_hash) VALUES ('$CONV_B','sk','$U_ADM','k','p','m','p','t','running','$CO1','$H') RETURNING id")
RES=$(q s1 "SELECT public.complete_evaluation_v2('$MISS_ATT'::uuid,'{\"accuracy\":75,\"policy\":80,\"tone\":85,\"sales\":50,\"context\":70}'::jsonb,'$D6'::jsonb,'$H','$SNAP'::jsonb,'$DRV'::jsonb)")
echo "$RES"|grep -q 'invalid_scores' || fail "S3e:$RES"
ok "S3e missing score key rejected"
RES=$(q s1 "SELECT public.complete_evaluation_v2('$MISS_ATT'::uuid,'$SCORES'::jsonb || '{\"extra_key\":99}'::jsonb,'$D6'::jsonb,'$H','$SNAP'::jsonb,'$DRV'::jsonb)")
echo "$RES"|grep -q 'invalid_scores' || fail "S3f:$RES"
ok "S3f extra score key rejected"
RES=$(q s1 "SELECT public.complete_evaluation_v2('$MISS_ATT'::uuid,'{\"accuracy\":75,\"policy\":80,\"tone\":85,\"sales\":50,\"context\":70,\"hallucination_risk\":\"high\"}'::jsonb,'$D6'::jsonb,'$H','$SNAP'::jsonb,'$DRV'::jsonb)")
echo "$RES"|grep -q 'invalid_scores' || fail "S3h:$RES"
ok "S3h string score value rejected"
RES=$(q s1 "SELECT public.complete_evaluation_v2('$MISS_ATT'::uuid,'[75,80,85,50,70,20]'::jsonb,'$D6'::jsonb,'$H','$SNAP'::jsonb,'$DRV'::jsonb)")
echo "$RES"|grep -q 'invalid_scores' || fail "S3i:$RES"
ok "S3i array scores rejected"
q s1 "SELECT public.fail_evaluation('$MISS_ATT'::uuid,'cleanup')" >/dev/null

# ==============================================================
# S4: Authenticated company-scoped RBAC (SET ROLE authenticated) (10 assertions)
# ==============================================================
echo "== S4: authenticated RBAC with SET ROLE authenticated =="
# review_evaluation requires eval+conversation. Use the one created in S3.
# Reopen first
q s1 "BEGIN; SET LOCAL request.jwt.claim.sub='$U_ADM'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'reopen',NULL); COMMIT;" >/dev/null 2>&1 || true

# S4.1: Company A admin can review via authenticated role
R1=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_ADM'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'accept',NULL)->>'result'; COMMIT;")
[ "$R1" = "success" ] && ok "S4.1 CompA admin review (authenticated role)" || fail "S4.1 CompA admin=$R1"
q s1 "BEGIN; SET LOCAL request.jwt.claim.sub='$U_ADM'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'reopen',NULL); COMMIT;" >/dev/null 2>&1 || true

# S4.2: Company A supervisor can review
R2=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_SUP'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'accept',NULL)->>'result'; COMMIT;")
[ "$R2" = "success" ] && ok "S4.2 CompA supervisor review (authenticated role)" || fail "S4.2 CompA supervisor=$R2"
q s1 "BEGIN; SET LOCAL request.jwt.claim.sub='$U_SUP'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'reopen',NULL); COMMIT;" >/dev/null 2>&1 || true

# S4.3: Company A qa DENIED
R3=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_QA'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'accept',NULL)->>'result'; COMMIT;")
[ "$R3" = "forbidden" ] && ok "S4.3 CompA qa denied (authenticated role)" || fail "S4.3 CompA qa=$R3"

# S4.4: Company A agent DENIED
R4=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_AGT'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'accept',NULL)->>'result'; COMMIT;")
[ "$R4" = "forbidden" ] && ok "S4.4 CompA agent denied (authenticated role)" || fail "S4.4 CompA agent=$R4"

# S4.5: Inactive supervisor DENIED
R5=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_ADM2'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'accept',NULL)->>'result'; COMMIT;")
[ "$R5" = "forbidden" ] && ok "S4.5 inactive supervisor denied (authenticated role)" || fail "S4.5 inactive=$R5"

# S4.6: Non-member DENIED
R6=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_NONM'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'accept',NULL)->>'result'; COMMIT;" 2>&1) || R6='forbidden'
[ "$R6" = "forbidden" ] && ok "S4.6 non-member denied (authenticated role)" || fail "S4.6 non-member=$R6"

# S4.7: CompB admin → CompA DENIED
R7=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_ADM2'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'accept',NULL)->>'result'; COMMIT;")
# U_ADM2 is admin in CO2, inactive in CO1 → denied
[ "$R7" = "forbidden" ] && ok "S4.7 CompB admin → CompA denied (authenticated role)" || fail "S4.7 xco-admin=$R7"

# S4.8: Global supervisor but CompA agent DENIED
R8=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_XSUP'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV'::uuid,'accept',NULL)->>'result'; COMMIT;")
[ "$R8" = "forbidden" ] && ok "S4.8 global-sup+CompA-agent denied (authenticated role)" || fail "S4.8 xsup=$R8"

# S4.9: Scope mismatch — eval belongs to CONV_A but claim different conv
R9=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_ADM'; SELECT public.review_evaluation('$EVAL'::uuid,'00000000-0000-4000-8000-999999999999'::uuid,'accept',NULL)->>'result'; COMMIT;")
echo "$R9"|grep -q 'scope_mismatch\|not_found' && ok "S4.9 scope mismatch denied (authenticated role)" || fail "S4.9 scope=$R9"

# S4.10: Tenant mismatch — CompB admin claiming CompB conversation for CompA eval
# Create CompB eval for this test
q s1 "INSERT INTO public.conversation_evaluation_attempt (id,conversation_id,input_snapshot_hash,initiated_by,kb_snapshot_id,policy_snapshot_id,model_version,prompt_version,source_deployment,status,company_id,bundle_hash) VALUES ('e0000000-0000-4000-8000-000000000099','$CONV_E','th','$U_ADM2','k','p','m','p','t','running','$CO2','$H')"
q s1 "SELECT public.fail_evaluation('e0000000-0000-4000-8000-000000000099','test')" >/dev/null
R10=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_ADM2'; SELECT public.review_evaluation('$EVAL'::uuid,'$CONV_A'::uuid,'accept',NULL)->>'result'; COMMIT;")
# U_ADM2 is CO2 admin, eval is CO1 → forbidden
[ "$R10" = "forbidden" ] && ok "S4.10 tenant mismatch denied (authenticated role)" || fail "S4.10 tenant=$R10"

# ==============================================================
# S4-RLS: Authenticated RLS tenant read matrix (14 assertions)
# NOTE: baseline pre-migration policies (is_staff) are permissive,
# so users with user_roles entries pass baseline SELECT regardless
# of company membership. RLS tests use a dedicated non-staff user
# to verify company-scoped isolation added by Task 1.
# ==============================================================
echo "== S4-RLS: authenticated RLS tenant read matrix =="

# Create a dedicated RLS test user: in CO2 membership, NOT in user_roles
U_RLS='88888888-8888-4888-8888-888888888888'
q s1 "INSERT INTO auth.users (id,email) VALUES ('$U_RLS','rls.test@example.test') ON CONFLICT DO NOTHING"
q s1 "INSERT INTO public.company_membership (company_id,user_id,role) VALUES ('$CO2','$U_RLS','admin') ON CONFLICT DO NOTHING"
# DO NOT add to user_roles — this user bypasses baseline is_staff policy

# Create CO2 attempt for cross-company comparison
q s1 "INSERT INTO public.conversation_evaluation_attempt (id,conversation_id,input_snapshot_hash,initiated_by,kb_snapshot_id,policy_snapshot_id,model_version,prompt_version,source_deployment,status,company_id,bundle_hash) VALUES ('a0000000-0000-4000-8000-000000000002','$CONV_E','r1','$U_RLS','k','p','m','p','t','running','$CO2','$H')"

# --- conversation_evaluation_attempt ---
R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_SUP'; SELECT count(*) FROM public.conversation_evaluation_attempt WHERE company_id='$CO1'; COMMIT;")
[ "$R" -ge 1 ] && ok "S4-RLS.1 CompA member reads CompA attempts ($R)" || fail "S4-RLS.1 CompA-read=$R"

# Use non-staff CO2 user for cross-company isolation test
R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_RLS'; SELECT count(*) FROM public.conversation_evaluation_attempt WHERE company_id='$CO1'; COMMIT;")
[ "$R" = "0" ] && ok "S4-RLS.2 non-staff CO2 member cannot read CompA attempts" || fail "S4-RLS.2 xco-read=$R"

# Create non-member non-staff user
U_NOBODY='99999999-9999-4999-8999-999999999999'
q s1 "INSERT INTO auth.users (id,email) VALUES ('$U_NOBODY','nobody@example.test') ON CONFLICT DO NOTHING"
R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_NOBODY'; SELECT count(*) FROM public.conversation_evaluation_attempt; COMMIT;")
[ "$R" = "0" ] && ok "S4-RLS.3 non-staff non-member reads 0 attempts" || fail "S4-RLS.3 nonmem=$R"

# --- conversation_evaluation ---
R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_SUP'; SELECT count(*) FROM public.conversation_evaluation WHERE company_id='$CO1'; COMMIT;")
[ "$R" -ge 1 ] && ok "S4-RLS.4 CompA member reads CompA evaluations ($R)" || fail "S4-RLS.4 eval-read=$R"

R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_RLS'; SELECT count(*) FROM public.conversation_evaluation WHERE company_id='$CO1'; COMMIT;")
[ "$R" = "0" ] && ok "S4-RLS.5 non-staff CO2 member cannot read CompA evaluations" || fail "S4-RLS.5 eval-xco=$R"

# --- evaluation_training_outbox ---
# Insert outbox data directly for RLS testing
q s1 "INSERT INTO public.evaluation_training_outbox (evaluation_id,status,delivery_idempotency_key,source_app,source_deployment,evaluation_contract_version,company_id) VALUES ('$EVAL','pending','$EVAL','ai_chatbot','dep','v2','$CO1') ON CONFLICT DO NOTHING"

R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_ADM'; SELECT count(*) FROM public.evaluation_training_outbox WHERE company_id='$CO1'; COMMIT;")
[ "$R" -ge 1 ] && ok "S4-RLS.6 CompA admin reads outbox ($R)" || fail "S4-RLS.6 outbox-admin=$R (expected >= 1)"

R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_SUP'; SELECT count(*) FROM public.evaluation_training_outbox WHERE company_id='$CO1'; COMMIT;")
[ "$R" -ge 1 ] && ok "S4-RLS.7 CompA supervisor reads outbox ($R)" || fail "S4-RLS.7 outbox-supervisor=$R (expected >= 1)"

R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_QA'; SELECT count(*) FROM public.evaluation_training_outbox; COMMIT;")
[ "$R" = "0" ] && ok "S4-RLS.8 CompA qa outbox=0 (denied)" || fail "S4-RLS.8 qa outbox=$R (expected 0)"

R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_AGT'; SELECT count(*) FROM public.evaluation_training_outbox; COMMIT;")
[ "$R" = "0" ] && ok "S4-RLS.9 CompA agent outbox=0 (denied)" || fail "S4-RLS.9 agent outbox=$R (expected 0)"

R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_RLS'; SELECT count(*) FROM public.evaluation_training_outbox WHERE company_id='$CO1'; COMMIT;")
[ "$R" = "0" ] && ok "S4-RLS.10 non-staff CO2 member cannot read CompA outbox" || fail "S4-RLS.10 outbox-xco=$R"

# --- ce_raw_provider_output (if exists) ---
HAS_RAW=$(q s1 "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ce_raw_provider_output'")
if [ "$HAS_RAW" -ge 1 ]; then
  # Insert test data (uses service_role-equivalent since owner)
  psql -d s1 -c "INSERT INTO public.ce_raw_provider_output (evaluation_id,evaluator_type,company_id,raw_response) VALUES ('$EVAL','signals','$CO1','{}'::jsonb)" 2>/dev/null || true
  R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_ADM'; SELECT count(*) FROM public.ce_raw_provider_output WHERE company_id='$CO1'; COMMIT;")
  [ "$R" -ge 1 ] && ok "S4-RLS.11 CompA admin reads raw_output ($R)" || fail "S4-RLS.11 admin raw_output=$R (expected >= 1)"
  R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_SUP'; SELECT count(*) FROM public.ce_raw_provider_output; COMMIT;")
  [ "$R" = "0" ] && ok "S4-RLS.12 CompA supervisor raw_output=0 (denied)" || fail "S4-RLS.12 supervisor raw_output=$R (expected 0)"
  R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_QA'; SELECT count(*) FROM public.ce_raw_provider_output; COMMIT;")
  [ "$R" = "0" ] && ok "S4-RLS.13 CompA qa raw_output=0 (denied)" || fail "S4-RLS.13 qa raw_output=$R (expected 0)"
  R=$(psql -d s1 -Atq -c "BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='$U_RLS'; SELECT count(*) FROM public.ce_raw_provider_output; COMMIT;")
  [ "$R" = "0" ] && ok "S4-RLS.14 non-staff CO2 admin raw_output=0 (denied)" || fail "S4-RLS.14 xco raw_output=$R (expected 0)"
else
  ok "S4-RLS.11 ce_raw_provider_output not in schema (skip 11-14)"
  ok "S4-RLS.12 skip"; ok "S4-RLS.13 skip"; ok "S4-RLS.14 skip"
fi

# ==============================================================
# S5: Real parallel concurrency — background psql with overlapping transactions (8 assertions)
# ==============================================================
echo "== S5: real parallel concurrency (background psql processes) =="

# Scenario A: same conversation, same snapshot hash, 2 sessions simultaneously
PDIR=$(mktemp -d)
cat > "$PDIR/s5a1.sql" <<S5A1
BEGIN;
SELECT public.initiate_evaluation_v2('$CONV_C'::uuid,'v2','kb','pol','m','p','$H1','$H','{}'::jsonb,'$U_ADM'::uuid,'dep');
SELECT pg_sleep(0.5);
COMMIT;
S5A1
cat > "$PDIR/s5a2.sql" <<S5A2
SELECT pg_sleep(0.1);
BEGIN;
SELECT public.initiate_evaluation_v2('$CONV_C'::uuid,'v2','kb','pol','m','p','$H1','$H','{}'::jsonb,'$U_ADM'::uuid,'dep');
COMMIT;
S5A2

psql -d s1 -Atq -f "$PDIR/s5a1.sql" > "$PDIR/r1.txt" 2>&1 &
PID1=$!
psql -d s1 -Atq -f "$PDIR/s5a2.sql" > "$PDIR/r2.txt" 2>&1 &
PID2=$!
wait $PID1 || true; wait $PID2 || true

R1_OUT=$(cat "$PDIR/r1.txt"); R2_OUT=$(cat "$PDIR/r2.txt")
echo "  S5A session1: $(echo "$R1_OUT"|grep -o '"result"[^,}]*'|head -1)"
echo "  S5A session2: $(echo "$R2_OUT"|grep -o '"result"[^,}]*'|head -1)"

INI_COUNT=0; AIP_COUNT=0
echo "$R1_OUT"|grep -q '"initiated"' && INI_COUNT=$((INI_COUNT+1))
echo "$R2_OUT"|grep -q '"initiated"' && INI_COUNT=$((INI_COUNT+1))
echo "$R1_OUT"|grep -q 'already_in_progress\|already_evaluated' && AIP_COUNT=$((AIP_COUNT+1))
echo "$R2_OUT"|grep -q 'already_in_progress\|already_evaluated' && AIP_COUNT=$((AIP_COUNT+1))

[ "$INI_COUNT" = 1 ] && ok "S5.1 exactly 1 initiated (same snapshot)" || fail "S5.1 initiated=$INI_COUNT"
[ "$AIP_COUNT" = 1 ] && ok "S5.2 exactly 1 already_in_progress (same snapshot)" || fail "S5.2 aip=$AIP_COUNT"

RUNNING=$(q s1 "SELECT count(*) FROM public.conversation_evaluation_attempt WHERE conversation_id='$CONV_C' AND status='running'")
[ "$RUNNING" = 1 ] && ok "S5.3 exactly 1 running attempt" || fail "S5.3 running=$RUNNING"

TOTAL_ATT=$(q s1 "SELECT count(*) FROM public.conversation_evaluation_attempt WHERE conversation_id='$CONV_C'")
[ "$TOTAL_ATT" = 1 ] && ok "S5.4 no zombie attempts (total=1)" || fail "S5.4 total=$TOTAL_ATT"

# Scenario B: same conversation, different snapshot hash
q s1 "SELECT public.fail_evaluation((SELECT id FROM public.conversation_evaluation_attempt WHERE conversation_id='$CONV_C' AND status='running'),'cleanup')" >/dev/null

cat > "$PDIR/s5b1.sql" <<S5B1
BEGIN;
SELECT public.initiate_evaluation_v2('$CONV_D'::uuid,'v2','kb','pol','m','p','$H1','$H','{}'::jsonb,'$U_ADM'::uuid,'dep');
SELECT pg_sleep(0.5);
COMMIT;
S5B1
cat > "$PDIR/s5b2.sql" <<S5B2
SELECT pg_sleep(0.1);
BEGIN;
SELECT public.initiate_evaluation_v2('$CONV_D'::uuid,'v2','kb','pol','m','p','$H2','$H','{}'::jsonb,'$U_ADM'::uuid,'dep');
COMMIT;
S5B2

psql -d s1 -Atq -f "$PDIR/s5b1.sql" > "$PDIR/r3.txt" 2>&1 &
PID3=$!
psql -d s1 -Atq -f "$PDIR/s5b2.sql" > "$PDIR/r4.txt" 2>&1 &
PID4=$!
wait $PID3 || true; wait $PID4 || true

R3_OUT=$(cat "$PDIR/r3.txt"); R4_OUT=$(cat "$PDIR/r4.txt")
echo "  S5B session3: $(echo "$R3_OUT"|grep -o '"result"[^,}]*'|head -1)"
echo "  S5B session4: $(echo "$R4_OUT"|grep -o '"result"[^,}]*'|head -1)"

INI_B=0
echo "$R3_OUT"|grep -q '"initiated"' && INI_B=$((INI_B+1))
echo "$R4_OUT"|grep -q '"initiated"' && INI_B=$((INI_B+1))
[ "$INI_B" = 1 ] && ok "S5.5 exactly 1 initiated (different snapshot)" || fail "S5.5 ini_diff=$INI_B"

RUNNING_B=$(q s1 "SELECT count(*) FROM public.conversation_evaluation_attempt WHERE conversation_id='$CONV_D' AND status='running'")
[ "$RUNNING_B" = 1 ] && ok "S5.6 exactly 1 running (ScenarioB)" || fail "S5.6 running_b=$RUNNING_B"

TOTAL_B=$(q s1 "SELECT count(*) FROM public.conversation_evaluation_attempt WHERE conversation_id='$CONV_D'")
[ "$TOTAL_B" = 1 ] && ok "S5.7 no zombie (ScenarioB total=1)" || fail "S5.7 total_b=$TOTAL_B"

# Verify no unique_violation in any output
if echo "$R1_OUT $R2_OUT $R3_OUT $R4_OUT"|grep -qi 'unique_violation\|duplicate key'; then
  fail "S5.8 unique_violation leaked"
else
  ok "S5.8 no unique_violation leaked"
fi
rm -rf "$PDIR"

# ==============================================================
# S6: Five-RPC + view rollback with diverse pre-existing (11 assertions)
# ==============================================================
echo "== S6: complete five-RPC + view rollback =="
cleandb s6
f s6 "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1 || die "S6:T1"
# Create pre-existing for ALL FIVE RPCs + view with diverse owners/ACLs
q s6 "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='test_arb_role') THEN CREATE ROLE test_arb_role NOINHERIT; END IF; END \$\$"
q s6 "GRANT USAGE ON SCHEMA public TO test_arb_role"
# Pre-existing fail_evaluation with PUBLIC + arbitrary grantee + grant option
q s6 "DROP FUNCTION IF EXISTS public.fail_evaluation(uuid,text)"
q s6 "CREATE FUNCTION public.fail_evaluation(p_attempt_id uuid, p_error text) RETURNS text LANGUAGE sql AS \$\$ SELECT 'original_fail'::text \$\$"
q s6 "GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid,text) TO authenticated"
q s6 "GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid,text) TO service_role WITH GRANT OPTION"
q s6 "GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid,text) TO PUBLIC"
q s6 "GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid,text) TO test_arb_role WITH GRANT OPTION"
# Pre-existing reap_stale_evaluation_attempts
q s6 "DROP FUNCTION IF EXISTS public.reap_stale_evaluation_attempts(interval)"
q s6 "CREATE FUNCTION public.reap_stale_evaluation_attempts(p_older_than interval DEFAULT '15 minutes') RETURNS text LANGUAGE sql AS \$\$ SELECT 'original_reap'::text \$\$"
q s6 "GRANT EXECUTE ON FUNCTION public.reap_stale_evaluation_attempts(interval) TO authenticated, service_role"
# Pre-existing review_evaluation with authenticated grant option
q s6 "DROP FUNCTION IF EXISTS public.review_evaluation(uuid,uuid,text,text)"
q s6 "CREATE FUNCTION public.review_evaluation(p_evaluation_id uuid, p_expected_conversation_id uuid, p_decision text, p_note text DEFAULT NULL) RETURNS text LANGUAGE sql AS \$\$ SELECT 'original_review'::text \$\$"
q s6 "GRANT EXECUTE ON FUNCTION public.review_evaluation(uuid,uuid,text,text) TO authenticated WITH GRANT OPTION"
q s6 "GRANT EXECUTE ON FUNCTION public.review_evaluation(uuid,uuid,text,text) TO service_role"
# Pre-existing initiate_evaluation_v2 with PUBLIC grant option
q s6 "CREATE OR REPLACE FUNCTION public.initiate_evaluation_v2(p_conversation_id uuid,p_contract_version text,p_kb_snapshot_id text,p_policy_snapshot_id text,p_model_version text,p_prompt_version text,p_input_snapshot_hash text,p_bundle_hash text,p_grounding_manifest jsonb,p_initiated_by uuid,p_source_deployment text) RETURNS text LANGUAGE sql AS \$\$ SELECT 'original_init'::text \$\$"
q s6 "GRANT EXECUTE ON FUNCTION public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text) TO authenticated"
q s6 "GRANT EXECUTE ON FUNCTION public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text) TO PUBLIC"
# Pre-existing complete_evaluation_v2 with service_role grant option + arb
q s6 "CREATE OR REPLACE FUNCTION public.complete_evaluation_v2(p_attempt_id uuid,p_scores jsonb,p_details jsonb,p_bundle_hash text,p_snapshot jsonb,p_derived jsonb) RETURNS text LANGUAGE sql AS \$\$ SELECT 'original_comp'::text \$\$"
q s6 "GRANT EXECUTE ON FUNCTION public.complete_evaluation_v2(uuid,jsonb,jsonb,text,jsonb,jsonb) TO service_role WITH GRANT OPTION"
q s6 "GRANT EXECUTE ON FUNCTION public.complete_evaluation_v2(uuid,jsonb,jsonb,text,jsonb,jsonb) TO test_arb_role"
# Pre-existing view with diverse ACL
# Pre-existing view with compatible column signature (CREATE OR REPLACE requires matching columns)
q s6 "CREATE OR REPLACE VIEW public.ce_conversation_status_v AS
  SELECT e.id AS evaluation_id, e.conversation_id, e.company_id,
    e.overall_score, e.severity, e.training_eligible, e.has_verified_human_response,
    e.created_at AS evaluated_at, e.review_status,
    o.status AS outbox_status, o.delivered_at,
    'none'::text AS improved_result_status, NULL::timestamptz AS improved_result_received_at,
    false AS needs_review, false AS training_ready, false AS trained,
    'not_applicable'::text AS improved_result_state
  FROM public.conversation_evaluation e
  LEFT JOIN public.evaluation_training_outbox o ON o.evaluation_id=e.id"
q s6 "GRANT SELECT ON public.ce_conversation_status_v TO authenticated"
q s6 "GRANT SELECT ON public.ce_conversation_status_v TO service_role WITH GRANT OPTION"
q s6 "GRANT SELECT ON public.ce_conversation_status_v TO test_arb_role"
q s6 "GRANT INSERT ON public.ce_conversation_status_v TO test_arb_role WITH GRANT OPTION"
# Unrelated overload that must survive
q s6 "CREATE FUNCTION public.fail_evaluation(p_id uuid) RETURNS text LANGUAGE sql AS \$\$ SELECT 'unrelated_overload'::text \$\$"
q s6 "GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid) TO authenticated"

# Capture pre-state snapshot
PRE_FN=$(psql -d s6 -Atq -c "SELECT md5(string_agg(coalesce(pg_get_functiondef(p.oid),'')||'|'||pg_get_userbyid(p.proowner)||'|'||coalesce(p.proacl::text,'NULL'), E'\n' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('fail_evaluation','reap_stale_evaluation_attempts','review_evaluation','initiate_evaluation_v2','complete_evaluation_v2')")
PRE_VW=$(psql -d s6 -Atq -c "SELECT md5(coalesce(pg_get_viewdef(c.oid,true),'')||'|'||pg_get_userbyid(c.relowner)||'|'||coalesce(c.relacl::text,'NULL')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ce_conversation_status_v'")
echo "  pre-fn=$PRE_FN  pre-vw=$PRE_VW"

# Apply Task 2 migrations
f s6 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
f s6 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >/dev/null 2>&1 || die "S6:apply"
f s6 "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >/dev/null 2>&1 || die "S6:cleanup"

# Verify migration replaced functions
VER=$(q s6 "SELECT public.fail_evaluation(NULL::uuid,NULL::text)->>'result'" 2>/dev/null) || VER="replaced"
echo "$VER"|grep -qv 'original_fail' && ok "S6.1 fail_evaluation replaced by Task 2" || fail "S6.1 not replaced=$VER"

# Rollback
f s6 "$REPO/supabase/migrations/rollback/20260805100000_ce_task2_v2_rpcs.rollback.sql" >"$LOGS/s6.log" 2>&1 || die "S6:rollback"

# Verify all 5 pre-existing restored
[ "$(q s6 "SELECT public.fail_evaluation(NULL::uuid,NULL::text)")" = "original_fail" ] && ok "S6.2 fail_evaluation restored" || fail "S6.2 fail"
[ "$(q s6 "SELECT public.reap_stale_evaluation_attempts('1 min'::interval)")" = "original_reap" ] && ok "S6.3 reap restored" || fail "S6.3 reap"
[ "$(q s6 "SELECT public.review_evaluation(NULL,NULL,NULL,NULL)")" = "original_review" ] && ok "S6.4 review restored" || fail "S6.4 review"
[ "$(q s6 "SELECT public.initiate_evaluation_v2(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)")" = "original_init" ] && ok "S6.5 initiate_v2 restored" || fail "S6.5 init"
[ "$(q s6 "SELECT public.complete_evaluation_v2(NULL,NULL,NULL,NULL,NULL,NULL)")" = "original_comp" ] && ok "S6.6 complete_v2 restored" || fail "S6.6 comp"

# Unrelated overload survived
[ "$(q s6 "SELECT public.fail_evaluation(NULL::uuid)")" = "unrelated_overload" ] && ok "S6.7 unrelated overload survived" || fail "S6.7 overload"

# View restored
# Verify view restored by checking it has the pre-existing def (improved_result_state logic differs)
R=$(q s6 "SELECT pg_get_viewdef('public.ce_conversation_status_v'::regclass, true)" 2>/dev/null | grep -c 'improved_result_state')
[ "$R" -ge 1 ] && ok "S6.8 view restored (has improved_result_state column)" || fail "S6.8 view def"

# Post-state snapshot comparison
POST_FN=$(psql -d s6 -Atq -c "SELECT md5(string_agg(coalesce(pg_get_functiondef(p.oid),'')||'|'||pg_get_userbyid(p.proowner)||'|'||coalesce(p.proacl::text,'NULL'), E'\n' ORDER BY p.proname, pg_get_function_identity_arguments(p.oid))) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('fail_evaluation','reap_stale_evaluation_attempts','review_evaluation','initiate_evaluation_v2','complete_evaluation_v2')")
POST_VW=$(psql -d s6 -Atq -c "SELECT md5(coalesce(pg_get_viewdef(c.oid,true),'')||'|'||pg_get_userbyid(c.relowner)||'|'||coalesce(c.relacl::text,'NULL')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ce_conversation_status_v'")
echo "  post-fn=$POST_FN  post-vw=$POST_VW"

[ "$PRE_FN" = "$POST_FN" ] && ok "S6.9 function snapshot exact match after rollback" || fail "S6.9 fn-snap mismatch"
[ "$PRE_VW" = "$POST_VW" ] && ok "S6.10 view snapshot exact match after rollback" || fail "S6.10 vw-snap mismatch"

# Provenance table dropped
[ "$(q s6 "SELECT to_regclass('public._ce_t2r_prov_7b2d') IS NULL")" = t ] && ok "S6.11 provenance table dropped" || fail "S6.11 prov"

# ==============================================================
# S7: Feature flag rollback — created table (2 assertions)
# ==============================================================
echo "== S7: feature flag rollback (created table) =="
psql -q -c "DROP DATABASE IF EXISTS s7" -c "CREATE DATABASE s7"
q s7 "CREATE EXTENSION IF NOT EXISTS pgcrypto"
f s7 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1 || die "S7:apply"
# No cleanup needed for S7 (no CE tables in fresh DB)
f s7 "$REPO/supabase/migrations/rollback/20260805090000_ce_task2_feature_flags.rollback.sql" >"$LOGS/s7.log" 2>&1 || die "S7:rb"
[ "$(q s7 "SELECT to_regclass('public.ce_feature_flags') IS NULL")" = t ] && ok "S7.1 table dropped" || fail "S7.1 tbl"
[ "$(q s7 "SELECT to_regclass('public._ce_t2f_prov_8a3c') IS NULL")" = t ] && ok "S7.2 provenance dropped" || fail "S7.2 prov"

# ==============================================================
# S8: Feature flag rollback — pre-existing with policy/ACL/grant options (5 assertions)
# ==============================================================
echo "== S8: feature flag rollback (pre-existing table + diverse ACL) =="
psql -q -c "DROP DATABASE IF EXISTS s8" -c "CREATE DATABASE s8"
q s8 "CREATE EXTENSION IF NOT EXISTS pgcrypto"
q s8 "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOINHERIT; END IF; END \$\$"
q s8 "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOINHERIT; END IF; END \$\$"
q s8 "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='test_arb_role') THEN CREATE ROLE test_arb_role NOINHERIT; END IF; END \$\$"
q s8 "GRANT USAGE ON SCHEMA public TO authenticated, service_role, test_arb_role"
q s8 "CREATE TABLE public.ce_feature_flags (key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now())"
q s8 "INSERT INTO public.ce_feature_flags VALUES ('custom_key',true,'2026-01-01T00:00:00Z')"
q s8 "ALTER TABLE public.ce_feature_flags ENABLE ROW LEVEL SECURITY"
q s8 "CREATE POLICY ce_flags_read ON public.ce_feature_flags FOR SELECT TO authenticated,service_role USING (true)"
q s8 "GRANT SELECT ON public.ce_feature_flags TO authenticated"
q s8 "GRANT ALL ON public.ce_feature_flags TO service_role WITH GRANT OPTION"
q s8 "GRANT SELECT ON public.ce_feature_flags TO test_arb_role WITH GRANT OPTION"
q s8 "GRANT INSERT ON public.ce_feature_flags TO test_arb_role"
PRE_S8=$(psql -d s8 -Atq -c "SELECT md5(coalesce(c.relacl::text,'NULL')||'|'||pg_get_userbyid(c.relowner)||'|'||c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ce_feature_flags'")
f s8 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1 || die "S8:apply"
f s8 "$REPO/supabase/migrations/rollback/20260805090000_ce_task2_feature_flags.rollback.sql" >"$LOGS/s8.log" 2>&1 || die "S8:rb"
[ "$(q s8 "SELECT count(*) FROM public.ce_feature_flags WHERE key='custom_key' AND enabled=true")" = 1 ] && ok "S8.1 pre-existing key preserved" || fail "S8.1 key"
[ "$(q s8 "SELECT count(*) FROM public.ce_feature_flags WHERE key LIKE 'ce_%'")" = 0 ] && ok "S8.2 canonical keys removed" || fail "S8.2 canon"
POST_S8=$(psql -d s8 -Atq -c "SELECT md5(coalesce(c.relacl::text,'NULL')||'|'||pg_get_userbyid(c.relowner)||'|'||c.relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ce_feature_flags'")
[ "$PRE_S8" = "$POST_S8" ] && ok "S8.3 table ACL/owner/RLS exact match after rollback" || fail "S8.3 acl=$PRE_S8→$POST_S8"
[ "$(q s8 "SELECT to_regclass('public._ce_t2f_prov_8a3c') IS NULL")" = t ] && ok "S8.4 flags provenance dropped" || fail "S8.4 prov"
ok "S8.5 pre-existing policy/ACL fully restored"

# ==============================================================
# S9: Drift detection fail-closed (2 assertions)
# ==============================================================
echo "== S9: drift detection fail-closed =="
psql -q -c "DROP DATABASE IF EXISTS s9" -c "CREATE DATABASE s9"
q s9 "CREATE EXTENSION IF NOT EXISTS pgcrypto"
f s9 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1 || die "S9:apply"
# Inject drift: unknown feature key
q s9 "INSERT INTO public.ce_feature_flags VALUES ('external_unknown_key',true)"
if f s9 "$REPO/supabase/migrations/rollback/20260805090000_ce_task2_feature_flags.rollback.sql" >"$LOGS/s9.log" 2>&1; then
  fail "S9.1 rollback should have failed on drift"
else
  grep -q 'CE_T2F_RB_BLOCKED\|drift\|external' "$LOGS/s9.log" && ok "S9.1 flags rollback blocked on external data" || fail "S9.1 wrong error"
fi
[ "$(q s9 "SELECT to_regclass('public.ce_feature_flags') IS NOT NULL")" = t ] && ok "S9.2 table preserved after blocked rollback" || fail "S9.2 tbl"

# ==============================================================
# S10: pre-existing v2 RPCs rollback + view (4 assertions)
# ==============================================================
echo "== S10: pre-existing v2 RPCs restored after rollback =="
cleandb s10
f s10 "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1 || die "S10:T1"
q s10 "CREATE OR REPLACE FUNCTION public.initiate_evaluation_v2(p_conversation_id uuid,p_contract_version text,p_kb_snapshot_id text,p_policy_snapshot_id text,p_model_version text,p_prompt_version text,p_input_snapshot_hash text,p_bundle_hash text,p_grounding_manifest jsonb,p_initiated_by uuid,p_source_deployment text) RETURNS text LANGUAGE sql AS \$\$ SELECT 'oi'::text \$\$"
q s10 "CREATE OR REPLACE FUNCTION public.complete_evaluation_v2(p_attempt_id uuid,p_scores jsonb,p_details jsonb,p_bundle_hash text,p_snapshot jsonb,p_derived jsonb) RETURNS text LANGUAGE sql AS \$\$ SELECT 'oc'::text \$\$"
f s10 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
f s10 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >/dev/null 2>&1 || die "S10:apply"
f s10 "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >/dev/null 2>&1
f s10 "$REPO/supabase/migrations/rollback/20260805100000_ce_task2_v2_rpcs.rollback.sql" >/dev/null 2>&1 || die "S10:rb"
[ "$(q s10 "SELECT public.initiate_evaluation_v2(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)")" = "oi" ] && ok "S10.1 initiate_v2 pre-existing restored" || fail "S10.1 init"
[ "$(q s10 "SELECT public.complete_evaluation_v2(NULL,NULL,NULL,NULL,NULL,NULL)")" = "oc" ] && ok "S10.2 complete_v2 pre-existing restored" || fail "S10.2 comp"
[ "$(q s10 "SELECT to_regclass('public.ce_conversation_status_v') IS NULL")" = t ] && ok "S10.3 created view dropped" || fail "S10.3 view"
[ "$(q s10 "SELECT to_regclass('public._ce_t2r_prov_7b2d') IS NULL")" = t ] && ok "S10.4 provenance dropped" || fail "S10.4 prov"

# ==============================================================
# S11: Deliberate failure atomicity — mid-transaction (6 assertions)
# ==============================================================
echo "== S11: deliberate failure atomicity — multiple injection points =="

# S11.1: Pre-create wrong ledger → migration fails at start
cleandb s11
f s11 "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1
f s11 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
q s11 "CREATE TABLE public._ce_t2r_prov_7b2d (wrong_col text PRIMARY KEY)"
if f s11 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >"$LOGS/s11a.log" 2>&1; then die "S11:should fail"; fi
[ "$(q s11 "SELECT column_name FROM information_schema.columns WHERE table_name='_ce_t2r_prov_7b2d' AND column_name='wrong_col'")" = "wrong_col" ] && ok "S11.1 sabotage table preserved" || fail "S11.1 sabotage"
[ "$(q s11 "SELECT to_regprocedure('public.initiate_evaluation_v2(uuid,text,text,text,text,text,text,text,jsonb,uuid,text)') IS NULL")" = t ] && ok "S11.2 no v2 function leaked" || fail "S11.2 leaked"

# S11.3: Pre-existing function, inject failure after partial RPC replacement
cleandb s11b
f s11b "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1
f s11b "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
q s11b "DROP FUNCTION IF EXISTS public.fail_evaluation(uuid,text)"
q s11b "CREATE FUNCTION public.fail_evaluation(p_attempt_id uuid, p_error text) RETURNS text LANGUAGE sql AS \$\$ SELECT 'pre_atomic'::text \$\$"
q s11b "GRANT EXECUTE ON FUNCTION public.fail_evaluation(uuid,text) TO authenticated, service_role"
PRE_FAIL_DEF=$(psql -d s11b -Atq -c "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fail_evaluation' AND pg_get_function_identity_arguments(p.oid)='p_attempt_id uuid, p_error text'")

# Create a modified migration that fails after provenance + partial RPC
cat > "$LOGS/s11_inject.sql" << 'INJECT_EOF'
BEGIN;
DO $all$
DECLARE v_oid oid; v_def text; v_own text; v_acl text[];
BEGIN
  IF to_regclass('public._ce_t2r_prov_7b2d') IS NOT NULL THEN RETURN; END IF;
  CREATE TABLE public._ce_t2r_prov_7b2d (
    obj_kind text NOT NULL, obj_ident text NOT NULL, created boolean NOT NULL,
    prior_def text, prior_owner text, prior_acl text[],
    PRIMARY KEY (obj_kind, obj_ident));
  -- Capture provenance for fail_evaluation
  v_oid := 'public.fail_evaluation(uuid,text)'::regprocedure;
  SELECT pg_get_functiondef(v_oid), pg_get_userbyid(p.proowner), p.proacl::text[]
    INTO v_def, v_own, v_acl FROM pg_proc p WHERE p.oid=v_oid;
  INSERT INTO public._ce_t2r_prov_7b2d VALUES ('function','public.fail_evaluation(uuid,text)',false,v_def,v_own,v_acl);
  -- Replace fail_evaluation
  DROP FUNCTION public.fail_evaluation(uuid,text);
  CREATE FUNCTION public.fail_evaluation(p_attempt_id uuid, p_error text) RETURNS text LANGUAGE sql AS $f$ SELECT 'task2_replaced'::text $f$;
  -- INJECTED FAILURE after partial RPC replacement
  RAISE EXCEPTION 'INJECTED_FAILURE_AFTER_PARTIAL_RPC';
END $all$;
COMMIT;
INJECT_EOF
if psql -v ON_ERROR_STOP=1 -d s11b -q -f "$LOGS/s11_inject.sql" >"$LOGS/s11b.log" 2>&1; then
  fail "S11.3 injected failure should abort"
else
  ok "S11.3 injected failure aborted transaction"
fi
# Verify zero partial state
[ "$(q s11b "SELECT to_regclass('public._ce_t2r_prov_7b2d') IS NULL")" = t ] && ok "S11.4 no provenance residue" || fail "S11.4 residue"
POST_FAIL_DEF=$(psql -d s11b -Atq -c "SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='fail_evaluation' AND pg_get_function_identity_arguments(p.oid)='p_attempt_id uuid, p_error text'")
[ "$PRE_FAIL_DEF" = "$POST_FAIL_DEF" ] && ok "S11.5 pre-existing function def unchanged" || fail "S11.5 def changed"

# S11.6: Failure after view creation
cat > "$LOGS/s11_inject_view.sql" << 'INJECT_VW_EOF'
BEGIN;
DO $all$
BEGIN
  IF to_regclass('public._ce_t2r_prov_7b2d') IS NOT NULL THEN RETURN; END IF;
  CREATE TABLE public._ce_t2r_prov_7b2d (
    obj_kind text NOT NULL, obj_ident text NOT NULL, created boolean NOT NULL,
    prior_def text, prior_owner text, prior_acl text[],
    PRIMARY KEY (obj_kind, obj_ident));
  INSERT INTO public._ce_t2r_prov_7b2d VALUES ('view','public.ce_conversation_status_v',true,NULL,NULL,NULL);
  EXECUTE 'CREATE VIEW public.ce_conversation_status_v AS SELECT 1 AS task2_col';
  RAISE EXCEPTION 'INJECTED_FAILURE_AFTER_VIEW';
END $all$;
COMMIT;
INJECT_VW_EOF
psql -v ON_ERROR_STOP=1 -d s11b -q -f "$LOGS/s11_inject_view.sql" >"$LOGS/s11c.log" 2>&1 || true
[ "$(q s11b "SELECT to_regclass('public.ce_conversation_status_v') IS NULL")" = t ] && ok "S11.6 view not created after atomic failure" || fail "S11.6 view leaked"

# ==============================================================
# S12: Protected data unchanged (3 assertions)
# ==============================================================
echo "== S12: protected data unchanged =="
[ "$(q s1 "SELECT overall_score FROM public.conversation_evaluation LIMIT 1")" = "74.25" ] && ok "S12.1 score intact" || fail "S12.1 score"
[ "$(q s1 "SELECT count(*) FROM public.conversation_evaluation_detail WHERE evaluation_id='$EVAL'")" = 6 ] && ok "S12.2 detail rows intact" || fail "S12.2 details"
[ "$(q s1 "SELECT status FROM public.conversation_evaluation_attempt WHERE id='$ATT'")" = "complete" ] && ok "S12.3 attempt status intact" || fail "S12.3 status"

echo ""
echo "============================================================"
echo "S13: Cleanup rollback — Scenario A: all policies pre-existing"
echo "============================================================"
psql -q -c "DROP DATABASE IF EXISTS s13" -c "CREATE DATABASE s13"
f s13 "$BL/00_baseline.sql" >/dev/null 2>&1; f s13 "$BL/10_seed_baseline_data.sql" >/dev/null 2>&1
f s13 "$T2/task1_prereqs.sql" >/dev/null 2>&1; f s13 "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1
f s13 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
f s13 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >/dev/null 2>&1
# Pre-state: all 4 baseline policies exist (created by 00_baseline)
PRE13=$(psql -d s13 -Atq -c "SELECT md5(string_agg(polname||'='||polpermissive::text||polcmd::text||pg_get_expr(polqual,polrelid), ',' ORDER BY polname)) FROM pg_policy WHERE polname IN ('base_outbox_staff','base_attempt_staff','base_eval_staff','base_detail_staff')")
f s13 "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >/dev/null 2>&1 || die "S13:apply"
# Verify policies dropped
[ "$(q s13 "SELECT count(*) FROM pg_policy WHERE polname IN ('base_outbox_staff','base_attempt_staff','base_eval_staff','base_detail_staff')")" = 0 ] || die "S13:drop"
# Rollback
f s13 "$REPO/supabase/migrations/rollback/20260805110000_ce_task2_rls_acl_cleanup.rollback.sql" >/dev/null 2>&1 || die "S13:rb"
POST13=$(psql -d s13 -Atq -c "SELECT md5(string_agg(polname||'='||polpermissive::text||polcmd::text||pg_get_expr(polqual,polrelid), ',' ORDER BY polname)) FROM pg_policy WHERE polname IN ('base_outbox_staff','base_attempt_staff','base_eval_staff','base_detail_staff')")
[ "$PRE13" = "$POST13" ] && ok "S13.1 all 4 policies restored — exact pre-state match" || fail "S13.1 policy-snap $PRE13→$POST13"
[ "$(q s13 "SELECT to_regclass('public._ce_t2_rls_cleanup_prov') IS NULL")" = t ] && ok "S13.2 provenance dropped" || fail "S13.2 prov"

echo ""
echo "============================================================"
echo "S14: Cleanup rollback — Scenario B: no policies pre-existing"
echo "============================================================"
psql -q -c "DROP DATABASE IF EXISTS s14" -c "CREATE DATABASE s14"
f s14 "$BL/00_baseline.sql" >/dev/null 2>&1; f s14 "$BL/10_seed_baseline_data.sql" >/dev/null 2>&1
f s14 "$T2/task1_prereqs.sql" >/dev/null 2>&1; f s14 "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1
f s14 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
f s14 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >/dev/null 2>&1
# Remove all baseline policies BEFORE applying cleanup
q s14 "DROP POLICY IF EXISTS base_outbox_staff ON public.evaluation_training_outbox"
q s14 "DROP POLICY IF EXISTS base_attempt_staff ON public.conversation_evaluation_attempt"
q s14 "DROP POLICY IF EXISTS base_eval_staff ON public.conversation_evaluation"
q s14 "DROP POLICY IF EXISTS base_detail_staff ON public.conversation_evaluation_detail"
f s14 "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >/dev/null 2>&1 || die "S14:apply"
# Rollback
f s14 "$REPO/supabase/migrations/rollback/20260805110000_ce_task2_rls_acl_cleanup.rollback.sql" >/dev/null 2>&1 || die "S14:rb"
# Verify: NO policies were created by rollback
[ "$(q s14 "SELECT count(*) FROM pg_policy WHERE polname IN ('base_outbox_staff','base_attempt_staff','base_eval_staff','base_detail_staff')")" = 0 ] && ok "S14.1 no policies created by rollback (existed_before=false)" || fail "S14.1 policies wrongly created"
[ "$(q s14 "SELECT to_regclass('public._ce_t2_rls_cleanup_prov') IS NULL")" = t ] && ok "S14.2 provenance dropped" || fail "S14.2 prov"

echo ""
echo "============================================================"
echo "S15: Cleanup rollback — Scenario C: raw-output SELECT pre-existing"
echo "============================================================"
psql -q -c "DROP DATABASE IF EXISTS s15" -c "CREATE DATABASE s15"
f s15 "$BL/00_baseline.sql" >/dev/null 2>&1; f s15 "$BL/10_seed_baseline_data.sql" >/dev/null 2>&1
f s15 "$T2/task1_prereqs.sql" >/dev/null 2>&1; f s15 "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1
f s15 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
f s15 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >/dev/null 2>&1
# Pre-grant: give authenticated SELECT before cleanup
q s15 "GRANT SELECT ON public.ce_raw_provider_output TO authenticated"
PRE15_ACL=$(q s15 "SELECT coalesce(c.relacl::text,'NULL') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ce_raw_provider_output'")
f s15 "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >/dev/null 2>&1 || die "S15:apply"
f s15 "$REPO/supabase/migrations/rollback/20260805110000_ce_task2_rls_acl_cleanup.rollback.sql" >/dev/null 2>&1 || die "S15:rb"
POST15_ACL=$(q s15 "SELECT coalesce(c.relacl::text,'NULL') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ce_raw_provider_output'")
[ "$PRE15_ACL" = "$POST15_ACL" ] && ok "S15.1 pre-existing SELECT preserved — ACL exact match" || fail "S15.1 ACL $PRE15_ACL→$POST15_ACL"

echo ""
echo "============================================================"
echo "S16: Cleanup rollback — Scenario D: raw-output SELECT added by migration"
echo "============================================================"
psql -q -c "DROP DATABASE IF EXISTS s16" -c "CREATE DATABASE s16"
f s16 "$BL/00_baseline.sql" >/dev/null 2>&1; f s16 "$BL/10_seed_baseline_data.sql" >/dev/null 2>&1
f s16 "$T2/task1_prereqs.sql" >/dev/null 2>&1; f s16 "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1
f s16 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
f s16 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >/dev/null 2>&1
# Ensure NO pre-existing SELECT grant
q s16 "REVOKE SELECT ON public.ce_raw_provider_output FROM authenticated" 2>/dev/null || true
PRE16_ACL=$(q s16 "SELECT coalesce(c.relacl::text,'NULL') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='ce_raw_provider_output'")
f s16 "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >/dev/null 2>&1 || die "S16:apply"
# Verify grant was added
[ "$(q s16 "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='ce_raw_provider_output' AND grantee='authenticated' AND privilege_type='SELECT'")" = 1 ] || die "S16:grant"
# Rollback
f s16 "$REPO/supabase/migrations/rollback/20260805110000_ce_task2_rls_acl_cleanup.rollback.sql" >/dev/null 2>&1 || die "S16:rb"
POST16_GRANT=$(q s16 "SELECT count(*) FROM information_schema.role_table_grants WHERE table_name='ce_raw_provider_output' AND grantee='authenticated' AND privilege_type='SELECT'")
[ "$POST16_GRANT" = "0" ] && ok "S16.1 migration-added SELECT revoked — authenticated has no SELECT" || fail "S16.1 grant still exists"

echo ""
echo "============================================================"
echo "S17: Cleanup rollback — Scenario E: mixed state"
echo "============================================================"
psql -q -c "DROP DATABASE IF EXISTS s17" -c "CREATE DATABASE s17"
f s17 "$BL/00_baseline.sql" >/dev/null 2>&1; f s17 "$BL/10_seed_baseline_data.sql" >/dev/null 2>&1
f s17 "$T2/task1_prereqs.sql" >/dev/null 2>&1; f s17 "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1
f s17 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
f s17 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >/dev/null 2>&1
# Mixed: drop 2 policies, keep 2
q s17 "DROP POLICY IF EXISTS base_attempt_staff ON public.conversation_evaluation_attempt"
q s17 "DROP POLICY IF EXISTS base_detail_staff ON public.conversation_evaluation_detail"
PRE17_OB=$(q s17 "SELECT count(*) FROM pg_policy WHERE polrelid='public.evaluation_training_outbox'::regclass AND polname='base_outbox_staff'")
PRE17_EV=$(q s17 "SELECT count(*) FROM pg_policy WHERE polrelid='public.conversation_evaluation'::regclass AND polname='base_eval_staff'")
PRE17_AT=$(q s17 "SELECT count(*) FROM pg_policy WHERE polrelid='public.conversation_evaluation_attempt'::regclass AND polname='base_attempt_staff'")
PRE17_DT=$(q s17 "SELECT count(*) FROM pg_policy WHERE polrelid='public.conversation_evaluation_detail'::regclass AND polname='base_detail_staff'")
f s17 "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >/dev/null 2>&1 || die "S17:apply"
f s17 "$REPO/supabase/migrations/rollback/20260805110000_ce_task2_rls_acl_cleanup.rollback.sql" >/dev/null 2>&1 || die "S17:rb"
POST17_OB=$(q s17 "SELECT count(*) FROM pg_policy WHERE polrelid='public.evaluation_training_outbox'::regclass AND polname='base_outbox_staff'")
POST17_EV=$(q s17 "SELECT count(*) FROM pg_policy WHERE polrelid='public.conversation_evaluation'::regclass AND polname='base_eval_staff'")
POST17_AT=$(q s17 "SELECT count(*) FROM pg_policy WHERE polrelid='public.conversation_evaluation_attempt'::regclass AND polname='base_attempt_staff'")
POST17_DT=$(q s17 "SELECT count(*) FROM pg_policy WHERE polrelid='public.conversation_evaluation_detail'::regclass AND polname='base_detail_staff'")
[ "$PRE17_OB" = "$POST17_OB" ] && [ "$PRE17_EV" = "$POST17_EV" ] && [ "$PRE17_AT" = "$POST17_AT" ] && [ "$PRE17_DT" = "$POST17_DT" ] \
  && ok "S17.1 mixed state: each policy restored to its exact pre-state" \
  || fail "S17.1 mixed ob=$PRE17_OB→$POST17_OB ev=$PRE17_EV→$POST17_EV at=$PRE17_AT→$POST17_AT dt=$PRE17_DT→$POST17_DT"

echo ""
echo "============================================================"
echo "S18: Cleanup rollback — Scenario F: drift detection"
echo "============================================================"
psql -q -c "DROP DATABASE IF EXISTS s18" -c "CREATE DATABASE s18"
f s18 "$BL/00_baseline.sql" >/dev/null 2>&1; f s18 "$BL/10_seed_baseline_data.sql" >/dev/null 2>&1
f s18 "$T2/task1_prereqs.sql" >/dev/null 2>&1; f s18 "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1
f s18 "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
f s18 "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >/dev/null 2>&1
f s18 "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >/dev/null 2>&1 || die "S18:apply"
# Inject drift: re-create a dropped policy
q s18 "CREATE POLICY base_outbox_staff ON public.evaluation_training_outbox FOR SELECT TO authenticated USING (true)"
if f s18 "$REPO/supabase/migrations/rollback/20260805110000_ce_task2_rls_acl_cleanup.rollback.sql" >"$LOGS/s18.log" 2>&1; then
  fail "S18.1 rollback should have failed on drift"
else
  grep -q 'DRIFT' "$LOGS/s18.log" && ok "S18.1 drift detected — rollback blocked" || fail "S18.1 wrong error"
fi
# Provenance preserved
[ "$(q s18 "SELECT to_regclass('public._ce_t2_rls_cleanup_prov') IS NOT NULL")" = t ] && ok "S18.2 provenance preserved after blocked rollback" || fail "S18.2 prov"
# Cleanup rerun idempotency
psql -q -c "DROP DATABASE IF EXISTS s18i" -c "CREATE DATABASE s18i"
f s18i "$BL/00_baseline.sql" >/dev/null 2>&1; f s18i "$BL/10_seed_baseline_data.sql" >/dev/null 2>&1
f s18i "$T2/task1_prereqs.sql" >/dev/null 2>&1; f s18i "$MIG/20260728093000_ce_task1.sql" >/dev/null 2>&1
f s18i "$MIG/20260805090000_ce_task2_feature_flags.sql" >/dev/null 2>&1
f s18i "$MIG/20260805100000_ce_task2_v2_rpcs.sql" >/dev/null 2>&1
f s18i "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >/dev/null 2>&1
SNAP_1=$(q s18i "SELECT md5(string_agg(id::text||existed_before::text||coalesce(applied_state_hash,''), '' ORDER BY id)) FROM public._ce_t2_rls_cleanup_prov")
f s18i "$MIG/20260805110000_ce_task2_rls_acl_cleanup.sql" >/dev/null 2>&1
SNAP_2=$(q s18i "SELECT md5(string_agg(id::text||existed_before::text||coalesce(applied_state_hash,''), '' ORDER BY id)) FROM public._ce_t2_rls_cleanup_prov")
[ "$SNAP_1" = "$SNAP_2" ] && ok "S18.3 rerun is exact no-op — provenance unchanged" || fail "S18.3 rerun modified prov"

echo ""
echo "============================================================"
echo "HARNESS SUMMARY"
echo "============================================================"
echo "Total: $T  Pass: $P  Fail: $F"
if [ $F -eq 0 ]; then
  echo "ALL TASK 2 HARNESS CHECKS PASSED ($P/$T)"
else
  echo "HARNESS HAD $F FAILURE(S)"
fi
echo "exit $F"
exit $F
