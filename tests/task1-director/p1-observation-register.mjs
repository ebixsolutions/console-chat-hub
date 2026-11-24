/** Same original P1 60 business rows + 7 probes, non-gating diagnostics.
 * No production import. The unchanged original handler runs in its isolated
 * external transport fixture, injected only into the runner's throwaway sibling.
 */
import {loadObservationCases,buildTurnInput,digest} from './p1-observation-fixtures.mjs';
import {snapshot,errorCodes,turnAssertions,businessAssertions,modeOutcome} from './p1-observation-diagnostics.mjs';

export function registerP1ObservationCases({test,assert,fixture,uuid,fs,root}){
 const {rows,manifest_sha256,case_ids_sha256}=loadObservationCases(fs,root);
 const run=async(row,mode,index)=>{
  let previous=null,history=[],priorOutcome=null;
  const turns=[];
  for(const [turn,utterance] of row.turns.entries()){
   const source=uuid(900000+index*20+turn);
   let input={proof:{reading:{status:'NOT_SUPPLIED',reason:'Input construction did not complete.'},
    kb:{status:'KB_FIXTURE_MISSING'},generation:{status:'NOT_SUPPLIED'}}};
   let actual=null,result=null,error=null;
   try{
    input=buildTurnInput(row,turn,mode,fs,root);
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
  }
  const business=businessAssertions(row,turns);
  return {...modeOutcome(turns,business),expected_turns:row.turns.length,executed_turns:turns.length,
   turns,business_assertions:business};
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
  if(Object.values(record.modes).every(mode=>mode.status==='PASS'))record.oracle='SCOPED_SCRIPTED_ASSERTIONS_CHECKED';
  console.log('P1_OBS_RESULT|'+JSON.stringify(record));
  // No unchecked must/must_not obligation can become a nonfail test merely
  // because HTTP/commit assertions passed. The original runner stays non-gating.
  assert(Object.values(record.modes).every(mode=>mode.status==='PASS'),
   'p1_observation_'+row.id+' '+Object.entries(record.modes).map(([name,mode])=>name+':'+mode.outcome).join(';'));
 });
}
