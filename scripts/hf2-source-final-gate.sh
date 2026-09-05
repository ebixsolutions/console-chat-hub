#!/usr/bin/env bash
set -euo pipefail

MIG="supabase/migrations/20260905123000_hf2_structured_handoff_feedback_closure.sql"
SUBMIT="supabase/functions/submit-feedback-response/index.ts"
DELIVER="supabase/functions/deliver-feedback-request/index.ts"

for f in "$MIG" "$SUBMIT" "$DELIVER"; do
  test -s "$f" || { echo "HF2_FAIL=missing_or_empty:$f"; exit 1; }
done
echo "HF2_FILES_NONEMPTY=PASS"

grep -q "uq_feedback_request_conversation_config" "$MIG"
grep -q "claim_feedback_delivery_tx" "$MIG"
grep -q "complete_widget_feedback_delivery_tx" "$MIG"
grep -q "submit_feedback_response_tx" "$MIG"
grep -q "service_role" "$MIG"
grep -q "submit_feedback_response_tx" "$SUBMIT"
! grep -q '\.from("feedback_request")' "$SUBMIT"
echo "HF2_SOURCE_ASSERTIONS=PASS"

# Disposable PostgreSQL: compile the migration and execute the production-blocking
# transactional behavior against the minimal authoritative table contract.
CID="hf2-pg-$RANDOM-$RANDOM"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$CID" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=hf2 -p 127.0.0.1::5432 postgres:17-alpine >/dev/null
for _ in $(seq 1 40); do
  if docker exec "$CID" pg_isready -U postgres -d hf2 >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CID" pg_isready -U postgres -d hf2 >/dev/null

cat > /tmp/hf2_fixture.sql <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE TABLE public.company(id uuid primary key,is_active boolean not null default true);
CREATE TABLE public.agent_profile(id uuid primary key,user_id uuid,status text);
CREATE TABLE public.company_membership(user_id uuid,company_id uuid references company(id),role text,is_active boolean);
CREATE TABLE public.visitor_session(id uuid primary key);
CREATE TABLE public.conversations(
 id uuid primary key,visitor_session_id uuid references visitor_session(id),channel_config_id uuid,
 status text,assigned_agent_id uuid,company_id uuid references company(id),updated_at timestamptz default now()
);
CREATE TABLE public.conversation_status_log(
 id bigserial primary key,conversation_id uuid,old_status text,new_status text,changed_by uuid,
 changed_by_type text,reason text,created_at timestamptz default now()
);
CREATE TABLE public.audit_log(
 id bigserial primary key,actor_id uuid,actor_type text,action text,resource_type text,resource_id uuid,diff jsonb
);
CREATE TABLE public.feedback_automation_config(
 id uuid primary key default gen_random_uuid(),name text not null,trigger_event text not null,
 delay_minutes integer default 0,is_active boolean default true,config jsonb default '{}'::jsonb,
 created_at timestamptz default now(),updated_at timestamptz default now(),
 CONSTRAINT feedback_automation_config_trigger_event_check CHECK(trigger_event IN ('conversation_resolved','rating_request','agent_transfer'))
);
CREATE TABLE public.feedback_request(
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references conversations(id) on delete cascade,
 visitor_session_id uuid references visitor_session(id),request_type text default 'csat',status text default 'pending',rating integer,
 feedback_text text,sent_at timestamptz,responded_at timestamptz,scheduled_at timestamptz,channel text,
 rating_type text not null default 'stars_1_5',config_version_id uuid,created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),response_token_hash text,token_expires_at timestamptz,token_used_at timestamptz,
 token_created_at timestamptz,recipient_email text,delivery_status text default 'pending',delivery_error_type text,
 email_provider text,email_provider_message_id text,delivery_event_received_at timestamptz,
 CONSTRAINT feedback_request_rating_check CHECK(rating between 1 and 5),
 CONSTRAINT feedback_request_request_type_check CHECK(request_type IN ('csat','nps','custom')),
 CONSTRAINT feedback_request_status_check CHECK(status IN ('pending','responded','expired','skipped')),
 CONSTRAINT feedback_request_delivery_status_check CHECK(delivery_status IN ('pending','token_generated','sent','delivery_failed','bounced','complained')),
 CONSTRAINT feedback_request_delivery_error_type_check CHECK(delivery_error_type IS NULL OR delivery_error_type IN ('config_error'))
);
CREATE UNIQUE INDEX idx_feedback_request_response_token_hash ON public.feedback_request(response_token_hash) WHERE response_token_hash IS NOT NULL;
CREATE TABLE public.messages(
 id uuid primary key default gen_random_uuid(),conversation_id uuid not null references conversations(id),role text not null,
 content text not null,content_type text default 'text',status text default 'delivered',metadata jsonb default '{}'::jsonb,
 created_at timestamptz default now(),updated_at timestamptz default now()
);
SQL
cat /tmp/hf2_fixture.sql | docker exec -i "$CID" psql -v ON_ERROR_STOP=1 -U postgres -d hf2 >/dev/null
cat "$MIG" | docker exec -i "$CID" psql -v ON_ERROR_STOP=1 -U postgres -d hf2 >/dev/null
echo "HF2_MIGRATION_COMPILE=PASS"

cat > /tmp/hf2_assert.sql <<'SQL'
\set ON_ERROR_STOP on
DO $$
DECLARE
  co uuid := '11111111-1111-1111-1111-111111111111';
  usr uuid := '22222222-2222-2222-2222-222222222222';
  ag uuid := '33333333-3333-3333-3333-333333333333';
  vs uuid := '44444444-4444-4444-4444-444444444444';
  cv uuid := '55555555-5555-5555-5555-555555555555';
  cfg uuid := '66666666-6666-6666-6666-666666666666';
  r jsonb; fr uuid; tok text := repeat('a',64); cnt int;
BEGIN
  INSERT INTO company(id) VALUES(co);
  INSERT INTO agent_profile(id,user_id,status) VALUES(ag,usr,'active');
  INSERT INTO company_membership VALUES(usr,co,'admin',true);
  INSERT INTO visitor_session(id) VALUES(vs);
  INSERT INTO conversations(id,visitor_session_id,status,assigned_agent_id,company_id) VALUES(cv,vs,'open',ag,co);
  INSERT INTO feedback_automation_config(id,name,trigger_event,delay_minutes,is_active,config)
    VALUES(cfg,'HF2','conversation_resolved',0,true,'{"rating_type":"nps","channels_enabled":["website_widget"]}'::jsonb);

  r := set_conversation_resolution_tx(cv,co,usr,ag,'resolved','done');
  IF r->>'result' <> 'success' OR (r->>'feedback_scheduled')::int <> 1 THEN RAISE EXCEPTION 'resolution scheduling failed: %',r; END IF;
  SELECT count(*) INTO cnt FROM feedback_request WHERE conversation_id=cv;
  IF cnt<>1 THEN RAISE EXCEPTION 'expected exactly one request, got %',cnt; END IF;

  r := set_conversation_resolution_tx(cv,co,usr,ag,'resolved','repeat');
  SELECT count(*) INTO cnt FROM feedback_request WHERE conversation_id=cv;
  IF r->>'result'<>'already_in_state' OR cnt<>1 THEN RAISE EXCEPTION 'idempotent resolution failed: %/%',r,cnt; END IF;

  r := claim_feedback_delivery_tx();
  IF r->>'result'<>'claimed' OR r->>'company_id'<>co::text OR r->>'rating_type'<>'nps' THEN RAISE EXCEPTION 'claim failed: %',r; END IF;
  fr := (r->>'feedback_request_id')::uuid;

  r := complete_widget_feedback_delivery_tx(fr,cv,co,tok,now(),now()+interval '7 days',now(),'https://example.test/feedback?token=x','nps','HF2_TEST');
  IF r->>'result'<>'success' THEN RAISE EXCEPTION 'widget complete failed: %',r; END IF;
  SELECT count(*) INTO cnt FROM messages WHERE conversation_id=cv AND metadata->>'response_route'='feedback_request';
  IF cnt<>1 THEN RAISE EXCEPTION 'expected one feedback message, got %',cnt; END IF;

  r := complete_widget_feedback_delivery_tx(fr,cv,co,tok,now(),now()+interval '7 days',now(),'https://example.test/feedback?token=x','nps','HF2_TEST');
  IF r->>'result'<>'already_sent' THEN RAISE EXCEPTION 'delivery idempotency failed: %',r; END IF;
  SELECT count(*) INTO cnt FROM messages WHERE conversation_id=cv AND metadata->>'response_route'='feedback_request';
  IF cnt<>1 THEN RAISE EXCEPTION 'duplicate widget message: %',cnt; END IF;

  r := submit_feedback_response_tx(tok,10,'great');
  IF r->>'result'<>'success' THEN RAISE EXCEPTION 'NPS response failed: %',r; END IF;
  r := submit_feedback_response_tx(tok,9,'duplicate');
  IF r->>'result'<>'invalid_or_expired_token' THEN RAISE EXCEPTION 'one-response failed: %',r; END IF;

  -- Cross-tenant supplied company must never complete the delivery.
  IF complete_widget_feedback_delivery_tx(fr,cv,'99999999-9999-9999-9999-999999999999',repeat('b',64),now(),now()+interval '1 day',now(),'https://example.test/x','nps','HF2_TEST')->>'result' NOT IN ('tenant_scope_mismatch','request_not_pending') THEN
    RAISE EXCEPTION 'tenant guard failed';
  END IF;
END $$;

-- Inactive config schedules nothing for a fresh conversation.
DO $$
DECLARE co uuid:='11111111-1111-1111-1111-111111111111'; usr uuid:='22222222-2222-2222-2222-222222222222'; ag uuid:='33333333-3333-3333-3333-333333333333'; vs uuid:='77777777-7777-7777-7777-777777777777'; cv uuid:='88888888-8888-8888-8888-888888888888'; r jsonb; cnt int;
BEGIN
 UPDATE feedback_automation_config SET is_active=false;
 INSERT INTO visitor_session(id) VALUES(vs);
 INSERT INTO conversations(id,visitor_session_id,status,assigned_agent_id,company_id) VALUES(cv,vs,'open',ag,co);
 r:=set_conversation_resolution_tx(cv,co,usr,ag,'resolved','done');
 SELECT count(*) INTO cnt FROM feedback_request WHERE conversation_id=cv;
 IF r->>'result'<>'success' OR cnt<>0 THEN RAISE EXCEPTION 'inactive config scheduled feedback: %/%',r,cnt; END IF;
END $$;
SQL
cat /tmp/hf2_assert.sql | docker exec -i "$CID" psql -v ON_ERROR_STOP=1 -U postgres -d hf2 >/dev/null
echo "HF2_DB_TRANSACTION_ASSERTIONS=PASS"

if command -v deno >/dev/null 2>&1; then
  deno check --node-modules-dir=auto "$SUBMIT" "$DELIVER" >/dev/null
  echo "HF2_DENO_CHECK=PASS"
fi

if [ -f package.json ]; then
  npm ci --ignore-scripts >/dev/null
  npm run build >/dev/null
  echo "HF2_BUILD_GATE=PASS"
fi

echo "HF2_SOURCE_FINAL_GATE=PASS"
