#!/usr/bin/env python3
"""Actual localhost SQL, concurrent sessions, authenticated RLS and retained receipt rollback."""
import os,json,subprocess,concurrent.futures,threading,time
from pathlib import Path
from urllib.parse import urlparse
url=os.environ['C3_UAT_TEST_DB_URL']; u=urlparse(url); assert u.hostname in ('127.0.0.1','localhost') and u.path=='/c3tempuat'
root=Path(__file__).resolve().parents[2];checks=[]
def sql(s,ok=True):
 p=subprocess.run(['psql',url,'-X','-At','-v','ON_ERROR_STOP=1','-c',s],capture_output=True,text=True)
 if ok and p.returncode:raise AssertionError(p.stderr)
 return p
svc=lambda s:sql('begin;set local role service_role;'+s+'commit;',False)
def check(n,b):assert b,n;checks.append(n)
company='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec';conv='22222222-2222-4222-8222-222222222222';run='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
sql("""DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;
CREATE TABLE conversations(id uuid primary key, company_id uuid, metadata_source jsonb, created_at timestamptz default now()); CREATE TABLE messages(id uuid primary key,conversation_id uuid,role text,is_recalled boolean default false,content text default 'fixture',created_at timestamptz default now());
CREATE TABLE upstream_call_log(id uuid primary key default gen_random_uuid(),company_id uuid,conversation_id uuid,upstream_service text,request_payload jsonb,response_status integer,created_at timestamptz default now());
ALTER TABLE upstream_call_log ENABLE ROW LEVEL SECURITY;CREATE POLICY fixture_authenticated_allow ON upstream_call_log TO authenticated USING(true) WITH CHECK(true);GRANT ALL ON upstream_call_log TO authenticated;""")
sql("CREATE TABLE c3_uat_conversation_scope(conversation_id uuid primary key); CREATE FUNCTION c3_uat_learning_excluded(p_conversation_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT EXISTS(SELECT 1 FROM public.c3_uat_conversation_scope WHERE conversation_id=p_conversation_id) $$;")
sql((root/'tests/uat-runtime/ce-live-baseline.sql').read_text())
sql((root/'tests/uat-runtime/tenant-fixtures.sql').read_text())
sql((root/'sql/c3_uat_tenant_authority.sql').read_text())
sql((root/'sql/c3_uat_execution_status.sql').read_text())
status_call=f"select c3_uat_execution_status('{run}','c3-3322877-bounded-uat-r2','{company}');"
check('authenticated cannot inspect server lease',sql('set role authenticated;'+status_call,False).returncode!=0)
check('read-only status detects missing RPC dependencies before activation','UAT_DEPENDENCY_MISSING' in svc(status_call).stdout)
sql((root/('sql/'+os.environ.get('C3_UAT_SQL_PACKAGE','c3_live_execution_dependencies.sql'))).read_text())
check('status does not invent an active lease','UAT_RUN_MISSING' in svc(status_call).stdout)
# Synthetic evidence ONLY: not a Production receipt or a bound for the seven real unknowns.
scope='C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1/rev1.5/stage-A/3520'
quota='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
missing=['commerce-semantic:'+x for x in ['83e12377-3e9f-435a-b3f3-32a9e7348edc','af02d94b-32bb-455d-ae91-030d7be729b2','25b28f4e-462a-4f16-bc0e-c80f0e4576b0','47f004ca-4996-4a0e-a8df-ae622bd008ee','10638698-3549-4d8d-a7e7-c76f276465d9','2f61d01e-0438-42c4-b739-5e64eb6ada85','e2cce632-0681-409f-93a2-d274fff1bd79']]
evidence={'contract':'C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1/rev1.5','company_id':company,'scope':scope,'unit':'model_attempt','limit':3520,'authorization_sha256':'a'*64,'coverage_sha256':'b'*64,'period_start':'2026-01-01T00:00:00Z','covered_through':'2026-01-02T00:00:00Z','entries':[{'id':'synthetic-confirmed','units':3489,'classification':'confirmed','receipt_sha256':'c'*64,'unit':'model_attempt','scope':scope,'request_ids':['synthetic-confirmed']}]+[{'id':x,'units':2,'classification':'uncertainty','receipt_sha256':'d'*64,'unit':'model_attempt','scope':scope,'request_ids':[x],'actual_usage':None,'call_chain_sha256':'e'*64,'coverage':['caller','pre-semantic','router-retries','fallback','verifier','async-sidecalls'],'overlap':'conservative-double-reserve'} for x in missing]}
evidence.update(budget_microusd=64000000,historical_cost_microusd=0,historical_conversations=0,historical_visitors=0,historical_assistants=0,conversation_limit=224,visitor_limit=480,assistant_limit=427,source_head='a'*40,source_tree='b'*40)
def seed_evidence():
 raw=json.dumps(evidence).replace("'","''")
 sql(f"insert into upstream_call_log(id,company_id,request_payload) values('{quota}','{company}',jsonb_build_object('kind','c3_uat_quota','scope','{scope}','evidence','{raw}'::jsonb,'evidence_sha256',encode(sha256(convert_to(('{raw}'::jsonb)::text,'UTF8')),'hex'))) on conflict(id) do update set request_payload=excluded.request_payload")
 sql(f"update upstream_call_log set request_payload=request_payload||jsonb_build_object('quota_evidence_sha256',(select request_payload->>'evidence_sha256' from upstream_call_log where id='{quota}')) where request_payload->>'kind' in ('c3_uat_run','c3_uat_dispatch')")
seed_evidence()
policy={'kind':'c3_uat_run','revision':'c3-3322877-bounded-uat-r2','state':'active','issued_at':'2026-01-01T00:00:00Z','expires':'2026-01-01T23:59:59Z','allowed_conversations':[conv],'allowed_purposes':['generation','evaluation','assist','kb_embedding'],'allowed_operation_prefixes':['generate-reply:','agent-assist:','ce:','kb:'],'conversation_limit':20,'visitor_limit':20,'attempt_limit':17,'budget_microusd':64000000,'batch_size':20,'batch_visitor_limit':20,'per_request_attempt_limit':32,'stage':'calibration','kb_bounds_verified':False,'quota_scope':scope,'count_tokens_limit':6,'quota_evidence_sha256':sql(f"select request_payload->>'evidence_sha256' from upstream_call_log where id='{quota}'").stdout.strip()}
policy.update(actor_id='4348ee35-9632-4626-a846-e313bcc4a5f9',channel_id='0405282f-77dc-47cf-8074-99dd3dc6c393',source_head='a'*40,source_tree='b'*40,authorization_sha256='a'*64)
sql(f"insert into conversations(id,company_id,metadata_source,created_at) values('{conv}','{company}','{{\"exclude_training\":true}}',clock_timestamp());insert into messages(id,conversation_id,role,created_at) values('44444444-4444-4444-8444-444444444444','{conv}','visitor',clock_timestamp());insert into upstream_call_log(id,company_id,request_payload) values('{run}','{company}','{json.dumps(policy)}');update upstream_call_log set request_payload=request_payload||jsonb_build_object('issued_at',clock_timestamp()-interval '1 minute','expires',clock_timestamp()+interval '1 hour') where id='{run}'")
sql(f"insert into messages(id,conversation_id,role) values('55555555-5555-4555-8555-555555555555','{conv}','assistant');insert into c3_uat_conversation_scope values('{conv}')")
check('active model-only lease status never promotes KB bound', '"ready": true' in svc(status_call).stdout and '"remote_ready": false' in svc(status_call).stdout)
check('read-only status emits no dispatch record',sql("select count(*) from upstream_call_log where request_payload->>'kind'='c3_uat_dispatch'").stdout.strip()=='0')
check('Phase1 dispatch activation does not enable CE or training',sql(f"select ce_conversation_evaluable_v1('{conv}')").stdout.strip()=='f')
sql(f"insert into conversations(id,company_id,metadata_source,created_at) values('33333333-3333-4333-8333-333333333333','{company}','{{\"exclude_training\":true}}','2026-01-01');insert into c3_uat_conversation_scope values('33333333-3333-4333-8333-333333333333');insert into messages(id,conversation_id,role) values('66666666-6666-4666-8666-666666666666','33333333-3333-4333-8333-333333333333','visitor'),('77777777-7777-4777-8777-777777777777','33333333-3333-4333-8333-333333333333','assistant')")
check('historical excluded CE jobs remain excluded under new active lease',sql("select ce_conversation_evaluable_v1('33333333-3333-4333-8333-333333333333')").stdout.strip()=='f')
check('CE learning exclusion remains active' ,sql(f"select c3_uat_learning_excluded('{conv}')").stdout.strip()=='t')
def reserve(i,c=company,v=conv,revision='c3-3322877-bounded-uat-r2',provider='vertex',purpose='generation',model='gemini-2.5-flash',op='generate-reply:test',cost=8540,inp=20000,out=1016):
 return f"select c3_uat_reserve_dispatch('{run}','{revision}','{c}','{v}','{op}','generation','{i:064x}','{'a'*64}','{provider}','{purpose}','{model}',1,{inp},{out},{cost});"
check('authenticated RPC denied',sql('set role authenticated;'+reserve(0),False).returncode!=0)
check('authenticated lease forgery rejected by restrictive RLS',sql(f"set role authenticated;insert into upstream_call_log(company_id,request_payload) values('{company}','{{\"kind\":\"c3_uat_run\"}}');",False).returncode!=0)
check('authenticated lease UPDATE blocked even with permissive fixture policy','UPDATE 0' in sql(f"set role authenticated;update upstream_call_log set request_payload='{{}}' where id='{run}';").stdout)
check('foreign company denied',svc(reserve(1,c='11111111-1111-4111-8111-111111111111')).returncode!=0)
check('foreign conversation denied',svc(reserve(1,v='33333333-3333-4333-8333-333333333333')).returncode!=0)
check('source revision drift denied',svc(reserve(1,revision='wrong')).returncode!=0)
check('unexpected fallback denied',svc(reserve(1,provider='anthropic')).returncode!=0)
check('KB unseen bound denied',svc(reserve(1,provider='singapore-kb',purpose='kb_embedding',model='gemini-embedding-001',op='kb:test',cost=100000,inp=2048,out=0)).returncode!=0)
sql(f"update upstream_call_log set request_payload=jsonb_set(request_payload,'{{expires}}',to_jsonb(clock_timestamp()-interval '1 second')) where id='{run}'")
check('expired authorization denied',svc(reserve(1)).returncode!=0)
check('expired CE permission fails closed',sql(f"select ce_conversation_evaluable_v1('{conv}')").stdout.strip()=='f')
sql(f"update upstream_call_log set request_payload=jsonb_set(request_payload,'{{expires}}',to_jsonb(clock_timestamp()+interval '1 hour')) where id='{run}'")
# Negative bounds are exercised in real SQL, not inferred from source presence.
for field,value in [('budget_microusd',100),('per_request_attempt_limit',0),('visitor_limit',0),('expires',None)]:
 sql(f"update upstream_call_log set request_payload=jsonb_set(request_payload,'{{{field}}}','{json.dumps(value)}'::jsonb) where id='{run}'")
 check('invalid or exhausted '+field+' denies',svc(reserve(90)).returncode!=0)
 restore=json.dumps(policy[field]) if field!='expires' else None
 if restore is not None:sql(f"update upstream_call_log set request_payload=jsonb_set(request_payload,'{{{field}}}','{restore}'::jsonb) where id='{run}'")
 else:sql(f"update upstream_call_log set request_payload=jsonb_set(request_payload,'{{expires}}',to_jsonb(clock_timestamp()+interval '1 hour')) where id='{run}'")
# No asserted historical bound is manufactured from the seven invocations.
sql(f"delete from upstream_call_log where id='{quota}'")
check('missing historical evidence refuses admission','UAT_HISTORY_EVIDENCE_REQUIRED' in svc(reserve(91)).stderr)
seed_evidence()
sql(f"update upstream_call_log set request_payload=jsonb_set(request_payload,'{{evidence,entries,1,coverage}}','[]') where id='{quota}'")
check('tampered historical evidence refuses admission','UAT_HISTORY_EVIDENCE_INVALID' in svc(reserve(91)).stderr)
seed_evidence()
saved=evidence['entries'][1]['coverage'];evidence['entries'][1]['coverage']=['router-retries'];seed_evidence()
check('hashed but incomplete full call chain refuses admission','UAT_HISTORY_BOUND_UNPROVED' in svc(reserve(91)).stderr)
evidence['entries'][1]['coverage']=saved;seed_evidence()
saved_entry=evidence['entries'][1].copy();evidence['entries'].append(saved_entry);seed_evidence()
check('duplicate historical ledger identity refuses admission','UAT_HISTORY_EVIDENCE_INVALID' in svc(reserve(91)).stderr)
evidence['entries'].pop();seed_evidence()
sql(f"update upstream_call_log set request_payload=request_payload-'quota_scope' where id='{run}'")
check('run without logical quota scope refuses admission','UAT_HISTORY_EVIDENCE_INVALID' in svc(reserve(91)).stderr)
sql(f"update upstream_call_log set request_payload=request_payload||jsonb_build_object('quota_scope','{scope}') where id='{run}'")
check('repeatable read cannot use a stale quota snapshot','UAT_ISOLATION_DENIED' in sql('begin isolation level repeatable read;set local role service_role;'+reserve(91),False).stderr)
# Two independent leases, one quota: 3503 historical units leaves exactly 17.
run1=run;run2='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
sql(f"insert into upstream_call_log(id,company_id,request_payload) select '{run2}',company_id,request_payload from upstream_call_log where id='{run1}'")
n=30;barrier=threading.Barrier(n)
def worker(i):
 target=run1 if i%2==0 else run2
 query=reserve(100+i).replace(run1,target)
 barrier.wait()
 return svc("set local application_name='c3-crossrun-overlap';select pg_backend_pid();select pg_sleep(0.15);"+query+f"select c3_uat_finalize_dispatch('{target}','{company}','{100+i:064x}','response',200,100,10);")
with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:
 futures=[pool.submit(worker,i) for i in range(n)]
 overlap=0
 while not all(f.done() for f in futures):
  overlap=max(overlap,int(sql("select count(*) from pg_stat_activity where application_name='c3-crossrun-overlap' and state='active'").stdout.strip()))
  time.sleep(.02)
 rows=[f.result() for f in futures]
check('server observes real overlapping cross-run DB connections',overlap>1)
pids={next((int(x) for x in r.stdout.splitlines() if x.isdigit()),None) for r in rows}
check('30 actual overlapping database sessions',len(pids)==30)
check('one original 3520 quota atomically grants exactly 17 of 30 across two runs',sum(r.returncode==0 for r in rows)==17)
check('both runs actually compete for the same balance',sql("select count(distinct request_payload->>'run_id') from upstream_call_log where request_payload->>'kind'='c3_uat_dispatch'").stdout.strip()=='2')
check('durable receipts equal granted slots',sql("select count(*) from upstream_call_log where request_payload->>'kind'='c3_uat_dispatch'").stdout.strip()=='17')
i=next(100+k for k,r in enumerate(rows) if r.returncode==0)
check('replay at full quota cannot dispatch',svc(reserve(i)).returncode!=0)
check('18th new dispatch denied',svc(reserve(999)).returncode!=0)
check('a fresh run cannot reset the original quota','UAT_CUMULATIVE_QUOTA_LIMIT' in svc(reserve(991).replace(run1,run2)).stderr)
check('finalized reservation counted once', '\"durable_debit\": 17' in svc(status_call).stdout)
# Explicitly change only the synthetic fixture to exercise two additional outcome states.
evidence['entries'][0]['units']=3487;seed_evidence()
sql(f"update upstream_call_log set request_payload=jsonb_set(request_payload,'{{attempt_limit}}','19'::jsonb) where id='{run}'")
sql(f"update upstream_call_log set request_payload=request_payload||jsonb_build_object('kb_bounds_verified',true,'kb_bound_receipt_sha256','{'b'*64}') where id='{run}'")
check('approved bounded embedding reserves its own exposure',svc(reserve(888,provider='singapore-kb',purpose='kb_embedding',model='gemini-embedding-001',op='kb:test',cost=100000,inp=2048,out=0)).returncode==0)
check('embedding finalization retains a bound, not fictitious observed tokens',svc(f"select c3_uat_finalize_dispatch('{run}','{company}','{888:064x}','remote_bound',200,null,null);").returncode==0)
check('reserve next attempt for unknown-outcome test',svc(reserve(999)).returncode==0)
check('unobserved pending attempt denies new dispatch immediately',svc(reserve(1000)).returncode!=0)
check('status rollback also denies an in-flight dispatch',sql((root/'sql/c3_uat_execution_status_rollback.sql').read_text(),False).returncode!=0)
check('pending dispatch denies a different run without retry','UAT_PENDING_OBSERVATION' in svc(reserve(1001).replace(run1,run2)).stderr)
check('rollback denies unsettled receipts',sql((root/'sql/c3_live_execution_dependencies_rollback.sql').read_text(),False).returncode!=0)
check('unknown finalization pauses future admissions',svc(f"select c3_uat_finalize_dispatch('{run}','{company}','{999:064x}','unknown',0,null,null);").returncode==0 and sql(f"select request_payload->>'state' from upstream_call_log where id='{run}'").stdout.strip()=='paused')
# Preserve receipts across guarded rollback. Only proposed new callable objects/policies are removed.
check('paused unknown outcome is not shown as enabled','"ready": false' in svc(status_call).stdout)
sql(f"update upstream_call_log set request_payload=jsonb_set(request_payload,'{{state}}','\"paused\"'::jsonb) where id='{run2}'")
sql((root/'sql/c3_uat_execution_status_rollback.sql').read_text())
check('status rollback removes exact read-only function',sql("select to_regprocedure('public.c3_uat_execution_status(uuid,text,uuid)') is null").stdout.strip()=='t')
sql((root/'sql/c3_live_execution_dependencies_rollback.sql').read_text())
sql(f"update upstream_call_log set request_payload=jsonb_set(request_payload,'{{state}}','\"paused\"'::jsonb) where id='{run2}'")
check('rollback retains 19 durable reservations and paused lease',sql("select count(*) from upstream_call_log where request_payload->>'kind'='c3_uat_dispatch'").stdout.strip()=='19')
check('exact original CE body restored',sql("select md5(prosrc) from pg_proc where oid='ce_conversation_evaluable_v1(uuid)'::regprocedure").stdout.strip()=='1cea72657a372172d7b06c557be30294')
check('rollback removes only temporary functions' ,sql("select to_regprocedure('public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer)') is null").stdout.strip()=='t')


check('rollback preserves restrictive receipt update protection','UPDATE 0' in sql(f"set role authenticated;update upstream_call_log set request_payload='{{}}' where id='{quota}'").stdout)
check('rollback permits legal ordinary non-UAT log writes',sql(f"set role authenticated;insert into upstream_call_log(company_id,request_payload) values('{company}','{{\"kind\":\"ordinary\"}}')").returncode==0)
# Exercise the exact proposed normal-UI fixture entry, including clock ordering.
sql((root/('sql/'+os.environ.get('C3_UAT_SQL_PACKAGE','c3_live_execution_dependencies.sql'))).read_text())
sql((root/'sql/c3_uat_execution_status.sql').read_text())
def qa_sql():
 cfg={'company_id':company,'actor_id':'4348ee35-9632-4626-a846-e313bcc4a5f9','run_id':'71657f35-88c4-4a73-a2e7-9abde643ad74','conversation_1':'c7d3fa80-ed64-42d2-a48e-cda98dce5d71','conversation_2':'a869150f-a69d-41ad-bb39-c070be8cc708','source_head':'a'*40,'source_tree':'b'*40,'authorization_sha256':'a'*64}
 return ''.join("SET c3.qa_"+k+"='"+v+"';" for k,v in cfg.items())+(root/'sql/c3_live_execution_qa_lease_proposed.sql').read_text()
check('proposed lease refuses unknown cross-run dispatch and rolls back all fixtures',sql(qa_sql(),False).returncode!=0 and sql("select count(*) from visitor_session where visitor_fingerprint like 'widget-live-test:%'").stdout.strip()=='0')
# A second isolated phase uses a clean fixture DB ledger; never remove production receipts.
sql("delete from upstream_call_log where request_payload->>'kind'='c3_uat_dispatch'")
evidence['entries'][0]['units']=298;seed_evidence()
sql(qa_sql())
check('exact lease expiry uses one clock sample',sql("select (request_payload->>'expires')::timestamptz-(request_payload->>'issued_at')::timestamptz=interval '45 minutes' from upstream_call_log where id='71657f35-88c4-4a73-a2e7-9abde643ad74'").stdout.strip()=='t')
check('exact proposed normal-UI entry creates two and only two scoped tickets',sql("select count(*) from conversations where id in ('c7d3fa80-ed64-42d2-a48e-cda98dce5d71','a869150f-a69d-41ad-bb39-c070be8cc708') and metadata_source->>'exclude_training'='true'").stdout.strip()=='2')
check('exact proposed lease does not enable remote bounds',sql("select request_payload->>'kb_bounds_verified' from upstream_call_log where id='71657f35-88c4-4a73-a2e7-9abde643ad74'").stdout.strip()=='false')
check('proposed tickets satisfy real issued_at admission ordering',sql("select bool_and(c.created_at >= (l.request_payload->>'issued_at')::timestamptz) from conversations c join upstream_call_log l on l.request_payload->'allowed_conversations' ? c.id::text where l.id='71657f35-88c4-4a73-a2e7-9abde643ad74'").stdout.strip()=='t')
check('proposed fixture setup does not send a customer message',sql("select count(*) from messages where conversation_id in ('c7d3fa80-ed64-42d2-a48e-cda98dce5d71','a869150f-a69d-41ad-bb39-c070be8cc708')").stdout.strip()=='0')
check('replay of fixture preparation is atomically denied',sql(qa_sql(),False).returncode!=0)
# The exact controlled lease has separate durable ceilings for generation and countTokens.
qa='71657f35-88c4-4a73-a2e7-9abde643ad74';qa_conv='c7d3fa80-ed64-42d2-a48e-cda98dce5d71'
original_run=run;run=qa
sql(f"insert into messages(id,conversation_id,role) values(gen_random_uuid(),'{qa_conv}','visitor')")
def qa_call(i,unit='model_attempt'):
 return reserve(i,v=qa_conv,op='generate-reply-controlled',out=0,cost=6000).replace("'generation','",("'countTokens:fixture','" if unit=='countTokens' else "'generation','"),1)
for k in range(6):
 check('countTokens durable slot '+str(k+1),svc(qa_call(2000+k,'countTokens')+f"select c3_uat_finalize_dispatch('{qa}','{company}','{2000+k:064x}','response',200,120,0);").returncode==0)
check('seventh countTokens denied across new connection',svc(qa_call(2010,'countTokens')).returncode!=0)
# Another source anchor retains the independent per-request ceiling.
sql(f"insert into messages(id,conversation_id,role) values(gen_random_uuid(),'{qa_conv}','visitor')")
for k in range(6):
 check('generation durable slot '+str(k+1),svc(qa_call(3000+k)+f"select c3_uat_finalize_dispatch('{qa}','{company}','{3000+k:064x}','response',200,120,0);").returncode==0)
check('seventh generation denied across new connection',svc(qa_call(3010)).returncode!=0)
check('countTokens is not fabricated as a model attempt',sql(f"select count(*) filter(where request_payload->>'unit'='model_attempt')||'/'||count(*) filter(where request_payload->>'unit'='countTokens') from upstream_call_log where request_payload->>'run_id'='{qa}'").stdout.strip()=='6/6')
check('controlled lease refuses remote embedding even with no dispatch',svc(reserve(4000,v=qa_conv,provider='singapore-kb',purpose='kb_embedding',model='gemini-embedding-001',op='kb:test',cost=100000,inp=2048,out=0)).returncode!=0)
run=original_run
sql("update upstream_call_log set request_payload=jsonb_set(request_payload,'{state}','\"paused\"'::jsonb) where id='71657f35-88c4-4a73-a2e7-9abde643ad74'")
sql((root/'sql/c3_uat_execution_status_rollback.sql').read_text())
sql((root/'sql/c3_live_execution_dependencies_rollback.sql').read_text())

subprocess.run([__import__('sys').executable,str(root/'tests/uat-runtime/dual-tenant.py')],check=True)

print(json.dumps({'result':'PASS','assertions':checks,'count':len(checks),'max_observed_overlapping_sessions':overlap,'scope':'real localhost PostgreSQL roles/RLS/concurrency and receipt-retaining rollback; no Hosted/provider dispatch'}))

if '--compatibility' in __import__('sys').argv:
 import tempfile
 fixtures=tempfile.mkdtemp(prefix='c3-live-comparison-')
 subprocess.run(['python3',str(root/'tests/uat-runtime/materialize-baselines.py'),fixtures],check=True)
 sql("insert into company(id) values('11111111-1111-4111-8111-111111111111') ON CONFLICT DO NOTHING;GRANT SELECT ON company,conversations TO service_role;insert into conversations(id,company_id) values('99999999-9999-4999-8999-999999999999','11111111-1111-4111-8111-111111111111');")
 sql("CREATE TABLE user_roles(user_id uuid,role text);insert into user_roles values('12345678-1234-4234-8234-123456789012','admin');GRANT SELECT ON user_roles,company_membership TO service_role;")
 sql((root/('sql/'+os.environ.get('C3_UAT_SQL_PACKAGE','c3_live_execution_dependencies.sql'))).read_text())
 sql((root/'sql/c3_uat_execution_status.sql').read_text())
 policy.update(state='active',count_tokens_limit=6,quota_evidence_sha256=sql(f"select request_payload->>'evidence_sha256' from upstream_call_log where id='{quota}'").stdout.strip(),attempt_limit=640,budget_microusd=64000000,per_request_attempt_limit=32,allowed_operation_prefixes=['generate-reply-','agent-assist-','ce:','kb:','grounding-verifier:'])
 sql("insert into upstream_call_log(id,company_id,request_payload) values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','"+company+"','"+json.dumps(policy)+"');update upstream_call_log set request_payload=request_payload||jsonb_build_object('issued_at',clock_timestamp()-interval '1 hour','expires',clock_timestamp()+interval '1 hour') where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'")
 env={**os.environ,'C3_UAT_BASELINES_DIR':fixtures}
 args=[os.environ.get('C3_UAT_DENO','deno'),'test','--no-lock','--allow-env','--allow-read','--allow-run']
 if os.environ.get('C3_UAT_DENO_CONFIG'):args+=['--config',os.environ['C3_UAT_DENO_CONFIG']]
 else:args+=['--no-config','--node-modules-dir=none']
 args+=[str(root/'tests/uat-runtime/native-compatibility.ts')]
 subprocess.run(args,cwd=fixtures,env=env,check=True)
