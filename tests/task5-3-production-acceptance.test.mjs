import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const helperPath = 'supabase/functions/_shared/agent-assist-grounding.ts';
const backendPath = 'supabase/functions/agent-assist/index.ts';
const uiPath = 'src/components/console/AgentToolPanel.tsx';
const routerPath = 'supabase/functions/_shared/llm-router.ts';
const helperSource = fs.readFileSync(helperPath, 'utf8');
const backend = fs.readFileSync(backendPath, 'utf8');
const ui = fs.readFileSync(uiPath, 'utf8');
const router = fs.readFileSync(routerPath, 'utf8');

assert.match(backend, /selectAgentAssistGrounding\(kb\.documents\)/);
assert.match(backend, /selectAgentAssistGrounding\(kb\.documents,\{policyOnly:true\}\)/);
assert.doesNotMatch(backend, /kb\.llm_context\?\.full_content_evidence/);
assert.match(backend, /callModel\(/);
assert.doesNotMatch(backend, /api\.anthropic\.com/);
assert.match(ui, /suggest_reply/);
assert.match(ui, /suggestResult/);
assert.match(ui, /onUseDraft\(s\.content\)/);
assert.match(ui, /toolReqIdRef\.current !== reqId/);
assert.match(ui, /const isResolved = convStatus === "resolved"/);
assert.match(ui, /AGENT_ASSIST_MAX_CONTENT = 2000/);
assert.match(router, /LLM_PROVIDER/);
assert.match(router, /GOOGLE_SERVICE_ACCOUNT_JSON/);
assert.match(router, /vertex/);

for (const [label, source] of [['agent-assist', backend], ['grounding-helper', helperSource]]) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: true,
  });
  const syntacticErrors = (compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  assert.equal(syntacticErrors.length, 0, `${label} has TypeScript syntax errors: ${syntacticErrors.map(d => d.messageText).join('; ')}`);
}

const transpiled = ts.transpileModule(helperSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const tmp = path.join(os.tmpdir(), `task5-3-grounding-${process.pid}-${Date.now()}.mjs`);
fs.writeFileSync(tmp, transpiled);
const { selectAgentAssistGrounding: select } = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

const ev = (document_id, content, score, source_type='FAQ') => ({ document_id, content, score, source_type });
const doc = (document_id, document_score, evidence, orientation_summary=null, selectedId=document_id) => ({
  document_id,
  document_score,
  llm_context: { selected_document_id: selectedId, orientation_summary, full_content_evidence: evidence },
});

let r = select([
  doc('doc-b', .70, [ev('doc-b', 'B evidence', .90)]),
  doc('doc-a', .80, [ev('doc-a', 'A evidence', .60)]),
]);
assert.equal(r.ok, true);
assert.equal(r.document.document_id, 'doc-a');
assert.deepEqual(r.evidence.map(e => e.document_id), ['doc-a']);

r = select([
  doc('doc-a', .80, [ev('doc-a', 'faq', .90, 'FAQ')]),
  doc('doc-policy', .70, [ev('doc-policy', 'returns policy', .70, 'Policy')]),
], { policyOnly: true });
assert.equal(r.ok, true);
assert.equal(r.document.document_id, 'doc-policy');
assert.deepEqual(r.evidence.map(e => e.document_id), ['doc-policy']);

r = select([doc('doc-a', .9, [ev('other-doc', 'bad evidence', .9)])]);
assert.deepEqual(r, { ok: false, error: 'KB_DOCUMENT_EVIDENCE_MISMATCH' });

r = select([doc('doc-a', .9, [ev('doc-a', 'good', .9)], null, 'other-doc')]);
assert.deepEqual(r, { ok: false, error: 'KB_DOCUMENT_EVIDENCE_MISMATCH' });

r = select([doc('doc-a', .9, [])]);
assert.equal(r.ok, true);
assert.equal(r.document, null);
assert.deepEqual(r.evidence, []);

r = select([
  doc('doc-b', .8, [ev('doc-b', 'B', .8)]),
  doc('doc-a', .8, [ev('doc-a', 'A', .8)]),
]);
assert.equal(r.document.document_id, 'doc-a');

console.log('TASK5_3_PRODUCTION_ACCEPTANCE_TESTS=PASS');
