import { createFileRoute, Outlet, Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { LogOut } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { mapDemoRoleToEffective, type ConsoleOutletContext, type EffectiveRole } from "@/types/demoRole";
import { EffectiveRoleProvider } from "@/hooks/useEffectiveRole";
export const Route = createFileRoute("/_authenticated/console")({
  component: ConsoleLayout,
});

/* ── Style constants (from Base44 AppLayout) ── */
const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
const LANGBAR_H = 34;
const TOPBAR_H = 54;
const SIDEBAR_EXPANDED = 220;
const SIDEBAR_COLLAPSED = 52;

/* ── Translations ── */
const translations: Record<string, Record<string, string>> = {
  en: {
    appName: "AI Chatbot",
    groupInbox: "LIVE INBOX",
    groupOperations: "AGENT OPERATIONS",
    groupSettings: "SETTINGS",
    navInbox: "AI Chatbot Inbox",
    navAnalytics: "Live Analytics",
    navAgentSettings: "Agent Settings",
    navChannelSettings: "Channel Settings",
    navFeedbackSettings: "Feedback Automation",
    navCustomer360: "Customer 360",
    navVisitorAnalytics: "Visitor Analytics",
    navLLMRuntime: "LLM Runtime",
    navWidgetPreview: "Widget Preview",
    navFeedbackResponses: "Feedback Responses",
    navKbHelper: "Knowledge Helper",
    navConversationEvaluation: "Conversation Evaluation",
    groupEvaluation: "CONVERSATION EVALUATION",
  },
  zh: {
    appName: "AI 智能客服",
    groupInbox: "即時收件箱",
    groupOperations: "客服管理",
    groupSettings: "系統設定",
    navInbox: "AI 客服收件箱",
    navAnalytics: "即時分析",
    navAgentSettings: "客服設定",
    navChannelSettings: "Channel 設定",
    navFeedbackSettings: "評分自動化",
    navCustomer360: "客戶全景",
    navVisitorAnalytics: "訪客分析",
    navLLMRuntime: "LLM 模型設定",
    navWidgetPreview: "Widget 預覽",
    navFeedbackResponses: "客戶回饋",
    navKbHelper: "知識庫搜尋",
    navConversationEvaluation: "對話評估",
    groupEvaluation: "對話評估",
  },
};

const pageMeta: Record<string, { zh: string; en: string; sub?: { zh: string; en: string } }> = {
  "/console": {
    zh: "AI 智能客服",
    en: "AI Chatbot",
    sub: { zh: "即時對話中心 — AI 自動回覆與人工接管", en: "Live conversation hub — AI auto-reply & human handoff" },
  },
  "/console/analytics": {
    zh: "即時分析",
    en: "Live Analytics",
    sub: { zh: "即時指標與 AI 客服表現概覽", en: "Real-time metrics & AI performance" },
  },
  "/console/agent-settings": {
    zh: "客服設定",
    en: "Agent Settings",
    sub: { zh: "客服人員配置與 AI Agent 管理", en: "Agent profiles & AI agent configuration" },
  },
  "/console/channel-settings": {
    zh: "Channel 設定",
    en: "Channel Settings",
    sub: { zh: "接入渠道配置", en: "Channel integration config" },
  },
  "/console/feedback-settings": {
    zh: "評分自動化",
    en: "Feedback Automation",
    sub: { zh: "對話結案後自動發送客戶評分請求", en: "Auto-send customer rating requests after resolution" },
  },
  "/console/feedback-responses": {
    zh: "客戶回饋",
    en: "Feedback Responses",
    sub: { zh: "查看客戶提交的評分與回饋意見", en: "View customer-submitted ratings and feedback" },
  },
  "/console/customer360": {
    zh: "客戶全景",
    en: "Customer 360",
    sub: { zh: "客戶/訪客上下文概覽", en: "Customer/visitor context overview" },
  },
  "/console/visitor-analytics": {
    zh: "訪客分析",
    en: "Visitor Analytics",
    sub: { zh: "匿名訪客工作階段分析", en: "Anonymous visitor session analytics" },
  },
  "/console/settings/llm-runtime": {
    zh: "LLM 模型設定",
    en: "LLM Runtime Settings",
    sub: {
      zh: "AI 模型提供商設定與路由規則（僅限 Admin）",
      en: "AI model provider config & routing rules (Admin only)",
    },
  },
  "/console/widget-preview": {
    zh: "Widget 預覽",
    en: "Widget Preview",
    sub: { zh: "管理獲授權的 Widget 安裝代碼", en: "Manage authorized widget installation code" },
  },
  "/console/conversations": {
    zh: "對話列表",
    en: "Conversations",
    sub: { zh: "所有對話記錄", en: "All conversation records" },
  },
  "/console/conversation-evaluation": {
    zh: "對話評估",
    en: "Conversation Evaluation",
    sub: { zh: "AI 對話評分、覆核與訓練狀態", en: "AI conversation scoring, review & training state" },
  },
  "/console/kb-gaps": {
    zh: "知識庫搜尋",
    en: "Knowledge Helper",
    sub: { zh: "搜尋知識庫中的相關文章與文件", en: "Search the Knowledge Base for relevant articles" },
  },
};

/* ── Nav groups (Base44 structure) ── */
/* Dev22-A1: Removed analytics + customer360 from inbox group (mock pages hidden from nav) */
const GROUPS = [
  {
    key: "inbox",
    labelKey: "groupInbox",
    color: "#dc2626",
    bgColor: "#fee2e2",
    items: [
      { path: "/console/conversations", icon: "💬", navKey: "navInbox" },
      { path: "/console/channel-settings", icon: "📡", navKey: "navChannelSettings" },
      { path: "/console/feedback-settings", icon: "⭐", navKey: "navFeedbackSettings" },
      { path: "/console/feedback-responses", icon: "📋", navKey: "navFeedbackResponses" },
    ],
  },
  {
    key: "evaluation",
    labelKey: "groupEvaluation",
    color: "#7c3aed",
    bgColor: "#ede9fe",
    items: [{ path: "/console/conversation-evaluation", icon: "🧪", navKey: "navConversationEvaluation" }],
  },
  {
    key: "operations",
    labelKey: "groupOperations",
    color: "#2563eb",
    bgColor: "#dbeafe",
    items: [
      { path: "/console/agent-settings", icon: "👤", navKey: "navAgentSettings" },
      { path: "/console/kb-gaps", icon: "📚", navKey: "navKbHelper", adminOnly: true },
      { path: "/console/customer360", icon: "👤", navKey: "navCustomer360", adminOnly: true },
      { path: "/console/visitor-analytics", icon: "📊", navKey: "navVisitorAnalytics", adminOnly: true },
    ],
  },
  {
    key: "settings",
    labelKey: "groupSettings",
    color: "#6366f1",
    bgColor: "#ede9fe",
    adminOnly: true,
    items: [{ path: "/console/settings/llm-runtime", icon: "🤖", navKey: "navLLMRuntime", adminOnly: true }],
  },
];

const GROUP_BADGE: Record<string, { label: string; bg: string; color: string }> = {
  "/console": { label: "LIVE INBOX", bg: "#fee2e2", color: "#dc2626" },
  "/console/analytics": { label: "LIVE INBOX", bg: "#fee2e2", color: "#dc2626" },
  "/console/conversations": { label: "LIVE INBOX", bg: "#fee2e2", color: "#dc2626" },
  "/console/agent-settings": { label: "AGENT OPERATIONS", bg: "#dbeafe", color: "#2563eb" },
  "/console/channel-settings": { label: "LIVE INBOX", bg: "#fee2e2", color: "#dc2626" },
  "/console/feedback-settings": { label: "LIVE INBOX", bg: "#fee2e2", color: "#dc2626" },
  "/console/feedback-responses": { label: "LIVE INBOX", bg: "#fee2e2", color: "#dc2626" },
  "/console/settings/llm-runtime": { label: "SETTINGS", bg: "#ede9fe", color: "#6d28d9" },
  "/console/widget-preview": { label: "WIDGET", bg: "#f0fdf4", color: "#16a34a" },
  "/console/conversation-evaluation": { label: "CONVERSATION EVALUATION", bg: "#ede9fe", color: "#6d28d9" },
  "/console/kb-gaps": { label: "KNOWLEDGE", bg: "#ede9fe", color: "#6d28d9" },
  "/console/customer360": { label: "ANALYTICS", bg: "#dbeafe", color: "#2563eb" },
};

const ROLES = [
  { key: "admin", short: "Admin", color: "#dc2626" },
  { key: "supervisor", short: "Sup", color: "#2563eb" },
  { key: "customer_service", short: "CS", color: "#16a34a" },
  { key: "qa_reviewer", short: "QA", color: "#d97706" },
] as const;

// Safe initials: handles empty, multi-space, email local-parts, non-English
function safeInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "U";
  // If it looks like an email local-part (no spaces), take first 2 chars
  if (!trimmed.includes(" ")) return trimmed.slice(0, 2).toUpperCase();
  // Split by whitespace, take first char of first two non-empty words
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return (
    parts
      .slice(0, 2)
      .map((w) => [...w][0] || "")
      .join("")
      .toUpperCase() || "U"
  );
}

/* ── Main Layout ── */
function ConsoleLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { role, loading: roleLoading } = useCurrentRole();
  const [demoRole, setDemoRole] = useState<string>("supervisor");

  // C3: Sync demoRole from resolved auth role exactly once.
  // After initial sync, manual demo switcher clicks are preserved.
  const hasSyncedRole = useRef(false);
  useEffect(() => {
    if (!roleLoading && role && !hasSyncedRole.current) {
      setDemoRole(role);
      hasSyncedRole.current = true;
    }
  }, [role, roleLoading]);

  // C1: Runtime identity from agent_profile with unmount guard + try/catch
  const [userDisplayName, setUserDisplayName] = useState("System");
  const [userInitials, setUserInitials] = useState("U");

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const authUser = authData?.user;
        if (cancelled || !authUser) return;

        const email = authUser.email || "";

        const { data: profile } = await supabase
          .from("agent_profile")
          .select("display_name")
          .eq("user_id", authUser.id)
          .maybeSingle();

        if (cancelled) return;

        if (profile?.display_name) {
          setUserDisplayName(profile.display_name);
          setUserInitials(safeInitials(profile.display_name));
        } else if (email) {
          const localPart = email.split("@")[0] || "System";
          setUserDisplayName(localPart);
          setUserInitials(safeInitials(localPart));
        }
        // If neither available, defaults remain: 'System' / 'U'
      } catch {
        // Auth/profile query failed — keep safe defaults, never Sarah Chen
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const [lang, setLang] = useState<"en" | "zh">("en");
  const [collapsed, setCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Production: sidebar + context use real DB role (normalized by authService).
  // Development: uses demoRole for switcher testing.
  const sidebarRole: string | null = import.meta.env.DEV ? demoRole : (role ?? null);

  const effectiveRoleForContext: EffectiveRole | null = sidebarRole ? mapDemoRoleToEffective(sidebarRole) : null;
  const effectiveRoleContext: ConsoleOutletContext | null =
    effectiveRoleForContext && sidebarRole
      ? { effectiveRole: effectiveRoleForContext, demoRole: sidebarRole, lang }
      : null;

  const t = (key: string) => translations[lang]?.[key] ?? translations.en[key] ?? key;
  const toggleGroup = (key: string) => setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  const showSettingsGroup = sidebarRole === "admin" || sidebarRole === "supervisor";
  // Map production "agent" to display key "customer_service" for ROLES lookup
  const roleDisplayKey: string | null = sidebarRole === "agent" ? "customer_service" : sidebarRole;
  const currentRoleMeta = roleDisplayKey ? ROLES.find((r) => r.key === roleDisplayKey) : null;
  const sidebarW = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED;

  const isConvDetail = pathname.startsWith("/console/conversations/");
  const noPaddingRoutes = ["/console", "/console/conversations"];
  const noPadding = noPaddingRoutes.includes(pathname) || isConvDetail;

  const meta = pageMeta[pathname] || (isConvDetail ? pageMeta["/console"] : null);
  const badgePath = Object.keys(GROUP_BADGE)
    .sort((a, b) => b.length - a.length)
    .find((k) => pathname === k || pathname.startsWith(k + "/"));
  const badge = badgePath ? GROUP_BADGE[badgePath] : null;

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/login" });
  };

  return (
    <div
      style={{
        fontFamily: FONT,
        fontSize: 13,
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        WebkitFontSmoothing: "antialiased",
        color: "#1a1a1a",
      }}
    >
      {/* ── LangBar ── */}
      <div
        style={{
          height: LANGBAR_H,
          background: "#1a1a1a",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          padding: "0 18px",
          gap: 12,
          flexShrink: 0,
        }}
      >
        <button
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.25)",
            background: "transparent",
            color: "#fff",
            cursor: "pointer",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ?
        </button>
        <button
          style={{
            width: 28,
            height: 28,
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.25)",
            background: "transparent",
            color: "#fff",
            cursor: "pointer",
            fontSize: 13,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          ⚙
        </button>
        <span style={{ fontSize: 12, color: "#999" }}>語言 / Language:</span>
        {(
          [
            ["zh", "中文"],
            ["en", "English"],
          ] as const
        ).map(([l, label]) => (
          <button
            key={l}
            onClick={() => setLang(l)}
            style={{
              fontSize: 11,
              padding: "3px 10px",
              borderRadius: 4,
              border: "none",
              cursor: "pointer",
              background: lang === l ? "#fff" : "transparent",
              color: lang === l ? "#1a1a1a" : "#ccc",
              fontWeight: 600,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Body: Sidebar + Main ── */}
      <div style={{ height: `calc(100vh - ${LANGBAR_H}px)`, display: "flex", overflow: "hidden" }}>
        {/* ── Sidebar ── */}
        <aside
          style={{
            width: sidebarW,
            flexShrink: 0,
            background: "#ffffff",
            borderRight: "0.5px solid #e8e6e0",
            overflowY: "auto",
            overflowX: "hidden",
            display: "flex",
            flexDirection: "column",
            transition: "width 0.2s ease",
          }}
        >
          {/* App name row */}
          <div
            style={{
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 10px",
              flexShrink: 0,
              background: "#1a1a1a",
              borderBottom: "0.5px solid #333",
            }}
          >
            {!collapsed && (
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: "#fff",
                  letterSpacing: 0.5,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                }}
              >
                💬 {t("appName")}
              </span>
            )}
            <button
              onClick={() => setCollapsed((c) => !c)}
              style={{
                background: "transparent",
                border: "none",
                color: "#fff",
                cursor: "pointer",
                fontSize: 14,
                width: 24,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                marginLeft: collapsed ? "auto" : 0,
                flexShrink: 0,
              }}
            >
              {collapsed ? "›" : "‹"}
            </button>
          </div>

          {/* User + Role */}
          {!collapsed && (
            <>
              <div
                style={{
                  padding: "11px 14px",
                  borderBottom: "0.5px solid #e8e6e0",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  background: "#ffffff",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: "50%",
                    background: "linear-gradient(135deg, #2563eb, #60a5fa)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <span style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>{userInitials}</span>
                </div>
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: "#1a1a1a",
                      lineHeight: 1.3,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {userDisplayName}
                  </div>
                  <div style={{ fontSize: 11, color: currentRoleMeta?.color ?? "#888", fontWeight: 500 }}>
                    {roleLoading
                      ? "Loading…"
                      : !currentRoleMeta
                        ? "No assigned role"
                        : currentRoleMeta.short === "Sup"
                          ? "Supervisor"
                          : currentRoleMeta.short === "CS"
                            ? "Customer Service"
                            : currentRoleMeta.short === "QA"
                              ? "QA Reviewer"
                              : "Admin"}
                  </div>
                </div>
              </div>
              {import.meta.env.DEV && (
                <div
                  style={{
                    padding: "7px 12px 9px",
                    borderBottom: "0.5px solid #e8e6e0",
                    display: "flex",
                    gap: 4,
                    flexWrap: "wrap",
                    background: "#ffffff",
                    flexShrink: 0,
                  }}
                >
                  {ROLES.map((r) => (
                    <button
                      key={r.key}
                      onClick={() => setDemoRole(r.key as string)}
                      style={{
                        fontSize: 10,
                        fontWeight: demoRole === r.key ? 700 : 600,
                        padding: "3px 9px",
                        borderRadius: 20,
                        border: "none",
                        cursor: "pointer",
                        transition: "all 0.15s",
                        background: demoRole === r.key ? "#1a1a1a" : "#f0efe9",
                        color: demoRole === r.key ? "#ffffff" : "#555",
                      }}
                    >
                      {r.short}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Nav groups */}
          <div style={{ padding: collapsed ? "8px 4px" : "10px 8px", flex: 1, background: "#ffffff" }}>
            {GROUPS.filter((g) => !g.adminOnly || showSettingsGroup).map((g) => {
              const groupCollapsed = collapsedGroups[g.key];
              return (
                <div key={g.key} style={{ marginBottom: 12 }}>
                  {!collapsed && (
                    <div
                      onClick={() => toggleGroup(g.key)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        cursor: "pointer",
                        marginBottom: 4,
                        padding: "2px 4px",
                      }}
                    >
                      <span
                        style={{
                          fontSize: 9.5,
                          fontWeight: 700,
                          letterSpacing: 0.8,
                          color: g.color,
                          background: g.bgColor,
                          padding: "2px 8px",
                          borderRadius: 5,
                        }}
                      >
                        {t(g.labelKey)}
                      </span>
                      <span style={{ fontSize: 10, color: "#aaa", marginLeft: 4 }}>{groupCollapsed ? "∨" : "∧"}</span>
                    </div>
                  )}
                  {!groupCollapsed &&
                    g.items
                      .filter((item) => !(item as any).adminOnly || showSettingsGroup)
                      .map((item) => {
                        const active = pathname === item.path || pathname.startsWith(item.path + "/");
                        return (
                          <Link
                            key={item.path}
                            to={item.path as any}
                            title={collapsed ? t(item.navKey) : ""}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: collapsed ? 0 : 8,
                              padding: collapsed ? "8px 0" : "7px 9px",
                              justifyContent: collapsed ? "center" : "flex-start",
                              borderRadius: 8,
                              marginBottom: 2,
                              textDecoration: "none",
                              background: active ? "#1a1a1a" : "transparent",
                              color: active ? "#ffffff" : "#555",
                              fontSize: 12.5,
                              fontWeight: active ? 600 : 400,
                            }}
                          >
                            <span style={{ fontSize: 14, flexShrink: 0 }}>{item.icon}</span>
                            {!collapsed && (
                              <span
                                style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
                              >
                                {t(item.navKey)}
                              </span>
                            )}
                          </Link>
                        );
                      })}
                </div>
              );
            })}

            {/* Widget Preview (always visible) */}
            {!collapsed && (
              <div style={{ marginTop: 8, borderTop: "0.5px solid #e8e6e0", paddingTop: 8 }}>
                <span
                  style={{
                    fontSize: 9.5,
                    fontWeight: 700,
                    letterSpacing: 0.8,
                    color: "#16a34a",
                    background: "#f0fdf4",
                    padding: "2px 8px",
                    borderRadius: 5,
                  }}
                >
                  WIDGET
                </span>
              </div>
            )}
            <Link
              to={"/console/widget-preview" as any}
              title={collapsed ? t("navWidgetPreview") : ""}
              style={{
                display: "flex",
                alignItems: "center",
                gap: collapsed ? 0 : 8,
                padding: collapsed ? "8px 0" : "7px 9px",
                marginTop: 4,
                justifyContent: collapsed ? "center" : "flex-start",
                borderRadius: 8,
                textDecoration: "none",
                background: pathname === "/console/widget-preview" ? "#1a1a1a" : "transparent",
                color: pathname === "/console/widget-preview" ? "#ffffff" : "#555",
                fontSize: 12.5,
                fontWeight: pathname === "/console/widget-preview" ? 600 : 400,
              }}
            >
              <span style={{ fontSize: 14, flexShrink: 0 }}>🖥️</span>
              {!collapsed && <span>{t("navWidgetPreview")}</span>}
            </Link>
          </div>

          {/* Sign out */}
          <div style={{ padding: "8px 10px", borderTop: "0.5px solid #e8e6e0", flexShrink: 0 }}>
            <button
              onClick={handleSignOut}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "7px 9px",
                width: "100%",
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "#888",
                fontSize: 12.5,
                borderRadius: 8,
                textAlign: "left",
              }}
            >
              {!collapsed && (
                <>
                  <LogOut size={14} /> Sign out
                </>
              )}
              {collapsed && <LogOut size={14} />}
            </button>
          </div>
        </aside>

        {/* ── TopBar + Main ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
          <div
            style={{
              height: TOPBAR_H,
              background: "#fff",
              borderBottom: "0.5px solid #e8e6e0",
              display: "flex",
              alignItems: "center",
              padding: "0 16px",
              gap: 10,
              flexShrink: 0,
            }}
          >
            {badge && (
              <span
                style={{
                  background: badge.bg,
                  color: badge.color,
                  fontSize: 11,
                  fontWeight: 700,
                  padding: "3px 10px",
                  borderRadius: 20,
                  flexShrink: 0,
                }}
              >
                IN: {badge.label}
              </span>
            )}
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: 14.5,
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {meta ? (lang === "zh" ? meta.zh : meta.en) : t("appName")}
              </div>
              {meta?.sub && (
                <div style={{ fontSize: 11, color: "#888" }}>{lang === "zh" ? meta.sub.zh : meta.sub.en}</div>
              )}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  fontSize: 10,
                  background: "#dcfce7",
                  color: "#16a34a",
                  padding: "3px 10px",
                  borderRadius: 20,
                  fontWeight: 600,
                }}
              >
                ● System Operational
              </span>
            </div>
          </div>

          <main style={{ flex: 1, padding: noPadding ? 0 : 16, overflowY: "auto", background: "#f5f4f0" }}>
            {roleLoading ? (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                  color: "#888",
                  fontSize: 13,
                }}
              >
                Loading…
              </div>
            ) : effectiveRoleContext ? (
              <EffectiveRoleProvider value={effectiveRoleContext}>
                <Outlet />
              </EffectiveRoleProvider>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  height: "100%",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 32 }}>🔒</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#374151" }}>No Assigned Role</div>
                <div style={{ fontSize: 12, color: "#888", textAlign: "center", maxWidth: 280 }}>
                  {lang === "zh"
                    ? "您的帳號尚未被指派角色。請聯繫管理員以取得存取權限。"
                    : "Your account does not have an assigned role. Please contact an administrator for access."}
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
