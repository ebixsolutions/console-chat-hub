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
}: {
  conversationId: string;
  convStatus: string;
  draftText: string;
  selectedMessage: { id: string; role: string; content: string } | null;
  onClearSelection: () => void;
  onUseDraft: (t: string) => void;
}) {
  const lang = useConsoleLang();
  const tc = (k: TCK) => TOOL_COPY[k]?.[lang] ?? TOOL_COPY[k]?.en ?? k;
  const [cs, setCs] = useState<"draft" | "selected" | "custom">("custom");
  const [ci, setCi] = useState("");
  const [tr, setTr] = useState<{ type: string; data: Record<string, unknown> } | null>(null);
  const [tl, setTl] = useState(false);
  const [te, setTe] = useState("");
  const toolReqIdRef = useRef(0);

  // Conversation changes must invalidate every visible/pending tool result.
  // This prevents a slow response from conversation A being rendered after
  // the operator has already switched to conversation B.
  useEffect(() => {
    toolReqIdRef.current += 1;
    setCs("custom");
    setCi("");
    setTr(null);
    setTl(false);
    setTe("");
    onClearSelection();
  // onClearSelection is intentionally excluded: conversationId is the
  // authoritative context boundary and parent callback identity may change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

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

  const gc = (): string => {
    if (cs === "draft") return draftText.trim();
    if (cs === "selected") return selectedMessage?.content?.trim() ?? "";
    return ci.trim();
  };
  const ac = gc();
  const hc = ac.length > 0 && ac.length <= AGENT_ASSIST_MAX_CONTENT;
  const tooLong = ac.length > AGENT_ASSIST_MAX_CONTENT;
  const isResolved = convStatus === "resolved";

  async function runTool(tt: string, extra?: Record<string, unknown>) {
    if (!hc || isResolved) return;
    const reqId = ++toolReqIdRef.current;
    setTl(true);
    setTe("");
    setTr(null);
    try {
      const { data, error } = await supabase.functions.invoke("agent-assist", {
        body: { tool_type: tt, conversation_id: conversationId, content: ac, ...extra },
      });
      if (toolReqIdRef.current !== reqId) return;
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
      if (toolReqIdRef.current !== reqId) return;
      setTe(tc("netError"));
    }
    if (toolReqIdRef.current === reqId) setTl(false);
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
    { k: "knowledge_helper", l: tc("knowledgeHelper"), i: "📚", a: () => runTool("knowledge_helper") },
    { k: "check_policy", l: tc("policyCheck"), i: "🛡️", a: () => runTool("check_policy") },
  ];

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
        {tl && <div style={{ textAlign: "center", color: "#888", padding: 14 }}>{tc("processing")}</div>}
        {te && <div style={{ color: "#ef4444", padding: "4px 0" }}>{te}</div>}
        {tr?.type === "translate" && (
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
              {String(tr.data.translated_text)}
            </div>
            <button
              onClick={() => onUseDraft(String(tr.data.translated_text))}
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
        {tr?.type === "grammar" && (
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
              {String(tr.data.corrected_text)}
            </div>
            <div style={{ fontSize: 10, color: "#888", marginTop: 3 }}>
              {String(tr.data.summary)} · {String(tr.data.tone_assessment)}
            </div>
            <button
              onClick={() => onUseDraft(String(tr.data.corrected_text))}
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
        {tr?.type === "knowledge_helper" && (
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
