import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const ciPath = 'supabase/functions/_shared/conversation-intelligence.ts';
const genPath = 'supabase/functions/generate-reply/index.ts';
const ciSource = fs.readFileSync(ciPath, 'utf8');
const genSource = fs.readFileSync(genPath, 'utf8');

assert.match(ciSource, /export function buildContextualRetrievalQuery\(/);
assert.match(genSource, /buildContextualRetrievalQuery\(_h1LastMsg, _pr5HistoryRows \?\? \[\]\)/);
assert.doesNotMatch(genSource, /const userQuery = _h1LastMsg;/);

const transpiled = ts.transpileModule(ciSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
}).outputText;
const tmp = path.join(os.tmpdir(), `conversation-intelligence-${process.pid}-${Date.now()}.mjs`);
fs.writeFileSync(tmp, transpiled);
const mod = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

const rows = (...texts) => texts.map((content) => ({ role: 'visitor', content }));
const q = mod.buildContextualRetrievalQuery;

let r = q('什么是四電一腦？', rows('什么是四電一腦？'));
assert.equal(r.mode, 'standalone');
assert.equal(r.query, '什么是四電一腦？');

r = q('簡單一點解釋給我聽。', rows('簡單一點解釋給我聽。', '什么是四電一腦？'));
assert.equal(r.mode, 'contextual');
assert.match(r.query, /四電一腦/);
assert.match(r.query, /簡單一點/);

r = q('那包括哪些種類？', rows('那包括哪些種類？', '什么是四電一腦？'));
assert.equal(r.mode, 'contextual');
assert.match(r.query, /四電一腦/);

r = q('它的保養多久？', rows('它的保養多久？', 'XR-500 可以退貨嗎？'));
assert.equal(r.mode, 'contextual');
assert.match(r.query, /XR-500/);

r = q('澳門呢？', rows('澳門呢？', '這個政策適用香港嗎？'));
assert.equal(r.mode, 'contextual');
assert.match(r.query, /香港/);

r = q('我講錯，是 XYZ789。', rows('我講錯，是 XYZ789。', '型號是 ABC123。'));
assert.equal(r.mode, 'contextual');
assert.match(r.query, /XYZ789/);
assert.match(r.query, /ABC123/);

r = q('火星上的規定呢？', rows('火星上的規定呢？', '什么是四電一腦？'));
assert.equal(r.mode, 'contextual');
assert.match(r.query, /火星/);

r = q('我想查產品 DEF900 的保養條款。', rows('我想查產品 DEF900 的保養條款。', '之前談的是 ABC100。'));
assert.equal(r.mode, 'standalone');
assert.doesNotMatch(r.query, /ABC100/);

r = q('Can you explain that in English?', rows('Can you explain that in English?', '什么是四電一腦？'));
assert.equal(r.mode, 'contextual');
assert.match(r.query, /四電一腦/);

r = q('不要轉真人，我想先問 AI。', rows('不要轉真人，我想先問 AI。', '什么是四電一腦？'));
assert.equal(r.mode, 'standalone');

r = q('那個呢？', [
  { role: 'visitor', content: '那個呢？' },
  { role: 'assistant', content: 'INTERNAL_ASSISTANT_TEXT_SHOULD_NOT_ENTER_QUERY' },
  { role: 'visitor', content: 'XR-500 的退貨政策。' },
]);
assert.equal(r.mode, 'contextual');
assert.match(r.query, /XR-500/);
assert.doesNotMatch(r.query, /INTERNAL_ASSISTANT_TEXT/);

console.log('TASK5_1_CONTEXTUAL_RETRIEVAL_TESTS=PASS');
