import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";

export const Route = createFileRoute("/_authenticated/console/conversations/")({
  component: ConversationsList,
});

type Conv = {
  id: string;
  status: string;
  priority: string | null;
  updated_at: string | null;
  created_at: string | null;
  assigned_agent_id: string | null;
  assigned_agent_name: string;
  channel_config: { name: string } | null;
  visitor_session: { id: string } | null;
  latest_preview: string;
};

const STATUS_TABS = ["all", "open", "human_needed", "pending", "unresolved", "resolved"] as const;
type StatusTab = (typeof STATUS_TABS)[number];

const STATUS_COLORS: Record<string, string> = {
  open: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  human_needed: "bg-red-500/15 text-red-700 dark:text-red-300",
  pending: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
  unresolved: "bg-red-500/15 text-red-700 dark:text-red-300",
  resolved: "bg-gray-500/15 text-gray-700 dark:text-gray-300",
};

const HANDOFF_KEYWORDS = [
  'human', 'handoff', 'agent', 'operator', 'staff', 'support',
  'speak with', 'talk to', '人工', '轉人工', '真人', '客服', '職員', '專員',
];

function isHumanNeeded(c: Conv): boolean {
  if (['pending', 'unresolved', 'human_needed'].includes(c.status)) return true;
  const preview = (c.latest_preview || '').toLowerCase();
  return HANDOFF_KEYWORDS.some(kw => preview.includes(kw.toLowerCase()));
}

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function ConversationsList() {
  const [conversations, setConversations] = useState<Conv[] | null>(null);
  const [tab, setTab] = useState<StatusTab>("all");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    // MicroPatch 1: 2-step fetch (no nested assigned_agent join)
    const { data: convs, error: cErr } = await supabase
      .from("conversations")
      .select(`
        id, status, priority, updated_at, created_at, assigned_agent_id,
        channel_config:channel_config_id(name),
        visitor_session:visitor_session_id(id)
      `)
      .order("updated_at", { ascending: false })
      .limit(50);

    if (cErr) {
      setError(cErr.message);
      return;
    }
    const list = convs ?? [];

    const agentIds = [
      ...new Set(list.filter((c) => c.assigned_agent_id).map((c) => c.assigned_agent_id as string)),
    ];
    const agentMap: Record<string, string> = {};
    if (agentIds.length > 0) {
      const { data: agents } = await supabase
        .from("agent_profile")
        .select("id, display_name")
        .in("id", agentIds);
      agents?.forEach((a) => {
        agentMap[a.id] = a.display_name;
      });
    }

    // Latest preview per conversation
    const previews: Record<string, string> = {};
    if (list.length > 0) {
      const { data: msgs } = await supabase
        .from("messages")
        .select("conversation_id, content, created_at, is_recalled")
        .in("id", []) // placeholder no-op
        .limit(0);
      void msgs;
      // Fetch latest message per conversation in a single bulk query then pick latest
      const { data: recent } = await supabase
        .from("messages")
        .select("conversation_id, content, created_at, is_recalled")
        .in("conversation_id", list.map((c) => c.id))
        .neq("content", "__THINKING__")
        .order("created_at", { ascending: false })
        .limit(500);
      recent?.forEach((m) => {
        if (!previews[m.conversation_id]) {
          previews[m.conversation_id] = m.is_recalled
            ? "[訊息已撤回]"
            : (m.content as string).slice(0, 80);
        }
      });
    }

    const enriched: Conv[] = list.map((c) => ({
      ...c,
      assigned_agent_name: c.assigned_agent_id
        ? agentMap[c.assigned_agent_id] || "Unknown"
        : "Unassigned",
      latest_preview: previews[c.id] || "(no messages yet)",
    }));
    setConversations(enriched);
    setError(null);
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const humanNeededCount = useMemo(() => {
    if (!conversations) return 0;
    return conversations.filter(c => isHumanNeeded(c)).length;
  }, [conversations]);

  const filtered = useMemo(() => {
    if (!conversations) return null;
    if (tab === "all") return conversations;
    if (tab === "human_needed") return conversations.filter(c => isHumanNeeded(c));
    return conversations.filter((c) => c.status === tab);
  }, [conversations, tab]);

  return (
    <div className="space-y-4">
      <div style={{ display: 'flex', gap: 16, padding: '8px 0', fontSize: 12, color: '#555' }}>
        <span><b style={{ color: '#2563eb' }}>{conversations?.filter(c => c.status === 'open').length || 0}</b> Open</span>
        <span><b style={{ color: '#dc2626' }}>{humanNeededCount}</b> Human Needed</span>
        <span><b style={{ color: '#6b7280' }}>{conversations?.filter(c => c.status === 'resolved').length || 0}</b> Resolved</span>
      </div>
      <div>
        <h1 className="text-2xl font-semibold">Conversations</h1>
        <p className="text-sm text-muted-foreground">Inbox of recent visitor conversations.</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as StatusTab)}>
        <TabsList>
          {STATUS_TABS.map((s) => (
            <TabsTrigger key={s} value={s} className="capitalize">
              {s}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="divide-y rounded-md border">
        {filtered === null && (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        )}
        {filtered && filtered.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">No conversations yet</div>
        )}
        {filtered?.map((c) => (
          <Link
            key={c.id}
            to="/console/conversations/$id"
            params={{ id: c.id }}
            className="flex items-center gap-4 p-3 hover:bg-muted/50"
          >
            <Badge className={STATUS_COLORS[c.status] || ""} variant="secondary">
              {c.status}
            </Badge>
            {isHumanNeeded(c) && c.status !== 'human_needed' && (
              <Badge className="bg-red-500/15 text-red-700" variant="secondary">
                🔴 Human Needed
              </Badge>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span>#{(c.visitor_session?.id || c.id).slice(0, 8)}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{c.channel_config?.name || "—"}</span>
              </div>
              <div className="truncate text-xs text-muted-foreground">{c.latest_preview}</div>
            </div>
            <div className="text-right text-xs text-muted-foreground">
              <div>{c.assigned_agent_name}</div>
              <div>{c.updated_at ? relTime(c.updated_at) : "—"}</div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
