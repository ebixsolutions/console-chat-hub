#!/usr/bin/env python3
"""Real PostgreSQL Tenant/run/actor/channel leases; no external AI/KB calls."""
import os,json,subprocess,threading,concurrent.futures,time,uuid
from pathlib import Path
from urllib.parse import urlparse,urlunparse
root=Path(__file__).resolve().parents[2]
u=urlparse(os.environ['C3_UAT_TEST_DB_URL']);assert u.hostname in ('localhost','127.0.0.1')
base=urlunparse(u._replace(path='/postgres'));url=urlunparse(u._replace(path='/c3dualtenant'))
def query(target,s,ok=True):
 r=subprocess.run(['psql',target,'-X','-At','-v','ON_ERROR_STOP=1','-c',s],capture_output=True,text=True)
 if ok:assert r.returncode==0,r.stderr
 return r
query(base,'DROP DATABASE IF EXISTS c3dualtenant WITH (FORCE)');query(base,'CREATE DATABASE c3dualtenant')
sql=lambda s,ok=True:query(url,s,ok)
svc=lambda s:sql('BEGIN;SET LOCAL ROLE service_role;'+s+'COMMIT;',False)
literal=lambda s:"'"+str(s).replace("'","''")+"'"
checks=[]
def check(n,ok):assert ok,n;checks.append({'assertion':n,'result':'PASS'})
sql("CREATE TABLE conversations(id uuid primary key,company_id uuid,metadata_source jsonb,created_at timestamptz default now());CREATE TABLE messages(id uuid primary key default gen_random_uuid(),conversation_id uuid,role text,is_recalled boolean default false,content text default 'fixture',created_at timestamptz default now());CREATE TABLE upstream_call_log(id uuid primary key default gen_random_uuid(),company_id uuid,conversation_id uuid,upstream_service text,request_payload jsonb,response_status integer,created_at timestamptz default now());ALTER TABLE upstream_call_log ENABLE ROW LEVEL SECURITY;CREATE POLICY native_permissive ON upstream_call_log TO authenticated USING(true) WITH CHECK(true);GRANT ALL ON upstream_call_log TO authenticated;")
sql((root/'tests/uat-runtime/tenant-fixtures.sql').read_text())
sql((root/'sql/c3_uat_tenant_authority.sql').read_text());sql((root/'sql/c3_uat_execution_status.sql').read_text());sql((root/'sql/c3_live_execution_dependencies.sql').read_text())
missing=['83e12377-3e9f-435a-b3f3-32a9e7348edc','af02d94b-32bb-455d-ae91-030d7be729b2','25b28f4e-462a-4f16-bc0e-c80f0e4576b0','47f004ca-4996-4a0e-a8df-ae622bd008ee','10638698-3549-4d8d-a7e7-c76f276465d9','2f61d01e-0438-42c4-b739-5e64eb6ada85','e2cce632-0681-409f-93a2-d274fff1bd79']
tenants=[{'company':'4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec','actor':'4348ee35-9632-4626-a846-e313bcc4a5f9','channel':'0405282f-77dc-47cf-8074-99dd3dc6c393','revision':'c3-3322877-bounded-uat-r2','scope':'C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1/rev1.5/stage-A/3520','limit':3520,'historical':3508,'remaining':12}, {'company':'3d6e17b5-ec79-4f75-aa7f-eaa824ff8493','actor':'11111111-2222-4333-8444-555555555555','channel':'b0000000-0000-0000-0000-000000000001','revision':'c3-frankie-tenant-bounded-demo-v1','scope':'C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1/rev1.5/frankie/model-attempt','limit':12,'historical':5,'remaining':7}]
def seed(t):
 e=t['evidence'];raw=literal(json.dumps(e));scope=literal(t['scope'])
 sql(f"INSERT INTO upstream_call_log(id,company_id,request_payload)VALUES('{t['quota']}','{t['company']}',jsonb_build_object('kind','c3_uat_quota','scope',{scope},'evidence',{raw}::jsonb,'evidence_sha256',encode(sha256(convert_to(({raw}::jsonb)::text,'UTF8')),'hex'))) ON CONFLICT(id)DO UPDATE SET request_payload=excluded.request_payload;")
 sql(f"UPDATE upstream_call_log SET request_payload=request_payload||jsonb_build_object('quota_evidence_sha256',(SELECT request_payload->>'evidence_sha256'FROM upstream_call_log WHERE id='{t['quota']}'))WHERE company_id='{t['company']}'AND request_payload->>'kind'IN('c3_uat_run','c3_uat_dispatch')")
def status(t,run=None):return f"SELECT c3_uat_execution_status('{run or t['run']}','{t['revision']}','{t['company']}');"
def reserve(t,i,run=None):return f"SELECT c3_uat_reserve_dispatch('{run or t['run']}','{t['revision']}','{t['company']}','{t['conv']}','generate-reply-native','generation','{i:064x}','{'a'*64}','vertex','generation','gemini-2.5-flash',1,20000,0,6000);"
def finalize(t,i,state='response',run=None):return f"SELECT c3_uat_finalize_dispatch('{run or t['run']}','{t['company']}','{i:064x}','{state}',{200 if state=='response'else 0},{100 if state=='response'else 'null'},{0 if state=='response'else 'null'});"
for k,t in enumerate(tenants):
 for field in ['quota','run','run2','conv']:t[field]=str(uuid.uuid4())
 entries=[{'id':'confirmed','units':t['historical']-(14 if k==0 else 0),'classification':'confirmed','receipt_sha256':'c'*64,'unit':'model_attempt','scope':t['scope'],'request_ids':['native-confirmed']}]
 if k==0:
  entries +=[{'id':x,'units':2,'classification':'uncertainty','receipt_sha256':'d'*64,'unit':'model_attempt','scope':t['scope'],'request_ids':['commerce-semantic:'+x],'actual_usage':None,'call_chain_sha256':'e'*64,'coverage':['caller','pre-semantic','router-retries','fallback','verifier','async-sidecalls'],'overlap':'conservative-double-reserve'}for x in missing]
 t['evidence']={'contract':'C3-FINAL-DEMO-LAUNCH-UAT-20261006-v1/rev1.5','company_id':t['company'],'scope':t['scope'],'unit':'model_attempt','limit':t['limit'],'authorization_sha256':'a'*64,'source_head':'a'*40,'source_tree':'b'*40,'coverage_sha256':'b'*64,'period_start':'2026-01-01','covered_through':'2026-01-02','entries':entries,'budget_microusd':1000000,'historical_cost_microusd':0,'historical_conversations':2,'historical_visitors':3,'historical_assistants':1,'conversation_limit':20,'visitor_limit':200,'assistant_limit':200}
 seed(t)
 sql(f"INSERT INTO conversations(id,company_id,metadata_source)VALUES('{t['conv']}','{t['company']}',jsonb_build_object('exclude_training',true));INSERT INTO messages(conversation_id,role)VALUES('{t['conv']}','visitor');")
 v={'kind':'c3_uat_run','revision':t['revision'],'actor_id':t['actor'],'channel_id':t['channel'],'source_head':'a'*40,'source_tree':'b'*40,'authorization_sha256':'a'*64,'quota_scope':t['scope'],'allowed_conversations':[t['conv']],'allowed_purposes':['generation'],'allowed_operation_prefixes':['generate-reply-'],'conversation_limit':10,'visitor_limit':150,'attempt_limit':30,'count_tokens_limit':30,'budget_microusd':1000000,'batch_size':10,'batch_visitor_limit':150,'per_request_attempt_limit':32,'stage':'B','kb_bounds_verified':False,'state':'active'}
 raw=literal(json.dumps(v));t['policy']=v
 for run in [t['run'],t['run2']]:sql(f"INSERT INTO upstream_call_log(id,company_id,request_payload)VALUES('{run}','{t['company']}',{raw}::jsonb||jsonb_build_object('issued_at',clock_timestamp()-interval '1 minute','expires',clock_timestamp()+interval '1 hour','quota_evidence_sha256',(SELECT request_payload->>'evidence_sha256'FROM upstream_call_log WHERE id='{t['quota']}')))")
 check('independent scoped readiness '+str(k),'"ready": true'in svc(status(t)).stdout)
 check('anonymous status denied '+str(k),sql('SET ROLE anon;'+status(t),False).returncode!=0)
 check('authenticated status denied '+str(k),sql('SET ROLE authenticated;'+status(t),False).returncode!=0)
 check('authenticated reserve denied '+str(k),sql('SET ROLE authenticated;'+reserve(t,1),False).returncode!=0)
 check('authenticated quota forgery denied '+str(k),sql(f"SET ROLE authenticated;INSERT INTO upstream_call_log(company_id,request_payload)VALUES('{t['company']}','{{\"kind\":\"c3_uat_quota\"}}');",False).returncode!=0)
 check('KB boundary remains false '+str(k),'"remote_ready": false'in svc(status(t)).stdout)
for k,t in enumerate(tenants):check('cross-tenant run substitution '+str(k),svc(reserve(t,1,tenants[1-k]['run'])).returncode!=0)
for field,value in [('actor_id',tenants[1]['actor']),('channel_id',tenants[1]['channel']),('source_tree','c'*40),('revision',tenants[1]['revision'])]:
 t=tenants[0];sql(f"UPDATE upstream_call_log SET request_payload=jsonb_set(request_payload,'{{{field}}}',to_jsonb('{value}'::text))WHERE id='{t['run']}'")
 check('lease binding tamper '+field,'"ready": false'in svc(status(t)).stdout)
 sql(f"UPDATE upstream_call_log SET request_payload=jsonb_set(request_payload,'{{{field}}}',to_jsonb('{t['policy'][field]}'::text))WHERE id='{t['run']}'")
for table,key in [('company','id'),('company_membership','company_id'),('channel_config','company_id')]:
 t=tenants[0];sql(f"UPDATE {table} SET is_active=false WHERE {key}='{t['company']}'")
 check('revoked authority '+table,svc(reserve(t,2)).returncode!=0)
 sql(f"UPDATE {table} SET is_active=true WHERE {key}='{t['company']}'")
barrier=threading.Barrier(32)
def worker(i):
 t=tenants[i%2];run=t['run']if i%4<2 else t['run2'];barrier.wait()
 return svc("SET LOCAL application_name='dual-tenant-real';SELECT pg_backend_pid();SELECT pg_sleep(0.15);"+reserve(t,100+i,run)+finalize(t,100+i,run=run))
with concurrent.futures.ThreadPoolExecutor(max_workers=32)as pool:
 fut=[pool.submit(worker,i)for i in range(32)];overlap=0
 while not all(f.done()for f in fut):
  overlap=max(overlap,int(sql("SELECT count(*)FROM pg_stat_activity WHERE application_name='dual-tenant-real'AND state='active'").stdout.strip()));time.sleep(.01)
 results=[f.result()for f in fut]
check('32 real independent backend sessions',len({next((x for x in r.stdout.splitlines()if x.isdigit()),None)for r in results})==32)
check('server-observed concurrent overlap',overlap>1)
for k,t in enumerate(tenants):
 check('historical cumulative quota independent '+str(k),sum(r.returncode==0 for i,r in enumerate(results)if i%2==k)==t['remaining'])
 check('new run cannot reset quota '+str(k),'UAT_CUMULATIVE_QUOTA_LIMIT'in svc(reserve(t,999,t['run2'])).stderr)
 winner=next(100+i for i,r in enumerate(results)if i%2==k and r.returncode==0);run=t['run']if (winner-100)%4<2 else t['run2']
 t['winner']=winner;t['winning_run']=run
 check('exact finalize replay '+str(k),svc(finalize(t,winner,run=run)).returncode==0)
 check('conflicting finalize denied '+str(k),svc(finalize(t,winner,run=run).replace(',200,100,0',',200,101,0')).returncode!=0)
 # Change only synthetic fixture evidence, never Production history.
 t['evidence']['entries'][0]['units']-=2;seed(t)
check('replay cannot dispatch again','\"dispatch\": false'in svc(reserve(tenants[0],tenants[0]['winner'],tenants[0]['winning_run'])).stdout)
t=tenants[1];check('pending reservation persists',svc(reserve(t,900)).returncode==0)
check('pending cross-run denied','UAT_PENDING_OBSERVATION'in svc(reserve(t,901,t['run2'])).stderr)
check('other Tenant unaffected by pending','"ready": true'in svc(status(tenants[0])).stdout)
check('unknown finalization retained',svc(finalize(t,900,'unknown')).returncode==0)
check('unknown pauses issuing lease','"ready": false'in svc(status(t)).stdout)
check('unknown blocks fresh same-Tenant lease','UAT_PENDING_OBSERVATION'in svc(reserve(t,902,t['run2'])).stderr)
t=tenants[0];t['evidence']['historical_cost_microusd']=t['evidence']['budget_microusd']-6000*12-100;seed(t)
check('cross-run budget exposure cannot reset','UAT_ATTEMPT_OR_BUDGET_EXPOSURE_LIMIT'in svc(reserve(t,903,t['run2'])).stderr)
check('rollback refuses active leases',sql((root/'sql/c3_uat_execution_status_rollback.sql').read_text(),False).returncode!=0)
before=sql("SELECT count(*)FROM upstream_call_log WHERE request_payload->>'kind'LIKE 'c3_uat_%'").stdout
sql("UPDATE upstream_call_log SET request_payload=jsonb_set(request_payload,'{state}','\"paused\"')WHERE request_payload->>'kind'='c3_uat_run'")
sql((root/'sql/c3_uat_execution_status_rollback.sql').read_text());sql((root/'sql/c3_live_execution_dependencies_rollback.sql').read_text())
check('rollback retains all cumulative evidence and outcomes',sql("SELECT count(*)FROM upstream_call_log WHERE request_payload->>'kind'LIKE 'c3_uat_%'").stdout==before)
check('retained RLS still protects history','UPDATE 0'in sql("SET ROLE authenticated;UPDATE upstream_call_log SET request_payload='{}'").stdout)
check('ordinary Frankie non-UAT log insert remains permitted',sql("SET ROLE authenticated;INSERT INTO upstream_call_log(company_id,request_payload)VALUES('3d6e17b5-ec79-4f75-aa7f-eaa824ff8493','{\"kind\":\"ordinary_customer\"}')").returncode==0)
sql((root/'sql/c3_uat_tenant_authority_rollback.sql').read_text())
check('exact rollback removes unused authority helper',sql("SELECT to_regprocedure('public.c3_uat_lease_authority(uuid,text,jsonb,uuid)')IS NULL").stdout.strip()=='t')
print(json.dumps({'result':'PASS','assertions':checks,'count':len(checks),'max_observed_overlapping_sessions':overlap,'Hosted':False,'paid_dispatches':0}))
