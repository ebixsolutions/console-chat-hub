/** Same original P1 60 business rows + 7 probes, non-gating diagnostics.
 * No production import. The unchanged original handler runs in its isolated
 * external transport fixture, injected only into the runner's throwaway sibling.
 */
import {loadObservationCases,buildTurnInput,digest,hasCorrectionReading} from './p1-observation-fixtures.mjs';
import {snapshot,errorCodes,turnAssertions,businessAssertions,modeOutcome} from './p1-observation-diagnostics.mjs';

export function registerP1ObservationCases({test,assert,fixture,uuid,fs,root}){
 const {rows,manifest_sha256,case_ids_sha256}=loadObservationCases(fs,root);
 const run=async(row,mode,index,wrongTurn=null)=>{
  let previous=null,history=[],priorOutcome=null;
  const turns=[];
  for(const [turn,utterance] of row.turns.entries()){
   const source=uuid(900000+index*20+turn);
   let input={proof:{reading:{status:'NOT_SUPPLIED',reason:'Input construction did not complete.'},
    kb:{status:'KB_FIXTURE_MISSING'},generation:{status:'NOT_SUPPLIED'}}};
   let actual=null,result=null,error=null;
   try{
    input=buildTurnInput(row,turn,turn===wrongTurn?'wrong_reading':mode,fs,root);
    actual=fixture(utterance,{...input.options,source,
     ...(previous?{previous,history,human:previous.conversations?.[0]?.status==='human_control'}:{})});
    result=await actual.run();
   }catch(caught){error=caught;}
   const observation={turn:turn+1,utterance,utterance_sha256:digest(utterance),input:input.proof,
    ...snapshot(actual,result,source),error_codes:errorCodes(result,actual,error),
    exception:error?{name:error.name??'Error',code:error.code??null,
     message:String(error.message??error).replace(/PRIVATE-SECRET/gu,'[fixture-redacted]').slice(0,240)}:null,
    continuation:{prior_turn_outcome:priorOutcome,readback_basis:actual?.tables?'ACTUAL_FIXTURE_TABLES_NOT_ASSUMED_SUCCESS':'UNAVAILABLE',
     previous_source_ids:history.filter(message=>message.role==='visitor').map(message=>message.id)}};
   observation.assertions=turnAssertions(observation);
   observation.first_failed_assertion=observation.assertions.find(item=>item.status==='FAIL')?.id??null;
   observation.last_reached_assertion=observation.assertions.filter(item=>item.status!=='NOT_REACHED').at(-1)?.id??null;
   observation.not_reached_assertions=observation.assertions.filter(item=>item.status==='NOT_REACHED').map(item=>item.id);
   observation.outcome=observation.assertions.every(item=>item.status==='PASS')?'RUNTIME_CHECKS_PASS':'RUNTIME_CHECKS_FAIL';
   turns.push(observation);
   // Carry only actual fixture tables, including real partial writes after a
   // failed reply. Never manufacture state from a proposed reading or label a
   // failed turn successful. The next turn is still executed and source-bound.
   if(actual?.tables){previous=actual.tables;history=actual.tables.messages.slice().reverse();}
   priorOutcome=observation.outcome;
   if(turn===wrongTurn)return {turns};
  }
  const business=businessAssertions(row,turns);
  return {...modeOutcome(turns,business),expected_turns:row.turns.length,executed_turns:turns.length,
   turns,business_assertions:business};
 };
 // Supplemental wrong-input negatives are not original modes/cases. Run
 // the unchanged Handler on a fresh isolated prefix, never seed a desired
 // state. Missing readback cannot earn PASS and a safe independent answer
 // can still be delivered. These are narrow wrong-proposal assertions only.
 const wrongReadingReceipt=async(row,index,wrongTurn)=>{
  const negative=await run(row,'scripted',index,wrongTurn);
  const after=negative.turns.at(-1),before=negative.turns.at(-2);
  const previous=before?.readback?.state,next=after?.readback?.state;
  const previousActive=(previous?.entities??[]).filter(e=>!['cancelled','deferred','superseded'].includes(e.status));
  const nextEntities=next?.entities??[];
  const scopeBound=!!previous&&!!next&&previousActive.length>0&&
   before.company_id===after.company_id&&before.conversation_id===after.conversation_id&&
   before.readback.commerce_company_id===after.company_id&&after.readback.commerce_company_id===after.company_id&&
   before.readback.commerce_conversation_id===after.conversation_id&&after.readback.commerce_conversation_id===after.conversation_id&&
   after.input?.reading?.status==='WRONG_READING_NEGATIVE';
  const applicable=(after?.assertions??[]).filter(a=>['source_visitor_binding','handler_http_200',
   'exactly_once_delivery','reply_source_binding','persisted_state_tenant_ticket',
   'no_fabricated_order_or_payment_in_state'].includes(a.id));
  const observed=scopeBound&&applicable.length===6&&applicable.every(a=>a.status==='PASS');
  const safe=wrongTurn===1?!nextEntities.some(e=>e.quantity===99999):
   JSON.stringify(next)===JSON.stringify(previous);
  return {turn:wrongTurn+1,status:observed?(safe?'PASS':'FAIL'):'NOT_PROVEN',
   scope:wrongTurn===1?'WRONG_QUANTITY_NOT_PERSISTED':'WRONG_REFERENT_READ_ONLY_NO_STATE_CHANGE',
   input:after?.input?.reading??null,scope_bound:scopeBound,
   actual_assertions:applicable,prior_revision:before?.readback?.commerce_revision??null,
   current_revision:after?.readback?.commerce_revision??null,
   before_quantities:previousActive.map(e=>({entity_id:e.entity_id,quantity:e.quantity})),
   actual_entities:nextEntities.map(e=>({entity_id:e.entity_id,quantity:e.quantity,status:e.status})),
   state_unchanged:!!previous&&!!next&&JSON.stringify(next)===JSON.stringify(previous),
   response_route:after?.response?.response_route??null,
   error_codes:after?.error_codes??[]};
 };
 for(const [index,row] of rows.entries())test('P1-OBS '+row.id,async()=>{
  const modes=row.kind==='probe'?['scripted']:['no_reading','scripted'];
  const record={id:row.id,category:row.kind,evidence:'ISOLATED_REAL_HANDLER_WITH_SCRIPTED_OR_EMPTY_READING',
   original_manifest_sha256:manifest_sha256,case_ids_sha256,
   original_oracle:{must:row.must??null,must_not:row.must_not??null,oracle:row.oracle??null,expect:row.expect??null},
   real_model:'NOT_RUN',real_kb:'NOT_RUN',hosted:'NOT_RUN',oracle:'NOT_PROVEN',modes:{}};
  for(const mode of modes){
   try{record.modes[mode]=await run(row,mode,index);}
   catch(error){record.modes[mode]={status:'FAIL',outcome:'BLOCKED',business_oracle:'NOT_PROVEN',
    expected_turns:row.turns.length,executed_turns:0,turns:[],error:String(error.message??error).slice(0,240)};}
  }
  if(hasCorrectionReading(row)){
   record.r2_supplemental_wrong_reading=[];
   for(const wrongTurn of [1,2]){
    try{record.r2_supplemental_wrong_reading.push(await wrongReadingReceipt(row,index+1000+wrongTurn*100,wrongTurn));}
    catch(error){record.r2_supplemental_wrong_reading.push({turn:wrongTurn+1,status:'NOT_PROVEN',
     reason:'Supplemental negative did not complete.',error:String(error.message??error).slice(0,240)});}
   }
  }
  if(Object.values(record.modes).every(mode=>mode.status==='PASS'))record.oracle='SCOPED_SCRIPTED_ASSERTIONS_CHECKED';
  console.log('P1_OBS_RESULT|'+JSON.stringify(record));
  // No unchecked must/must_not obligation can become a nonfail test merely
  // because HTTP/commit assertions passed. The original runner stays non-gating.
  assert(Object.values(record.modes).every(mode=>mode.status==='PASS'),
   'p1_observation_'+row.id+' '+Object.entries(record.modes).map(([name,mode])=>name+':'+mode.outcome).join(';'));
 });
}
