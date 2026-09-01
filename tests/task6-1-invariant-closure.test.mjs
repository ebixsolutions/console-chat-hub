import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

function importTs(file) {
  const source = fs.readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, `${file} syntax errors: ${errors.map((d) => String(d.messageText)).join('; ')}`);
  const tmp = path.join(os.tmpdir(), `task6-1-${path.basename(file)}-${process.pid}-${Date.now()}-${Math.random()}.mjs`);
  fs.writeFileSync(tmp, compiled.outputText);
  return import(pathToFileURL(tmp).href).finally(() => { try { fs.unlinkSync(tmp); } catch {} });
}

const ci = await importTs('supabase/functions/_shared/conversation-intelligence.ts');
const grounding = await importTs('supabase/functions/_shared/kb-grounding.ts');

// INV-CONV-RAG-01: follow-up/pronoun/correction/topic-switch semantics.
const hist = (turnsNewestFirst) => turnsNewestFirst.map((content) => ({ role: 'visitor', content }));
let q = ci.buildContextualRetrievalQuery('簡單一點解釋給我聽。', hist(['簡單一點解釋給我聽。', '什么是四電一腦？']));
assert.equal(q.mode, 'contextual');
assert.match(q.query, /四電一腦/);
assert.match(q.query, /簡單一點/);

q = ci.buildContextualRetrievalQuery('那包括哪些種類？', hist(['那包括哪些種類？', '簡單一點解釋給我聽。', '什么是四電一腦？']));
assert.equal(q.mode, 'contextual');
assert.match(q.query, /四電一腦/);
assert.match(q.query, /包括哪些種類/);

q = ci.buildContextualRetrievalQuery('我講錯，是 XYZ789。', hist(['我講錯，是 XYZ789。', '型號是 ABC123。']));
assert.equal(q.mode, 'contextual');
assert.match(q.query, /ABC123/);
assert.match(q.query, /XYZ789/);

q = ci.buildContextualRetrievalQuery('我想查產品 DEF900 的保養條款。', hist(['我想查產品 DEF900 的保養條款。', '之前談的是 ABC100。']));
assert.equal(q.mode, 'standalone');
assert.equal(q.query, '我想查產品 DEF900 的保養條款。');
assert.doesNotMatch(q.query, /ABC100/);

// Agent-assist draft/selected-message mode must remain conversation-bound.
q = ci.buildConversationAssistRetrievalQuery('我們可以替你處理。', hist(['對。', '我要退貨。', '昨天收到產品。']));
assert.equal(q.mode, 'contextual');
assert.match(q.query, /退貨/);
assert.match(q.query, /昨天收到產品/);
assert.match(q.query, /我們可以替你處理/);

// INV-KB-DOC-01 / INV-KB-PUB-01: one published winner, zero evidence mixing.
const ev = (doc, content, score, source='FAQ', chunk_id='c1') => ({ document_id: doc, chunk_id, content, score, source_type: source });
const chunk = (doc, content, score, source='FAQ', status='published', chunk_id='c1') => ({ document_id: doc, chunk_id, content, score, source_type: source, status, chunk_type: 'full_content' });
const doc = (id, document_score, evidence, chunks, selected=id) => ({
  document_id: id,
  document_score,
  chunks,
  llm_context: { selected_document_id: selected, orientation_summary: null, full_content_evidence: evidence },
});

let sel = grounding.selectGroundedDocument([
  doc('doc-b', .70, [ev('doc-b', 'B evidence', .9)], [chunk('doc-b', 'B evidence', .9)]),
  doc('doc-a', .80, [ev('doc-a', 'A evidence', .8)], [chunk('doc-a', 'A evidence', .8)]),
], { minScore: .55, requirePublished: true });
assert.equal(sel.ok, true);
assert.equal(sel.document.document_id, 'doc-a');
assert.ok(sel.evidence.every((e) => e.document_id === 'doc-a'));
assert.ok(sel.chunks.every((c) => c.document_id === 'doc-a' && c.status === 'published'));

sel = grounding.selectGroundedDocument([
  doc('draft-doc', .99, [ev('draft-doc', 'draft', .99)], [chunk('draft-doc', 'draft', .99, 'FAQ', 'draft')]),
  doc('pub-doc', .75, [ev('pub-doc', 'published', .8)], [chunk('pub-doc', 'published', .8)]),
], { minScore: .55, requirePublished: true });
assert.equal(sel.ok, true);
assert.equal(sel.document.document_id, 'pub-doc');

sel = grounding.selectGroundedDocument([
  doc('doc-a', .9, [ev('other-doc', 'bad', .9)], [chunk('doc-a', 'bad', .9)]),
], { minScore: .55, requirePublished: true });
assert.deepEqual(sel, { ok: false, error: 'KB_DOCUMENT_EVIDENCE_MISMATCH' });

sel = grounding.selectGroundedDocument([
  doc('low', .99, [ev('low', 'low', .4)], [chunk('low', 'low', .4)]),
], { minScore: .55, requirePublished: true });
assert.equal(sel.ok, true);
assert.equal(sel.document, null);

sel = grounding.selectGroundedDocument([
  doc('faq', .95, [ev('faq', 'faq', .9, 'FAQ')], [chunk('faq', 'faq', .9, 'FAQ')]),
  doc('policy', .80, [ev('policy', 'policy text', .85, 'Policy')], [chunk('policy', 'policy text', .85, 'Policy')]),
], { minScore: .55, policyOnly: true, requirePublished: true });
assert.equal(sel.ok, true);
assert.equal(sel.document.document_id, 'policy');

// Source-level cross-caller invariants.
const generate = fs.readFileSync('supabase/functions/generate-reply/index.ts', 'utf8');
const assist = fs.readFileSync('supabase/functions/agent-assist/index.ts', 'utf8');
const proxy = fs.readFileSync('supabase/functions/kb-search-proxy/index.ts', 'utf8');
const crm = fs.readFileSync('src/components/console/CRMPanel.tsx', 'utf8');
const tools = fs.readFileSync('src/components/console/AgentToolPanel.tsx', 'utf8');

assert.match(generate, /buildContextualRetrievalQuery\(_h1LastMsg/);
assert.match(generate, /selectGroundedDocument\(ragResult\.documents \?\? \[\]/);
assert.doesNotMatch(generate, /const usableChunks = ragResult\.chunks\.filter/);
assert.doesNotMatch(generate, /!c\.status \|\| c\.status === "published"/);

assert.match(assist, /buildConversationAssistRetrievalQuery/);
assert.match(assist, /contextMode===\"conversation\"/);
assert.doesNotMatch(assist, /fetchKBRag\(\{query:content\.slice\(0,500\)/);
assert.match(assist, /selectAgentAssistGrounding\(kb\.documents\)/);

assert.match(proxy, /buildContextualRetrievalQuery/);
assert.match(proxy, /query_mode/);
assert.match(proxy, /forceAutoContext/);
assert.match(crm, /query_mode: queryMode/);
assert.match(crm, /"auto_context"/);
assert.match(crm, /context_mode: "conversation"/);
assert.match(tools, /context_mode: cs === "custom" \? "manual" : "conversation"/);

// Machine caller registry. Customer-facing / agent-assist production callers
// must obey Task 6.1. CE grounding is explicitly owned by Task 6.2 because it
// evaluates a whole conversation and intentionally may collect separate KB and
// policy evidence. Generated bundles are frozen build artifacts, never source
// entrypoints, and must not be treated as independent runtime callers.
const productionCallers = [];
const explicitExemptions = new Set([
  'supabase/functions/_shared/ce-grounding.ts',
]);
function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name).replaceAll('\\', '/');
    if (ent.isDirectory()) {
      if (p.includes('/generated')) continue;
      walk(p);
    } else if (ent.isFile() && p.endsWith('.ts')) {
      const s = fs.readFileSync(p, 'utf8');
      if (s.includes('fetchKBRag(') && !p.endsWith('_shared/kb-client.ts') && !explicitExemptions.has(p)) productionCallers.push(p);
    }
  }
}
walk('supabase/functions');
const expected = [
  'supabase/functions/agent-assist/index.ts',
  'supabase/functions/generate-reply/index.ts',
  'supabase/functions/kb-search-proxy/index.ts',
].sort();
assert.deepEqual(productionCallers.sort(), expected, `Unexpected Task 6.1 fetchKBRag callers: ${productionCallers.join(', ')}`);

const ceGrounding = fs.readFileSync('supabase/functions/_shared/ce-grounding.ts', 'utf8');
assert.match(ceGrounding, /Conversation Evaluation grounding adapter/);
assert.match(ceGrounding, /requirePolicyEvidence/);
const generatedBundle = fs.readFileSync('supabase/functions/generated/task4-1-generate-reply.bundle.ts', 'utf8');
assert.match(generatedBundle, /^\/\/ supabase\/functions\/_shared\/kb-client\.ts/);

const registry = JSON.parse(fs.readFileSync('config/ai-chatbot-invariants.json', 'utf8'));
assert.ok(registry.invariants.some((i) => i.id === 'INV-CONV-RAG-01'));
assert.ok(registry.invariants.some((i) => i.id === 'INV-KB-DOC-01'));
assert.ok(registry.invariants.some((i) => i.id === 'INV-KB-PUB-01'));
assert.deepEqual(registry.task6_1_exemptions.map((x) => x.path).sort(), [
  'supabase/functions/_shared/ce-grounding.ts',
  'supabase/functions/generated/task4-1-generate-reply.bundle.ts',
].sort());

console.log('TASK6_1_INVARIANT_CLOSURE_TESTS=PASS');
