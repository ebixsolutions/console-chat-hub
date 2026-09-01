import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const helperPath = 'src/lib/console/contextualKbQuery.ts';
const crmPath = 'src/components/console/CRMPanel.tsx';
const agentPath = 'src/components/console/AgentToolPanel.tsx';
const customerPath = 'src/lib/customer360/useCustomerContext.ts';

const helperSource = fs.readFileSync(helperPath, 'utf8');
const crmSource = fs.readFileSync(crmPath, 'utf8');
const agentSource = fs.readFileSync(agentPath, 'utf8');
const customerSource = fs.readFileSync(customerPath, 'utf8');

assert.match(crmSource, /deriveContextualKbAutoQuery/);
assert.doesNotMatch(crmSource, /return latest\.length >= KB_AUTO_QUERY_MIN_CHARS \? latest : context/);
assert.match(crmSource, /kbReqIdRef\.current !== reqId/);
assert.match(crmSource, /polReqIdRef\.current !== reqId/);
assert.match(agentSource, /toolReqIdRef\.current !== reqId/);
assert.match(customerSource, /const stale = \(\) => cancelled \|\| reqIdRef\.current !== reqId/);
assert.doesNotMatch(crmSource, /Lifetime Value|Order Value:\s*\$|VIP:\s*(Gold|Silver|Platinum)/i);

const transpiled = ts.transpileModule(helperSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const tmp = path.join(os.tmpdir(), `task5-2-context-${process.pid}-${Date.now()}.mjs`);
fs.writeFileSync(tmp, transpiled);
const mod = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);
const q = mod.deriveContextualKbAutoQuery;

let r = q('什么是四電一腦？');
assert.equal(r, '什么是四電一腦？');

r = q('什么是四電一腦？ / 簡單一點解釋給我聽。');
assert.match(r, /四電一腦/);
assert.match(r, /簡單一點/);

r = q('什么是四電一腦？ / 簡單一點解釋給我聽。 / 那包括哪些種類？');
assert.match(r, /四電一腦/);
assert.match(r, /包括哪些種類/);
assert.doesNotMatch(r, /簡單一點解釋給我聽.*包括哪些種類/);

r = q('XR-500 可以退貨嗎？ / 它的保養多久？');
assert.match(r, /XR-500/);
assert.match(r, /保養多久/);

r = q('這個政策適用香港嗎？ / 澳門呢？');
assert.match(r, /香港/);
assert.match(r, /澳門/);

r = q('型號是 ABC123。 / 我講錯，是 XYZ789。');
assert.match(r, /ABC123/);
assert.match(r, /XYZ789/);

r = q('之前談的是 ABC100。 / 我想查產品 DEF900 的保養條款。');
assert.equal(r, '我想查產品 DEF900 的保養條款。');
assert.doesNotMatch(r, /ABC100/);

r = q('什么是四電一腦？ / Can you explain that in English?');
assert.match(r, /四電一腦/);
assert.match(r, /English/);

assert.ok(q(('A'.repeat(400)) + ' / ' + ('那這個呢？'.repeat(40))).length <= 500);

console.log('TASK5_2_CONSOLE_CONTEXT_TESTS=PASS');
