import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

async function loadTs(file){
  const src=fs.readFileSync(file,'utf8');
  const out=ts.transpileModule(src,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022},reportDiagnostics:true});
  const errs=(out.diagnostics??[]).filter(d=>d.category===ts.DiagnosticCategory.Error);
  assert.equal(errs.length,0,`${file} syntax errors: ${errs.map(e=>String(e.messageText)).join('; ')}`);
  const tmp=path.join(os.tmpdir(),`task71-${path.basename(file)}-${process.pid}-${Date.now()}.mjs`);fs.writeFileSync(tmp,out.outputText);return {mod:await import(pathToFileURL(tmp).href),tmp};
}
const stateLoaded=await loadTs('supabase/functions/_shared/conversation-runtime-state.ts');
const state=stateLoaded.mod;
const history=[];
for(let i=20;i>=1;i--) history.push({role:'visitor',content:i===1?'什么是四電一腦？':i===8?'如果我不確定分類呢？':i===12?'Mars 的冷氣機回收費是多少？':i===14?'算了，不談 Mars，回香港的規則。':i===15?'我一開始問的是什麼？':`turn ${i}`});
let projected=state.projectConversationRuntimeState(history);
assert.equal(projected.first_customer_turn,'什么是四電一腦？');
assert.equal(projected.latest_customer_turn,'turn 20');
let q=state.buildCanonicalRetrievalQuery('我一開始問的是什麼？',history);
assert.equal(q.mode,'memory');
assert.match(q.query,/四電一腦/);
q=state.buildCanonicalRetrievalQuery('Mars 的冷氣機回收費是多少？',history);
assert.equal(q.mode,'standalone');
assert.equal(q.state.jurisdiction,'mars');
assert.doesNotMatch(q.query,/香港/);
q=state.buildCanonicalRetrievalQuery('那包括哪些種類？',[{role:'visitor',content:'那包括哪些種類？'},{role:'assistant',content:'之前答案'},{role:'visitor',content:'什么是四電一腦？'}]);
assert.equal(q.mode,'contextual');assert.match(q.query,/四電一腦/);
const block=state.buildCanonicalContinuityBlock([{role:'visitor',content:'我一開始問的是什麼？'},{role:'assistant',content:'建議你提供型號。'},{role:'visitor',content:'不要猜。'},{role:'visitor',content:'什么是四電一腦？'}]);
assert.match(block,/First customer turn: 什么是四電一腦/);assert.match(block,/Active customer constraints/);assert.match(block,/prior recommendations|assistant recommendations/i);
fs.unlinkSync(stateLoaded.tmp);

// canonical-grounding imports kb-client, so test source contract + extract a runtime-safe copy of selector logic by transpiling after replacing the type-only import and jurisdiction import.
const groundingSource=fs.readFileSync('supabase/functions/_shared/canonical-grounding.ts','utf8');
assert.match(groundingSource,/requirePublished/);assert.match(groundingSource,/jurisdiction_mismatch|unsupported_explicit_jurisdiction/);assert.match(groundingSource,/model_mismatch/);
const runnable=groundingSource.replace(/import type[^;]+;\n/,'').replace(/import \{ detectExplicitJurisdiction \} from[^;]+;\n/,'const detectExplicitJurisdiction=(t)=>/(mars|火星)/i.test(t)?"mars":/(香港|hong\\s*kong|\\bhk\\b)/i.test(t)?"hong_kong":null;\n');
const out=ts.transpileModule(runnable,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const tmp=path.join(os.tmpdir(),`task71-ground-${process.pid}.mjs`);fs.writeFileSync(tmp,out);const {selectCanonicalGrounding:select}=await import(pathToFileURL(tmp).href);fs.unlinkSync(tmp);
const doc=(id,score,text,j='香港',model='')=>({document_id:id,title:`${j} ${model}`,source_type:'FAQ',document_score:score,chunks:[{document_id:id,chunk_id:id+'-c',title:`${j}`,content:text,score:.9,chunk_type:'full_content',source_type:'FAQ',status:'published'}],citations:[],llm_context:{selected_document_id:id,orientation_summary:null,full_content_evidence:[{document_id:id,chunk_id:id+'-c',content:text,score:.9,source_type:'FAQ'}]},meta:{}});
let g=select([doc('hk',.9,'香港四電一腦回收安排')],{requestText:'Mars 的冷氣機回收費是多少？',requirePublished:true});assert.equal(g.ok,true);assert.equal(g.document,null);
g=select([doc('hk',.8,'香港四電一腦回收安排')],{requestText:'香港四電一腦回收安排',requirePublished:true});assert.equal(g.ok,true);assert.equal(g.document.document_id,'hk');
const bad=doc('bad',.99,'x');bad.llm_context.full_content_evidence[0].document_id='other';g=select([bad],{requestText:'x'});assert.deepEqual(g,{ok:false,error:'KB_DOCUMENT_EVIDENCE_MISMATCH'});
const draft=doc('draft',1,'香港四電一腦');draft.chunks[0].status='draft';g=select([draft],{requestText:'香港四電一腦',requirePublished:true});assert.equal(g.ok,true);assert.equal(g.document,null);

const generate=fs.readFileSync('supabase/functions/generate-reply/index.ts','utf8');
const assist=fs.readFileSync('supabase/functions/agent-assist/index.ts','utf8');
const proxy=fs.readFileSync('supabase/functions/kb-search-proxy/index.ts','utf8');
const ce=fs.readFileSync('supabase/functions/_shared/ce-grounding.ts','utf8');
assert.match(generate,/buildCanonicalRetrievalQuery/);assert.match(generate,/buildCanonicalContinuityBlock/);assert.match(generate,/selectCanonicalGrounding/);assert.doesNotMatch(generate,/selectGroundedDocument/);
assert.match(assist,/buildCanonicalAssistRetrievalQuery/);assert.match(assist,/selectCanonicalGrounding/);assert.doesNotMatch(assist,/selectAgentAssistGrounding\(/);
assert.match(proxy,/buildCanonicalRetrievalQuery/);assert.match(proxy,/MAX_CONTEXT_MESSAGES = 200/);
assert.match(ce,/selectCanonicalGrounding/);assert.doesNotMatch(ce,/result\.llm_context\?\.full_content_evidence/);
const registry=JSON.parse(fs.readFileSync('config/ai-chatbot-invariants.json','utf8'));assert.equal(registry.version,'2026-09-01-task7.1');assert.ok(registry.invariants.some(x=>x.id==='INV-KB-APPLICABILITY-01'));
console.log('TASK7_1_CANONICAL_RUNTIME_TESTS=PASS');
