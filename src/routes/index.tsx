import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState, useRef, type CSSProperties } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/")({
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

const ELEVATED = new Set(["manager", "admin", "super_admin"]);
const ADMIN_ONLY = new Set(["admin", "super_admin"]);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isHumanNeeded(c: Conv): boolean {
  if (["pending", "unresolved", "human_needed"].includes(c.status)) return true;
  const preview = (c.latest_preview || "").toLowerCase();
  return HANDOFF_KEYWORDS.some((kw) => preview.includes(kw.toLowerCase()));
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

function getVisitorLabel(c: Conv): string {
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

// ─── Main Component ───────────────────────────────────────────────────────────
function SinglePageInbox() {
  const { user } = useAuth();

  // ── Left panel state ──────────────────────────────────────────────────────
  const [conversations, setConversations] = useState<Conv[] | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  // ── Selection state (Base44 selectedId pattern) ───────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── Middle panel state ────────────────────────────────────────────────────
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [myAgent, setMyAgent] = useState<AgentLite | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ─── LEFT PANEL: Conversation list query (Phase-1 preserved) ─────────────
  async function loadConversations() {
    const { data: convs, error: cErr } = await supabase
      .from("conversations")
      .select(
        `
        id, status, priority, updated_at, created_at, assigned_agent_id,
        channel_config:channel_config_id(name),
        visitor_session:visitor_session_id(id, visitor_metadata)
      `,
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
      const { data: ags } = await supabase.from("agent_profile").select("id, display_name").in("id", agentIds);
      ags?.forEach((a) => {
        agentMap[a.id] = a.display_name;
      });
    }

    const previews: Record<string, string> = {};
    if (list.length > 0) {
      const { data: recent } = await supabase
        .from("messages")
        .select("conversation_id, content, created_at, is_recalled")
        .in(
          "conversation_id",
          list.map((c) => c.id),
        )
        .neq("content", "__THINKING__")
        .order("created_at", { ascending: false })
        .limit(500);
      recent?.forEach((m) => {
        if (!previews[m.conversation_id]) {
          previews[m.conversation_id] = m.is_recalled ? "[訊息已撤回]" : (m.content as string).slice(0, 80);
        }
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

  // ─── MIDDLE PANEL: Messages query (from $id.tsx pattern) ─────────────────
  const loadMessages = useCallback(async (convId: string, showLoading = false) => {
    if (showLoading) setLoadingMessages(true);
    const { data } = await supabase
      .from("messages")
      .select("id, role, content, status, is_recalled, metadata, created_at")
      .eq("conversation_id", convId)
      .neq("content", "__THINKING__")
      .order("created_at", { ascending: true });
    setMessages((data as Msg[]) ?? []);
    if (showLoading) setLoadingMessages(false);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  // ─── Agents query (from $id.tsx pattern) ─────────────────────────────────
  const loadAgents = useCallback(async () => {
    const { data } = await supabase
      .from("agent_profile")
      .select("id, display_name, role, status")
      .eq("status", "active");
    setAgents((data as AgentLite[]) ?? []);
  }, []);

  // ─── myAgent query (from $id.tsx pattern) ────────────────────────────────
  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("agent_profile")
        .select("id, display_name, role, status")
        .eq("user_id", user.id)
        .maybeSingle();
      setMyAgent((data as AgentLite | null) ?? null);
    })();
  }, [user]);

  // ─── Polling: conversation list (5s) + messages (3s when selected) ────────
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

  // ─── Edge Function caller (from $id.tsx — same pattern) ──────────────────
  // Edge functions used: agent-send-reply, resolve-conversation, mark-unresolved,
  // assign-conversation, transfer-conversation, recall-message
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
      loadMessages(selectedId);
    }
  }

  async function handleResolve() {
    if (!selectedId) return;
    if (await callEF("resolve-conversation", { conversation_id: selectedId })) {
      toast.success("Marked resolved");
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
      loadMessages(selectedId);
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
      loadMessages(selectedId!);
    }
  }

  // ─── Derived state ────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!conversations) return { pending_human: 0, high_priority: 0, human_control: 0, ai_handling: 0 };
    return {
      pending_human: conversations.filter((c) => isHumanNeeded(c)).length,
      high_priority: conversations.filter((c) => c.priority === "high").length,
      human_control: conversations.filter((c) => c.status === "human_control").length,
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
    if (filter === "ai_handling") {
      return list.filter((c) => c.status === "ai_handling" || (!isHumanNeeded(c) && c.status === "open"));
    }
    return list.filter((c) => c.status === filter);
  }, [conversations, filter, search]);

  const selectedConv = useMemo(
    () => conversations?.find((c) => c.id === selectedId) ?? null,
    [conversations, selectedId],
  );
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

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      style={{
        display: "flex",
        height: "100%",
        overflow: "hidden",
        background: "#f5f4f0",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      {/* ── LEFT: QueuePanel (320px) ───────────────────────────────────────── */}
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
        {/* Stats bar */}
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

        {/* Search */}
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

        {/* Filter chips */}
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

        {/* Count */}
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

        {/* Conversation list — click sets selectedId, NO Link navigation */}
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

      {/* ── MIDDLE: ChatPanel (flex) ────────────────────────────────────────── */}
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
            <div style={{ fontSize: 11, color: "#9ca3af", textAlign: "center", maxWidth: 240 }}>
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
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: "#fef3c7",
                    color: "#92400e",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {selectedConv ? getVisitorLabel(selectedConv).slice(0, 2).toUpperCase() : "??"}
                </div>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                  {selectedConv ? getVisitorLabel(selectedConv) : "—"}
                </span>
                <span style={{ fontSize: 10, color: "#888" }}>#{selectedId.slice(0, 8)}</span>
                {selectedConv && (
                  <Badge variant="secondary" className="capitalize">
                    {selectedConv.status}
                  </Badge>
                )}
                <span style={{ fontSize: 10.5, color: selectedConv?.assigned_agent_id ? "#555" : "#92400e" }}>
                  {selectedConv?.assigned_agent_id ? `👤 ${assignedName}` : "Unassigned"}
                </span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                  {selectedConv?.status !== "resolved" && (
                    <Button size="sm" variant="outline" onClick={handleResolve}>
                      Resolve
                    </Button>
                  )}
                  {selectedConv?.status !== "unresolved" && (
                    <Button size="sm" variant="outline" onClick={handleUnresolve}>
                      Mark Unresolved
                    </Button>
                  )}
                  {isElevated && (
                    <Select onValueChange={handleAssign}>
                      <SelectTrigger className="h-7 text-xs w-28">
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
                </div>
              </div>
            </div>

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
                const isVisitor = m.role === "visitor";
                const isAgent = m.role === "agent";
                const isAssistant = m.role === "assistant";
                const bubbleClass = isVisitor
                  ? "ml-auto bg-muted text-foreground"
                  : isAgent
                    ? "bg-blue-500/15 text-blue-900 dark:text-blue-100"
                    : isAssistant
                      ? "bg-purple-500/15 text-purple-900 dark:text-purple-100"
                      : "bg-muted";
                const agentName = (m.metadata as { agent_name?: string } | null)?.agent_name;
                return (
                  <div key={m.id} className={`group mb-2 max-w-[80%] rounded-lg px-3 py-2 text-sm ${bubbleClass}`}>
                    {isAgent && agentName && <div className="text-[10px] font-medium opacity-70">{agentName}</div>}
                    {isAssistant && <div className="text-[10px] font-medium opacity-70">AI</div>}
                    {m.is_recalled ? (
                      <div className="italic text-muted-foreground">[訊息已撤回]</div>
                    ) : (
                      <div className="whitespace-pre-wrap">{m.content}</div>
                    )}
                    {!m.is_recalled &&
                      (isAgent || isAssistant || (isVisitor && myAgent && ADMIN_ONLY.has(myAgent.role))) && (
                        <button
                          onClick={() => handleRecall(m.id, m.role)}
                          className="mt-1 hidden text-[10px] text-destructive underline group-hover:inline"
                        >
                          Recall
                        </button>
                      )}
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Composer */}
            <div style={{ background: "#fff", borderTop: "0.5px solid #e8e6e0", padding: "8px 12px", flexShrink: 0 }}>
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                <button
                  onClick={() => toast("Policy check (Mock)")}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    padding: "4px 10px",
                    borderRadius: 8,
                    border: "none",
                    background: "#1a1a1a",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  Check Policy
                </button>
                <button
                  onClick={() => toast("Translate (Mock)")}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    padding: "4px 10px",
                    borderRadius: 8,
                    border: "none",
                    background: "#3b82f6",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  Translate ▼
                </button>
                <button
                  onClick={() => toast("Grammar check (Mock)")}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    padding: "4px 10px",
                    borderRadius: 8,
                    border: "none",
                    background: "#6366f1",
                    color: "#fff",
                    cursor: "pointer",
                  }}
                >
                  Grammar Check
                </button>
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
                <Button onClick={sendReply} disabled={sending || !reply.trim()} className="ml-auto">
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

      {/* ── RIGHT: CRMPanel placeholder (300px) ────────────────────────────── */}
      <div
        style={{
          width: 300,
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
            fontSize: 10,
            color: "#888",
            flexShrink: 0,
          }}
        >
          <div>Context Panel Placeholder</div>
          <div>Live integrations disabled for demo</div>
        </div>
        {selectedConv ? (
          <div style={{ padding: 12, overflowY: "auto", flex: 1 }}>
            {/* Visitor header */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
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
                }}
              >
                {getVisitorLabel(selectedConv).slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{getVisitorLabel(selectedConv)}</div>
                <div style={{ fontSize: 10, color: "#888" }}>{selectedConv.channel_config?.name || "—"}</div>
              </div>
            </div>
            {/* Basic info */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12, fontSize: 11 }}>
              {[
                ["Status", selectedConv.status],
                ["Channel", selectedConv.channel_config?.name || "—"],
                ["Assigned", assignedName],
              ].map(([l, v]) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#888" }}>{l}</span>
                  <span style={{ fontWeight: 500, color: "#1a1a1a" }}>{v}</span>
                </div>
              ))}
            </div>
            {/* CRM placeholder */}
            <div
              style={{
                background: "#f5f4f0",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 10,
                color: "#888",
                lineHeight: 1.6,
                marginBottom: 12,
              }}
            >
              📊 Customer / Knowledge / AI Suggestion / Policy tabs coming in Phase-2C
            </div>
            <Link
              to="/console/customer360"
              style={{
                display: "block",
                textAlign: "center",
                fontSize: 11,
                fontWeight: 600,
                color: "#6366f1",
                textDecoration: "none",
                background: "#ede9fe",
                padding: "6px 12px",
                borderRadius: 6,
              }}
            >
              ↗ Open Full Customer 360
            </Link>
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: 20,
              textAlign: "center" as const,
            }}
          >
            <div style={{ fontSize: 28 }}>👤</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8" }}>Customer Context</div>
            <div style={{ fontSize: 10, color: "#cbd5e1", lineHeight: 1.6 }}>
              Select a conversation to view customer context.
              <br />
              Full CRM panel coming in Phase-2C.
            </div>
            <Link
              to="/console/customer360"
              style={{
                marginTop: 8,
                fontSize: 11,
                fontWeight: 600,
                color: "#6366f1",
                textDecoration: "none",
                background: "#ede9fe",
                padding: "4px 10px",
                borderRadius: 6,
              }}
            >
              ↗ Open Customer 360
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
