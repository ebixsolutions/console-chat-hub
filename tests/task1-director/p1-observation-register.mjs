/**
 * Original Task3C P1: register 60 observation cases plus 7 distinct probes
 * against the REAL full-chain local handler fixture, never a provider mock PASS.
 * This module is imported only from a throwaway sibling of the ORIGINAL
 * unchanged 580-case handler file. No production runtime import.
 */
export function registerP1ObservationCases({test,assert,fixture,uuid,fs,root}) {
 const path = root+'/tests/task1-director/fixtures/task3c-replay/observations-60-plus-7.json';
 const spec=JSON.parse(fs.readFileSync(path,'utf8'));
 const all=[];
 for (const entry of spec.original_25_source){
  const pack=JSON.parse(fs.readFileSync(root+'/'+entry.path,'utf8'));
  if(pack.tasks.length!==5||pack.profile.industry!==entry.domain)
    throw Error('seed_drift:'+entry.domain);
  for(const row of pack.tasks)
   all.push({id:row.seed_task_id,turns:row.turns,kind:'synthetic',must:row.expected});
 }
 for(const row of spec.b2b)all.push({id:row.id,turns:row.turns,kind:'synthetic_b2b',must:row.expected});
 for(const row of spec.sourced){
  const turns=[...row.turns.matchAll(/[①②③④⑤⑥⑦⑧⑨]\s*(?:「([^」]+)」|"([^"]+)")/gu)].map(m=>m[1]??m[2]);
  all.push({id:row.id,turns:turns.length?turns:[row.turns],kind:'sourced_synthetic_kb',
   must:row.must,must_not:row.must_not});
 }
 if(all.length!==60||new Set(all.map(x=>x.id)).size!==60||
   spec.probes.length!==7||new Set(spec.probes.map(x=>x.id)).size!==7)
   throw Error('observation_case_count_mismatch');
 const scripted=probe=>({operation:probe.reading.operation,intent:probe.reading.intent,confidence:0.98,
  entities:[{name:probe.reading.name,kind:probe.reading.kind,quantity:probe.reading.quantity,
   confidence:0.98}],customer_facts:probe.reading.facts??[],requested_facts:[]});
 const run=async(row,mode,index)=>{
  let previous=null,history=[],last=null;
  const details=[];
  for(const [turn,utterance] of row.turns.entries()){
   const semantic=mode==='scripted'
     ?row.kind==='probe'?scripted(row)
       :{operation:'ASK_FACT',confidence:0.97,intent:'customer_guidance',
         entities:[],customer_facts:[],requested_facts:[]}
     :undefined;
   const options={originalPreview:true,fullChain:true,source:uuid(900000+index*20+turn),
    answer:'Your stated requirements are noted. Current merchant policies, availability, orders and prices need verified evidence.',
    ...(semantic?{semantic}:{}),...(previous?{previous,history}:{})};
   const f=fixture(utterance,options);
   const result=await f.run();
   assert.equal(result.status,200,'observed_handler_http_failure');
   assert.equal(f.commits.length,1,'observed_handler_commit_not_exactly_once');
   if(row.id==='P3' && mode==='scripted'){
    // P3 is an original failing observation; leave its assertion intact.
    // Record only safe route/stage codes to identify the shared runtime defect.
    const md=f.commits[0].metadata??{}, failure=md.execution_failure??{};
    console.log('P1_P3_TRACE '+JSON.stringify({route:md.response_route??null,
     error_code:md.source_error_code??null,
     failure_stage:failure.stage??null,
     failure_code:failure.code??null,
     commerce_result:md.commerce_state_persist_result??null}));
   }
   assert.notEqual(f.commits[0].metadata.generation_success,false,'observed_handler_terminal_failure');
   const state=f.tables.conversation_commerce_state[0]?.state;
   if(state){
    assert.notEqual(state.conversion.order_status,'confirmed','handler fabricated a confirmed order');
    assert.notEqual(state.conversion.payment_status,'paid','handler fabricated payment');
   }
   previous=f.tables;history=f.tables.messages;last={f,result,state};
   details.push({turn:turn+1,route:f.commits[0].metadata.response_route,http:result.status});
  }
  if(row.kind==='probe'&&mode==='scripted'){
   const {state}=last,expect=row.expect;
   const entity=state?.entities?.find(e=>e.attributes.product_name===expect.item);
   if(expect.item&&!expect.allowSafeRefusal)assert(entity,'expected item absent');
   if(typeof expect.quantity==='number')assert.equal(entity?.quantity,expect.quantity,'incorrect item quantity');
   if(typeof expect.notQuantity==='number'&&entity)assert.notEqual(entity.quantity,expect.notQuantity);
   if(expect.noCustomerExplicit&&entity)assert.notEqual(entity.attributes.quantity_basis,'customer_explicit');
   if(expect.quotes===0)assert.equal(state?.quotes?.length??0,0,'customer budget became quotation record');
  }
  return details;
 };
 for(const [index,row] of [...all,...spec.probes.map(probe=>({...probe,kind:'probe'}))].entries())
  test('P1-OBS '+row.id,async()=>{
   const modes=row.kind==='probe'?['scripted']:['no_reading','scripted'];
   const record={id:row.id,category:row.kind??'probe',
    evidence:'ISOLATED_REAL_HANDLER_WITH_SCRIPTED_OR_NO_READING',real_model:'NOT_RUN',
    real_kb:'NOT_RUN',hosted:'NOT_RUN',oracle:'NOT_FULLY_PROVEN',modes:{}};
   const problems=[];
   for(const mode of modes){
    try{
     record.modes[mode]={status:'EXECUTED',turns:await run(row,mode,index)};
     if(row.kind==='sourced_synthetic_kb')record.modes[mode].kb_oracle='NOT_VERIFIED';
    }catch(error){
     record.modes[mode]={status:'FAIL',error:String(error?.message??error).slice(0,250)};
     problems.push(mode+':'+record.modes[mode].error);
    }
   }
   console.log('P1_OBS_RESULT|'+JSON.stringify(record));
   if(problems.length)assert.fail('p1_observation_'+row.id+' '+problems.join(';'));
  });
}
