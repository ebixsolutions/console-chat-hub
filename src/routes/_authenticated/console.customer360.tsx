import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { supabase } from "@/integrations/supabase/client";
import { AlertCircle, Loader2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/console/customer360")({
  component: Customer360Guard,
});

// ─── Copy (bilingual, frozen requirement) ────────────────────────────────────
const COPY = {
  bannerText: {
    en: "A live profile of each visitor — conversations, feedback, and AI evaluation results actually stored in this system. Purchase history, CRM tier, and AI trust scoring require external integrations that are not yet connected.",
    zh: "每位訪客的即時檔案 — 顯示系統中實際儲存的對話、回饋與 AI 評估結果。購買紀錄、CRM 等級與 AI 信任分數需要尚未連接的外部整合。",
  },
  gotIt: { en: "Got it ✓", zh: "了解 ✓" },
  searchPh: { en: "Search visitors...", zh: "搜尋訪客..." },
  allTiers: { en: "All Tiers", zh: "所有等級" },
  allTrust: { en: "All Trust", zh: "所有信任度" },
  allLtv: { en: "All LTV", zh: "所有終身價值" },
  filterUnavailable: {
    en: "Tier / Trust / LTV segmentation requires CRM integration — showing all visitors",
    zh: "等級／信任度／終身價值分眾需要 CRM 整合 — 目前顯示所有訪客",
  },
  noVisitors: { en: "No visitors found", zh: "找不到訪客" },
  noData: { en: "No data", zh: "無資料" },
  since: { en: "SINCE", zh: "首次出現" },
  ltv: { en: "LTV", zh: "終身價值" },
  orders: { en: "ORDERS", zh: "訂單" },
  trust: { en: "TRUST", zh: "信任分數" },
  memory: { en: "MEMORY", zh: "記憶信心" },
  freshness: { en: "FRESHNESS", zh: "資料新鮮度" },
  tabProfile: { en: "Profile", zh: "檔案" },
  tabConversations: { en: "Conversations", zh: "對話紀錄" },
  tabOrders: { en: "Orders", zh: "訂單" },
  tabProducts: { en: "Products Bought", zh: "購買產品" },
  tabPayments: { en: "Payments", zh: "付款紀錄" },
  tabEmotion: { en: "Emotion Journey", zh: "情緒旅程" },
  tabTrust: { en: "Trust Score", zh: "信任分數" },
  tabFollowup: { en: "Follow-up Plan", zh: "跟進計畫" },
  tabPredictions: { en: "Predictions", zh: "預測分析" },
  coreProfile: { en: "CORE PROFILE", zh: "基本檔案" },
  convMetrics: { en: "CONVERSATION METRICS", zh: "對話指標" },
  channel: { en: "Channel", zh: "管道" },
  firstSeen: { en: "First Seen", zh: "首次出現" },
  lastSeen: { en: "Last Seen", zh: "最近出現" },
  sessionRef: { en: "Session Reference", zh: "工作階段參照" },
  identityNote: {
    en: "Fields below are shown only if the visitor voluntarily provided them via the widget form.",
    zh: "以下欄位僅在訪客透過 Widget 表單主動提供時顯示。",
  },
  noIdentity: { en: "No visitor-provided identity data", zh: "訪客未提供身份資料" },
  resolutionRate: { en: "Resolution Rate", zh: "解決率" },
  escalationRate: { en: "Escalation Rate", zh: "升級率" },
  avgFeedback: { en: "Avg Feedback", zh: "平均回饋" },
  avgEvalScore: { en: "Avg Evaluation Score", zh: "平均評估分數" },
  lastUpdated: { en: "Last updated", zh: "最後更新" },
  total: { en: "Total", zh: "總數" },
  escalations: { en: "Escalations", zh: "升級案件" },
  needsReview: { en: "Needs Review", zh: "待覆核" },
  avgScore: { en: "Avg Eval Score", zh: "平均評分" },
  date: { en: "Date", zh: "日期" },
  status: { en: "Status", zh: "狀態" },
  priority: { en: "Priority", zh: "優先度" },
  evalScore: { en: "Eval Score", zh: "評估分數" },
  id: { en: "ID", zh: "編號" },
  assignedAgent: { en: "Assigned Agent", zh: "指派客服" },
  noConversations: { en: "No conversations found.", zh: "找不到對話。" },
  noOrders: { en: "No orders found.", zh: "找不到訂單。" },
  noProducts: { en: "No products found.", zh: "找不到產品。" },
  noPayments: { en: "No transactions found.", zh: "找不到交易紀錄。" },
  noEmotion: { en: "No emotion journey data found.", zh: "找不到情緒旅程資料。" },
  noTrustEvents: { en: "No trust score events.", zh: "沒有信任分數事件。" },
  noFollowup: { en: "No follow-up plans.", zh: "沒有跟進計畫。" },
  noPredictions: { en: "No predictions available.", zh: "沒有可用的預測。" },
  ordersUnavailable: {
    en: "Order history requires an external commerce/CRM integration that is not yet connected.",
    zh: "訂單紀錄需要尚未連接的外部商務／CRM 整合。",
  },
  productsUnavailable: {
    en: "Product purchase history requires an external commerce integration that is not yet connected.",
    zh: "產品購買紀錄需要尚未連接的外部商務整合。",
  },
  paymentsUnavailable: {
    en: "Payment and lifetime value data require an external payment/CRM integration that is not yet connected.",
    zh: "付款與終身價值資料需要尚未連接的外部付款／CRM 整合。",
  },
  trustUnavailable: {
    en: "AI trust scoring engine is not yet implemented. This tab will populate once a real trust-scoring pipeline is connected.",
    zh: "AI 信任分數引擎尚未實作。待真實信任評分管線接上後，本頁將自動顯示資料。",
  },
  followupUnavailable: {
    en: "Follow-up plan workflow is not yet implemented.",
    zh: "跟進計畫工作流程尚未實作。",
  },
  predictionsUnavailable: {
    en: "Predictive analytics (churn risk, retention offers) are not yet implemented.",
    zh: "預測分析（流失風險、挽留優惠）尚未實作。",
  },
  lifetimeValue: { en: "Lifetime Value", zh: "終身價值" },
  filter_all: { en: "All", zh: "全部" },
  filter_pending: { en: "Pending", zh: "待處理" },
  filter_completed: { en: "Completed", zh: "已完成" },
  error: { en: "Failed to load customer context", zh: "無法載入客戶上下文" },
  errorSub: { en: "Please try again later", zh: "請稍後再試" },
  loading: { en: "Loading...", zh: "載入中..." },
  liveDataFooter: { en: "Live data ·", zh: "即時資料 ·" },
  visitorProfiles: { en: "visitor profiles", zh: "位訪客檔案" },
  title: { en: "Customer 360", zh: "客戶全景" },
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
function initialsOf(label: string) {
  return (label || "?")
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
function fmtDate(d: string | null) {
  return d ? new Date(d).toLocaleDateString() : "—";
}
function fmtDateTime(d: string | null) {
  return d ? new Date(d).toLocaleString() : "—";
}
const card: CSSProperties = {
  background: "#fff",
  borderRadius: 12,
  padding: "16px 20px",
  boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
  marginBottom: 12,
};
function statusColor(s: string) {
  if (s === "resolved") return { bg: "#dcfce7", color: "#16a34a" };
  if (s === "open" || s === "ai_handling") return { bg: "#dbeafe", color: "#2563eb" };
  if (s === "pending" || s === "human_needed" || s === "escalation_risk") return { bg: "#fef3c7", color: "#d97706" };
  return { bg: "#f1f5f9", color: "#64748b" };
}
function evalScoreColor(s: number) {
  return s >= 80 ? "#16a34a" : s >= 60 ? "#d97706" : "#dc2626";
}

// ─── ArcGauge (半圓弧, kept from confirmed UI) ────────────────────────────────
function ArcGauge({ value, label, color, noData }: { value: number; label: string; color: string; noData?: boolean }) {
  const pct = Math.min(Math.max(value ?? 0, 0), 100);
  const r = 26,
    cx = 34,
    cy = 34;
  const circumference = Math.PI * r;
  const dash = (pct / 100) * circumference;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <svg width="68" height="42" viewBox="0 0 68 42">
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="#e2e8f0"
          strokeWidth="6"
          strokeLinecap="round"
        />
        {!noData && (
          <path
            d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
            fill="none"
            stroke={color}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
          />
        )}
        <text
          x={cx}
          y={cy - 2}
          textAnchor="middle"
          fontSize={noData ? "8" : "11"}
          fontWeight="700"
          fill={noData ? "#cbd5e1" : "#0f172a"}
        >
          {noData ? "—" : pct}
        </text>
      </svg>
      <div style={{ fontSize: 10, color: "#64748b", textAlign: "center", maxWidth: 72 }}>{label}</div>
    </div>
  );
}

// ─── SummaryBar (kept from confirmed UI) ─────────────────────────────────────
function SummaryBar({ items }: { items: { label: string; value: string | number; color?: string }[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: 8, marginBottom: 12 }}>
      {items.map((m, i) => (
        <div
          key={i}
          style={{
            background: "#fff",
            borderRadius: 10,
            padding: "10px 14px",
            textAlign: "center",
            boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
          }}
        >
          <div style={{ fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>{m.label}</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: m.color || "#0f172a" }}>{m.value}</div>
        </div>
      ))}
    </div>
  );
}

// ─── Empty-state (reused pattern from confirmed UI) ──────────────────────────
function EmptyState({ text }: { text: string }) {
  return <div style={{ textAlign: "center", padding: "40px", color: "#94a3b8" }}>📭 {text}</div>;
}
function NotAvailableNotice({ text }: { text: string }) {
  return (
    <div
      style={{
        background: "#f8fafc",
        border: "1px dashed #cbd5e1",
        borderRadius: 10,
        padding: "12px 16px",
        marginBottom: 12,
        fontSize: 12,
        color: "#64748b",
        lineHeight: 1.6,
      }}
    >
      {text}
    </div>
  );
}

const TABS = [
  "profile",
  "conversations",
  "orders",
  "products",
  "payments",
  "emotion",
  "trust",
  "followup",
  "predictions",
] as const;
type TabKey = (typeof TABS)[number];

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
  priority: string | null;
  created_at: string | null;
  channel_name: string | null;
  assigned_agent_name: string | null;
  eval_score: number | null;
};
type FeedbackRow = { id: string; rating: number | null; created_at: string };
type EvalRow = {
  id: string;
  conversation_id: string;
  overall_score: number;
  severity: string;
  review_status: string;
  created_at: string;
};
type EmotionRow = {
  id: string;
  conversation_id: string;
  turn_index: number;
  sentiment: string;
  sentiment_score: number;
  trigger_label: string | null;
  occurred_at: string;
};

const SENTIMENT_COLOR: Record<string, string> = {
  very_negative: "#dc2626",
  negative: "#f97316",
  neutral: "#94a3b8",
  positive: "#22c55e",
  very_positive: "#16a34a",
};

// ─── Main content ──────────────────────────────────────────────────────────
function Customer360Content() {
  const lang = useConsoleLang();
  const t = (key: CopyKey) => COPY[key]?.[lang] ?? COPY[key]?.en ?? key;

  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [visitors, setVisitors] = useState<VisitorRow[]>([]);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("profile");
  const [bannerVisible, setBannerVisible] = useState(true);
  const [followupFilter, setFollowupFilter] = useState<"all" | "pending" | "completed">("all");

  const [detailLoading, setDetailLoading] = useState(false);
  const [detailConvs, setDetailConvs] = useState<ConvRow[]>([]);
  const [detailFeedback, setDetailFeedback] = useState<FeedbackRow[]>([]);
  const [detailEval, setDetailEval] = useState<EvalRow[]>([]);
  const [detailEmotion, setDetailEmotion] = useState<EmotionRow[]>([]);

  // ── Load visitor list ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase
          .from("visitor_session")
          .select("id, created_at, last_seen_at, visitor_metadata, channel_config:channel_config_id(name)")
          .order("last_seen_at", { ascending: false })
          .limit(50);
        if (cancelled) return;
        if (error) {
          setStatus("error");
          return;
        }
        const raw = (data ?? []) as Array<{
          id: string;
          created_at: string | null;
          last_seen_at: string | null;
          visitor_metadata: unknown;
          channel_config: { name: string } | null;
        }>;
        const ids = raw.map((v) => v.id);
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
        const mapped = raw.map((v) => ({
          id: v.id,
          created_at: v.created_at,
          last_seen_at: v.last_seen_at,
          visitor_metadata: v.visitor_metadata,
          channel_name: v.channel_config?.name ?? null,
          conv_count: countMap[v.id] ?? 0,
        }));
        setVisitors(mapped);
        if (mapped.length > 0) setSelectedId(mapped[0].id);
        setStatus("success");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Load selected visitor detail ──
  useEffect(() => {
    if (!selectedId) {
      setDetailConvs([]);
      setDetailFeedback([]);
      setDetailEval([]);
      setDetailEmotion([]);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setActiveTab("profile");
    (async () => {
      try {
        const { data: convData } = await supabase
          .from("conversations")
          .select("id, status, priority, created_at, channel_config:channel_config_id(name), assigned_agent_id")
          .eq("visitor_session_id", selectedId)
          .order("created_at", { ascending: false });
        if (cancelled) return;
        const rows = (convData ?? []) as Array<{
          id: string;
          status: string;
          priority: string | null;
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
        const convIds = rows.map((r) => r.id);

        const [fbRes, evalRes] = await Promise.all([
          supabase
            .from("feedback_request")
            .select("id, rating, created_at")
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
        const evalRows = (evalRes.data ?? []) as EvalRow[];
        const evalByConv: Record<string, number> = {};
        evalRows.forEach((e) => {
          evalByConv[e.conversation_id] = e.overall_score;
        });

        setDetailConvs(
          rows.map((r) => ({
            id: r.id,
            status: r.status,
            priority: r.priority,
            created_at: r.created_at,
            channel_name: r.channel_config?.name ?? null,
            assigned_agent_name: r.assigned_agent_id ? (agentMap[r.assigned_agent_id] ?? null) : null,
            eval_score: evalByConv[r.id] ?? null,
          })),
        );
        setDetailFeedback((fbRes.data ?? []) as FeedbackRow[]);
        setDetailEval(evalRows);

        const evalIds = evalRows.map((e) => e.id);
        if (evalIds.length > 0) {
          const { data: emoData } = await supabase
            .from("ce_emotion_point")
            .select("id, evaluation_id, turn_index, sentiment, sentiment_score, trigger_label, occurred_at")
            .in("evaluation_id", evalIds)
            .order("turn_index", { ascending: true });
          if (cancelled) return;
          const evalToConv: Record<string, string> = {};
          evalRows.forEach((e) => {
            evalToConv[e.id] = e.conversation_id;
          });
          setDetailEmotion(
            (
              (emoData ?? []) as Array<{
                id: string;
                evaluation_id: string;
                turn_index: number;
                sentiment: string;
                sentiment_score: number;
                trigger_label: string | null;
                occurred_at: string;
              }>
            ).map((e) => ({
              id: e.id,
              conversation_id: evalToConv[e.evaluation_id] ?? "",
              turn_index: e.turn_index,
              sentiment: e.sentiment,
              sentiment_score: e.sentiment_score,
              trigger_label: e.trigger_label,
              occurred_at: e.occurred_at,
            })),
          );
        } else {
          setDetailEmotion([]);
        }
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

  const selected = visitors.find((v) => v.id === selectedId) ?? null;
  const selectedLabel = selected ? getVisitorLabel(selected.visitor_metadata, selected.id) : "";

  // Real derived metrics (per selected visitor)
  const resolutionRate =
    detailConvs.length > 0
      ? Math.round((detailConvs.filter((c) => c.status === "resolved").length / detailConvs.length) * 100)
      : null;
  const escalationRate =
    detailConvs.length > 0
      ? Math.round((detailConvs.filter((c) => c.priority === "high").length / detailConvs.length) * 100)
      : null;
  const ratedFeedback = detailFeedback.filter((f) => f.rating !== null);
  const avgFeedbackPct =
    ratedFeedback.length > 0
      ? Math.round((ratedFeedback.reduce((s, f) => s + (f.rating ?? 0), 0) / ratedFeedback.length / 5) * 100)
      : null;
  const avgEvalScore =
    detailEval.length > 0 ? Math.round(detailEval.reduce((s, e) => s + e.overall_score, 0) / detailEval.length) : null;

  const chipStyle = (): CSSProperties => ({
    fontSize: 9,
    padding: "2px 7px",
    borderRadius: 999,
    border: "none",
    fontWeight: 600,
    background: "#f1f5f9",
    color: "#cbd5e1",
    cursor: "not-allowed",
  });

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
    if (!selected) return [];
    const m = selected.visitor_metadata;
    if (!m || typeof m !== "object" || Array.isArray(m)) return [];
    return Object.entries(m as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined && v !== "");
  })();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        background: "#f8fafc",
      }}
    >
      {/* Info Banner */}
      {bannerVisible && (
        <div
          style={{
            background: "#fffbeb",
            borderBottom: "1px solid #fde68a",
            padding: "8px 20px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14 }}>💡</span>
          <span style={{ fontSize: 12, color: "#92400e", flex: 1 }}>{t("bannerText")}</span>
          <button
            onClick={() => setBannerVisible(false)}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "#92400e",
              background: "none",
              border: "none",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            {t("gotIt")}
          </button>
        </div>
      )}

      {/* Two-column layout */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* LEFT: Visitor List */}
        <div
          style={{
            flex: "0 0 30%",
            width: "30%",
            borderRight: "1px solid #e5e7eb",
            background: "#fff",
            display: "flex",
            flexDirection: "column",
            padding: 12,
            overflowY: "auto",
          }}
        >
          <div style={{ position: "relative", marginBottom: 10 }}>
            <span
              style={{
                position: "absolute",
                left: 10,
                top: "50%",
                transform: "translateY(-50%)",
                color: "#94a3b8",
                fontSize: 12,
              }}
            >
              🔍
            </span>
            <input
              placeholder={t("searchPh")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 10px 8px 30px",
                border: "1px solid #e5e7eb",
                borderRadius: 999,
                fontSize: 12,
                background: "#f8fafc",
                outline: "none",
                boxSizing: "border-box",
                color: "#0f172a",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 6,
              marginBottom: 8,
              paddingBottom: 8,
              borderBottom: "1px solid #e5e7eb",
            }}
          >
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              {[t("allTiers"), "VIP", "Premium", "Standard"].map((l) => (
                <button key={l} disabled style={chipStyle()} title={t("filterUnavailable")}>
                  {l}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              {[t("allTrust"), "High ≥75", "Med 50–74", "Low <50"].map((l) => (
                <button key={l} disabled style={chipStyle()} title={t("filterUnavailable")}>
                  {l}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
              {[t("allLtv"), "Critical >5k", "High >2k", "Med", "Low"].map((l) => (
                <button key={l} disabled style={chipStyle()} title={t("filterUnavailable")}>
                  {l}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 9, color: "#cbd5e1", lineHeight: 1.4 }}>{t("filterUnavailable")}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {filteredVisitors.length === 0 ? (
              <div style={{ textAlign: "center", color: "#94a3b8", fontSize: 12, padding: 20 }}>{t("noVisitors")}</div>
            ) : (
              filteredVisitors.map((v) => {
                const label = getVisitorLabel(v.visitor_metadata, v.id);
                const isActive = v.id === selectedId;
                return (
                  <button
                    key={v.id}
                    onClick={() => setSelectedId(v.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 12px",
                      borderRadius: 10,
                      border: "none",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      background: isActive ? "#0f172a" : "#fff",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
                    }}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: "50%",
                        background: isActive ? "#374151" : "linear-gradient(135deg,#2563eb,#60a5fa)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      <span style={{ color: "#fff", fontSize: 11, fontWeight: 700 }}>{initialsOf(label)}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 500,
                          color: isActive ? "#fff" : "#0f172a",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {label}
                      </div>
                      <div
                        style={{ fontSize: 10, color: isActive ? "rgba(255,255,255,0.6)" : "#94a3b8", marginTop: 2 }}
                      >
                        {v.channel_name || "—"} · {v.conv_count} conv
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* RIGHT: Detail */}
        <div
          style={{
            flex: "0 0 70%",
            width: "70%",
            background: "#f8fafc",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {!selected ? (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#94a3b8",
                fontSize: 13,
              }}
            >
              {t("noVisitors")}
            </div>
          ) : (
            <>
              {/* Header */}
              <div
                style={{
                  background: "#fff",
                  borderBottom: "1px solid #e5e7eb",
                  padding: "12px 20px",
                  display: "flex",
                  alignItems: "center",
                  gap: 16,
                  flexShrink: 0,
                  flexWrap: "wrap",
                }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: "50%",
                    background: "linear-gradient(135deg,#2563eb,#60a5fa)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    fontWeight: 700,
                    fontSize: 14,
                    flexShrink: 0,
                  }}
                >
                  {initialsOf(selectedLabel)}
                </div>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>{selectedLabel}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 11, color: "#94a3b8" }}>{selected.channel_name || "—"}</span>
                  </div>
                </div>
                <div style={{ width: 1, height: 32, background: "#e5e7eb", flexShrink: 0 }} />
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
                  {[
                    [t("ltv"), "—", "#94a3b8"],
                    [t("since"), fmtDate(selected.created_at), "#0f172a"],
                    [t("orders"), "—", "#94a3b8"],
                    [t("trust"), "—", "#94a3b8"],
                    [t("memory"), "—", "#94a3b8"],
                    [t("freshness"), "—", "#94a3b8"],
                  ].map(([label, val, color], i, arr) => (
                    <div
                      key={label as string}
                      style={{ padding: "0 14px", borderRight: i < arr.length - 1 ? "1px solid #e5e7eb" : "none" }}
                    >
                      <div
                        style={{
                          fontSize: 9,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.06em",
                          color: "#94a3b8",
                        }}
                      >
                        {label}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: color as string }}>{val}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Tab Bar */}
              <div style={{ padding: "12px 20px 0", flexShrink: 0 }}>
                <div
                  style={{
                    background: "#e2e8f0",
                    borderRadius: 10,
                    padding: 4,
                    display: "flex",
                    gap: 2,
                    overflowX: "auto",
                  }}
                >
                  {TABS.map((tk) => (
                    <button
                      key={tk}
                      onClick={() => setActiveTab(tk)}
                      style={{
                        padding: "7px 14px",
                        borderRadius: 8,
                        border: "none",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        fontSize: 12,
                        fontWeight: activeTab === tk ? 600 : 400,
                        color: activeTab === tk ? "#0f172a" : "#64748b",
                        background: activeTab === tk ? "#fff" : "transparent",
                        boxShadow: activeTab === tk ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                        flexShrink: 0,
                      }}
                    >
                      {t(("tab" + tk[0].toUpperCase() + tk.slice(1)) as CopyKey)}
                    </button>
                  ))}
                </div>
              </div>

              {/* Tab Content */}
              <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
                {detailLoading ? (
                  <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
                    <Loader2 size={20} className="animate-spin" style={{ color: "#94a3b8" }} />
                  </div>
                ) : (
                  <>
                    {activeTab === "profile" && (
                      <div style={{ display: "grid", gridTemplateColumns: "55% 45%", gap: 16 }}>
                        <div style={card}>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                              color: "#94a3b8",
                              marginBottom: 8,
                            }}
                          >
                            {t("coreProfile")}
                          </div>
                          {[
                            [t("channel"), selected.channel_name || "—"],
                            [t("firstSeen"), fmtDateTime(selected.created_at)],
                            [t("lastSeen"), fmtDateTime(selected.last_seen_at)],
                            [t("sessionRef"), selected.id],
                          ].map(([label, val]) => (
                            <div
                              key={label}
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                padding: "10px 0",
                                borderBottom: "1px solid #f1f5f9",
                              }}
                            >
                              <span style={{ fontSize: 12, color: "#64748b", flexShrink: 0, marginRight: 12 }}>
                                {label}
                              </span>
                              <span
                                style={{
                                  fontSize: 12,
                                  color: "#0f172a",
                                  fontWeight: 500,
                                  textAlign: "right",
                                  fontFamily: label === t("sessionRef") ? "monospace" : "inherit",
                                }}
                              >
                                {val}
                              </span>
                            </div>
                          ))}
                          <div style={{ marginTop: 10, fontSize: 10, color: "#cbd5e1", lineHeight: 1.5 }}>
                            {t("identityNote")}
                          </div>
                          {identityFields.length > 0 &&
                            identityFields.map(([k, v]) => (
                              <div
                                key={k}
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  padding: "6px 0",
                                  borderBottom: "1px solid #f1f5f9",
                                }}
                              >
                                <span style={{ fontSize: 12, color: "#64748b", textTransform: "capitalize" }}>
                                  {k.replace(/_/g, " ")}
                                </span>
                                <span style={{ fontSize: 12, color: "#0f172a", fontWeight: 500 }}>{String(v)}</span>
                              </div>
                            ))}
                          {identityFields.length === 0 && (
                            <div style={{ fontSize: 11, color: "#cbd5e1", marginTop: 6 }}>{t("noIdentity")}</div>
                          )}
                        </div>
                        <div style={card}>
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: "uppercase",
                              letterSpacing: "0.08em",
                              color: "#94a3b8",
                              marginBottom: 8,
                            }}
                          >
                            {t("convMetrics")}
                          </div>
                          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, paddingTop: 8 }}>
                            <ArcGauge
                              value={resolutionRate ?? 0}
                              noData={resolutionRate === null}
                              label={t("resolutionRate")}
                              color="#16a34a"
                            />
                            <ArcGauge
                              value={escalationRate ?? 0}
                              noData={escalationRate === null}
                              label={t("escalationRate")}
                              color="#dc2626"
                            />
                            <ArcGauge
                              value={avgFeedbackPct ?? 0}
                              noData={avgFeedbackPct === null}
                              label={t("avgFeedback")}
                              color="#f59e0b"
                            />
                            <ArcGauge
                              value={avgEvalScore ?? 0}
                              noData={avgEvalScore === null}
                              label={t("avgEvalScore")}
                              color="#6366f1"
                            />
                          </div>
                          <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 12 }}>
                            {t("lastUpdated")}: {new Date().toLocaleDateString()}
                          </div>
                        </div>
                      </div>
                    )}

                    {activeTab === "conversations" && (
                      <div>
                        <SummaryBar
                          items={[
                            { label: t("total"), value: detailConvs.length },
                            { label: t("escalations"), value: detailConvs.filter((c) => c.priority === "high").length },
                            {
                              label: t("needsReview"),
                              value: detailEval.filter((e) => e.review_status === "pending").length,
                            },
                            {
                              label: t("avgScore"),
                              value: avgEvalScore ?? "—",
                              color: avgEvalScore !== null ? evalScoreColor(avgEvalScore) : undefined,
                            },
                          ]}
                        />
                        {detailConvs.length === 0 ? (
                          <EmptyState text={t("noConversations")} />
                        ) : (
                          <div style={{ ...card, padding: 0, overflow: "hidden" }}>
                            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                              <thead>
                                <tr style={{ background: "#f1f5f9" }}>
                                  {[
                                    t("date"),
                                    t("channel"),
                                    t("status"),
                                    t("priority"),
                                    t("assignedAgent"),
                                    t("evalScore"),
                                    t("id"),
                                  ].map((h) => (
                                    <th
                                      key={h}
                                      style={{
                                        padding: "9px 12px",
                                        textAlign: "left",
                                        fontSize: 11,
                                        fontWeight: 600,
                                        textTransform: "uppercase",
                                        color: "#64748b",
                                        whiteSpace: "nowrap",
                                      }}
                                    >
                                      {h}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {detailConvs.map((c, i) => {
                                  const sc = statusColor(c.status);
                                  return (
                                    <tr key={c.id} style={{ background: i % 2 === 0 ? "#fff" : "#fafafa" }}>
                                      <td style={{ padding: "10px 12px", fontSize: 12, color: "#475569" }}>
                                        {fmtDate(c.created_at)}
                                      </td>
                                      <td style={{ padding: "10px 12px", fontSize: 12, color: "#0f172a" }}>
                                        {c.channel_name || "—"}
                                      </td>
                                      <td style={{ padding: "10px 12px" }}>
                                        <span
                                          style={{
                                            background: sc.bg,
                                            color: sc.color,
                                            fontSize: 11,
                                            fontWeight: 600,
                                            padding: "2px 8px",
                                            borderRadius: 4,
                                          }}
                                        >
                                          {c.status}
                                        </span>
                                      </td>
                                      <td style={{ padding: "10px 12px" }}>
                                        <span
                                          style={{
                                            background: c.priority === "high" ? "#fee2e2" : "#f1f5f9",
                                            color: c.priority === "high" ? "#dc2626" : "#64748b",
                                            fontSize: 11,
                                            fontWeight: 600,
                                            padding: "2px 8px",
                                            borderRadius: 4,
                                          }}
                                        >
                                          {c.priority || "—"}
                                        </span>
                                      </td>
                                      <td style={{ padding: "10px 12px", fontSize: 12, color: "#64748b" }}>
                                        {c.assigned_agent_name || "—"}
                                      </td>
                                      <td
                                        style={{
                                          padding: "10px 12px",
                                          fontSize: 13,
                                          fontWeight: 700,
                                          color: c.eval_score !== null ? evalScoreColor(c.eval_score) : "#cbd5e1",
                                        }}
                                      >
                                        {c.eval_score ?? "—"}
                                      </td>
                                      <td style={{ padding: "10px 12px", fontSize: 11 }}>
                                        <Link
                                          to="/console/conversations/$id"
                                          params={{ id: c.id }}
                                          style={{ color: "#2563eb", fontWeight: 600, textDecoration: "none" }}
                                        >
                                          #{c.id.slice(0, 8)}
                                        </Link>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}

                    {activeTab === "orders" && (
                      <div>
                        <NotAvailableNotice text={t("ordersUnavailable")} />
                        <EmptyState text={t("noOrders")} />
                      </div>
                    )}

                    {activeTab === "products" && (
                      <div>
                        <NotAvailableNotice text={t("productsUnavailable")} />
                        <EmptyState text={t("noProducts")} />
                      </div>
                    )}

                    {activeTab === "payments" && (
                      <div>
                        <div
                          style={{
                            background: "#0f172a",
                            borderRadius: 12,
                            padding: "20px",
                            textAlign: "center",
                            marginBottom: 16,
                          }}
                        >
                          <div
                            style={{
                              fontSize: 11,
                              color: "#94a3b8",
                              letterSpacing: "0.1em",
                              textTransform: "uppercase",
                              marginBottom: 8,
                            }}
                          >
                            {t("lifetimeValue")}
                          </div>
                          <div style={{ fontSize: 36, fontWeight: 800, color: "#64748b" }}>—</div>
                        </div>
                        <NotAvailableNotice text={t("paymentsUnavailable")} />
                        <EmptyState text={t("noPayments")} />
                      </div>
                    )}

                    {activeTab === "emotion" && (
                      <div>
                        {detailEmotion.length === 0 ? (
                          <EmptyState text={t("noEmotion")} />
                        ) : (
                          Object.entries(
                            detailEmotion.reduce((acc: Record<string, EmotionRow[]>, e) => {
                              (acc[e.conversation_id] ??= []).push(e);
                              return acc;
                            }, {}),
                          ).map(([convId, points]) => (
                            <div key={convId} style={card}>
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 8,
                                  marginBottom: 8,
                                  flexWrap: "wrap",
                                }}
                              >
                                <Link
                                  to="/console/conversations/$id"
                                  params={{ id: convId }}
                                  style={{ fontSize: 11, color: "#2563eb", fontWeight: 600, textDecoration: "none" }}
                                >
                                  #{convId.slice(0, 8)}
                                </Link>
                                {points.map((p, si, arr) => (
                                  <span key={p.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                                    <span
                                      style={{
                                        fontSize: 10,
                                        fontWeight: 700,
                                        padding: "2px 7px",
                                        borderRadius: 10,
                                        background: "#f1f5f9",
                                        color: SENTIMENT_COLOR[p.sentiment] || "#64748b",
                                      }}
                                    >
                                      {p.sentiment}
                                    </span>
                                    {si < arr.length - 1 && <span style={{ color: "#cbd5e1" }}>→</span>}
                                  </span>
                                ))}
                              </div>
                              <div style={{ fontSize: 10, color: "#94a3b8" }}>
                                {points.length} tracked turn{points.length !== 1 ? "s" : ""} · avg score{" "}
                                {Math.round(points.reduce((s, p) => s + p.sentiment_score, 0) / points.length)}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {activeTab === "trust" && (
                      <div>
                        <NotAvailableNotice text={t("trustUnavailable")} />
                        <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a", marginBottom: 8 }}>
                          {t("tabTrust")}
                        </div>
                        <EmptyState text={t("noTrustEvents")} />
                      </div>
                    )}

                    {activeTab === "followup" && (
                      <div>
                        <NotAvailableNotice text={t("followupUnavailable")} />
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            marginBottom: 16,
                          }}
                        >
                          <span style={{ fontSize: 14, fontWeight: 700, color: "#0f172a" }}>{t("tabFollowup")}</span>
                          <div style={{ display: "flex", gap: 4 }}>
                            {(["all", "pending", "completed"] as const).map((f) => (
                              <button
                                key={f}
                                onClick={() => setFollowupFilter(f)}
                                style={{
                                  fontSize: 12,
                                  fontWeight: 600,
                                  padding: "5px 12px",
                                  borderRadius: 6,
                                  border: "none",
                                  cursor: "pointer",
                                  background: followupFilter === f ? "#0f172a" : "#f1f5f9",
                                  color: followupFilter === f ? "#fff" : "#64748b",
                                }}
                              >
                                {t(("filter_" + f) as CopyKey)}
                              </button>
                            ))}
                          </div>
                        </div>
                        <EmptyState text={t("noFollowup")} />
                      </div>
                    )}

                    {activeTab === "predictions" && (
                      <div>
                        <NotAvailableNotice text={t("predictionsUnavailable")} />
                        <EmptyState text={t("noPredictions")} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ textAlign: "right", fontSize: 11, color: "#9ca3af", padding: "4px 16px", flexShrink: 0 }}>
        {t("liveDataFooter")} {visitors.length} {t("visitorProfiles")}
      </div>
    </div>
  );
}
