#!/usr/bin/env python3
"""Real PostgreSQL sessions. Localhost only. No provider/network to Production."""
import os,sys,json,subprocess,concurrent.futures,threading,time,hashlib
from pathlib import Path
from urllib.parse import urlparse
URL=os.environ['C3_ACCOUNTING_TEST_DB_URL']; u=urlparse(URL)
assert u.hostname in ('127.0.0.1','localhost') and u.path=='/c3modelaccounting'
root=Path(__file__).resolve().parents[2]; receipts=[]
def sql(s,ok=True):
 p=subprocess.run(['psql',URL,'-X','-At','-v','ON_ERROR_STOP=1','-c',s],capture_output=True,text=True)
 if ok and p.returncode:raise AssertionError(p.stderr)
 return p

def check(name,v):
 assert v,name
 receipts.append({'assertion':name,'result':'PASS'})
company='4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec'; conv='22222222-2222-4222-8222-222222222222'; run='a0a8c36e-42b5-4d9f-bbee-095ddc731520'; hash='a'*64
sql((root/'tests/model-accounting/bootstrap.sql').read_text())
migration=next((root/'supabase/migrations').glob('*_c3_shared_model_attempt_accounting.sql'))
sql(migration.read_text())
check('migration forward and paused future cap 3520',sql(f"select ceiling||':'||reserved||':'||state from c3_model_accounting.run where id='{run}'").stdout.strip()=='3520:0:paused')
def reserve(i,c=company,v=conv,r=run,provider='mock',purpose='generation'):
 return f"select public.c3_reserve_model_attempt('{c}',{('NULL' if v is None else chr(39)+v+chr(39))},'{i}','operation','{provider}','{purpose}','{hash}','{r}');"
def svc(s):return sql('begin;set local role service_role;'+s+'commit;',ok=False)
check('paused run denies before dispatch',svc(reserve('paused')).returncode!=0)
sql(f"update c3_model_accounting.run set state='active',ceiling=17 where id='{run}'")
# All workers start together, retain transactions after reservation, and return actual distinct backend PIDs.
n=40;barrier=threading.Barrier(n)
def worker(i):
 barrier.wait(timeout=30)
 t=time.monotonic();p=svc("select pg_backend_pid();"+reserve('concurrent-'+str(i))+"select pg_sleep(0.015);")
 lines=p.stdout.splitlines();pid=next((int(x) for x in lines if x.isdigit()),None)
 return {'index':i,'pid':pid,'exit_code':p.returncode,'elapsed_ms':round((time.monotonic()-t)*1000,2),'dispatch':p.returncode==0,'error':p.stderr.strip()[:150]}
with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool: rows=list(pool.map(worker,range(n)))
check('genuine 40 concurrent PostgreSQL sessions',len({r['pid'] for r in rows})==n)
check('17 granted, 23 denied at shared ceiling',sum(r['dispatch'] for r in rows)==17)
check('counter equals durable reservations',sql(f"select reserved||':'||(select count(*) from c3_model_accounting.attempt where run_id='{run}') from c3_model_accounting.run where id='{run}'").stdout.strip()=='17:17')
check('one additional attempt denied',svc(reserve('one-above')).returncode!=0)
first=next(r['index'] for r in rows if r['dispatch']); identity='concurrent-'+str(first)
p=svc(reserve(identity));check('idempotent replay at full cap returns no dispatch',p.returncode==0 and '"dispatch": false' in p.stdout)
check('replay payload conflict denied',svc(reserve(identity,provider='other')).returncode!=0)
check('unknown outcome never decrements',svc(f"select public.c3_finalize_model_attempt('{company}','{run}','{identity}','unknown',0);").returncode==0)
check('idempotent finalization', '"idempotent": true' in svc(f"select public.c3_finalize_model_attempt('{company}','{run}','{identity}','unknown',0);").stdout)
check('conflicting finalization denied',svc(f"select public.c3_finalize_model_attempt('{company}','{run}','{identity}','response',200);").returncode!=0)
check('crash/reserved receipts still occupy all 17 slots',sql(f"select reserved from c3_model_accounting.run where id='{run}'").stdout.strip()=='17')
check('foreign conversation rejected',svc(reserve('foreign',v='33333333-3333-4333-8333-333333333333')).returncode!=0)
check('foreign tenant/run rejected',svc(reserve('foreign-company',c='11111111-1111-4111-8111-111111111111',v='33333333-3333-4333-8333-333333333333')).returncode!=0)
check('wrong run rejected',svc(reserve('wrong-run',r='44444444-4444-4444-8444-444444444444')).returncode!=0)
for role in ['anon','authenticated']:
 check(role+' RPC execute denied',sql('begin;set local role '+role+';'+reserve('unauthorized')+'commit;',ok=False).returncode!=0)
 check(role+' ledger access denied',sql('begin;set local role '+role+';select * from c3_model_accounting.run;commit;',ok=False).returncode!=0)
check('service cannot reset/increase quota',svc(f"update c3_model_accounting.run set reserved=0,ceiling=3520 where id='{run}';").returncode!=0)
check('RLS enabled on both private tables',sql("select count(*) from pg_class join pg_namespace n on n.oid=relnamespace where n.nspname='c3_model_accounting' and relkind='r' and relrowsecurity").stdout.strip()=='2')
# Concurrent identical dispatch identity gives one fresh claim even below quota.
sql(f"update c3_model_accounting.run set ceiling=18 where id='{run}'")
n2=12;b2=threading.Barrier(n2)
def duplicate(_):
 b2.wait();return svc(reserve('same-identity')).stdout
with concurrent.futures.ThreadPoolExecutor(max_workers=n2) as pool: same=list(pool.map(duplicate,range(n2)))
check('12 racing replays permit exactly one dispatch',sum('"dispatch": true' in x for x in same)==1)
check('crash before finalize remains durable reserved',sql(f"select state from c3_model_accounting.attempt where run_id='{run}' and identity='same-identity'").stdout.strip()=='reserved')
# Close is not a bypass.
sql(f"update c3_model_accounting.run set state='closed' where id='{run}'")
check('closed scope denies rather than unmetered bypass',svc(reserve('closed')).returncode!=0)
sql((root/'sql/c3-model-accounting/rollback.sql').read_text())
check('rollback revokes dispatch',svc(reserve('after-rollback')).returncode!=0)
check('rollback preserves consumed receipts',sql(f"select count(*) from c3_model_accounting.attempt where run_id='{run}'").stdout.strip()=='18')
# An independent fixture run checks the actual approved numerical ceiling, without resetting any ledger.
company2='11111111-1111-4111-8111-111111111111';run2='55555555-5555-4555-8555-555555555555'
sql(f"insert into c3_model_accounting.run(id,company_id,label,ceiling,state) values('{run2}','{company2}','isolated-exact-3520',3520,'active')")
# Rollback revoked access; restore only fixture RPC grants for this independent local run.
sql("grant execute on function public.c3_reserve_model_attempt(uuid,uuid,text,text,text,text,text,uuid) to service_role")
p=svc(f"select public.c3_reserve_model_attempt('{company2}','33333333-3333-4333-8333-333333333333','exact-'||i::text,'exact-3520','mock','evaluation','{hash}','{run2}') from generate_series(1,3520) as i;")
check('3520 sequential actual SQL reservations reach exact future cap',p.returncode==0 and p.stdout.count('"dispatch": true')==3520)
check('3521st actual reservation denied',svc(reserve('3521',c=company2,v='33333333-3333-4333-8333-333333333333',r=run2)).returncode!=0)
check('approved numerical cap durable count exactly 3520',sql(f"select reserved||':'||(select count(*) from c3_model_accounting.attempt where run_id='{run2}') from c3_model_accounting.run where id='{run2}'").stdout.strip()=='3520:3520')
# Kill a genuine database connection after committed reservation, not a sequential mock of a crash.
sql(f"update c3_model_accounting.run set state='closed' where id='{run2}'")
run3='66666666-6666-4666-8666-666666666666'
sql(f"insert into c3_model_accounting.run(id,company_id,label,ceiling,state) values('{run3}','{company2}','isolated-crash',1,'active')")
proc=subprocess.Popen(['psql',URL,'-X','-At','-v','ON_ERROR_STOP=1','-c',"begin;set local role service_role;"+reserve('crash',c=company2,v='33333333-3333-4333-8333-333333333333',r=run3)+"commit;select pg_sleep(30);"],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
for _ in range(100):
 row=sql(f"select count(*) from c3_model_accounting.attempt where run_id='{run3}'").stdout.strip()
 if row=='1':break
 time.sleep(.01)
check('crash fixture reservation committed before kill',row=='1')
sql("select pg_terminate_backend(pid) from pg_stat_activity where datname='c3modelaccounting' and pid<>pg_backend_pid() and query like '%pg_sleep(30)%'")
proc.communicate(timeout=5)
check('real killed session retains durable unknown-consumption slot',proc.returncode!=0 and sql(f"select reserved from c3_model_accounting.run where id='{run3}'").stdout.strip()=='1')
check('crash replay refuses duplicate dispatch', '"dispatch": false' in svc(reserve('crash',c=company2,v='33333333-3333-4333-8333-333333333333',r=run3)).stdout)
check('crash full cap refuses replacement attempt',svc(reserve('replacement',c=company2,v='33333333-3333-4333-8333-333333333333',r=run3)).returncode!=0)
print(json.dumps({'provider_calls':0,'database':'actual native PostgreSQL','assertions':receipts,'concurrent_sessions':rows,'identical_identity_racers':n2,'overall':'PASS'},indent=2))
