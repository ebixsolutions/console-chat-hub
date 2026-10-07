import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTHORITATIVE_SUPABASE_PROJECT_ID as productionRef } from './src/integrations/supabase/runtime-authority.mjs';
import { AUTHORITATIVE_SUPABASE_PROJECT_ID as nonproductionRef } from './src/integrations/supabase/nonproduction-authority.mjs';

// Build receipt, not proof of deployed backend/API parity. No secrets or request data.
// Same bounded manifest in git and exported build copies. Never traverse links,
// .env, runtime data or generated output. Hash actual bytes, not mtimes/git blobs.
const ROOTS = ['src', 'public', 'supabase/functions'];
const CONFIG = ['package.json', 'package-lock.json', 'bun.lock', 'index.html',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'components.json',
  'vite.config.ts', 'vite.preview-environment.mjs', 'vite.preview-environment.d.mts',
  'vite.candidate-identity.mjs', 'vite.candidate-identity.d.mts'];
const OMIT = /^(?:node_modules|dist|build|\.output|\.git|\.tanstack|\.cache|coverage|cache|sessions?|runtime-data|secrets?)$/i;
const SOURCE = /\.(?:tsx?|jsx?|mjs|mts|cts|css|json|html|svg|png|jpe?g|webp|ico|woff2?|ttf|txt)$/i;
const SECRET = /(?:^|[./_-])(?:secret|credentials?|private[-_]?key|session)(?:[./_-]|$)|\.test\.|\.spec\./i;
export function sourceFingerprint(root = fileURLToPath(new URL('.', import.meta.url))) {
  root = resolve(root);
  const files = [];
  const visit = file => {
    const abs = resolve(root, file);
    let stat; try { stat = lstatSync(abs); } catch (error) { if(error.code==='ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (OMIT.test(file.split('/').at(-1))) return;
      for (const name of readdirSync(abs).sort()) visit(file + '/' + name);
    } else if (stat.isFile() && !SECRET.test(file) && (SOURCE.test(file) || CONFIG.includes(file))) files.push(file);
  };
  for (const file of [...ROOTS, ...CONFIG]) visit(file);
  const paths = [...new Set(files)].sort();
  if (!paths.includes('vite.candidate-identity.mjs') || !paths.includes('public/widget/chat.js')) throw Error('Candidate source manifest incomplete');
  if (paths.length > 10000) throw Error('Candidate source manifest too large');
  const hash = createHash('sha256').update('c3-source-manifest-v2\0');
  let size = 0;
  for (const file of paths) {
    const bytes = readFileSync(resolve(root,file)); size += bytes.length;
    if (size > 128 * 1024 * 1024) throw Error('Candidate source manifest too large');
    hash.update(file + '\0' + bytes.length + '\0').update(bytes).update('\0');
  }
  return { sourceSha256: hash.digest('hex'), sourceManifestVersion: 'c3-source-manifest-v2', sourceFileCount: paths.length };
}
export function candidateIdentity(nonproduction, {root = fileURLToPath(new URL('.', import.meta.url)), env = process.env} = {}) {
  root = resolve(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'], timeout: 5000 }).trim();
  let head = null, tree = null, modified = null;
  try {
    // A parent repository must not masquerade as this exported app's identity.
    if (resolve(git('rev-parse','--show-toplevel')) !== root) throw Error('Not candidate git worktree');
    const h = git('rev-parse','HEAD'), t = git('rev-parse','HEAD^{tree}');
    if (!/^[a-f0-9]{40}$/.test(h) || !/^[a-f0-9]{40}$/.test(t)) throw Error('Invalid git identity');
    const dirty = Boolean(git('status','--porcelain'));
    head = h; tree = t; modified = dirty;
  } catch { /* Git/history/executable are optional in hosted build copies. */ }
  // Inspect only explicitly named, non-secret metadata. Lovable currently exposes
  // no documented attested HEAD/TREE contract. Plain env strings (even valid SHAs)
  // cannot establish provenance; neither GitHub nor user-supplied values are trusted.
  const metadataPresent = ['LOVABLE_COMMIT_SHA','LOVABLE_TREE_SHA','GITHUB_SHA','C3_BUILD_HEAD','C3_BUILD_TREE']
    .some(name => typeof env[name] === 'string' && env[name].length > 0);
  return Object.freeze({
    projectId: '4dbf593e-577e-4af4-a553-460441c34473',
    identitySource: head ? 'git' : 'source_fingerprint', head, tree, modified,
    buildEnvIdentity: null,
    buildEnvMetadataStatus: metadataPresent ? 'ignored_unverified_provenance' : 'unavailable',
    ...sourceFingerprint(root),
    buildProfile: nonproduction ? 'nonproduction' : 'production',
    sourceBackendRef: nonproduction ? nonproductionRef : productionRef,
    backendRuntimeVerified: false,
  });
}

export function renderCandidateIdentity(identity) {
  return identity.head && identity.tree
    ? `${identity.head} / ${identity.tree}${identity.modified ? ' / WORKTREE MODIFIED' : ''}`
    : `SOURCE SHA256 ${identity.sourceSha256} / GIT IDENTITY UNAVAILABLE`;
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
