import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated/console/conversations/")({
  component: ConversationsList,
});

// ─── Types (unchanged from original) ─────────────────────────────────────────
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

// ─── Filter definitions (Base44 QueuePanel aligned) ──────────────────────────
const FILTERS: { key: string | null; label: string }[] = [
  { key: null,              label: 'All' },
  { key: 'human_needed',   label: 'Human Needed' },
  { key: 'ai_handling',    label: 'AI Handling' },
  { key: 'escalation_risk',label: 'Escalation Risk' },
  { key: 'human_control',  label: 'Human Control' },
  { key: 'unresolved',     label: 'Unresolved' },
  { key: 'resolved',       label: 'Resolved' },
];

// ─── Helpers (preserved from original) ───────────────────────────────────────
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
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ─── Status badge mapping (Base44 aligned) ───────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    open:             { bg: '#dbeafe', color: '#1d4ed8', label: 'Open' },
    human_needed:     { bg: '#fee2e2', color: '#991b1b', label: '🔴 Human Needed' },
    ai_handling:      { bg: '#d1fae5', color: '#065f46', label: '🤖 AI Handling' },
    escalation_risk:  { bg: '#fef3c7', color: '#92400e', label: '⚠ Escalation Risk' },
    human_control:    { bg: '#ede9fe', color: '#5b21b6', label: '🟣 Human Control' },
    pending:          { bg: '#fef3c7', color: '#92400e', label: 'Pending' },
    unresolved:       { bg: '#fee2e2', color: '#991b1b', label: 'Unresolved' },
    resolved:         { bg: '#f0fdf4', color: '#166534', label: '✓ Resolved' },
  };
  const s = map[status] || { bg: '#f1f5f9', color: '#475569', label: status };
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20, whiteSpace: 'nowrap' as const, flexShrink: 0 }}>
      {s.label}
    </span>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
function ConversationsList() {
  const [conversations, setConversations] = useState<Conv[] | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── Data fetching (preserved from original) ──────────────────────────
  async function load() {
    const { data: convs, error: cErr } = await supabase
      .from("conversations")
      .select(`
        id, status, priority, updated_at, created_at, assigned_agent_id,
        channel_config:channel_config_id(name),
        visitor_session:visitor_session_id(id)
      `)
      .order("updated_at", { ascending: false })
      .limit(50);

    if (cErr) { setError(cErr.message); return; }
    const list = convs ?? [];

    const agentIds = [...new Set(list.filter((c) => c.assigned_agent_id).map((c) => c.assigned_agent_id as string))];
    const agentMap: Record<string, string> = {};
    if (agentIds.length > 0) {
      const { data: agents } = await supabase.from("agent_profile").select("id, display_name").in("id", agentIds);
      agents?.forEach((a) => { agentMap[a.id] = a.display_name; });
    }

    const previews: Record<string, string> = {};
    if (list.length > 0) {
      const { data: recent } = await supabase
        .from("messages")
        .select("conversation_id, content, created_at, is_recalled")
        .in("conversation_id", list.map((c) => c.id))
        .neq("content", "__THINKING__")
        .order("created_at", { ascending: false })
        .limit(500);
      recent?.forEach((m) => {
        if (!previews[m.conversation_id]) {
          previews[m.conversation_id] = m.is_recalled ? "[訊息已撤回]" : (m.content as string).slice(0, 80);
        }
      });
    }

    const enriched: Conv[] = list.map((c) => ({
      ...c,
      assigned_agent_name: c.assigned_agent_id ? agentMap[c.assigned_agent_id] || "Unknown" : "Unassigned",
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

  // ── Stats (Base44 QueuePanel aligned) ────────────────────────────────────
  const stats = useMemo(() => {
    if (!conversations) return { pending_human: 0, high_priority: 0, human_control: 0, ai_handling: 0 };
    return {
      pending_human: conversations.filter(c => isHumanNeeded(c)).length,
      high_priority: conversations.filter(c => c.priority === 'high').length,
      human_control: conversations.filter(c => c.status === 'human_control').length,
      ai_handling: conversations.filter(c => c.status === 'ai_handling' || (!isHumanNeeded(c) && c.status === 'open')).length,
    };
  }, [conversations]);

  // ── Filtering ─────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!conversations) return null;
    let list = conversations;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        (c.visitor_session?.id || c.id).toLowerCase().includes(q) ||
        c.latest_preview.toLowerCase().includes(q) ||
        (c.channel_config?.name || '').toLowerCase().includes(q)
      );
    }
    if (filter === null) return list;
    if (filter === 'human_needed') return list.filter(c => isHumanNeeded(c));
    if (filter === 'ai_handling') return list.filter(c => c.status === 'ai_handling' || (!isHumanNeeded(c) && c.status === 'open'));
    if (filter === 'escalation_risk') return list.filter(c => c.status === 'escalation_risk');
    if (filter === 'human_control') return list.filter(c => c.status === 'human_control');
    return list.filter(c => c.status === filter);
  }, [conversations, filter, search]);

  // ── Styles ────────────────────────────────────────────────────────────────
  const chipStyle = (active: boolean, special?: boolean): CSSProperties => ({
    fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 20, cursor: 'pointer',
    border: active ? 'none' : special ? '0.5px solid #f59e0b' : '0.5px solid #e8e6e0',
    background: active ? '#1a1a1a' : special ? '#fef3c7' : '#fff',
    color: active ? '#fff' : special ? '#92400e' : '#555',
    whiteSpace: 'nowrap' as const,
  });

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: '#fff' }}>

      {/* Stats bar — Base44 QueuePanel style */}
      <div style={{ padding: '10px 12px', borderBottom: '0.5px solid #e8e6e0', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 12, fontSize: 10.5, color: '#555' }}>
          <span><b style={{ color: '#991b1b' }}>{stats.pending_human}</b> Pending</span>
          <span><b style={{ color: '#92400e' }}>{stats.high_priority}</b> High</span>
          <span><b style={{ color: '#6d28d9' }}>{stats.human_control}</b> Human</span>
          <span><b style={{ color: '#065f46' }}>{stats.ai_handling}</b> AI</span>
        </div>
      </div>

      {/* Search */}
      <div style={{ padding: '8px 12px', borderBottom: '0.5px solid #e8e6e0', flexShrink: 0 }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Search conversations..."
          style={{ width: '100%', fontSize: 11.5, padding: '6px 9px', borderRadius: 8, border: '0.5px solid #e8e6e0', background: '#f5f4f0', outline: 'none', boxSizing: 'border-box' }}
        />
      </div>

      {/* Filter chips — Base44 QueuePanel aligned */}
      <div style={{ padding: '8px 12px', borderBottom: '0.5px solid #e8e6e0', display: 'flex', flexWrap: 'wrap', gap: 4, flexShrink: 0 }}>
        {FILTERS.map(f => (
          <button
            key={f.label}
            onClick={() => setFilter(f.key)}
            style={chipStyle(filter === f.key, f.key === 'unresolved')}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Count */}
      <div style={{ padding: '5px 12px', fontSize: 10, color: '#888', borderBottom: '0.5px solid #e8e6e0', flexShrink: 0 }}>
        Showing {filtered?.length ?? 0} conversation{filtered?.length !== 1 ? 's' : ''}
      </div>

      {/* Error */}
      {error && (
        <div style={{ margin: '8px 12px', padding: '8px 10px', background: '#fee2e2', border: '0.5px solid #fca5a5', borderRadius: 8, fontSize: 11, color: '#991b1b', flexShrink: 0 }}>
          {error}
        </div>
      )}

      {/* Conversation list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered === null && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} style={{ height: 64, borderRadius: 8, background: '#f1f5f9', animation: 'pulse 1.5s infinite' }} />
            ))}
          </div>
        )}
        {filtered && filtered.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', fontSize: 12, color: '#888' }}>No conversations found</div>
        )}
        {filtered?.map(c => {
          const active = c.id === selectedId;
          const humanNeeded = isHumanNeeded(c);
          const slaBreached = c.priority === 'high' && humanNeeded;
          return (
            <Link
              key={c.id}
              to="/console/conversations/$id"
              params={{ id: c.id }}
              onClick={() => setSelectedId(c.id)}
              style={{ textDecoration: 'none', display: 'block' }}
            >
              <div
                style={{
                  padding: '10px 12px',
                  borderBottom: '0.5px solid #e8e6e0',
                  cursor: 'pointer',
                  background: active ? '#1a1a1a' : '#fff',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = '#f5f4f0'; }}
                onMouseLeave={e => { if (!active) (e.currentTarget as HTMLDivElement).style.background = '#fff'; }}
              >
                {/* Row 1: customer id + time */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: active ? '#fff' : '#1a1a1a' }}>
                    #{(c.visitor_session?.id || c.id).slice(0, 8)}
                  </span>
                  <span style={{ fontSize: 10, color: slaBreached ? '#ef4444' : (active ? 'rgba(255,255,255,0.5)' : '#888'), fontWeight: slaBreached ? 600 : 400 }}>
                    {c.updated_at ? relTime(c.updated_at) : '—'}
                    {slaBreached && ' ⚠ SLA'}
                  </span>
                </div>

                {/* Row 2: preview */}
                <div style={{ fontSize: 11, marginBottom: 5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: active ? 'rgba(255,255,255,0.6)' : '#555' }}>
                  {c.latest_preview}
                </div>

                {/* Row 3: badges */}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
                  <StatusBadge status={c.status} />
                  {humanNeeded && c.status !== 'human_needed' && (
                    <span style={{ background: active ? 'rgba(239,68,68,0.3)' : '#fee2e2', color: active ? '#fca5a5' : '#991b1b', fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 20 }}>
                      🔴 Human Needed
                    </span>
                  )}
                  {c.channel_config?.name && (
                    <span style={{ background: active ? 'rgba(255,255,255,0.15)' : '#f0efe9', color: active ? '#fff' : '#555', fontSize: 10, padding: '2px 8px', borderRadius: 20 }}>
                      {c.channel_config.name}
                    </span>
                  )}
                </div>

                {/* Row 4: assigned agent */}
                <div style={{ marginTop: 4, fontSize: 10, color: active ? 'rgba(255,255,255,0.4)' : '#92400e' }}>
                  {c.assigned_agent_name === 'Unassigned' ? '— Unassigned' : `👤 ${c.assigned_agent_name}`}
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
