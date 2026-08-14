import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const sourcePath = "supabase/functions/_shared/ce-contract.ts";
const source = fs.readFileSync(sourcePath, "utf8");
const out = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
  reportDiagnostics: true,
  fileName: sourcePath,
});
const errors = (out.diagnostics ?? []).filter(
  (d) => d.category === ts.DiagnosticCategory.Error,
);
if (errors.length) {
  throw new Error(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
}

const temp = path.join(os.tmpdir(), `ce-contract-regression-${process.pid}.mjs`);
fs.writeFileSync(temp, out.outputText);
const mod = await import(pathToFileURL(temp).href + `?v=${Date.now()}`);

const companyId = "11111111-1111-4111-8111-111111111111";
const ts0 = "2026-08-14T09:00:00.000Z";
const grounding = {
  kb_chunks: [],
  policy_chunks: [],
  kb_block: "",
  policy_block: "",
  kb_snapshot_id: "sha256:kb",
  policy_snapshot_id: "sha256:policy",
  manifest: {
    adapter: "singapore-kb-client",
    request_id: null,
    retrieval_quality: "high",
    no_answer: false,
    kb_gap_detected: false,
    conflict_detected: false,
    policy_gap: false,
    singapore_tenant_id: "sg-tenant-1",
    company_id: companyId,
    selected_document_ids: [],
    limits: { max_chunk_chars: 3000, max_block_chars: 12000, max_chunks_per_class: 8 },
    kb: { snapshot_id:"sha256:kb", chunks_returned:0, chunks_included:0, chunks_dropped:0, chars_used:0, truncated:false, entries:[] },
    policy: { snapshot_id:"sha256:policy", chunks_returned:0, chunks_included:0, chunks_dropped:0, chars_used:0, truncated:false, entries:[] },
  },
};
const conversation = {
  id: "22222222-2222-4222-8222-222222222222",
  company_id: companyId,
  status: "resolved",
  priority: null,
  channel_config_id: "33333333-3333-4333-8333-333333333333",
  created_at: ts0,
  resolved_at: ts0,
};
const actor = {
  user_id: "44444444-4444-4444-8444-444444444444",
  company_id: companyId,
  roles: ["supervisor"],
};
const messages = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    role: "visitor",
    content: "Need help",
    created_at: ts0,
    is_recalled: false,
    sender_id: null,
    sender_identity_verified_at: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000010",
    role: "assistant",
    content: "AI answer",
    created_at: ts0,
    is_recalled: false,
    sender_id: null,
    sender_identity_verified_at: null,
  },
  {
    id: "00000000-0000-4000-8000-000000000020",
    role: "human_agent",
    content: "Correct human answer",
    created_at: ts0,
    is_recalled: false,
    sender_id: "55555555-5555-4555-8555-555555555555",
    sender_identity_verified_at: ts0,
  },
];

if (mod.normalizeRole("human_agent") !== "human_agent") {
  throw new Error("canonical human_agent role was not preserved");
}

const bundle = await mod.buildCanonicalBundle({
  conversation,
  messages,
  actor,
  grounding,
  contractVersion: "ce-test",
});

if (bundle.verified_human_response?.id !== messages[2].id) {
  throw new Error("same-timestamp verified human response was not selected deterministically");
}
if (!bundle.text.includes(`company_id=${companyId}`)) {
  throw new Error("canonical company_id missing");
}
if (!bundle.text.includes("singapore_tenant_id=sg-tenant-1")) {
  throw new Error("Singapore tenant identity missing");
}
if (bundle.text.includes("workspace_id=") || /\ntenant_id=/.test(bundle.text)) {
  throw new Error("retired Base44 workspace/tenant identity leaked into CE bundle");
}

let mismatchRejected = false;
try {
  await mod.buildCanonicalBundle({
    conversation,
    messages,
    actor,
    grounding: {
      ...grounding,
      manifest: { ...grounding.manifest, company_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    },
    contractVersion: "ce-test",
  });
} catch (e) {
  mismatchRejected = String(e?.message) === "BUNDLE_GROUNDING_COMPANY_MISMATCH";
}
if (!mismatchRejected) {
  throw new Error("grounding company mismatch was not rejected");
}

const earlierHuman = { ...messages[2], id: "00000000-0000-4000-8000-000000000005" };
const bundle2 = await mod.buildCanonicalBundle({
  conversation,
  messages: [messages[0], earlierHuman, messages[1]],
  actor,
  grounding,
  contractVersion: "ce-test",
});
if (bundle2.verified_human_response !== null) {
  throw new Error("human message ordered before AI at same timestamp was incorrectly treated as correction");
}

console.log("PASS CE canonical bundle runtime regression");
console.log("PASS Singapore identity contract");
console.log("PASS CE↔KB company mismatch fail-closed");
console.log("PASS same-timestamp (created_at,id) human ordering");
