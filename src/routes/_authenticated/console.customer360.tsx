import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/console/customer360")({
  component: Customer360Page,
});

const CUSTOMERS = [
  {
    id: '1', name: 'Frankie Chan', tier: 'Gold VIP', lang: 'English', ltv: 'HK$8,240',
    member_since: '2022-03-10', trust_score: 78, satisfaction: 'Declining', churn_risk: 'Medium',
    conversations: 6, resolved_by_ai: 4, escalations: 2,
    recent: [
      { date: '2026-06-04', channel: 'WhatsApp', intent: 'Refund & Returns', qa: 48, status: 'Training Ready' },
      { date: '2026-05-15', channel: 'Web Chat', intent: 'Product Inquiry', qa: 88, status: 'AI Resolved' },
      { date: '2026-03-20', channel: 'VOC', intent: 'Complaint', qa: 32, status: 'Escalated' },
    ],
    orders: [
      { id: 'ORD-4521', date: '2026-05-01', product: 'Luxury Anti-Aging Collection', amount: 320, status: 'Delivered' },
      { id: 'ORD-4388', date: '2026-03-15', product: 'VIP Birthday Bundle', amount: 580, status: 'Delivered' },
      { id: 'ORD-4201', date: '2026-01-20', product: 'Year-End VIP Luxury Set', amount: -180, status: 'Refunded' },
    ],
    tags: ['VIP', 'Escalation History', 'Express Delivery', 'Black/White Only'],
  },
  {
    id: '2', name: 'Amy Wu', tier: 'Premium', lang: '中文', ltv: 'HK$3,120',
    member_since: '2023-08-22', trust_score: 91, satisfaction: 'Stable', churn_risk: 'Low',
    conversations: 3, resolved_by_ai: 3, escalations: 0,
    recent: [
      { date: '2026-06-20', channel: 'Web Chat', intent: 'Product Inquiry', qa: 92, status: 'AI Resolved' },
      { date: '2026-04-10', channel: 'Web Chat', intent: 'Warranty Check', qa: 85, status: 'AI Resolved' },
    ],
    orders: [
      { id: 'ORD-5102', date: '2026-06-18', product: 'Smart Home Bundle', amount: 1280, status: 'Shipped' },
      { id: 'ORD-4899', date: '2026-04-02', product: 'Air Purifier X200', amount: 890, status: 'Delivered' },
    ],
    tags: ['Premium', 'Smart Home', 'Repeat Buyer'],
  },
];

const tierStyle = (t: string) => {
  if (t.includes('VIP')) return { bg: '#f3e8ff', color: '#7c3aed', avatar: 'linear-gradient(135deg,#7c3aed,#a855f7)' };
  if (t === 'Premium') return { bg: '#dbeafe', color: '#2563eb', avatar: 'linear-gradient(135deg,#2563eb,#60a5fa)' };
  return { bg: '#f1f5f9', color: '#475569', avatar: 'linear-gradient(135deg,#475569,#94a3b8)' };
};

const qaColor = (s: number) => s >= 75 ? '#16a34a' : s >= 60 ? '#d97706' : '#dc2626';

function Customer360Page() {
  return (
    <div style={{ maxWidth: 1100, padding: 4 }}>
      <div style={{ display: 'grid', gap: 16 }}>
        {CUSTOMERS.map(c => {
          const ts = tierStyle(c.tier);
          return (
            <div key={c.id} style={{ background: '#fff', border: '0.5px solid #e8e6e0', borderRadius: 12, padding: 20 }}>
              {/* Header */}
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14 }}>
                <div style={{ width: 48, height: 48, borderRadius: '50%', background: ts.avatar, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ color: '#fff', fontSize: 16, fontWeight: 700 }}>{c.name.split(' ').map(n => n[0]).join('')}</span>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>{c.name}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: ts.color, background: ts.bg, padding: '2px 10px', borderRadius: 20 }}>{c.tier}</span>
                    {c.churn_risk === 'Medium' && <span style={{ fontSize: 10, fontWeight: 600, color: '#d97706', background: '#fef3c7', padding: '2px 8px', borderRadius: 20 }}>⚠ Churn Risk</span>}
                  </div>
                  <div style={{ fontSize: 11, color: '#888', marginTop: 2 }}>
                    {c.lang} · Member since {c.member_since} · LTV: {c.ltv}
                  </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: c.trust_score >= 80 ? '#16a34a' : '#d97706' }}>{c.trust_score}</div>
                  <div style={{ fontSize: 10, color: '#888' }}>Trust Score</div>
                </div>
              </div>

              {/* Summary */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
                <MiniKpi label="Conversations" value={c.conversations} />
                <MiniKpi label="AI Resolved" value={c.resolved_by_ai} color="#16a34a" />
                <MiniKpi label="Escalations" value={c.escalations} color={c.escalations > 0 ? '#dc2626' : '#16a34a'} />
                <MiniKpi label="Satisfaction" value={c.satisfaction} color={c.satisfaction === 'Declining' ? '#d97706' : '#16a34a'} />
              </div>

              {/* Tags */}
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 14 }}>
                {c.tags.map(t => (
                  <span key={t} style={{ fontSize: 10, background: '#f0efe9', color: '#555', padding: '2px 8px', borderRadius: 20 }}>{t}</span>
                ))}
              </div>

              {/* Recent Conversations */}
              <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94a3b8' }}>Recent Conversations</div>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse', marginBottom: 14 }}>
                <thead>
                  <tr style={{ background: '#f8f8f6' }}>
                    <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#64748b' }}>Date</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#64748b' }}>Channel</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#64748b' }}>Intent</th>
                    <th style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 600, color: '#64748b' }}>QA</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#64748b' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {c.recent.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid #e8e6e0' }}>
                      <td style={{ padding: '6px 10px' }}>{r.date}</td>
                      <td style={{ padding: '6px 10px' }}>{r.channel}</td>
                      <td style={{ padding: '6px 10px' }}>{r.intent}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'center', color: qaColor(r.qa), fontWeight: 700 }}>{r.qa}</td>
                      <td style={{ padding: '6px 10px' }}>{r.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Orders */}
              <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#94a3b8' }}>Order History</div>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#f8f8f6' }}>
                    <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#64748b' }}>Order</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#64748b' }}>Date</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#64748b' }}>Product</th>
                    <th style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600, color: '#64748b' }}>Amount</th>
                    <th style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 600, color: '#64748b' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {c.orders.map((o, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid #e8e6e0' }}>
                      <td style={{ padding: '6px 10px', fontWeight: 600 }}>{o.id}</td>
                      <td style={{ padding: '6px 10px' }}>{o.date}</td>
                      <td style={{ padding: '6px 10px' }}>{o.product}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: o.amount < 0 ? '#dc2626' : '#1a1a1a', fontWeight: 600 }}>${Math.abs(o.amount)}</td>
                      <td style={{ padding: '6px 10px' }}>{o.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 10, color: '#aaa', marginTop: 12, textAlign: 'right' }}>Demo data · 2 customer profiles</div>
    </div>
  );
}

function MiniKpi({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div style={{ background: '#f8f8f6', borderRadius: 8, padding: '8px 12px', textAlign: 'center' }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: color || '#1a1a1a' }}>{value}</div>
      <div style={{ fontSize: 10, color: '#888' }}>{label}</div>
    </div>
  );
}
