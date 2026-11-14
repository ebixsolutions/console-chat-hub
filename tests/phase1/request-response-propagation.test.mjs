import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createMiddleware } from '@tanstack/react-start';

// Execute the actual request middleware with the installed TanStack factory.
// Extracting its declaration avoids initializing the unrelated browser client.
const source = readFileSync(new URL('../../src/start.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('start.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(s => ts.isVariableStatement(s) &&
  s.declarationList.declarations.some(d => d.name.getText(ast) === 'errorMiddleware'));
assert.ok(declaration, 'original request error middleware must exist');
const pageSource = readFileSync(new URL('../../src/lib/error-page.ts', import.meta.url), 'utf8');
const pageModule = { exports: {} };
const pageContext = vm.createContext({ exports: pageModule.exports, module: pageModule });
vm.runInContext(ts.transpileModule(pageSource, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText, pageContext);
const errors = [];
const context = vm.createContext({ createMiddleware, Response,
  console: { error: e => errors.push(e) },
  renderErrorPage: pageModule.exports.renderErrorPage,
});
vm.runInContext(ts.transpileModule(declaration.getText(ast) +
  '\n;globalThis.middleware = errorMiddleware;', { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None,
} }).outputText, context);
const run = next => context.middleware.options.server({ next });

for (const status of [401, 403, 409, 429, 302]) {
  test(`deliberate HTTP ${status} survives request boundary unchanged`, async () => {
    const response = new Response(status === 302 ? null : 'controlled response', {
      status, headers: { 'Cache-Control': 'no-store',
        ...(status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}),
        ...(status === 429 ? { 'Retry-After': '15' } : {}),
        ...(status === 302 ? { Location: '/login' } : {}),
      },
    });
    await assert.rejects(run(async () => { throw response; }), error => {
      assert.equal(error, response);
      assert.equal(error.status, status);
      assert.equal(error.headers.get('Cache-Control'), 'no-store');
      return true;
    });
    assert.equal(response.bodyUsed, false);
  });
}
test('ordinary unexpected failure remains sanitized HTTP500', async () => {
  const failure = new Error('PRIVATE_SYNTHETIC_FAILURE');
  const response = await run(async () => { throw failure; });
  assert.equal(response.status, 500);
  assert.match(response.headers.get('Content-Type'), /text\/html/);
  assert.ok(errors.includes(failure));
  assert.doesNotMatch(await response.text(), /PRIVATE_SYNTHETIC_FAILURE/);
});
test('framework statusCode control remains thrown', async () => {
  const failure = { statusCode: 404, message: 'not found' };
  await assert.rejects(run(async () => { throw failure; }), error => error === failure);
});
test('successful downstream Response remains unchanged', async () => {
  const response = Response.json({ ok: true });
  assert.equal(await run(async () => response), response);
});
