import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AUTHORITATIVE_SUPABASE_PROJECT_ID as productionRef } from './src/integrations/supabase/runtime-authority.mjs';
import { AUTHORITATIVE_SUPABASE_PROJECT_ID as nonproductionRef } from './src/integrations/supabase/nonproduction-authority.mjs';

// Build receipt, not proof of deployed backend/API parity. No secrets or request data.
export function candidateIdentity(nonproduction) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const files = git('ls-files', '-z').split('\0').filter(path =>
    /\.(?:tsx?|m?js|css)$/.test(path) && !path.startsWith('tests/'));
  // Include new identity source before its first commit.
  if (!files.includes('vite.candidate-identity.mjs')) files.push('vite.candidate-identity.mjs');
  const hash = createHash('sha256');
  for (const path of files.sort()) hash.update(path + '\0').update(readFileSync(path)).update('\0');
  return Object.freeze({
    projectId: '4dbf593e-577e-4af4-a553-460441c34473',
    head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    modified: Boolean(git('status', '--porcelain')), sourceSha256: hash.digest('hex'),
    buildProfile: nonproduction ? 'nonproduction' : 'production',
    sourceBackendRef: nonproduction ? nonproductionRef : productionRef,
    backendRuntimeVerified: false,
  });
}

export function candidateIdentityPlugin(identity) {
  const stamp = () => '/* C3 candidate ' + JSON.stringify(identity) + ' */\n' + readFileSync('public/widget/chat.js', 'utf8');
  return {
    name: 'c3-integrated-candidate-receipt',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = request.url?.split('?')[0];
        if (path !== '/c3-candidate.json' && path !== '/widget/chat.js') return next();
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', path === '/widget/chat.js' ? 'text/javascript; charset=utf-8' : 'application/json');
        response.end(path === '/widget/chat.js' ? stamp() : JSON.stringify(identity));
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'c3-candidate.json', source: JSON.stringify(identity, null, 2) });
      this.emitFile({ type: 'asset', fileName: 'widget/chat.js', source: stamp() });
    },
  };
}
