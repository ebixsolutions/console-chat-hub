import fs from 'node:fs';

const write=(p,c)=>{fs.mkdirSync(p.split('/').slice(0,-1).join('/'),{recursive:true});fs.writeFileSync(p,c);};
const must=(cond,msg)=>{if(!cond)throw new Error(msg);};
const statePath='supabase/functions/_shared/conversation-runtime-state.ts';
const groundingPath='supabase/functions/_shared/canonical-grounding.ts';
const generatePath='supabase/functions/generate-reply/index.ts';
const assistPath='supabase/functions/agent-assist/index.ts';
const proxyPath='supabase/functions/kb-search-proxy/index.ts';
const cePath='supabase/functions/_shared/ce-grounding.ts';

must(!fs.existsSync(statePath),'conversation-runtime-state already exists');
must(!fs.existsSync(groundingPath),'canonical-grounding already exists');
write(statePath,fs.readFileSync('scripts/task7-1/conversation-runtime-state.ts.template','utf8'));
write(groundingPath,fs.readFileSync('scripts/task7-1/canonical-grounding.ts.template','utf8'));

let generate=fs.readFileSync(generatePath,'utf8');
must(generate.includes('buildContextualRetrievalQuery'),'generate contextual baseline missing');
must(generate.includes('selectGroundedDocument'),'generate grounding baseline missing');
generate=generate.replace(
  'import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildContextualRetrievalQuery, buildConversationContinuityBlock, buildCustomerAdvisoryContext, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";',
  'import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildCustomerAdvisoryContext, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";\nimport { buildCanonicalRetrievalQuery, buildCanonicalContinuityBlock } from "../_shared/conversation-runtime-state.ts";'
);
generate=generate.replace('import { selectGroundedDocument } from "../_shared/kb-grounding.ts";','import { selectCanonicalGrounding } from "../_shared/canonical-grounding.ts";');
generate=generate.replaceAll('buildConversationContinuityBlock(','buildCanonicalContinuityBlock(');
generate=generate.replaceAll('buildContextualRetrievalQuery(','buildCanonicalRetrievalQuery(');
generate=generate.replaceAll('selectGroundedDocument(','selectCanonicalGrounding(');
const groundCall=/const _groundingSelection = selectCanonicalGrounding\(ragResult\.documents \?\? \[\], \{\s*minScore,\s*requirePublished: true,\s*\}\);/m;
must(groundCall.test(generate),'generate canonical grounding call marker missing');
generate=generate.replace(groundCall,'const _groundingSelection = selectCanonicalGrounding(ragResult.documents ?? [], {\n      minScore,\n      requirePublished: true,\n      requestText: userQuery,\n    });');
write(generatePath,generate);

let assist=fs.readFileSync(assistPath,'utf8');
must(assist.includes('selectAgentAssistGrounding'),'agent assist grounding baseline missing');
assist=assist.replace('import { selectAgentAssistGrounding } from "../_shared/agent-assist-grounding.ts";','import { selectCanonicalGrounding } from "../_shared/canonical-grounding.ts";');
assist=assist.replace('import { buildConversationAssistRetrievalQuery } from "../_shared/conversation-intelligence.ts";','import { buildCanonicalAssistRetrievalQuery } from "../_shared/conversation-runtime-state.ts";');
assist=assist.replace('.order("created_at",{ascending:false}).limit(20);','.order("created_at",{ascending:false}).limit(200);');
assist=assist.replace('buildConversationAssistRetrievalQuery(content,history)','buildCanonicalAssistRetrievalQuery(content,history)');
assist=assist.replace('selectAgentAssistGrounding(kb.documents,{policyOnly:true})','selectCanonicalGrounding(kb.documents,{policyOnly:true,requestText:retrievalQuery,requirePublished:true})');
assist=assist.replace('selectAgentAssistGrounding(kb.documents)','selectCanonicalGrounding(kb.documents,{requestText:retrievalQuery,requirePublished:true})');
write(assistPath,assist);

let proxy=fs.readFileSync(proxyPath,'utf8');
must(proxy.includes('buildContextualRetrievalQuery'),'proxy contextual baseline missing');
proxy=proxy.replace('import { buildContextualRetrievalQuery } from "../_shared/conversation-intelligence.ts";','import { buildCanonicalRetrievalQuery } from "../_shared/conversation-runtime-state.ts";');
proxy=proxy.replace('const MAX_CONTEXT_MESSAGES = 5;','const MAX_CONTEXT_MESSAGES = 200;');
proxy=proxy.replace('buildContextualRetrievalQuery(latest, newestFirst)','buildCanonicalRetrievalQuery(latest, newestFirst)');
write(proxyPath,proxy);

let ce=fs.readFileSync(cePath,'utf8');
must(ce.includes('function evidenceRows(result: KBRagResponse)'), 'CE evidenceRows baseline missing');
ce=ce.replace('} from "./kb-client.ts";','} from "./kb-client.ts";\nimport { selectCanonicalGrounding } from "./canonical-grounding.ts";');
const start=ce.indexOf('function evidenceRows(result: KBRagResponse)');
const end=ce.indexOf('function mergeEvidence(',start);
must(start>=0&&end>start,'CE evidence block boundaries missing');
const replacement=`function evidenceRows(result: KBRagResponse, requestText: string, policyOnly = false): Array<Record<string, unknown>> {\n  const selected = selectCanonicalGrounding(result.documents ?? [], { requestText, policyOnly, requirePublished: true });\n  if (!selected.ok || !selected.document) return [];\n  return selected.evidence.map((item) => {\n    const matching = selected.chunks.find((c: KBFullChunk) => c.chunk_type === "full_content" && c.document_id === item.document_id && (!item.chunk_id || c.chunk_id === item.chunk_id));\n    return { chunk_id:item.chunk_id ?? matching?.chunk_id ?? "", document_id:selected.document.document_id, document_title:matching?.title ?? selected.document.title ?? "KB document", citation_label:matching?.title ?? selected.document.title ?? "KB document", source_type:item.source_type || matching?.source_type || "unknown", source_scope:policyOnly ? "policy" : "customer_answer", score:item.score, version:null, last_updated_at:null, freshness_status:"fresh", content:item.content };\n  });\n}\n\n`;
ce=ce.slice(0,start)+replacement+ce.slice(end);
ce=ce.replace('let evidence = evidenceRows(primary.result);\n  let selectedDocumentIds = resultDocumentIds(primary.result);','let evidence = evidenceRows(primary.result, query);\n  let selectedDocumentIds = [...new Set(evidence.map((row) => String(row.document_id ?? "")).filter(Boolean))];');
ce=ce.replace('evidence = mergeEvidence(evidence, evidenceRows(secondary.result));\n    selectedDocumentIds.push(...resultDocumentIds(secondary.result));','const policyEvidence = evidenceRows(secondary.result, policyQuery, true);\n    evidence = mergeEvidence(evidence, policyEvidence);\n    selectedDocumentIds.push(...policyEvidence.map((row) => String(row.document_id ?? "")).filter(Boolean));');
write(cePath,ce);

console.log('TASK7_1_APPLY=PASS');
