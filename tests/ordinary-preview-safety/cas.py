# Actual source revision revalidation with an overlapping writer connection.
sql('INSERT INTO conversation_commerce_state(conversation_id,company_id,revision,source_message_id,state,state_hash)VALUES('+literal(normal_id)+','+literal(company)+',1,'+literal(v['message_id'])+",'{}','native-state')")
sql('INSERT INTO conversation_memory_state(conversation_id,company_id,revision,source_message_id,commerce_state_revision,memory,markdown_projection,memory_hash)VALUES('+literal(normal_id)+','+literal(company)+',1,'+literal(v['message_id'])+",1,'{\"customer_facts\":[]}','native prior memory','native-memory')")
memory_before=sql('SELECT row_to_json(m)FROM conversation_memory_state m WHERE conversation_id='+literal(normal_id))
def cas_writer():return sql("BEGIN;SET LOCAL application_name='preview-native-CAS-writer';SELECT id FROM conversations WHERE id="+literal(normal_id)+' FOR UPDATE;UPDATE conversation_commerce_state SET revision=2 WHERE conversation_id='+literal(normal_id)+';SELECT pg_sleep(0.6);COMMIT;')
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as pool:
 writer=pool.submit(cas_writer);writer_pid=''
 for i in range(60):
  writer_pid=sql("SELECT pid FROM pg_stat_activity WHERE application_name='preview-native-CAS-writer' AND wait_event='PgSleep'")
  if writer_pid:break
  time.sleep(.01)
 assert writer_pid,'overlapping writer did not reach real row-lock hold'
 content='stale guarded native reply';response_hash=hashlib.sha256(content.encode()).hexdigest();h=literal(response_hash);key=literal(hashlib.sha256((company+':'+normal_id+':'+v['message_id']+':1:'+response_hash).encode()).hexdigest())
 metadata="jsonb_build_object('b2_expected_revision',1,'b2_expected_company_id',"+literal(company)+",'b2_source_message_id',"+literal(v['message_id'])+",'b2_gate_contract','executeB2PersistenceGate:allow_after_revalidation','b2_commit_source','commit_ai_reply_tx','b2_response_hash',"+h+",'b2_idempotency_key',"+key+")"
 result=json.loads(sql('SET ROLE service_role;SELECT json_build_object(\'pid\',pg_backend_pid(),\'receipt\',commit_ai_reply_tx('+literal(normal_id)+','+literal(v['message_id'])+','+literal(content)+','+metadata+'))'))
 writer.result()
check('two distinct live SQL connections revalidate CAS after concurrent writer',str(result['pid'])!=writer_pid and result['receipt']['result']=='stale_authorized_revision')
check('stale CAS cannot replace original Assistant or mutate canonical Memory',sql('SELECT count(*)FROM messages WHERE conversation_id='+literal(normal_id)+" AND content='stale guarded native reply'")=='0' and sql('SELECT row_to_json(m)FROM conversation_memory_state m WHERE conversation_id='+literal(normal_id))==memory_before)
