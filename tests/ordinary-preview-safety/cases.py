company='a1000000-0000-4000-8000-000000000001';other='a2000000-0000-4000-8000-000000000001';channel='b1000000-0000-4000-8000-000000000001';foreign='b2000000-0000-4000-8000-000000000001';admin='a1100000-0000-4000-8000-000000000001';agent='a1200000-0000-4000-8000-000000000001';qa='a1300000-0000-4000-8000-000000000001';norole='a1400000-0000-4000-8000-000000000001';origin='https://console-chat-hub.lovable.app'
sql(f"INSERT INTO company(id,is_active)VALUES('{company}',true),('{other}',true);INSERT INTO channel_config(id,company_id,is_active,channel_type,allowed_origins)VALUES('{channel}','{company}',true,'web_widget',ARRAY['{origin}']),('{foreign}','{other}',true,'web_widget',ARRAY['{origin}']);INSERT INTO company_membership(user_id,company_id,is_active,role)VALUES('{admin}','{company}',true,'admin'),('{agent}','{company}',true,'agent'),('{qa}','{company}',true,'qa');INSERT INTO ce_automation_runtime(singleton,enabled,worker_url,worker_secret_id,global_concurrency,per_company_concurrency,debounce_minutes,max_age_minutes,enqueue_batch_limit)VALUES(true,false,'https://native-worker.invalid','d1000000-0000-4000-8000-000000000001',10,10,0,1,100);INSERT INTO vault.decrypted_secrets VALUES('d1000000-0000-4000-8000-000000000001','native-test-secret');")
def actor_stmt(stmt,who=admin,o=origin):return 'BEGIN;SET LOCAL ROLE authenticated;SET LOCAL request.jwt.claim.sub='+literal(who)+';SET LOCAL request.headers='+literal(json.dumps({'origin':o}))+ ';'+stmt+';COMMIT;'
def call(name,args,who=admin,o=origin,fail=False):return sql(actor_stmt('SELECT public.'+name+'('+','.join('NULL'if x is None else literal(x)for x in args)+')',who,o),fail)
def bootstrap(req='c1000000-0000-4000-8000-000000000001',ch=channel,who=admin,o=origin):return json.loads(call('widget_control_preview_bootstrap',[ch,req],who,o))
for who in [agent,qa,norole]:call('widget_control_preview_bootstrap',[channel,'c1000000-0000-4000-8000-000000000001'],who,fail=True)
call('widget_control_preview_bootstrap',[foreign,'c1000000-0000-4000-8000-000000000001'],fail=True);call('widget_control_preview_bootstrap',[channel,'c1000000-0000-4000-8000-000000000001'],o='https://wrong-origin.invalid',fail=True)
check('Agent QA no-role foreign channel and wrong Origin denied before creation',sql('SELECT count(*) FROM widget_control_preview_scope')=='0')
for role in ['anon','authenticated','service_role']:sql('SET ROLE '+role+';INSERT INTO public.widget_control_preview_scope DEFAULT VALUES;',True)
check('registry cannot be written through public API roles',True)
sessions=[]
for i,text in enumerate(['你是誰？','Who are you?','請轉真人客服','Please connect me to a human.']):
 req=f'c1000000-0000-4000-8000-{i+2:012d}';s=bootstrap(req);sessions.append(s);check('bootstrap original request replay '+str(i),bootstrap(req)==s)
 args=[s['conversation_id'],s['session_token'],text,f'd1000000-0000-4000-8000-{i+2:012d}'];r=json.loads(call('widget_control_preview_message_tx',args));again=json.loads(call('widget_control_preview_message_tx',args));check('original source receipt exactly once '+str(i),r['message_id']==again['message_id'])
 counts=json.loads(sql("SELECT json_build_object('visitor',count(*)FILTER(WHERE role='visitor'),'assistant',count(*)FILTER(WHERE role='assistant' AND content<>'__THINKING__'),'thinking',count(*)FILTER(WHERE content='__THINKING__'))FROM messages WHERE conversation_id="+literal(s['conversation_id'])))
 check('one Visitor one Assistant zero thinking '+str(i),counts==dict(visitor=1,assistant=1,thinking=0));check('CE eligibility excluded '+str(i),sql('SELECT ce_conversation_evaluable_v1('+literal(s['conversation_id'])+')')=='f')
 if i>=2:
  check('R1 pending without fabricated assignment '+str(i),sql("SELECT status||':'||coalesce(assigned_agent_id::text,'none')FROM conversations WHERE id="+literal(s['conversation_id']))=='pending:none')
  check('one real handoff with same-ticket Summary '+str(i),sql("SELECT count(*)FROM handoff_event WHERE conversation_id="+literal(s['conversation_id'])+" AND escalation_rule='R1' AND ai_summary IS NOT NULL")=='1')
 else:
  content=sql("SELECT content FROM messages WHERE role='assistant' AND conversation_id="+literal(s['conversation_id']));check('truthful deterministic identity '+str(i),'automated support assistant' in content or '自動客服助手' in content)
check('real realtime trigger never invoked for server preview',sql('SELECT count(*) FROM trigger_probe')=='0')
check('CE state jobs and worker HTTP are all zero after actual success',sql("SELECT (SELECT count(*)FROM ce_evaluation_state)::text||':'||(SELECT count(*)FROM ce_evaluation_job)::text||':'||(SELECT count(*)FROM dispatch_probe)::text")=='0:0:0')
s=sessions[0];client='d1000000-0000-4000-8000-000000000099'
for args,who,o in [([s['conversation_id'],'x'*64,'Who are you?',client],admin,origin),([s['conversation_id'],s['session_token'],'Buy refrigerator',client],admin,origin),([s['conversation_id'],s['session_token'],'Who are you?',client],agent,origin),([s['conversation_id'],s['session_token'],'Who are you?',client],admin,'https://wrong.invalid')]:call('widget_control_preview_message_tx',args,who,o,True)
check('token Actor Origin and business forgery cannot persist',sql('SELECT count(*)FROM messages')=='8')
s=bootstrap('c1000000-0000-4000-8000-000000000050');barrier=__import__('threading').Barrier(2)
def race(i):barrier.wait();return json.loads(call('widget_control_preview_message_tx',[s['conversation_id'],s['session_token'],'Who are you?','d1000000-0000-4000-8000-000000000050']))
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:races=list(pool.map(race,[0,1]))
check('two real connections preserve exact source receipt',races[0]['message_id']==races[1]['message_id'] and sql('SELECT count(*)FROM messages WHERE conversation_id='+literal(s['conversation_id']))=='2')
normal=json.loads(sql("SELECT create_widget_session_tx('"+channel+"','"+'n'*64+"',NULL,'{\"console_preview\":\"ordinary-widget-control-v2\",\"exclude_training\":true}','"+origin+"')"));normal_id=normal['conversation_id'];sql("UPDATE conversations SET metadata_source='{\"source\":\"ordinary_widget_control_preview\",\"exclude_training\":true}'WHERE id="+literal(normal_id));check('ordinary customer cannot acquire exclusion from JSON flags',sql('SELECT widget_control_preview_excluded('+literal(normal_id)+')')=='f');sql("UPDATE conversations SET metadata_source='{}'WHERE id="+literal(normal_id))
v=json.loads(sql("SELECT receive_widget_message_tx("+literal(normal_id)+",'"+'n'*64+"','normal customer message','d1000000-0000-4000-8000-000000000060')"));sql('SELECT commit_ai_reply_tx('+literal(normal_id)+','+literal(v['message_id'])+",'normal assistant response',jsonb_build_object('source_message_id',"+literal(v['message_id'])+'))')
check('normal customer retains CE enqueue and Worker dispatch',sql('SELECT count(*)FROM ce_evaluation_job')=='1' and sql('SELECT count(*)FROM dispatch_probe')=='1')
check('normal original CE trigger instrumentation is active',int(sql('SELECT count(*)FROM trigger_probe'))>0)
job=sql('SELECT id FROM ce_evaluation_job LIMIT 1');check('normal interactive dwell still works with scheduler disabled',json.loads(sql('SELECT ce_claim_specific_job_v1('+literal(job)+",'native-worker')"))['result']=='claimed')
for i,s in enumerate(sessions):
 sql('INSERT INTO ce_evaluation_job(conversation_id,company_id,status,source,available_at,job_key)VALUES('+literal(s['conversation_id'])+','+literal(company)+",'queued','ce_dwell',now(),'stale-preview-"+str(i)+"')");j=sql("SELECT id FROM ce_evaluation_job WHERE job_key='stale-preview-"+str(i)+"'")
 check('historical interactive preview job denied '+str(i),json.loads(sql('SELECT ce_claim_specific_job_v1('+literal(j)+",'native-worker')"))['result']=='conversation_not_evaluable')
 before=sql('SELECT count(*)FROM dispatch_probe');sql('SELECT ce_dispatch_realtime_evaluation_v1('+literal(s['conversation_id'])+')');sql('SELECT ce_enqueue_current_snapshot_v1('+literal(s['conversation_id'])+",'ce_dwell',now()+interval '1 second')");time.sleep(.02);check('delayed Worker dispatch zero '+str(i),sql('SELECT count(*)FROM dispatch_probe')==before)
sql('UPDATE company_membership SET is_active=false WHERE user_id='+literal(admin));check('revocation never reactivates historical CE',all(sql('SELECT widget_control_preview_excluded('+literal(x['conversation_id'])+')')=='t'for x in sessions));call('widget_control_preview_context',[sessions[0]['conversation_id'],sessions[0]['session_token']],fail=True);sql('UPDATE company_membership SET is_active=true WHERE user_id='+literal(admin));sql((root/'sql/c3_ordinary_preview_safety_rollback.sql').read_text(),True);check('rollback refuses to remove used exclusions',True)
# No direct browser permission can alter a sealed Tenant/Session/metadata binding.
sql("UPDATE conversations SET metadata_source='{}' WHERE id="+literal(sessions[0]['conversation_id']),True)
sql('UPDATE conversations SET company_id='+literal(other)+'WHERE id='+literal(sessions[0]['conversation_id']),True)
check('protected Conversation binding cannot be reclassified',True)
# Existing C3 learning exclusion is an independent permanent branch.
sql('INSERT INTO c3_uat_conversation_scope(conversation_id) VALUES('+literal(normal_id)+')')
check('existing C3 learning scope still excludes',sql('SELECT c3_uat_learning_excluded('+literal(normal_id)+')')=='t')
# Token revocation must not activate delayed CE on historical preview receipts.
oldtoken=sessions[1]['session_token'];sql('UPDATE visitor_session SET session_token='+literal('rotated-native-token-'+'x'*40)+'WHERE id='+literal(sessions[1]['session_id']))
check('exclusion survives visitor token rotation',sql('SELECT widget_control_preview_excluded('+literal(sessions[1]['conversation_id'])+')')=='t')
call('widget_control_preview_context',[sessions[1]['conversation_id'],oldtoken],fail=True)
exec((folder/'cas.py').read_text())
if (folder/'runtime.mjs').exists():subprocess.run(['node',str(folder/'runtime.mjs')],check=True,env=os.environ)
out=pathlib.Path(os.environ.get('C3_PREVIEW_EVIDENCE','/tmp/c3-preview-safety-evidence'));out.mkdir(parents=True,exist_ok=True);(out/'native-proof.json').write_text(json.dumps({'status':'PASS','checks':checks,'commands':commands,'Hosted':False},ensure_ascii=False,indent=2)+'\n');print(json.dumps({'status':'PASS','count':len(checks),'Hosted':False,'checks':checks},ensure_ascii=False))
