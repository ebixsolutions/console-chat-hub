import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveAuthoritativeSupabaseBinding as resolve, AUTHORITATIVE_SUPABASE_PUBLISHABLE_KEY as key, AUTHORITATIVE_SUPABASE_ORIGIN as origin, AUTHORITATIVE_SUPABASE_PROJECT_ID as project, AUTHORITATIVE_SUPABASE_FUNCTIONS_ORIGIN as functions, assertAuthoritativeSupabaseRuntime as assertRuntime } from '../../src/integrations/supabase/runtime-authority.mjs';
const foreignJwt = 'e30.' + Buffer.from(JSON.stringify({ref:'foreign-project'})).toString('base64url') + '.signature';
for (const injected of ['sb_publishable_FOREIGN_KEY', foreignJwt, 'malformed.jwt.value']) {
  test(`non-authoritative input cannot replace canonical client key: ${injected.startsWith('sb_') ? 'opaque' : 'JWT'}`, () => {
    assert.deepEqual(resolve({ url:'https://foreign.supabase.co', projectId:'foreign', publishableKey:injected, functionsUrl:'https://foreign.supabase.co/functions/v1' }), { url:origin, projectId:project, publishableKey:key, functionsUrl:functions });
  });
}
test('canonical client binding and explicit runtime rejection', () => {
  assert.equal(resolve({publishableKey:key}).publishableKey,key);
  assert.throws(()=>assertRuntime('https://foreign.supabase.co',project));
  assert.throws(()=>assertRuntime(origin,'foreign'));
});
test('browser and SSR clients resolve the same authority before construction', () => {
  for(const file of ['src/integrations/supabase/client.ts','src/integrations/supabase/client.server.ts']) {
    const source=readFileSync(new URL('../../'+file,import.meta.url),'utf8');
    assert.match(source,/resolveAuthoritativeSupabaseBinding/);
    assert.match(source,/assertAuthoritativeSupabaseRuntime/);
  }
});
test('npm and Bun resolve the exact authorized Lovable tool without package version upgrades', () => {
  const pkg=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url)));
  const lock=JSON.parse(readFileSync(new URL('../../package-lock.json',import.meta.url)));
  assert.equal(pkg.devDependencies['@lovable.dev/vite-tanstack-config'],'2.25.3');
  assert.equal(lock.packages[''].devDependencies['@lovable.dev/vite-tanstack-config'],'2.25.3');
  assert.equal(lock.packages['node_modules/@lovable.dev/vite-tanstack-config'].version,'2.25.3');
  const bun=readFileSync(new URL('../../bun.lock',import.meta.url),'utf8');
  assert.match(bun,/@lovable\.dev\/vite-tanstack-config@2\.25\.3/);
});
