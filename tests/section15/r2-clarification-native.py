"""Native PostgreSQL test of proposed R2 SQL, original canonical writer and exact rollback.
Runs only in the existing C3 disposable CI PostgreSQL service. No live RPC/data."""
import argparse, hashlib, json, os, pathlib, subprocess, time, urllib.parse
p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--out',required=True);a=p.parse_args()
u=urllib.parse.urlparse(a.database)
assert u.hostname in ('127.0.0.1','localhost') and u.path=='/c3_uat_isolated_native'
base=pathlib.Path.cwd();out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True)
maintenance=urllib.parse.urlunparse(u._replace(path='/postgres'));db=urllib.parse.urlunparse(u._replace(path='/c3_r2_native'))
cmds=[];checks=[];created=False;workers=[]
def run(sql,database=db,deny=False):
 r=subprocess.run(['psql',database,'-X','-qAt','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True,timeout=25)
 cmds.append(dict(sql=sql,exit_code=r.returncode,stdout=r.stdout,stderr=r.stderr))
 assert (r.returncode!=0 if deny else r.returncode==0),r.stderr
 return r.stdout.strip()
def check(name,ok):
 assert ok,name
 checks.append(dict(name=name,result='PASS'))
def uid(n):return 'fc160000-0000-4000-8000-'+str(n).zfill(12)
co,t,s,other=map(uid,[1,2,3,4])
def q(s):return "'"+str(s).replace("'","''")+"'"
def digest(s):return hashlib.sha256(s.encode()).hexdigest()
def proof(sid=s,content='Which date applies?',revision=1,company=co):
 h=digest(content)
 return dict(b2_gate_contract='executeB2PersistenceGate:allow_after_revalidation',b2_commit_source='commit_ai_reply_tx',
  b2_source_message_id=sid,b2_expected_company_id=company,b2_expected_revision=revision,b2_response_hash=h,
  b2_idempotency_key=digest(':'.join([company,t,sid,str(revision),h])))
def call(sid=s,content='Which date applies?',reason='clarification_required_before_r2',meta=None):
 return "SELECT public.required_escalation_clarification_tx("+','.join(map(q,[t,sid,'R2',content,reason,json.dumps(proof(sid,content) if meta is None else meta)]))+"::jsonb);"
def invoke(*args,**kwargs):return json.loads(run('SET ROLE service_role;'+call(*args,**kwargs)))
def count(table):return int(run('SELECT count(*) FROM '+table+';'))
def replies():return int(run("SELECT count(*) FROM messages WHERE role='assistant';"))
def visitor(sid,clock):
 run(f"INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('{sid}','{t}','visitor','Customer asks for policy','{clock}');")
def process(sql,name):
 p=subprocess.Popen(['psql',db,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',sql],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'PGAPPNAME':name})
 workers.append(p);return p
def wait_for(query):
 end=time.monotonic()+8
 while time.monotonic()<end:
  if run(query)=='t':return True
  time.sleep(.05)
 return False
def finish(proc):
 stdout,stderr=proc.communicate(timeout=15);cmds.append(dict(pid=proc.pid,exit_code=proc.returncode,stdout=stdout,stderr=stderr))
 assert proc.returncode==0,stderr
 return json.loads(next(x for x in stdout.splitlines() if x.startswith('{')))
try:
 run('CREATE DATABASE c3_r2_native;',maintenance);created=True
 run("""CREATE SCHEMA extensions;CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
 CREATE TABLE public.conversations(id uuid PRIMARY KEY,company_id uuid NOT NULL,status text,assigned_agent_id uuid,updated_at timestamptz DEFAULT now());
 CREATE TABLE public.messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid,role text,content text,status text,is_recalled boolean DEFAULT false,metadata jsonb,created_at timestamptz DEFAULT now());
 CREATE TABLE public.conversation_commerce_state(conversation_id uuid PRIMARY KEY,company_id uuid,revision bigint,source_message_id uuid);
 CREATE TABLE public.handoff_event(conversation_id uuid,handoff_type text,created_at timestamptz);
 CREATE TABLE public.audit_log(actor_id uuid,actor_type text,action text,resource_type text,resource_id uuid,diff jsonb);
 ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
 ALTER TABLE conversation_commerce_state ENABLE ROW LEVEL SECURITY;ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
 """)
 run((base/'tests/section15/early-r1-commit-reply-before.sql').read_text())
 run('REVOKE ALL ON FUNCTION public.commit_ai_reply_tx(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;GRANT EXECUTE ON FUNCTION public.commit_ai_reply_tx(uuid,uuid,text,jsonb) TO service_role;')
 run((base/'tests/section15/r2-clarification-before.sql').read_text())
 sig="public.required_escalation_clarification_tx(uuid,uuid,text,text,text)"
 newsig="public.required_escalation_clarification_tx(uuid,uuid,text,text,text,jsonb)"
 canon="public.commit_ai_reply_tx(uuid,uuid,text,jsonb)"
 def md5(sig):return run(f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure));")
 def acl(sig):return run(f"SELECT proacl::text FROM pg_proc WHERE oid='{sig}'::regprocedure;")
 before=(md5(sig),acl(sig),md5(canon),acl(canon))
 check('captured_exact_before',before==('98b2d2e627df51228d4bcb248afe7d63','{postgres=X/postgres,service_role=X/postgres}','f3ba6240d2453729ce073b7e87ed665c','{postgres=X/postgres,service_role=X/postgres}'))
 forward=(base/'sql/c3_r2_clarification_forward_proposed.sql').read_text();rollback=(base/'sql/c3_r2_clarification_rollback_proposed.sql').read_text()
 run(forward);check('canonical_frozen_and_legacy_disabled',md5(canon)==before[2] and acl(canon)==before[3] and acl(sig)=='{postgres=X/postgres}')
 check('new_service_only_acl',acl(newsig)==before[1])
 run(forward,deny=True)
 run(f"INSERT INTO conversations(id,company_id,status) VALUES('{t}','{co}','open');")
 visitor(s,'2026-11-26 00:00:00+00')
 run(f"INSERT INTO conversation_commerce_state VALUES('{t}','{co}',1,'{s}');")
 for role in ('anon','authenticated'):
  run('SET ROLE '+role+';'+call(),deny=True)
 run(f"SET ROLE service_role;SELECT {sig.split('(')[0]}('{t}','{s}','R2','Which date applies?','clarification_required_before_r2');",deny=True)
 check('legacy_and_client_denied',replies()==0)
 for name,meta,expected in [('missing_proof',{},'invalid_b2_revision_proof'),('tenant_mismatch',proof(company=other),'tenant_mismatch'),('stale_revision',proof(revision=2),'stale_authorized_revision'),('wrong_hash',proof(content='Other text'),'response_hash_mismatch')]:
  check(name,invoke(meta=meta)['result']==expected and replies()==0 and count('audit_log')==0)
 check('unowned_source',invoke(uid(99))['result']=='invalid_source_message' and replies()==0)
 # Real two independent processes; observe PostgreSQL lock wait.
 first=process('BEGIN;SET ROLE service_role;'+call()+'SELECT pg_sleep(4);COMMIT;','r2_first')
 check('first_connection_holds_lock',wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='r2_first' AND wait_event='PgSleep');"))
 second=process('BEGIN;SET ROLE service_role;'+call()+'COMMIT;','r2_second')
 check('second_connection_blocked',wait_for("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='r2_second' AND cardinality(pg_blocking_pids(pid))>0);"))
 left,right=finish(first),finish(second)
 check('concurrent_exactly_once',left['result']=='success' and right['result']=='already_handled' and left['message_id']==right['message_id'] and replies()==1 and count('audit_log')==1)
 meta=json.loads(run("SELECT metadata FROM messages WHERE role='assistant';"))
 check('actual_canonical_metadata',all(meta[k]==v for k,v in proof().items()) and meta['control_commit']=='ai' and meta['escalation_action']=='clarification')
 check('same_source_substitution_denied',invoke(content='Different question?')['result']=='response_substitution' and replies()==1 and count('audit_log')==1)
 run(f"UPDATE conversations SET status='human_control' WHERE id='{t}';")
 check('human_control_denied',invoke()['result']=='already_under_human_control');run(f"UPDATE conversations SET status='open' WHERE id='{t}';")
 nextsid=uid(5);visitor(nextsid,'2026-11-26 00:01:00+00')
 check('same_intent_cap',invoke(nextsid)['result']=='max_clarifications_reached' and replies()==1)
 # Force failure after canonical writer to prove audit and message share one transaction.
 run("CREATE FUNCTION public.reject_r2_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'native audit failure'; END;$$;CREATE TRIGGER reject_r2_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION public.reject_r2_audit();")
 run('SET ROLE service_role;'+call(nextsid,reason='clarification_new_intent_no_kb_match'),deny=True)
 check('audit_failure_rolls_back_reply',replies()==1 and count('audit_log')==1)
 run('DROP TRIGGER reject_r2_audit ON audit_log;DROP FUNCTION public.reject_r2_audit();')
 check('new_intent_atomic_exception',invoke(nextsid,reason='clarification_new_intent_no_kb_match')['result']=='success' and replies()==2 and count('audit_log')==2)
 check('new_intent_replay',invoke(nextsid,reason='clarification_new_intent_no_kb_match')['result']=='already_handled' and replies()==2 and count('audit_log')==2)
 visitor(uid(6),'2026-11-26 00:02:00+00')
 check('superseded_source',invoke(nextsid,reason='clarification_new_intent_no_kb_match')['result']=='superseded_source' and replies()==2)
 run(rollback)
 check('exact_rollback',(md5(sig),acl(sig),md5(canon),acl(canon))==before and run(f"SELECT to_regprocedure('{newsig}') IS NULL;")=='t' and replies()==2 and count('audit_log')==2)
 run(rollback,deny=True)
 print('C3_R2_BOUND_NATIVE|'+json.dumps(dict(status='PASS',assertions=len(checks),production_writes=0)))
finally:
 for proc in workers:
  if proc.poll() is None:proc.terminate();proc.communicate(timeout=10)
 if created:run('DROP DATABASE IF EXISTS c3_r2_native;',maintenance)
 (out/'r2-bound-native-assertions.json').write_text(json.dumps(checks,indent=2)+'\n')
 (out/'r2-bound-native-commands.json').write_text(json.dumps(cmds,indent=2)+'\n')
