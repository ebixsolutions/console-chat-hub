import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/console/analytics")({
  component: AnalyticsPage,
});

const MOCK = {
  kpis: [
    { label: 'AI Resolution Rate', value: '78%', color: '#065f46' },
    { label: 'Human Handoff Rate', value: '14%', color: '#92400e' },
    { label: 'KB Hit Rate', value: '62%', color: '#1d4ed8' },
    { label: 'Avg First Response', value: '1.8s', color: '#1a1a1a' },
  ],
  queue: [
    { name: 'Pending Human', value: 5 },
    { name: 'High Priority', value: 2 },
    { name: 'Human Control', value: 3 },
    { name: 'AI Handling', value: 31 },
  ],
  trend: [
    { date: 'Jun 19', ai: 72, handoff: 18, kb: 55 },
    { date: 'Jun 20', ai: 75, handoff: 16, kb: 58 },
    { date: 'Jun 21', ai: 74, handoff: 15, kb: 60 },
    { date: 'Jun 22', ai: 78, handoff: 14, kb: 62 },
    { date: 'Jun 23', ai: 76, handoff: 15, kb: 61 },
    { date: 'Jun 24', ai: 79, handoff: 13, kb: 64 },
    { date: 'Jun 25', ai: 78, handoff: 14, kb: 62 },
  ],
  suggestions: { used: 142, edited: 23, editRate: '16%' },
  audit: { recalled: 3, csat: 4.2, trainingCandidates: 8 },
};

function AnalyticsPage() {
  const maxQ = Math.max(...MOCK.queue.map(q => q.value));
  return (
    <div style={{ maxWidth: 1100, padding: 4 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 12 }}>
        {MOCK.kpis.map(k => (
          <div key={k.label} style={{ background: '#fff', border: '0.5px solid #e8e6e0', borderRadius: 11, padding: 14 }}>
            <div style={{ fontSize: 10, color: '#888', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4 }}>{k.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div style={{ background: '#fff', border: '0.5px solid #e8e6e0', borderRadius: 11, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 10 }}>7-Day Trend</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
            {MOCK.trend.map(d => (
              <div key={d.date} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'center' }}>
                  <div style={{ width: 8, height: d.ai, background: '#2d7d4f', borderRadius: 2 }} title={`AI: ${d.ai}%`} />
                  <div style={{ width: 8, height: d.kb * 0.6, background: '#3b82f6', borderRadius: 2 }} title={`KB: ${d.kb}%`} />
                </div>
                <div style={{ fontSize: 8, color: '#aaa', whiteSpace: 'nowrap' }}>{d.date.slice(-2)}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10, color: '#888' }}>
            <span>🟢 AI Resolution</span><span>🔵 KB Hit</span>
          </div>
        </div>
        <div style={{ background: '#fff', border: '0.5px solid #e8e6e0', borderRadius: 11, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 10 }}>Queue Distribution</div>
          {MOCK.queue.map(q => (
            <div key={q.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <div style={{ fontSize: 10, color: '#555', width: 100, flexShrink: 0 }}>{q.name}</div>
              <div style={{ flex: 1, height: 18, background: '#f0efe9', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${(q.value / maxQ) * 100}%`, background: '#1a1a1a', borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 4 }}>
                  <span style={{ fontSize: 9, color: '#fff', fontWeight: 700 }}>{q.value}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div style={{ background: '#fff', border: '0.5px solid #e8e6e0', borderRadius: 11, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 10 }}>AI Suggestions</div>
          <div style={{ display: 'flex', gap: 24 }}>
            <StatBlock label="Used" value={MOCK.suggestions.used} />
            <StatBlock label="Edited" value={MOCK.suggestions.edited} />
            <StatBlock label="Edit Rate" value={MOCK.suggestions.editRate} />
          </div>
        </div>
        <div style={{ background: '#fff', border: '0.5px solid #e8e6e0', borderRadius: 11, padding: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 10 }}>Message Recall & Audit</div>
          <div style={{ display: 'flex', gap: 24 }}>
            <StatBlock label="Recalled" value={MOCK.audit.recalled} />
            <StatBlock label="CSAT Avg" value={MOCK.audit.csat} />
            <StatBlock label="Training Candidates" value={MOCK.audit.trainingCandidates} />
          </div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: '#aaa', marginTop: 12, textAlign: 'right' }}>Demo data · Last refreshed: just now</div>
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
      <div style={{ fontSize: 10, color: '#888' }}>{label}</div>
    </div>
  );
}
