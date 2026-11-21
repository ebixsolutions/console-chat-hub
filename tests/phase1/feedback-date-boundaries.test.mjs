import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';

// Execute the real server input schema and date boundary function without
// initializing Auth, Supabase, or a browser. No substitute query implementation.
const source = readFileSync(new URL('../../src/lib/api/feedback.service.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('feedback.service.ts', source, ts.ScriptTarget.Latest, true);
const nodes = ast.statements.filter(s =>
  (ts.isVariableStatement(s) && s.declarationList.declarations.some(d => d.name.getText(ast) === 'listInput')) ||
  (ts.isFunctionDeclaration(s) && s.name?.text === 'nextDayUtc'));
assert.equal(nodes.length, 2);
const context = vm.createContext({ z });
vm.runInContext(ts.transpileModule(nodes.map(n => n.getText(ast)).join('\n') +
  '\nglobalThis.schema = listInput; globalThis.upper = nextDayUtc;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText, context);

for (const field of ['from', 'to']) {
  test(`Feedback ${field} rejects impossible calendar dates before query execution`, () => {
    for (const value of ['2026-02-30', '2026-02-29', '1900-02-29', '2026-04-31', '2026-99-99', '2026-00-10', '2026-01-00']) {
      assert.equal(context.schema.safeParse({ [field]: value }).success, false, value);
    }
  });
  test(`Feedback ${field} accepts real dates and rejects timestamps or noncanonical values`, () => {
    for (const value of ['2024-02-29', '2000-02-29', '2026-01-01', '2026-12-31']) {
      assert.equal(context.schema.safeParse({ [field]: value }).success, true, value);
    }
    for (const value of ['2026-1-1', '2026-01-01T00:00:00Z', '', ' 2026-01-01']) {
      assert.equal(context.schema.safeParse({ [field]: value }).success, false, value);
    }
  });
}
test('Feedback inclusive end date becomes the next UTC midnight across month, leap and year boundaries', () => {
  for (const [date, expected] of [
    ['2026-02-28', '2026-03-01T00:00:00.000Z'],
    ['2024-02-28', '2024-02-29T00:00:00.000Z'],
    ['2024-02-29', '2024-03-01T00:00:00.000Z'],
    ['2026-12-31', '2027-01-01T00:00:00.000Z'],
  ]) {
    const parsed = context.schema.parse({ to: date });
    assert.equal(context.upper(parsed.to), expected);
  }
});
test('Feedback initial unfiltered read still validates and keeps pagination defaults', () => {
  const parsed = context.schema.parse({});
  assert.equal(parsed.from, undefined);
  assert.equal(parsed.to, undefined);
  assert.equal(parsed.page, 0);
  assert.equal(parsed.page_size, 20);
});
