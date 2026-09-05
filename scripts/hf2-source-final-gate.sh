#!/usr/bin/env bash
set -euo pipefail
MIG="supabase/migrations/20260905123000_hf2_structured_handoff_feedback_closure.sql"
SUBMIT="supabase/functions/submit-feedback-response/index.ts"
DELIVER="supabase/functions/deliver-feedback-request/index.ts"
ADMIN_KEY="supabase/functions/_shared/supabase-admin-key.ts"
for f in "$MIG" "$SUBMIT" "$DELIVER" "$ADMIN_KEY"; do test -s "$f" || { echo "HF2_FAIL=missing_or_empty:$f"; exit 1; }; done
echo "HF2_FILES_NONEMPTY=PASS"
grep -q "NOT EXISTS" "$MIG"
grep -q "claim_feedback_delivery_tx" "$MIG"
grep -q "complete_widget_feedback_delivery_tx" "$MIG"
grep -q "submit_feedback_response_tx" "$MIG"
grep -q "REVOKE ALL ON FUNCTION" "$MIG"
! grep -q "CREATE UNIQUE INDEX IF NOT EXISTS uq_feedback_request_conversation_config" "$MIG"
grep -q "getSupabaseAdminKey" "$SUBMIT"
grep -q "getSupabaseAdminKey" "$DELIVER"
! grep -q 'Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")' "$SUBMIT"
! grep -q 'Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")' "$DELIVER"
grep -q "submit_feedback_response_tx" "$SUBMIT"
! grep -q '\.from("feedback_request")' "$SUBMIT"
echo "HF2_SOURCE_ASSERTIONS=PASS"

CID="hf2-pg-$RANDOM-$RANDOM"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$CID" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=hf2 postgres:17-alpine >/dev/null
READY=0
for _ in $(seq 1 60); do
  if docker exec "$CID" psql -U postgres -d hf2 -Atqc 'select 1' 2>/dev/null | grep -qx 1; then READY=1; break; fi
  sleep 1
done
test "$READY" = 1 || { echo "HF2_FAIL=disposable_db_not_ready"; exit 1; }
echo "HF2_DISPOSABLE_DB_READY=PASS"

cat > /tmp/hf2_fixture.sql <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE TABLE company(id uuid primary key,is_active boolean default true);
CREATE TABLE agent_profile(id uuid primary key,user_id uuid,status text);
CREATE TABLE company_membership(user_id uuid,company_id uuid,role text,is_active boolean);
CREATE TABLE visitor_session(id uuid primary key);
CREATE TABLE conversations(id uuid primary key,visitor_session_id uuid,channel_config_id uuid,status text,assigned_agent_id uuid,company_id uuid,updated_at timestamptz default now());
CREATE TABLE conversation_status_log(id bigserial primary key,conversation_id uuid,old_status text,new_status text,changed_by uuid,changed_by_type text,reason text,created_at timestamptz default now());
CREATE TABLE audit_log(id bigserial primary key,actor_id uuid,actor_type text,action text,resource_type text,resource_id uuid,diff jsonb);
CREATE TABLE feedback_automation_config(id uuid primary key default gen_random_uuid(),name text not null,trigger_event text not null,delay_minutes integer default 0,is_active boolean default true,config jsonb default '{}'::jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
CREATE TABLE feedback_request(id uuid primary key default gen_random_uuid(),conversation_id uuid not null,visitor_session_id uuid,request_type text default 'csat',status text default 'pending',rating integer,feedback_text text,sent_at timestamptz,responded_at timestamptz,scheduled_at timestamptz,channel text,rating_type text not null default 'stars_1_5',config_version_id uuid,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),response_token_hash text,token_expires_at timestamptz,token_used_at timestamptz,token_created_at timestamptz,recipient_email text,delivery_status text default 'pending',delivery_error_type text,email_provider text,email_provider_message_id text,delivery_event_received_at timestamptz,CONSTRAINT feedback_request_rating_check CHECK(rating between 1 and 5),CONSTRAINT feedback_request_delivery_error_type_check CHECK(delivery_error_type IS NULL OR delivery_error_type='config_error'));
CREATE UNIQUE INDEX idx_feedback_request_response_token_hash ON feedback_request(response_token_hash) WHERE response_token_hash IS NOT NULL;
CREATE TABLE messages(id uuid primary key default gen_random_uuid(),conversation_id uuid not null,role text not null,content text not null,content_type text default 'text',status text default 'delivered',metadata jsonb default '{}'::jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
-- Reproduce production history: two already-responded rows for one conversation/config.
INSERT INTO feedback_request(id,conversation_id,status,rating,rating_type,config_version_id,delivery_status,created_at,updated_at)
VALUES
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','responded',1,'stars_1_5','cccccccc-cccc-cccc-cccc-cccccccccccc','sent',now()-interval '60 days',now()-interval '59 days'),
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','responded',4,'stars_1_5','cccccccc-cccc-cccc-cccc-cccccccccccc','sent',now()-interval '60 days',now()-interval '59 days');
SQL
docker exec -i "$CID" psql -v ON_ERROR_STOP=1 -U postgres -d hf2 < /tmp/hf2_fixture.sql >/dev/null
docker exec -i "$CID" psql -v ON_ERROR_STOP=1 -U postgres -d hf2 < "$MIG" >/dev/null
echo "HF2_MIGRATION_COMPILE=PASS"
HIST_COUNT=$(docker exec "$CID" psql -U postgres -d hf2 -Atqc "select count(*) from feedback_request where conversation_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid and config_version_id='cccccccc-cccc-cccc-cccc-cccccccccccc'::uuid")
test "$HIST_COUNT" = 2 || { echo "HF2_FAIL=historical_duplicate_rewrite:$HIST_COUNT"; exit 1; }
echo "HF2_HISTORICAL_DUPLICATE_PRESERVATION=PASS"

cat > /tmp/hf2_assert.sql <<'SQL'
\set ON_ERROR_STOP on
DO $$
DECLARE co uuid:='11111111-1111-1111-1111-111111111111'; usr uuid:='22222222-2222-2222-2222-222222222222'; ag uuid:='33333333-3333-3333-3333-333333333333'; vs uuid:='44444444-4444-4444-4444-444444444444'; cv uuid:='55555555-5555-5555-5555-555555555555'; cfg uuid:='66666666-6666-6666-6666-666666666666'; r jsonb; fr uuid; tok text:=repeat('a',64); cnt int;
BEGIN
 INSERT INTO company VALUES(co,true); INSERT INTO agent_profile VALUES(ag,usr,'active'); INSERT INTO company_membership VALUES(usr,co,'admin',true); INSERT INTO visitor_session VALUES(vs); INSERT INTO conversations(id,visitor_session_id,status,assigned_agent_id,company_id) VALUES(cv,vs,'open',ag,co);
 INSERT INTO feedback_automation_config(id,name,trigger_event,delay_minutes,is_active,config) VALUES(cfg,'HF2','conversation_resolved',0,true,'{"rating_type":"nps","channels_enabled":["website_widget"]}');
 r:=set_conversation_resolution_tx(cv,co,usr,ag,'resolved','done'); IF r->>'result'<>'success' OR (r->>'feedback_scheduled')::int<>1 THEN RAISE EXCEPTION 'schedule:%',r; END IF;
 r:=set_conversation_resolution_tx(cv,co,usr,ag,'resolved','again'); SELECT count(*) INTO cnt FROM feedback_request WHERE conversation_id=cv AND config_version_id=cfg; IF r->>'result'<>'already_in_state' OR cnt<>1 THEN RAISE EXCEPTION 'resolution_idempotency:%/%',r,cnt; END IF;
 r:=claim_feedback_delivery_tx(); IF r->>'result'<>'claimed' OR r->>'company_id'<>co::text THEN RAISE EXCEPTION 'claim:%',r; END IF; fr:=(r->>'feedback_request_id')::uuid;
 r:=complete_widget_feedback_delivery_tx(fr,cv,co,tok,now(),now()+interval '7 days',now(),'https://example.test/feedback?token=x','nps','HF2_TEST'); IF r->>'result'<>'success' THEN RAISE EXCEPTION 'complete:%',r; END IF;
 r:=complete_widget_feedback_delivery_tx(fr,cv,co,tok,now(),now()+interval '7 days',now(),'https://example.test/feedback?token=x','nps','HF2_TEST'); IF r->>'result'<>'already_sent' THEN RAISE EXCEPTION 'delivery_idempotency:%',r; END IF; SELECT count(*) INTO cnt FROM messages WHERE metadata->>'response_route'='feedback_request'; IF cnt<>1 THEN RAISE EXCEPTION 'duplicate_message:%',cnt; END IF;
 r:=submit_feedback_response_tx(tok,10,'great'); IF r->>'result'<>'success' THEN RAISE EXCEPTION 'nps:%',r; END IF; r:=submit_feedback_response_tx(tok,9,'duplicate'); IF r->>'result'<>'invalid_or_expired_token' THEN RAISE EXCEPTION 'one_response:%',r; END IF;
 r:=complete_widget_feedback_delivery_tx(fr,cv,'99999999-9999-9999-9999-999999999999',repeat('b',64),now(),now()+interval '1 day',now(),'https://example.test/x','nps','HF2_TEST'); IF r->>'result'<>'tenant_scope_mismatch' THEN RAISE EXCEPTION 'tenant:%',r; END IF;
END $$;
DO $$
DECLARE co uuid:='11111111-1111-1111-1111-111111111111'; usr uuid:='22222222-2222-2222-2222-222222222222'; ag uuid:='33333333-3333-3333-3333-333333333333'; vs uuid:='77777777-7777-7777-7777-777777777777'; cv uuid:='88888888-8888-8888-8888-888888888888'; r jsonb; cnt int;
BEGIN UPDATE feedback_automation_config SET is_active=false; INSERT INTO visitor_session VALUES(vs); INSERT INTO conversations(id,visitor_session_id,status,assigned_agent_id,company_id) VALUES(cv,vs,'open',ag,co); r:=set_conversation_resolution_tx(cv,co,usr,ag,'resolved','done'); SELECT count(*) INTO cnt FROM feedback_request WHERE conversation_id=cv; IF r->>'result'<>'success' OR cnt<>0 THEN RAISE EXCEPTION 'inactive:%/%',r,cnt; END IF; END $$;
SQL
docker exec -i "$CID" psql -v ON_ERROR_STOP=1 -U postgres -d hf2 < /tmp/hf2_assert.sql >/dev/null
echo "HF2_DB_TRANSACTION_ASSERTIONS=PASS"

deno check --node-modules-dir=auto "$SUBMIT" "$DELIVER" >/dev/null
echo "HF2_DENO_CHECK=PASS"
npm ci --ignore-scripts >/dev/null
npm run build >/dev/null
echo "HF2_BUILD_GATE=PASS"
echo "HF2_SOURCE_FINAL_GATE=PASS"
