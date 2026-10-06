"""Native PG17 / captured production bodies; offline SQL subjects are NOT hosted Auth."""
import argparse,subprocess,json,pathlib,urllib.parse,os,time,uuid,traceback
p=argparse.ArgumentParser();p.add_argument('--database',required=True);p.add_argument('--out',required=True);a=p.parse_args();u=urllib.parse.urlparse(a.database)
if u.hostname not in ('127.0.0.1','localhost') or u.path!='/c3_uat_isolated_native':raise SystemExit('Only disposable local named database permitted')
root=pathlib.Path.cwd();ev=[];commands=[];out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True)
def run(q,name='observer',reject=None):
 r=subprocess.run(['psql',a.database,'-X','-qAt','-v','ON_ERROR_STOP=1',],input=q,capture_output=True,text=True,env={**os.environ,'PGAPPNAME':'c3uat_'+name},timeout=25);commands.append(dict(sql=q,name=name,exit_code=r.returncode,stdout=r.stdout,stderr=r.stderr))
 if reject is not None:assert r.returncode!=0 and reject in r.stderr,r.stderr
 else:assert r.returncode==0,r.stderr
 return r.stdout.strip()
def val(q):return run(q).splitlines()[-1]
def yes(name,q,expected='t'):assert val(q)==expected,(name,commands[-1]);ev.append(dict(name=name,result='PASS'))
def file(f,prefix=''):
 return run(prefix+(root/f).read_text())
def uid(n):return 'fa140000-0000-4000-8000-'+str(n).zfill(12)
def actor(n,sql):return f"SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','{uid(n)}',false); SELECT set_config('request.jwt.claim.role','authenticated',false); "+sql
co,ch,vs,conv=uid(1),uid(2),uid(3),uid(4)
def spawn(q,name):return subprocess.Popen(['psql',a.database,'-X','-qAt','-v','ON_ERROR_STOP=1','-c',q],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env={**os.environ,'PGAPPNAME':'c3uat_'+name})
def observe(pred):
 until=time.monotonic()+6
 while time.monotonic()<until:
  d=json.loads(val("SELECT coalesce(json_agg(json_build_object('pid',pid,'name',application_name,'wait',wait_event,'blockers',pg_blocking_pids(pid))),'[]') FROM pg_stat_activity WHERE application_name LIKE 'c3uat_%' AND pid<>pg_backend_pid()"))
  if pred(d):return d
  time.sleep(.04)
 raise AssertionError('Independent process lock not observed')
def end(p):
 stdout,stderr=p.communicate(timeout=15);commands.append(dict(process=p.pid,exit_code=p.returncode,stdout=stdout,stderr=stderr));assert p.returncode==0,stderr;return stdout
try:
 version=val('SHOW server_version');assert version.startswith('17.'),version
 file('tests/c3-uat-isolation/current-schema.sql');baseline=json.loads(val("SELECT json_build_object('learning',md5(pg_get_functiondef('public.hf3_refresh_learning_case_tx(uuid)'::regprocedure)),'claim',md5(pg_get_functiondef('public.claim_feedback_delivery_tx()'::regprocedure)))"))
 file('supabase/migrations/20261006120000_c3_uat_learning_isolation.sql',f"SELECT set_config('c3.expected_learning_md5','{baseline['learning']}',false);")
 file('supabase/migrations/20261006120001_c3_uat_feedback_isolation.sql',f"SELECT set_config('c3.expected_claim_md5','{baseline['claim']}',false);")
 run(f"INSERT INTO company(id,slug,display_name,external_workspace_id,external_tenant_id,platform_company_id) VALUES('{co}','c3-uat-native','C3-UAT','native','native',141);INSERT INTO channel_config(id,company_id,name,channel_type) VALUES('{ch}','{co}','C3-UAT-native','web_widget'); INSERT INTO c3_uat_channel_scope VALUES('{ch}','{co}','{uid(99)}',now());")
 for n,role in [(10,'admin'),(11,'supervisor'),(12,'agent'),(13,'qa')]:
  run(f"INSERT INTO auth.users VALUES('{uid(n)}','c3-{n}@example.invalid');INSERT INTO agent_profile(user_id,display_name,email,role,status) VALUES('{uid(n)}','C3-{n}','c3-{n}@example.invalid','{'viewer' if role=='qa' else role}','active');INSERT INTO company_membership(company_id,user_id,role,is_active) VALUES('{co}','{uid(n)}','{role}',true);")
 for role in ['anon','authenticated','service_role']:run(f'SET ROLE {role}; SELECT * FROM c3_uat_channel_scope;',reject='permission denied')
 run(actor(10,"SELECT c3_uat_save_feedback_config('{\"is_active\":true,\"delay_minutes\":1440}'::jsonb);"))
 for n in [10,11,13]:yes('config legal role '+str(n),actor(n,"SELECT (c3_uat_feedback_config_context()->>'isolated')::boolean"))
 for n in [12,13]:run(actor(n,"SELECT c3_uat_save_feedback_config('{}')"),reject='Trusted role required')
 run(actor(10,"SELECT c3_uat_save_feedback_config('{\"company_id\":\"00000000-0000-0000-0000-000000000000\"}')"),reject='Config scope spoof denied')
 run(actor(10,"SELECT c3_uat_save_feedback_config('{\"delay_minutes\":1}')"),reject='check constraint')
 run(f"INSERT INTO visitor_session(id,channel_config_id) VALUES('{vs}','{ch}');INSERT INTO conversations(id,company_id,channel_config_id,visitor_session_id,status) VALUES('{conv}','{co}','{ch}','{vs}','resolved');")
 yes('authoritative registration',f"SELECT c3_uat_learning_excluded('{conv}')")
 schedule=actor(10,f"SELECT c3_uat_schedule_feedback('{conv}')")
 first=spawn('BEGIN;'+schedule+';SELECT pg_sleep(3);COMMIT;','first');barrier=observe(lambda d:any(x['name']=='c3uat_first' and x['wait']=='PgSleep' for x in d));second=spawn('BEGIN;'+schedule+';COMMIT;','second');locks=observe(lambda d:any(x['name']=='c3uat_second' and x['blockers'] for x in d));left,right=end(first),end(second)
 yes('concurrent scheduling exactly one',f"SELECT count(*) FROM feedback_request WHERE conversation_id='{conv}'",'1');ev.append(dict(name='real two-process lock race',result='PASS',barrier=barrier,locks=locks,replies=[left,right]))
 yes('real delay not shortened',f"SELECT scheduled_at >= created_at+interval '1439 minutes' FROM feedback_request WHERE conversation_id='{conv}'")
 yes('normal worker cannot claim fixture',"SET ROLE service_role; SELECT claim_feedback_delivery_tx()->>'result'",'none')
 yes('fixture future job not claimable',f"SET ROLE service_role; SELECT c3_uat_claim_feedback_delivery('{co}')->>'result'",'none')
 # Full current canonical lineage, deferred enqueue and all learning-trigger paths.
 bh='a'*64;att=uid(20);evaluation=uid(21)
 run(f"INSERT INTO conversation_evaluation_attempt(id,conversation_id,input_snapshot_hash,initiated_by,kb_snapshot_id,policy_snapshot_id,model_version,prompt_version,source_deployment,company_id,bundle_hash) VALUES('{att}','{conv}','{bh}','{uid(10)}','kb','policy','native-no-model','prompt','native-offline','{co}','{bh}');INSERT INTO ce_bundle_snapshot(attempt_id,conversation_id,company_id,bundle_hash,transcript_hash,evaluation_contract_version,model_version,prompt_version,kb_snapshot_id,policy_snapshot_id,canonical_input,normalized_transcript,grounding_evidence,grounding_manifest,truncation_manifest) SELECT id,conversation_id,company_id,bundle_hash,'{bh}',evaluation_contract_version,model_version,prompt_version,kb_snapshot_id,policy_snapshot_id,'offline-native','[]','[]','{{}}','{{}}' FROM conversation_evaluation_attempt WHERE id='{att}';INSERT INTO conversation_evaluation(id,attempt_id,conversation_id,evaluation_contract_version,input_snapshot_hash,accuracy_score,policy_score,tone_score,sales_score,context_score,hallucination_risk_score,hallucination_quality_score,overall_score,severity,model_version,prompt_version,kb_snapshot_id,policy_snapshot_id,source_deployment,evaluated_by,company_id,bundle_hash,review_status,reviewed_by,reviewed_at,training_eligible) SELECT '{evaluation}',id,conversation_id,evaluation_contract_version,input_snapshot_hash,50,50,50,50,50,50,50,50,'critical',model_version,prompt_version,kb_snapshot_id,policy_snapshot_id,source_deployment,initiated_by,company_id,bundle_hash,'accepted',initiated_by,now(),true FROM conversation_evaluation_attempt WHERE id='{att}';")
 yes('accepted low score cannot become training',f"SELECT NOT training_eligible FROM conversation_evaluation WHERE id='{evaluation}'")
 run(f"UPDATE conversation_evaluation SET training_eligible=true WHERE id='{evaluation}';UPDATE feedback_request SET status='responded',rating=1,responded_at=now() WHERE conversation_id='{conv}';INSERT INTO ce_discrepancy(evaluation_id,company_id,dimension,ai_claim,divergence_kind,severity) VALUES('{evaluation}','{co}','accuracy','synthetic','unsupported','critical');INSERT INTO ce_training_link(evaluation_id,company_id,link_kind) VALUES('{evaluation}','{co}','training_candidate');INSERT INTO handoff_event(conversation_id,handoff_reason,handoff_type) VALUES('{conv}','synthetic','ai_to_agent');SELECT hf3_refresh_learning_case_tx('{evaluation}');")
 yes('all real downstream learning sinks remain empty',f"SELECT NOT EXISTS(SELECT 1 FROM hf3_learning_case WHERE conversation_id='{conv}') AND NOT EXISTS(SELECT 1 FROM evaluation_training_outbox WHERE evaluation_id='{evaluation}')")
 run(f"INSERT INTO hf3_learning_case(company_id,conversation_id,evaluation_id) VALUES('{co}','{conv}','{evaluation}');INSERT INTO evaluation_training_outbox(evaluation_id,company_id,delivery_idempotency_key,source_deployment,evaluation_contract_version) SELECT id,company_id,id::text,source_deployment,evaluation_contract_version FROM conversation_evaluation WHERE id='{evaluation}';")
 yes('direct sink insertion excluded',f"SELECT NOT EXISTS(SELECT 1 FROM hf3_learning_case WHERE conversation_id='{conv}') AND NOT EXISTS(SELECT 1 FROM evaluation_training_outbox WHERE evaluation_id='{evaluation}')")
 run(actor(10,"SELECT c3_uat_save_feedback_config('{\"is_active\":false}')"))
 # Responded records remain intact; fresh pending requests are cancelled only while pending.
 yes('disable preserves responded record',f"SELECT status='responded' FROM feedback_request WHERE conversation_id='{conv}'")
 run((root/'sql/c3_uat_isolation_guarded_rollback.sql').read_text(),reject='Isolation rows still retained')
 ev.append(dict(name='elapsed-time delivery/token recovery',result='NOT_RUN',reason='Real 24h due time not elapsed; no clock change/backdating; not a runtime PASS'))
 status='PASS_SAFETY_SUBSET';exitcode=0
except Exception as e:status='FAIL';exitcode=1;ev.append(dict(name='native execution failure',result='FAIL',error=str(e),trace=traceback.format_exc()))
finally:
 report=dict(status=status,exit_code=exitcode,head=os.getenv('GITHUB_SHA'),scope='captured real trigger/lineage + native competition, not hosted Auth/runtime',hosted='NOT_TESTED',uat_start_allowed=False,evidence=ev,commands=commands);(out/'native-guards.json').write_text(json.dumps(report,indent=2));print(json.dumps({k:v for k,v in report.items() if k!='commands'},indent=2))
raise SystemExit(exitcode)
