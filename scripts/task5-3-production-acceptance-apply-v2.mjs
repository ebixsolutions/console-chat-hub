import fs from 'node:fs';

const backendPath = 'supabase/functions/agent-assist/index.ts';
const helperPath = 'supabase/functions/_shared/agent-assist-grounding.ts';
const uiPath = 'src/components/console/AgentToolPanel.tsx';
let backend = fs.readFileSync(backendPath, 'utf8');
let ui = fs.readFileSync(uiPath, 'utf8');

if (backend.includes('selectAgentAssistGrounding')) throw new Error('backend already applied');
if (ui.includes('suggestResult')) throw new Error('ui already applied');

fs.writeFileSync(helperPath, `export interface AgentAssistEvidence {
  document_id: string;
  chunk_id?: string;
  content: string;
  score: number;
  source_type: string;
}
export interface AgentAssistDocument {
  document_id: string;
  document_score: number;
  llm_context: {
    selected_document_id: string;
    orientation_summary: string | null;
    full_content_evidence: AgentAssistEvidence[];
  };
}
export type GroundingSelection =
  | { ok: true; document: AgentAssistDocument | null; evidence: AgentAssistEvidence[] }
  | { ok: false; error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
function usableEvidence(document: AgentAssistDocument, policyOnly: boolean): AgentAssistEvidence[] | null {
  if (document.llm_context.selected_document_id !== document.document_id) return null;
  const evidence = document.llm_context.full_content_evidence ?? [];
  if (evidence.some((item) => item.document_id !== document.document_id)) return null;
  return evidence.filter((item) => Boolean(item.content?.trim()) && (!policyOnly || item.source_type.toLowerCase().includes("policy")));
}
export function selectAgentAssistGrounding(
  documents: AgentAssistDocument[],
  options: { policyOnly?: boolean } = {},
): GroundingSelection {
  const eligible: Array<{ document: AgentAssistDocument; evidence: AgentAssistEvidence[]; evidenceScore: number }> = [];
  for (const document of documents ?? []) {
    const evidence = usableEvidence(document, options.policyOnly === true);
    if (evidence === null) return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    if (!evidence.length) continue;
    eligible.push({ document, evidence, evidenceScore: Math.max(...evidence.map((e) => Number.isFinite(e.score) ? e.score : 0), 0) });
  }
  eligible.sort((a, b) => b.document.document_score - a.document.document_score || b.evidenceScore - a.evidenceScore || a.document.document_id.localeCompare(b.document.document_id));
  const winner = eligible[0];
  return winner ? { ok: true, document: winner.document, evidence: winner.evidence } : { ok: true, document: null, evidence: [] };
}
`);

const routerImport = 'import { callModel, parseJsonObject } from "../_shared/llm-router.ts";\n';
if (!backend.includes(routerImport)) throw new Error('router import baseline missing');
backend = backend.replace(routerImport, routerImport + 'import { selectAgentAssistGrounding } from "../_shared/agent-assist-grounding.ts";\n');
backend = backend.replace('const CLAUDE_TIMEOUT_MS = 15000;\n', '');

const startMarker = '  const kb=await fetchKBRag({query:content.slice(0,500),top_k:3},tenant.scope,endpoint);';
const endMarker = '  const block=policy.map((p,n)=>';
const start = backend.indexOf(startMarker);
const end = backend.indexOf(endMarker);
if (start < 0 || end < 0 || end <= start) throw new Error('KB block markers missing');
const replacement = `  const kb=await fetchKBRag({query:content.slice(0,500),top_k:3},tenant.scope,endpoint);if(!kb.success)return jsonRes({success:false,error:\`${'${kbPrefix}'}_kb_unavailable\`},kb.error_code==="KB_TIMEOUT"?504:502,req);
  const groundingSelection=selectAgentAssistGrounding(kb.documents);if(!groundingSelection.ok)return jsonRes({success:false,error:\`${'${kbPrefix}'}_kb_contract_mismatch\`},502,req);
  if(toolType==="knowledge_helper"){const selected=groundingSelection.document,evidence=groundingSelection.evidence.slice(0,3);if(!selected||!evidence.length)return jsonRes({success:true,tool_type:"knowledge_helper",knowledge_grounded:true,scope_mode:tenant.scope.mode,selected_document_id:null,result:{status:"insufficient_evidence",orientation_summary:"",evidence:[]}},200,req);return jsonRes({success:true,tool_type:"knowledge_helper",knowledge_grounded:true,scope_mode:tenant.scope.mode,selected_document_id:selected.document_id,result:{status:"available",orientation_summary:selected.llm_context.orientation_summary?.slice(0,800)??"",evidence:evidence.map((i,n)=>({label:\`Evidence ${'${n+1}'}\`,source_type:i.source_type,chunk_type:"full_content",content:i.content.slice(0,1200)}))}},200,req);}
  if(toolType==="suggest_reply"){const selected=groundingSelection.document,evidence=groundingSelection.evidence.slice(0,3);if(!selected||!evidence.length)return jsonRes({success:false,error:"suggest_insufficient_evidence"},422,req);const grounding=[selected.llm_context.orientation_summary?\`Orientation Summary (context only):\\n${'${selected.llm_context.orientation_summary.slice(0,1200)}'}\`:"",\`Full Content Evidence:\\n${'${evidence.map((i,n)=>`[Evidence ${n+1}]\\n${i.content.slice(0,1200)}`).join("\\n\\n")}'}\`].filter(Boolean).join("\\n\\n");const r=await callAssistModel('Generate up to 3 customer-service reply drafts with different tones. Ground factual claims ONLY in Full Content Evidence. Return ONLY JSON: {"suggestions":[{"content":"...","tone_label":"Empathetic|Informative|Neutral"}]}',\`Customer message:\\n${'${content}'}\\n\\nKnowledge Base grounding:\\n${'${grounding}'}\`,{companyId:scope.companyId,conversationId,toolType:"suggest_reply"});if(!r.ok||!r.text)return jsonRes({success:false,error:"suggest_failed"},502,req);const p=parseJson(r.text);if(!Array.isArray(p?.suggestions))return jsonRes({success:false,error:"suggest_parse_failed"},502,req);const safe=(p!.suggestions as any[]).filter(s=>typeof s?.content==="string"&&s.content.trim()&&VALID_SUG_TONES.has(String(s.tone_label))).slice(0,3).map(s=>({content:String(s.content).slice(0,1000),tone_label:String(s.tone_label)}));if(!safe.length)return jsonRes({success:false,error:"suggest_parse_failed"},502,req);return jsonRes({success:true,tool_type:"suggest_reply",draft_only:true,knowledge_grounded:true,scope_mode:tenant.scope.mode,selected_document_id:selected.document_id,result:{suggestions:safe}},200,req);}
  const policySelection=selectAgentAssistGrounding(kb.documents,{policyOnly:true});if(!policySelection.ok)return jsonRes({success:false,error:"policy_kb_contract_mismatch"},502,req);const selectedPolicy=policySelection.document,policy=policySelection.evidence.slice(0,MAX_POLICY_EVIDENCE);if(!selectedPolicy||!policy.length)return jsonRes({success:true,tool_type:"check_policy",knowledge_grounded:true,scope_mode:tenant.scope.mode,selected_document_id:null,result:{status:"insufficient_evidence",summary:"No matching full-content policy evidence found. Cannot assess compliance.",issues:[]}},200,req);
`;
backend = backend.slice(0, start) + replacement + backend.slice(end);
const oldFinal = 'selected_document_id:kb.llm_context?.selected_document_id??null,result:{status:p.status';
if (!backend.includes(oldFinal)) throw new Error('policy final baseline missing');
backend = backend.replace(oldFinal, 'selected_document_id:selectedPolicy.document_id,result:{status:p.status');
fs.writeFileSync(backendPath, backend);

for (const [needle, insert] of [
  ['  grammar: { en: "Grammar", zh: "文法" },\n', '  grammar: { en: "Grammar", zh: "文法" },\n  suggestReply: { en: "Suggest Reply", zh: "建議回覆" },\n'],
  ['  gramResult: { en: "Grammar Check", zh: "文法檢查" },\n', '  gramResult: { en: "Grammar Check", zh: "文法檢查" },\n  suggestResult: { en: "Suggested Replies", zh: "建議回覆" },\n'],
  ['    { k: "grammar", l: tc("grammar"), i: "✏️", a: () => runTool("grammar") },\n', '    { k: "grammar", l: tc("grammar"), i: "✏️", a: () => runTool("grammar") },\n    { k: "suggest_reply", l: tc("suggestReply"), i: "💬", a: () => runTool("suggest_reply") },\n'],
]) {
  if (!ui.includes(needle)) throw new Error('UI baseline marker missing');
  ui = ui.replace(needle, insert);
}
const renderMarker = '        {tr?.type === "knowledge_helper" && (\n';
if (!ui.includes(renderMarker)) throw new Error('UI render marker missing');
ui = ui.replace(renderMarker, `        {tr?.type === "suggest_reply" && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "#7c3aed", marginBottom: 4 }}>{tc("suggestResult")}</div>
            {Array.isArray(tr.data.suggestions) && (tr.data.suggestions as Array<{ content: string; tone_label: string }>).map((s, i) => (
              <div key={i} style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 5, padding: 6, marginBottom: 5 }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, color: "#7c3aed", marginBottom: 3 }}>{s.tone_label}</div>
                <div style={{ fontSize: 10.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{s.content}</div>
                <button onClick={() => onUseDraft(s.content)} style={{ marginTop: 4, fontSize: 10.5, padding: "3px 9px", borderRadius: 4, border: "1px solid #7c3aed", background: "#faf5ff", color: "#7c3aed", cursor: "pointer", fontWeight: 600 }}>{tc("useInDraft")}</button>
              </div>
            ))}
          </div>
        )}
` + renderMarker);
fs.writeFileSync(uiPath, ui);
console.log('TASK5_3_APPLY=PASS');
