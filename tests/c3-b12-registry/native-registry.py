"""Real multi-connection PostgreSQL; disposable local DB only, never hosted Auth proof."""
import pathlib,json,subprocess,urllib.parse,argparse,time,os
p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--out',required=True);a=p.parse_args();u=urllib.parse.urlparse(a.database);assert u.hostname in ['127.0.0.1','localhost'];R=pathlib.Path(__file__).resolve().parents[2];out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True);commands=[];checks=[];maint=urllib.parse.urlunparse(u._replace(path='/postgres'));db=urllib.parse.urlunparse(u._replace(path='/c3_b12_registry_native'))
def run(s,d=None,fail=False):
 r=subprocess.run(['psql',d or db,'-X','-qAt','-v','ON_ERROR_STOP=1'],input=s,text=True,capture_output=True,timeout=30);commands.append(dict(sql=s,exit=r.returncode,stdout=r.stdout,stderr=r.stderr));assert (r.returncode!=0 if fail else r.returncode==0),r.stderr;return r.stdout.strip()
def uid(n):return 'fb120000-0000-4000-8000-'+str(n).zfill(12)
def yes(name,s,v='t'):actual=run(s).splitlines()[-1];assert actual==v,(name,actual,v);checks.append(dict(name=name,result='PASS'))
def spawn(sql,name):return subprocess.Popen(['psql',db,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',sql],text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={**os.environ,'PGAPPNAME':'b12_'+name})
def observe(name,condition):
 end=time.monotonic()+8
 while time.monotonic()<end:
  if run("select exists(select 1 from pg_stat_activity where application_name='b12_"+name+"' and "+condition+")")=='t':return
  time.sleep(.03)
 raise AssertionError('real concurrent session not observed: '+name)
def done(proc):s,e=proc.communicate(timeout=15);assert proc.returncode==0,e;commands.append(dict(concurrent=True,exit=proc.returncode,stdout=s,stderr=e));return s
try:
 run('CREATE DATABASE c3_b12_registry_native;',maint)
 setup="SET check_function_bodies=false; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;"
 for role in ['anon','authenticated','service_role']:setup+="DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='"+role+"') THEN CREATE ROLE "+role+"; END IF;END$$;"
 import re
 schema=(R/'tests/c3-uat-isolation/current-schema.sql').read_text()
 for table in ['ce_evaluation_job','ce_evaluation_state','ce_automation_runtime','conversation_evaluation','conversation_evaluation_attempt']:
  setup+=re.search(r'CREATE TABLE public\."'+table+r'"\(.*?\);',schema,re.S)[0]
 setup+='''CREATE TABLE conversations(id uuid PRIMARY KEY,company_id uuid,channel_config_id uuid,metadata_source jsonb DEFAULT '{}'::jsonb); CREATE TABLE messages(id uuid PRIMARY KEY,conversation_id uuid,role text,content text,is_recalled boolean DEFAULT false); CREATE TABLE channel_config(id uuid PRIMARY KEY,company_id uuid); CREATE TABLE c3_uat_conversation_scope(conversation_id uuid PRIMARY KEY REFERENCES conversations(id),company_id uuid,channel_id uuid,run_id uuid); ALTER TABLE c3_uat_conversation_scope ENABLE ROW LEVEL SECURITY; REVOKE ALL ON c3_uat_conversation_scope FROM PUBLIC,anon,authenticated,service_role; ALTER TABLE ce_evaluation_job ADD PRIMARY KEY(id); ALTER TABLE ce_evaluation_job ADD UNIQUE(job_key); ALTER TABLE ce_evaluation_state ADD PRIMARY KEY(conversation_id); ALTER TABLE ce_automation_runtime ADD PRIMARY KEY(singleton); CREATE FUNCTION ce_current_evaluation_fingerprint() RETURNS text LANGUAGE sql AS $$SELECT repeat('a',64)$$;  CREATE FUNCTION ce_trigger_snapshot_hash_v1(uuid) RETURNS text LANGUAGE sql AS $$SELECT repeat('b',64)$$;'''
 rows=json.loads((R/'tests/c3-b12-registry/captured-functions.json').read_text())
 for r in rows:
  setup+=r['definition']+'; REVOKE ALL ON FUNCTION public.'+r['signature']+' FROM PUBLIC,anon,authenticated,service_role;'
  if 'service_role=' in r['acl']:setup+='GRANT EXECUTE ON FUNCTION public.'+r['signature']+' TO service_role;'
 setup+="CREATE TRIGGER zz_c3_uat_evaluation_learning_guard BEFORE INSERT OR UPDATE ON conversation_evaluation FOR EACH ROW EXECUTE FUNCTION c3_uat_evaluation_learning_guard(); CREATE FUNCTION ce_realtime_assistant_message_trigger_v1() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.role='assistant' THEN PERFORM ce_dispatch_realtime_evaluation_v1(NEW.conversation_id);END IF;RETURN NEW;END$$; CREATE TRIGGER dispatch AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION ce_realtime_assistant_message_trigger_v1(); INSERT INTO ce_automation_runtime(singleton,enabled,global_concurrency,per_company_concurrency) VALUES(true,true,2,2);"
 run(setup)
 run(json.loads((R/'tests/c3-b12-registry/captured-company-helper.json').read_text())['definition']+';')
 sink=json.loads((R/'tests/c3-b12-registry/captured-sink-dependency.json').read_text())
 run(sink['function_definition']+';CREATE TABLE hf3_learning_case(conversation_id uuid);CREATE TABLE evaluation_training_outbox(evaluation_id uuid);CREATE TRIGGER learning_guard BEFORE INSERT OR UPDATE ON hf3_learning_case FOR EACH ROW EXECUTE FUNCTION c3_uat_learning_sink_guard();CREATE TRIGGER training_guard BEFORE INSERT OR UPDATE ON evaluation_training_outbox FOR EACH ROW EXECUTE FUNCTION c3_uat_learning_sink_guard();')
 run((R/'sql/c3_b12_registry_isolation_forward_proposed.sql').read_text())
 co,ch,syn,normal,other=uid(1),uid(2),uid(3),uid(4),uid(5)
 run(f"INSERT INTO channel_config VALUES('{ch}','{co}'); INSERT INTO conversations(id,company_id,channel_config_id,metadata_source) VALUES('{syn}','{co}','{ch}','{{}}'),('{normal}','{co}','{ch}','{{\"exclude_training\":true}}'),('{other}','{co}','{ch}','{{}}'); INSERT INTO c3_uat_conversation_scope VALUES('{syn}','{co}','{ch}','{uid(6)}'); INSERT INTO ce_evaluation_state(conversation_id,company_id,revision) SELECT id,company_id,1 FROM conversations;")
 for n,conv in enumerate([syn,normal,other]):run(f"INSERT INTO messages(id,conversation_id,role,content) VALUES('{uid(20+n*2)}','{conv}','visitor','natural customer question'),('{uid(21+n*2)}','{conv}','assistant','normal answer');")
 yes('registry exclusion independent of flags',f"SELECT NOT ce_conversation_evaluable_v1('{syn}')")
 yes('metadata spoof alone cannot exclude unregistered normal',f"SELECT ce_conversation_evaluable_v1('{normal}')")
 yes('normal dispatch creates job / synthetic dispatch creates none',f"SELECT count(*)=0 FROM ce_evaluation_job WHERE conversation_id='{syn}'")
 yes('normal dispatch preserved',f"SELECT count(*)=2 FROM ce_evaluation_job WHERE conversation_id IN('{normal}','{other}')")
 for n in range(11):run(f"INSERT INTO ce_evaluation_job(id,job_key,conversation_id,company_id,snapshot_hash,evaluation_fingerprint,expected_revision,source,priority,status,attempts) VALUES('{uid(100+n)}','{str(n).zfill(64)}','{syn}','{co}','{str(n).zfill(64)}',repeat('a',64),1,'ce_dwell',70,'queued',1)")
 # Actual native evaluation rows, with real required columns, before late registry insertion.
 for ident,conv in [(200,normal),(201,other)]:
  run(f"INSERT INTO conversation_evaluation(id,attempt_id,conversation_id,evaluation_contract_version,input_snapshot_hash,accuracy_score,policy_score,tone_score,sales_score,context_score,hallucination_risk_score,overall_score,severity,training_eligible,model_version,prompt_version,kb_snapshot_id,policy_snapshot_id,source_deployment,evaluated_by,company_id) VALUES('{uid(ident)}','{uid(300)}','{conv}','native',repeat('b',64),50,50,50,50,50,0,50,'none',true,'native','native','native','native','native','{uid(301)}','{co}')")
 frozen=run(f"SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM ce_evaluation_job j WHERE conversation_id='{syn}'")
 yes('direct snapshot enqueue excluded',f"SELECT ce_enqueue_current_snapshot_v1('{syn}','manual',now())->>'result'",'conversation_not_evaluable')
 yes('direct lower enqueue excluded',f"SELECT ce_enqueue_evaluation_v1('{syn}',repeat('c',64),repeat('a',64),1,'manual',now())->>'result'",'conversation_not_evaluable')
 for n in range(11):yes('existing synthetic specific claim '+str(n),f"SELECT ce_claim_specific_job_v1('{uid(100+n)}','native')->>'result'",'conversation_not_evaluable')
 yes('normal enqueue stale CAS preserved',f"SELECT ce_enqueue_evaluation_v1('{normal}',repeat('b',64),repeat('a',64),99,'manual',now())->>'result'",'stale_revision')
 yes('normal enqueue idempotent retry',f"SELECT ce_enqueue_evaluation_v1('{normal}',repeat('b',64),repeat('a',64),1,'manual',now())->>'result'",'already_queued')
 run(f"UPDATE ce_evaluation_job SET status='running' WHERE id='{uid(100)}'")
 yes('synthetic canonical attempt initialization blocked',f"SELECT ce_automation_initiate_canonical_v1('{uid(100)}','native',repeat('b',64),'native','native','native','{{}}'::jsonb,repeat('a',64),'native','native')->>'result'",'conversation_not_evaluable')
 run(f"UPDATE ce_evaluation_job SET status='queued' WHERE id='{uid(100)}'")
 yes('synthetic attempt sink empty',f"SELECT count(*)=0 FROM conversation_evaluation_attempt WHERE conversation_id='{syn}'")
 # Truly overlapping database connections; the second blocks on the advisory claim lock.
 x=spawn("BEGIN; SELECT id FROM ce_claim_evaluation_jobs_v1('a',1);SELECT pg_sleep(1.4);COMMIT;",'claimA');observe('claimA',"wait_event='PgSleep'")
 y=spawn("BEGIN;SELECT id FROM ce_claim_evaluation_jobs_v1('b',1);COMMIT;",'claimB');observe('claimB',"wait_event_type='Lock'");done(x);done(y);checks.append(dict(name='real two-connection claim overlap and lock wait',result='PASS'))
 yes('normal jobs exactly once / attempts one',f"SELECT count(*)=2 AND min(attempts)=1 AND max(attempts)=1 FROM ce_evaluation_job WHERE conversation_id IN('{normal}','{other}') AND status='running'")
 assert run(f"SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM ce_evaluation_job j WHERE conversation_id='{syn}'")==frozen;checks.append(dict(name='all11 synthetic full rows/status/attempts/lease unchanged',result='PASS'))
 # Cross-tenant job must never be claimed, regardless of otherwise legitimate conversation.
 run(f"INSERT INTO ce_evaluation_job(id,job_key,conversation_id,company_id,snapshot_hash,evaluation_fingerprint,expected_revision,source,priority,status,attempts) VALUES('{uid(130)}',repeat('d',64),'{normal}','{uid(999)}',repeat('d',64),repeat('a',64),1,'manual',100,'queued',1)")
 yes('cross tenant specific rejection',f"SELECT ce_claim_specific_job_v1('{uid(130)}','foreign')->>'result'",'tenant_mismatch')
 yes('cross tenant stays queued unchanged',f"SELECT attempts=1 AND status='queued' AND lease_owner IS NULL FROM ce_evaluation_job WHERE id='{uid(130)}'")
 # Registry INSERT is truly blocked while claim transaction holds SHARE; no sequential concurrency claim.
 x=spawn(f"BEGIN;SELECT ce_claim_specific_job_v1((SELECT id FROM ce_evaluation_job WHERE conversation_id='{other}' LIMIT 1),'holder');SELECT pg_sleep(1.4);COMMIT;",'holder');observe('holder',"wait_event='PgSleep'")
 y=spawn(f"INSERT INTO c3_uat_conversation_scope VALUES('{other}','{co}','{ch}','{uid(6)}')",'registryWriter');observe('registryWriter',"wait_event_type='Lock'");done(x);done(y);checks.append(dict(name='real registry writer/claim lock race linearized',result='PASS'))
 yes('late registry recognized by subsequent eligibility',f"SELECT NOT ce_conversation_evaluable_v1('{other}')")
 # Opposite lock order: a registry writer commits first; blocked claim must see that committed scope.
 late=uid(7)
 run(f"INSERT INTO conversations(id,company_id,channel_config_id) VALUES('{late}','{co}','{ch}');INSERT INTO ce_evaluation_state(conversation_id,company_id,revision) VALUES('{late}','{co}',1);INSERT INTO messages(id,conversation_id,role,content) VALUES('{uid(30)}','{late}','visitor','legitimate question'),('{uid(31)}','{late}','assistant','normal answer')")
 late_job=run(f"SELECT id FROM ce_evaluation_job WHERE conversation_id='{late}'")
 late_before=run(f"SELECT to_jsonb(j) FROM ce_evaluation_job j WHERE id='{late_job}'")
 x=spawn(f"BEGIN;INSERT INTO c3_uat_conversation_scope VALUES('{late}','{co}','{ch}','{uid(6)}');SELECT pg_sleep(1.4);COMMIT;",'registryFirst');observe('registryFirst',"wait_event='PgSleep'")
 y=spawn(f"SELECT ce_claim_specific_job_v1('{late_job}','waiter')",'claimAfterWriter');observe('claimAfterWriter',"wait_event_type='Lock'");done(x);result=done(y);assert 'conversation_not_evaluable' in result,result
 assert run(f"SELECT to_jsonb(j) FROM ce_evaluation_job j WHERE id='{late_job}'")==late_before
 checks.append(dict(name='writer-first real concurrency: committed registry observed / job unchanged',result='PASS'))
 # Preserve normal learning/training, refuse registered synthetic and historical evaluation links.
 run(f"INSERT INTO hf3_learning_case VALUES('{normal}'),('{syn}');INSERT INTO evaluation_training_outbox VALUES('{uid(200)}'),('{uid(201)}')")
 yes('normal learning preserved / synthetic zero spill',f"SELECT count(*)=1 AND bool_and(conversation_id='{normal}') FROM hf3_learning_case")
 yes('normal training preserved / registered historical evaluation zero spill',f"SELECT count(*)=1 AND bool_and(evaluation_id='{uid(200)}') FROM evaluation_training_outbox")
 # Native RLS/RBAC subjects only; not production-issued Auth evidence.
 run("SET ROLE authenticated;SELECT * FROM c3_uat_conversation_scope;",fail=True)
 run(f"SET ROLE authenticated;SELECT ce_conversation_evaluable_v1('{normal}');",fail=True)
 yes('service role eligible RPC preserved',f"SET ROLE service_role;SELECT ce_conversation_evaluable_v1('{normal}')")
 # A minimal native sink uses the exact captured trigger body: prove its exclusion rather than an unrelated NOT NULL error.
 run('CREATE TABLE b12_evaluation_sink(conversation_id uuid,training_eligible boolean);CREATE TRIGGER scope_guard BEFORE INSERT OR UPDATE ON b12_evaluation_sink FOR EACH ROW EXECUTE FUNCTION c3_uat_evaluation_learning_guard();')
 run(f"INSERT INTO b12_evaluation_sink VALUES('{normal}',true)")
 yes('normal legitimate evaluation sink preserved',"SELECT count(*)=1 AND bool_and(training_eligible) FROM b12_evaluation_sink")
 run(f"INSERT INTO b12_evaluation_sink VALUES('{syn}',true)",fail=True)
 assert 'C3_UAT_EVALUATION_EXCLUDED' in commands[-1]['stderr'];checks.append(dict(name='exact synthetic sink rejection code',result='PASS'))
 yes('synthetic evaluation guard has zero spill',f"SELECT count(*)=0 FROM b12_evaluation_sink WHERE conversation_id='{syn}'")
 # Reaper must preserve even expired synthetic leases while reclaiming legitimate expired work.
 run(f"UPDATE ce_evaluation_job SET status='running',lease_expires_at=now()-interval '1 minute',lease_owner='native' WHERE id='{uid(100)}';UPDATE ce_evaluation_job SET lease_expires_at=now()-interval '1 minute' WHERE conversation_id='{normal}' AND status='running'")
 expired=run(f"SELECT to_jsonb(j) FROM ce_evaluation_job j WHERE id='{uid(100)}'")
 run('SELECT ce_reap_expired_jobs_v1()')
 assert run(f"SELECT to_jsonb(j) FROM ce_evaluation_job j WHERE id='{uid(100)}'")==expired
 checks.append(dict(name='synthetic expired lease untouched',result='PASS'))
 yes('normal expired lease reclaimed',f"SELECT status='queued' AND lease_owner IS NULL FROM ce_evaluation_job WHERE conversation_id='{normal}' AND company_id='{co}' LIMIT 1")
 yes('synthetic evaluation sink zero rows',f"SELECT count(*)=0 FROM conversation_evaluation WHERE conversation_id='{syn}'")
 # Guarded rollback and original exact definitions/configs restored.
 run((R/'sql/c3_b12_registry_isolation_rollback_proposed.sql').read_text())
 for r in rows:yes('rollback exact '+r['signature'],"SELECT md5(pg_get_functiondef('public."+r['signature']+"'::regprocedure))",r['definition_md5'])
 run((R/'sql/c3_b12_registry_isolation_forward_proposed.sql').read_text())
 run("CREATE OR REPLACE FUNCTION ce_conversation_evaluable_v1(p_conversation_id uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$SELECT false$$;")
 run((R/'sql/c3_b12_registry_isolation_rollback_proposed.sql').read_text(),fail=True)
 checks.append(dict(name='rollback refuses later owner change',result='PASS'))
 print('C3_B12_REGISTRY_NATIVE|PASS|true_multi_connection|eligibility|enqueue|general_specific_claim|11_rows_immutable|tenant|RBAC|rollback')
finally:
 (out/'b12-native-result.json').write_text(json.dumps(dict(checks=checks,commands=commands,production_Auth='NOT_RUN',production_writes=0),indent=2)+'\n');run('DROP DATABASE IF EXISTS c3_b12_registry_native;',maint)
