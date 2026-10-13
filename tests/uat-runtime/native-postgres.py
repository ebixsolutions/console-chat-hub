#!/usr/bin/env python3
"""Actual localhost SQL, concurrent sessions, authenticated RLS and retained receipt rollback."""
import os,json,subprocess,concurrent.futures,threading
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
sql((root/'sql/c3_temporary_uat_execution.sql').read_text())
policy={'kind':'c3_uat_run','revision':'c3-3322877-bounded-uat-r2','state':'active','issued_at':'2026-01-01T00:00:00Z','expires':'2026-01-01T23:59:59Z','allowed_conversations':[conv],'allowed_purposes':['generation','evaluation','assist','kb_embedding'],'allowed_operation_prefixes':['generate-reply:','agent-assist:','ce:','kb:'],'conversation_limit':20,'visitor_limit':20,'attempt_limit':17,'budget_microusd':64000000,'batch_size':20,'batch_visitor_limit':20,'per_request_attempt_limit':32,'stage':'calibration','kb_bounds_verified':False}
sql(f"insert into conversations values('{conv}','{company}','{{\"exclude_training\":true}}',clock_timestamp());insert into messages(id,conversation_id,role,created_at) values('44444444-4444-4444-8444-444444444444','{conv}','visitor',clock_timestamp());insert into upstream_call_log(id,company_id,request_payload) values('{run}','{company}','{json.dumps(policy)}');update upstream_call_log set request_payload=request_payload||jsonb_build_object('issued_at',clock_timestamp()-interval '1 minute','expires',clock_timestamp()+interval '1 hour') where id='{run}'")
sql(f"insert into messages(id,conversation_id,role) values('55555555-5555-4555-8555-555555555555','{conv}','assistant');insert into c3_uat_conversation_scope values('{conv}')")
check('fresh scoped CE evaluation eligible under active protected lease',sql(f"select ce_conversation_evaluable_v1('{conv}')").stdout.strip()=='t')
sql(f"insert into conversations values('33333333-3333-4333-8333-333333333333','{company}','{{\"exclude_training\":true}}','2026-01-01');insert into c3_uat_conversation_scope values('33333333-3333-4333-8333-333333333333');insert into messages(id,conversation_id,role) values('66666666-6666-4666-8666-666666666666','33333333-3333-4333-8333-333333333333','visitor'),('77777777-7777-4777-8777-777777777777','33333333-3333-4333-8333-333333333333','assistant')")
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
n=30;barrier=threading.Barrier(n)
def worker(i):barrier.wait();return svc('select pg_backend_pid();'+reserve(100+i)+f"select c3_uat_finalize_dispatch('{run}','{company}','{100+i:064x}','response',200,100,10);")
with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool: rows=list(pool.map(worker,range(n)))
pids={next((int(x) for x in r.stdout.splitlines() if x.isdigit()),None) for r in rows}
check('30 actual overlapping database sessions',len(pids)==30)
check('atomic existing-log ledger grants exactly 17 of 30',sum(r.returncode==0 for r in rows)==17)
check('durable receipts equal granted slots',sql("select count(*) from upstream_call_log where request_payload->>'kind'='c3_uat_dispatch'").stdout.strip()=='17')
i=next(100+k for k,r in enumerate(rows) if r.returncode==0)
check('replay returns no dispatch at full cap','"dispatch": false' in svc(reserve(i)).stdout)
check('18th new dispatch denied',svc(reserve(999)).returncode!=0)
sql(f"update upstream_call_log set request_payload=jsonb_set(request_payload,'{{attempt_limit}}','19'::jsonb) where id='{run}'")
sql(f"update upstream_call_log set request_payload=request_payload||jsonb_build_object('kb_bounds_verified',true,'kb_bound_receipt_sha256','{'b'*64}') where id='{run}'")
check('approved bounded embedding reserves its own exposure',svc(reserve(888,provider='singapore-kb',purpose='kb_embedding',model='gemini-embedding-001',op='kb:test',cost=100000,inp=2048,out=0)).returncode==0)
check('embedding finalization retains a bound, not fictitious observed tokens',svc(f"select c3_uat_finalize_dispatch('{run}','{company}','{888:064x}','remote_bound',200,null,null);").returncode==0)
check('reserve next attempt for unknown-outcome test',svc(reserve(999)).returncode==0)
check('unobserved pending attempt denies new dispatch immediately',svc(reserve(1000)).returncode!=0)
check('rollback denies unsettled receipts',sql((root/'sql/c3_temporary_uat_rollback.sql').read_text(),False).returncode!=0)
check('unknown finalization pauses future admissions',svc(f"select c3_uat_finalize_dispatch('{run}','{company}','{999:064x}','unknown',0,null,null);").returncode==0 and sql(f"select request_payload->>'state' from upstream_call_log where id='{run}'").stdout.strip()=='paused')
# Preserve receipts across guarded rollback. Only proposed new callable objects/policies are removed.
sql((root/'sql/c3_temporary_uat_rollback.sql').read_text())
check('rollback retains 19 durable reservations and paused lease',sql("select count(*) from upstream_call_log where request_payload->>'kind'='c3_uat_dispatch'").stdout.strip()=='19')
check('exact original CE body restored',sql("select md5(prosrc) from pg_proc where oid='ce_conversation_evaluable_v1(uuid)'::regprocedure").stdout.strip()=='1cea72657a372172d7b06c557be30294')
check('rollback removes only temporary functions' ,sql("select to_regprocedure('public.c3_uat_finalize_dispatch(uuid,uuid,text,text,integer,integer,integer)') is null").stdout.strip()=='t')
print(json.dumps({'result':'PASS','assertions':checks,'count':len(checks),'scope':'real localhost PostgreSQL roles/RLS/concurrency and receipt-retaining rollback; no Hosted/provider dispatch'}))

if '--compatibility' in __import__('sys').argv:
 import tempfile
 fixtures=tempfile.mkdtemp(prefix='c3-live-comparison-')
 subprocess.run(['python3',str(root/'tests/uat-runtime/materialize-baselines.py'),fixtures],check=True)
 sql("CREATE TABLE companies(id uuid primary key);insert into companies values('11111111-1111-4111-8111-111111111111'),('4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec');GRANT SELECT ON companies,conversations TO service_role;insert into conversations(id,company_id) values('99999999-9999-4999-8999-999999999999','11111111-1111-4111-8111-111111111111');")
 sql("CREATE TABLE user_roles(user_id uuid,role text);CREATE TABLE company_membership(user_id uuid,company_id uuid,is_active boolean);insert into user_roles values('12345678-1234-4234-8234-123456789012','admin');GRANT SELECT ON user_roles,company_membership TO service_role;")
 sql((root/'sql/c3_temporary_uat_execution.sql').read_text())
 policy.update(state='active',attempt_limit=640,budget_microusd=64000000,per_request_attempt_limit=32,allowed_operation_prefixes=['generate-reply-','agent-assist-','ce:','kb:','grounding-verifier:'])
 sql("insert into upstream_call_log(id,company_id,request_payload) values('cccccccc-cccc-4ccc-8ccc-cccccccccccc','"+company+"','"+json.dumps(policy)+"');update upstream_call_log set request_payload=request_payload||jsonb_build_object('issued_at',clock_timestamp()-interval '1 hour','expires',clock_timestamp()+interval '1 hour') where id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'")
 env={**os.environ,'C3_UAT_BASELINES_DIR':fixtures}
 args=[os.environ.get('C3_UAT_DENO','deno'),'test','--no-lock','--node-modules-dir=auto','--allow-env','--allow-read','--allow-run']
 if os.environ.get('C3_UAT_DENO_CONFIG'):args+=['--config',os.environ['C3_UAT_DENO_CONFIG']]
 args+=[str(root/'tests/uat-runtime/native-compatibility.ts')]
 subprocess.run(args,cwd=root,env=env,check=True)
