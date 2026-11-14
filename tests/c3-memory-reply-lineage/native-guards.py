"""Local PostgreSQL 17, independent psql processes; no hosted/product traffic."""
import argparse,subprocess,json,pathlib,urllib.parse,os,time
p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--out',required=True);a=p.parse_args()
u=urllib.parse.urlparse(a.database)
if u.hostname not in ('127.0.0.1','localhost') or u.path!='/c3_uat_isolated_native':raise SystemExit('Only disposable local CI database allowed')
root=pathlib.Path.cwd();out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True);commands=[];tests=[]
base=root/'tests/c3-memory-reply-lineage';maintenance=urllib.parse.urlunparse(u._replace(path='/postgres'))
def run(q,name='observer',db=None,reject=None):
 r=subprocess.run(['psql',db or a.database,'-X','-qAt','-v','ON_ERROR_STOP=1'],input=q,capture_output=True,text=True,env={**os.environ,'PGAPPNAME':'c3reply_'+name},timeout=25)
 commands.append(dict(name=name,sql=q,exit_code=r.returncode,stdout=r.stdout,stderr=r.stderr))
 if reject:assert r.returncode!=0 and reject in r.stderr,r.stderr
 else:assert r.returncode==0,r.stderr
 return r.stdout.strip()
def val(q):return run(q).splitlines()[-1]
def uid(n):return 'fd070000-0000-4000-8000-'+str(n).zfill(12)
co,conv,source,reply=[uid(n) for n in [1,2,3,4]]
def spawn(q,name):return subprocess.Popen(['psql',a.database,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',q],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'PGAPPNAME':'c3reply_'+name})
def observe(predicate):
 until=time.monotonic()+6
 while time.monotonic()<until:
  rows=json.loads(val("SELECT coalesce(json_agg(json_build_object('pid',pid,'name',application_name,'wait',wait_event,'blockers',pg_blocking_pids(pid))),'[]') FROM pg_stat_activity WHERE application_name LIKE 'c3reply_%' AND pid<>pg_backend_pid()"))
  if predicate(rows):return rows
  time.sleep(.04)
 raise AssertionError('Independent connection/lock not actually observed')
def end(process):
 stdout,stderr=process.communicate(timeout=15);commands.append(dict(pid=process.pid,exit_code=process.returncode,stdout=stdout,stderr=stderr));assert process.returncode==0,stderr
 return stdout
def quoted(value):return "'"+json.dumps(value).replace("'","''")+"'::jsonb"
def setup():
 run('TRUNCATE c3_memory_reply_lifecycle_receipt,conversation_memory_state_event,conversation_memory_state,conversation_commerce_state,messages,conversations,company;')
 run(f"INSERT INTO company VALUES('{co}');INSERT INTO conversations VALUES('{conv}','{co}');INSERT INTO messages(id,conversation_id,role,content,metadata) VALUES('{source}','{conv}','visitor','Does the custom service include a morning visit?','{{}}');INSERT INTO conversation_commerce_state VALUES('{conv}','{co}',1);")
 memory=dict(version='conversation-memory-1.0.0',conversation_id=conv,company_id=co,source_message_id=source,memory_revision=1,commerce_state_revision=1,updated_from_turn=1,current_customer_facts=[dict(key='location',value='studio',authority='customer')],question_lifecycle=[dict(source_message_id=source,text='Does the custom service include a morning visit?',status='pending',entity_id='custom-service')],open_questions=['Does the custom service include a morning visit?'],pending_actions=[],handoff_relevant_state=dict(open_questions=['Does the custom service include a morning visit?'],pending_actions=[]))
 result=json.loads(val(f"SELECT c3_commit_conversation_memory_tx('{conv}','{co}','{source}',1,0,{quoted(memory)},'parent',1)"));assert result['result']=='success'
 meta=dict(source_message_id=source,b2_source_message_id=source,control_commit='ai',b2_commit_source='commit_ai_reply_tx',b2_expected_company_id=co,b2_expected_revision=1,b2_gate_contract='executeB2PersistenceGate:allow_after_revalidation')
 run(f"INSERT INTO messages(id,conversation_id,role,content,metadata) VALUES('{reply}','{conv}','assistant','Documented morning visits are available.',{quoted(meta)})")
 parent=json.loads(val(f"SELECT to_jsonb(e) FROM conversation_memory_state_event e WHERE source_message_id='{source}'"))
 memory['memory_revision']=2;memory['question_lifecycle'][0].update(status='resolved',resolution='canonical_kb_direct_answer',resolution_source_message_id=reply);memory['open_questions']=[];memory['handoff_relevant_state']['open_questions']=[]
 return memory,parent
def finalize(memory,parent,company=co):return f"SELECT c3_finalize_memory_reply_tx('{conv}','{company}','{source}','{reply}',1,'{parent['memory_hash']}',{quoted(memory)},'delivered projection')"
try:
 run('CREATE DATABASE c3_memory_reply_native;',db=maintenance)
 a.database=urllib.parse.urlunparse(u._replace(path='/c3_memory_reply_native'))
 run((base/'minimal-memory-schema.sql').read_text().replace('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;','')); run((base/'captured-memory-functions.sql').read_text())
 run('CREATE TRIGGER memory_lineage BEFORE INSERT OR UPDATE ON conversation_memory_state FOR EACH ROW EXECUTE FUNCTION c3_enforce_conversation_memory_lineage_tg();')
 assert val("SELECT md5(pg_get_functiondef('c3_commit_conversation_memory_tx(uuid,uuid,uuid,bigint,bigint,jsonb,text,bigint)'::regprocedure))")=='65b17cdee445f6e23d2bcdbe124af6c9'
 assert val("SELECT md5(pg_get_functiondef('c3_enforce_conversation_memory_lineage_tg()'::regprocedure))")=='05edecc570d47e2fb3a6194dbb207b3e'
 tests.append(dict(name='fresh captured Memory RPC and lineage trigger byte identity',result='PASS'))
 run("SELECT set_config('c3.expected_memory_rpc_md5','65b17cdee445f6e23d2bcdbe124af6c9',false);SELECT set_config('c3.expected_memory_trigger_md5','05edecc570d47e2fb3a6194dbb207b3e',false);"+(root/'sql/c3_memory_reply_lineage_proposed.sql').read_text())
 for kind in ['exact_retry','conflicting_payload']:
  memory,parent=setup();q=finalize(memory,parent)
  first=spawn('BEGIN;'+q+';SELECT pg_sleep(3);COMMIT;','first')
  barrier=observe(lambda rows:any(r['name']=='c3reply_first' and r['wait']=='PgSleep' for r in rows))
  changed=json.loads(json.dumps(memory))
  if kind=='conflicting_payload':changed['question_lifecycle'][0]['text']='conflicting lifecycle payload'
  second=spawn('BEGIN;'+finalize(changed,parent)+';COMMIT;','second')
  blocked=observe(lambda rows:any(r['name']=='c3reply_second' and r['blockers'] for r in rows))
  left,right=end(first),end(second)
  results=[json.loads(next(line for line in value.splitlines() if line.startswith('{'))) for value in [left,right]]
  assert results[0]['result']=='success' and results[0]['idempotent'] is False,results
  if kind=='exact_retry':assert results[1]['result']=='success' and results[1]['idempotent'] is True,results
  else:assert results[1]['result']=='reply_replay_conflict',results
  assert val('SELECT count(*) FROM c3_memory_reply_lifecycle_receipt')=='1'
  assert val('SELECT revision FROM conversation_memory_state')=='2'
  assert json.loads(val(f"SELECT to_jsonb(e) FROM conversation_memory_state_event e WHERE source_message_id='{source}'"))==parent
  assert val("SELECT count(*) FROM messages WHERE role='assistant'")=='1'
  tests.append(dict(name='real two-process '+kind,result='PASS',barrier=barrier,blocked=blocked,replies=results,exactly_once_receipts=1,customer_parent_unchanged=True))
 memory,parent=setup()
 for role in ['anon','authenticated']:run('SET ROLE '+role+';'+finalize(memory,parent)+';',reject='permission denied')
 run('SET ROLE service_role;INSERT INTO c3_memory_reply_lifecycle_receipt DEFAULT VALUES;',reject='permission denied')
 result=json.loads(val('SET ROLE service_role;'+finalize(memory,parent)));assert result['result']=='success'
 tests.append(dict(name='native SQL ACL denies client callers/direct writes; service RPC allowed',result='PASS',hosted_auth='NOT_RUN'))
 result=json.loads(val(finalize(memory,parent,uid(99))));assert result['result']=='tenant_mismatch';tests.append(dict(name='native cross-tenant RPC rejection',result='PASS'))
 status='PASS';code=0
except Exception as error:
 status='FAIL';code=1;tests.append(dict(name='native test execution',result='FAIL',error=str(error)))
finally:
 try:run('DROP DATABASE c3_memory_reply_native;',db=maintenance);cleanup='PASS'
 except Exception as error:cleanup='FAIL';code=1;tests.append(dict(name='disposable cleanup',result='FAIL',error=str(error)))
 (out/'memory-reply-native.json').write_text(json.dumps(dict(status=status,tests=tests,cleanup=cleanup,hosted_runtime='NOT_RUN',production_writes=0),indent=2)+'\n')
 (out/'memory-reply-native-commands.json').write_text(json.dumps(commands,indent=2)+'\n')
 print('C3_MEMORY_NATIVE|'+json.dumps(dict(status=status,tests=len(tests),cleanup=cleanup)))
raise SystemExit(code)
