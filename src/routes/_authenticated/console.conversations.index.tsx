import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { feedbackService } from "@/lib/api/feedback.service";

export const Route = createFileRoute("/_authenticated/console/conversations/")({
  component: SinglePageInbox,
});

// ─── Types ───────────────────────────────────────────────────────────────────
type Conv = {
  id: string;
  status: string;
  priority: string | null;
  updated_at: string | null;
  created_at: string | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string;
  channel_config: { name: string } | null;
  visitor_session: { id: string; visitor_metadata?: unknown | null } | null;
  latest_preview: string;
};
type Msg = {
  id: string;
  role: string;
  content: string;
  status: string | null;
  is_recalled: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string | null;
};
type AgentLite = { id: string; display_name: string; role: string; status: string };
type ActivityEvent = {
  ts: string;
  kind: "status" | "assignment" | "handoff";
  label: string;
  detail: string;
  actor: string;
};

// ─── Constants ───────────────────────────────────────────────────────────────
const FILTERS: { key: string | null; label: string }[] = [
  { key: null, label: "All" },
  { key: "human_needed", label: "Human Needed" },
  { key: "ai_handling", label: "AI Handling" },
  { key: "escalation_risk", label: "Escalation Risk" },
  { key: "human_control", label: "Human Control" },
  { key: "unresolved", label: "Unresolved" },
  { key: "resolved", label: "Resolved" },
];
const HANDOFF_KEYWORDS = [
  "human",
  "handoff",
  "agent",
  "operator",
  "staff",
  "support",
  "speak with",
  "talk to",
  "人工",
  "轉人工",
  "真人",
  "客服",
  "職員",
  "專員",
];
const ELEVATED = new Set(["manager", "admin", "super_admin", "supervisor"]);
const ADMIN_ONLY = new Set(["admin", "super_admin"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isHumanNeeded(c: Conv) {
  if (["pending", "unresolved", "human_needed"].includes(c.status)) return true;
  return HANDOFF_KEYWORDS.some((kw) => (c.latest_preview || "").toLowerCase().includes(kw.toLowerCase()));
}
function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function getVisitorLabel(c: Conv) {
  const rawMeta = c.visitor_session?.visitor_metadata;
  const meta =
    rawMeta && typeof rawMeta === "object" && !Array.isArray(rawMeta) ? (rawMeta as Record<string, unknown>) : {};
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  const email = typeof meta.email === "string" ? meta.email.trim() : "";
  const shortId = (c.visitor_session?.id || c.id).slice(0, 8);
  const channel = c.channel_config?.name || "Visitor";
  if (name) return name;
  if (email) return email;
  return `${channel} Visitor #${shortId}`;
}
function getInitials(label: string) {
  return label
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    open: { bg: "#dbeafe", color: "#1d4ed8", label: "Open" },
    human_needed: { bg: "#fee2e2", color: "#991b1b", label: "🔴 Human Needed" },
    ai_handling: { bg: "#d1fae5", color: "#065f46", label: "🤖 AI Handling" },
    escalation_risk: { bg: "#fef3c7", color: "#92400e", label: "⚠ Escalation Risk" },
    human_control: { bg: "#ede9fe", color: "#5b21b6", label: "🟣 Human Control" },
    pending: { bg: "#fef3c7", color: "#92400e", label: "Pending" },
    unresolved: { bg: "#fee2e2", color: "#991b1b", label: "Unresolved" },
    resolved: { bg: "#f0fdf4", color: "#166534", label: "✓ Resolved" },
  };
  const s = map[status] || { bg: "#f1f5f9", color: "#475569", label: status };
  return (
    <span
      style={{
        background: s.bg,
        color: s.color,
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 8px",
        borderRadius: 20,
        whiteSpace: "nowrap" as const,
        flexShrink: 0,
      }}
    >
      {s.label}
    </span>
  );
}

// ─── HandoffBanner (aligned to Base44 HandoffBanner.jsx) ─────────────────────
function HandoffBanner({
  conv,
  messages,
  onResolve,
  onTakeOver,
  onReturnToAi,
}: {
  conv: Conv;
  messages: Msg[];
  onResolve?: () => void;
  onTakeOver: () => void;
  onReturnToAi: () => void;
}) {
  const isHumanControl = conv.status === "pending" && Boolean(conv.assigned_agent_id);
  const isHandoff = isHumanControl || conv.status === "escalation_risk" || isHumanNeeded(conv);
  if (!isHandoff) return null;

  const borderColor = isHumanControl ? "#a78bfa" : "#ef4444";
  const headerBg = isHumanControl ? "#ede9fe" : "#fee2e2";
  const headerColor = isHumanControl ? "#6d28d9" : "#991b1b";

  // Derive precise Detected Issues from all conversation messages
  const visitorMsgs = messages.filter((m) => m.role === "visitor");
  const aiMsgs = messages.filter((m) => m.role === "assistant");
  const aiCount = aiMsgs.length;
  const visitorCount = visitorMsgs.length;
  const allVisitorText = visitorMsgs
    .map((m) => m.content)
    .join(" ")
    .toLowerCase();

  // Detect signals from full conversation
  const hasRefund = allVisitorText.includes("退款") || allVisitorText.includes("refund");
  const hasDamaged =
    allVisitorText.includes("損壞") ||
    allVisitorText.includes("损坏") ||
    allVisitorText.includes("damaged") ||
    allVisitorText.includes("破損");
  const hasUrgent =
    allVisitorText.includes("急") ||
    allVisitorText.includes("urgent") ||
    allVisitorText.includes("今天") ||
    allVisitorText.includes("today");
  const hasAngry =
    allVisitorText.includes("angry") ||
    allVisitorText.includes("😡") ||
    allVisitorText.includes("不滿") ||
    allVisitorText.includes("失去預算") ||
    allVisitorText.includes("unacceptable");
  const hasHuman =
    allVisitorText.includes("真人") ||
    allVisitorText.includes("人工") ||
    allVisitorText.includes("human") ||
    allVisitorText.includes("轉接") ||
    allVisitorText.includes("transfer");
  const hasBudget =
    allVisitorText.includes("預算") ||
    allVisitorText.includes("budget") ||
    allVisitorText.includes("失去") ||
    allVisitorText.includes("超支");

  // Build narrative summary from detected signals
  const summaryParts: string[] = [];
  if (hasRefund) summaryParts.push("requested a refund");
  if (hasDamaged) summaryParts.push("reported damaged goods after delivery");
  if (hasUrgent) summaryParts.push("said the item was urgently needed today");
  if (hasAngry || hasBudget) summaryParts.push("became upset about the budget impact");
  if (hasHuman) summaryParts.push("requested human support");
  if (summaryParts.length === 0) summaryParts.push("escalated the conversation");
  const summaryText = "Customer " + summaryParts.join(", ") + ".";

  // Detected Signals (keyword-based)
  const whyReasons: string[] = [];
  if (hasAngry) whyReasons.push("✓ Angry sentiment detected");
  if (hasRefund) whyReasons.push("✓ Refund / policy issue");
  if (hasDamaged) whyReasons.push("✓ Damaged item after delivery");
  if (hasUrgent) whyReasons.push("✓ Urgent need today");
  if (hasHuman) whyReasons.push("✓ Human support requested");
  if (whyReasons.length === 0) whyReasons.push("✓ AI confidence threshold triggered");

  // Dynamic recommended actions
  const actions: string[] = ["✓ Prioritize human takeover", "✓ Review full conversation"];
  if (hasRefund || hasDamaged) actions.push("✓ Ask for order number");
  if (hasDamaged) actions.push("✓ Request damage photos");
  if (hasHuman) actions.push("✓ Confirm contact method");
  if (hasRefund || hasDamaged) actions.push("✓ Review refund / replacement policy");

  return (
    <div
      style={{
        margin: "8px 10px 0",
        background: "#fff",
        borderRadius: 10,
        overflow: "hidden",
        flexShrink: 0,
        border: `1px solid ${borderColor}`,
      }}
    >
      <div style={{ padding: "9px 12px", display: "flex", alignItems: "center", gap: 8, background: headerBg }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: headerColor }}>
          {isHumanControl
            ? "🟣 Human Control Active — Knowledge Helper available for internal reference only"
            : "🔴 AI Handoff Summary — Human Action Required"}
        </span>
      </div>
      <div style={{ padding: "10px 12px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, fontSize: 12 }}>
        <div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#888",
              textTransform: "uppercase" as const,
              marginBottom: 5,
            }}
          >
            Customer
          </div>
          <div style={{ lineHeight: 1.5, fontSize: 11 }}>{getVisitorLabel(conv)}</div>
          <div style={{ fontSize: 10, color: "#888", marginTop: 2 }}>
            {conv.channel_config?.name || "Web"} · {visitorCount} msg · AI replied {aiCount}×
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#888",
              textTransform: "uppercase" as const,
              marginBottom: 5,
            }}
          >
            Detected Issues
          </div>
          <div style={{ lineHeight: 1.6, fontSize: 11, color: "#1a1a1a" }}>{summaryText}</div>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#888",
              textTransform: "uppercase" as const,
              marginBottom: 4,
            }}
          >
            Detected Signals (keyword-based)
          </div>
          <div style={{ lineHeight: 1.7, marginBottom: 6, fontSize: 11 }}>
            {whyReasons.map((r, i) => (
              <div key={i}>{r}</div>
            ))}
          </div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#888",
              textTransform: "uppercase" as const,
              marginBottom: 4,
            }}
          >
            Recommended Action
          </div>
          <div style={{ fontSize: 11 }}>
            {actions.map((a, i) => (
              <div key={i}>{a}</div>
            ))}
          </div>
        </div>
      </div>
      <div
        style={{
          padding: "8px 12px",
          borderTop: "0.5px solid #e8e6e0",
          display: "flex",
          gap: 6,
          background: isHumanControl ? "#ede9fe" : "#fff",
          alignItems: "center",
          flexWrap: "wrap" as const,
        }}
      >
        {isHumanControl ? (
          <>
            <span style={{ fontSize: 11, color: "#6d28d9", marginRight: "auto" }}>
              🟣 AI will not reply directly. Knowledge Helper remains available for internal reference only.
            </span>
            <BannerBtn label="↩ Return to AI" onClick={onReturnToAi} />
            <BannerBtn label="Keep Human Control" onClick={() => toast.info("Human control maintained")} />
            <BannerBtn label="✓ Resolve Ticket" bg="#2d7d4f" color="#fff" onClick={onResolve} />
          </>
        ) : (
          <>
            <BannerBtn label="🤝 Take Over" bg="#ef4444" color="#fff" onClick={onTakeOver} />
            <BannerBtn label="Assign to Me" onClick={onTakeOver} />
          </>
        )}
      </div>
    </div>
  );
}
function BannerBtn({
  label,
  bg = "#fff",
  color = "#1a1a1a",
  onClick,
}: {
  label: string;
  bg?: string;
  color?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: "5px 11px",
        borderRadius: 8,
        border: bg === "#fff" ? "0.5px solid #e8e6e0" : "none",
        background: bg,
        color,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// ─── CRMPanel ────────────────────────────────────────────────────────────────
function CRMPanel({
  conv,
  visitorLabel,
  onResolve,
}: {
  conv: Conv | null;
  visitorLabel: string;
  onResolve: () => void;
}) {
  const [tab, setTab] = useState("customer");

  useEffect(() => {
    setTab("customer");
  }, [conv?.id]);

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
    { key: "knowledge", label: "Knowledge" },
    { key: "suggestion", label: "AI Suggestion" },
    { key: "policy", label: "Policy" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: "#fff" }}>
      {/* Connection status */}
      <div
        style={{
          padding: "8px 12px",
          borderBottom: "0.5px solid #e8e6e0",
          fontSize: 10,
          color: "#555",
          flexShrink: 0,
          background: "#fff",
        }}
      >
        <div>AI Context: Not connected</div>
        <div>Knowledge Base: Not connected</div>
      </div>

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          borderBottom: "0.5px solid #e8e6e0",
          overflowX: "auto" as const,
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
              whiteSpace: "nowrap" as const,
              color: tab === tb.key ? "#1a1a1a" : "#888",
              borderBottom: tab === tb.key ? "2px solid #1a1a1a" : "2px solid transparent",
              flexShrink: 0,
            }}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: 12, background: "#fff" }}>
        {/* CUSTOMER TAB — Dev22-A2.2: real visitor data + CRM not connected */}
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
                textAlign: "left" as const,
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

        {/* KNOWLEDGE TAB — Dev22-A2.1a: KB not connected */}
        {tab === "knowledge" && (
          <>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              <input
                disabled
                value=""
                placeholder="🔍 Knowledge Base not connected"
                style={{
                  flex: 1,
                  fontSize: 11.5,
                  padding: "6px 9px",
                  borderRadius: 8,
                  border: "0.5px solid #e8e6e0",
                  background: "#f0efe9",
                  outline: "none",
                  cursor: "not-allowed",
                  opacity: 0.6,
                }}
              />
              <button
                disabled
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "6px 12px",
                  borderRadius: 8,
                  border: "none",
                  background: "#d1d5db",
                  color: "#9ca3af",
                  cursor: "not-allowed",
                  opacity: 0.6,
                }}
              >
                Search
              </button>
            </div>
            <div
              style={{
                background: "#f5f4f0",
                borderRadius: 9,
                padding: "12px 14px",
                marginTop: 8,
                fontSize: 11,
                color: "#555",
                lineHeight: 1.6,
              }}
            >
              Knowledge Base is not connected. Search results will appear when KB integration is enabled.
            </div>
          </>
        )}

        {/* AI SUGGESTION TAB — Dev22-A2.1: LLM + KB required */}
        {tab === "suggestion" && (
          <>
            <div style={{ marginBottom: 6 }}>
              <span style={sectionTitle}>AI Suggested Reply</span>
            </div>
            <div
              style={{
                background: "#f5f4f0",
                borderRadius: 9,
                padding: "12px 14px",
                fontSize: 11,
                color: "#555",
                lineHeight: 1.6,
              }}
            >
              AI Suggestions require LLM and Knowledge Base connections. Suggested replies will appear here when both
              integrations are enabled.
            </div>
          </>
        )}

        {/* POLICY TAB — Dev22-A2.1: KB required */}
        {tab === "policy" && (
          <>
            <div style={sectionTitle}>Policy Check</div>
            <div
              style={{
                fontSize: 11.5,
                lineHeight: 1.6,
                background: "#f5f4f0",
                borderRadius: 9,
                padding: "12px 14px",
                color: "#555",
              }}
            >
              Policy lookup requires Knowledge Base connection. Connect KB to enable real-time policy checks during
              conversations.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
function SinglePageInbox() {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conv[] | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [myAgent, setMyAgent] = useState<AgentLite | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [sendGuardOpen, setSendGuardOpen] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityRows, setActivityRows] = useState<ActivityEvent[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  async function loadConversations() {
    const { data: convs, error: cErr } = await supabase
      .from("conversations")
      .select(
        `id,status,priority,updated_at,created_at,assigned_agent_id,channel_config:channel_config_id(name),visitor_session:visitor_session_id(id,visitor_metadata)`,
      )
      .order("updated_at", { ascending: false })
      .limit(50);
    if (cErr) {
      setError(cErr.message);
      return;
    }
    const list = convs ?? [];
    const agentIds = [...new Set(list.filter((c) => c.assigned_agent_id).map((c) => c.assigned_agent_id as string))];
    const agentMap: Record<string, string> = {};
    if (agentIds.length > 0) {
      const { data: ags } = await supabase.from("agent_profile").select("id,display_name").in("id", agentIds);
      ags?.forEach((a) => {
        agentMap[a.id] = a.display_name;
      });
    }
    const previews: Record<string, string> = {};
    if (list.length > 0) {
      const { data: recent } = await supabase
        .from("messages")
        .select("conversation_id,content,created_at,is_recalled")
        .in(
          "conversation_id",
          list.map((c) => c.id),
        )
        .neq("content", "__THINKING__")
        .order("created_at", { ascending: false })
        .limit(500);
      recent?.forEach((m) => {
        if (!previews[m.conversation_id])
          previews[m.conversation_id] = m.is_recalled ? "[訊息已撤回]" : (m.content as string).slice(0, 80);
      });
    }
    setConversations(
      list.map((c) => ({
        ...c,
        assigned_agent_name: c.assigned_agent_id ? agentMap[c.assigned_agent_id] || "Unknown" : "Unassigned",
        latest_preview: previews[c.id] || "(no messages yet)",
      })) as Conv[],
    );
    setError(null);
  }

  const loadMessages = useCallback(async (convId: string, showLoading = false, scrollToBottom = false) => {
    if (showLoading) setLoadingMessages(true);
    const { data } = await supabase
      .from("messages")
      .select("id,role,content,status,is_recalled,metadata,created_at")
      .eq("conversation_id", convId)
      .neq("content", "__THINKING__")
      .order("created_at", { ascending: true });
    setMessages((data as Msg[]) ?? []);
    if (showLoading) setLoadingMessages(false);
    if (showLoading || scrollToBottom) {
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    }
  }, []);

  const loadAgents = useCallback(async () => {
    const { data } = await supabase.from("agent_profile").select("id,display_name,role,status").eq("status", "active");
    setAgents((data as AgentLite[]) ?? []);
  }, []);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("agent_profile")
        .select("id,display_name,role,status")
        .eq("user_id", user.id)
        .maybeSingle();
      setMyAgent((data as AgentLite | null) ?? null);
    })();
  }, [user]);
  useEffect(() => {
    loadConversations();
    loadAgents();
    const t = setInterval(loadConversations, 5000);
    return () => clearInterval(t);
  }, [loadAgents]);
  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setReply("");
      return;
    }
    loadMessages(selectedId, true);
    const t = setInterval(() => loadMessages(selectedId, false), 3000);
    return () => clearInterval(t);
  }, [selectedId, loadMessages]);

  async function callEF(name: string, body: Record<string, unknown>) {
    const { data, error: efErr } = await supabase.functions.invoke(name, { body });
    if (efErr) {
      toast.error(efErr.message);
      return false;
    }
    if (data && (data as { error?: string }).error) {
      toast.error((data as { error: string }).error);
      return false;
    }
    return true;
  }
  async function sendReply() {
    if (!selectedId || !reply.trim()) return;
    setSending(true);
    const ok = await callEF("agent-send-reply", { conversation_id: selectedId, content: reply.trim() });
    setSending(false);
    if (ok) {
      setReply("");
      toast.success("Reply sent");
      loadMessages(selectedId, false, true);
    }
  }
  function handleSendClick() {
    if (!selectedId || !reply.trim()) return;
    const conv = conversations?.find((c) => c.id === selectedId);
    if (!conv) return;
    // Resolved: block send entirely
    if (conv.status === "resolved") {
      toast("This conversation is resolved. Mark unresolved before replying.");
      return;
    }
    // Human-controlled AND assigned to current agent: send directly
    if (conv.status === "pending" && conv.assigned_agent_id === myAgent?.id) {
      sendReply();
      return;
    }
    // All other cases: AI-handled, open, unassigned, or assigned to another agent
    setSendGuardOpen(true);
  }
  async function handleTakeOverAndSend() {
    if (!selectedId) return;
    setSending(true);
    const takeOverOk = await callEF("take-over-conversation", { conversation_id: selectedId });
    if (!takeOverOk) {
      setSending(false);
      setSendGuardOpen(false);
      toast.error("Take over failed. Message not sent.");
      return;
    }
    const sendOk = await callEF("agent-send-reply", { conversation_id: selectedId, content: reply.trim() });
    setSending(false);
    setSendGuardOpen(false);
    if (sendOk) {
      setReply("");
      toast.success("Took over and sent reply");
      loadConversations();
      loadMessages(selectedId, false, true);
    }
  }
  async function handleResolve() {
    const conversationId = selectedId;
    if (!conversationId) return;
    if (await callEF("resolve-conversation", { conversation_id: conversationId })) {
      toast.success("Marked resolved");
      try {
        const schedResult = await feedbackService.scheduleFeedbackRequest(conversationId);
        if (schedResult && !schedResult.ok) {
          toast.warning("Conversation resolved, but feedback scheduling failed.");
        }
      } catch {
        toast.warning("Conversation resolved, but feedback scheduling failed.");
      }
      loadConversations();
    }
  }
  async function handleUnresolve() {
    if (!selectedId) return;
    if (await callEF("mark-unresolved", { conversation_id: selectedId })) {
      toast.success("Marked unresolved");
      loadConversations();
    }
  }
  async function handleAssign(targetId: string) {
    if (!selectedId) return;
    if (await callEF("assign-conversation", { conversation_id: selectedId, target_agent_id: targetId })) {
      toast.success("Assigned");
      loadConversations();
    }
  }
  async function handleTransfer(targetId: string) {
    if (!selectedId) return;
    if (await callEF("transfer-conversation", { conversation_id: selectedId, to_agent_id: targetId })) {
      toast.success("Transferred");
      loadConversations();
      loadMessages(selectedId, false, true);
    }
  }
  async function handleRecall(messageId: string, role: string) {
    if (!myAgent) return;
    if (role === "visitor" && !ADMIN_ONLY.has(myAgent.role)) {
      toast.error("Only admins can recall visitor messages");
      return;
    }
    if (await callEF("recall-message", { message_id: messageId })) {
      toast.success("Message recalled");
      loadMessages(selectedId!, false, true);
    }
  }
  async function handleTakeOver() {
    if (!selectedId) return;
    if (await callEF("take-over-conversation", { conversation_id: selectedId })) {
      toast.success("Conversation taken over");
      loadConversations();
      loadMessages(selectedId, false, true);
    }
  }
  async function handleReturnToAi() {
    if (!selectedId) return;
    if (await callEF("return-to-ai", { conversation_id: selectedId })) {
      toast.success("Returned to AI");
      loadConversations();
      loadMessages(selectedId, false, true);
    }
  }

  // Dev21b Phase 1: Conversation Activity Timeline
  async function loadActivity(convId: string) {
    setActivityLoading(true);
    setActivityRows([]);
    try {
      const [statusRes, assignRes, handoffRes] = await Promise.all([
        supabase
          .from("conversation_status_log")
          .select("created_at,old_status,new_status,reason,changed_by")
          .eq("conversation_id", convId),
        supabase
          .from("conversation_assignment")
          .select("assigned_at,unassigned_at,is_active,agent_id,assigned_by")
          .eq("conversation_id", convId),
        supabase
          .from("handoff_event")
          .select("created_at,handoff_type,handoff_reason,from_agent_id,to_agent_id")
          .eq("conversation_id", convId),
      ]);

      if (statusRes.error || assignRes.error || handoffRes.error) {
        if (statusRes.error) console.error("[activity] conversation_status_log:", statusRes.error.message);
        if (assignRes.error) console.error("[activity] conversation_assignment:", assignRes.error.message);
        if (handoffRes.error) console.error("[activity] handoff_event:", handoffRes.error.message);
        toast.error("Failed to load conversation activity");
        setActivityRows([]);
        return;
      }

      const nameOf = (id: string | null) =>
        id ? agents.find((a) => a.id === id)?.display_name || id.slice(0, 8) : "—";
      const events: ActivityEvent[] = [];
      (statusRes.data ?? []).forEach((r) => {
        events.push({
          ts: r.created_at || "",
          kind: "status",
          label: `Status: ${r.old_status ?? "?"} → ${r.new_status}`,
          detail: r.reason || "",
          actor: nameOf(r.changed_by),
        });
      });
      (assignRes.data ?? []).forEach((r) => {
        events.push({
          ts: r.assigned_at || "",
          kind: "assignment",
          label: `Assignment created → ${nameOf(r.agent_id)}`,
          detail: r.assigned_by ? `by ${nameOf(r.assigned_by)}` : "",
          actor: nameOf(r.assigned_by),
        });
        if (r.unassigned_at) {
          events.push({
            ts: r.unassigned_at,
            kind: "assignment",
            label: `Assignment ended (${nameOf(r.agent_id)})`,
            detail: r.is_active ? "still active" : "",
            actor: nameOf(r.assigned_by),
          });
        }
      });
      (handoffRes.data ?? []).forEach((r) => {
        events.push({
          ts: r.created_at || "",
          kind: "handoff",
          label: `Handoff (${r.handoff_type}): ${nameOf(r.from_agent_id)} → ${nameOf(r.to_agent_id)}`,
          detail: r.handoff_reason || "",
          actor: nameOf(r.from_agent_id),
        });
      });
      events.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
      setActivityRows(events);
    } catch (err) {
      console.error("[activity] unexpected error:", err);
      toast.error("Failed to load conversation activity");
      setActivityRows([]);
    } finally {
      setActivityLoading(false);
    }
  }
  function openActivity() {
    if (!selectedId) return;
    setActivityOpen(true);
    loadActivity(selectedId);
  }

  const stats = useMemo(() => {
    if (!conversations) return { pending_human: 0, high_priority: 0, human_control: 0, ai_handling: 0 };
    return {
      pending_human: conversations.filter((c) => isHumanNeeded(c)).length,
      high_priority: conversations.filter((c) => c.priority === "high").length,
      human_control: conversations.filter((c) => c.status === "pending" && Boolean(c.assigned_agent_id)).length,
      ai_handling: conversations.filter((c) => c.status === "ai_handling" || (!isHumanNeeded(c) && c.status === "open"))
        .length,
    };
  }, [conversations]);

  const filtered = useMemo(() => {
    if (!conversations) return null;
    let list = conversations;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (c) =>
          getVisitorLabel(c).toLowerCase().includes(q) ||
          (c.visitor_session?.id || c.id).toLowerCase().includes(q) ||
          c.latest_preview.toLowerCase().includes(q),
      );
    }
    if (filter === null) return list;
    if (filter === "human_needed") return list.filter((c) => isHumanNeeded(c));
    if (filter === "ai_handling")
      return list.filter((c) => c.status === "ai_handling" || (!isHumanNeeded(c) && c.status === "open"));
    return list.filter((c) => c.status === filter);
  }, [conversations, filter, search]);

  const selectedConv = useMemo(
    () => conversations?.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );
  const visitorLabel = selectedConv ? getVisitorLabel(selectedConv) : "";
  const assignedName = agents.find((a) => a.id === selectedConv?.assigned_agent_id)?.display_name || "Unassigned";
  const isElevated = myAgent ? ELEVATED.has(myAgent.role) : false;
  const transferableAgents = agents.filter((a) => a.id !== myAgent?.id);

  const chipStyle = (active: boolean, special?: boolean): CSSProperties => ({
    fontSize: 10,
    fontWeight: 600,
    padding: "3px 9px",
    borderRadius: 20,
    cursor: "pointer",
    border: active ? "none" : special ? "0.5px solid #f59e0b" : "0.5px solid #e8e6e0",
    background: active ? "#1a1a1a" : special ? "#fef3c7" : "#fff",
    color: active ? "#fff" : special ? "#92400e" : "#555",
    whiteSpace: "nowrap" as const,
  });

  const isHumanControlConv = (c: Conv | null | undefined) => c?.status === "pending" && Boolean(c?.assigned_agent_id);
  const isHumanControl = isHumanControlConv(selectedConv);

  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        overflow: "hidden",
        background: "#f5f4f0",
        fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      }}
    >
      {/* ── LEFT: QueuePanel (320px) ── */}
      <div
        style={{
          width: 320,
          flexShrink: 0,
          background: "#fff",
          borderRight: "0.5px solid #e8e6e0",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "10px 12px", borderBottom: "0.5px solid #e8e6e0", flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 12, fontSize: 10.5, color: "#555" }}>
            <span>
              <b style={{ color: "#991b1b" }}>{stats.pending_human}</b> Pending
            </span>
            <span>
              <b style={{ color: "#92400e" }}>{stats.high_priority}</b> High
            </span>
            <span>
              <b style={{ color: "#6d28d9" }}>{stats.human_control}</b> Human
            </span>
            <span>
              <b style={{ color: "#065f46" }}>{stats.ai_handling}</b> AI
            </span>
          </div>
        </div>
        <div style={{ padding: "8px 12px", borderBottom: "0.5px solid #e8e6e0", flexShrink: 0 }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Search conversations..."
            style={{
              width: "100%",
              fontSize: 11.5,
              padding: "6px 9px",
              borderRadius: 8,
              border: "0.5px solid #e8e6e0",
              background: "#f5f4f0",
              outline: "none",
              boxSizing: "border-box" as const,
            }}
          />
        </div>
        <div
          style={{
            padding: "8px 12px",
            borderBottom: "0.5px solid #e8e6e0",
            display: "flex",
            flexWrap: "wrap" as const,
            gap: 4,
            flexShrink: 0,
          }}
        >
          {FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => setFilter(f.key)}
              style={chipStyle(filter === f.key, f.key === "unresolved")}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div
          style={{
            padding: "5px 12px",
            fontSize: 10,
            color: "#888",
            borderBottom: "0.5px solid #e8e6e0",
            flexShrink: 0,
          }}
        >
          Showing {filtered?.length ?? 0} conversation{filtered?.length !== 1 ? "s" : ""}
        </div>
        {error && (
          <div
            style={{
              margin: "8px 12px",
              padding: "8px 10px",
              background: "#fee2e2",
              border: "0.5px solid #fca5a5",
              borderRadius: 8,
              fontSize: 11,
              color: "#991b1b",
              flexShrink: 0,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ flex: 1, overflowY: "auto" }}>
          {filtered === null && (
            <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} style={{ height: 64, borderRadius: 8, background: "#f1f5f9" }} />
              ))}
            </div>
          )}
          {filtered && filtered.length === 0 && (
            <div style={{ padding: 40, textAlign: "center", fontSize: 12, color: "#888" }}>No conversations found</div>
          )}
          {filtered?.map((c) => {
            const active = c.id === selectedId;
            const humanNeeded = isHumanNeeded(c);
            const slaBreached = c.priority === "high" && humanNeeded;
            return (
              <div
                key={c.id}
                onClick={() => setSelectedId(c.id)}
                style={{
                  padding: "10px 12px",
                  borderBottom: "0.5px solid #e8e6e0",
                  cursor: "pointer",
                  background: active ? "#1a1a1a" : "#fff",
                }}
                onMouseEnter={(e) => {
                  if (!active) (e.currentTarget as HTMLDivElement).style.background = "#f5f4f0";
                }}
                onMouseLeave={(e) => {
                  if (!active) (e.currentTarget as HTMLDivElement).style.background = "#fff";
                }}
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 3 }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600, color: active ? "#fff" : "#1a1a1a" }}>
                    {getVisitorLabel(c)}
                  </span>
                  <span
                    style={{
                      fontSize: 10,
                      color: slaBreached ? "#ef4444" : active ? "rgba(255,255,255,0.5)" : "#888",
                      fontWeight: slaBreached ? 600 : 400,
                    }}
                  >
                    {c.updated_at ? relTime(c.updated_at) : "—"}
                    {slaBreached && " ⚠"}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    marginBottom: 5,
                    whiteSpace: "nowrap" as const,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: active ? "rgba(255,255,255,0.6)" : "#555",
                  }}
                >
                  {c.latest_preview}
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const, alignItems: "center" }}>
                  <StatusBadge status={c.status} />
                  {humanNeeded && c.status !== "human_needed" && (
                    <span
                      style={{
                        background: active ? "rgba(239,68,68,0.3)" : "#fee2e2",
                        color: active ? "#fca5a5" : "#991b1b",
                        fontSize: 10,
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: 20,
                      }}
                    >
                      🔴 Human Needed
                    </span>
                  )}
                  {c.channel_config?.name && (
                    <span
                      style={{
                        background: active ? "rgba(255,255,255,0.15)" : "#f0efe9",
                        color: active ? "#fff" : "#555",
                        fontSize: 10,
                        padding: "2px 8px",
                        borderRadius: 20,
                      }}
                    >
                      {c.channel_config.name}
                    </span>
                  )}
                </div>
                <div style={{ marginTop: 4, fontSize: 10, color: active ? "rgba(255,255,255,0.4)" : "#92400e" }}>
                  {c.assigned_agent_name === "Unassigned" ? "— Unassigned" : `👤 ${c.assigned_agent_name}`}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── MIDDLE: ChatPanel (flex) ── */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "#fff",
          borderRight: "0.5px solid #e8e6e0",
        }}
      >
        {!selectedId ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
            }}
          >
            <div style={{ fontSize: 40 }}>💬</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#374151" }}>Select a conversation</div>
            <div style={{ fontSize: 11, color: "#9ca3af", textAlign: "center" as const, maxWidth: 240 }}>
              Choose a conversation from the left panel to view messages and reply
            </div>
          </div>
        ) : (
          <>
            {/* Chat Header */}
            <div
              style={{ background: "#fff", borderBottom: "0.5px solid #e8e6e0", padding: "8px 12px", flexShrink: 0 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: "50%",
                    background: "#fef3c7",
                    color: "#92400e",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {getInitials(visitorLabel)}
                </div>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{visitorLabel}</span>
                <span style={{ fontSize: 10.5, color: "#888" }}>#{selectedId.slice(0, 8)}</span>
                {selectedConv?.assigned_agent_id ? (
                  <span style={{ fontSize: 10.5, color: "#555" }}>👤 {assignedName}</span>
                ) : (
                  <span style={{ fontSize: 10.5, color: "#92400e" }}>Unassigned</span>
                )}
                {selectedConv && <StatusBadge status={selectedConv.status} />}
                {isHumanControl && (
                  <span
                    style={{
                      background: "#ede9fe",
                      color: "#6d28d9",
                      fontSize: 10,
                      fontWeight: 600,
                      padding: "2px 8px",
                      borderRadius: 20,
                    }}
                  >
                    Human Control Active
                  </span>
                )}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                  {isHumanControl ? (
                    <button
                      onClick={handleReturnToAi}
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "4px 10px",
                        borderRadius: 8,
                        border: "none",
                        background: "#7c3aed",
                        color: "#fff",
                        cursor: "pointer",
                      }}
                    >
                      ↩ Return to AI
                    </button>
                  ) : (
                    <button
                      onClick={handleTakeOver}
                      disabled={selectedConv?.status === "resolved"}
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "4px 10px",
                        borderRadius: 8,
                        border: "none",
                        background: selectedConv?.status === "resolved" ? "#d1d5db" : "#ef4444",
                        color: "#fff",
                        cursor: selectedConv?.status === "resolved" ? "not-allowed" : "pointer",
                      }}
                    >
                      Take Over
                    </button>
                  )}
                  {isElevated && (
                    <Select onValueChange={handleAssign}>
                      <SelectTrigger className="h-7 text-xs w-24">
                        <SelectValue placeholder="Assign to" />
                      </SelectTrigger>
                      <SelectContent>
                        {agents.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.display_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {selectedConv?.status !== "unresolved" && (
                    <Button size="sm" variant="outline" onClick={handleUnresolve}>
                      Mark Unresolved
                    </Button>
                  )}
                  <Select onValueChange={handleTransfer}>
                    <SelectTrigger className="h-7 text-xs w-28">
                      <SelectValue placeholder="Transfer to" />
                    </SelectTrigger>
                    <SelectContent>
                      {transferableAgents.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.display_name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedConv?.status !== "resolved" && (
                    <Button size="sm" variant="outline" onClick={handleResolve}>
                      Resolve
                    </Button>
                  )}
                  {(myAgent?.role === "admin" || myAgent?.role === "supervisor" || myAgent?.role === "super_admin") && (
                    <button
                      onClick={openActivity}
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        padding: "4px 10px",
                        borderRadius: 8,
                        border: "0.5px solid #e8e6e0",
                        background: "#fff",
                        color: "#1a1a1a",
                        cursor: "pointer",
                      }}
                    >
                      Activity
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* HandoffBanner */}
            {selectedConv && (
              <HandoffBanner
                conv={selectedConv}
                messages={messages}
                onResolve={handleResolve}
                onTakeOver={handleTakeOver}
                onReturnToAi={handleReturnToAi}
              />
            )}

            {/* Messages */}
            <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
              {loadingMessages && (
                <div style={{ display: "flex", justifyContent: "center", padding: 20 }}>
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {!loadingMessages && messages.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-8">No messages yet.</div>
              )}
              {messages.map((m) => {
                const isVisitor = m.role === "visitor",
                  isAgent = m.role === "agent",
                  isAssistant = m.role === "assistant";
                const isLowConf =
                  isAssistant &&
                  (m.metadata as { confidence_score?: number } | null)?.confidence_score != null &&
                  (m.metadata as { confidence_score: number }).confidence_score < 40;
                let bubbleStyle: CSSProperties;
                if (isVisitor)
                  bubbleStyle = {
                    maxWidth: "78%",
                    padding: "8px 11px",
                    borderRadius: 9,
                    fontSize: 12,
                    lineHeight: 1.55,
                    background: "#1a1a1a",
                    color: "#fff",
                    borderBottomRightRadius: 3,
                    marginLeft: "auto",
                  };
                else if (isAssistant && isLowConf)
                  bubbleStyle = {
                    maxWidth: "78%",
                    padding: "8px 11px",
                    borderRadius: 9,
                    fontSize: 12,
                    lineHeight: 1.55,
                    background: "#fff4f4",
                    border: "0.5px solid #fca5a5",
                    borderBottomLeftRadius: 3,
                    color: "#991b1b",
                  };
                else if (isAssistant)
                  bubbleStyle = {
                    maxWidth: "78%",
                    padding: "8px 11px",
                    borderRadius: 9,
                    fontSize: 12,
                    lineHeight: 1.55,
                    background: "#fff",
                    border: "0.5px solid #e8e6e0",
                    borderBottomLeftRadius: 3,
                  };
                else
                  bubbleStyle = {
                    maxWidth: "78%",
                    padding: "8px 11px",
                    borderRadius: 9,
                    fontSize: 12,
                    lineHeight: 1.55,
                    background: "#d1fae5",
                    borderBottomLeftRadius: 3,
                    color: "#065f46",
                  };
                const agentName = (m.metadata as { agent_name?: string } | null)?.agent_name;
                const confScore = (m.metadata as { confidence_score?: number } | null)?.confidence_score;
                return (
                  <div
                    key={m.id}
                    style={{
                      marginBottom: 10,
                      display: "flex",
                      flexDirection: "column",
                      alignItems: isVisitor ? "flex-end" : "flex-start",
                    }}
                  >
                    <div
                      style={{
                        marginBottom: 2,
                        fontSize: 10,
                        color: isVisitor ? "#888" : isAgent ? "#2d7d4f" : isLowConf ? "#ef4444" : "#3b82f6",
                      }}
                    >
                      {isVisitor
                        ? "Customer"
                        : isAgent
                          ? `Human Agent · ${agentName || "You"}`
                          : isLowConf
                            ? `AI (low confidence ${confScore}%)`
                            : "AI"}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        maxWidth: "100%",
                        flexDirection: isVisitor ? "row-reverse" : "row",
                        alignSelf: isVisitor ? "flex-end" : "flex-start",
                        width: "100%",
                      }}
                    >
                      {m.is_recalled ? (
                        <div style={{ fontSize: 12, color: "#888", fontStyle: "italic", padding: "8px 11px" }}>
                          [訊息已撤回]
                        </div>
                      ) : (
                        <div style={bubbleStyle}>
                          <div className="whitespace-pre-wrap">{m.content}</div>
                        </div>
                      )}
                      {!m.is_recalled &&
                        (isAgent || isAssistant || (isVisitor && myAgent && ADMIN_ONLY.has(myAgent.role))) && (
                          <button
                            onClick={() => handleRecall(m.id, m.role)}
                            style={{
                              border: "none",
                              background: "transparent",
                              cursor: "pointer",
                              color: "#888",
                              fontSize: 14,
                              padding: "0 4px",
                            }}
                          >
                            ⋯
                          </button>
                        )}
                    </div>
                  </div>
                );
              })}
              {isHumanControl && (
                <div style={{ textAlign: "center" as const, padding: "6px 0" }}>
                  <span
                    style={{
                      fontSize: 11,
                      background: "#ede9fe",
                      color: "#7c3aed",
                      borderRadius: 20,
                      padding: "3px 10px",
                    }}
                  >
                    🟣 Human Control Active — AI is assisting only
                  </span>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <div style={{ background: "#fff", borderTop: "0.5px solid #e8e6e0", padding: "8px 12px", flexShrink: 0 }}>
              <div
                style={{ display: "flex", gap: 6, marginBottom: 8, alignItems: "center", flexWrap: "wrap" as const }}
              >
                <button
                  disabled
                  type="button"
                  title="Requires KB connection"
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    padding: "4px 10px",
                    borderRadius: 8,
                    border: "none",
                    background: "#d1d5db",
                    color: "#9ca3af",
                    cursor: "not-allowed",
                    opacity: 0.6,
                  }}
                >
                  Check Policy
                </button>
                <button
                  disabled
                  type="button"
                  title="Coming soon"
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    padding: "4px 10px",
                    borderRadius: 8,
                    border: "none",
                    background: "#d1d5db",
                    color: "#9ca3af",
                    cursor: "not-allowed",
                    opacity: 0.6,
                  }}
                >
                  Translate
                </button>
                <button
                  disabled
                  type="button"
                  title="Coming soon"
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    padding: "4px 10px",
                    borderRadius: 8,
                    border: "none",
                    background: "#d1d5db",
                    color: "#9ca3af",
                    cursor: "not-allowed",
                    opacity: 0.6,
                  }}
                >
                  Grammar Check
                </button>
                {isHumanControl && (
                  <span style={{ fontSize: 10, color: "#7c3aed", marginLeft: "auto" }}>
                    🟣 Knowledge Helper available for internal reference only
                  </span>
                )}
              </div>
              <Textarea
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Type your reply…"
                rows={2}
                maxLength={4000}
                className="mb-2 text-sm"
              />
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 14, cursor: "pointer" }}>😊</span>
                <span style={{ fontSize: 14, cursor: "pointer" }}>🖼️</span>
                <span style={{ fontSize: 14, cursor: "pointer" }}>📎</span>
                <Button onClick={handleSendClick} disabled={sending || !reply.trim()} className="ml-auto">
                  {sending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending…
                    </>
                  ) : (
                    "Send"
                  )}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── RIGHT: CRMPanel (360px) ── */}
      <div style={{ width: 360, flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <CRMPanel conv={selectedConv} visitorLabel={visitorLabel || "Visitor"} onResolve={handleResolve} />
      </div>

      {/* Dev22-A2.3: Send Guard — Take Over Confirmation */}
      <Dialog open={sendGuardOpen} onOpenChange={setSendGuardOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Take Over Conversation?</DialogTitle>
            <DialogDescription>
              This conversation is not currently under your control. Take over before sending this message?
            </DialogDescription>
          </DialogHeader>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
            <Button variant="outline" size="sm" onClick={() => setSendGuardOpen(false)} disabled={sending}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleTakeOverAndSend} disabled={sending}>
              {sending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing…
                </>
              ) : (
                "Take Over & Send"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dev21b Phase 1: Conversation Activity Timeline */}
      <Dialog open={activityOpen} onOpenChange={setActivityOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Conversation Activity Timeline</DialogTitle>
            <DialogDescription>
              Showing status, assignment, and handoff events. Full audit_log is reserved for admin audit view.
            </DialogDescription>
          </DialogHeader>
          <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {activityLoading && (
              <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
            {!activityLoading && activityRows.length === 0 && (
              <div style={{ padding: 24, textAlign: "center", fontSize: 13, color: "#888" }}>
                No status, assignment, or handoff activity recorded for this conversation.
              </div>
            )}
            {!activityLoading &&
              activityRows.map((e, i) => {
                const dot = e.kind === "status" ? "#2563eb" : e.kind === "assignment" ? "#16a34a" : "#7c3aed";
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      gap: 10,
                      padding: "8px 4px",
                      borderBottom: "0.5px solid #f0efe9",
                    }}
                  >
                    <div
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: dot,
                        marginTop: 5,
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: "#1a1a1a" }}>{e.label}</div>
                      {e.detail && <div style={{ fontSize: 11, color: "#555", marginTop: 1 }}>{e.detail}</div>}
                      <div style={{ fontSize: 10.5, color: "#888", marginTop: 2 }}>
                        {e.actor !== "—" ? `${e.actor} · ` : ""}
                        {e.ts ? new Date(e.ts).toLocaleString() : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
