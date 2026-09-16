#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export const PRODUCTION_REF = "nrfxhqabwblzxoushgnm";
export const NONPRODUCTION_REF = "nbtowfuvvfqpxqydyoby";
export const EXPECTED_HEAD = "2c1b9566d3c50d6a09ef151939b54d34bb034c12";
export const EXPECTED_TREE = "825da428244bb36177184c0d689f4863cbe1515e";
export const DATASET_PATH = new URL("./c3_nonproduction_heldout_dataset.json", import.meta.url);
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_NAMESPACE = "c3-nonproduction-external-quality-v1";
const fail = (reason) => { throw new Error(reason); };
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  : value;
export const canonicalJson = (value) => JSON.stringify(canonical(value));

export function loadFrozenDataset(file = DATASET_PATH) {
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes);
  if (value.schema_version !== "c3-nonproduction-heldout-1.0.0") fail("dataset_schema_invalid");
  if (value.repository !== "ebixsolutions/console-chat-hub") fail("dataset_repository_invalid");
  if (value.candidate?.head !== EXPECTED_HEAD || value.candidate?.tree !== EXPECTED_TREE) fail("dataset_candidate_invalid");
  if (value.frozen_before_responses !== true || value.response_count_at_freeze !== 0) fail("dataset_not_prefrozen");
  if (!Array.isArray(value.cases) || value.cases.length < 100 || value.case_count !== value.cases.length) fail("dataset_case_count_invalid");
  const ids = new Set();
  const categories = new Set();
  const endpoints = new Set();
  for (const row of value.cases) {
    if (!/^c3-ho-[0-9]{3}$/.test(row.id) || ids.has(row.id)) fail("dataset_case_identity_invalid");
    if (typeof row.customer_message !== "string" || row.customer_message.trim().length < 20) fail(`dataset_message_invalid:${row.id}`);
    if (!['short','medium','long'].includes(row.conversation_length)) fail(`dataset_length_invalid:${row.id}`);
    if (!['generate-reply','agent-assist'].includes(row.endpoint)) fail(`dataset_endpoint_invalid:${row.id}`);
    if (row.context_contract?.synthetic !== true || row.context_contract?.must_not_assume !== true) fail(`dataset_context_invalid:${row.id}`);
    if (!Array.isArray(row.oracle?.critical_prohibitions) || !row.oracle.critical_prohibitions.includes("invent_facts")) fail(`dataset_oracle_invalid:${row.id}`);
    ids.add(row.id); categories.add(row.category); endpoints.add(row.endpoint);
  }
  if (categories.size < 10 || endpoints.size !== 2) fail("dataset_coverage_invalid");
  return { value, bytes, sha256: sha(bytes) };
}

export function validateIsolation({ projectRef, projectUrl, head, tree }) {
  if (projectRef !== NONPRODUCTION_REF || projectRef === PRODUCTION_REF) fail("nonproduction_project_ref_invalid");
  const parsed = new URL(projectUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== `${projectRef}.supabase.co`) fail("nonproduction_url_identity_invalid");
  if (projectUrl.includes(PRODUCTION_REF)) fail("production_url_fallback_detected");
  if (head !== EXPECTED_HEAD || tree !== EXPECTED_TREE) fail("candidate_identity_invalid");
  return true;
}

function fixtureUuid(caseId, suffix) {
  const h = sha(`${UUID_NAMESPACE}:${caseId}:${suffix}`);
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}

async function request(url, init, allowed = [200,201,204]) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  if (!allowed.includes(response.status)) fail(`http_${response.status}:${body?.error ?? body?.message ?? "request_failed"}`);
  return { status: response.status, body };
}

function restHeaders(serviceKey, extra = {}) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "return=minimal", ...extra };
}

async function restDelete(base, key, table, column, ids) {
  if (!ids.length) return;
  const encoded = ids.map((id) => `"${id}"`).join(",");
  await request(`${base}/rest/v1/${table}?${column}=in.(${encodeURIComponent(encoded)})`, { method: "DELETE", headers: restHeaders(key) });
}

export function verifyEvidence(evidence, datasetHash) {
  if (evidence.schema_version !== "c3-nonproduction-http-evidence-1.0.0") fail("evidence_schema_invalid");
  validateIsolation(evidence.binding);
  if (evidence.binding.dataset_sha256 !== datasetHash || !HEX64.test(datasetHash)) fail("evidence_dataset_binding_invalid");
  if (!Array.isArray(evidence.observations) || evidence.observations.length < 100) fail("evidence_observation_count_invalid");
  const expected = new Map(loadFrozenDataset().value.cases.map((row) => [row.id, row.endpoint]));
  const ids = new Set();
  const responseHashes = new Set();
  for (const row of evidence.observations) {
    if (ids.has(row.case_id) || !expected.has(row.case_id)) fail("evidence_replay_or_unknown_case_id");
    if (expected.get(row.case_id) !== row.endpoint) fail(`evidence_endpoint_mismatch:${row.case_id}`);
    if (!HEX64.test(row.request_sha256) || !HEX64.test(row.context_sha256) || !HEX64.test(row.response_sha256)) fail(`evidence_hash_invalid:${row.case_id}`);
    if (sha(Buffer.from(canonicalJson(row.request))) !== row.request_sha256) fail(`evidence_request_hash_mismatch:${row.case_id}`);
    if (sha(Buffer.from(canonicalJson(row.context))) !== row.context_sha256) fail(`evidence_context_hash_mismatch:${row.case_id}`);
    if (sha(Buffer.from(canonicalJson(row.response))) !== row.response_sha256) fail(`evidence_response_hash_mismatch:${row.case_id}`);
    if (responseHashes.has(row.response_sha256)) fail(`evidence_duplicate_response:${row.case_id}`);
    ids.add(row.case_id);
    responseHashes.add(row.response_sha256);
  }
  if (ids.size !== expected.size) fail("evidence_dataset_coverage_incomplete");
  if (evidence.cleanup?.zero_residual !== true || evidence.cleanup?.checked_ids !== evidence.observations.length) fail("evidence_cleanup_invalid");
  return true;
}

async function executeHeldout(dataset, binding, outFile) {
  const base = process.env.C3_NONPROD_SUPABASE_URL;
  const serviceKey = process.env.C3_NONPROD_SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.C3_NONPROD_TEST_AGENT_EMAIL;
  const password = process.env.C3_NONPROD_TEST_AGENT_PASSWORD;
  for (const [name,value] of Object.entries({C3_NONPROD_SUPABASE_URL:base,C3_NONPROD_SUPABASE_SERVICE_ROLE_KEY:serviceKey,C3_NONPROD_TEST_AGENT_EMAIL:email,C3_NONPROD_TEST_AGENT_PASSWORD:password})) if (!value) fail(`missing_secret:${name}`);
  const login = await request(`${base}/auth/v1/token?grant_type=password`, { method:"POST", headers:{apikey:serviceKey,"Content-Type":"application/json"}, body:JSON.stringify({email,password}) });
  const accessToken = login.body?.access_token;
  const userId = login.body?.user?.id;
  if (!accessToken || !userId) fail("test_agent_session_missing");
  const profile = await request(`${base}/rest/v1/agent_profile?user_id=eq.${encodeURIComponent(userId)}&select=id`, {headers:restHeaders(serviceKey,{Prefer:""})});
  const agentId = profile.body?.[0]?.id;
  if (!agentId) fail("test_agent_profile_missing");
  const companyId = "c3000000-0000-4000-8000-000000000001";
  const observations=[]; const conversationIds=[]; const messageIds=[];
  try {
    for (const row of dataset.value.cases) {
      const conversationId=fixtureUuid(row.id,"conversation"); const sourceMessageId=fixtureUuid(row.id,"source");
      conversationIds.push(conversationId); messageIds.push(sourceMessageId);
      await request(`${base}/rest/v1/conversations`,{method:"POST",headers:restHeaders(serviceKey),body:JSON.stringify({id:conversationId,status:row.endpoint==="agent-assist"?"pending":"open",assigned_agent_id:row.endpoint==="agent-assist"?agentId:null,company_id:companyId,language:"en",metadata_source:{source:"c3_nonproduction_heldout",synthetic:true,case_id:row.id}})});
      const history=[];
      for(let n=0;n<row.context_contract.prior_turns;n++){const id=fixtureUuid(row.id,`history-${n}`);messageIds.push(id);history.push({id,conversation_id:conversationId,role:n%2===0?"visitor":"assistant",content:n%2===0?`Synthetic prior customer turn ${n+1} for ${row.category}.`:`Synthetic prior assistant acknowledgement ${n+1}; no external claim.`,metadata:{synthetic:true,case_id:row.id}});}
      if(history.length) await request(`${base}/rest/v1/messages`,{method:"POST",headers:restHeaders(serviceKey),body:JSON.stringify(history)});
      await request(`${base}/rest/v1/messages`,{method:"POST",headers:restHeaders(serviceKey),body:JSON.stringify({id:sourceMessageId,conversation_id:conversationId,role:"visitor",content:row.customer_message,metadata:{synthetic:true,held_out:true,case_id:row.id}})});
      const payload=row.endpoint==="generate-reply"?{conversation_id:conversationId,source_message_id:sourceMessageId}:{tool_type:"suggest_reply",conversation_id:conversationId,content:row.customer_message,context_mode:"full"};
      const context={case_id:row.id,category:row.category,conversation_length:row.conversation_length,prior_turns:row.context_contract.prior_turns,oracle:row.oracle};
      const result=await request(`${base}/functions/v1/${row.endpoint}`,{method:"POST",headers:{apikey:serviceKey,Authorization:`Bearer ${accessToken}`,"Content-Type":"application/json"},body:JSON.stringify(payload)});
      observations.push({case_id:row.id,endpoint:row.endpoint,conversation_id:conversationId,source_message_id:sourceMessageId,request:payload,context,response:result.body,http_status:result.status,request_sha256:sha(Buffer.from(canonicalJson(payload))),context_sha256:sha(Buffer.from(canonicalJson(context))),response_sha256:sha(Buffer.from(canonicalJson(result.body)))});
    }
  } finally {
    await restDelete(base,serviceKey,"conversation_memory_state_event","conversation_id",conversationIds);
    await restDelete(base,serviceKey,"conversation_memory_state","conversation_id",conversationIds);
    await restDelete(base,serviceKey,"messages","conversation_id",conversationIds);
    await restDelete(base,serviceKey,"conversations","id",conversationIds);
  }
  const readback=await request(`${base}/rest/v1/conversations?id=in.(${encodeURIComponent(conversationIds.map(x=>`"${x}"`).join(","))})&select=id`,{headers:restHeaders(serviceKey,{Prefer:"",Range:"0-0"})});
  const evidence={schema_version:"c3-nonproduction-http-evidence-1.0.0",binding:{...binding,dataset_sha256:dataset.sha256},started_at:new Date().toISOString(),completed_at:new Date().toISOString(),observations,cleanup:{checked_ids:observations.length,zero_residual:Array.isArray(readback.body)&&readback.body.length===0}};
  fs.writeFileSync(outFile,JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
  verifyEvidence(evidence,dataset.sha256);
}

function identity() {
  return { head:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(), tree:execFileSync("git",["rev-parse","HEAD^{tree}"],{encoding:"utf8"}).trim() };
}

async function main() {
  const command=process.argv[2]??""; const dataset=loadFrozenDataset();
  if(command==="verify-dataset"){console.log(`C3_NONPROD_DATASET|cases=${dataset.value.case_count}|sha256=${dataset.sha256}|responses_at_freeze=0|result=PASS`);return;}
  if(command==="preflight"){const checkout=identity();const binding={projectRef:process.env.C3_NONPROD_SUPABASE_PROJECT_REF,projectUrl:process.env.C3_NONPROD_SUPABASE_URL,head:EXPECTED_HEAD,tree:EXPECTED_TREE,workflow_head:checkout.head,workflow_tree:checkout.tree};validateIsolation(binding);console.log(`C3_NONPROD_PREFLIGHT|ref=${NONPRODUCTION_REF}|runtime_head=${EXPECTED_HEAD}|workflow_head=${checkout.head}|dataset_sha256=${dataset.sha256}|result=PASS`);return;}
  if(command==="run"){const checkout=identity();const binding={projectRef:process.env.C3_NONPROD_SUPABASE_PROJECT_REF,projectUrl:process.env.C3_NONPROD_SUPABASE_URL,head:EXPECTED_HEAD,tree:EXPECTED_TREE,workflow_head:checkout.head,workflow_tree:checkout.tree,generate_reply_manifest:"93c4e80f8f21fbcebc7a56b383d9ae6c1205fc705493a9debfd7c8817972385d",agent_assist_manifest:"59d324b3a7bcaf26634f51fa547beeedc536b19344d733f5af68c8ecc0cbaf23"};validateIsolation(binding);await executeHeldout(dataset,binding,process.argv[3]??"c3-nonproduction-http-evidence.json");console.log(`C3_NONPROD_HTTP|responses=${dataset.value.case_count}|cleanup=PASS|result=PASS`);return;}
  if(command==="verify-evidence"){verifyEvidence(JSON.parse(fs.readFileSync(process.argv[3],"utf8")),dataset.sha256);console.log("C3_NONPROD_EVIDENCE|result=PASS");return;}
  fail(`unsupported_command:${command}`);
}

if(import.meta.url===`file://${process.argv[1]}`) main().catch((error)=>{console.error(`C3_NONPROD_EXTERNAL_QUALITY|result=FAIL|reason=${error.message}`);process.exitCode=1;});
