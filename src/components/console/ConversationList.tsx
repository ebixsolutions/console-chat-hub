import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { readInboxConversations } from "@/lib/api/inbox-read";

type ConversationRow = { id: string; status: string; created_at: string | null };
type ReadState = { actor: string; rows: ConversationRow[]; loading: boolean; error: boolean };

/** The normal signed-in client and existing RLS decide which tickets are visible. */
export function ConversationList({ actorId, currentId }: { actorId: string; currentId: string }) {
  const [read, setRead] = useState<ReadState>({ actor: actorId, rows: [], loading: true, error: false });
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const scoped = read.actor === actorId ? read : { rows: [], loading: true, error: false };

  useEffect(() => {
    const request = ++generation.current;
    setRead({ actor: actorId, rows: [], loading: true, error: false });
    setQuery("");
    if (!actorId) {
      setRead({ actor: actorId, rows: [], loading: false, error: true });
      return;
    }
    void readInboxConversations<ConversationRow>((from, to) => supabase.from("conversations")
      .select("id,status,created_at", { count: "exact" })
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(from, to))
      .then(result => {
        if (generation.current !== request) return;
        setRead({ actor: actorId, rows: result.data ?? [], loading: false, error: !!result.error });
      });
    return () => { generation.current++; };
  }, [actorId, attempt]);

  const needle = query.trim().toLowerCase();
  const rows = scoped.rows.filter(row => `${row.id} ${row.status}`.toLowerCase().includes(needle));
  return <nav aria-label="Conversation list" className="space-y-2 text-xs">
    <div className="flex items-center justify-between gap-2">
      <h2 className="font-semibold">Conversations{!scoped.loading && !scoped.error ? ` (${scoped.rows.length})` : ""}</h2>
      <button type="button" disabled={scoped.loading} onClick={() => setAttempt(value => value + 1)}>Refresh list</button>
    </div>
    {scoped.loading ? <p role="status">Loading conversations…</p> : scoped.error ?
      <div role="alert">Conversation list unavailable. <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry list</button></div> : <>
        <input aria-label="Filter conversation list" placeholder="Ticket ID or status" value={query}
          onChange={event => setQuery(event.target.value)} className="w-full rounded border px-2 py-1" />
        {rows.length === 0 ? <p>{scoped.rows.length ? "No matching conversations." : "No conversations available."}</p> :
          <ul className="space-y-1">{rows.map(row => <li key={row.id}>
            <Link to="/console/conversations/$id" params={{ id: row.id }}
              aria-current={row.id === currentId ? "page" : undefined}
              className={`block rounded border px-2 py-2 ${row.id === currentId ? "border-primary bg-muted" : "hover:bg-muted"}`}>
              <span className="block break-all">Ticket #{row.id.slice(0, 8)}</span>
              <span>{row.status}</span>
            </Link>
          </li>)}</ul>}
      </>}
  </nav>;
}
