import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Render the complete original route with real React hooks. Only the external
// service boundary and authenticated role are fixtures; no real API is called.
const require = createRequire(path.resolve(process.env.C3_REACT_TEST_ROOT ?? '.', 'package.json'));
const React = require('react');
const { create, act } = require('react-test-renderer');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const fixture = globalThis.__kbBindingSaveRuntime = {};

const compiled = await build({
  entryPoints: ['src/routes/_authenticated/console.settings.kb-binding.tsx'],
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  define: { 'import.meta.env.VITE_C3_KB_BINDING_DEV_ENABLED': '"true"' },
  plugins: [{
    name: 'kb-binding-runtime-boundaries',
    setup(builder) {
      builder.onResolve({ filter: /^react(?:\/.*)?$/ }, ({ path: module }) => ({
        path: require.resolve(module), external: true,
      }));
      builder.onResolve({ filter: /^(@tanstack\/react-router|@\/hooks\/useCurrentRole|@\/components\/console\/PageStates|@\/lib\/api\/kbBinding.service)$/ }, ({ path: module }) => ({
        path: module, namespace: 'kb-fixture',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'kb-fixture' }, ({ path: module }) => {
        if (module === '@tanstack/react-router') {
          return { contents: 'export const createFileRoute = () => options => options;' };
        }
        if (module.endsWith('/useCurrentRole')) {
          return { contents: 'export const useCurrentRole = () => globalThis.__kbBindingSaveRuntime.role;' };
        }
        if (module.endsWith('/PageStates')) {
          return { contents: 'export const LoadingState = () => null; export const PermissionDenied = () => null;' };
        }
        return { contents: `
          const f = globalThis.__kbBindingSaveRuntime;
          export const isKBDevHost = (host, enabled) => enabled && host === f.host;
          export const kbDevBindingService = {
            list: () => f.list(),
            save: input => f.save(input),
            listAuthorizedCompanyScopesReadOnly: () => f.readOnly(),
            invite: () => { throw new Error('Unexpected invitation'); },
            createOrLinkTestAccount: () => { throw new Error('Unexpected account grant'); },
            bootstrap: () => { throw new Error('Unexpected tenant bootstrap'); },
          };
        ` };
      });
    },
  }],
});
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c3-kb-binding-runtime-'));
const routeModule = path.join(tempDir, 'route.mjs');
fs.writeFileSync(routeModule, compiled.outputFiles[0].text);
let Route;
try {
  ({ Route } = await import(pathToFileURL(routeModule)));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

const COMPANY = 'bdb07806-be44-499c-bfcb-b08afac2d213';
const ACTOR = '740ec4da-4a09-4395-a362-5b6a52e0dd03';
const EMAIL = 'uat@ebixpro.com';
const MOCK_KEY = 'MOCK_KB50_NATIVE_TEST_KEY_ONLY';
const text = value => typeof value === 'string'
  ? value
  : Array.isArray(value)
    ? value.map(text).join('')
    : value?.children?.map(text).join('') ?? '';
const alerts = renderer => renderer.root.findAllByProps({ role: 'alert' }).map(node => text(node.children)).join('\n');
const confirmation = renderer => renderer.root.findAllByProps({ id: 'kb-binding-save-confirmation' });

function reset() {
  fixture.host = 'id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app';
  fixture.role = { role: 'admin', actorId: ACTOR, loading: false };
  fixture.binding = {
    company_id: COMPANY,
    company_name: 'UAT KB50 native fixture',
    kb_tenant_id: null,
    kb_company_id: null,
    is_active: false,
    revision: 0,
    has_key: false,
    writer_ready: false,
    writer_status: 'server_credential_unavailable',
    binding_write_eligible: true,
    channels_ready: true,
    updated_at: null,
    members: [{ user_id: ACTOR, role: 'admin', email: EMAIL, is_active: true }],
  };
  fixture.listCalls = 0;
  fixture.saveCalls = [];
  fixture.afterSaveRead = null;
  fixture.saveOutcome = null;
  fixture.list = async () => {
    fixture.listCalls += 1;
    if (fixture.saveCalls.length && fixture.afterSaveRead) return fixture.afterSaveRead();
    return { ok: true, data: [structuredClone(fixture.binding)] };
  };
  fixture.readOnly = async () => ({ ok: false, error: 'fixture_readback_unavailable' });
  fixture.save = async input => {
    fixture.saveCalls.push(structuredClone(input));
    if (fixture.saveOutcome) return fixture.saveOutcome(input);
    fixture.binding = {
      ...fixture.binding,
      kb_tenant_id: input.kb_tenant_id,
      kb_company_id: input.kb_company_id,
      is_active: input.is_active,
      revision: input.expected_revision + 1,
      has_key: true,
      updated_at: '2026-11-12T03:00:00Z',
    };
    return {
      ok: true,
      data: {
        company_id: input.company_id,
        kb_tenant_id: input.kb_tenant_id,
        revision: input.expected_revision + 1,
        is_active: input.is_active,
        has_key: true,
      },
    };
  };
  globalThis.window = { location: { host: fixture.host } };
}

async function mount(t) {
  let renderer;
  await act(async () => { renderer = create(React.createElement(Route.component)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return renderer;
}

async function enterBinding(renderer) {
  await act(async () => {
    renderer.root.findByProps({ id: 'kb-login-email' }).props.onChange({ target: { value: EMAIL } });
    renderer.root.findByProps({ id: 'kb-tenant-input' }).props.onChange({ target: { value: '50' } });
    renderer.root.findByProps({ id: 'kb-key-input' }).props.onChange({ target: { value: MOCK_KEY } });
    renderer.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } });
  });
  const save = renderer.root.findByProps({ id: 'kb-binding-save' });
  assert.equal(save.props.disabled, false, 'B eligibility must permit Save without the unavailable management writer');
  assert.equal(renderer.root.findByProps({ id: 'kb-key-input' }).props.type, 'password');
}

async function clickSave(renderer) {
  await act(async () => { renderer.root.findByProps({ id: 'kb-binding-save' }).props.onClick(); });
  // Allow the metadata synchronization effect to run after the refreshed row.
  await act(async () => {});
}

function assertOneMaskedSave(renderer) {
  assert.equal(fixture.saveCalls.length, 1, 'unknown or failed outcomes must not automatically resend');
  assert.deepEqual(fixture.saveCalls[0], {
    company_id: COMPANY,
    kb_tenant_id: '50',
    kb_company_id: null,
    is_active: true,
    expected_revision: 0,
    api_key: MOCK_KEY,
  });
  assert.equal(renderer.root.findByProps({ id: 'kb-key-input' }).props.value, '', 'clear the write-only key after the attempt');
}

test('KB50 B Save preserves verified revision feedback after the real metadata effect', async t => {
  reset();
  const renderer = await mount(t);
  await enterBinding(renderer);
  await clickSave(renderer);
  assertOneMaskedSave(renderer);
  assert.equal(fixture.listCalls, 2, 'one initial list and one post-save readback');
  assert.equal(confirmation(renderer).length, 1);
  assert.match(text(confirmation(renderer)[0].children), /Saved and read back/);
  assert.match(text(confirmation(renderer)[0].children), /revision\s*1/i);
  assert.match(text(renderer.toJSON()), /Current Revision:\s*1/);
  assert.equal(alerts(renderer), '');
});

test('KB50 unknown Save result remains unconfirmed and never automatically resends', async t => {
  reset();
  fixture.saveOutcome = async () => ({ ok: false, error: 'binding_save_unconfirmed_reload_before_retry' });
  const renderer = await mount(t);
  await enterBinding(renderer);
  await clickSave(renderer);
  assertOneMaskedSave(renderer);
  assert.equal(confirmation(renderer).length, 0);
  assert.match(alerts(renderer), /unconfirmed|could not be confirmed|Reload/i);
  assert.doesNotMatch(text(renderer.toJSON()), /Saved (?:to the authorized|and read back)/);
  // Re-entering a key must not accidentally unlock an unknown prior outcome.
  await act(async () => {
    renderer.root.findByProps({ id: 'kb-key-input' }).props.onChange({ target: { value: MOCK_KEY } });
  });
  assert.equal(renderer.root.findByProps({ id: 'kb-binding-save' }).props.disabled, true);
  assert.equal(fixture.saveCalls.length, 1);
  const reload = renderer.root.findAllByType('button').find(node => text(node.children) === 'Reload live identity');
  await act(async () => { reload.props.onClick(); });
  assert.equal(renderer.root.findByProps({ id: 'kb-binding-save' }).props.disabled, false,
    'only a successful explicit metadata reload may release the retry lock');
  assert.equal(fixture.saveCalls.length, 1, 'a metadata reload must never dispatch a save');
});

test('KB50 stale CAS revision is an actionable conflict with no success or retry', async t => {
  reset();
  fixture.saveOutcome = async () => ({ ok: false, error: 'binding_revision_conflict_reload' });
  const renderer = await mount(t);
  await enterBinding(renderer);
  await clickSave(renderer);
  assertOneMaskedSave(renderer);
  assert.equal(confirmation(renderer).length, 0);
  assert.match(alerts(renderer), /changed in another session.*Reload/s);
});

test('KB50 committed Save with failed refreshed metadata never displays confirmed success', async t => {
  reset();
  fixture.afterSaveRead = async () => ({ ok: false, error: 'binding_metadata_rls_read_failed' });
  const renderer = await mount(t);
  await enterBinding(renderer);
  await clickSave(renderer);
  assertOneMaskedSave(renderer);
  assert.equal(confirmation(renderer).length, 0);
  assert.match(alerts(renderer), /unconfirmed|could not be confirmed|Reload before/i);
  assert.doesNotMatch(text(renderer.toJSON()), /Saved (?:to the authorized|and read back)/);
  assert.equal(renderer.root.findByProps({ id: 'kb-binding-save' }).props.disabled, true);
});

test('KB50 receipt requires the same Company, tenant, revision and active readback', async t => {
  for (const [field, value] of [
    ['company_id', '00000000-0000-4000-8000-000000000050'],
    ['kb_tenant_id', '51'],
    ['revision', 2],
    ['is_active', false],
  ]) {
    await t.test(`mismatched ${field} cannot become a Save success`, async caseTest => {
      reset();
      fixture.afterSaveRead = async () => ({
        ok: true,
        data: [{ ...structuredClone(fixture.binding), [field]: value }],
      });
      const renderer = await mount(caseTest);
      await enterBinding(renderer);
      await clickSave(renderer);
      assertOneMaskedSave(renderer);
      assert.equal(confirmation(renderer).length, 0);
      assert.match(alerts(renderer), /unconfirmed|could not be confirmed|Reload before/i);
      assert.doesNotMatch(text(renderer.toJSON()), /Saved (?:to the authorized|and read back)/);
    });
  }
});
