import { useCallback, useEffect, useRef, useState } from "react";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { supabase } from "@/integrations/supabase/client";

export const AGENT_ASSIST_MAX_CONTENT = 2000;

const TOOL_COPY = {
  panelTitle: { en: "Human Support Tools", zh: "真人客服協助工具" },
  useDraft: { en: "Use draft", zh: "使用草稿" },
  useSelected: { en: "Selected msg", zh: "已選訊息" },
  customInput: { en: "Custom", zh: "自訂" },
  customPh: { en: "Paste or type...", zh: "貼上或輸入..." },
  translate: { en: "Translate", zh: "翻譯" },
  grammar: { en: "Grammar", zh: "文法" },
  suggestReply: { en: "Suggest Reply", zh: "建議回覆" },
  knowledgeHelper: { en: "Knowledge Helper", zh: "知識助手" },
  policyCheck: { en: "Policy Check", zh: "政策檢查" },
  processing: { en: "Processing...", zh: "處理中..." },
  useInDraft: { en: "Use in Draft", zh: "套用至草稿" },
  use: { en: "Use", zh: "使用" },
  draftOnly: { en: "Draft only — review before sending", zh: "僅為草稿 — 發送前請確認" },
  noContent: { en: "Select a message or enter text", zh: "請選取訊息或輸入文字" },
  draftEmpty: { en: "Draft empty", zh: "草稿為空" },
  noSel: { en: "No selection", zh: "未選取" },
  clear: { en: "Clear", zh: "清除" },
  selPrev: { en: "Selected:", zh: "已選：" },
  toolHint: { en: "Enter text, then select a tool.", zh: "輸入文字後選取工具。" },
  resolved: { en: "Conversation resolved — tools disabled", zh: "對話已解決 — 工具已停用" },
  reqFailed: { en: "Request failed", zh: "請求失敗" },
  kbUnavailable: {
    en: "Knowledge base unavailable",
    zh: "知識庫目前無法使用",
  },
  kbTenantUnresolved: {
    en: "Knowledge scope is not configured for this conversation",
    zh: "此對話尚未設定可驗證的知識庫租戶範圍",
  },
  kbInsufficientEvidence: {
    en: "Not enough verified knowledge evidence",
    zh: "沒有足夠已驗證的知識證據",
  },
  netError: { en: "Network error", zh: "網路錯誤" },
  transResult: { en: "Translation", zh: "翻譯結果" },
  gramResult: { en: "Grammar Check", zh: "文法檢查" },
  suggestResult: { en: "Suggested Replies", zh: "建議回覆" },
  knowledgeResult: { en: "Knowledge Evidence", zh: "知識證據" },
  policyResult: { en: "Policy Check", zh: "政策檢查" },
  tooLong: { en: "Content exceeds 2,000 characters", zh: "內容超過 2,000 字元" },
} as const;
type TCK = keyof typeof TOOL_COPY;

export function AgentToolPanel({
  conversationId,
  convStatus,
  draftText,
  selectedMessage,
  onClearSelection,
  onUseDraft,
  autoLoadHandoffContext,
  toolScopeKey = "",
  contextRevisionKey = "",
}: {
  conversationId: string;
  convStatus: string;
  draftText: string;
  selectedMessage: { id: string; role: string; content: string } | null;
  onClearSelection: () => void;
  onUseDraft: (t: string) => void;
  autoLoadHandoffContext?: boolean;
  toolScopeKey?: string;
  contextRevisionKey?: string;
}) {
  const lang = useConsoleLang();
  const tc = (k: TCK) => TOOL_COPY[k]?.[lang] ?? TOOL_COPY[k]?.en ?? k;
  const [cs, setCs] = useState<"draft" | "selected" | "custom">("custom");
  const [ci, setCi] = useState("");
  const [tr, setTr] = useState<{ type: string; data: Record<string, unknown> } | null>(null);
  const [tl, setTl] = useState(false);
  const [boundedToolMode, setBoundedToolMode] = useState(false);
  const [te, setTe] = useState("");
  const [handoffContext, setHandoffContext] = useState<Record<string, any> | null>(null);
  const [handoffLoading, setHandoffLoading] = useState(false);
  const toolReqIdRef = useRef(0);
  const toolPending=useRef(false);
  const handoffReqIdRef = useRef(0);
  const handoffPendingRef = useRef(false);
  const handoffSnapshot=useRef<{key:string;draft:string}|null>(null);

  // Conversation changes must invalidate every visible/pending tool result.
  // This prevents a slow response from conversation A being rendered after
  // the operator has already switched to conversation B.
  useEffect(() => {
    toolReqIdRef.current += 1;
    handoffReqIdRef.current += 1;
    handoffPendingRef.current = false;
    setCs("custom");
    setBoundedToolMode(false);
    setCi("");
    setTr(null);
    setTl(false);
    setTe("");
    setHandoffContext(null);
    setHandoffLoading(false);
    onClearSelection();
  // onClearSelection is intentionally excluded: conversationId is the
  // authoritative context boundary and parent callback identity may change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId,toolScopeKey]);

  // AUTO-HEIGHT: textarea ref + resize logic
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const sh = el.scrollHeight;
    const cap = 150;
    el.style.height = Math.min(sh, cap) + "px";
    el.style.overflowY = sh > cap ? "auto" : "hidden";
  }, []);
  useEffect(() => {
    if (cs === "custom") adjustHeight();
  }, [ci, cs, adjustHeight]);

  async function prepareHandoffContext() {
    if (!autoLoadHandoffContext || convStatus === "resolved" || handoffPendingRef.current) return;
    const key=JSON.stringify([latestInputs.current.scope,latestInputs.current.revision]);
    handoffSnapshot.current={key,draft:draftText};
    const valid=()=>handoffReqIdRef.current===reqId && handoffSnapshot.current?.key===JSON.stringify([latestInputs.current.scope,latestInputs.current.revision]);
    const reqId = ++handoffReqIdRef.current;
    handoffPendingRef.current = true;
    setHandoffLoading(true);
    setTe("");
    try {
      const { data, error } = await supabase.functions.invoke("agent-assist", {
        body: { tool_type: "handoff_context", conversation_id: conversationId, content: "handoff" },
      });
      if (!valid()) return;
      if (!error && data?.success) setHandoffContext(data as Record<string, any>);
      else setTe(lang === "zh" ? "未能準備交接內容，請重試。" : "Could not prepare handoff context. Please retry.");
    } catch {
      if (valid()) setTe(lang === "zh" ? "未能準備交接內容，請重試。" : "Could not prepare handoff context. Please retry.");
    } finally {
      if (valid()) { handoffPendingRef.current = false; setHandoffLoading(false); }
    }
  }

  const gc = (): string => {
    if (cs === "draft") return draftText.trim();
    if (cs === "selected") return selectedMessage?.content?.trim() ?? "";
    return ci.trim();
  };
  const ac = gc();
  const hc = ac.length > 0 && ac.length <= AGENT_ASSIST_MAX_CONTENT;
  const tooLong = ac.length > AGENT_ASSIST_MAX_CONTENT;
  const latestInputs = useRef({scope:[] as unknown[],language:lang,mode:cs,content:ac,selectedId:selectedMessage?.id,revision:contextRevisionKey,draft:draftText,boundedToolMode});
  latestInputs.current={scope:[conversationId,convStatus,toolScopeKey],language:lang,mode:cs,content:ac,selectedId:cs==="selected"?selectedMessage?.id:undefined,revision:contextRevisionKey,draft:draftText,boundedToolMode};
  const resultSnapshot=useRef<{key:string;type:string;draft:string}|null>(null);
  const keyFor=(type:string,v=latestInputs.current)=>{return JSON.stringify([v.scope,type,type==="translate"?v.language:null,v.mode,v.content,v.selectedId,["suggest_reply","knowledge_helper","check_policy"].includes(type)?v.revision:null,["suggest_reply","knowledge_helper","check_policy"].includes(type)?v.boundedToolMode:null]);};
  const renderedInputs=latestInputs.current;
  const displayedResultSnapshot=resultSnapshot.current;
  const validResult=()=>!!resultSnapshot.current && resultSnapshot.current.key===keyFor(resultSnapshot.current.type);
  const useResult=(content:string)=>{if(resultSnapshot.current===displayedResultSnapshot && validResult() && resultSnapshot.current?.draft===latestInputs.current.draft && convStatus!=="resolved")onUseDraft(content);};
  useEffect(()=>{
    if(resultSnapshot.current && !validResult()){toolReqIdRef.current++;resultSnapshot.current=null;toolPending.current=false;setTr(null);setTl(false);setTe("");}
  },[conversationId,convStatus,toolScopeKey,lang,cs,ac,selectedMessage?.id,contextRevisionKey]);

  useEffect(()=>{handoffReqIdRef.current++;handoffPendingRef.current=false;handoffSnapshot.current=null;setHandoffContext(null);setHandoffLoading(false);},[toolScopeKey,convStatus,contextRevisionKey]);
  useEffect(()=>()=>{toolReqIdRef.current++;handoffReqIdRef.current++;toolPending.current=false;handoffPendingRef.current=false;resultSnapshot.current=null;handoffSnapshot.current=null;},[]);
  const isResolved = convStatus === "resolved";

  async function runTool(tt: string, extra?: Record<string, unknown>) {
    if (!hc || isResolved || toolPending.current || keyFor(tt,renderedInputs)!==keyFor(tt)) return;
    toolPending.current=true;
    const key=keyFor(tt);resultSnapshot.current={key,type:tt,draft:draftText};
    const valid=()=>toolReqIdRef.current===reqId && key===keyFor(tt);
    const reqId = ++toolReqIdRef.current;
    setTl(true);
    setTe("");
    setTr(null);
    try {
      const { data, error } = await supabase.functions.invoke("agent-assist", {
        body: { tool_type: tt, conversation_id: conversationId, content: ac, ...((["suggest_reply", "knowledge_helper", "check_policy"].includes(tt)) ? { context_mode: cs === "custom" ? "manual" : cs === "draft" ? "draft" : "conversation", bounded_mode:boundedToolMode } : {}), ...extra },
      });
      if (!valid()) return;
      if (error || !data?.success) {
        if (data?.result?.status === "insufficient_evidence") {
          setTr({ type: tt, data: data.result });
        } else if (String(data?.error ?? "").endsWith("_kb_tenant_unresolved")) {
          setTe(tc("kbTenantUnresolved"));
        } else if (String(data?.error ?? "").includes("insufficient_evidence")) {
          setTe(tc("kbInsufficientEvidence"));
        } else if (String(data?.error ?? "").endsWith("_kb_unavailable")) {
          setTe(tc("kbUnavailable"));
        } else {
          setTe(tc("reqFailed"));
        }
      } else {
        setTr({ type: tt, data: data.result });
      }
    } catch {
      if (!valid()) return;
      setTe(tc("netError"));
    }
    if (valid()) {toolPending.current=false;setTl(false); }
  }

  const dis = tl || !hc || isResolved;
  const TOOLS = [
    {
      k: "translate",
      l: tc("translate"),
      i: "🌐",
      a: () => runTool("translate", { target_language: lang === "zh" ? "en" : "zh-TW" }),
    },
    { k: "grammar", l: tc("grammar"), i: "✏️", a: () => runTool("grammar") },
    { k: "suggest_reply", l: tc("suggestReply"), i: "💬", a: () => runTool("suggest_reply") },
    { k: "knowledge_helper", l: tc("knowledgeHelper"), i: "📚", a: () => runTool("knowledge_helper") },
    { k: "check_policy", l: tc("policyCheck"), i: "🛡️", a: () => runTool("check_policy") },
  ];

  const visibleResult=validResult()?tr:null;
  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        flexShrink: 0,
        background: "#fff",
        borderLeft: "0.5px solid #e8e6e0",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "0.5px solid #e8e6e0",
          fontSize: 12,
          fontWeight: 600,
          color: "#374151",
          flexShrink: 0,
        }}
      >
        {tc("panelTitle")}
      </div>
      <label className="flex items-center gap-2 px-3 py-2 text-[11px]">
        <input type="checkbox" checked={boundedToolMode} disabled={tl}
          onChange={e => setBoundedToolMode(e.target.checked)} aria-label="One provider attempt per C4 tool call" />
        {lang === "zh" ? "每個模型呼叫只嘗試一次（不能視為遠端帳單封頂）" : "One provider attempt per model call (not a remote billing hard cap)"}
      </label>
      {isResolved ? (
        <div style={{ padding: "20px 10px", textAlign: "center", color: "#9ca3af", fontSize: 11.5 }}>
          {tc("resolved")}
        </div>
      ) : (
        <>
          <div style={{ padding: "6px 10px", borderBottom: "0.5px solid #f3f4f6", flexShrink: 0, fontSize: 11 }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 5, flexWrap: "wrap" }}>
              {[
                { k: "draft" as const, l: tc("useDraft"), d: !draftText.trim() },
                { k: "selected" as const, l: tc("useSelected"), d: !selectedMessage },
                { k: "custom" as const, l: tc("customInput"), d: false },
              ].map((s) => (
                <button
                  key={s.k}
                  onClick={() => !s.d && setCs(s.k)}
                  style={{
                    fontSize: 10,
                    padding: "3px 7px",
                    borderRadius: 4,
                    border: cs === s.k ? "1px solid #8b5cf6" : "1px solid #e5e7eb",
                    background: cs === s.k ? "#faf5ff" : s.d ? "#f9fafb" : "#fff",
                    color: s.d ? "#d1d5db" : cs === s.k ? "#7c3aed" : "#555",
                    cursor: s.d ? "not-allowed" : "pointer",
                    fontWeight: 500,
                  }}
                >
                  {s.l}
                </button>
              ))}
            </div>
            {cs === "draft" && (
              <div
                style={{
                  fontSize: 10.5,
                  color: draftText.trim() ? "#555" : "#d1d5db",
                  background: "#f9fafb",
                  borderRadius: 4,
                  padding: "4px 6px",
                  maxHeight: 150,
                  overflowY: "auto",
                }}
              >
                {draftText.trim() || tc("draftEmpty")}
              </div>
            )}
            {cs === "selected" && (
              <div
                style={{
                  fontSize: 10.5,
                  background: "#f9fafb",
                  borderRadius: 4,
                  padding: "4px 6px",
                  maxHeight: 150,
                  overflowY: "auto",
                }}
              >
                {selectedMessage ? (
                  <>
                    <span style={{ color: "#8b5cf6", fontWeight: 600 }}>
                      {tc("selPrev")}[{selectedMessage.role}]
                    </span>{" "}
                    {selectedMessage.content}
                    <button
                      onClick={onClearSelection}
                      style={{
                        marginLeft: 4,
                        fontSize: 10,
                        color: "#ef4444",
                        background: "none",
                        border: "none",
                        cursor: "pointer",
                      }}
                    >
                      {tc("clear")}
                    </button>
                  </>
                ) : (
                  <span style={{ color: "#d1d5db" }}>{tc("noSel")}</span>
                )}
              </div>
            )}
            {cs === "custom" && (
              <textarea
                ref={textareaRef}
                value={ci}
                onChange={(e) => setCi(e.target.value)}
                placeholder={tc("customPh")}
                style={{
                  width: "100%",
                  fontSize: 11,
                  border: "1px solid #e5e7eb",
                  borderRadius: 4,
                  padding: "4px 6px",
                  resize: "none",
                  minHeight: 34,
                  maxHeight: 150,
                  overflowY: "hidden",
                  fontFamily: "inherit",
                  boxSizing: "border-box",
                }}
              />
            )}
            {tooLong && <div style={{ fontSize: 10, color: "#ef4444", marginTop: 2 }}>{tc("tooLong")}</div>}
          </div>
          <div
            style={{
              padding: "6px 10px",
              display: "flex",
              flexWrap: "wrap",
              gap: 4,
              borderBottom: "0.5px solid #f3f4f6",
              flexShrink: 0,
            }}
          >
            {TOOLS.map((t) => (
              <button
                key={t.k}
                onClick={t.a}
                disabled={dis}
                style={{
                  fontSize: 10.5,
                  padding: "4px 8px",
                  borderRadius: 5,
                  border: "1px solid #e5e7eb",
                  background: dis ? "#f9fafb" : "#fff",
                  cursor: dis ? "not-allowed" : "pointer",
                  color: dis ? "#d1d5db" : "#374151",
                  fontWeight: 500,
                  display: "flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                <span>{t.i}</span>
                {t.l}
              </button>
            ))}
          </div>
        </>
      )}
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px", fontSize: 11 }}>
        {autoLoadHandoffContext && <button type="button" disabled={handoffLoading || convStatus === "resolved"} onClick={() => void prepareHandoffContext()}>
          {lang === "zh" ? "AI 準備交接內容" : "Prepare handoff context with AI"}
        </button>}
        {autoLoadHandoffContext && (handoffLoading || handoffContext) && (
          <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, marginBottom: 10, background: "#fafafa" }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Warm Handoff Context / 真人接手摘要</div>
            {handoffLoading && <div style={{ color: "#888" }}>Loading handoff context...</div>}
            {handoffContext?.warm_handoff_package && <>
              <div><b>Customer goal:</b> {String(handoffContext.warm_handoff_package.customer_goal || "—")}</div>
              <div><b>Last request:</b> {String(handoffContext.warm_handoff_package.last_customer_request || "—")}</div>
              <div style={{ marginTop: 5 }}><b>Known facts:</b> {(handoffContext.warm_handoff_package.known_facts || []).length ? (handoffContext.warm_handoff_package.known_facts || []).map((x: any) => `${x.label}: ${x.value}`).join(" · ") : "—"}</div>
              <div><b>Missing facts:</b> {(handoffContext.warm_handoff_package.missing_facts || []).join(", ") || "—"}</div>
              <div><b>Unavailable:</b> {(handoffContext.warm_handoff_package.unavailable_facts || []).join(", ") || "—"}</div>
              <div style={{ marginTop: 5 }}><b>Summary:</b> {String(handoffContext.warm_handoff_package.conversation_summary || "—")}</div>
            </>}
            <div style={{ marginTop: 8, fontWeight: 600 }}>Relevant Knowledge</div>
            {(handoffContext?.knowledge?.evidence || []).length ? ((handoffContext?.knowledge?.evidence ?? []) as any[]).map((x: any, i: number) => <div key={`hk-${i}`} style={{ marginTop: 4, padding: 6, background: "#fff", borderRadius: 5 }}>{x.content}</div>) : <div style={{ color: "#888" }}>No matching verified evidence.</div>}
            <div style={{ marginTop: 8, fontWeight: 600 }}>Relevant Policy</div>
            {(handoffContext?.policy?.evidence || []).length ? ((handoffContext?.policy?.evidence ?? []) as any[]).map((x: any, i: number) => <div key={`hp-${i}`} style={{ marginTop: 4, padding: 6, background: "#fff", borderRadius: 5 }}>{x.content}</div>) : <div style={{ color: "#888" }}>No matching verified policy evidence.</div>}
            <div style={{ marginTop: 8, fontWeight: 600 }}>Suggested Replies</div>
            {(handoffContext?.suggested_replies || []).length ? ((handoffContext?.suggested_replies ?? []) as any[]).map((x: any, i: number) => <div key={`hs-${i}`} style={{ marginTop: 5, padding: 6, background: "#fff", borderRadius: 5 }}><div>{x.content}</div><button onClick={() => {if(handoffSnapshot.current?.key===JSON.stringify([latestInputs.current.scope,latestInputs.current.revision]) && handoffSnapshot.current?.draft===latestInputs.current.draft && convStatus!=="resolved")onUseDraft(String(x.content));}} style={{ marginTop: 4, fontSize: 10, padding: "3px 7px" }}>Use in Draft</button></div>) : <div style={{ color: "#888" }}>No grounded draft available.</div>}
          </div>
        )}
        {tl && <div style={{ textAlign: "center", color: "#888", padding: 14 }}>{tc("processing")}</div>}
        {te && <div style={{ color: "#ef4444", padding: "4px 0" }}>{te}</div>}
        {visibleResult?.type === "translate" && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "#2563eb", marginBottom: 4 }}>
              {tc("transResult")}
            </div>
            <div
              style={{
                background: "#f0f9ff",
                border: "1px solid #bae6fd",
                borderRadius: 5,
                padding: "6px",
                lineHeight: 1.5,
              }}
            >
              {String(visibleResult.data.translated_text)}
            </div>
            <button
              onClick={() => useResult(String(visibleResult.data.translated_text))}
              style={{
                marginTop: 4,
                fontSize: 10.5,
                padding: "3px 9px",
                borderRadius: 4,
                border: "1px solid #2563eb",
                background: "#eff6ff",
                color: "#2563eb",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {tc("useInDraft")}
            </button>
          </div>
        )}
        {visibleResult?.type === "grammar" && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "#16a34a", marginBottom: 4 }}>{tc("gramResult")}</div>
            <div
              style={{
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                borderRadius: 5,
                padding: "6px",
                lineHeight: 1.5,
              }}
            >
              {String(visibleResult.data.corrected_text)}
            </div>
            <div style={{ fontSize: 10, color: "#888", marginTop: 3 }}>
              {String(visibleResult.data.summary)} · {String(visibleResult.data.tone_assessment)}
            </div>
            <button
              onClick={() => useResult(String(visibleResult.data.corrected_text))}
              style={{
                marginTop: 4,
                fontSize: 10.5,
                padding: "3px 9px",
                borderRadius: 4,
                border: "1px solid #16a34a",
                background: "#f0fdf4",
                color: "#16a34a",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {tc("useInDraft")}
            </button>
          </div>
        )}
        {visibleResult?.type === "suggest_reply" && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "#7c3aed", marginBottom: 4 }}>{tc("suggestResult")}</div>
            {Array.isArray(visibleResult.data.suggestions) && (visibleResult.data.suggestions as Array<{ content: string; tone_label: string }>).map((s, i) => (
              <div key={i} style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 5, padding: 6, marginBottom: 5 }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, color: "#7c3aed", marginBottom: 3 }}>{s.tone_label}</div>
                <div style={{ fontSize: 10.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{s.content}</div>
                <button onClick={() => useResult(s.content)} style={{ marginTop: 4, fontSize: 10.5, padding: "3px 9px", borderRadius: 4, border: "1px solid #7c3aed", background: "#faf5ff", color: "#7c3aed", cursor: "pointer", fontWeight: 600 }}>{tc("useInDraft")}</button>
              </div>
            ))}
          </div>
        )}
        {visibleResult?.type === "knowledge_helper" && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "#7c3aed", marginBottom: 4 }}>{tc("knowledgeResult")}</div>
            {String(visibleResult.data.orientation_summary ?? "") && (
              <div style={{ background: "#faf5ff", border: "1px solid #e9d5ff", borderRadius: 5, padding: 6, marginBottom: 5, lineHeight: 1.5 }}>
                {String(visibleResult.data.orientation_summary)}
              </div>
            )}
            {Array.isArray(visibleResult.data.evidence) && (visibleResult.data.evidence as Array<{ label: string; source_type: string; chunk_type: string; content: string }>).map((e, i) => (
              <div key={i} style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 5, padding: 6, marginBottom: 4 }}>
                <div style={{ fontSize: 9.5, fontWeight: 700, color: "#64748b", marginBottom: 3 }}>{e.label} · {e.source_type} · {e.chunk_type}</div>
                <div style={{ fontSize: 10.5, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{e.content}</div>
              </div>
            ))}
            {String(visibleResult.data.status ?? "") === "insufficient_evidence" && <div style={{ color: "#92400e" }}>{tc("kbInsufficientEvidence")}</div>}
          </div>
        )}
        {visibleResult?.type === "check_policy" && (
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 600, color: "#0f766e", marginBottom: 4 }}>{tc("policyResult")}</div>
            <div style={{ background: "#f0fdfa", border: "1px solid #99f6e4", borderRadius: 5, padding: 6, lineHeight: 1.5 }}>
              <strong>{String(visibleResult.data.status ?? "unknown")}</strong> — {String(visibleResult.data.summary ?? "")}
            </div>
            {Array.isArray(visibleResult.data.issues) && (visibleResult.data.issues as Array<{ excerpt: string; policy_label: string; severity: string }>).map((i, n) => (
              <div key={n} style={{ marginTop: 4, background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 5, padding: 6 }}>
                <div style={{ fontSize: 9.5, fontWeight: 700 }}>{i.severity} · {i.policy_label}</div>
                <div style={{ fontSize: 10.5, marginTop: 2 }}>{i.excerpt}</div>
              </div>
            ))}
          </div>
        )}
        {!tl && !te && !tr && !isResolved && (
          <div style={{ padding: "16px 10px", textAlign: "center", color: "#cbd5e1", fontSize: 10.5 }}>
            <div style={{ fontSize: 18, marginBottom: 4 }}>🛠️</div>
            {tc(hc ? "toolHint" : "noContent")}
          </div>
        )}
      </div>
    </div>
  );
}
