import fs from 'node:fs';

const write = (p,c) => { fs.mkdirSync(p.split('/').slice(0,-1).join('/'),{recursive:true}); fs.writeFileSync(p,c); };
const must = (cond,msg) => { if(!cond) throw new Error(msg); };

const statePath='supabase/functions/_shared/conversation-runtime-state.ts';
const groundingPath='supabase/functions/_shared/canonical-grounding.ts';
const generatePath='supabase/functions/generate-reply/index.ts';
const assistPath='supabase/functions/agent-assist/index.ts';
const proxyPath='supabase/functions/kb-search-proxy/index.ts';
const cePath='supabase/functions/_shared/ce-grounding.ts';

must(!fs.existsSync(statePath),'conversation-runtime-state already exists');
must(!fs.existsSync(groundingPath),'canonical-grounding already exists');

write(statePath, String.raw`export type RuntimeHistoryRow = { role?: string; content?: string | null; created_at?: string | null; metadata?: unknown };
export type RuntimeLanguage = "zh-TW" | "zh-CN" | "en";
export interface ConversationRuntimeState {
  first_customer_turn: string | null;
  first_intent: string | null;
  latest_customer_turn: string | null;
  current_intent: string | null;
  current_topic: string | null;
  prior_topics: string[];
  active_referents: string[];
  unresolved_questions: string[];
  latest_corrections: string[];
  active_constraints: string[];
  jurisdiction: string | null;
  language: RuntimeLanguage;
  prior_recommendations: string[];
}
export interface CanonicalRetrievalQuery { query:string; mode:"standalone"|"contextual"|"memory"; latest:string; context_turns:string[]; state:ConversationRuntimeState }
const CUSTOMER=new Set(["visitor","customer","user"]); const ASSISTANT=new Set(["assistant","ai","human_agent"]);
const CORRECTION=/(我講錯|我说错|我說錯|更正|其實係|其实是|唔係.*係|不是.*是|改返|改成|actually|i meant|correction|not .* but )/i;
const CONSTRAINT=/(不要|唔好|不准|唔准|不要猜|唔好估|沒有型號|没有型号|冇型號|only|don't|do not|without|must not|no model)/i;
const FOLLOW=/^(?:咁|那|那麼|那么|所以|另外|仲有|还有|如果|再|又|而|同埋|what about|and what about|then|so|also|in that case|how about)/i;
const PRONOUN=/(這個|这个|那個|那个|它|其|上述|剛才|刚才|之前|頭先|头先|same|that|this|it|its|earlier|previous)/i;
const MEMORY=/(一開始|一开始|第一個問題|第一个问题|最初|剛才建議|刚才建议|之前建議|之前建议|first question|first thing|what did i ask|what did you suggest|earlier recommendation)/i;
const QUESTION=/[?？]|^(?:什麼|什么|如何|怎樣|怎样|哪|哪些|多久|幾耐|几耐|why|what|which|how|when|where)/i;
const RECOMMEND=/(建議|建议|需要我提供|請提供|请提供|可以提供|recommend|suggest|provide)/i;
const JURISDICTIONS=[
  ["mars",/(mars|火星)/i],["hong_kong",/(香港|hong\s*kong|\bhk\b)/i],["macau",/(澳門|澳门|macau|macao)/i],
  ["singapore",/(新加坡|singapore)/i],["taiwan",/(台灣|台湾|taiwan)/i],["mainland_china",/(中國大陸|中国大陆|內地|内地|mainland\s*china)/i]
] as const;
function clean(v:unknown){return typeof v==="string"?v.replace(/\s+/g," ").trim().slice(0,800):""}
function language(t:string):RuntimeLanguage{if(!/[\u4e00-\u9fff]/.test(t))return"en";return /[转们为这没请台]/.test(t)?"zh-CN":"zh-TW"}
export function detectExplicitJurisdiction(t:string):string|null{for(const [id,re] of JURISDICTIONS)if(re.test(t))return id;return null}
function topic(t:string){return clean(t).replace(/[?？!！。,.，]/g," ").replace(/^(?:咁|那|所以|另外|再|又|what about|then|so)\s*/i,"").trim().slice(0,180)}
export function projectConversationRuntimeState(newestFirst:RuntimeHistoryRow[]):ConversationRuntimeState{
 const rows=newestFirst.map((r,i)=>({r,i,text:clean(r.content),role:String(r.role??"").toLowerCase()})).filter(x=>x.text&&x.text!=="__THINKING__");
 const customers=rows.filter(x=>CUSTOMER.has(x.role)); const assistants=rows.filter(x=>ASSISTANT.has(x.role)); const chronological=[...customers].reverse();
 const latest=customers[0]?.text??null, first=chronological[0]?.text??null;
 const corrections=customers.filter(x=>CORRECTION.test(x.text)).slice(0,6).map(x=>x.text);
 const constraints=customers.filter(x=>CONSTRAINT.test(x.text)).slice(0,8).map(x=>x.text);
 const unresolved=customers.filter(x=>QUESTION.test(x.text)).slice(0,8).map(x=>x.text);
 const explicitJ=latest?detectExplicitJurisdiction(latest):null;
 const inheritedJ=customers.map(x=>detectExplicitJurisdiction(x.text)).find(Boolean)??null;
 const topics=[]; for(const x of chronological){const p=topic(x.text);if(p&&!topics.includes(p))topics.push(p);}
 const current=latest?topic(latest):null;
 const refs=latest?[...latest.matchAll(/(這個|这个|那個|那个|它|其|上述|剛才|刚才|之前|same|that|this|it|its)/gi)].map(m=>m[0]).slice(0,6):[];
 return {first_customer_turn:first,first_intent:first?topic(first):null,latest_customer_turn:latest,current_intent:latest,current_topic:current,prior_topics:topics.slice(-12,-1),active_referents:refs,unresolved_questions:unresolved,latest_corrections:corrections,active_constraints:constraints,jurisdiction:explicitJ??inheritedJ,language:language(latest??first??""),prior_recommendations:assistants.filter(x=>RECOMMEND.test(x.text)).slice(0,6).map(x=>x.text)};
}
export function buildCanonicalContinuityBlock(newestFirst:RuntimeHistoryRow[]):string{
 const s=projectConversationRuntimeState(newestFirst); if(!s.latest_customer_turn)return"";
 const lines=["Canonical conversation state (internal; never quote this block):",`First customer turn: ${s.first_customer_turn??"—"}`,`Current customer turn: ${s.latest_customer_turn}`,`Current topic: ${s.current_topic??"—"}`,`Jurisdiction: ${s.jurisdiction??"unspecified"}`];
 if(s.latest_corrections.length)lines.push("Newest corrections / superseding facts:",...s.latest_corrections.map((x,i)=>`${i+1}. ${x}`));
 if(s.active_constraints.length)lines.push("Active customer constraints:",...s.active_constraints.map((x,i)=>`${i+1}. ${x}`));
 if(s.unresolved_questions.length)lines.push("Recent unresolved customer questions:",...s.unresolved_questions.slice(0,5).map((x,i)=>`${i+1}. ${x}`));
 if(s.prior_recommendations.length)lines.push("Recent assistant recommendations (context only, not customer facts):",...s.prior_recommendations.slice(0,3).map((x,i)=>`${i+1}. ${x}`));
 return lines.join("\n").slice(0,6000);
}
export function buildCanonicalRetrievalQuery(latestInput:string,newestFirst:RuntimeHistoryRow[]):CanonicalRetrievalQuery{
 const latest=clean(latestInput); const state=projectConversationRuntimeState(newestFirst); if(!latest)return{query:"",mode:"standalone",latest:"",context_turns:[],state};
 if(MEMORY.test(latest)){const parts=[`Conversation-memory request: ${latest}`];if(state.first_customer_turn)parts.push(`First customer turn: ${state.first_customer_turn}`);if(state.prior_recommendations.length)parts.push(`Relevant prior recommendations: ${state.prior_recommendations.join(" / ")}`);return{query:parts.join("\n").slice(0,1200),mode:"memory",latest,context_turns:[],state};}
 const explicitJ=detectExplicitJurisdiction(latest); const previous=newestFirst.filter(r=>CUSTOMER.has(String(r.role??"").toLowerCase())).map(r=>clean(r.content)).filter(x=>x&&x!==latest&&x!=="__THINKING__");
 const needs=FOLLOW.test(latest)||PRONOUN.test(latest)||latest.length<=28&&QUESTION.test(latest)||CORRECTION.test(latest);
 if(!needs||explicitJ){return{query:latest,mode:"standalone",latest,context_turns:[],state:{...state,jurisdiction:explicitJ??state.jurisdiction}};}
 const ctx=previous.filter(x=>!MEMORY.test(x)).slice(0,5); if(!ctx.length)return{query:latest,mode:"standalone",latest,context_turns:[],state};
 return{query:[`Current request: ${latest}`,`Relevant prior customer context: ${ctx.join(" / ")}`].join("\n").slice(0,1200),mode:"contextual",latest,context_turns:ctx,state};
}
export function buildCanonicalAssistRetrievalQuery(input:string,newestFirst:RuntimeHistoryRow[]):CanonicalRetrievalQuery{
 const latest=clean(input); const state=projectConversationRuntimeState(newestFirst); const customer=newestFirst.filter(r=>CUSTOMER.has(String(r.role??"").toLowerCase())).map(r=>clean(r.content)).filter(Boolean).slice(0,12);
 const chronological=[...customer].reverse(); return{query:[`Assistance input: ${latest}`,`Canonical customer context: ${chronological.join(" / ")}`,`Jurisdiction: ${state.jurisdiction??"unspecified"}`].join("\n").slice(0,1600),mode:"contextual",latest,context_turns:customer,state};
}
`);

write(groundingPath, String.raw`import type { KBDocumentCandidate, KBFullChunk, KBLLMContextEvidence } from "./kb-client.ts";
import { detectExplicitJurisdiction } from "./conversation-runtime-state.ts";
export interface CanonicalGroundingOptions { minScore?:number; policyOnly?:boolean; requirePublished?:boolean; requestText?:string }
export type CanonicalGroundingResult = {ok:true;document:KBDocumentCandidate|null;chunks:KBFullChunk[];evidence:KBLLMContextEvidence[];applicability:{accepted:boolean;reason:string;request_jurisdiction:string|null;document_jurisdictions:string[]}}|{ok:false;error:"KB_DOCUMENT_EVIDENCE_MISMATCH"|"KB_EVIDENCE_NOT_PUBLISHED"};
function models(t:string){return [...new Set((t.match(/\b[A-Z]{2,}[A-Z0-9]*[- ]?\d{2,}[A-Z0-9-]*\b/g)??[]).map(x=>x.replace(/\s+/g,"").toUpperCase()))]}
function docText(d:KBDocumentCandidate){return [d.title,d.source_type,...d.chunks.map(c=>`${c.title??""} ${c.content}`),...d.llm_context.full_content_evidence.map(e=>e.content)].join("\n").slice(0,50000)}
function jurisdictions(t:string){const ids=["mars","hong_kong","macau","singapore","taiwan","mainland_china"];return ids.filter(id=>detectExplicitJurisdiction(id==="mars"?(/(mars|火星)/i.test(t)?"Mars":""):id==="hong_kong"?(/(香港|hong\s*kong|\bhk\b)/i.test(t)?"香港":""):id==="macau"?(/(澳門|澳门|macau|macao)/i.test(t)?"澳門":""):id==="singapore"?(/(新加坡|singapore)/i.test(t)?"新加坡":""):id==="taiwan"?(/(台灣|台湾|taiwan)/i.test(t)?"台灣":""):/(中國大陸|中国大陆|內地|内地|mainland\s*china)/i.test(t)?"中國大陸":"")===id)}
function applicability(d:KBDocumentCandidate,request:string){const rj=detectExplicitJurisdiction(request);const text=docText(d);const dj=jurisdictions(text);if(rj==="mars"&&!dj.includes("mars"))return{accepted:false,reason:"unsupported_explicit_jurisdiction",request_jurisdiction:rj,document_jurisdictions:dj};if(rj&&dj.length&& !dj.includes(rj))return{accepted:false,reason:"jurisdiction_mismatch",request_jurisdiction:rj,document_jurisdictions:dj};const rm=models(request),dm=models(text);if(rm.length&&dm.length&&!rm.some(x=>dm.includes(x)))return{accepted:false,reason:"model_mismatch",request_jurisdiction:rj,document_jurisdictions:dj};return{accepted:true,reason:"applicable",request_jurisdiction:rj,document_jurisdictions:dj}}
export function selectCanonicalGrounding(documents:KBDocumentCandidate[],options:CanonicalGroundingOptions={}):CanonicalGroundingResult{
 const min=Number.isFinite(options.minScore)?Number(options.minScore):0,policy=options.policyOnly===true,published=options.requirePublished!==false,request=options.requestText??"";const eligible=[] as Array<{document:KBDocumentCandidate;chunks:KBFullChunk[];evidence:KBLLMContextEvidence[];a:ReturnType<typeof applicability>;score:number}>;
 for(const d of documents??[]){if(d.llm_context.selected_document_id!==d.document_id)return{ok:false,error:"KB_DOCUMENT_EVIDENCE_MISMATCH"};if(d.llm_context.full_content_evidence.some(e=>e.document_id!==d.document_id)||d.chunks.some(c=>c.document_id!==d.document_id))return{ok:false,error:"KB_DOCUMENT_EVIDENCE_MISMATCH"};const chunks=d.chunks.filter(c=>c.content.trim()&&Number.isFinite(c.score)&&c.score>=min&&(!published||c.status==="published")&&(!policy||c.source_type.toLowerCase().includes("policy")));const ids=new Set(chunks.filter(c=>c.chunk_type==="full_content").map(c=>c.chunk_id??c.content));const evidence=d.llm_context.full_content_evidence.filter(e=>e.content.trim()&&Number.isFinite(e.score)&&e.score>=min&&(!policy||e.source_type.toLowerCase().includes("policy"))&&ids.has(e.chunk_id??e.content));if(published&&evidence.length&&chunks.every(c=>c.status!=="published"))return{ok:false,error:"KB_EVIDENCE_NOT_PUBLISHED"};if(!evidence.length)continue;const a=applicability(d,request);if(!a.accepted)continue;eligible.push({document:d,chunks,evidence,a,score:Math.max(...evidence.map(e=>e.score),0)});}
 eligible.sort((a,b)=>b.document.document_score-a.document.document_score||b.score-a.score||a.document.document_id.localeCompare(b.document.document_id));const w=eligible[0];return w?{ok:true,document:w.document,chunks:w.chunks,evidence:w.evidence,applicability:w.a}:{ok:true,document:null,chunks:[],evidence:[],applicability:{accepted:false,reason:"no_applicable_published_evidence",request_jurisdiction:detectExplicitJurisdiction(request),document_jurisdictions:[]}};
}
`);

let generate=fs.readFileSync(generatePath,'utf8');
must(generate.includes('buildContextualRetrievalQuery'),'generate contextual baseline missing');
must(generate.includes('selectGroundedDocument'),'generate grounding baseline missing');
generate=generate.replace('import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildContextualRetrievalQuery, buildConversationContinuityBlock, buildCustomerAdvisoryContext, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";','import { CUSTOMER_CONVERSATION_POLICY, NATURAL_CLARIFICATION, buildCustomerAdvisoryContext, classifyConversationTurn, classifyHandoffIntent, hasUsableFullContentEvidence, isHumanControlState } from "../_shared/conversation-intelligence.ts";\nimport { buildCanonicalRetrievalQuery, buildCanonicalContinuityBlock } from "../_shared/conversation-runtime-state.ts";');
generate=generate.replace('import { selectGroundedDocument } from "../_shared/kb-grounding.ts";','import { selectCanonicalGrounding } from "../_shared/canonical-grounding.ts";');
generate=generate.replaceAll('buildConversationContinuityBlock(','buildCanonicalContinuityBlock(').replaceAll('buildContextualRetrievalQuery(','buildCanonicalRetrievalQuery(').replaceAll('selectGroundedDocument(','selectCanonicalGrounding(');
generate=generate.replace('requirePublished: true,\n      },','requirePublished: true,\n        requestText: userQuery,\n      },');
write(generatePath,generate);

let assist=fs.readFileSync(assistPath,'utf8');
must(assist.includes('selectAgentAssistGrounding'),'agent assist grounding baseline missing');
assist=assist.replace('import { selectAgentAssistGrounding } from "../_shared/agent-assist-grounding.ts";','import { selectCanonicalGrounding } from "../_shared/canonical-grounding.ts";');
assist=assist.replace('import { buildConversationAssistRetrievalQuery } from "../_shared/conversation-intelligence.ts";','import { buildCanonicalAssistRetrievalQuery } from "../_shared/conversation-runtime-state.ts";');
assist=assist.replace('.order("created_at",{ascending:false}).limit(20);','.order("created_at",{ascending:false}).limit(200);');
assist=assist.replace('buildConversationAssistRetrievalQuery(content,history)','buildCanonicalAssistRetrievalQuery(content,history)');
assist=assist.replace('selectAgentAssistGrounding(kb.documents)','selectCanonicalGrounding(kb.documents,{requestText:retrievalQuery,requirePublished:true})');
assist=assist.replace('selectAgentAssistGrounding(kb.documents,{policyOnly:true})','selectCanonicalGrounding(kb.documents,{policyOnly:true,requestText:retrievalQuery,requirePublished:true})');
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
const start=ce.indexOf('function evidenceRows(result: KBRagResponse)'); const end=ce.indexOf('function mergeEvidence(',start); must(start>=0&&end>start,'CE evidence block boundaries missing');
const replacement=String.raw`function evidenceRows(result: KBRagResponse, requestText: string, policyOnly = false): Array<Record<string, unknown>> {
  const selected = selectCanonicalGrounding(result.documents ?? [], { requestText, policyOnly, requirePublished: true });
  if (!selected.ok || !selected.document) return [];
  return selected.evidence.map((item) => {
    const matching = selected.chunks.find((c: KBFullChunk) => c.chunk_type === "full_content" && c.document_id === item.document_id && (!item.chunk_id || c.chunk_id === item.chunk_id));
    return { chunk_id:item.chunk_id??matching?.chunk_id??"", document_id:selected.document!.document_id, document_title:matching?.title??selected.document!.title??"KB document", citation_label:matching?.title??selected.document!.title??"KB document", source_type:item.source_type||matching?.source_type||"unknown", source_scope:policyOnly?"policy":"customer_answer", score:item.score, version:null, last_updated_at:null, freshness_status:"fresh", content:item.content };
  });
}

`;
ce=ce.slice(0,start)+replacement+ce.slice(end);
ce=ce.replace('let evidence = evidenceRows(primary.result);\n  let selectedDocumentIds = resultDocumentIds(primary.result);','let evidence = evidenceRows(primary.result, query);\n  let selectedDocumentIds = [...new Set(evidence.map((row) => String(row.document_id ?? "")).filter(Boolean))];');
ce=ce.replace('evidence = mergeEvidence(evidence, evidenceRows(secondary.result));\n    selectedDocumentIds.push(...resultDocumentIds(secondary.result));','const policyEvidence = evidenceRows(secondary.result, policyQuery, true);\n    evidence = mergeEvidence(evidence, policyEvidence);\n    selectedDocumentIds.push(...policyEvidence.map((row) => String(row.document_id ?? "")).filter(Boolean));');
write(cePath,ce);

console.log('TASK7_1_APPLY=PASS');
