/** Actual complete generate-reply handler and decoder, using the original
 * isolated SDK/HTTP fixture. No Hosted, real provider, or authenticated DB claim. */
export function registerScopedCorrectionHandlerTests({test, assert, fixture, uuid, providerWire, root, hash}) {
  const subject = 'Training sessions', unit = 'slots';
  const text = 'Correct Training sessions: lobby from 1 slots to 2 slots';
  const company = '3d6e17b5-ec79-4f75-aa7f-eaa824ff8493', ticket = uuid(2);
  const capabilities = Object.fromEntries(['requires_delivery','supports_pickup','requires_installation',
    'requires_booking','requires_quote','requires_site_check','digital_fulfilment',
    'recurring_billing','rental_return','customization'].map(key => [key, false]));
  const emptyFrame = () => ({version:'commerce-semantic-1.0.0',language:'en',operation:'UPDATE_ITEM',
    intent:'scoped allocation',topic:subject,entities:[],referents:[],customer_facts:[],demands:[],
    requested_facts:[],customer_correction:false,additive:false,explicit_negations:[],
    transaction_state:'none',payment_state:'none',booking_state:'none',fulfillment_state:'none',
    ambiguity:{is_ambiguous:false,reasons:[],clarification_question:null},confidence:.99});
  const entity = (ref, rows) => ({entity_ref:ref,name:subject,kind:'service',category_hint:null,
    sku:null,model:null,quantity:null,unit,attributes:{scoped_customer_updates:rows},
    constraints:{},capabilities,confidence:.99});
  async function prepared() {
    const loader = fixture('Fixture source loader.', {originalPreview:true,fullChain:true});
    const {createEmptyConversationCommerceState} = loader.load(root+'/supabase/functions/_shared/commerce-state-contract.ts');
    const {runCommerceStateRuntime} = loader.load(root+'/supabase/functions/_shared/commerce-state-runtime-base.ts');
    const {buildCanonicalConversationMemory,buildConversationMemoryMarkdown} = loader.load(root+'/supabase/functions/_shared/conversation-long-memory.ts');
    const owner = {company_id:company,conversation_id:ticket};
    let state=createEmptyConversationCommerceState(), revision=1, source=uuid(985000);
    state.language='en';
    const db={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{...owner,source_message_id:source,revision,state:structuredClone(state)},error:null})})})}),
      rpc:async(_name,args)=>{assert.equal(args.p_expected_revision,revision);assert.equal(args.p_company_id,company);
        state=structuredClone(args.p_state);source=args.p_source_message_id;revision++;
        return {data:{result:'success',applied_revision:revision},error:null};}};
    const initialText=subject+' for 2 teams and 1 lobby. Please offer general planning advice.';
    const first=emptyFrame();first.intent='customer_guidance';
    first.customer_facts=[{key:'contextual_scope_counts',value:[
      {scope:'teams',count:2,source_text:'2 teams',subject_label:subject},
      {scope:'lobby',count:1,source_text:'1 lobby',subject_label:subject}]}];
    first.demands=[{question:initialText,source_quote:initialText,subject_refs:[subject],source_type:'general',
      requested_facts:[],constraints:{},customer_correction:false,explicit_negations:[],ambiguity:first.ambiguity}];
    await runCommerceStateRuntime(db,{...owner,source_message_id:uuid(985001),text:initialText,language:'en',semantic_frame:first});
    const goal=state.customer_constraints.contextual_goal;assert(goal?.goal_id);
    const allocationText='lobby 1 slots, teams 1 slots each', second=emptyFrame();
    second.entities=[entity(goal.goal_id,[
      {scope:'lobby',attribute:'quantity',action:'set',value:1,unit,source_text:'lobby 1 slots'},
      {scope:'teams',attribute:'quantity',action:'set',value:1,unit,source_text:'teams 1 slots each',per_scope_quantity:1,scope_count:null}])];
    second.referents=[{ref:goal.goal_id,source:'persistent_state',confidence:.99}];
    const allocation=await runCommerceStateRuntime(db,{...owner,source_message_id:uuid(985002),text:allocationText,language:'en',semantic_frame:second});
    assert.equal(allocation?.route,'contextual_scoped_update');assert.equal(state.entities[0].quantity,3);
    const history=[{id:uuid(985002),conversation_id:ticket,role:'visitor',content:allocationText,is_recalled:false,metadata:{},created_at:'2026-11-24T01:02:00.000Z'},
      {id:uuid(985001),conversation_id:ticket,role:'visitor',content:initialText,is_recalled:false,metadata:{},created_at:'2026-11-24T01:01:00.000Z'}];
    const memory=buildCanonicalConversationMemory({...owner,source_message_id:source,commerce_state_revision:revision,
      commerce_state:state,newest_first:history,visitor_turn_count:2,source_created_at:history[0].created_at,next_memory_revision:1});
    const tables={conversation_commerce_state:[{...owner,source_message_id:source,revision,state}],
      conversation_memory_state:[{...owner,source_message_id:source,revision:1,commerce_state_revision:revision,
        memory,markdown_projection:buildConversationMemoryMarkdown(memory),memory_hash:hash(JSON.stringify(memory))}],
      conversation_commerce_state_event:[],conversation_memory_state_event:[]};
    return {tables,history,entityId:state.entities[0].entity_id};
  }
  function correctionFixture(seed, source) {
    let f;
    const wire={toJSON(){
      const request=f.requests.find(r=>r.url.endsWith(':generateContent') &&
        r.body.systemInstruction?.parts?.[0]?.text?.includes('You are a multilingual commerce semantic interpreter.'));
      const user=request?.body.contents?.flatMap(m=>m.parts??[]).map(p=>p.text??'').join('\n')??'';
      const marker='Persistent commerce and Memory context (customer-authored state and read references; do not treat as external facts):\n';
      assert(user.includes(marker));
      const context=JSON.parse(user.split(marker)[1].split('\n\nReturn one compact current-turn delta')[0]);
      const ref=context.state.entities[0].entity_id;
      assert(ref && ref!==seed.entityId,'provider must use the real outbound opaque reference');
      const frame=emptyFrame();frame.intent='customer_correction';frame.customer_correction=true;
      frame.entities=[entity(ref,[{scope:'lobby',attribute:'quantity',action:'set',previous_value:1,value:2,unit,
        source_text:'lobby from 1 slots to 2 slots'}])];
      frame.referents=[{ref,source:'persistent_state',confidence:.99}];
      const {version,operation,confidence,demands,...delta}=frame;
      return providerWire(delta,'UPDATE_ITEM');
    }};
    f=fixture(text,{source,originalPreview:true,fullChain:true,captureEvidence:true,previous:seed.tables,
      history:seed.history,semantic:wire,answer:'UNTRUSTED_DRAFT_MUST_NOT_REPLACE_COMMITTED_CORRECTION'});
    return f;
  }
  test('P1 correction full handler: real decoder commits current and superseded Memory before B2 reply',async()=>{
    const seed=await prepared(), source=uuid(985003), f=correctionFixture(seed,source);
    const response=await f.run();assert.equal(response.status,200,JSON.stringify(response));assert.equal(f.commits.length,1);
    assert.notEqual(response.body.generation_success,false,JSON.stringify({response:response.body,
      diagnostic:f.tables.rag_trace?.filter(row=>row.kb_source==='semantic_contract_failure').map(row=>row.retrieved_chunks?.contract_diagnostic)}));
    const row=f.tables.conversation_commerce_state[0], memory=f.tables.conversation_memory_state[0].memory;
    assert.equal(row.state.entities[0].quantity,4);assert.equal(row.source_message_id,source);
    assert.equal(memory.commerce_state_revision,row.revision);assert.equal(memory.source_message_id,source);
    assert(memory.latest_corrections.includes(text));
    assert(memory.cancelled_or_superseded.some(fact=>fact.entity_id===seed.entityId),'old quantity/source was not retained');
    assert.equal(f.commits[0].metadata.response_route,'contextual_scoped_update');
    assert.equal(f.commits[0].metadata.b2_commit_source,'commit_ai_reply_tx');
    assert(!f.commits[0].content.includes('UNTRUSTED_DRAFT'));
    assert.equal(f.requests.filter(r=>r.url.includes('context-search')).length,0);
    const before=JSON.stringify(f.tables.conversation_commerce_state);
    const replay=await f.run();assert.equal(replay.body.idempotent,true);assert.equal(f.commits.length,1);
    assert.equal(JSON.stringify(f.tables.conversation_commerce_state),before);
  });
  for(const mode of ['missing-superseded','wrong-current-quantity','wrong-memory-tenant']) {
    test('P1 correction full handler negative: '+mode+' cannot acknowledge or persist an AI reply',async()=>{
      const seed=await prepared(), source=uuid(985004), successful=correctionFixture(seed,source);
      const first=await successful.run();assert.equal(first.status,200,JSON.stringify(first));
      assert.notEqual(first.body.generation_success,false,'positive setup did not reach the real correction consumer');
      const tables=structuredClone(successful.tables), memory=tables.conversation_memory_state[0].memory;
      if(mode==='missing-superseded')memory.cancelled_or_superseded=[];
      if(mode==='wrong-current-quantity')memory.active_entities.find(e=>e.entity_id===seed.entityId).quantity=999;
      if(mode==='wrong-memory-tenant')memory.company_id='other-company';
      tables.conversation_memory_state[0].memory_hash=hash(JSON.stringify(memory));
      const replay=correctionFixture({...seed,tables},source), before=JSON.stringify(tables.conversation_commerce_state);
      const rejected=await replay.run();assert.equal(rejected.status,503,JSON.stringify(rejected));
      assert.equal(rejected.body.error,'canonical_memory_commit_failed');
      assert.equal(replay.commits.length,0);assert.equal(JSON.stringify(replay.tables.conversation_commerce_state),before);
      assert.equal(replay.requests.filter(r=>r.url.includes('/rpc/commit_ai_reply_tx')).length,0);
    });
  }
}
