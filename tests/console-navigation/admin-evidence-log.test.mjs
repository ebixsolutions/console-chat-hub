import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
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
 assert.deepEqual(explicit.turns[0].semanticEvidence,[]); // Old missing provider text is never backfilled from receipt hashes.
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

test("Structured evidence keeps exact lineage IDs without exposing contacts or raw content",()=>{
 const chunkId="aabbccddee1122ff91234567aabbccdd";
 const contact="61234567";
 const visitor={id:"visitor",role:"visitor",content:"Models?",created_at:"2026-11-05"};
 const assistant={id:"answer",role:"assistant",content:"Reply",created_at:"2026-11-05",metadata:{
  source_message_id:visitor.id,
  factual_evidence_selection:[{chunk_id:chunkId,document_id:contact}],
  citation_lineage:{evidence_chunk_ids:[chunkId],selected_document_ids:[chunkId]},
  grounding_rejection_reason:`Call ${contact} or email test@example.com`,
 }};
 const raw=JSON.stringify({chunk_id:chunkId,phone:contact});
 const trace={id:"trace",message_id:visitor.id,query_sent:"q",created_at:"2026-11-05",
  kb_source:"singapore_context_search",top_score:null,retrieved_chunks:{
   response:{capture_state:"CAPTURED",response_json_raw:raw,response_sha256:"original"},
   lineage:[{document_id:chunkId,chunks:[{chunk_id:chunkId,title:`Call ${contact}`,api_key:"secret"}]}],
  }};
 const turn=linkConversationEvidenceTurns([visitor,assistant],[trace]).turns[0];
 const evidence=turn.evidence[0];
 const [document]=JSON.parse(evidence.lineage);
 assert.equal(document.document_id,chunkId);
 assert.equal(document.chunks[0].chunk_id,chunkId);
 assert.equal(document.chunks[0].title,"Call [PHONE_REDACTED]");
 assert.equal(document.chunks[0].api_key,"[REDACTED]");
 const meta=JSON.parse(turn.answers[0].metadata);
 assert.equal(meta.factual_evidence_selection[0].chunk_id,chunkId);
 assert.equal(meta.factual_evidence_selection[0].document_id,"[PHONE_REDACTED]");
 assert.deepEqual(meta.citation_lineage.evidence_chunk_ids,[chunkId]);
 assert.deepEqual(meta.citation_lineage.selected_document_ids,[chunkId]);
 assert.equal(meta.grounding_rejection_reason,"Call [PHONE_REDACTED] or email [EMAIL_REDACTED]");
 assert.equal(evidence.rawCaptureState,"REDACTED");
 assert.equal(evidence.rawSha256,"original");
 assert.equal(evidence.rawCaptureOrigin,"LEGACY_ORIGIN_UNVERIFIED");
 assert(!evidence.rawResponse.includes(chunkId));
 assert(!evidence.rawResponse.includes(contact));
});

// Synthetic future capture fixtures, not reconstructed A/B-T01 provider output.
const semanticVisitor={id:"13caab89-1fe5-42b2-8335-28122574ed5d",role:"visitor",content:"A source-owned question",created_at:"2026-11-06T02:43:28Z"};
const semanticRequestId=`commerce-semantic:${semanticVisitor.id}`;
function semanticBody(body,capture_origin){return{capture_origin,capture_state:"CAPTURED",body,
 sha256:createHash("sha256").update(body).digest("hex"),bytes:Buffer.byteLength(body,"utf8")};}
function semanticTrace(){return{id:"semantic-trace",message_id:semanticVisitor.id,query_sent:null,top_score:null,
 kb_source:"semantic_contract_failure",created_at:"2026-11-06T02:43:40Z",retrieved_chunks:{
  contract:"c3-admin-semantic-failure-v1",source_message_id:semanticVisitor.id,operation_id:semanticRequestId,
  request_dispatch_state:"KB_NOT_DISPATCHED_SEMANTIC_FAILURE",
  semantic_input:{source_message_id:semanticVisitor.id,user_sha256:"636fab1cbeb1a9840abc44c09b3a2a8ec7cd2c91fd0ffcddf206ab92e576e6ea",
   system_sha256:"5e68b7fc2b0b3bf5cf32b60510bdf6659d2797795645a0ab452561e5a670de8f"},
  stage:"semantic_contract",contract_rejection:"wire_context_nodes",
  contract_diagnostic:{container:"wire_nodes",stage:"canonical_vocabulary",field_class:"demand",reason:"field",node_count:29},
  semantic:{contract:"c3-semantic-failure-evidence-v1",source_message_id:semanticVisitor.id,request_id:semanticRequestId,
   request:semanticBody('{"user":"A source-owned question"}',"SEMANTIC_ROUTER_INPUT"),
   response:semanticBody('{"synthetic":"unsupported demand field"}',"SEMANTIC_MODEL_TEXT"),
   recovery_outcomes:{entity_read_only:"NOT_APPLICABLE"}},
 }};}
test("Semantic failure capture is separate from KB dispatch and preserves exact original hashes",()=>{
 const trace=semanticTrace(),original=structuredClone(trace);
 const turn=linkConversationEvidenceTurns([semanticVisitor],[trace]).turns[0];
 assert.equal(turn.evidenceStatus,"KB_NOT_DISPATCHED_SEMANTIC_FAILURE");
 assert.equal(turn.evidence.length,0);
 assert.equal(turn.semanticEvidence.length,1);
 const evidence=turn.semanticEvidence[0];
 assert.equal(evidence.linkageStatus,"MATCH");
 assert.equal(evidence.requestId,semanticRequestId);
 assert.equal(evidence.request.captureOrigin,"SEMANTIC_ROUTER_INPUT");
 assert.equal(evidence.response.captureOrigin,"SEMANTIC_MODEL_TEXT");
 for(const name of ["request","response"]){
  assert.equal(evidence[name].captureState,"CAPTURED");
  assert.equal(evidence[name].displayState,"CAPTURED");
  assert.equal(evidence[name].body,trace.retrieved_chunks.semantic[name].body);
  assert.equal(evidence[name].sha256,trace.retrieved_chunks.semantic[name].sha256);
  assert.equal(evidence[name].bytes,trace.retrieved_chunks.semantic[name].bytes);
 }
 assert.equal(evidence.inputSystemSha256,trace.retrieved_chunks.semantic_input.system_sha256);
 assert.equal(evidence.inputUserSha256,trace.retrieved_chunks.semantic_input.user_sha256);
 assert.deepEqual(trace,original);
});
test("Existing KB evidence stays independent when a semantic trace is also present",()=>{
 const kb={id:"kb-trace",message_id:semanticVisitor.id,query_sent:"Actual separate KB query",top_score:null,
  kb_source:"singapore_context_search",created_at:"2026-11-06T02:45:00Z",retrieved_chunks:{
   request_dispatch_state:"HTTP_RECEIVED",response:{capture_origin:"UPSTREAM_HTTP",capture_state:"CAPTURED",response_json_raw:"{}",http_status:200}}};
 const turn=linkConversationEvidenceTurns([semanticVisitor],[semanticTrace(),kb]).turns[0];
 assert.equal(turn.evidenceStatus,"TRACE_RECORDED");
 assert.equal(turn.evidence.length,1);assert.equal(turn.evidence[0].id,"kb-trace");
 assert.equal(turn.semanticEvidence.length,1);
 assert.equal(turn.evidence[0].responseStatus,200);
});
test("Semantic body is withheld on any source/request/input binding mismatch",()=>{
 const changes=[
  t=>{t.retrieved_chunks.source_message_id="another-source";},
  t=>{t.retrieved_chunks.semantic.source_message_id="another-source";},
  t=>{t.retrieved_chunks.operation_id="commerce-semantic:another-source";},
  t=>{t.retrieved_chunks.semantic.request_id="commerce-semantic:another-source";},
  t=>{t.retrieved_chunks.semantic_input.source_message_id="another-source";},
  t=>{delete t.retrieved_chunks.semantic_input;},
  t=>{t.retrieved_chunks.request_dispatch_state="HTTP_RECEIVED";},
  t=>{t.query_sent="Not a KB query";},t=>{t.top_score=0.9;},
  t=>{t.retrieved_chunks.source_message_id=semanticVisitor.id+"\napi_key=should-not-appear";},
 ];
 for(const change of changes){
  const trace=semanticTrace();change(trace);
  const turn=linkConversationEvidenceTurns([semanticVisitor],[trace]).turns[0];
  assert.equal(turn.evidence.length,0);
  assert.equal(turn.evidenceStatus,"NOT_CAPTURED");
  const evidence=turn.semanticEvidence[0];
  assert.equal(evidence.linkageStatus,"WITHHELD_INVALID_BINDING");
  assert.equal(evidence.request.body,null);assert.equal(evidence.response.body,null);
  assert.equal(evidence.request.sha256,null);assert.equal(evidence.requestId,null);
  assert.equal(evidence.diagnostics,null);
  assert(!JSON.stringify(evidence).includes("should-not-appear"));
 }
 const wrongMessage=semanticTrace();wrongMessage.message_id="another-source";
 assert.deepEqual(linkConversationEvidenceTurns([semanticVisitor],[wrongMessage]).turns[0].semanticEvidence,[]);
 const maliciousSource={...semanticVisitor,id:"source\napi_key=should-not-appear"};
 const trace=semanticTrace();trace.message_id=maliciousSource.id;
 trace.retrieved_chunks.source_message_id=maliciousSource.id;
 trace.retrieved_chunks.semantic.source_message_id=maliciousSource.id;
 trace.retrieved_chunks.semantic_input.source_message_id=maliciousSource.id;
 trace.retrieved_chunks.operation_id=trace.retrieved_chunks.semantic.request_id=`commerce-semantic:${maliciousSource.id}`;
 const view=linkConversationEvidenceTurns([maliciousSource],[trace]).turns[0].semanticEvidence[0];
 assert.equal(view.linkageStatus,"WITHHELD_INVALID_BINDING");assert.equal(view.response.body,null);
});
test("Invalid semantic tags cannot be promoted into KB raw or KB call counts",()=>{
 for(const change of [
  t=>{t.retrieved_chunks.contract="unknown-contract";},
  t=>{t.retrieved_chunks.semantic.contract="unknown-contract";},
  t=>{t.kb_source="singapore_context_search";},
  t=>{t.kb_source="singapore_context_search";t.retrieved_chunks.contract="unknown-contract";},
  t=>{t.kb_source="semantic_contract_failure_v2";t.retrieved_chunks.contract="c3-admin-semantic-failure-v2";
   t.retrieved_chunks.semantic.contract="c3-semantic-failure-evidence-v2";},
  t=>{t.kb_source="singapore_context_search";t.retrieved_chunks.contract="unknown-contract";
   t.retrieved_chunks.semantic.contract="unknown-contract";},
 ]){
  const trace=semanticTrace();change(trace);
  trace.retrieved_chunks.response={capture_origin:"UPSTREAM_HTTP",capture_state:"CAPTURED",response_json_raw:"must-not-become-KB-raw"};
  const turn=linkConversationEvidenceTurns([semanticVisitor],[trace]).turns[0];
  assert.equal(turn.evidence.length,0);assert.equal(turn.semanticEvidence.length,1);
  assert.equal(turn.semanticEvidence[0].linkageStatus,"WITHHELD_INVALID_BINDING");
  assert(!JSON.stringify(turn).includes("must-not-become-KB-raw"));
 }
});
test("Semantic display redacts bodies without modifying original hashes or input evidence",()=>{
 const trace=semanticTrace(),body='{"api_key":"dont-display","contact":"alice@example.com","phone":"91234567"}';
 trace.retrieved_chunks.semantic.response=semanticBody(body,"SEMANTIC_MODEL_TEXT");
 // A valid digest-shaped receipt may include phone-like digits; display must not transform it.
 trace.retrieved_chunks.semantic.response.sha256="aabbccdd91234567".repeat(4);
 const original=structuredClone(trace),evidence=linkConversationEvidenceTurns([semanticVisitor],[trace]).turns[0].semanticEvidence[0];
 assert.equal(evidence.response.captureState,"CAPTURED");assert.equal(evidence.response.displayState,"REDACTED");
 assert.equal(evidence.response.sha256,original.retrieved_chunks.semantic.response.sha256);
 assert.equal(evidence.response.bytes,Buffer.byteLength(body,"utf8"));
 for(const secret of ["dont-display","alice@example.com","91234567"])assert(!evidence.response.body.includes(secret));
 assert.equal(evidence.inputSystemSha256,original.retrieved_chunks.semantic_input.system_sha256);
 assert.deepEqual(trace,original);
});
test("Semantic withheld captures keep exact hashes/counts with no body and no truncation",()=>{
 for(const state of ["WITHHELD_OVERSIZED","WITHHELD_SENSITIVE"]){
  const trace=semanticTrace(),receipt=trace.retrieved_chunks.semantic.response;
  receipt.capture_state=state;receipt.body=null;receipt.bytes=state==="WITHHELD_OVERSIZED"?70000:receipt.bytes;
  const response=linkConversationEvidenceTurns([semanticVisitor],[trace]).turns[0].semanticEvidence[0].response;
  assert.equal(response.captureState,state);assert.equal(response.displayState,state);assert.equal(response.body,null);
  assert.equal(response.sha256,receipt.sha256);assert.equal(response.bytes,receipt.bytes);
 }
 // Character count alone is insufficient: complete UTF-8 bytes exceed the bound.
 const trace=semanticTrace();trace.retrieved_chunks.semantic.response=semanticBody("字".repeat(22000),"SEMANTIC_MODEL_TEXT");
 const response=linkConversationEvidenceTurns([semanticVisitor],[trace]).turns[0].semanticEvidence[0].response;
 assert.equal(response.displayState,"WITHHELD_OVERSIZED");assert.equal(response.body,null);assert.equal(response.bytes,66000);
});
test("Malformed semantic capture receipts are withheld without exposing body or invented HTTP origin",()=>{
 for(const change of [
  r=>{r.capture_origin="UPSTREAM_HTTP";},r=>{r.capture_origin="SEMANTIC_MODEL_TEXT\nsecret";},
  r=>{r.capture_state="HTTP_200";},r=>{r.sha256="invalid-secret-hash";},
  r=>{r.bytes=-1;},r=>{r.bytes+=1;},r=>{delete r.body;},
  r=>{r.capture_state="WITHHELD_SENSITIVE";},
 ]){
  const trace=semanticTrace();change(trace.retrieved_chunks.semantic.response);
  const response=linkConversationEvidenceTurns([semanticVisitor],[trace]).turns[0].semanticEvidence[0].response;
  assert.equal(response.displayState,"WITHHELD_INVALID_RECEIPT");
  assert.equal(response.body,null);assert.equal(response.sha256,null);assert.equal(response.captureOrigin,null);
 }
});
