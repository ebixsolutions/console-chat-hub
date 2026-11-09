import {captureProtectedDiagnosticText,writeProtectedPipelineEvidence} from '../../supabase/functions/_shared/protected-pipeline-evidence.ts';
const scope={company_id:'20000000-0000-4000-8000-000000000001',conversation_id:'30000000-0000-4000-8000-000000000001',source_message_id:'10000000-0000-4000-8000-000000000001'};
function assert(value:unknown):asserts value{if(!value)throw Error('assertion failed');}
function database(overrides:Record<string,unknown>={}){
 const writes:any[]=[];const rows:any={conversations:{id:scope.conversation_id,company_id:scope.company_id},messages:{id:scope.source_message_id,conversation_id:scope.conversation_id,role:'visitor',is_recalled:false},...overrides};
 return {writes,from(table:string){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:rows[table],error:null};},async insert(row:unknown){writes.push(row);return {error:null};}};}};
}
Deno.test('protected evidence binds exact tenant/source and captures rejected draft/verdict without public metadata',async()=>{
 const db=database();const data={candidate:'Please confirm the model?',decision:{code:'KNOWN_CONTEXT_RECONFIRMATION',detail:'entities.0.name'},used_evidence_ids:['E1'],value:0,flag:false,missing:null};
 assert(await writeProtectedPipelineEvidence(db,scope,'b2_verdict',data));assert(db.writes.length===1);
 const row=db.writes[0];assert(row.message_id===scope.source_message_id&&row.kb_source==='protected_pipeline_diagnostic');
 assert(row.retrieved_chunks.payload.body===JSON.stringify(data));assert(row.retrieved_chunks.payload.capture_state==='CAPTURED');
});
for(const [label,override] of Object.entries({tenant:{conversations:{id:scope.conversation_id,company_id:'other'}},ticket:{conversations:{id:'other',company_id:scope.company_id}},source:{messages:{id:'other',conversation_id:scope.conversation_id,role:'visitor',is_recalled:false}},role:{messages:{id:scope.source_message_id,conversation_id:scope.conversation_id,role:'assistant',is_recalled:false}},recalled:{messages:{id:scope.source_message_id,conversation_id:scope.conversation_id,role:'visitor',is_recalled:true}}}))Deno.test('protected sink rejects '+label,async()=>{const db=database(override);assert(!await writeProtectedPipelineEvidence(db,scope,'b2',{}));assert(db.writes.length===0);});
Deno.test('sensitive and oversized evidence withholds entire body with original digest',async()=>{
 for(const [body,state] of [['email a@example.test','WITHHELD_SENSITIVE'],['x'.repeat(65537),'WITHHELD_OVERSIZED']]){
 const captured=await captureProtectedDiagnosticText(body,'SERVER_PIPELINE_SNAPSHOT');assert(captured.capture_state===state&&captured.body===null);assert(captured.sha256.length===64&&captured.bytes===new TextEncoder().encode(body).length);
 }
});
Deno.test('sink errors do not throw or obtain a business decision/retry',async()=>{assert(!await writeProtectedPipelineEvidence({from(){throw Error('unavailable');}},scope,'b2',{}));});
