import {test} from "node:test";
import assert from "node:assert/strict";
import {resolveEvidenceAdminScope,linkConversationEvidenceTurns,isEvidenceConversationId,redactEvidenceSensitiveText} from "../../src/lib/api/evidence-log-scope.ts";
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

test("Full exact Conversation ID search accepts older tickets without accepting prefixes",()=>{
 const id="fd9a4ebb-1e26-5dc7-a6e4-42b791860716";
 assert.equal(isEvidenceConversationId(id),true);
 assert.equal(isEvidenceConversationId(id.toUpperCase()),true);
 for(const bad of ["fd9a4ebb","",id+"-other","../../conversations",id.slice(0,-1)]){
  assert.equal(isEvidenceConversationId(bad),false);
 }
});
test("Admin evidence display masks secret values and customer contacts without changing original trace",()=>{
 const secret='{"api_key":"dont-show","query":"Email alice@example.com","phone":"91234567"}';
 const redacted=redactEvidenceSensitiveText(secret);
 assert.equal(redacted.includes("dont-show"),false);
 assert.equal(redacted.includes("alice@example.com"),false);
 assert.equal(redacted.includes("91234567"),false);
 const src=[{id:"v",role:"visitor",content:"Contact alice@example.com",created_at:"2026-01-01"},
  {id:"a",role:"assistant",content:"Email alice@example.com",created_at:"2026-01-02",metadata:{source_message_id:"v"}}];
 const trace=[{id:"t",message_id:"v",query_sent:"Query alice@example.com",retrieved_chunks:{
  request_json:secret,response:{capture_state:"CAPTURED",response_json_raw:secret,response_sha256:"originalhash",response_bytes:secret.length},
  source_context:{access_token:"hidden",intent:"lookup"}},created_at:"2026-01-01",top_score:null,kb_source:"singapore_context_search"}];
 const linked=linkConversationEvidenceTurns(src,trace);
 assert.equal(linked.turns[0].evidence[0].rawCaptureState,"REDACTED");
 assert.equal(linked.turns[0].evidence[0].rawSha256,"originalhash");
 assert.equal(JSON.stringify(linked).includes("dont-show"),false);
 assert.equal(JSON.stringify(linked).includes("alice@example.com"),false);
 assert.equal(JSON.stringify(linked).includes("hidden"),false);
});

test('Pre-KB semantic failure is not mislabeled as historical KB raw capture',()=>{
 const visitor={id:'a3571189',role:'visitor',content:'給我有關大金 2匹機的型號介紹',created_at:'2026-11-04'};
 const assistant={id:'answer',role:'assistant',content:'請求失敗',created_at:'2026-11-04',metadata:{source_message_id:'a3571189',response_route:'terminal_failure_recovery',source_error_code:'LLM_INVALID_OUTPUT',execution_failure:{stage:'canonical_validation'},rag_api_status:null,semantic_failure_receipt:{input:{source_message_id:"a3571189",user_sha256:"fixture-hash"},stage:"semantic_contract"}}};
 const explicit=linkConversationEvidenceTurns([visitor,assistant],[]);
 assert.equal(explicit.turns[0].evidenceStatus,'KB_NOT_DISPATCHED_SEMANTIC_FAILURE');
 assert.equal(explicit.turns[0].evidence.length,0);
 assert.equal(JSON.parse(explicit.turns[0].answers[0].metadata).semantic_failure_receipt.stage,'semantic_contract');
 assert.equal(linkConversationEvidenceTurns([visitor],[]).turns[0].evidenceStatus,'NOT_CAPTURED');
});

test("Cross-page replies are bound by exact source and conflicting IDs are not guessed",()=>{
 const v={id:"visitor",role:"visitor",content:"Which models?",created_at:"2026-11-04T10:00:00Z"};
 const a={id:"answer",role:"assistant",content:"Exact answer",created_at:"2026-11-04T10:01:00Z",metadata:{source_message_id:"visitor"}};
 const other={id:"other",role:"assistant",content:"Another page",created_at:"2026-11-04T10:02:00Z",metadata:{source_message_id:"visitor-other"}};
 const conflict={id:"bad",role:"assistant",content:"Conflicting sources",created_at:"2026-11-04T10:03:00Z",
   metadata:{source_message_id:"visitor",b2_source_message_id:"visitor-other"}};
 const linked=linkConversationEvidenceTurns([v,a,other,conflict],[]);
 assert.equal(linked.turns[0].answers.length,1);assert.equal(linked.turns[0].answers[0].id,"answer");
 assert.equal(linked.unlinkedReplies.length,1);
 assert.equal(linked.unlinkedReplies[0].linkageStatus,"CONFLICTING_SOURCE_IDS");
});
test("Legacy captured hash is still shown, without falsely claiming upstream origin",()=>{
 const v={id:"v",role:"visitor",content:"Models?",created_at:"2026-11-04T10:00:00Z"};
 const t={id:"t",message_id:"v",query_sent:"q",retrieved_chunks:{
  response:{capture_state:"CAPTURED",response_sha256:"originalhash",response_json_raw:"{}"}},
  created_at:"2026-11-04T10:00:01Z",kb_source:"singapore_context_search",top_score:null};
 const result=linkConversationEvidenceTurns([v],[t]);
 assert.equal(result.turns[0].evidence[0].rawSha256,"originalhash");
 assert.equal(result.turns[0].evidence[0].rawCaptureState,"LEGACY_ORIGIN_UNVERIFIED");
});

test("New semantic and grounding receipts link exact IDs and preserve redaction",()=>{
 const v={id:"54f4abea-09cc-4b53-86be-bd8c3a93a820",role:"visitor",content:"1匹?",created_at:"2026-11-05"};
 const a={id:"2d695f37-7409-4ef3-9bbb-63cb4c130124",role:"assistant",content:"Unverified model",created_at:"2026-11-05",metadata:{
  source_message_id:v.id,b2_source_message_id:v.id,b2_expected_company_id:"3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
  b2_expected_revision:1,b2_gate_contract:"executeB2PersistenceGate:allow_after_revalidation",
  b2_commit_source:"commit_ai_reply_tx",grounding_rejection_reason:"unsupported_claims",
  factual_evidence_candidates:[{document_id:"doc",chunk_id:"chunk",demand_ids:["demand-1"]}],
  factual_evidence_selection:[{evidence_id:"E1",document_id:"doc",chunk_id:"chunk",demand_ids:["demand-1"]}],
 }};
 const trace={id:"t",message_id:v.id,query_sent:"q",created_at:"2026-11-05",top_score:null,kb_source:"singapore_context_search",
  retrieved_chunks:{request_dispatch_state:"HTTP_RECEIVED",request_json:'{"query":"q"}',
   source_context:{semantic_input:{source_message_id:v.id},accepted_semantic_frame:{operation:"ASK_FACT"},phone:"91234567"},
   response:{capture_state:"CAPTURED",capture_origin:"UPSTREAM_HTTP",response_json_raw:"{}"}}};
 const turn=linkConversationEvidenceTurns([v,a],[trace]).turns[0];
 assert.equal(turn.evidence[0].requestDispatchState,"HTTP_RECEIVED");
 assert.equal(turn.evidence[0].rawCaptureState,"CAPTURED");
 assert.equal(JSON.parse(turn.evidence[0].requestJson).query,"q");
 assert.equal(JSON.parse(turn.evidence[0].sourceContext).semantic_input.source_message_id,v.id);
 assert(!turn.evidence[0].sourceContext.includes("91234567"));
 const receipt=JSON.parse(turn.answers[0].metadata);
 assert.equal(receipt.assistant_message_id,a.id);
 assert.equal(receipt.b2_source_message_id,v.id);
 assert.equal(receipt.b2_expected_company_id,a.metadata.b2_expected_company_id);
 assert.equal(receipt.b2_expected_revision,1);
 assert.equal(receipt.factual_evidence_candidates[0].chunk_id,"chunk");
 assert.equal(receipt.factual_evidence_selection[0].evidence_id,"E1");
 assert.equal(receipt.grounding_rejection_reason,"unsupported_claims");
});
