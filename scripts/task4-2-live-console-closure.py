from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    count = s.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}: {old[:120]!r}")
    p.write_text(s.replace(old, new, 1))

# 1) Live Console queue semantics: backend state only, no keyword handoff guessing.
route = "src/routes/_authenticated/console.conversations.index.tsx"
replace_once(route,
'''const FILTERS: { key: string | null; label: string }[] = [
  { key: null, label: "All" },
  { key: "human_needed", label: "Human Needed" },
  { key: "ai_handling", label: "AI Handling" },
  { key: "escalation_risk", label: "Escalation Risk" },
  { key: "human_control", label: "Human Control" },
  { key: "unresolved", label: "Unresolved" },
  { key: "resolved", label: "Resolved" },
];''',
'''const FILTERS: { key: string | null; label: string }[] = [
  { key: null, label: "All" },
  { key: "waiting_human", label: "Waiting for Human" },
  { key: "human_control", label: "Human Control" },
  { key: "ai_handling", label: "AI Handling" },
  { key: "escalation_risk", label: "Escalation Risk" },
  { key: "unresolved", label: "Unresolved" },
  { key: "resolved", label: "Resolved" },
];''')

replace_once(route,
'''function isHumanNeeded(c: Conv) {
  if (["pending", "unresolved", "human_needed"].includes(c.status)) return true;
  return HANDOFF_KEYWORDS.some((kw) => (c.latest_preview || "").toLowerCase().includes(kw.toLowerCase()));
}''',
'''function isHumanNeeded(c: Conv) {
  if (c.status === "pending") return !c.assigned_agent_id;
  return ["unresolved", "human_needed", "escalation_risk"].includes(c.status);
}''')

replace_once(route,
'''      pending_human: conversations.filter((c) => isHumanNeeded(c)).length,''',
'''      pending_human: conversations.filter((c) => isHumanNeeded(c) && !c.assigned_agent_id).length,''')

replace_once(route,
'''    if (filter === "ai_handling")
      return list.filter((c) => c.status === "ai_handling" || (!isHumanNeeded(c) && c.status === "open"));
    return list.filter((c) => c.status === filter);''',
'''    if (filter === "waiting_human")
      return list.filter((c) => isHumanNeeded(c) && !c.assigned_agent_id);
    if (filter === "human_control")
      return list.filter((c) => c.status === "pending" && Boolean(c.assigned_agent_id));
    if (filter === "ai_handling")
      return list.filter((c) => c.status === "ai_handling" || (!isHumanNeeded(c) && c.status === "open"));
    return list.filter((c) => c.status === filter);''')

replace_once(route,
'''  async function handleReturnToAi() {
    if (!selectedId) return;
    if (await callEF("return-to-ai", { conversation_id: selectedId })) {
      toast.success("Returned to AI");
      loadConversations();
      loadMessages(selectedId, false, true);
    }
  }''',
'''  async function handleReturnToAi() {
    if (!selectedId || !selectedConv) return;
    if (selectedConv.status !== "pending" || !selectedConv.assigned_agent_id) {
      toast.error("Return to AI is available only while a human agent owns the conversation.");
      return;
    }
    const issueResolved = window.confirm(
      "Return to AI checklist 1/2: Has the human-handled issue been resolved or sufficiently addressed?",
    );
    if (!issueResolved) {
      toast.info("Keep Human Control until the issue is addressed, or resolve the ticket.");
      return;
    }
    const lowRiskFollowup = window.confirm(
      "Return to AI checklist 2/2: Is the remaining follow-up low-risk and appropriate for AI handling?",
    );
    if (!lowRiskFollowup) {
      toast.info("Keep Human Control for non-low-risk follow-up, or resolve the ticket.");
      return;
    }
    if (
      await callEF("return-to-ai", {
        conversation_id: selectedId,
        closure_checklist: { issue_resolved: true, low_risk_followup: true },
      })
    ) {
      toast.success("Returned to AI after closure checklist confirmation");
      loadConversations();
      loadMessages(selectedId, false, true);
    }
  }''')

# 2) Return-to-AI Edge: enforce checklist server-side; RPC is service-role-only so this is non-bypassable by clients.
edge = "supabase/functions/return-to-ai/index.ts"
replace_once(edge,
'''    const conversation_id = body?.conversation_id;

    if (!conversation_id) return json({ error: "conversation_id required" }, 400);''',
'''    const conversation_id = body?.conversation_id;
    const issueResolved = body?.closure_checklist?.issue_resolved === true;
    const lowRiskFollowup = body?.closure_checklist?.low_risk_followup === true;

    if (!conversation_id) return json({ error: "conversation_id required" }, 400);
    if (!issueResolved || !lowRiskFollowup) {
      return json(
        {
          success: false,
          error: "closure_checklist_required",
          detail: "Return to AI requires issue_resolved=true and low_risk_followup=true",
        },
        409,
      );
    }''')

replace_once(edge,
'''    if (!ELEVATED.has(scope.companyRole) && conversation.assigned_agent_id !== agent.id) {
      return json({ error: "You can only return conversations assigned to you" }, 403);
    }

    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc("return_to_ai_tx", {''',
'''    if (conversation.status !== "pending" || !conversation.assigned_agent_id) {
      return json(
        { success: false, error: "human_control_required", detail: "Conversation must be under active human control" },
        409,
      );
    }

    if (!ELEVATED.has(scope.companyRole) && conversation.assigned_agent_id !== agent.id) {
      return json({ error: "You can only return conversations assigned to you" }, 403);
    }

    const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc("return_to_ai_tx", {''')

# 3) Agent Assist backend: add read-only Knowledge Helper. Keep suggest_reply backend for compatibility outside Live Console.
aa = "supabase/functions/agent-assist/index.ts"
replace_once(aa,
'''const TOOL_TYPES = new Set(["translate", "grammar", "suggest_reply", "check_policy"]);''',
'''const TOOL_TYPES = new Set(["translate", "grammar", "suggest_reply", "knowledge_helper", "check_policy"]);''')
replace_once(aa,
'''  suggest_reply: new Set(["tool_type", "conversation_id", "content"]),
  check_policy: new Set(["tool_type", "conversation_id", "content"]),''',
'''  suggest_reply: new Set(["tool_type", "conversation_id", "content"]),
  knowledge_helper: new Set(["tool_type", "conversation_id", "content"]),
  check_policy: new Set(["tool_type", "conversation_id", "content"]),''')
replace_once(aa,
'''  const tenant=await resolveTenantScope(conversationId,{userId:agent.user_id,allowPreActivation:true});if(!tenant.resolved)return jsonRes({success:false,error:toolType==="suggest_reply"?"suggest_kb_tenant_unresolved":"policy_kb_tenant_unresolved",detail:tenant.reason},503,req);
  const scopeAligned=scope.mode==="canonical"?tenant.scope.mode==="canonical"&&tenant.scope.aiCompanyId===scope.companyId:tenant.scope.mode==="pre_activation"&&scope.companyId===null;if(!scopeAligned)return jsonRes({success:false,error:toolType==="suggest_reply"?"suggest_kb_tenant_unresolved":"policy_kb_tenant_unresolved"},503,req);
  const endpoint=resolveKBEndpoint();if(!endpoint)return jsonRes({success:false,error:toolType==="suggest_reply"?"suggest_kb_unavailable":"policy_kb_unavailable"},503,req);
  const kb=await fetchKBRag({query:content.slice(0,500),top_k:3},tenant.scope,endpoint);if(!kb.success)return jsonRes({success:false,error:toolType==="suggest_reply"?"suggest_kb_unavailable":"policy_kb_unavailable"},kb.error_code==="KB_TIMEOUT"?504:502,req);
  if(toolType==="suggest_reply")''',
'''  const kbPrefix=toolType==="suggest_reply"?"suggest":toolType==="knowledge_helper"?"knowledge":"policy";
  const tenant=await resolveTenantScope(conversationId,{userId:agent.user_id,allowPreActivation:true});if(!tenant.resolved)return jsonRes({success:false,error:`${kbPrefix}_kb_tenant_unresolved`,detail:tenant.reason},503,req);
  const scopeAligned=scope.mode==="canonical"?tenant.scope.mode==="canonical"&&tenant.scope.aiCompanyId===scope.companyId:tenant.scope.mode==="pre_activation"&&scope.companyId===null;if(!scopeAligned)return jsonRes({success:false,error:`${kbPrefix}_kb_tenant_unresolved`},503,req);
  const endpoint=resolveKBEndpoint();if(!endpoint)return jsonRes({success:false,error:`${kbPrefix}_kb_unavailable`},503,req);
  const kb=await fetchKBRag({query:content.slice(0,500),top_k:3},tenant.scope,endpoint);if(!kb.success)return jsonRes({success:false,error:`${kbPrefix}_kb_unavailable`},kb.error_code==="KB_TIMEOUT"?504:502,req);
  if(toolType==="knowledge_helper"){const evidence=kb.llm_context?.full_content_evidence?.filter(i=>i.content.trim()).slice(0,3)??[];if(!evidence.length)return jsonRes({success:true,tool_type:"knowledge_helper",knowledge_grounded:true,scope_mode:tenant.scope.mode,selected_document_id:kb.llm_context?.selected_document_id??null,result:{status:"insufficient_evidence",orientation_summary:kb.llm_context?.orientation_summary?.slice(0,800)??"",evidence:[]}},200,req);return jsonRes({success:true,tool_type:"knowledge_helper",knowledge_grounded:true,scope_mode:tenant.scope.mode,selected_document_id:kb.llm_context?.selected_document_id??null,result:{status:"available",orientation_summary:kb.llm_context?.orientation_summary?.slice(0,800)??"",evidence:evidence.map((i,n)=>({label:`Evidence ${n+1}`,source_type:i.source_type,chunk_type:i.chunk_type,content:i.content.slice(0,1200)}))}},200,req);}
  if(toolType==="suggest_reply")''')

# 4) Live Console tool panel: no customer-facing AI suggestions; show read-only KB evidence + policy check.
panel = "src/components/console/AgentToolPanel.tsx"
replace_once(panel,
'''  panelTitle: { en: "Agent Assist Tools", zh: "智能協助工具" },''',
'''  panelTitle: { en: "Human Support Tools", zh: "真人客服協助工具" },''')
replace_once(panel,
'''  suggest: { en: "Suggest", zh: "建議" },''',
'''  knowledgeHelper: { en: "Knowledge Helper", zh: "知識助手" },
  policyCheck: { en: "Policy Check", zh: "政策檢查" },''')
replace_once(panel,
'''    en: "Knowledge base unavailable — suggestion not generated",
    zh: "知識庫目前無法使用 — 未產生建議回覆",''',
'''    en: "Knowledge base unavailable",
    zh: "知識庫目前無法使用",''')
replace_once(panel,
'''    en: "Not enough verified knowledge to generate a grounded reply",
    zh: "沒有足夠已驗證知識可產生有依據的建議回覆",''',
'''    en: "Not enough verified knowledge evidence",
    zh: "沒有足夠已驗證的知識證據",''')
replace_once(panel,
'''  sugResult: { en: "Suggested Replies", zh: "建議回覆" },''',
'''  knowledgeResult: { en: "Knowledge Evidence", zh: "知識證據" },
  policyResult: { en: "Policy Check", zh: "政策檢查" },''')

replace_once(panel,
'''        } else if (
          tt === "suggest_reply" &&
          data?.error === "suggest_kb_tenant_unresolved"
        ) {
          setTe(tc("kbTenantUnresolved"));
        } else if (
          tt === "suggest_reply" &&
          data?.error === "suggest_insufficient_evidence"
        ) {
          setTe(tc("kbInsufficientEvidence"));
        } else if (
          tt === "suggest_reply" &&
          data?.error === "suggest_kb_unavailable"
        ) {
          setTe(tc("kbUnavailable"));
        } else {''',
'''        } else if (String(data?.error ?? "").endsWith("_kb_tenant_unresolved")) {
          setTe(tc("kbTenantUnresolved"));
        } else if (String(data?.error ?? "").includes("insufficient_evidence")) {
          setTe(tc("kbInsufficientEvidence"));
        } else if (String(data?.error ?? "").endsWith("_kb_unavailable")) {
          setTe(tc("kbUnavailable"));
        } else {''')

replace_once(panel,
'''    { k: "grammar", l: tc("grammar"), i: "✏️", a: () => runTool("grammar") },
    { k: "suggest_reply", l: tc("suggest"), i: "💡", a: () => runTool("suggest_reply") },''',
'''    { k: "grammar", l: tc("grammar"), i: "✏️", a: () => runTool("grammar") },
    { k: "knowledge_helper", l: tc("knowledgeHelper"), i: "📚", a: () => runTool("knowledge_helper") },
    { k: "check_policy", l: tc("policyCheck"), i: "🛡️", a: () => runTool("check_policy") },''')

old_suggest = '''        {tr?.type === "suggest_reply" && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "#8b5cf6", marginBottom: 4 }}>{tc("sugResult")}</div>
            <div style={{ fontSize: 10, color: "#888", marginBottom: 4, fontStyle: "italic" }}>{tc("draftOnly")}</div>
            {Array.isArray(tr.data.suggestions) &&
              (tr.data.suggestions as Array<{ content: string; tone_label: string }>).map((s, i) => (
                <div
                  key={i}
                  style={{
                    background: "#faf5ff",
                    border: "1px solid #e9d5ff",
                    borderRadius: 5,
                    padding: "6px",
                    marginBottom: 4,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <span
                      style={{
                        fontSize: 9.5,
                        background: "#ede9fe",
                        color: "#6366f1",
                        padding: "1px 5px",
                        borderRadius: 6,
                        fontWeight: 600,
                      }}
                    >
                      {s.tone_label}
                    </span>
                    <button
                      onClick={() => onUseDraft(s.content)}
                      style={{
                        fontSize: 10,
                        padding: "2px 7px",
                        borderRadius: 4,
                        border: "1px solid #8b5cf6",
                        background: "#faf5ff",
                        color: "#8b5cf6",
                        cursor: "pointer",
                        fontWeight: 600,
                      }}
                    >
                      {tc("use")}
                    </button>
                  </div>
                  <div style={{ fontSize: 10.5, lineHeight: 1.5 }}>{s.content}</div>
                </div>
              ))}
          </div>
        )}'''
new_tools = '''        {tr?.type === "knowledge_helper" && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "#7c3aed", marginBottom: 4 }}>{tc("knowledgeResult")}</div>
            {String(tr.data.orientation_summary ?? "") && (
              <div style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 5, padding: 6, marginBottom: 5, lineHeight: 1.5 }}>
                {String(tr.data.orientation_summary)}
              </div>
            )}
            {Array.isArray(tr.data.evidence) && (tr.data.evidence as Array<{ label: string; source_type: string; chunk_type: string; content: string }>).map((e, i) => (
              <div key={i} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 5, padding: 6, marginBottom: 4 }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, color: "#64748b", marginBottom: 3 }}>{e.label} · {e.source_type} · {e.chunk_type}</div>
                <div style={{ fontSize: 10.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{e.content}</div>
              </div>
            ))}
            {String(tr.data.status ?? "") === "insufficient_evidence" && <div style={{ color: "#92400e" }}>{tc("kbInsufficientEvidence")}</div>}
          </div>
        )}
        {tr?.type === "check_policy" && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "#0f766e", marginBottom: 4 }}>{tc("policyResult")}</div>
            <div style={{ background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 5, padding: 6, lineHeight: 1.5 }}>
              <strong>{String(tr.data.status ?? "unknown")}</strong> — {String(tr.data.summary ?? "")}
            </div>
            {Array.isArray(tr.data.issues) && (tr.data.issues as Array<{ excerpt: string; policy_label: string; severity: string }>).map((i, n) => (
              <div key={n} style={{ marginTop: 4, background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 5, padding: 6 }}>
                <div style={{ fontSize: 9.5, fontWeight: 700 }}>{i.severity} · {i.policy_label}</div>
                <div style={{ fontSize: 10.5, marginTop: 2 }}>{i.excerpt}</div>
              </div>
            ))}
          </div>
        )}'''
replace_once(panel, old_suggest, new_tools)

# Static invariants after patch.
checks = {
    route: ["Waiting for Human", 'filter === "waiting_human"', "closure_checklist", "low_risk_followup"],
    edge: ["closure_checklist_required", "human_control_required"],
    aa: ['"knowledge_helper"', 'tool_type:"knowledge_helper"'],
    panel: ["Knowledge Helper", "Policy Check", 'runTool("knowledge_helper")', 'runTool("check_policy")'],
}
for path, needles in checks.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"{path}: missing postcondition {needle}")

# Live Console must no longer expose reply-generating Suggest UI.
panel_text = Path(panel).read_text()
if 'runTool("suggest_reply")' in panel_text or 'Suggested Replies' in panel_text:
    raise SystemExit("AgentToolPanel still exposes customer-facing suggested replies")

print("TASK4_2_SOURCE_PATCH=PASS")
