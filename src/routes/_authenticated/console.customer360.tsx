import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { supabase } from "@/integrations/supabase/client";
import {
  AlertCircle,
  Loader2,
  MessageSquare,
  Users,
  UserCircle2,
  PlugZap,
  Search,
  Star,
  ClipboardCheck,
  Radio,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/console/customer360")({
  component: Customer360Guard,
});

// ─── Copy ──────────────────────────────────────────────────────────────────
const COPY = {
  title: { en: "Customer 360", zh: "客戶全景" },
  subtitle: {
    en: "Customer and visitor context overview for the current workspace",
    zh: "目前工作區的客戶與訪客上下文概覽",
  },
  crmTitle: { en: "CRM integration required", zh: "需要 CRM 整合" },
  crmBody: {
    en: "Order history, lifetime value, and CRM tier require an external CRM connection. This page shows only real conversation, feedback, and evaluation data currently stored in this system.",
    zh: "訂單紀錄、終身價值與 CRM 等級需要外部 CRM 連接。本頁僅顯示系統中實際儲存的對話、回饋與評估資料。",
  },
  degraded: { en: "Degraded — no CRM connected", zh: "降級 — 尚未連接 CRM" },
  totalConversations: { en: "Total Conversations", zh: "總對話數" },
  totalSessions: { en: "Visitor Sessions", zh: "訪客工作階段" },
  evaluated: { en: "Evaluated Conversations", zh: "已評估對話" },
  feedbackReceived: { en: "Feedback Received", zh: "收到回饋" },
  searchPh: { en: "Search visitors...", zh: "搜尋訪客..." },
  noVisitors: { en: "No visitors found", zh: "找不到訪客" },
  selectVisitor: { en: "Select a visitor to view context", zh: "選取訪客以查看上下文" },
  firstSeen: { en: "First seen", zh: "首次出現" },
  lastSeen: { en: "Last seen", zh: "最近出現" },
  channel: { en: "Channel", zh: "管道" },
  tabOverview: { en: "Overview", zh: "概覽" },
  tabConversations: { en: "Conversations", zh: "對話紀錄" },
  tabFeedback: { en: "Feedback", zh: "客戶回饋" },
  tabEvaluation: { en: "Evaluation", zh: "對話評估" },
  identityNote: {
    en: "Identity fields below are only shown if the visitor voluntarily provided them via the widget form. No data is inferred or purchased.",
    zh: "以下身份欄位僅在訪客透過 Widget 表單主動提供時顯示，不進行任何推斷或購買資料。",
  },
  noIdentity: { en: "No visitor-provided identity data", zh: "訪客未提供身份資料" },
  sessionRef: { en: "Session Reference", zh: "工作階段參照" },
  convId: { en: "Conversation", zh: "對話" },
  status: { en: "Status", zh: "狀態" },
  assignedAgent: { en: "Assigned Agent", zh: "指派客服" },
  created: { en: "Created", zh: "建立時間" },
  noConversations: { en: "No conversations for this visitor", zh: "此訪客暫無對話紀錄" },
  noFeedback: { en: "No feedback submitted yet", zh: "尚未收到回饋" },
  noEvaluation: {
    en: "No evaluation available yet for this visitor's conversations",
    zh: "此訪客的對話目前尚無評估結果",
  },
  rating: { en: "Rating", zh: "評分" },
  feedbackText: { en: "Comment", zh: "留言" },
  overallScore: { en: "Overall Score", zh: "整體分數" },
  severity: { en: "Severity", zh: "嚴重程度" },
  reviewStatus: { en: "Review Status", zh: "覆核狀態" },
  viewConversation: { en: "View conversation →", zh: "查看對話 →" },
  error: { en: "Failed to load customer context", zh: "無法載入客戶上下文" },
  errorSub: { en: "Please try again later", zh: "請稍後再試" },
  loading: { en: "Loading...", zh: "載入中..." },
  unassigned: { en: "Unassigned", zh: "未指派" },
  na: { en: "N/A", zh: "無資料" },
} as const;
type CopyKey = keyof typeof COPY;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getVisitorLabel(meta: unknown, sessionId: string): string {
  const m = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
  const name = typeof m.name === "string" ? m.name.trim() : "";
  const email = typeof m.email === "string" ? m.email.trim() : "";
  if (name) return name;
  if (email) return email;
  return `Visitor #${sessionId.slice(0, 8)}`;
}
function initials(label: string) {
  return (label || "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
function severityColor(sev: string | null) {
  if (sev === "critical") return { bg: "#fee2e2", color: "#991b1b" };
  if (sev === "high") return { bg: "#ffedd5", color: "#c2410c" };
  if (sev === "medium") return { bg: "#fef3c7", color: "#92400e" };
  if (sev === "low") return { bg: "#dcfce7", color: "#166534" };
  return { bg: "#f1f5f9", color: "#64748b" };
}
function statusColor(s: string) {
  if (s === "resolved") return { bg: "#dcfce7", color: "#166534" };
  if (s === "open" || s === "ai_handling") return { bg: "#dbeafe", color: "#1e40af" };
  if (s === "pending" || s === "human_needed" || s === "escalation_risk") return { bg: "#fef3c7", color: "#92400e" };
  return { bg: "#f1f5f9", color: "#475569" };
}
const card: CSSProperties = {
  background: "#fff",
  border: "1px solid #e8e6e0",
  borderRadius: 10,
  padding: "16px",
};

// ─── Guard ───────────────────────────────────────────────────────────────────
function Customer360Guard() {
  const { role, loading } = useCurrentRole();
  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "60vh" }}>
        <Loader2 size={24} className="animate-spin" style={{ color: "#888" }} />
      </div>
    );
  }
  if (!role || (role !== "admin" && role !== "supervisor")) {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "60vh",
          gap: 12,
        }}
      >
        <AlertCircle size={40} style={{ color: "#ef4444" }} />
        <div style={{ fontSize: 16, fontWeight: 600, color: "#374151" }}>Permission Denied / 權限不足</div>
        <div style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", maxWidth: 360, lineHeight: 1.6 }}>
          Only Admin and Supervisor roles can access Customer 360.
          <br />
          僅限 Admin 和 Supervisor 角色存取客戶全景。
        </div>
      </div>
    );
  }
  return <Customer360Content />;
}

// ─── Types ───────────────────────────────────────────────────────────────────
type VisitorRow = {
  id: string;
  created_at: string | null;
  last_seen_at: string | null;
  visitor_metadata: unknown;
  channel_name: string | null;
  conv_count: number;
};
type ConvRow = {
  id: string;
  status: string;
  created_at: string | null;
  channel_name: string | null;
  assigned_agent_name: string | null;
};
type FeedbackRow = {
  id: string;
  rating: number | null;
  feedback_text: string | null;
  created_at: string;
  conversation_id: string;
};
type EvalRow = {
  id: string;
  conversation_id: string;
  overall_score: number;
  severity: string;
  review_status: string;
  created_at: string;
};

// ─── Main content ──────────────────────────────────────────────────────────
function Customer360Content() {
  const lang = useConsoleLang();
  const t = (key: CopyKey) => COPY[key]?.[lang] ?? COPY[key]?.en ?? key;

  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [convCount, setConvCount] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);
  const [evaluatedCount, setEvaluatedCount] = useState(0);
  const [feedbackCount, setFeedbackCount] = useState(0);
  const [visitors, setVisitors] = useState<VisitorRow[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"overview" | "conversations" | "feedback" | "evaluation">("overview");

  const [detailLoading, setDetailLoading] = useState(false);
  const [detailConvs, setDetailConvs] = useState<ConvRow[]>([]);
  const [detailFeedback, setDetailFeedback] = useState<FeedbackRow[]>([]);
  const [detailEval, setDetailEval] = useState<EvalRow[]>([]);

  // ── Load aggregate + visitor list ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [convRes, sessRes, evalRes, fbRes, visitorRes] = await Promise.all([
          supabase.from("conversations").select("id", { count: "exact", head: true }),
          supabase.from("visitor_session").select("id", { count: "exact", head: true }),
          supabase.from("conversation_evaluation").select("id", { count: "exact", head: true }),
          supabase.from("feedback_request").select("id", { count: "exact", head: true }).not("rating", "is", null),
          supabase
            .from("visitor_session")
            .select("id, created_at, last_seen_at, visitor_metadata, channel_config:channel_config_id(name)")
            .order("last_seen_at", { ascending: false })
            .limit(50),
        ]);
        if (cancelled) return;
        if (convRes.error || sessRes.error || visitorRes.error) {
          setStatus("error");
          return;
        }
        setConvCount(convRes.count ?? 0);
        setSessionCount(sessRes.count ?? 0);
        setEvaluatedCount(evalRes.count ?? 0);
        setFeedbackCount(fbRes.count ?? 0);

        const rawVisitors = (visitorRes.data ?? []) as Array<{
          id: string;
          created_at: string | null;
          last_seen_at: string | null;
          visitor_metadata: unknown;
          channel_config: { name: string } | null;
        }>;
        const ids = rawVisitors.map((v) => v.id);
        let countMap: Record<string, number> = {};
        if (ids.length > 0) {
          const { data: convRows } = await supabase
            .from("conversations")
            .select("visitor_session_id")
            .in("visitor_session_id", ids);
          countMap = (convRows ?? []).reduce(
            (acc: Record<string, number>, r: { visitor_session_id: string | null }) => {
              if (r.visitor_session_id) acc[r.visitor_session_id] = (acc[r.visitor_session_id] ?? 0) + 1;
              return acc;
            },
            {},
          );
        }
        if (cancelled) return;
        setVisitors(
          rawVisitors.map((v) => ({
            id: v.id,
            created_at: v.created_at,
            last_seen_at: v.last_seen_at,
            visitor_metadata: v.visitor_metadata,
            channel_name: v.channel_config?.name ?? null,
            conv_count: countMap[v.id] ?? 0,
          })),
        );
        setStatus("success");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Load selected visitor detail (conv-scoped, stale-guarded) ──
  useEffect(() => {
    if (!selectedId) {
      setDetailConvs([]);
      setDetailFeedback([]);
      setDetailEval([]);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setTab("overview");
    (async () => {
      try {
        const { data: convData } = await supabase
          .from("conversations")
          .select("id, status, created_at, channel_config:channel_config_id(name), assigned_agent_id")
          .eq("visitor_session_id", selectedId)
          .order("created_at", { ascending: false });
        if (cancelled) return;

        const rows = (convData ?? []) as Array<{
          id: string;
          status: string;
          created_at: string | null;
          channel_config: { name: string } | null;
          assigned_agent_id: string | null;
        }>;
        const agentIds = [
          ...new Set(rows.filter((r) => r.assigned_agent_id).map((r) => r.assigned_agent_id as string)),
        ];
        let agentMap: Record<string, string> = {};
        if (agentIds.length > 0) {
          const { data: agents } = await supabase.from("agent_profile").select("id, display_name").in("id", agentIds);
          agentMap = (agents ?? []).reduce((acc: Record<string, string>, a: { id: string; display_name: string }) => {
            acc[a.id] = a.display_name;
            return acc;
          }, {});
        }
        if (cancelled) return;
        const convIds = rows.map((r) => r.id);
        setDetailConvs(
          rows.map((r) => ({
            id: r.id,
            status: r.status,
            created_at: r.created_at,
            channel_name: r.channel_config?.name ?? null,
            assigned_agent_name: r.assigned_agent_id ? (agentMap[r.assigned_agent_id] ?? null) : null,
          })),
        );

        const [fbRes, evalRes] = await Promise.all([
          supabase
            .from("feedback_request")
            .select("id, rating, feedback_text, created_at, conversation_id")
            .eq("visitor_session_id", selectedId)
            .order("created_at", { ascending: false }),
          convIds.length > 0
            ? supabase
                .from("conversation_evaluation")
                .select("id, conversation_id, overall_score, severity, review_status, created_at")
                .in("conversation_id", convIds)
                .order("created_at", { ascending: false })
            : Promise.resolve({ data: [] as EvalRow[] }),
        ]);
        if (cancelled) return;
        setDetailFeedback((fbRes.data ?? []) as FeedbackRow[]);
        setDetailEval((evalRes.data ?? []) as EvalRow[]);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const filteredVisitors = useMemo(() => {
    if (!search.trim()) return visitors;
    const q = search.toLowerCase();
    return visitors.filter((v) => {
      const label = getVisitorLabel(v.visitor_metadata, v.id).toLowerCase();
      return label.includes(q) || v.id.toLowerCase().includes(q) || (v.channel_name || "").toLowerCase().includes(q);
    });
  }, [visitors, search]);

  const selectedVisitor = visitors.find((v) => v.id === selectedId) ?? null;
  const selectedLabel = selectedVisitor ? getVisitorLabel(selectedVisitor.visitor_metadata, selectedVisitor.id) : "";
  const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : "—");

  if (status === "loading") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "60vh",
          gap: 12,
        }}
      >
        <Loader2 size={24} className="animate-spin" style={{ color: "#888" }} />
        <div style={{ fontSize: 13, color: "#888" }}>{t("loading")}</div>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          height: "60vh",
          gap: 12,
        }}
      >
        <AlertCircle size={32} style={{ color: "#ef4444" }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: "#374151" }}>{t("error")}</div>
        <div style={{ fontSize: 12, color: "#9ca3af" }}>{t("errorSub")}</div>
      </div>
    );
  }

  const identityFields = (() => {
    if (!selectedVisitor) return [];
    const m = selectedVisitor.visitor_metadata;
    if (!m || typeof m !== "object" || Array.isArray(m)) return [];
    return Object.entries(m as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== "");
  })();

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "#f5f4f0" }}
    >
      <div style={{ padding: "20px 20px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <UserCircle2 size={22} style={{ color: "#2563eb" }} />
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a1a", margin: 0 }}>{t("title")}</h1>
        </div>
        <p style={{ fontSize: 13, color: "#888", margin: "0 0 16px" }}>{t("subtitle")}</p>

        {/* CRM degraded banner */}
        <div
          style={{
            background: "#fffbeb",
            border: "1px solid #fde68a",
            borderRadius: 10,
            padding: "12px 16px",
            marginBottom: 16,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <PlugZap size={16} style={{ color: "#92400e" }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: "#92400e" }}>{t("crmTitle")}</span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 10,
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: 12,
                background: "#fef3c7",
                color: "#92400e",
              }}
            >
              {t("degraded")}
            </span>
          </div>
          <div style={{ fontSize: 12, color: "#78350f", lineHeight: 1.6 }}>{t("crmBody")}</div>
        </div>

        {/* Aggregate cards */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 12,
            marginBottom: 16,
          }}
        >
          {[
            { icon: <MessageSquare size={18} />, label: t("totalConversations"), value: convCount, color: "#16a34a" },
            { icon: <Users size={18} />, label: t("totalSessions"), value: sessionCount, color: "#2563eb" },
            { icon: <ClipboardCheck size={18} />, label: t("evaluated"), value: evaluatedCount, color: "#7c3aed" },
            { icon: <Star size={18} />, label: t("feedbackReceived"), value: feedbackCount, color: "#f59e0b" },
          ].map((c, i) => (
            <div
              key={i}
              style={{ background: "#fff", border: "1px solid #e8e6e0", borderRadius: 10, padding: "14px 16px" }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, color: c.color }}>
                {c.icon}
                <span style={{ fontSize: 11, color: "#888", fontWeight: 600 }}>{c.label}</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, color: "#1a1a1a" }}>{c.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Master-detail */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", padding: "0 20px 20px", gap: 12 }}>
        {/* LEFT: visitor list */}
        <div
          style={{
            width: 300,
            flexShrink: 0,
            ...card,
            padding: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: 10, borderBottom: "1px solid #f3f4f6" }}>
            <div style={{ position: "relative" }}>
              <Search
                size={13}
                style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "#9ca3af" }}
              />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("searchPh")}
                style={{
                  width: "100%",
                  fontSize: 12,
                  padding: "7px 8px 7px 28px",
                  borderRadius: 8,
                  border: "1px solid #e5e7eb",
                  outline: "none",
                  boxSizing: "border-box",
                  background: "#f9fafb",
                }}
              />
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>
            {filteredVisitors.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", fontSize: 12, color: "#9ca3af" }}>{t("noVisitors")}</div>
            )}
            {filteredVisitors.map((v) => {
              const label = getVisitorLabel(v.visitor_metadata, v.id);
              const active = v.id === selectedId;
              return (
                <button
                  key={v.id}
                  onClick={() => setSelectedId(v.id)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "9px 10px",
                    border: "none",
                    borderBottom: "1px solid #f9fafb",
                    background: active ? "#1a1a1a" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: active ? "#374151" : "#eef2ff",
                      color: active ? "#fff" : "#4338ca",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 10.5,
                      fontWeight: 700,
                      flexShrink: 0,
                    }}
                  >
                    {initials(label)}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: active ? "#fff" : "#1a1a1a",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {label}
                    </div>
                    <div style={{ fontSize: 10, color: active ? "rgba(255,255,255,0.6)" : "#9ca3af" }}>
                      {v.channel_name || "—"} · {v.conv_count} conv
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* RIGHT: detail */}
        <div style={{ flex: 1, ...card, padding: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {!selectedVisitor ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              <Users size={28} style={{ color: "#d1d5db" }} />
              <div style={{ fontSize: 13, color: "#9ca3af" }}>{t("selectVisitor")}</div>
            </div>
          ) : (
            <>
              <div
                style={{
                  padding: "14px 16px",
                  borderBottom: "1px solid #e8e6e0",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: "linear-gradient(135deg,#2563eb,#60a5fa)",
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontWeight: 700,
                    fontSize: 13,
                    flexShrink: 0,
                  }}
                >
                  {initials(selectedLabel)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{selectedLabel}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span>
                      <Radio size={10} style={{ display: "inline", marginRight: 3 }} />
                      {selectedVisitor.channel_name || t("na")}
                    </span>
                    <span>
                      {t("firstSeen")}: {fmt(selectedVisitor.created_at)}
                    </span>
                    <span>
                      {t("lastSeen")}: {fmt(selectedVisitor.last_seen_at)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Tabs */}
              <div style={{ display: "flex", borderBottom: "1px solid #e8e6e0", flexShrink: 0 }}>
                {(["overview", "conversations", "feedback", "evaluation"] as const).map((tk) => (
                  <button
                    key={tk}
                    onClick={() => setTab(tk)}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "9px 14px",
                      border: "none",
                      cursor: "pointer",
                      background: "#fff",
                      color: tab === tk ? "#1a1a1a" : "#9ca3af",
                      borderBottom: tab === tk ? "2px solid #1a1a1a" : "2px solid transparent",
                    }}
                  >
                    {t(
                      tk === "overview"
                        ? "tabOverview"
                        : tk === "conversations"
                          ? "tabConversations"
                          : tk === "feedback"
                            ? "tabFeedback"
                            : "tabEvaluation",
                    )}
                    {tk === "conversations" && detailConvs.length > 0 ? ` (${detailConvs.length})` : ""}
                    {tk === "feedback" && detailFeedback.length > 0 ? ` (${detailFeedback.length})` : ""}
                    {tk === "evaluation" && detailEval.length > 0 ? ` (${detailEval.length})` : ""}
                  </button>
                ))}
              </div>

              <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
                {detailLoading ? (
                  <div style={{ display: "flex", justifyContent: "center", padding: 30 }}>
                    <Loader2 size={18} className="animate-spin" style={{ color: "#9ca3af" }} />
                  </div>
                ) : (
                  <>
                    {tab === "overview" && (
                      <div>
                        <div style={{ fontSize: 10, color: "#9ca3af", marginBottom: 10, lineHeight: 1.5 }}>
                          {t("identityNote")}
                        </div>
                        {identityFields.length === 0 ? (
                          <div style={{ padding: "20px 0", textAlign: "center", color: "#9ca3af", fontSize: 12 }}>
                            {t("noIdentity")}
                          </div>
                        ) : (
                          <div style={{ background: "#f9fafb", borderRadius: 8, padding: "10px 12px" }}>
                            {identityFields.map(([k, v]) => (
                              <div
                                key={k}
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  padding: "6px 0",
                                  borderBottom: "1px solid #f1f5f9",
                                  fontSize: 12,
                                }}
                              >
                                <span style={{ color: "#6b7280", textTransform: "capitalize" }}>
                                  {k.replace(/_/g, " ")}
                                </span>
                                <span style={{ color: "#1a1a1a", fontWeight: 500 }}>{String(v)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <div style={{ marginTop: 12, fontSize: 11, color: "#9ca3af" }}>
                          {t("sessionRef")}: <span style={{ fontFamily: "monospace" }}>{selectedVisitor.id}</span>
                        </div>
                      </div>
                    )}

                    {tab === "conversations" &&
                      (detailConvs.length === 0 ? (
                        <div style={{ padding: "20px 0", textAlign: "center", color: "#9ca3af", fontSize: 12 }}>
                          {t("noConversations")}
                        </div>
                      ) : (
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead>
                            <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                              {[t("convId"), t("channel"), t("status"), t("assignedAgent"), t("created")].map((h) => (
                                <th
                                  key={h}
                                  style={{
                                    textAlign: "left",
                                    padding: "6px 8px",
                                    fontSize: 10,
                                    fontWeight: 700,
                                    color: "#94a3b8",
                                    textTransform: "uppercase",
                                  }}
                                >
                                  {h}
                                </th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {detailConvs.map((c) => {
                              const sc = statusColor(c.status);
                              return (
                                <tr key={c.id} style={{ borderBottom: "1px solid #f9fafb" }}>
                                  <td style={{ padding: "8px" }}>
                                    <Link
                                      to="/console/conversations/$id"
                                      params={{ id: c.id }}
                                      style={{
                                        color: "#2563eb",
                                        fontFamily: "monospace",
                                        fontSize: 11,
                                        textDecoration: "none",
                                      }}
                                    >
                                      #{c.id.slice(0, 8)}
                                    </Link>
                                  </td>
                                  <td style={{ padding: "8px", color: "#555" }}>{c.channel_name || "—"}</td>
                                  <td style={{ padding: "8px" }}>
                                    <span
                                      style={{
                                        background: sc.bg,
                                        color: sc.color,
                                        fontSize: 10,
                                        fontWeight: 600,
                                        padding: "2px 8px",
                                        borderRadius: 10,
                                      }}
                                    >
                                      {c.status}
                                    </span>
                                  </td>
                                  <td style={{ padding: "8px", color: "#555" }}>
                                    {c.assigned_agent_name || t("unassigned")}
                                  </td>
                                  <td style={{ padding: "8px", color: "#888" }}>{fmt(c.created_at)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ))}

                    {tab === "feedback" &&
                      (detailFeedback.length === 0 ? (
                        <div style={{ padding: "20px 0", textAlign: "center", color: "#9ca3af", fontSize: 12 }}>
                          {t("noFeedback")}
                        </div>
                      ) : (
                        detailFeedback.map((f) => (
                          <div key={f.id} style={{ ...card, padding: "10px 12px", marginBottom: 8 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                              {f.rating !== null ? (
                                <span style={{ fontSize: 12, color: "#f59e0b", fontWeight: 700 }}>
                                  {"★".repeat(f.rating)}
                                  {"☆".repeat(Math.max(0, 5 - f.rating))} {f.rating}/5
                                </span>
                              ) : (
                                <span style={{ fontSize: 11, color: "#9ca3af" }}>{t("na")}</span>
                              )}
                              <Link
                                to="/console/conversations/$id"
                                params={{ id: f.conversation_id }}
                                style={{ marginLeft: "auto", fontSize: 10.5, color: "#2563eb", textDecoration: "none" }}
                              >
                                {t("viewConversation")}
                              </Link>
                            </div>
                            {f.feedback_text && (
                              <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.5 }}>{f.feedback_text}</div>
                            )}
                            <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 4 }}>{fmt(f.created_at)}</div>
                          </div>
                        ))
                      ))}

                    {tab === "evaluation" &&
                      (detailEval.length === 0 ? (
                        <div style={{ padding: "20px 0", textAlign: "center", color: "#9ca3af", fontSize: 12 }}>
                          {t("noEvaluation")}
                        </div>
                      ) : (
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead>
                            <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
                              {[t("convId"), t("overallScore"), t("severity"), t("reviewStatus"), t("created")].map(
                                (h) => (
                                  <th
                                    key={h}
                                    style={{
                                      textAlign: "left",
                                      padding: "6px 8px",
                                      fontSize: 10,
                                      fontWeight: 700,
                                      color: "#94a3b8",
                                      textTransform: "uppercase",
                                    }}
                                  >
                                    {h}
                                  </th>
                                ),
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {detailEval.map((e) => {
                              const sv = severityColor(e.severity);
                              return (
                                <tr key={e.id} style={{ borderBottom: "1px solid #f9fafb" }}>
                                  <td style={{ padding: "8px" }}>
                                    <Link
                                      to="/console/conversations/$id"
                                      params={{ id: e.conversation_id }}
                                      style={{
                                        color: "#2563eb",
                                        fontFamily: "monospace",
                                        fontSize: 11,
                                        textDecoration: "none",
                                      }}
                                    >
                                      #{e.conversation_id.slice(0, 8)}
                                    </Link>
                                  </td>
                                  <td style={{ padding: "8px", fontWeight: 700, color: "#1a1a1a" }}>
                                    {e.overall_score}
                                  </td>
                                  <td style={{ padding: "8px" }}>
                                    <span
                                      style={{
                                        background: sv.bg,
                                        color: sv.color,
                                        fontSize: 10,
                                        fontWeight: 600,
                                        padding: "2px 8px",
                                        borderRadius: 10,
                                      }}
                                    >
                                      {e.severity}
                                    </span>
                                  </td>
                                  <td style={{ padding: "8px", color: "#555" }}>{e.review_status}</td>
                                  <td style={{ padding: "8px", color: "#888" }}>{fmt(e.created_at)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ))}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
