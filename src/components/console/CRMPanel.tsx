import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { useCustomerContext } from "@/lib/customer360/useCustomerContext";
import { deriveContextualKbAutoQuery } from "@/lib/console/contextualKbQuery";

export type CRMConv = {
  id: string;
  status: string;
  channel_config: { name: string } | null;
  visitor_session_id: string | null;
};

export type CtxMsg = {
  id: string;
  role: string;
  content: string;
  status: string | null;
  is_recalled: boolean;
  created_at: string | null;
};

export type KBResult = {
  display_label: string;
  content: string;
  score: number;
  source_type: string;
  document_id?: string;
  chunk_type?: "rag_summary" | "full_content" | "faq_pair" | "section" | "unknown";
};

export type PolicyResult = {
  status: string;
  summary: string;
  issues: Array<{ excerpt: string; policy_label: string; severity: string }>;
};

export type KBConnState =
  | "idle"
  | "loading"
  | "connected"
  | "empty"
  | "denied"
  | "unavailable";

export const RIGHT_COPY = {
  kbSearch: { en: "Search knowledge base...", zh: "搜尋知識庫..." },
  kbSearchBtn: { en: "Search", zh: "搜尋" },
  kbRefresh: { en: "Refresh", zh: "重新整理" },
  kbCopy: { en: "Copy", zh: "複製" },
  kbInsert: { en: "Insert into Draft", zh: "插入草稿" },
  kbSummaryOnly: {
    en: "Summary only — use full content for draft insertion",
    zh: "僅供摘要參考 — 插入草稿請使用完整內容",
  },
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
  polKbUnavailable: {
    en: "Knowledge base unavailable — policy check not performed",
    zh: "知識庫目前無法使用 — 未執行政策檢查",
  },
  polKbTenantUnresolved: {
    en: "Knowledge scope is not configured for this conversation",
    zh: "此對話尚未設定可驗證的知識庫租戶範圍",
  },
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
  customerTab: { en: "Customer", zh: "客戶" },
  customerLoading: { en: "Loading…", zh: "載入中…" },
  customerUnavailable: { en: "Customer context unavailable.", zh: "客戶上下文目前無法使用。" },
  customerEmpty: { en: "No customer context available.", zh: "目前沒有客戶上下文資料。" },
  evaluationLabel: { en: "Evaluation", zh: "評估" },
  externalCrmNotice: {
    en: "Order history, loyalty status, and CRM trust score require an external CRM integration. No authoritative source currently exists in this repository.",
    zh: "訂單紀錄、會員忠誠狀態及 CRM 信任分數需要外部 CRM 整合。目前此系統沒有可用的權威資料來源。",
  },
  quickActions: { en: "Quick Actions", zh: "快速操作" },
  resolveTicket: { en: "Resolve Ticket", zh: "解決對話" },
} as const;
export type RCK = keyof typeof RIGHT_COPY;

export const MAX_CONTEXT_MESSAGES = 5;
export const CONTEXT_SEPARATOR = " / ";
export const EFFECTIVE_QUERY_CAP = 500;

export function buildBoundedContext(messages: CtxMsg[]): string {
  const eligible = messages.filter(
    (m) =>
      m.role === "visitor" &&
      !m.is_recalled &&
      typeof m.content === "string" &&
      m.content.trim().length > 0 &&
      m.content !== "__THINKING__",
  );
  if (eligible.length === 0) return "";
  const recent = eligible.slice(-MAX_CONTEXT_MESSAGES);
  while (recent.length > 1) {
    const totalLen =
      recent.reduce((s, m) => s + m.content.trim().length, 0) +
      (recent.length - 1) * CONTEXT_SEPARATOR.length;
    if (totalLen <= EFFECTIVE_QUERY_CAP) break;
    recent.shift();
  }
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
      (m) =>
        m.role === "visitor" &&
        !m.is_recalled &&
        typeof m.content === "string" &&
        m.content.trim().length > 0 &&
        m.content !== "__THINKING__",
    )
    .slice(-MAX_CONTEXT_MESSAGES);
  if (eligible.length === 0) return conversationId + ":empty";
  return (
    conversationId +
    ":" +
    eligible
      .map((m) =>
        [m.id, m.created_at ?? "", m.status ?? "", String(m.is_recalled), m.content.trim()].join("|")
      )
      .join("~")
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeKBResults(value: unknown): KBResult[] | null {
  if (!Array.isArray(value)) return null;
  const out: KBResult[] = [];
  for (const raw of value) {
    const r = asRecord(raw);
    if (!r || typeof r.content !== "string" || !r.content.trim()) continue;
    const scoreRaw = Number(r.score);
    if (!Number.isFinite(scoreRaw)) continue;
    const chunkRaw = String(r.chunk_type ?? "unknown");
    const chunk_type =
      ["rag_summary", "full_content", "faq_pair", "section"].includes(chunkRaw)
        ? chunkRaw as KBResult["chunk_type"]
        : "unknown";
    out.push({
      display_label:
        typeof r.display_label === "string" && r.display_label.trim()
          ? r.display_label.trim().slice(0, 180)
          : "Knowledge Base document",
      content: r.content,
      score: Math.max(0, Math.min(1, scoreRaw)),
      source_type:
        typeof r.source_type === "string" && r.source_type.trim()
          ? r.source_type.trim().slice(0, 80)
          : "knowledge",
      ...(typeof r.document_id === "string" ? { document_id: r.document_id } : {}),
      chunk_type,
    });
  }
  return out;
}

/* --------------------------- UI relevance contract -------------------------- */

/**
 * Conservative hard display threshold for the right-hand Knowledge panel.
 * Selected-document/full-content evidence is a ranking preference only; it can
 * never lower the acceptance threshold because doing so would present a weak or
 * unrelated retrieval as contextually relevant evidence.
 */
export const KB_UI_MIN_RELEVANCE = 0.75;

export function filterRelevantKBResults(
  results: KBResult[],
  selectedDocumentId: string | null,
): KBResult[] {
  const kept = results.filter((r) => r.score >= KB_UI_MIN_RELEVANCE);
  const rank = (r: KBResult) => {
    if (!!selectedDocumentId && r.document_id === selectedDocumentId) return 0;
    if (r.chunk_type === "full_content") return 1;
    return 2;
  };
  return kept.sort((a, b) => rank(a) - rank(b) || b.score - a.score);
}

/**
 * The auto-search query is the latest meaningful visitor turn, not the whole
 * bounded window: concatenating five unrelated turns retrieves documents for
 * topics the customer already left behind. The bounded context remains the
 * fallback when the latest turn is too short to be a query on its own.
 */
export const KB_AUTO_QUERY_MIN_CHARS = 6;

export function deriveAutoSearchQuery(boundedContext: string): string {
  return deriveContextualKbAutoQuery(boundedContext);
}

export function normalizePolicyResult(value: unknown): PolicyResult | null {
  const r = asRecord(value);
  if (!r || typeof r.status !== "string" || typeof r.summary !== "string") return null;
  const issues: PolicyResult["issues"] = [];
  if (Array.isArray(r.issues)) {
    for (const raw of r.issues) {
      const i = asRecord(raw);
      if (!i) continue;
      issues.push({
        excerpt: typeof i.excerpt === "string" ? i.excerpt.slice(0, 800) : "",
        policy_label:
          typeof i.policy_label === "string" && i.policy_label.trim()
            ? i.policy_label.trim().slice(0, 160)
            : "Policy",
        severity:
          typeof i.severity === "string" && i.severity.trim()
            ? i.severity.trim().slice(0, 60)
            : "warning",
      });
    }
  }
  return {
    status: r.status.slice(0, 80),
    summary: r.summary.slice(0, 3000),
    issues,
  };
}

function getInitials(label: string) {
  return label
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

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
  const [kbResults, setKbResults] = useState<KBResult[]>([]);
  const [kbConnState, setKbConnState] = useState<KBConnState>("idle");
  const [kbError, setKbError] = useState("");
  const [kbQuery, setKbQuery] = useState("");
  const kbReqIdRef = useRef(0);
  const lastAutoQueryRef = useRef("");
  const [polResult, setPolResult] = useState<PolicyResult | null>(null);
  const [polLoading, setPolLoading] = useState(false);
  const [polError, setPolError] = useState("");
  const [polMode, setPolMode] = useState<"conv" | "draft">("conv");
  const polReqIdRef = useRef(0);

  const canAccessKb = currentRole === "admin" || currentRole === "supervisor";
  const custCtx = useCustomerContext(conv?.visitor_session_id ?? null);

  const runKbSearch = useCallback(
    async (query: string, reqId: number, queryMode: "manual" | "auto_context" = "manual") => {
      if (!query.trim()) return;
      setKbConnState("loading");
      setKbError("");
      setKbResults([]);
      try {
        const { data, error } = await supabase.functions.invoke("kb-search-proxy", {
          body: { query: query.trim().slice(0, 500), top_k: 3, conversation_id: conv?.id, query_mode: queryMode },
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
        if (!data?.success) {
          setKbConnState("unavailable");
          setKbError(rc("kbError"));
          return;
        }
        const normalized = normalizeKBResults(data.results);
        if (normalized === null || (Array.isArray(data.results) && data.results.length > 0 && normalized.length === 0)) {
          setKbConnState("unavailable");
          setKbError(rc("kbError"));
          return;
        }
        const relevant = filterRelevantKBResults(
          normalized,
          typeof data.selected_document_id === "string" ? data.selected_document_id : null,
        );
        setKbResults(relevant);
        setKbConnState(relevant.length > 0 ? "connected" : "empty");
      } catch {
        if (kbReqIdRef.current !== reqId) return;
        setKbConnState("unavailable");
        setKbError(rc("kbError"));
      }
    },
    [conv?.id, rc],
  );

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

  useEffect(() => {
    if (!conv || !boundedContext || !canAccessKb) return;
    if (lastAutoQueryRef.current === contextRevisionKey) return;
    lastAutoQueryRef.current = contextRevisionKey;
    setKbResults([]);
    setKbError("");
    const autoQuery = deriveAutoSearchQuery(boundedContext);
    if (!autoQuery) {
      setKbConnState("empty");
      return;
    }
    void runKbSearch(autoQuery, ++kbReqIdRef.current, "auto_context");
  }, [conv, boundedContext, contextRevisionKey, canAccessKb, runKbSearch]);

  const runPolicyCheck = async (content: string, reqId: number) => {
    if (!content.trim() || !canAccessKb) return;
    setPolLoading(true);
    setPolError("");
    setPolResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("agent-assist", {
        body: {
          tool_type: "check_policy",
          conversation_id: conv?.id ?? "",
          content: content.trim().slice(0, 2000),
          context_mode: "conversation",
        },
      });
      if (polReqIdRef.current !== reqId) return;
      if (error || !data?.success) {
        setPolError(
          data?.error === "policy_kb_tenant_unresolved"
            ? rc("polKbTenantUnresolved")
            : data?.error === "policy_kb_unavailable"
              ? rc("polKbUnavailable")
              : rc("polError"),
        );
      } else {
        const normalized = normalizePolicyResult(data.result);
        if (!normalized) setPolError(rc("polError"));
        else setPolResult(normalized);
      }
    } catch {
      if (polReqIdRef.current === reqId) setPolError(rc("polError"));
    } finally {
      if (polReqIdRef.current === reqId) setPolLoading(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(rc("copied")))
      .catch(() => toast.error(rc("copyFailed")));
  };

  const initials = getInitials(visitorLabel);
  const sectionTitle: CSSProperties = {
    fontSize: 10,
    fontWeight: 700,
    color: "#888",
    textTransform: "uppercase",
    marginBottom: 6,
  };
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
    ? lang === "zh" ? "權限不足" : "Permission denied"
    : kbConnState === "loading"
      ? lang === "zh" ? "載入中" : "Loading"
      : kbConnState === "connected" || kbConnState === "empty"
        ? lang === "zh" ? "已連線" : "Connected"
        : kbConnState === "denied"
          ? lang === "zh" ? "權限不足" : "Permission denied"
          : kbConnState === "unavailable"
            ? lang === "zh" ? "無法存取" : "Unavailable"
            : lang === "zh" ? "就緒" : "Ready";

  const TABS = [
    { key: "customer", label: rc("customerTab") },
    { key: "knowledge", label: lang === "zh" ? "知識" : "Knowledge" },
    { key: "policy", label: lang === "zh" ? "政策" : "Policy" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "#fff" }}>
      <div style={{ padding: "8px 12px", borderBottom: "0.5px solid #e8e6e0", fontSize: 10, color: "#555" }}>
        Knowledge Base: {kbStatusLabel}
      </div>
      <div style={{ display: "flex", borderBottom: "0.5px solid #e8e6e0", overflowX: "auto" }}>
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
              color: tab === tb.key ? "#1a1a1a" : "#888",
              borderBottom: tab === tb.key ? "2px solid #1a1a1a" : "2px solid transparent",
            }}
          >
            {tb.label}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {tab === "customer" && conv && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#fef3c7", color: "#92400e", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700 }}>
                {initials}
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{visitorLabel}</div>
                <div style={{ fontSize: 10.5, color: "#888" }}>
                  {conv.channel_config?.name || "Web"} · #{conv.id.slice(0, 8)}
                </div>
              </div>
            </div>

            {custCtx.status === "loading" && <div style={{ fontSize: 11, color: "#9ca3af" }}>{rc("customerLoading")}</div>}
            {custCtx.status === "error" && <div style={{ fontSize: 11, color: "#ef4444" }}>{rc("customerUnavailable")}</div>}
            {custCtx.status === "empty" && <div style={{ fontSize: 11, color: "#9ca3af" }}>{rc("customerEmpty")}</div>}
            {custCtx.status === "success" && (
              <>
                {custCtx.data.evaluations.find((e) => e.conversation_id === conv.id) && (
                  <div style={cardStyle}>
                    {(() => {
                      const ev = custCtx.data.evaluations.find((e) => e.conversation_id === conv.id)!;
                      return <div style={{ fontSize: 10.5, fontWeight: 600 }}>{rc("evaluationLabel")}: {ev.overall_score} · {ev.severity} · {ev.review_status}</div>;
                    })()}
                  </div>
                )}
                {custCtx.data.feedback.find((f) => f.conversation_id === conv.id && f.rating !== null) && (
                  <div style={cardStyle}>
                    {(() => {
                      const fb = custCtx.data.feedback.find((f) => f.conversation_id === conv.id && f.rating !== null)!;
                      const rating = Math.max(0, Math.min(5, Number(fb.rating ?? 0)));
                      return <div style={{ fontSize: 10.5 }}>{"★".repeat(rating)}{"☆".repeat(5 - rating)} {rating}/5{fb.feedback_text ? " — " + fb.feedback_text : ""}</div>;
                    })()}
                  </div>
                )}
              </>
            )}

            <div style={{ background: "#f5f4f0", borderRadius: 9, padding: "12px 14px", marginBottom: 12, fontSize: 11, color: "#555", lineHeight: 1.6 }}>
              {rc("externalCrmNotice")}
            </div>
            <div style={sectionTitle}>{rc("quickActions")}</div>
            <button type="button" onClick={onResolve} style={{ ...btnSm, display: "block", width: "100%", textAlign: "left", color: "#ef4444", padding: "7px 11px" }}>
              {rc("resolveTicket")}
            </button>
          </>
        )}

        {tab === "knowledge" && (
          !canAccessKb ? (
            <div style={{ padding: 24, textAlign: "center" }}>{rc("kbDenied")}</div>
          ) : !conv ? (
            <div style={{ padding: 24, textAlign: "center", color: "#9ca3af" }}>{rc("kbNoConv")}</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                <input
                  value={kbQuery}
                  onChange={(e) => setKbQuery(e.target.value)}
                  placeholder={rc("kbSearch")}
                  onKeyDown={(e) => e.key === "Enter" && kbQuery.trim() && void runKbSearch(kbQuery, ++kbReqIdRef.current)}
                  style={{ flex: 1, fontSize: 11.5, padding: "5px 8px", borderRadius: 6, border: "0.5px solid #e8e6e0" }}
                />
                <button disabled={kbConnState === "loading" || !kbQuery.trim()} onClick={() => void runKbSearch(kbQuery, ++kbReqIdRef.current)} style={btnSm}>{rc("kbSearchBtn")}</button>
                <button disabled={kbConnState === "loading"} onClick={() => {
                  const q = kbQuery.trim() || deriveAutoSearchQuery(boundedContext);
                  if (q) void runKbSearch(q, ++kbReqIdRef.current, kbQuery.trim() ? "manual" : "auto_context");
                }} style={btnSm}>↻</button>
              </div>
              {kbConnState === "loading" && <div style={{ textAlign: "center", color: "#888", padding: 16 }}>{rc("kbLoading")}</div>}
              {kbError && <div style={{ color: "#ef4444", padding: "6px 0" }}>{kbError}</div>}
              {kbConnState === "empty" && !kbError && <div style={{ padding: 20, textAlign: "center" }}>{rc("kbEmpty")}</div>}

              {kbResults.map((r, i) => (
                <div key={`${r.document_id ?? "doc"}-${i}`} style={cardStyle}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                    <div style={{ fontWeight: 600, fontSize: 11 }}>{r.display_label}</div>
                    <span style={{ fontSize: 9, color: "#6366f1" }}>
                      {r.chunk_type === "rag_summary" ? "summary" : r.chunk_type === "full_content" ? "full content" : r.source_type}
                    </span>
                  </div>
                  <div style={{ fontSize: 10.5, color: "#555", lineHeight: 1.5 }}>
                    {r.content.slice(0, 200)}{r.content.length > 200 ? "..." : ""}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 9.5, color: "#888" }}>{rc("kbScore")}: {(r.score * 100).toFixed(0)}%</span>
                    <div style={{ display: "flex", gap: 3 }}>
                      <button onClick={() => handleCopy(r.content)} style={btnSm}>{rc("kbCopy")}</button>
                      {r.chunk_type === "full_content" ? (
                        <button onClick={() => onInsertDraft(r.content)} style={{ ...btnSm, color: "#2563eb", borderColor: "#2563eb" }}>{rc("kbInsert")}</button>
                      ) : r.chunk_type === "rag_summary" ? (
                        <span style={{ fontSize: 9.5, color: "#9ca3af", fontStyle: "italic" }}>{rc("kbSummaryOnly")}</span>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
            </>
          )
        )}

        {tab === "policy" && (
          !canAccessKb ? (
            <div style={{ padding: 24, textAlign: "center" }}>{rc("polDenied")}</div>
          ) : !conv ? (
            <div style={{ padding: 24, textAlign: "center", color: "#9ca3af" }}>{rc("polNoContent")}</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                <button
                  style={{ ...btnSm, background: polMode === "conv" ? "#faf5ff" : "#fff" }}
                  disabled={polLoading || !boundedContext.trim()}
                  onClick={() => {
                    setPolMode("conv");
                    if (boundedContext.trim()) void runPolicyCheck(boundedContext, ++polReqIdRef.current);
                  }}
                >
                  {rc("polCheckConv")}
                </button>
                <button
                  style={{ ...btnSm, background: polMode === "draft" ? "#faf5ff" : "#fff" }}
                  disabled={polLoading}
                  onClick={() => {
                    setPolMode("draft");
                    if (!draftText.trim()) setPolError(rc("polDraftEmpty"));
                    else void runPolicyCheck(draftText, ++polReqIdRef.current);
                  }}
                >
                  {rc("polCheckDraft")}
                </button>
              </div>
              {polLoading && <div style={{ textAlign: "center", color: "#888", padding: 16 }}>{rc("polLoading")}</div>}
              {polError && <div style={{ color: "#ef4444", padding: "6px 0" }}>{polError}</div>}
              {!polLoading && !polError && !polResult && <div style={{ padding: 20, textAlign: "center" }}>{rc("polNoContent")}</div>}
              {polResult && (
                <div>
                  <div style={{ ...cardStyle, background: polResult.status === "compliant" ? "#f0fdf4" : polResult.status === "insufficient_evidence" ? "#f9fafb" : "#fef3c7" }}>
                    <div style={{ fontWeight: 600, fontSize: 11, textTransform: "uppercase" }}>{polResult.status}</div>
                    <div style={{ fontSize: 11, lineHeight: 1.5 }}>{polResult.summary}</div>
                  </div>
                  {polResult.issues.map((iss, i) => (
                    <div key={i} style={{ marginBottom: 3, fontSize: 10.5, padding: "3px 6px", background: iss.severity === "violation" ? "#fef2f2" : "#fffbeb", borderRadius: 4 }}>
                      <span style={{ fontWeight: 600 }}>{iss.severity}:</span> {iss.excerpt} <span style={{ color: "#888" }}>({iss.policy_label})</span>
                    </div>
                  ))}
                  <button onClick={() => handleCopy(polResult.summary)} style={{ ...btnSm, marginTop: 4 }}>{rc("polCopySummary")}</button>
                </div>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}
