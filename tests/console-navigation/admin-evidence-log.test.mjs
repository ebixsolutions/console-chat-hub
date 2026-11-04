import {test} from "node:test";
import assert from "node:assert/strict";
import {resolveEvidenceAdminScope,linkConversationEvidenceTurns} from "../../src/lib/api/evidence-log-scope.ts";
function db(rows,companyActive=true){
 return{from(name){
  if(name==="company_membership")return{select(){return{eq(){return Promise.resolve({data:rows,error:null})}}}};
  if(name==="company")return{select(){return{eq(){return{maybeSingle(){return Promise.resolve({
   data:companyActive?{id:rows[0]?.company_id,is_active:true}:null,error:null
  })}}}}}};
  throw Error("unexpected "+name);
 }};
}
test("Admin evidence deny-by-default role, tenant and inactive company",async()=>{
 const row={company_id:"own",role:"admin",is_active:true};
 assert.deepEqual(await resolveEvidenceAdminScope(db([row]),"actor"),{ok:true,companyId:"own"});
 for(const role of ["supervisor","agent","qa"]){
  assert.equal((await resolveEvidenceAdminScope(db([{...row,role}]),"actor")).ok,false);
 }
 assert.equal((await resolveEvidenceAdminScope(db([{...row,is_active:false}]),"actor")).ok,false);
 assert.equal((await resolveEvidenceAdminScope(db([row,{...row,company_id:"other"}]),"actor")).ok,false);
 assert.equal((await resolveEvidenceAdminScope(db([row],false),"actor")).ok,false);
 assert.equal((await resolveEvidenceAdminScope(db([row]),"")).ok,false);
});
test("Original response is only linked to exact source message, not inferred",()=>{
 const messages=[{id:"visitor-1",role:"visitor",content:"有咩型號選擇？",created_at:"2026-01-01"},
  {id:"ai1",role:"assistant",content:"Human reply",created_at:"2026-01-02",
   metadata:{source_message_id:"visitor-1",response_route:"canonical_kb_direct_answer"}},
  {id:"unlinked",role:"assistant",content:"No source",created_at:"2026-01-03"}];
 const none=linkConversationEvidenceTurns(messages,[]);
 assert.equal(none.turns[0].evidenceStatus,"NOT_CAPTURED");
 assert.equal(none.unlinkedReplies.length,1);
 const trace=[{id:"trace1",message_id:"visitor-1",query_sent:"exact Query",
   retrieved_chunks:{request_json:'{"query":"exact Query"}',
    response:{capture_state:"CAPTURED",response_json_raw:'{"raw":"yes"}',http_status:200}},
   created_at:"2026-01-02",kb_source:"singapore_context_search",top_score:null}];
 const output=linkConversationEvidenceTurns(messages,trace);
 assert.equal(output.turns[0].evidence[0].exactQuery,"exact Query");
 assert.equal(output.turns[0].evidence[0].rawResponse,'{"raw":"yes"}');
 assert.equal(output.turns[0].answers[0].text,"Human reply");
});
