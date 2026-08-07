import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { supabase } from "@/integrations/supabase/client";
import { AlertCircle, Loader2, MessageSquare, Users, UserCircle2, PlugZap } from "lucide-react";

export const Route = createFileRoute("/_authenticated/console/customer360")({
  component: Customer360Guard,
});

const COPY = {
  title: { en: "Customer 360", zh: "客戶全景" },
  subtitle: {
    en: "Customer and visitor context overview for the current workspace",
    zh: "目前工作區的客戶與訪客上下文概覽",
  },
  crmTitle: { en: "CRM integration required", zh: "需要 CRM 整合" },
  crmBody: {
    en: "Customer profile data requires CRM integration. Connect your CRM to view detailed customer profiles.",
    zh: "客戶檔案資料需要 CRM 整合。請連接您的 CRM 以查看詳細客戶檔案。",
  },
  degraded: { en: "Degraded — no CRM connected", zh: "降級 — 尚未連接 CRM" },
  totalConversations: { en: "Total Conversations", zh: "總對話數" },
  totalSessions: { en: "Visitor Sessions", zh: "訪客工作階段" },
  recent: { en: "Recent Conversations", zh: "近期對話" },
  conversation: { en: "Conversation", zh: "對話" },
  channel: { en: "Channel", zh: "管道" },
  status: { en: "Status", zh: "狀態" },
  created: { en: "Created", zh: "建立時間" },
  noData: { en: "No conversation data yet", zh: "暫無對話資料" },
  error: { en: "Failed to load customer context", zh: "無法載入客戶上下文" },
  errorSub: { en: "Please try again later", zh: "請稍後再試" },
  loading: { en: "Loading...", zh: "載入中..." },
} as const;

type CopyKey = keyof typeof COPY;

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

type RecentConv = {
  id: string;
  status: string;
  created_at: string | null;
  channel_config: { name: string } | null;
};

function Customer360Content() {
  const lang = useConsoleLang();
  const t = (key: CopyKey) => COPY[key]?.[lang] ?? COPY[key]?.en ?? key;
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [convCount, setConvCount] = useState(0);
  const [sessionCount, setSessionCount] = useState(0);
  const [recent, setRecent] = useState<RecentConv[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [convRes, sessRes, recentRes] = await Promise.all([
          supabase.from("conversations").select("id", { count: "exact", head: true }),
          supabase.from("visitor_session").select("id", { count: "exact", head: true }),
          supabase
            .from("conversations")
            .select("id, status, created_at, channel_config:channel_config_id(name)")
            .order("created_at", { ascending: false })
            .limit(10),
        ]);
        if (cancelled) return;
        if (convRes.error || sessRes.error || recentRes.error) {
          setStatus("error");
          return;
        }
        setConvCount(convRes.count ?? 0);
        setSessionCount(sessRes.count ?? 0);
        setRecent((recentRes.data as RecentConv[] | null) ?? []);
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

  const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : "—");

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px" }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <UserCircle2 size={22} style={{ color: "#2563eb" }} />
          <h1 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a1a", margin: 0 }}>{t("title")}</h1>
        </div>
        <p style={{ fontSize: 13, color: "#888", margin: 0 }}>{t("subtitle")}</p>
      </div>

      {/* CRM degraded state */}
      <div
        style={{
          background: "#fffbeb",
          border: "1px solid #fde68a",
          borderRadius: 10,
          padding: "14px 16px",
          marginBottom: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
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

      {/* Real DB counts */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
          marginBottom: 24,
        }}
      >
        {[
          { icon: <MessageSquare size={18} />, label: t("totalConversations"), value: convCount, color: "#16a34a" },
          { icon: <Users size={18} />, label: t("totalSessions"), value: sessionCount, color: "#2563eb" },
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

      {/* Recent conversations */}
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
          {t("recent")}
        </div>
        {recent.length === 0 ? (
          <div style={{ padding: "28px 16px", textAlign: "center", fontSize: 12, color: "#9ca3af" }}>{t("noData")}</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #f3f4f6" }}>
                  {[t("conversation"), t("channel"), t("status"), t("created")].map((h, i) => (
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
                {recent.map((c) => (
                  <tr key={c.id} style={{ borderBottom: "1px solid #f9fafb" }}>
                    <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 12, color: "#6366f1" }}>
                      #{c.id.slice(0, 8)}
                    </td>
                    <td style={{ padding: "10px 14px", color: "#555" }}>{c.channel_config?.name || "—"}</td>
                    <td style={{ padding: "10px 14px" }}>
                      <span
                        style={{
                          fontSize: 11,
                          padding: "2px 8px",
                          borderRadius: 12,
                          fontWeight: 600,
                          background:
                            c.status === "resolved" ? "#dcfce7" : c.status === "open" ? "#dbeafe" : "#fef3c7",
                          color: c.status === "resolved" ? "#166534" : c.status === "open" ? "#1e40af" : "#92400e",
                        }}
                      >
                        {c.status}
                      </span>
                    </td>
                    <td style={{ padding: "10px 14px", color: "#555" }}>{fmt(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
