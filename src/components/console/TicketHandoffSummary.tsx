import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { projectTicketSummary, type TicketSummary } from "./handoff-summary";
export function TicketSummaryView({ summary }: { summary: TicketSummary }) {
  return (
    <section
      aria-label="真人接手摘要"
      data-testid="ticket-handoff-summary"
      style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8, marginBottom: 10 }}
    >
      <h3>真人接手摘要</h3>
      {summary.map((s) => (
        <div key={s.title}>
          <b>{s.title}</b>
          <ul>
            {s.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
export function TicketHandoffSummary({ conversationId }: { conversationId: string }) {
  const [state, setState] = useState<{
    id: string;
    summary: TicketSummary | null;
    error: boolean;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState(null);
    async function load() {
      const { data: conversation, error: ce } = await supabase
        .from("conversations")
        .select("id,company_id")
        .eq("id", conversationId)
        .maybeSingle();
      if (ce || !conversation?.company_id) {
        if (!cancelled) setState({ id: conversationId, summary: null, error: true });
        return;
      }
      const { data: event, error: he } = await supabase
        .from("handoff_event")
        .select("ai_summary")
        .eq("conversation_id", conversationId)
        .not("ai_summary", "is", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const summary = event
        ? projectTicketSummary(event.ai_summary, conversationId, conversation.company_id)
        : null;
      if (!cancelled)
        setState({ id: conversationId, summary, error: Boolean(he || (event && !summary)) });
    }
    void load();
    const channel = supabase
      .channel(`ticket-summary-${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "handoff_event",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => void load(),
      )
      .subscribe();
    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [conversationId, refresh]);
  if (!state || state.id !== conversationId) return <p>正在讀取交接摘要…</p>;
  if (state.error)
    return (
      <div role="alert">
        交接摘要未能讀取。<button onClick={() => setRefresh((x) => x + 1)}>重新讀取</button>
      </div>
    );
  return state.summary ? <TicketSummaryView summary={state.summary} /> : null;
}
