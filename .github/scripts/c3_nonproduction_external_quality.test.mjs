import assert from "node:assert/strict";
import crypto from "node:crypto";
import { canonicalJson, loadFrozenDataset, sourceClosureManifest, validateIsolation, verifyEvidence } from "./c3_nonproduction_external_quality.mjs";

const sha=(value)=>crypto.createHash("sha256").update(value).digest("hex");
const dataset=loadFrozenDataset();
assert.equal(dataset.value.case_count,100);
assert.equal(new Set(dataset.value.cases.map((row)=>row.customer_message)).size,100);
const head=dataset.value.candidate.base_head,tree=dataset.value.candidate.base_tree;
assert.throws(()=>validateIsolation({projectRef:"nrfxhqabwblzxoushgnm",projectUrl:"https://nrfxhqabwblzxoushgnm.supabase.co",head,tree}),/nonproduction_project_ref_invalid/);
assert.throws(()=>validateIsolation({projectRef:"nbtowfuvvfqpxqydyoby",projectUrl:"https://nrfxhqabwblzxoushgnm.supabase.co",head,tree}),/nonproduction_url_identity_invalid/);

const observations=dataset.value.cases.map((row,index)=>{
  const request={case_id:row.id,prompt:row.customer_message};
  const context={category:row.category,length:row.conversation_length};
  const response={case_id:row.id,synthetic_test_response:`unique-${index}`};
  return {case_id:row.id,endpoint:row.endpoint,request,context,response,
    request_sha256:sha(Buffer.from(canonicalJson(request))),
    context_sha256:sha(Buffer.from(canonicalJson(context))),
    response_sha256:sha(Buffer.from(canonicalJson(response)))};
});
const evidence={schema_version:"c3-nonproduction-http-evidence-1.0.0",binding:{projectRef:"nbtowfuvvfqpxqydyoby",projectUrl:"https://nbtowfuvvfqpxqydyoby.supabase.co",head,tree,workflowHead:head,workflowTree:tree,dataset_sha256:dataset.sha256,generate_reply_manifest:sourceClosureManifest("generate-reply/index.ts").sha256,agent_assist_manifest:sourceClosureManifest("agent-assist/index.ts").sha256},observations,cleanup:{checked_ids:100,zero_residual:true}};
assert.equal(verifyEvidence(evidence,dataset.sha256),true);

const forged=structuredClone(evidence);forged.observations[0].response={changed:true};
assert.throws(()=>verifyEvidence(forged,dataset.sha256),/response_hash_mismatch/);
const replay=structuredClone(evidence);replay.observations[1].response=replay.observations[0].response;replay.observations[1].response_sha256=replay.observations[0].response_sha256;
assert.throws(()=>verifyEvidence(replay,dataset.sha256),/duplicate_response/);
const wrongHead=structuredClone(evidence);wrongHead.binding.head="0".repeat(40);
assert.throws(()=>verifyEvidence(wrongHead,dataset.sha256),/candidate_identity_invalid/);
const dirtyCleanup=structuredClone(evidence);dirtyCleanup.cleanup.zero_residual=false;
assert.throws(()=>verifyEvidence(dirtyCleanup,dataset.sha256),/cleanup_invalid/);
console.log(`C3_NONPROD_CONTROL_TESTS|cases=${observations.length}|positive=1|negative=4|result=PASS`);
