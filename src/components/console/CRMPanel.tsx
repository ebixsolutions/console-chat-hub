import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useConsoleLang } from "@/hooks/useEffectiveRole";

// ─── Shared types ────────────────────────────────────────────────────────────
export type CRMConv = {
  id: string;
  status: string;
  channel_config: { name: string } | null;
};

export type CtxMsg = {
  id: string;
  role: string;
  content: string;
  status: string | null;
  is_recalled: boolean;
  created_at: string | null;
};

export type KBResult = { display_label: string; content: string; score: number; source_type: string };
export type PolicyResult = {
  status: string;
  summary: string;
  issues: Array<{ excerpt: string; policy_label: string; severity: string }>;
};
export type KBConnState = "idle" | "loading" | "connected" | "empty" | "denied" | "unavailable";

export const RIGHT_COPY = {
  kbSearch: { en: "Search knowledge base...", zh: "搜尋知識庫..." },
  kbSearchBtn: { en: "Search", zh: "搜尋" },
  kbRefresh: { en: "Refresh", zh: "重新整理" },
  kbCopy: { en: "Copy", zh: "複製" },
  kbInsert: { en: "Insert into Draft", zh: "插入草稿" },
  kbLoading: { en: "Searching knowledge base...", zh: "搜尋知識庫中..." },
  kbEmpty: { en: "No relevant knowledge found", zh: "未找到相關知識" },
  kbEmptySub: { en: "Try a different search or select a conversation", zh: "請嘗試其他搜尋或選取對話" },
  kbError: { en: "Knowledge base unavailable", zh: "知識庫無法存取" },
  kbDenied: { en: "Requires Admin or Supervisor role", zh: "需要 Admin 或 Supervisor 角色" },
  kbNoConv: { en: "Select a conversation to see recommendations", zh: "選取對話以查看推薦" },
  kbScore: { en: "Relevance", zh: "相關度" },
  polCheckConv: { en: "Check Conversation", zh: "檢查對話" },
  polCheckDraft: { en: "Check Draft", zh: "檢查草稿" },
  polLoading: { en: "Checking policy...", zh: "檢查政策中..." },
  polError: { en: "Policy check failed", zh: "政策檢查失敗" },
  polDenied: { en: "Requires Admin or Supervisor role", zh: "需要 Admin 或 Supervisor 角色" },
  polNoContent: { en: "Select a conversation or enter a draft to check", zh: "選取對話或輸入草稿以檢查" },
  polSrcNote: { en: "Based on provided policy sources only", zh: "僅基於所提供的政策來源" },
  polDraftEmpty: { en: "Draft is empty", zh: "草稿為空" },
  polCopySummary: { en: "Copy Summary", zh: "複製摘要" },
  polInsufficient: {
    en: "No matching policy sources found — cannot assess compliance",
    zh: "未找到相符政策來源 — 無法評估合規性",
  },
  copied: { en: "Copied to clipboard", zh: "已複製到剪貼簿" },
  copyFailed: { en: "Copy failed", zh: "複製失敗" },
  inserted: { en: "Inserted into draft", zh: "已插入草稿" },
} as const;
export type RCK = keyof typeof RIGHT_COPY;

// ── RIGHT-CRM-KB-CONTEXT-1: Deterministic bounded conversational context ──
export const MAX_CONTEXT_MESSAGES = 5;
export const CONTEXT_SEPARATOR = " / ";
export const EFFECTIVE_QUERY_CAP = 500;

export function buildBoundedContext(messages: CtxMsg[]): string {
  const eligible = messages.filter(
    (m) => m.role === "visitor" && !m.is_recalled && m.content.trim().length > 0 && m.content !== "__THINKING__",
  );
  if (eligible.length === 0) return "";
  const recent = eligible.slice(-MAX_CONTEXT_MESSAGES);
  // Enforce character cap with separator budget
  while (recent.length > 1) {
    const totalLen =
      recent.reduce((s, m) => s + m.content.trim().length, 0) + (recent.length - 1) * CONTEXT_SEPARATOR.length;
    if (totalLen <= EFFECTIVE_QUERY_CAP) break;
    recent.shift();
  }
  // Head-tail truncation for single message exceeding cap
  if (recent.length === 1 && recent[0].content.trim().length > EFFECTIVE_QUERY_CAP) {
    const text = recent[0].content.trim();
    const headBudget = Math.floor(EFFECTIVE_QUERY_CAP * 0.4);
    const tailBudget = EFFECTIVE_QUERY_CAP - headBudget - 5;
    return text.slice(0, headBudget) + " ... " + text.slice(-tailBudget);
  }
  return recent.map((m) => m.content.trim()).join(CONTEXT_SEPARATOR);
}

export function computeContextRevisionKey(conversationId: string, messages: CtxMsg[]): string {
  const eligible = messages
    .filter(
      (m) => m.role === "visitor" && !m.is_recalled && m.content.trim().length > 0 && m.content !== "__THINKING__",
    )
    .slice(-MAX_CONTEXT_MESSAGES);
  if (eligible.length === 0) return conversationId + ":empty";
  const fingerprint = eligible
    .map((m) => [m.id, m.created_at ?? "", m.status ?? "", String(m.is_recalled), m.content.trim()].join("|"))
    .join("~");
  return conversationId + ":" + fingerprint;
}

function getInitials(label: string) {
  return label
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// ─── CRMPanel (Phase 2A: functional Knowledge + Policy) ──────────────────────
export function CRMPanel({
  conv,
  visitorLabel,
  onResolve,
  boundedContext,
  contextRevisionKey,
  draftText,
  currentRole,
  onInsertDraft,
}: {
  conv: CRMConv | null;
  visitorLabel: string;
  onResolve: () => void;
  boundedContext: string;
  contextRevisionKey: string;
  draftText: string;
  currentRole: string | null;
  onInsertDraft: (t: string) => void;
}) {
  const lang = useConsoleLang();
  const rc = useCallback((k: RCK) => RIGHT_COPY[k]?.[lang] ?? RIGHT_COPY[k]?.en ?? k, [lang]);
  const [tab, setTab] = useState("customer");
  // Knowledge state
  const [kbResults, setKbResults] = useState<KBResult[]>([]);
  const [kbConnState, setKbConnState] = useState<KBConnState>("idle");
  const [kbError, setKbError] = useState("");
  const [kbQuery, setKbQuery] = useState("");
  const kbReqIdRef = useRef(0);
  const lastAutoQueryRef = useRef("");
  // Policy state
  const [polResult, setPolResult] = useState<PolicyResult | null>(null);
  const [polLoading, setPolLoading] = useState(false);
  const [polError, setPolError] = useState("");
  const [polMode, setPolMode] = useState<"conv" | "draft">("conv");
  const polReqIdRef = useRef(0);
  // Permission: mirrors EF ALLOWED_ROLES = ["admin", "supervisor"]
  const canAccessKb = currentRole === "admin" || currentRole === "supervisor";

  const runKbSearch = useCallback(
    async (query: string, reqId: number) => {
      if (!query.trim()) return;
      setKbConnState("loading");
      setKbError("");
      setKbResults([]);
      try {
        const { data, error } = await supabase.functions.invoke("kb-search-proxy", {
          body: { query: query.trim().slice(0, 500), top_k: 3 },
        });
        if (kbReqIdRef.current !== reqId) return;
        if (error) {
          setKbConnState("unavailable");
          setKbError(rc("kbError"));
          return;
        }
        if (data?.error === "forbidden") {
          setKbConnState("denied");
          setKbError(rc("kbDenied"));
          return;
        }
        if (!data?.success || !Array.isArray(data.results)) {
          setKbConnState("unavailable");
          setKbError(rc("kbError"));
          return;
        }
        const results = data.results as KBResult[];
        setKbResults(results);
        setKbConnState(results.length > 0 ? "connected" : "empty");
      } catch {
        if (kbReqIdRef.current !== reqId) return;
        setKbConnState("unavailable");
        setKbError(rc("kbError"));
      }
    },
    [rc],
  );

  // Reset on conversation change
  useEffect(() => {
    setTab("customer");
    setKbResults([]);
    setKbConnState("idle");
    setKbError("");
    setKbQuery("");
    setPolResult(null);
    setPolLoading(false);
    setPolError("");
    setPolMode("conv");
    kbReqIdRef.current++;
    polReqIdRef.current++;
    lastAutoQueryRef.current = "";
  }, [conv?.id]);

  // Auto-query Knowledge (RIGHT-CRM-KB-CONTEXT-1: bounded context)
  useEffect(() => {
    if (!conv || !boundedContext || !canAccessKb) return;
    if (lastAutoQueryRef.current === contextRevisionKey) return;
    lastAutoQueryRef.current = contextRevisionKey;
    const reqId = ++kbReqIdRef.current;
    runKbSearch(boundedContext, reqId);
  }, [conv, boundedContext, contextRevisionKey, canAccessKb, runKbSearch]);

  function handleKbKeywordSearch() {
    if (!kbQuery.trim() || !canAccessKb) return;
    const reqId = ++kbReqIdRef.current;
    runKbSearch(kbQuery, reqId);
  }
  function handleKbRefresh() {
    if (!canAccessKb) return;
    const q = kbQuery.trim() || boundedContext;
    if (!q) return;
    const reqId = ++kbReqIdRef.current;
    runKbSearch(q, reqId);
  }
  async function runPolicyCheck(content: string, reqId: number) {
    if (!content.trim() || !canAccessKb) return;
    setPolLoading(true);
    setPolError("");
    setPolResult(null);
    let pctx: Array<{ label: string; content: string; source_type: string }> = [];
    let kbDenied = false;
    try {
      const { data, error } = await supabase.functions.invoke("kb-search-proxy", {
        body: { query: content.trim().slice(0, 500), top_k: 3 },
      });
      if (polReqIdRef.current !== reqId) return;
      if (data?.error === "forbidden") {
        kbDenied = true;
      } else if (error) {
        setPolError(rc("polError"));
        setPolLoading(false);
        return;
      } else if (data?.success && Array.isArray(data.results)) {
        pctx = (data.results as KBResult[]).slice(0, 3).map((r) => ({
          label: r.display_label.slice(0, 120),
          content: r.content.slice(0, 800),
          source_type: r.source_type.slice(0, 40),
        }));
      }
    } catch {
      if (polReqIdRef.current !== reqId) return;
      setPolError(rc("polError"));
      setPolLoading(false);
      return;
    }
    if (kbDenied) {
      setPolError(rc("polDenied"));
      setPolLoading(false);
      return;
    }
    if (pctx.length === 0) {
      setPolResult({ status: "insufficient_evidence", summary: rc("polInsufficient"), issues: [] });
      setPolLoading(false);
      return;
    }
    try {
      const body: Record<string, unknown> = {
        tool_type: "check_policy",
        conversation_id: conv?.id ?? "",
        content: content.trim().slice(0, 2000),
        policy_context: pctx,
      };
      const { data, error } = await supabase.functions.invoke("agent-assist", { body });
      if (polReqIdRef.current !== reqId) return;
      if (error || !data?.success) {
        setPolError(rc("polError"));
      } else {
        setPolResult(data.result as PolicyResult);
      }
    } catch {
      if (polReqIdRef.current !== reqId) return;
      setPolError(rc("polError"));
    }
    if (polReqIdRef.current === reqId) setPolLoading(false);
  }
  function handleCopy(text: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(rc("copied")))
      .catch(() => toast.error(rc("copyFailed")));
  }
  const initials = getInitials(visitorLabel);
  const sectionTitle: CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    color: "#888",
    textTransform: "uppercase",
    marginBottom: 6,
  };
  const TABS = [
    { key: "customer", label: "Customer" },
    { key: "knowledge", label: lang === "zh" ? "知識" : "Knowledge" },
    { key: "policy", label: lang === "zh" ? "政策" : "Policy" },
  ];
  const cardStyle: CSSProperties = {
    background: "#f9fafb",
    border: "1px solid #e8e6e0",
    borderRadius: 6,
    padding: "6px 8px",
    marginBottom: 5,
  };
  const btnSm: CSSProperties = {
    fontSize: 10,
    padding: "2px 7px",
    borderRadius: 4,
    border: "1px solid #e5e7eb",
    background: "#fff",
    cursor: "pointer",
    fontWeight: 500,
  };
  const kbStatusLabel = !canAccessKb
    ? lang === "zh"
      ? "權限不足"
      : "Permission denied"
    : kbConnState === "idle"
      ? lang === "zh"
        ? "就緒"
        : "Ready"
      : kbConnState === "loading"
        ? lang === "zh"
          ? "載入中"
          : "Loading"
        : kbConnState === "connected" || kbConnState === "empty"
          ? lang === "zh"
            ? "已連線"
            : "Connected"
          : kbConnState === "denied"
            ? lang === "zh"
              ? "權限不足"
              : "Permission denied"
            : lang === "zh"
              ? "無法存取"
              : "Unavailable";
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "#fff" }}>
      <div
        style={{ padding: "8px 12px", borderBottom: "0.5px solid #e8e6e0", fontSize: 10, color: "#555", flexShrink: 0 }}
      >
        <div>Knowledge Base: {kbStatusLabel}</div>
      </div>
      <div
        style={{
          display: "flex",
          borderBottom: "0.5px solid #e8e6e0",
          overflowX: "auto",
          flexShrink: 0,
          background: "#fff",
        }}
      >
        {TABS.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key)}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "8px 10px",
              border: "none",
              cursor: "pointer",
              background: "#fff",
              whiteSpace: "nowrap",
              color: tab === tb.key ? "#1a1a1a" : "#888",
              borderBottom: tab === tb.key ? "2px solid #1a1a1a" : "2px solid transparent",
              flexShrink: 0,
            }}
          >
            {tb.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: 12, background: "#fff" }}>
        {/* Customer tab */}
        {tab === "customer" && conv && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    background: "#fef3c7",
                    color: "#92400e",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {initials}
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{visitorLabel}</div>
                  <div style={{ fontSize: 10.5, color: "#888" }}>
                    {conv.channel_config?.name || "Web"} · #{conv.id.slice(0, 8)}
                  </div>
                </div>
              </div>
            </div>
            <div
              style={{
                background: "#f5f4f0",
                borderRadius: 9,
                padding: "12px 14px",
                marginBottom: 12,
                fontSize: 11,
                color: "#555",
                lineHeight: 1.6,
              }}
            >
              Customer profile data requires CRM integration. Connect your CRM to view order history, loyalty status,
              sentiment analysis, and trust scores.
            </div>
            <div style={sectionTitle}>Quick Actions</div>
            <button
              type="button"
              onClick={onResolve}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                fontSize: 11.5,
                fontWeight: 500,
                padding: "7px 11px",
                borderRadius: 8,
                border: "0.5px solid #e8e6e0",
                background: "#fff",
                cursor: "pointer",
                marginBottom: 5,
                color: "#ef4444",
              }}
            >
              Resolve Ticket
            </button>
          </>
        )}
        {/* Knowledge tab */}
        {tab === "knowledge" &&
          (!canAccessKb ? (
            <div style={{ padding: "24px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 20, marginBottom: 6 }}>🔒</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}>{rc("kbDenied")}</div>
            </div>
          ) : !conv ? (
            <div style={{ padding: "24px 10px", textAlign: "center", color: "#9ca3af", fontSize: 11.5 }}>
              {rc("kbNoConv")}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                <input
                  value={kbQuery}
                  onChange={(e) => setKbQuery(e.target.value)}
                  placeholder={rc("kbSearch")}
                  onKeyDown={(e) => e.key === "Enter" && handleKbKeywordSearch()}
                  style={{
                    flex: 1,
                    fontSize: 11.5,
                    padding: "5px 8px",
                    borderRadius: 6,
                    border: "0.5px solid #e8e6e0",
                    background: "#fff",
                    outline: "none",
                    boxSizing: "border-box",
                  }}
                />
                <button
                  onClick={handleKbKeywordSearch}
                  disabled={kbConnState === "loading" || !kbQuery.trim()}
                  style={{
                    ...btnSm,
                    color: kbConnState === "loading" || !kbQuery.trim() ? "#d1d5db" : "#374151",
                    cursor: kbConnState === "loading" || !kbQuery.trim() ? "not-allowed" : "pointer",
                  }}
                >
                  {rc("kbSearchBtn")}
                </button>
                <button
                  onClick={handleKbRefresh}
                  disabled={kbConnState === "loading"}
                  style={{
                    ...btnSm,
                    color: kbConnState === "loading" ? "#d1d5db" : "#374151",
                    cursor: kbConnState === "loading" ? "not-allowed" : "pointer",
                  }}
                >
                  ↻
                </button>
              </div>
              {kbConnState === "loading" && (
                <div style={{ textAlign: "center", color: "#888", padding: 16, fontSize: 11.5 }}>{rc("kbLoading")}</div>
              )}
              {kbConnState !== "loading" && kbError && (
                <div style={{ color: "#ef4444", padding: "6px 0", fontSize: 11.5 }}>{kbError}</div>
              )}
              {kbConnState === "empty" && !kbError && (
                <div style={{ padding: "20px 10px", textAlign: "center" }}>
                  <div style={{ fontSize: 18, marginBottom: 4 }}>📚</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>{rc("kbEmpty")}</div>
                  <div style={{ fontSize: 10.5, color: "#9ca3af", marginTop: 3 }}>{rc("kbEmptySub")}</div>
                </div>
              )}
              {kbConnState === "idle" && !kbError && (
                <div style={{ padding: "20px 10px", textAlign: "center", color: "#9ca3af", fontSize: 11.5 }}>
                  {rc("kbNoConv")}
                </div>
              )}
              {kbResults.map((r, i) => (
                <div key={i} style={cardStyle}>
                  <div
                    style={{ display: "flex", justifyContent: "space-between", alignItems: "start", marginBottom: 3 }}
                  >
                    <div style={{ fontWeight: 600, fontSize: 11, color: "#1a1a1a", flex: 1 }}>{r.display_label}</div>
                    <span
                      style={{
                        fontSize: 9,
                        background: "#ede9fe",
                        color: "#6366f1",
                        padding: "1px 5px",
                        borderRadius: 6,
                        flexShrink: 0,
                        marginLeft: 4,
                      }}
                    >
                      {r.source_type}
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, color: "#555", lineHeight: 1.5, marginBottom: 4 }}>
                    {r.content.slice(0, 200)}
                    {r.content.length > 200 ? "..." : ""}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 9.5, color: "#888" }}>
                      {rc("kbScore")}: {(r.score * 100).toFixed(0)}%
                    </span>
                    <div style={{ display: "flex", gap: 3 }}>
                      <button onClick={() => handleCopy(r.content)} style={btnSm}>
                        {rc("kbCopy")}
                      </button>
                      <button
                        onClick={() => onInsertDraft(r.content)}
                        style={{ ...btnSm, color: "#2563eb", borderColor: "#2563eb" }}
                      >
                        {rc("kbInsert")}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </>
          ))}
        {/* Policy tab */}
        {tab === "policy" &&
          (!canAccessKb ? (
            <div style={{ padding: "24px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 20, marginBottom: 6 }}>🔒</div>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 4 }}>{rc("polDenied")}</div>
            </div>
          ) : !conv ? (
            <div style={{ padding: "24px 10px", textAlign: "center", color: "#9ca3af", fontSize: 11.5 }}>
              {rc("polNoContent")}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                <button
                  onClick={() => {
                    setPolMode("conv");
                    if (boundedContext.trim()) {
                      const rid = ++polReqIdRef.current;
                      runPolicyCheck(boundedContext, rid);
                    }
                  }}
                  disabled={polLoading || !boundedContext.trim()}
                  style={{
                    ...btnSm,
                    background: polMode === "conv" ? "#faf5ff" : "#fff",
                    borderColor: polMode === "conv" ? "#8b5cf6" : "#e5e7eb",
                    color: polLoading || !boundedContext.trim() ? "#d1d5db" : "#374151",
                    cursor: polLoading || !boundedContext.trim() ? "not-allowed" : "pointer",
                  }}
                >
                  {rc("polCheckConv")}
                </button>
                <button
                  onClick={() => {
                    setPolMode("draft");
                    if (!draftText.trim()) {
                      setPolError(rc("polDraftEmpty"));
                      return;
                    }
                    const rid = ++polReqIdRef.current;
                    runPolicyCheck(draftText, rid);
                  }}
                  disabled={polLoading}
                  style={{
                    ...btnSm,
                    background: polMode === "draft" ? "#faf5ff" : "#fff",
                    borderColor: polMode === "draft" ? "#8b5cf6" : "#e5e7eb",
                    color: polLoading ? "#d1d5db" : "#374151",
                    cursor: polLoading ? "not-allowed" : "pointer",
                  }}
                >
                  {rc("polCheckDraft")}
                </button>
              </div>
              {polLoading && (
                <div style={{ textAlign: "center", color: "#888", padding: 16, fontSize: 11.5 }}>
                  {rc("polLoading")}
                </div>
              )}
              {!polLoading && polError && (
                <div style={{ color: "#ef4444", padding: "6px 0", fontSize: 11.5 }}>{polError}</div>
              )}
              {!polLoading && !polError && !polResult && (
                <div style={{ padding: "20px 10px", textAlign: "center" }}>
                  <div style={{ fontSize: 18, marginBottom: 4 }}>📋</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: "#374151" }}>
                    {lang === "zh" ? "政策檢查" : "Policy Check"}
                  </div>
                  <div style={{ fontSize: 10.5, color: "#9ca3af", marginTop: 3 }}>{rc("polNoContent")}</div>
                </div>
              )}
              {polResult && (
                <div>
                  <div
                    style={{
                      background:
                        polResult.status === "compliant"
                          ? "#f0fdf4"
                          : polResult.status === "insufficient_evidence"
                            ? "#f9fafb"
                            : "#fef3c7",
                      border:
                        "1px solid " +
                        (polResult.status === "compliant"
                          ? "#bbf7d0"
                          : polResult.status === "insufficient_evidence"
                            ? "#e5e7eb"
                            : "#fde68a"),
                      borderRadius: 6,
                      padding: "8px 10px",
                      marginBottom: 6,
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        fontSize: 11,
                        textTransform: "uppercase",
                        marginBottom: 3,
                        color:
                          polResult.status === "compliant"
                            ? "#166534"
                            : polResult.status === "violation"
                              ? "#991b1b"
                              : "#92400e",
                      }}
                    >
                      {polResult.status}
                    </div>
                    <div style={{ fontSize: 11, lineHeight: 1.5, color: "#374151" }}>{polResult.summary}</div>
                  </div>
                  {polResult.status !== "insufficient_evidence" && (
                    <div style={{ fontSize: 9.5, color: "#888", fontStyle: "italic", marginBottom: 4 }}>
                      {rc("polSrcNote")}
                    </div>
                  )}
                  {polResult.issues.map((iss, i) => (
                    <div
                      key={i}
                      style={{
                        marginBottom: 3,
                        fontSize: 10.5,
                        padding: "3px 6px",
                        background: iss.severity === "violation" ? "#fef2f2" : "#fffbeb",
                        borderRadius: 4,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{iss.severity}:</span> {iss.excerpt}{" "}
                      <span style={{ color: "#888" }}>({iss.policy_label})</span>
                    </div>
                  ))}
                  <button onClick={() => handleCopy(polResult.summary)} style={{ ...btnSm, marginTop: 4 }}>
                    {rc("polCopySummary")}
                  </button>
                </div>
              )}
            </>
          ))}
      </div>
    </div>
  );
}
