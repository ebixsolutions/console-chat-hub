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

Deno.test("Task3C reason summary retains real reviewer condition without plaintext",async()=>{
 const db=database();
 const verifier={verdict:{ok:false,reason:"verifier_demand_resolution_invalid",
  rejection:{stage:"demand_resolution_shape",reason:"unavailable_cannot_cite_evidence",
   demand_resolutions:[{demand_id:"demand-1",status:"supported",evidence_ids:["E1"]}]}}};
 assert(await writeProtectedPipelineEvidence(db,scope,"grounding_verdict",verifier));
 const row=db.writes[0].retrieved_chunks,proof=row.decision_receipt;
 assert(proof.gate==="grounding_verifier"&&proof.outcome==="rejected");
 assert(proof.fired_condition==="unavailable_cannot_cite_evidence"&&proof.fault_class==="reviewer_output_shape");
 assert(proof.per_demand[0].status==="supported");
 assert(row.payload.body===JSON.stringify(verifier));
});
Deno.test("Task3C reason summary redacts raw B2 candidate even on whole-body WITHHELD",async()=>{
 const db=database(),data={candidate:"email alice@example.com",decision:{decision:"allow",code:"B2_ALLOW"},
  committed:true,state_revision:2};
 assert(await writeProtectedPipelineEvidence(db,scope,"b2_verdict",data));
 const row=db.writes[0].retrieved_chunks,proof=row.decision_receipt;
 assert(row.payload.capture_state==="WITHHELD_SENSITIVE"&&row.payload.body===null);
 assert(proof.fired_condition==="B2_ALLOW"&&proof.commit_confirmed===true&&proof.candidate_ref.sha256.length===64);
 assert(!JSON.stringify(proof).includes("alice@example.com"));
});

Deno.test("Task3C all four source-bound gate summaries distinguish real acceptance from review and recovery",async()=>{
 const db=database();
 for(const [stage,payload] of [
  ["semantic_validation",{accepted:true}],
  ["grounding_verdict",{verdict:{ok:false,reason:"verifier_invalid_output",
    rejection:{stage:"verifier_output_shape",reason:"verifier_invalid_output",demand_resolutions:[]}}}],
  ["recovery_decision",{fallback_condition:"REVIEWER_OUTPUT_SHAPE",selected_fallback:"canonical_kb_partial_recovery",
    committed:true,demand_outcomes:[{demand_id:"demand-1",status:"partial",evidence_ids:["E1"]},
      {demand_id:"demand-2",status:"unavailable",evidence_ids:[]}]}],
  ["b2_verdict",{decision:{decision:"allow",code:"B2_ALLOW"},committed:true}],
 ] as Array<[string,unknown]>)assert(await writeProtectedPipelineEvidence(db,scope,stage,payload));
 assert(db.writes.length===4);
 const receipts=db.writes.map(row=>row.retrieved_chunks.decision_receipt);
 assert(receipts.map(x=>x.gate).join(",")==="semantic_validation,grounding_verifier,recovery,b2");
 assert(receipts[0].outcome==="accepted");
 assert(receipts[1].fault_class==="reviewer_output_shape");
 assert(receipts[2].outcome==="fallback_selected"&&receipts[2].per_demand.length===2);
 assert(receipts[3].commit_confirmed===true);
});
Deno.test("Task3C unknown reviewer free text cannot become a factual code",async()=>{
 const db=database();
 assert(await writeProtectedPipelineEvidence(db,scope,"grounding_verdict",
  {verdict:{ok:false,reason:"email bad@example.com",rejection:{reason:"Free text bad@example.com"}}}));
 const proof=db.writes[0].retrieved_chunks.decision_receipt;
 assert(proof.fired_condition==="NOT_CAPTURED"&&!JSON.stringify(proof).includes("bad@example.com"));
});
