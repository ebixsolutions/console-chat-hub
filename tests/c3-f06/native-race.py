"""Disposable native PostgreSQL only; observed independent sessions and locks."""
import argparse, json, pathlib, subprocess, time, urllib.parse, os, sys
p=argparse.ArgumentParser(); p.add_argument('--database',required=True); a=p.parse_args()
u=urllib.parse.urlparse(a.database)
if u.hostname not in ('localhost','127.0.0.1','::1') or not u.path.startswith('/c3_f06_isolated_'):
    raise SystemExit('Refuse nonlocal/nonisolated database')
root=pathlib.Path(__file__).parent; evidence=[]; commands=[]
def run(q, name='observer', fail=False):
    env={**os.environ,'PGAPPNAME':'c3f06_'+name}
    r=subprocess.run(['psql','--no-psqlrc','--set','ON_ERROR_STOP=1','--no-align','--tuples-only','--dbname',a.database,'--command',q],env=env,capture_output=True,text=True)
    commands.append({'sql':q,'session':name,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr})
    if not fail and r.returncode: raise RuntimeError(r.stderr)
    return r
def sql(q): return run(q).stdout.strip()
def spawn(q,name):
    return subprocess.Popen(['psql','--no-psqlrc','--set','ON_ERROR_STOP=1','--no-align','--tuples-only','--dbname',a.database,'--command',q],env={**os.environ,'PGAPPNAME':'c3f06_'+name},stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def finish(proc):
    out,err=proc.communicate(timeout=10)
    assert proc.returncode==0,err
    return out
def observe(predicate):
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        data=json.loads(sql("SELECT coalesce(json_agg(json_build_object('pid',pid,'name',application_name,'state',state,'wait',wait_event,'blockers',pg_blocking_pids(pid))),'[]') FROM pg_stat_activity WHERE application_name LIKE 'c3f06_%' AND pid<>pg_backend_pid()"))
        if predicate(data): return data
        time.sleep(.03)
    raise AssertionError('Required actual lock/barrier not observed')
def uid(n): return 'f7000000-0000-4000-8000-'+str(n).zfill(12)
def call(n,content='Race',agent=10):
    return f"SELECT public.agent_send_reply_tx('{uid(20)}','{uid(agent)}','{content}','Agent','{uid(n)}')"
def replies(out): return [json.loads(x) for x in out.splitlines() if x.startswith('{')]
def counts(n):
    return json.loads(sql(f"SELECT json_build_object('message',(SELECT count(*) FROM public.messages WHERE metadata->>'client_request_id'='{uid(n)}'),'audit',(SELECT count(*) FROM public.audit_log WHERE diff->>'client_request_id'='{uid(n)}'),'receipt',(SELECT count(*) FROM public.c3_agent_reply_request WHERE client_request_id='{uid(n)}'))"))
def race(n,left,right):
    first=spawn('BEGIN; '+call(n,left)+'; SELECT pg_sleep(3); COMMIT;','first')
    barrier=observe(lambda d:any(x['name']=='c3f06_first' and x['wait']=='PgSleep' for x in d))
    second=spawn('BEGIN; '+call(n,right)+'; COMMIT;','second')
    locks=observe(lambda d:any(x['name']=='c3f06_second' and x['blockers'] for x in d))
    x=replies(finish(first))[0]; y=replies(finish(second))[0]
    assert counts(n)=={'message':1,'audit':1,'receipt':1}
    evidence.append({'case':'same_request' if left==right else 'payload_conflict','barrier':barrier,'locks':locks,'replies':[x,y],'counts':counts(n)})
    return x,y
def rollback_attempt(expected,extra=''):
    # Capture via psql JSON wrapper without interpreting SQL text as a shell command.
    q=(root/'sql/f06-capture-rollback-identity.sql').read_text(); q=q[q.index('SELECT '):].rstrip().rstrip(';')
    capture=json.loads(sql('SELECT row_to_json(x) FROM ('+q+') x'))
    settings=''.join("SELECT set_config('c3.f06_expected_%s','%s',false);"%(k,v) for k,v in capture.items())
    r=run(settings+extra+(root/'sql/f06-rollback.sql').read_text(),fail=True)
    assert (r.returncode==0)==(expected=='success'),r.stderr
    if expected!='success': assert expected in r.stderr,r.stderr
    evidence.append({'case':'rollback_'+expected,'exit':r.returncode,'error':r.stderr})
try:
    evidence.append({'case':'versions','postgres':sql('SELECT version()'),'psql':subprocess.check_output(['psql','--version'],text=True).strip(),'cwd':os.getcwd(),'head':os.environ.get('GITHUB_SHA')})
    for name in ['f06-local-production-schema-subset.sql','f06-local-messages-schema.sql','f06-four-argument-baseline.sql','f06-agent-reply-exactly-once.sql']:
        r=subprocess.run(['psql','--no-psqlrc','--set','ON_ERROR_STOP=1','--dbname',a.database,'--file',str(root/'sql'/name)],capture_output=True,text=True)
        commands.append({'file':name,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr}); assert r.returncode==0,r.stderr
    rollback_db=u.path[1:]+'_rollback'
    maintenance=urllib.parse.urlunparse(u._replace(path='/postgres'))
    r=subprocess.run(['psql','--no-psqlrc','--set','ON_ERROR_STOP=1','--dbname',maintenance,'--command',f'CREATE DATABASE {rollback_db} TEMPLATE {u.path[1:]}'],capture_output=True,text=True)
    assert r.returncode==0,r.stderr
    empty_url=urllib.parse.urlunparse(u._replace(path='/'+rollback_db))
    run((root/'sql/f06-local-race-fixtures.sql').read_text())
    assert sql("SELECT md5(pg_get_functiondef('public.agent_send_reply_tx(uuid,uuid,text,text)'::regprocedure))")=='2491450055223f90ff932b0faf64c560'
    x,y=race(70,'Race','Race'); assert x['message_id']==y['message_id'] and y['replayed']
    x,y=race(71,'Payload-A','Payload-B'); assert [x['result'],y['result']]==['success','request_id_conflict']
    for role in ['anon','authenticated','service_role']:
        for verb in ['SELECT * FROM public.c3_agent_reply_request','DELETE FROM public.c3_agent_reply_request','UPDATE public.c3_agent_reply_request SET created_at=now()']:
            r=run('SET ROLE '+role+'; '+verb,fail=True); assert r.returncode and 'permission denied' in r.stderr
        if role!='service_role':
            r=run('SET ROLE '+role+'; '+call(80),fail=True); assert r.returncode and 'permission denied' in r.stderr
    r=run('SET ROLE service_role; '+call(70)); assert replies(r.stdout)[0]['replayed']
    evidence.append({'case':'actual_role_acl','roles':['anon','authenticated','service_role'],'direct_receipt_read_update_delete':'denied','service_rpc':'allowed'})
    for n,state in [(72,"status='open'"),(73,"assigned_agent_id=NULL")]:
        sql(f"UPDATE public.conversations SET status='pending',assigned_agent_id='{uid(10)}' WHERE id='{uid(20)}'")
        first=spawn(f"BEGIN; SELECT id FROM public.conversations WHERE id='{uid(20)}' FOR UPDATE; UPDATE public.conversations SET {state} WHERE id='{uid(20)}'; SELECT pg_sleep(3); COMMIT;",'control')
        barrier=observe(lambda d:any(x['name']=='c3f06_control' and x['wait']=='PgSleep' for x in d))
        second=spawn(call(n,'After control'), 'send')
        locks=observe(lambda d:any(x['name']=='c3f06_send' and x['blockers'] for x in d))
        finish(first); reply=replies(finish(second))[0]
        assert reply['result']==('human_control_required' if n==72 else 'takeover_required'); assert counts(n)=={'message':0,'audit':0,'receipt':0}
        evidence.append({'case':'AI_return' if n==72 else 'transfer','barrier':barrier,'locks':locks,'reply':reply,'counts':counts(n)})
    rollback_attempt('Receipts exist')
    rollback_attempt('Missing or mismatched captured five-argument definition hash',"SELECT set_config('c3.f06_expected_definition_md5','drift',false);")
    previous=a.database; a.database=empty_url
    run('CREATE VIEW public.c3_f06_dependency_probe AS SELECT * FROM public.c3_agent_reply_request')
    rollback_attempt('depend')
    assert sql("SELECT to_regclass('public.c3_agent_reply_request') IS NOT NULL")=='t'
    run('DROP VIEW public.c3_f06_dependency_probe')
    rollback_attempt('success')
    assert sql("SELECT to_regclass('public.c3_agent_reply_request') IS NULL")=='t'
    assert sql("SELECT md5(pg_get_functiondef('public.agent_send_reply_tx(uuid,uuid,text,text)'::regprocedure))")=='2491450055223f90ff932b0faf64c560'
    a.database=previous
    status='PASS'
except Exception as e:
    status='FAIL'; evidence.append({'error':str(e)})
finally:
    output={'status':status,'production_execution':False,'scope':'native separate backend sessions; isolated schema subset, not hosted/Auth/UI','evidence':evidence,'commands':commands}
    print(json.dumps(output,indent=2)); sys.exit(0 if status=='PASS' else 1)
