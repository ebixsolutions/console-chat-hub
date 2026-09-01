import fs from 'node:fs';

const read = (p) => fs.readFileSync(p, 'utf8');
const write = (p, s) => fs.writeFileSync(p, s);
const replaceOnce = (source, needle, replacement, label) => {
  const count = source.split(needle).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one marker, found ${count}`);
  return source.replace(needle, replacement);
};

// ---------------------------------------------------------------------------
// 1) Shared conversation-bound retrieval contract.
// ---------------------------------------------------------------------------
const ciPath = 'supabase/functions/_shared/conversation-intelligence.ts';
let ci = read(ciPath);
if (ci.includes('buildConversationAssistRetrievalQuery')) throw new Error('Task 6.1 conversation assist resolver already present');
const advisoryMarker = 'export interface CustomerAdvisorySignals {';
const assistFn = `export function buildConversationAssistRetrievalQuery(\n  assistanceInput: string,\n  newestFirstMessages: ConversationHistoryRow[],\n): ContextualRetrievalQuery {\n  const latest = cleanContinuityText(assistanceInput);\n  if (!latest) return { query: \"\", mode: \"standalone\", latest: \"\", context_turns: [] };\n\n  const customerTurns = newestFirstMessages\n    .filter((row) => CUSTOMER_ROLES.has(String(row.role ?? \"\").toLowerCase()))\n    .map((row) => cleanContinuityText(row.content))\n    .filter(Boolean);\n  if (customerTurns.length === 0) {\n    return { query: latest, mode: \"standalone\", latest, context_turns: [] };\n  }\n\n  // Agent-assist input can be a selected customer turn OR an agent draft. In\n  // both cases the authoritative topic comes from the same trusted conversation.\n  // Keep the projection bounded, customer-only and newest-correction aware.\n  const contextTurns = customerTurns\n    .filter((text) => !isRetrievalNoise(text))\n    .slice(0, 6);\n  if (contextTurns.length === 0) {\n    return { query: latest, mode: \"standalone\", latest, context_turns: [] };\n  }\n\n  const chronological = [...contextTurns].reverse();\n  const query = [\n    \"Assistance input: \" + latest,\n    \"Relevant customer conversation: \" + chronological.join(\" / \"),\n  ].join(\"\\n\").slice(0, 1200);\n\n  return { query, mode: \"contextual\", latest, context_turns: contextTurns };\n}\n\n`;
ci = replaceOnce(ci, advisoryMarker, assistFn + advisoryMarker, 'conversation-intelligence insert');
write(ciPath, ci);

// ---------------------------------------------------------------------------
// 2) Canonical winner-only/published-only KB document selector.
// ---------------------------------------------------------------------------
const groundingPath = 'supabase/functions/_shared/kb-grounding.ts';
if (fs.existsSync(groundingPath)) throw new Error('Task 6.1 kb-grounding already exists');
write(groundingPath, `export interface GroundingChunk {\n  document_id?: string;\n  doc_id?: string;\n  chunk_id?: string;\n  content: string;\n  score: number;\n  chunk_type: string;\n  source_type: string;\n  status?: string;\n}\nexport interface GroundingEvidence {\n  document_id: string;\n  chunk_id?: string;\n  content: string;\n  score: number;\n  source_type: string;\n}\nexport interface GroundingDocument {\n  document_id: string;\n  document_score: number;\n  chunks: GroundingChunk[];\n  llm_context: {\n    selected_document_id: string;\n    orientation_summary: string | null;\n    full_content_evidence: GroundingEvidence[];\n  };\n}\nexport type GroundedSelection =\n  | { ok: true; document: GroundingDocument | null; chunks: GroundingChunk[]; evidence: GroundingEvidence[] }\n  | { ok: false; error: \"KB_DOCUMENT_EVIDENCE_MISMATCH\" | \"KB_EVIDENCE_NOT_PUBLISHED\" };\n\nexport function selectGroundedDocument(\n  documents: GroundingDocument[],\n  options: { minScore?: number; policyOnly?: boolean; requirePublished?: boolean } = {},\n): GroundedSelection {\n  const minScore = Number.isFinite(options.minScore) ? Number(options.minScore) : 0;\n  const policyOnly = options.policyOnly === true;\n  const requirePublished = options.requirePublished !== false;\n  const eligible: Array<{ document: GroundingDocument; chunks: GroundingChunk[]; evidence: GroundingEvidence[]; evidenceScore: number }> = [];\n\n  for (const document of documents ?? []) {\n    if (document.llm_context.selected_document_id !== document.document_id) {\n      return { ok: false, error: \"KB_DOCUMENT_EVIDENCE_MISMATCH\" };\n    }\n    if ((document.llm_context.full_content_evidence ?? []).some((e) => e.document_id !== document.document_id)) {\n      return { ok: false, error: \"KB_DOCUMENT_EVIDENCE_MISMATCH\" };\n    }\n    if ((document.chunks ?? []).some((c) => (c.document_id ?? c.doc_id) !== document.document_id)) {\n      return { ok: false, error: \"KB_DOCUMENT_EVIDENCE_MISMATCH\" };\n    }\n\n    const chunks = (document.chunks ?? []).filter((c) =>\n      typeof c.content === \"string\" && c.content.trim() &&\n      typeof c.score === \"number\" && Number.isFinite(c.score) && c.score >= minScore &&\n      (!requirePublished || c.status === \"published\") &&\n      (!policyOnly || c.source_type.toLowerCase().includes(\"policy\"))\n    );\n    const fullIds = new Set(chunks.filter((c) => c.chunk_type === \"full_content\").map((c) => c.chunk_id ?? c.content));\n    const evidence = (document.llm_context.full_content_evidence ?? []).filter((e) =>\n      e.document_id === document.document_id &&\n      typeof e.content === \"string\" && e.content.trim() &&\n      typeof e.score === \"number\" && Number.isFinite(e.score) && e.score >= minScore &&\n      (!policyOnly || e.source_type.toLowerCase().includes(\"policy\")) &&\n      fullIds.has(e.chunk_id ?? e.content)\n    );\n\n    if (requirePublished && evidence.length > 0 && chunks.every((c) => c.status !== \"published\")) {\n      return { ok: false, error: \"KB_EVIDENCE_NOT_PUBLISHED\" };\n    }\n    if (!evidence.length) continue;\n    eligible.push({\n      document, chunks, evidence,\n      evidenceScore: Math.max(...evidence.map((e) => e.score), 0),\n    });\n  }\n\n  eligible.sort((a, b) =>\n    b.document.document_score - a.document.document_score ||\n    b.evidenceScore - a.evidenceScore ||\n    a.document.document_id.localeCompare(b.document.document_id)\n  );\n  const winner = eligible[0];\n  return winner\n    ? { ok: true, document: winner.document, chunks: winner.chunks, evidence: winner.evidence }\n    : { ok: true, document: null, chunks: [], evidence: [] };\n}\n`);

// ---------------------------------------------------------------------------
// 3) Customer generate-reply: contextual query already exists; enforce one
//    deterministic published document before any evidence reaches the LLM.
// ---------------------------------------------------------------------------
const grPath = 'supabase/functions/generate-reply/index.ts';
let gr = read(grPath);
const grImport = 'import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildContextualRetrievalQuery, buildConversationContinuityBlock, buildCustomerAdvisoryContext, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";\n';
gr = replaceOnce(gr, grImport, grImport + 'import { selectGroundedDocument } from "../_shared/kb-grounding.ts";\n', 'generate-reply grounding import');
const oldUsable = `    const usableChunks = ragResult.chunks.filter(\n      (c) => c.score && c.score >= minScore && (!c.status || c.status === \"published\"),\n    );`;
const newUsable = `    const _groundingSelection = selectGroundedDocument(ragResult.documents ?? [], {\n      minScore,\n      requirePublished: true,\n    });\n    const usableChunks = _groundingSelection.ok ? _groundingSelection.chunks : [];`;
gr = replaceOnce(gr, oldUsable, newUsable, 'generate-reply flattened grounding');
write(grPath, gr);

// ---------------------------------------------------------------------------
// 4) Agent Assist: server-derived conversation context for conversation-bound
//    Knowledge/Suggest/Policy tools. Manual custom mode remains explicit.
// ---------------------------------------------------------------------------
const aaPath = 'supabase/functions/agent-assist/index.ts';
let aa = read(aaPath);
const aaImport = 'import { selectAgentAssistGrounding } from "../_shared/agent-assist-grounding.ts";\n';
aa = replaceOnce(aa, aaImport, aaImport + 'import { buildConversationAssistRetrievalQuery } from "../_shared/conversation-intelligence.ts";\n', 'agent-assist context import');
aa = replaceOnce(aa, 'suggest_reply: new Set(["tool_type", "conversation_id", "content"]),', 'suggest_reply: new Set(["tool_type", "conversation_id", "content", "context_mode"]),', 'suggest context field');
aa = replaceOnce(aa, 'knowledge_helper: new Set(["tool_type", "conversation_id", "content"]),', 'knowledge_helper: new Set(["tool_type", "conversation_id", "content", "context_mode"]),', 'knowledge context field');
aa = replaceOnce(aa, 'check_policy: new Set(["tool_type", "conversation_id", "content"]),', 'check_policy: new Set(["tool_type", "conversation_id", "content", "context_mode"]),', 'policy context field');
const parseMarker = 'function parseJson(raw:string):Record<string,unknown>|null{return parseJsonObject(raw);}\n';
const historyHelper = `async function loadAssistConversationHistory(supabaseAdmin:any,conversationId:string){\n  const {data,error}=await supabaseAdmin.from(\"messages\").select(\"role, content, metadata, created_at\").eq(\"conversation_id\",conversationId).eq(\"is_recalled\",false).neq(\"content\",\"__THINKING__\").order(\"created_at\",{ascending:false}).limit(20);\n  if(error)return null;\n  return (data??[]).filter((row:any)=>typeof row?.content===\"string\"&&row.content.trim());\n}\n`;
aa = replaceOnce(aa, parseMarker, parseMarker + historyHelper, 'agent-assist history helper');
const oldFetch = '  const kb=await fetchKBRag({query:content.slice(0,500),top_k:3},tenant.scope,endpoint);if(!kb.success)return jsonRes({success:false,error:`${kbPrefix}_kb_unavailable`},kb.error_code==="KB_TIMEOUT"?504:502,req);';
const newFetch = `  const contextMode=body.context_mode===\"manual\"?\"manual\":\"conversation\";\n  let retrievalQuery=content.slice(0,500);\n  if(contextMode===\"conversation\"){const history=await loadAssistConversationHistory(supabaseAdmin,conversationId);if(history===null)return jsonRes({success:false,error:\`${'${kbPrefix}'}_conversation_context_unavailable\`},500,req);retrievalQuery=buildConversationAssistRetrievalQuery(content,history).query.slice(0,500);}\n  const kb=await fetchKBRag({query:retrievalQuery,top_k:3},tenant.scope,endpoint);if(!kb.success)return jsonRes({success:false,error:\`${'${kbPrefix}'}_kb_unavailable\`},kb.error_code===\"KB_TIMEOUT\"?504:502,req);`;
aa = replaceOnce(aa, oldFetch, newFetch, 'agent-assist contextual fetch');
write(aaPath, aa);

// ---------------------------------------------------------------------------
// 5) kb-search-proxy: replace its independent context heuristic with the same
//    canonical server-side resolver. Manual search stays manual.
// ---------------------------------------------------------------------------
const kpPath = 'supabase/functions/kb-search-proxy/index.ts';
let kp = read(kpPath);
const kpImport = 'import { supabaseCorsHeaders } from "../_shared/supabase-cors.ts";\n';
kp = replaceOnce(kp, kpImport, kpImport + 'import { buildContextualRetrievalQuery } from "../_shared/conversation-intelligence.ts";\n', 'proxy context import');
const oldBuilderStart = 'function buildTrustedRetrievalQuery(\n  clientQuery: string,\n  turns: VisitorTurn[],\n): { query: string; currentRequest: string; mode: "auto_context" | "manual" } {';
const start = kp.indexOf(oldBuilderStart);
const end = kp.indexOf('\nfunction parseTenantMap()', start);
if (start < 0 || end < 0) throw new Error('proxy trusted retrieval builder block missing');
const newBuilder = `function buildTrustedRetrievalQuery(\n  clientQuery: string,\n  turns: VisitorTurn[],\n  forceAutoContext = false,\n): { query: string; currentRequest: string; mode: \"auto_context\" | \"manual\" } {\n  if (turns.length === 0) return { query: clientQuery, currentRequest: clientQuery, mode: \"manual\" };\n  const latest = turns[turns.length - 1].content.trim();\n  const joined = turns.map((t) => t.content.trim()).join(CONTEXT_SEPARATOR);\n  const q = normalizeComparable(clientQuery);\n  const isAuto = forceAutoContext || q === normalizeComparable(latest) || q === normalizeComparable(joined.slice(0, MAX_QUERY_LENGTH));\n  if (!isAuto) return { query: clientQuery, currentRequest: clientQuery, mode: \"manual\" };\n  const newestFirst = [...turns].reverse().map((t) => ({ role: \"visitor\", content: t.content }));\n  const semantic = buildContextualRetrievalQuery(latest, newestFirst);\n  return { query: semantic.query.slice(0, MAX_QUERY_LENGTH), currentRequest: latest, mode: \"auto_context\" };\n}\n`;
kp = kp.slice(0, start) + newBuilder + kp.slice(end);
const derivedOld = '    const derived = buildTrustedRetrievalQuery(query, recentTurns);';
const derivedNew = '    const queryMode = body?.query_mode === "auto_context" ? "auto_context" : "manual";\n    const derived = buildTrustedRetrievalQuery(query, recentTurns, queryMode === "auto_context");';
kp = replaceOnce(kp, derivedOld, derivedNew, 'proxy query mode');
write(kpPath, kp);

// ---------------------------------------------------------------------------
// 6) Console surfaces declare intent: automatic conversation lookups are
//    server-contextual; explicit typed searches remain manual.
// ---------------------------------------------------------------------------
const crmPath = 'src/components/console/CRMPanel.tsx';
let crm = read(crmPath);
crm = replaceOnce(crm, 'async (query: string, reqId: number) => {', 'async (query: string, reqId: number, queryMode: "manual" | "auto_context" = "manual") => {', 'CRM runKbSearch signature');
crm = replaceOnce(crm, 'body: { query: query.trim().slice(0, 500), top_k: 3, conversation_id: conv?.id },', 'body: { query: query.trim().slice(0, 500), top_k: 3, conversation_id: conv?.id, query_mode: queryMode },', 'CRM KB body mode');
crm = replaceOnce(crm, 'void runKbSearch(autoQuery, ++kbReqIdRef.current);', 'void runKbSearch(autoQuery, ++kbReqIdRef.current, "auto_context");', 'CRM auto search mode');
crm = replaceOnce(crm, 'if (q) void runKbSearch(q, ++kbReqIdRef.current);', 'if (q) void runKbSearch(q, ++kbReqIdRef.current, kbQuery.trim() ? "manual" : "auto_context");', 'CRM refresh mode');
crm = replaceOnce(crm, 'content: content.trim().slice(0, 2000),\n        },', 'content: content.trim().slice(0, 2000),\n          context_mode: "conversation",\n        },', 'CRM policy context mode');
write(crmPath, crm);

const atpPath = 'src/components/console/AgentToolPanel.tsx';
let atp = read(atpPath);
const invokeOld = '        body: { tool_type: tt, conversation_id: conversationId, content: ac, ...extra },';
const invokeNew = '        body: { tool_type: tt, conversation_id: conversationId, content: ac, ...((["suggest_reply", "knowledge_helper", "check_policy"].includes(tt)) ? { context_mode: cs === "custom" ? "manual" : "conversation" } : {}), ...extra },';
atp = replaceOnce(atp, invokeOld, invokeNew, 'AgentToolPanel context mode');
write(atpPath, atp);

console.log('TASK6_1_APPLY=PASS');
