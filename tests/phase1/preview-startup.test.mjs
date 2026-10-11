import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';
import { PREVIEW_HOST, resolveConsoleEnvironment as resolve } from '../../vite.preview-environment.mjs';
const dev = { command: 'serve', mode: 'development' };
const build = { command: 'build', mode: 'production' };
test('actual Lovable dev-process markers select the unified production authority', () => {
  for (const env of [{ LOVABLE_SANDBOX:'1' }, { DEV_SERVER__PROJECT_PATH:'/dev-server' }, { LOVABLE_PREVIEW_HOST:PREVIEW_HOST }]) {
    assert.equal(resolve(dev,env),'production');
    assert.equal(resolve(dev,env),'production'); // normal restart, no mutable session state
  }
});
test('explicit nonproduction works in local dev and separate nonproduction builds',()=> {
  for (const config of [dev,build]) assert.equal(resolve(config,{C3_CONSOLE_ENV:'nonproduction'}),'nonproduction');
});
test('production builds preserve default and explicit production binding inside sandbox',()=> {
  for (const markers of [{},{LOVABLE_SANDBOX:'1',LOVABLE_PREVIEW_HOST:PREVIEW_HOST},{DEV_SERVER__PROJECT_PATH:'/dev-server'}]) {
    assert.equal(resolve(build,markers),undefined);
    assert.equal(resolve(build,{...markers,C3_CONSOLE_ENV:'production'}),'production');
  }
});
test('ordinary local dev is unchanged and hosted build:dev selects production',()=> {
  assert.equal(resolve(dev,{}),undefined);
  assert.equal(resolve({command:'build',mode:'development'},{}),undefined);
  assert.equal(resolve({command:'build',mode:'development'},{LOVABLE_SANDBOX:'1'}),'production');
});
test('Preview rejects an obsolete nonproduction selector',()=> {
  assert.throws(()=>resolve(dev,{LOVABLE_SANDBOX:'1',C3_CONSOLE_ENV:'nonproduction'}),/cannot use nonproduction/);
});
test('other project hosts, deceptive suffixes and arbitrary lovable hosts fail closed',()=> {
  for (const host of ['id-preview--aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.lovable.app',PREVIEW_HOST+'.evil.test','arbitrary.lovable.app']) {
    assert.throws(()=>resolve(dev,{LOVABLE_PREVIEW_HOST:host}),/unapproved project host/);
  }
});
test('invalid selector is rejected for both builds and Preview',()=> {
  for (const config of [dev,build]) assert.throws(()=>resolve(config,{C3_CONSOLE_ENV:'staging'}),/Unknown/);
});
test('request, query, client environment and browser storage cannot select a backend',()=> {
  assert.equal(resolve(dev,{VITE_C3_CONSOLE_ENV:'nonproduction',Host:PREVIEW_HOST,Origin:'https://'+PREVIEW_HOST,query:'C3_CONSOLE_ENV=nonproduction',localStorage:'nonproduction'}),undefined);
});
test('Vite reuses one shared browser/SSR authority alias and existing Widget binding',()=> {
  const source=readFileSync(new URL('../../vite.config.ts',import.meta.url),'utf8');
  assert.match(source,/resolveConsoleEnvironment\(environment, process\.env\)/);
  assert.match(source,/new URL\("\.\/src\/integrations\/supabase\/nonproduction-authority\.mjs"/);
  assert.match(source,/data-api-base="https:\/\/nbtowfuvvfqpxqydyoby\.supabase\.co\/functions\/v1"/);
  assert.match(source,/\}\)\(environment\)/);
  assert.doesNotMatch(source,/req\.(?:headers|query).*nonproduction|localStorage|location\.hostname/);
});
test('actual Vite config uses production browser/SSR and Widget binding for normal Preview',async()=> {
  const keys=['LOVABLE_SANDBOX','LOVABLE_PREVIEW_HOST','C3_CONSOLE_ENV'];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    process.env.LOVABLE_SANDBOX='1';process.env.LOVABLE_PREVIEW_HOST=PREVIEW_HOST;delete process.env.C3_CONSOLE_ENV;
    for(const [configuration,expected] of [[dev,false],[{command:'build',mode:'development'},false],[build,false]]) {
      const loaded=await loadConfigFromFile(configuration,fileURLToPath(new URL('../../vite.config.ts',import.meta.url)));
      const rawAliases=loaded.config.resolve?.alias ?? [];
      const aliases=Array.isArray(rawAliases)?rawAliases:Object.entries(rawAliases).map(([find,replacement])=>({find,replacement}));
      const bindings=aliases.filter(x=>x.find instanceof RegExp && x.find.test('./runtime-authority.mjs'));
      assert.equal(bindings.length,expected?1:0);
      if(expected) {
        assert.match(bindings[0].replacement,/\/src\/integrations\/supabase\/nonproduction-authority\.mjs$/);
        for(const specifier of ['@/integrations/supabase/runtime-authority.mjs','./runtime-authority.mjs']) assert.ok(bindings[0].find.test(specifier));
      }
      const plugins=loaded.config.plugins.flat(Infinity).filter(Boolean);
      assert.equal(plugins.some(p=>p.name==='c3-nonproduction-customer-entrypoint'),expected);
    }
  } finally {for(const k of keys) {if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}}
});

test('all targets import the crawler tree handled by Start client pruning',async()=> {
  const saved=process.env.C3_CONSOLE_ENV;
  try {
    for (const target of ['production','nonproduction']) {
      process.env.C3_CONSOLE_ENV=target;
      for (const configuration of [dev,{command:'build',mode:'development'},build]) {
        const loaded=await loadConfigFromFile(configuration,fileURLToPath(new URL('../../vite.config.ts',import.meta.url)));
        const aliases=loaded.config.resolve.alias;
        const matches=aliases.filter(a=>a.find instanceof RegExp && a.find.test('./routeTree.gen'));
        assert.equal(matches.length,1);
        assert.equal(matches[0].replacement,fileURLToPath(new URL('../../.tanstack/c3-preview-routeTree.gen.ts',import.meta.url)));
      }
    }
  } finally {if(saved===undefined)delete process.env.C3_CONSOLE_ENV;else process.env.C3_CONSOLE_ENV=saved;}
});
