from pathlib import Path

HELPER = r'''export type WarmHandoffKnownFact = { label: string; value: string };
export type WarmHandoffPackage = {
  reason: string;
  customer_goal: string;
  known_facts: WarmHandoffKnownFact[];
  unavailable_facts: string[];
  missing_facts: string[];
  actions_already_tried: string[];
  last_customer_request: string;
  conversation_summary: string;
  collection_already_attempted: boolean;
  ready_for_handoff: boolean;
};
type Row = { role?: string; content?: string | null; metadata?: unknown };
const REGION = /(香港|台灣|台湾|澳門|澳门|Hong Kong|Taiwan|Macau)/i;
const PRODUCT = /(冷氣|空調|空调|洗衣機|洗衣机|雪櫃|冰箱|電視|电视|產品|产品|product)/i;
const PRODUCT_SUPPORT = /(維修|维修|保養|保修|故障|唔凍|不冷|不能運作|无法运行|repair|warranty|broken|not working)/i;
const ORDER_SUPPORT = /(訂單|订单|送貨|送货|退款|退貨|退货|order|delivery|refund|return)/i;
const MODEL_VALUE = /(?:型號|型号|model(?: number)?)[\s:：#-]*([A-Za-z0-9][A-Za-z0-9._\/-]{1,60})/i;
const ORDER_VALUE = /(?:訂單(?:編號|號碼|号码)|订单(?:编号|号码)|order(?: number| no\.?| id)|order\s*#)[\s:：#-]*([A-Za-z0-9][A-Za-z0-9._\/-]{2,80})/i;
const NO_MODEL = /(?:沒有|没有|冇|不知道|唔知|未知|no|don['’]?t have|do not have).{0,10}(?:型號|型号|model)/i;
const NO_ORDER = /(?:沒有|没有|冇|不知道|唔知|未知|no|don['’]?t have|do not have).{0,12}(?:訂單(?:編號|號碼|号码)?|订单(?:编号|号码)?|order(?: number| no\.?| id)?)/i;
function clean(v: unknown, max = 500): string {
  return typeof v === "string" ? v.normalize("NFKC").replace(/\s+/g, " ").trim().slice(0, max) : "";
}
function meta(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
export function buildWarmHandoffPackage(rows: Row[], reason = "human_handoff"): WarmHandoffPackage {
  const usable = rows.filter((r) => clean(r.content) && clean(r.content) !== "__THINKING__");
  const visitors = usable.filter((r) => ["visitor", "customer", "user"].includes(String(r.role || "").toLowerCase()));
  const transcript = visitors.map((r) => clean(r.content)).join(" ");
  const last = clean(visitors.at(-1)?.content);
  const known: WarmHandoffKnownFact[] = [];
  const region = transcript.match(REGION)?.[0]; if (region) known.push({ label: "Region", value: region });
  const product = transcript.match(PRODUCT)?.[0]; if (product) known.push({ label: "Product", value: product });
  const model = transcript.match(MODEL_VALUE)?.[1]; if (model) known.push({ label: "Model", value: model });
  const order = transcript.match(ORDER_VALUE)?.[1]; if (order) known.push({ label: "Order reference", value: order });
  const unavailable: string[] = [];
  if (NO_MODEL.test(transcript)) unavailable.push("model");
  if (NO_ORDER.test(transcript)) unavailable.push("order_reference");
  const missing: string[] = [];
  if (PRODUCT_SUPPORT.test(transcript) && !model && !unavailable.includes("model")) missing.push("model");
  if (ORDER_SUPPORT.test(transcript) && !order && !unavailable.includes("order_reference")) missing.push("order_reference");
  const collectionAttempted = usable.some((r) => meta(r.metadata)?.response_route === "warm_handoff_data_collection");
  const assistants = usable.filter((r) => String(r.role || "").toLowerCase() === "assistant");
  const actions = assistants
    .filter((r) => meta(r.metadata)?.response_route !== "warm_handoff_data_collection")
    .slice(-3).map((r) => clean(r.content)).filter(Boolean);
  const goal = last || clean(visitors.at(-2)?.content) || "Customer requested human support";
  return {
    reason,
    customer_goal: goal,
    known_facts: known,
    unavailable_facts: unavailable,
    missing_facts: missing,
    actions_already_tried: actions,
    last_customer_request: last,
    conversation_summary: visitors.slice(-5).map((r) => clean(r.content)).join(" / ").slice(0, 1500),
    collection_already_attempted: collectionAttempted,
    ready_for_handoff: missing.length === 0 || collectionAttempted,
  };
}
export function buildMissingFactsQuestion(pkg: WarmHandoffPackage, lang: "zh-TW" | "zh-CN" | "en" = "zh-TW"): string | null {
  if (pkg.missing_facts.length === 0 || pkg.collection_already_attempted) return null;
  const names = {
    model: { "zh-TW": "產品型號", "zh-CN": "产品型号", en: "product model" },
    order_reference: { "zh-TW": "訂單編號", "zh-CN": "订单编号", en: "order number" },
  } as const;
  const labels = pkg.missing_facts.map((x) => (names as any)[x]?.[lang] || x);
  if (lang === "en") return `Before I connect you with a human agent, could you provide ${labels.join(" and ")}? If you don’t have it, just say so and I’ll still pass along everything we have.`;
  return `轉交真人客服前，想先補齊${labels.join("、")}；如果你手上沒有，直接告訴我「沒有」也可以，我會把目前資料一併交給客服。`;
}
export function shouldCollectMissingFacts(rule: string | null | undefined, explicitNow: boolean, pkg: WarmHandoffPackage): boolean {
  if (explicitNow) return false;
  if (rule === "E1" || rule === "E2" || rule === "S0" || rule === "R1") return false;
  return pkg.missing_facts.length > 0 && !pkg.collection_already_attempted;
}
'''

TESTS = r'''import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildMissingFactsQuestion, buildWarmHandoffPackage, shouldCollectMissingFacts } from "../../supabase/functions/_shared/warm-handoff.ts";
Deno.test("complete conversation does not ask again", () => { const p = buildWarmHandoffPackage([{ role: "visitor", content: "香港冷氣維修，型號 AC-123" }]); assertEquals(p.missing_facts, []); assert(p.ready_for_handoff); assertEquals(buildMissingFactsQuestion(p), null); });
Deno.test("incomplete nonurgent asks only missing", () => { const p = buildWarmHandoffPackage([{ role: "visitor", content: "香港冷氣壞了，想維修" }]); assertEquals(p.missing_facts, ["model"]); assert(shouldCollectMissingFacts("R2", false, p)); assert(buildMissingFactsQuestion(p)?.includes("產品型號")); });
Deno.test("explicit unavailable model is not asked repeatedly", () => { const p = buildWarmHandoffPackage([{ role: "visitor", content: "冷氣壞了，我沒有型號" }]); assertEquals(p.missing_facts, []); assertEquals(p.unavailable_facts, ["model"]); assert(p.ready_for_handoff); });
Deno.test("prior collection attempt prevents loop", () => { const p = buildWarmHandoffPackage([{ role: "assistant", content: "請提供產品型號", metadata: { response_route: "warm_handoff_data_collection" } }, { role: "visitor", content: "冷氣仍然壞了" }]); assert(p.collection_already_attempted); assertEquals(buildMissingFactsQuestion(p), null); });
Deno.test("explicit R1 never delayed", () => { const p = buildWarmHandoffPackage([{ role: "visitor", content: "我要真人客服，冷氣壞了" }]); assertEquals(shouldCollectMissingFacts("R1", true, p), false); });
Deno.test("critical E1 E2 S0 never delayed", () => { const p = buildWarmHandoffPackage([{ role: "visitor", content: "冷氣壞了" }]); for (const r of ["E1", "E2", "S0"]) assertEquals(shouldCollectMissingFacts(r, false, p), false); });
Deno.test("plain order conversation asks order reference", () => { const p = buildWarmHandoffPackage([{ role: "visitor", content: "我的送貨訂單出問題" }]); assertEquals(p.missing_facts, ["order_reference"]); });
Deno.test("explicit order reference is accepted", () => { const p = buildWarmHandoffPackage([{ role: "visitor", content: "我的送貨訂單編號 ABC123 出問題" }]); assertEquals(p.missing_facts, []); assert(p.known_facts.some((x) => x.label === "Order reference" && x.value === "ABC123")); });
Deno.test("plain order word is never parsed as identifier", () => { const p = buildWarmHandoffPackage([{ role: "visitor", content: "我的訂單還沒到" }]); assertEquals(p.missing_facts, ["order_reference"]); assert(!p.known_facts.some((x) => x.label === "Order reference")); });
Deno.test("unavailable order reference does not loop", () => { const p = buildWarmHandoffPackage([{ role: "visitor", content: "我的送貨有問題，但我沒有訂單編號" }]); assertEquals(p.missing_facts, []); assertEquals(p.unavailable_facts, ["order_reference"]); });
'''

Path("supabase/functions/_shared/warm-handoff.ts").write_text(HELPER)
Path("tests/edge/warm-handoff-package.test.ts").write_text(TESTS)

# Agent Assist: unified handoff package + verified KB/policy + grounded drafts.
p = Path("supabase/functions/agent-assist/index.ts")
s = p.read_text()
imp = 'import { buildCanonicalAssistRetrievalQuery } from "../_shared/conversation-runtime-state.ts";'
if 'from "../_shared/warm-handoff.ts"' not in s:
    assert s.count(imp) == 1
    s = s.replace(imp, imp + '\nimport { buildWarmHandoffPackage } from "../_shared/warm-handoff.ts";', 1)
old = 'const TOOL_TYPES = new Set(["translate", "grammar", "suggest_reply", "knowledge_helper", "check_policy"]);'
if '"handoff_context"' not in s.split("const ALLOWED_LANGS")[0]:
    assert s.count(old) == 1
    s = s.replace(old, 'const TOOL_TYPES = new Set(["translate", "grammar", "suggest_reply", "knowledge_helper", "check_policy", "handoff_context"]);', 1)
policy = '  check_policy: new Set(["tool_type", "conversation_id", "content", "context_mode"]),'
if "handoff_context: new Set" not in s:
    assert s.count(policy) == 1
    s = s.replace(policy, policy + '\n  handoff_context: new Set(["tool_type", "conversation_id", "content"]),', 1)
marker = '  if(toolType==="translate"){'
if 'toolType==="handoff_context"' not in s:
    assert s.count(marker) == 1
    block = r'''  if(toolType==="handoff_context"){
    const history=await loadAssistConversationHistory(supabaseAdmin,conversationId);
    if(history===null)return jsonRes({success:false,error:"handoff_context_unavailable"},500,req);
    const pkg=buildWarmHandoffPackage(history,"takeover");
    const tenant=await resolveTenantScope(conversationId,{userId:agent.user_id,allowPreActivation:true});
    if(!tenant.resolved)return jsonRes({success:false,error:"handoff_kb_tenant_unresolved"},503,req);
    const scopeAligned=scope.mode==="canonical"?tenant.scope.mode==="canonical"&&tenant.scope.aiCompanyId===scope.companyId:tenant.scope.mode==="pre_activation"&&scope.companyId===null;
    if(!scopeAligned)return jsonRes({success:false,error:"handoff_kb_tenant_unresolved"},503,req);
    const endpoint=resolveKBEndpoint(); if(!endpoint)return jsonRes({success:false,error:"handoff_kb_unavailable"},503,req);
    const query=buildCanonicalAssistRetrievalQuery(pkg.customer_goal,history).query.slice(0,500);
    const kb=await fetchKBRag({query,top_k:3},tenant.scope,endpoint);
    if(!kb.success)return jsonRes({success:false,error:"handoff_kb_unavailable"},kb.error_code==="KB_TIMEOUT"?504:502,req);
    const knowledge=selectCanonicalGrounding(kb.documents,{requestText:query,requirePublished:true});
    if(!knowledge.ok)return jsonRes({success:false,error:"handoff_kb_contract_mismatch"},502,req);
    const policy=selectCanonicalGrounding(kb.documents,{policyOnly:true,requestText:query,requirePublished:true});
    if(!policy.ok)return jsonRes({success:false,error:"handoff_policy_contract_mismatch"},502,req);
    const ke=knowledge.evidence.slice(0,3).map((i,n)=>({label:`Evidence ${n+1}`,content:i.content.slice(0,1200),source_type:i.source_type,chunk_type:"full_content"}));
    const pe=policy.evidence.slice(0,3).map((i,n)=>({label:`Policy ${n+1}`,content:i.content.slice(0,1000),source_type:i.source_type,chunk_type:"full_content"}));
    let suggestions:any[]=[];
    if(ke.length){const grounding=ke.map((i:any)=>i.content).join("\n\n");const r=await callAssistModel('Generate up to 3 concise customer-service reply drafts grounded ONLY in the supplied evidence. Return ONLY JSON: {"suggestions":[{"content":"...","tone_label":"Empathetic|Informative|Neutral"}]}',`Customer goal:\n${pkg.customer_goal}\n\nEvidence:\n${grounding}`,{companyId:scope.companyId,conversationId,toolType:"handoff_context"});if(r.ok&&r.text){const x=parseJson(r.text);if(Array.isArray(x?.suggestions))suggestions=(x!.suggestions as any[]).filter(v=>typeof v?.content==="string"&&v.content.trim()&&VALID_SUG_TONES.has(String(v.tone_label))).slice(0,3).map(v=>({content:String(v.content).slice(0,1000),tone_label:String(v.tone_label)}));}}
    return jsonRes({success:true,tool_type:"handoff_context",warm_handoff_package:pkg,knowledge:{selected_document_id:knowledge.document?.document_id??null,evidence:ke},policy:{selected_document_id:policy.document?.document_id??null,evidence:pe},suggested_replies:suggestions},200,req);
  }
'''
    s = s.replace(marker, block + marker, 1)
p.write_text(s)

# generate-reply: only noncritical R2 handoff may collect truly missing facts first.
p = Path("supabase/functions/generate-reply/index.ts")
s = p.read_text()
import_anchor = 'import { buildInheritedTransformCitationMetadata, buildPriorGroundedTransformBlock, buildPriorGroundedTransformGenerationSystem, buildPriorGroundedTransformGenerationUser, buildPriorGroundedTransformRetrySystem, resolvePriorGroundedTransform } from "../_shared/prior-grounded-transform.ts";'
if 'from "../_shared/warm-handoff.ts"' not in s:
    assert s.count(import_anchor) == 1
    s = s.replace(import_anchor, import_anchor + '\nimport { buildMissingFactsQuestion, buildWarmHandoffPackage } from "../_shared/warm-handoff.ts";', 1)
param = '    suppress_r2_for_prior_grounded_transform?: boolean;'
if 'warm_handoff_question?: string;' not in s:
    assert s.count(param) == 1
    s = s.replace(param, param + '\n    warm_handoff_question?: string;', 1)
decision = '''  if (params.suppress_r2_for_prior_grounded_transform === true && decision.matched_rule === "R2") {\n    return null;\n  }\n\n'''
if 'response_route: "warm_handoff_data_collection"' not in s:
    assert s.count(decision) == 1
    collect = '''  if (decision.decision === "handoff" && decision.matched_rule === "R2" && params.warm_handoff_question) {\n    const { data, error } = await supabaseAdmin.rpc("commit_ai_reply_tx", {\n      p_conversation_id: params.conversation_id,\n      p_source_message_id: params.source_message_id,\n      p_content: params.warm_handoff_question,\n      p_metadata: { escalation_rule: "R2", escalation_action: "collect_missing_handoff_facts", response_route: "warm_handoff_data_collection", handoff_required: false },\n    });\n    if (error) return new Response(JSON.stringify({ success:false, error:"warm_handoff_collection_failed" }), { status:500, headers:{...corsHeaders,"Content-Type":"application/json"} });\n    const result=String((data as any)?.result ?? "");\n    if (result === "success" || result === "idempotent") {\n      await cleanupThinking(supabaseAdmin, params.conversation_id, params.source_message_id);\n      return new Response(JSON.stringify({ success:true, response_route:"warm_handoff_data_collection", handoff_required:false, missing_facts_requested:true }), { headers:{...corsHeaders,"Content-Type":"application/json"} });\n    }\n    if (result === "human_control" || result === "resolved" || result === "superseded_source") return new Response(JSON.stringify({ success:true, skipped:result }), { headers:{...corsHeaders,"Content-Type":"application/json"} });\n    return new Response(JSON.stringify({ success:false, error:`warm_handoff_collection_${result||"unexpected"}` }), { status:409, headers:{...corsHeaders,"Content-Type":"application/json"} });\n  }\n\n'''
    s = s.replace(decision, decision + collect, 1)
call = '''    suppress_r2_for_prior_grounded_transform: Boolean(_priorGroundedTransform),\n    rag_match_state: _pr5RagMatchState,'''
if 'warm_handoff_question: _warmHandoffQuestion' not in s:
    assert s.count(call) == 1
    target = '  const _pr5RequiredLiveResponse = await evaluateAndPersistRequiredRulesLive(supabaseAdmin, {'
    assert s.count(target) == 1
    pre = '  const _warmHandoffPackage = buildWarmHandoffPackage(_pr5HistoryRows ?? [], "R2");\n  const _warmHandoffQuestion = buildMissingFactsQuestion(_warmHandoffPackage, _visitorLang);\n\n'
    s = s.replace(target, pre + target, 1)
    s = s.replace(call, '    suppress_r2_for_prior_grounded_transform: Boolean(_priorGroundedTransform),\n    warm_handoff_question: _warmHandoffQuestion ?? undefined,\n    rag_match_state: _pr5RagMatchState,', 1)
p.write_text(s)

# Agent UI: auto preload when pending or assigned.
p = Path("src/components/console/AgentToolPanel.tsx")
s = p.read_text()
sig = '''  onUseDraft,\n}: {'''
if 'autoLoadHandoffContext,' not in s:
    assert s.count(sig) == 1
    s = s.replace(sig, '''  onUseDraft,\n  autoLoadHandoffContext,\n}: {''', 1)
typ = '''  onUseDraft: (t: string) => void;\n}) {'''
if 'autoLoadHandoffContext?: boolean;' not in s:
    assert s.count(typ) == 1
    s = s.replace(typ, '''  onUseDraft: (t: string) => void;\n  autoLoadHandoffContext?: boolean;\n}) {''', 1)
state = '''  const [te, setTe] = useState("");'''
if 'handoffContext, setHandoffContext' not in s:
    assert s.count(state) == 1
    s = s.replace(state, state + '\n  const [handoffContext, setHandoffContext] = useState<Record<string, any> | null>(null);\n  const [handoffLoading, setHandoffLoading] = useState(false);', 1)
reset = '''    setTe("");\n    onClearSelection();'''
if 'setHandoffContext(null);' not in s:
    assert s.count(reset) == 1
    s = s.replace(reset, '''    setTe("");\n    setHandoffContext(null);\n    setHandoffLoading(false);\n    onClearSelection();''', 1)
gc = '''  const gc = (): string => {'''
if 'tool_type: "handoff_context"' not in s:
    assert s.count(gc) == 1
    effect = '''  useEffect(() => {\n    if (!autoLoadHandoffContext || convStatus === "resolved") return;\n    let cancelled = false;\n    setHandoffLoading(true);\n    void supabase.functions.invoke("agent-assist", { body: { tool_type: "handoff_context", conversation_id: conversationId, content: "handoff" } }).then(({ data, error }) => {\n      if (cancelled) return;\n      if (!error && data?.success) setHandoffContext(data as Record<string, any>);\n    }).finally(() => { if (!cancelled) setHandoffLoading(false); });\n    return () => { cancelled = true; };\n  }, [autoLoadHandoffContext, conversationId, convStatus]);\n\n'''
    s = s.replace(gc, effect + gc, 1)
result_div = '''      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px", fontSize: 11 }}>'''
if 'Warm Handoff Context / 真人接手摘要' not in s:
    assert s.count(result_div) == 1
    jsx = '''      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px", fontSize: 11 }}>\n        {autoLoadHandoffContext && (handoffLoading || handoffContext) && (\n          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, marginBottom: 10, background: "#fafafa" }}>\n            <div style={{ fontWeight: 700, marginBottom: 6 }}>Warm Handoff Context / 真人接手摘要</div>\n            {handoffLoading && <div style={{ color: "#888" }}>Loading handoff context...</div>}\n            {handoffContext?.warm_handoff_package && <>\n              <div><b>Customer goal:</b> {String(handoffContext.warm_handoff_package.customer_goal || "—")}</div>\n              <div><b>Last request:</b> {String(handoffContext.warm_handoff_package.last_customer_request || "—")}</div>\n              <div style={{ marginTop: 5 }}><b>Known facts:</b> {(handoffContext.warm_handoff_package.known_facts || []).length ? (handoffContext.warm_handoff_package.known_facts || []).map((x: any) => `${x.label}: ${x.value}`).join(" · ") : "—"}</div>\n              <div><b>Missing facts:</b> {(handoffContext.warm_handoff_package.missing_facts || []).join(", ") || "—"}</div>\n              <div><b>Unavailable:</b> {(handoffContext.warm_handoff_package.unavailable_facts || []).join(", ") || "—"}</div>\n              <div style={{ marginTop: 5 }}><b>Summary:</b> {String(handoffContext.warm_handoff_package.conversation_summary || "—")}</div>\n            </>}\n            <div style={{ marginTop: 8, fontWeight: 600 }}>Relevant Knowledge</div>\n            {(handoffContext?.knowledge?.evidence || []).length ? (handoffContext.knowledge.evidence as any[]).map((x: any, i: number) => <div key={`hk-${i}`} style={{ marginTop: 4, padding: 6, background: "#fff", borderRadius: 5 }}>{x.content}</div>) : <div style={{ color: "#888" }}>No matching verified evidence.</div>}\n            <div style={{ marginTop: 8, fontWeight: 600 }}>Relevant Policy</div>\n            {(handoffContext?.policy?.evidence || []).length ? (handoffContext.policy.evidence as any[]).map((x: any, i: number) => <div key={`hp-${i}`} style={{ marginTop: 4, padding: 6, background: "#fff", borderRadius: 5 }}>{x.content}</div>) : <div style={{ color: "#888" }}>No matching verified policy evidence.</div>}\n            <div style={{ marginTop: 8, fontWeight: 600 }}>Suggested Replies</div>\n            {(handoffContext?.suggested_replies || []).length ? (handoffContext.suggested_replies as any[]).map((x: any, i: number) => <div key={`hs-${i}`} style={{ marginTop: 5, padding: 6, background: "#fff", borderRadius: 5 }}><div>{x.content}</div><button onClick={() => onUseDraft(String(x.content))} style={{ marginTop: 4, fontSize: 10, padding: "3px 7px" }}>Use in Draft</button></div>) : <div style={{ color: "#888" }}>No grounded draft available.</div>}\n          </div>\n        )}'''
    s = s.replace(result_div, jsx, 1)
p.write_text(s)

# Conversation route enables preload only for handoff/assigned human states.
p = Path("src/routes/_authenticated/console.conversations.$id.tsx")
s = p.read_text()
idx = s.find("<AgentToolPanel")
assert idx != -1
end = s.find("/>", idx)
assert end != -1
block = s[idx:end]
if "autoLoadHandoffContext=" not in block:
    s = s[:end] + '\n                autoLoadHandoffContext={conv.status === "pending" || Boolean(conv.assigned_agent_id)}' + s[end:]
p.write_text(s)

print("DIRECTOR_WARM_HANDOFF_SOURCE_IMPLEMENTATION=PASS")
