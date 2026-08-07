import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { supabase } from "@/integrations/supabase/client";
import { Users, AlertCircle, Loader2, MessageSquare, Star, BarChart3 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/console/visitor-analytics")({
  component: VisitorAnalyticsGuard,
});

const COPY = {
  title: { en: "Visitor Analytics", zh: "訪客分析" },
  subtitle: {
    en: "Anonymous visitor session analytics — no customer identity data",
    zh: "匿名訪客工作階段分析 — 無客戶身份資料",
  },
  totalSessions: { en: "Total Sessions", zh: "總工作階段" },
  totalConversations: { en: "Total Conversations", zh: "總對話數" },
  totalMessages: { en: "Total Messages", zh: "總訊息數" },
  feedbackCount: { en: "Feedback Received", zh: "收到回饋" },
  avgRating: { en: "Avg Rating", zh: "平均評分" },
  recentSessions: { en: "Recent Visitor Sessions", zh: "近期訪客工作階段" },
  sessionRef: { en: "Session", zh: "工作階段" },
  firstSeen: { en: "First Seen", zh: "首次存取" },
  lastSeen: { en: "Last Seen", zh: "最近存取" },
  conversations: { en: "Conversations", zh: "對話數" },
  status: { en: "Status", zh: "狀態" },
  noData: { en: "No visitor data available", zh: "暫無訪客資料" },
  noDataSub: { en: "Visitor analytics will appear once conversations begin", zh: "對話開始後將顯示訪客分析" },
  error: { en: "Failed to load analytics", zh: "無法載入分析資料" },
  errorSub: { en: "Please try again later", zh: "請稍後再試" },
  loading: { en: "Loading analytics...", zh: "載入分析資料..." },
  na: { en: "N/A", zh: "無" },
} as const;

type CopyKey = keyof typeof COPY;

function VisitorAnalyticsGuard() {
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
          Only Admin and Supervisor roles can access Visitor Analytics.
          <br />
          僅限 Admin 和 Supervisor 角色存取訪客分析。
        </div>
      </div>
    );
  }
  return <VisitorAnalyticsContent />;
}

interface SummaryData {
  total_sessions: number;
  total_conversations: number;
  status_counts: Record<string, number>;
  total_messages: number;
  feedback_count: number;
  average_rating: number | null;
  recent_sessions: Array<{
    session_ref: string;
    first_seen: string | null;
    last_seen: string | null;
    conversation_count: number;
    last_status: string;
  }>;
}

function VisitorAnalyticsContent() {
  const lang = useConsoleLang();
  const t = (key: CopyKey) => COPY[key]?.[lang] ?? COPY[key]?.en ?? key;
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke("visitor-analytics", {
          body: { mode: "summary" },
        });
        if (cancelled) return;
        if (error || !data?.success) {
          setStatus("error");
          return;
        }
        setSummary(data.summary);
        setStatus("success");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
  if (!summary || summary.total_sessions === 0) {
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
        <Users size={32} style={{ color: "#d1d5db" }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: "#374151" }}>{t("noData")}</div>
        <div style={{ fontSize: 12, color: "#9ca3af" }}>{t("noDataSub")}</div>
      </div>
    );
  }

  const fmt = (d: string | null) => (d ? new Date(d).toLocaleDateString() : "—");
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px" }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <BarChart3 size={22} style={{ color: "#2563eb" }} />
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a1a", margin: 0 }}>{t("title")}</h1>
        </div>
        <p style={{ fontSize: 13, color: "#888", margin: 0 }}>{t("subtitle")}</p>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
          gap: 12,
          marginBottom: 24,
        }}
      >
        {[
          { icon: <Users size={18} />, label: t("totalSessions"), value: summary.total_sessions, color: "#2563eb" },
          {
            icon: <MessageSquare size={18} />,
            label: t("totalConversations"),
            value: summary.total_conversations,
            color: "#16a34a",
          },
          {
            icon: <MessageSquare size={18} />,
            label: t("totalMessages"),
            value: summary.total_messages,
            color: "#6366f1",
          },
          { icon: <Star size={18} />, label: t("feedbackCount"), value: summary.feedback_count, color: "#f59e0b" },
          {
            icon: <Star size={18} />,
            label: t("avgRating"),
            value: summary.average_rating !== null ? summary.average_rating.toFixed(1) : t("na"),
            color: "#ef4444",
          },
        ].map((card, i) => (
          <div key={i} style={{ background: "#fff", border: "1px solid #e8e6e0", borderRadius: 10, padding: "16px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, color: card.color }}>
              {card.icon}
              <span style={{ fontSize: 11, color: "#888", fontWeight: 600 }}>{card.label}</span>
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#1a1a1a" }}>{card.value}</div>
          </div>
        ))}
      </div>
      <div style={{ background: "#fff", border: "1px solid #e8e6e0", borderRadius: 10, overflow: "hidden" }}>
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid #e8e6e0",
            fontWeight: 600,
            fontSize: 14,
            color: "#374151",
          }}
        >
          {t("recentSessions")}
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #f3f4f6" }}>
                {[t("sessionRef"), t("firstSeen"), t("lastSeen"), t("conversations"), t("status")].map((h, i) => (
                  <th
                    key={i}
                    style={{
                      padding: "10px 14px",
                      textAlign: "left",
                      fontWeight: 600,
                      color: "#6b7280",
                      fontSize: 11,
                      textTransform: "uppercase",
                      letterSpacing: ".5px",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {summary.recent_sessions.map((s, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f9fafb" }}>
                  <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 12, color: "#6366f1" }}>
                    {s.session_ref}
                  </td>
                  <td style={{ padding: "10px 14px", color: "#555" }}>{fmt(s.first_seen)}</td>
                  <td style={{ padding: "10px 14px", color: "#555" }}>{fmt(s.last_seen)}</td>
                  <td style={{ padding: "10px 14px", color: "#555" }}>{s.conversation_count}</td>
                  <td style={{ padding: "10px 14px" }}>
                    <span
                      style={{
                        fontSize: 11,
                        padding: "2px 8px",
                        borderRadius: 12,
                        fontWeight: 600,
                        background:
                          s.last_status === "resolved" ? "#dcfce7" : s.last_status === "open" ? "#dbeafe" : "#fef3c7",
                        color:
                          s.last_status === "resolved" ? "#166534" : s.last_status === "open" ? "#1e40af" : "#92400e",
                      }}
                    >
                      {s.last_status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
