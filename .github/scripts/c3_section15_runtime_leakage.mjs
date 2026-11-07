import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Implements the original Section15.10 assertion. It changes no runtime or contract.
const root = path.resolve(process.argv[2] ?? process.cwd());
const ts = createRequire(path.join(root,'package.json'))('typescript');
const { runtimeDependencyClosure } = await import(pathToFileURL(path.join(root, '.github/scripts/c3_module_graph.mjs')));
const entrypoints = ['generate-reply','agent-assist','kb-search-proxy','customer360-coach-sync','model-attempt-accounting','take-over-conversation','agent-send-reply','return-to-ai','receive-widget-message','widget-poll-messages']
  .map(name => `supabase/functions/${name}/index.ts`);
const files = runtimeDependencyClosure({ root, entrypoints });
const rules = [
  ['historical_demo_sku', /CW-SUL70BA/iu],
  ['demo_room_structure', /two_bedrooms_and_living_room/u],
  ['appliance_topic_architecture', /PRODUCT_TOPIC_PATTERNS/u],
  ['demo_refrigerator_measurement', /595\s*(?:mm|毫米)/iu],
  ['demo_room_measurement', /(?:80|100|110|180)\s*(?:sq[ .-]*ft|square\s*feet|平方呎)/iu],
  ['demo_merchant_price', /HK\$\s*4,?000/u],
];
// No domain rule is allowlisted. Control greetings/handoff/queue/unknown-fact
// notices are permitted by original 15.2 and do not match these domain rules.
const findings = [];
const hashes = {};
for (const file of files) {
  const source = fs.readFileSync(path.join(root,file),'utf8');
  hashes[file] = crypto.createHash('sha256').update(source).digest('hex');
  const ast = ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const visit = node => {
    // Inspect executable identifiers, strings and regexes, not examples in comments.
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node)) {
      for (const [rule,pattern] of rules) if (pattern.test(node.getText(ast))) {
        findings.push({file,line:ast.getLineAndCharacterOfPosition(node.getStart(ast)).line+1,rule});
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(ast);
}
const result = { assertion:'original Section15.10', source_only:true, hosted_pass:false,
  scope:'complete executable local dependency closure of Phase-1 callers',
  runtime_file_count:files.length, runtime_hashes:hashes, control_allowlist:'15.2 control notices only; no domain exceptions',
  findings, result:findings.length ? 'FAIL':'PASS' };
const output = process.argv[3];
if (output) fs.writeFileSync(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({assertion:result.assertion, runtime_file_count:files.length, findings, result:result.result}));
process.exitCode = findings.length ? 1:0;
