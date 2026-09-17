#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const PRODUCTION_REF = "nrfxhqabwblzxoushgnm";
export const NONPRODUCTION_REF = "nbtowfuvvfqpxqydyoby";
export const BASE_HEAD = "efbe6b2f9ef333da8845260534bdc5ba41524bf8";
export const BASE_TREE = "56f18dca1d7e40aa860faf352a1f354a84d55971";
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

export function sourceClosureManifest(entry) {
  const root = path.resolve("supabase/functions");
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    const imports = /(?:from\s+|import\s*)["'](\.\.?\/[^"']+)["']/g;
    let match;
    while ((match = imports.exec(source))) {
      let dependency = path.resolve(path.dirname(file), match[1]);
      if (!path.extname(dependency)) dependency += ".ts";
      if (fs.existsSync(dependency)) walk(dependency);
    }
  };
  walk(path.resolve(root, entry));
  const files = [...seen].sort().map((file) => ({
    path: path.relative(root, file),
    sha256: sha(fs.readFileSync(file)),
  }));
  return { files, sha256: sha(Buffer.from(canonicalJson(files))) };
}

export function loadFrozenDataset(file = DATASET_PATH) {
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes);
  if (value.schema_version !== "c3-nonproduction-heldout-1.0.0") fail("dataset_schema_invalid");
  if (value.repository !== "ebixsolutions/console-chat-hub") fail("dataset_repository_invalid");
  if (value.candidate?.base_head !== BASE_HEAD || value.candidate?.base_tree !== BASE_TREE || value.candidate?.binding_mode !== "workflow_checkout_and_closure_manifest") fail("dataset_candidate_invalid");
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

export function validateIsolation({ projectRef, projectUrl, head, tree, workflowHead = head, workflowTree = tree }) {
  if (projectRef !== NONPRODUCTION_REF || projectRef === PRODUCTION_REF) fail("nonproduction_project_ref_invalid");
  const parsed = new URL(projectUrl);
  if (parsed.protocol !== "https:" || parsed.hostname !== `${projectRef}.supabase.co`) fail("nonproduction_url_identity_invalid");
  if (projectUrl.includes(PRODUCTION_REF)) fail("production_url_fallback_detected");
  if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(tree) || head !== workflowHead || tree !== workflowTree) fail("candidate_identity_invalid");
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

async function restInsert(base, key, table, rows) {
  if (!rows.length) return;
  await request(`${base}/rest/v1/${table}`, {
    method: "POST",
    headers: restHeaders(key),
    body: JSON.stringify(rows),
  });
}

const BASE_FIXTURE = {
  company: "c3000000-0000-4000-8000-000000000001",
  agent: "c3000000-0000-4000-8000-000000000110",
  membership: "c3000000-0000-4000-8000-000000000111",
  role: "c3000000-0000-4000-8000-000000000112",
  widget: "c3000000-0000-4000-8000-000000000120",
  channel: "c3000000-0000-4000-8000-000000000130",
  kbTenant: "c3000000-0000-4000-8000-000000001001",
  kbDocument: "c3000000-0000-4000-8000-000000001101",
  kbVersion: "c3000000-0000-4000-8000-000000001201",
  kbChunk: "c3000000-0000-4000-8000-000000001301",
};

async function provisionBaseFixtures(base, key, email, password) {
  const created = await request(`${base}/auth/v1/admin/users`, {
    method: "POST",
    headers: restHeaders(key),
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { synthetic: true, c3: true } }),
  }, [200, 201]);
  const userId = created.body?.id;
  if (typeof userId !== "string") fail("test_agent_creation_missing_id");
  await restInsert(base, key, "company", [{ id: BASE_FIXTURE.company, slug: "c3-heldout", display_name: "C3 Held-out Synthetic Company", external_workspace_id: "c3-heldout", external_tenant_id: "c3-heldout", is_active: true, platform_company_id: 93001 }]);
  await restInsert(base, key, "agent_profile", [{ id: BASE_FIXTURE.agent, user_id: userId, display_name: "C3 Synthetic Agent", email, role: "agent", status: "active" }]);
  await restInsert(base, key, "user_roles", [{ id: BASE_FIXTURE.role, user_id: userId, role: "agent" }]);
  await restInsert(base, key, "company_membership", [{ id: BASE_FIXTURE.membership, company_id: BASE_FIXTURE.company, user_id: userId, role: "agent", is_active: true }]);
  await restInsert(base, key, "widget_config", [{ id: BASE_FIXTURE.widget, name: "C3 Held-out Synthetic Widget", header_title: "Synthetic Support", is_active: true }]);
  await restInsert(base, key, "channel_config", [{ id: BASE_FIXTURE.channel, name: "C3 Held-out Synthetic Channel", channel_type: "web_widget", widget_config_id: BASE_FIXTURE.widget, company_id: BASE_FIXTURE.company, allowed_origins: ["https://nonproduction.invalid"], is_active: true }]);
  await restInsert(base, key, "c3_nonprod_kb_tenant", [{ id: BASE_FIXTURE.kbTenant, company_id: BASE_FIXTURE.company, external_tenant_id: 93001, name: "C3 Held-out KB Tenant", is_active: true }]);
  const kbText = "Synthetic island delivery takes three business days and requires address confirmation. Synthetic returns require the original receipt within thirty days.";
  await restInsert(base, key, "c3_nonprod_kb_document", [{ id: BASE_FIXTURE.kbDocument, tenant_id: BASE_FIXTURE.kbTenant, title: "C3 Synthetic Customer Support Policy", source_type: "policy", language: "en", status: "published", publication_state: "published", currentness: "current", version: "v1", version_rank: 1, source_priority: 100, authority_scope: "customer_support", effective_at: "2026-01-01T00:00:00Z", published_at: "2026-01-01T00:00:00Z", claims: [{ key: "synthetic_policy", value: "current" }] }]);
  await restInsert(base, key, "c3_nonprod_kb_document_version", [{ id: BASE_FIXTURE.kbVersion, document_id: BASE_FIXTURE.kbDocument, version: "v1", version_rank: 1, raw_content_snapshot: kbText, content_hash: sha(Buffer.from(kbText)), review_status: "approved", vector_status: "not_generated" }]);
  await restInsert(base, key, "c3_nonprod_kb_chunk", [{ id: BASE_FIXTURE.kbChunk, document_id: BASE_FIXTURE.kbDocument, version_id: BASE_FIXTURE.kbVersion, chunk_index: 0, chunk_text: kbText, chunk_type: "full_content", status: "active", embedding_status: "pending" }]);
  return userId;
}

async function cleanupBaseFixtures(base, key, userId) {
  await restDelete(base, key, "c3_nonprod_kb_chunk", "id", [BASE_FIXTURE.kbChunk]);
  await restDelete(base, key, "c3_nonprod_kb_document_version", "id", [BASE_FIXTURE.kbVersion]);
  await restDelete(base, key, "c3_nonprod_kb_document", "id", [BASE_FIXTURE.kbDocument]);
  await restDelete(base, key, "c3_nonprod_kb_tenant", "id", [BASE_FIXTURE.kbTenant]);
  await restDelete(base, key, "company_membership", "id", [BASE_FIXTURE.membership]);
  await restDelete(base, key, "user_roles", "id", [BASE_FIXTURE.role]);
  await restDelete(base, key, "agent_profile", "id", [BASE_FIXTURE.agent]);
  await restDelete(base, key, "channel_config", "id", [BASE_FIXTURE.channel]);
  await restDelete(base, key, "widget_config", "id", [BASE_FIXTURE.widget]);
  await restDelete(base, key, "company", "id", [BASE_FIXTURE.company]);
  if (userId) await request(`${base}/auth/v1/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE", headers: restHeaders(key) }, [200, 204]);
}

export function verifyEvidence(evidence, datasetHash) {
  if (evidence.schema_version !== "c3-nonproduction-http-evidence-1.0.0") fail("evidence_schema_invalid");
  validateIsolation(evidence.binding);
  const generate = sourceClosureManifest("generate-reply/index.ts");
  const assist = sourceClosureManifest("agent-assist/index.ts");
  if (evidence.binding.generate_reply_manifest !== generate.sha256 || evidence.binding.agent_assist_manifest !== assist.sha256) fail("runtime_manifest_binding_invalid");
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
  let userId=null;
  let accessToken=null;
  const companyId = BASE_FIXTURE.company;
  const agentId = BASE_FIXTURE.agent;
  const observations=[]; const conversationIds=[]; const messageIds=[]; const visitorIds=[]; const crmCustomerIds=[]; const entitlementIds=[];
  try {
    userId=await provisionBaseFixtures(base,serviceKey,email,password);
    const login = await request(`${base}/auth/v1/token?grant_type=password`, { method:"POST", headers:{apikey:serviceKey,"Content-Type":"application/json"}, body:JSON.stringify({email,password}) });
    accessToken = login.body?.access_token;
    if (!accessToken || login.body?.user?.id!==userId) fail("test_agent_session_missing");
    for (const row of dataset.value.cases) {
      const conversationId=fixtureUuid(row.id,"conversation"); const sourceMessageId=fixtureUuid(row.id,"source");
      const visitorId=fixtureUuid(row.id,"visitor"),crmCustomerId=fixtureUuid(row.id,"crm-customer");
      const customerRef=`cus_${sha(Buffer.from(row.id)).slice(0,24)}`;
      conversationIds.push(conversationId); messageIds.push(sourceMessageId); visitorIds.push(visitorId); crmCustomerIds.push(crmCustomerId);
      await restInsert(base,serviceKey,"visitor_session",[{id:visitorId,session_token:`c3-${row.id}`,channel_config_id:BASE_FIXTURE.channel,visitor_fingerprint:`synthetic-${row.id}`,visitor_metadata:{synthetic:true,case_id:row.id,customer_ref:customerRef}}]);
      await request(`${base}/rest/v1/conversations`,{method:"POST",headers:restHeaders(serviceKey),body:JSON.stringify({id:conversationId,visitor_session_id:visitorId,channel_config_id:BASE_FIXTURE.channel,status:row.endpoint==="agent-assist"?"pending":"open",assigned_agent_id:row.endpoint==="agent-assist"?agentId:null,company_id:companyId,language:"en",metadata_source:{source:"c3_nonproduction_heldout",synthetic:true,case_id:row.id}})});
      await restInsert(base,serviceKey,"c3_nonprod_crm_customer",[{id:crmCustomerId,company_id:companyId,conversation_id:conversationId,customer_ref:customerRef,source_identity:"c3-customer360-db-v1",context:{synthetic:true,case_id:row.id},is_active:true}]);
      const authority=row.context_contract.source_authority;
      if(authority==="trusted_crm_required"||row.id==="c3-ho-094"||row.id==="c3-ho-095"){
        const first=fixtureUuid(row.id,"entitlement-1");entitlementIds.push(first);
        await restInsert(base,serviceKey,"c3_nonprod_crm_entitlement",[{id:first,customer_id:crmCustomerId,name:"premium_installation",value:"included",scope:"customer_support",status:"active",valid_from:row.id==="c3-ho-094"?"2024-01-01T00:00:00Z":"2026-01-01T00:00:00Z",valid_until:row.id==="c3-ho-094"?"2025-01-01T00:00:00Z":"2099-01-01T00:00:00Z"}]);
        if(row.id==="c3-ho-095"){const second=fixtureUuid(row.id,"entitlement-2");entitlementIds.push(second);await restInsert(base,serviceKey,"c3_nonprod_crm_entitlement",[{id:second,customer_id:crmCustomerId,name:"premium_installation",value:"excluded",scope:"customer_support",status:"active",valid_from:"2026-01-01T00:00:00Z",valid_until:"2099-01-01T00:00:00Z"}]);}
      }
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
    await restDelete(base,serviceKey,"c3_nonprod_crm_entitlement","id",entitlementIds);
    await restDelete(base,serviceKey,"c3_nonprod_crm_customer","id",crmCustomerIds);
    await restDelete(base,serviceKey,"conversation_memory_state_event","conversation_id",conversationIds);
    await restDelete(base,serviceKey,"conversation_memory_state","conversation_id",conversationIds);
    await restDelete(base,serviceKey,"messages","conversation_id",conversationIds);
    await restDelete(base,serviceKey,"conversations","id",conversationIds);
    await restDelete(base,serviceKey,"visitor_session","id",visitorIds);
    await cleanupBaseFixtures(base,serviceKey,userId);
  }
  const readback=await request(`${base}/rest/v1/conversations?id=in.(${encodeURIComponent(conversationIds.map(x=>`"${x}"`).join(","))})&select=id`,{headers:restHeaders(serviceKey,{Prefer:"",Range:"0-0"})});
  const residualChecks=await Promise.all([
    request(`${base}/rest/v1/visitor_session?id=in.(${encodeURIComponent(visitorIds.map(x=>`"${x}"`).join(","))})&select=id`,{headers:restHeaders(serviceKey,{Prefer:"",Range:"0-0"})}),
    request(`${base}/rest/v1/c3_nonprod_crm_customer?id=in.(${encodeURIComponent(crmCustomerIds.map(x=>`"${x}"`).join(","))})&select=id`,{headers:restHeaders(serviceKey,{Prefer:"",Range:"0-0"})}),
    request(`${base}/rest/v1/company?id=eq.${BASE_FIXTURE.company}&select=id`,{headers:restHeaders(serviceKey,{Prefer:"",Range:"0-0"})}),
  ]);
  const zeroResidual=Array.isArray(readback.body)&&readback.body.length===0&&residualChecks.every((item)=>Array.isArray(item.body)&&item.body.length===0);
  const evidence={schema_version:"c3-nonproduction-http-evidence-1.0.0",binding:{...binding,dataset_sha256:dataset.sha256},started_at:new Date().toISOString(),completed_at:new Date().toISOString(),observations,cleanup:{checked_ids:observations.length,zero_residual:zeroResidual}};
  fs.writeFileSync(outFile,JSON.stringify(evidence,null,2)+"\n",{mode:0o600});
  verifyEvidence(evidence,dataset.sha256);
}

function identity() {
  return { head:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(), tree:execFileSync("git",["rev-parse","HEAD^{tree}"],{encoding:"utf8"}).trim() };
}

async function main() {
  const command=process.argv[2]??""; const dataset=loadFrozenDataset();
  if(command==="verify-dataset"){console.log(`C3_NONPROD_DATASET|cases=${dataset.value.case_count}|sha256=${dataset.sha256}|responses_at_freeze=0|result=PASS`);return;}
  if(command==="preflight"){const checkout=identity();const generate=sourceClosureManifest("generate-reply/index.ts"),assist=sourceClosureManifest("agent-assist/index.ts");const binding={projectRef:process.env.C3_NONPROD_SUPABASE_PROJECT_REF,projectUrl:process.env.C3_NONPROD_SUPABASE_URL,head:checkout.head,tree:checkout.tree,workflowHead:checkout.head,workflowTree:checkout.tree};validateIsolation(binding);console.log(`C3_NONPROD_PREFLIGHT|ref=${NONPRODUCTION_REF}|runtime_head=${checkout.head}|runtime_tree=${checkout.tree}|generate_manifest=${generate.sha256}|assist_manifest=${assist.sha256}|dataset_sha256=${dataset.sha256}|result=PASS`);return;}
  if(command==="run"){const checkout=identity();const binding={projectRef:process.env.C3_NONPROD_SUPABASE_PROJECT_REF,projectUrl:process.env.C3_NONPROD_SUPABASE_URL,head:checkout.head,tree:checkout.tree,workflowHead:checkout.head,workflowTree:checkout.tree,generate_reply_manifest:sourceClosureManifest("generate-reply/index.ts").sha256,agent_assist_manifest:sourceClosureManifest("agent-assist/index.ts").sha256};validateIsolation(binding);const authorization=`c3-nonprod-model-${checkout.head}-${checkout.tree}`;if(process.env.C3_NONPROD_MODEL_AUTHORIZATION!==authorization)fail("zero_cost_model_authorization_missing");await executeHeldout(dataset,binding,process.argv[3]??"c3-nonproduction-http-evidence.json");console.log(`C3_NONPROD_HTTP|responses=${dataset.value.case_count}|cleanup=PASS|result=PASS`);return;}
  if(command==="verify-evidence"){verifyEvidence(JSON.parse(fs.readFileSync(process.argv[3],"utf8")),dataset.sha256);console.log("C3_NONPROD_EVIDENCE|result=PASS");return;}
  fail(`unsupported_command:${command}`);
}

if(import.meta.url===`file://${process.argv[1]}`) main().catch((error)=>{console.error(`C3_NONPROD_EXTERNAL_QUALITY|result=FAIL|reason=${error.message}`);process.exitCode=1;});
