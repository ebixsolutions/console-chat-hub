import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CUSTOMER_FACT_KB_RETENTION_IDS } from './customer-fact-kb-retention-register.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(here, '../..'));
const original = path.join(root, 'tests/emergency-p0/chain.test.mjs'), source = fs.readFileSync(original, 'utf8');
const digest = value => createHash('sha256').update(value).digest('hex'), baseline = digest(source);
const temporary = path.join(path.dirname(original), '.customer-fact-kb-retention-' + process.pid + '.test.mjs');
let child, rows = [];
try {
  const registration = pathToFileURL(path.join(here, 'customer-fact-kb-retention-register.mjs')).href;
  fs.writeFileSync(temporary, source + '\nimport {registerCustomerFactKbRetentionCases} from ' + JSON.stringify(registration) + ';\n' +
    'registerCustomerFactKbRetentionCases({test,assert,fixture,uuid,root});\n', { flag: 'wx', mode: 0o600 });
  child = spawnSync(process.execPath, ['--test', '--test-name-pattern=^CTX-KB-RETENTION ', temporary],
    { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env } });
  for (const line of ((child.stdout ?? '') + '\n' + (child.stderr ?? '')).split(/\r?\n/)) {
    const at = line.indexOf('CTX_KB_RETENTION_RESULT|');
    if (at >= 0) try { rows.push(JSON.parse(Buffer.from(line.slice(at + 'CTX_KB_RETENTION_RESULT|'.length).trim(), 'base64').toString('utf8'))); } catch {}
  }
} finally { try { fs.unlinkSync(temporary); } catch {} }
const unchanged = digest(fs.readFileSync(original, 'utf8')) === baseline;
const ids = rows.map(row => row.id), complete = ids.length === CUSTOMER_FACT_KB_RETENTION_IDS.length &&
  new Set(ids).size === ids.length && CUSTOMER_FACT_KB_RETENTION_IDS.every(id => ids.includes(id));
console.log('CTX_KB_RETENTION_SUMMARY|' + JSON.stringify({ expected_cases: CUSTOMER_FACT_KB_RETENTION_IDS.length,
  executed_cases: rows.length, passed: rows.filter(row => row.status === 'PASS').length,
  failed: rows.filter(row => row.status === 'FAIL').map(row => row.id), original_handler_suite_sha256: baseline,
  original_handler_suite_unchanged: unchanged, subprocess_exit: child?.status ?? null,
  subprocess_signal: child?.signal ?? null, real_model: 'NOT_RUN', real_kb: 'NOT_RUN', hosted: 'NOT_RUN' }));
for (const row of rows) console.log('CTX_KB_RETENTION_ROW|' + JSON.stringify(row));
if (!complete || !unchanged || child?.status !== 0 || rows.some(row => row.status !== 'PASS')) {
  if (child?.error) console.error(String(child.error));
  console.error(((child?.stdout ?? '') + '\n' + (child?.stderr ?? '')).slice(-12000));
  process.exitCode = 1;
}
