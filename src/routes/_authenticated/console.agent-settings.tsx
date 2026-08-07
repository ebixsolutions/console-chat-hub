import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/console/agent-settings")({
  component: AgentSettingsPage,
});

const STATUS_COLORS: Record<string, string> = { online: '#2d7d4f', busy: '#f59e0b', offline: '#888', break: '#3b82f6' };

const MOCK_AGENTS = [
  {
    id: '1', display_name: 'Sarah Chen', role: 'supervisor', availability_status: 'online',
    assigned_queue: 'VIP Queue', max_concurrent: 8, languages: ['English', '中文'],
    skills: ['Refund', 'Escalation', 'VIP'],
    can_see_all: true, can_take_over: true, can_assign: true, can_transfer: true,
    can_recall: true, recall_limit: 5,
  },
  {
    id: '2', display_name: 'Jason Lee', role: 'customer_service', availability_status: 'online',
    assigned_queue: 'General Queue', max_concurrent: 5, languages: ['English', '中文', '日本語'],
    skills: ['Product', 'Warranty', 'Shipping'],
    can_see_all: false, can_take_over: false, can_assign: false, can_transfer: true,
    can_recall: true, recall_limit: 3,
  },
  {
    id: '3', display_name: 'Emily Wong', role: 'customer_service', availability_status: 'busy',
    assigned_queue: 'Returns Queue', max_concurrent: 5, languages: ['English', '中文'],
    skills: ['Returns', 'Refund', 'Product'],
    can_see_all: false, can_take_over: false, can_assign: false, can_transfer: true,
    can_recall: true, recall_limit: 3,
  },
  {
    id: '4', display_name: 'David Lam', role: 'qa_reviewer', availability_status: 'offline',
    assigned_queue: 'QA Review', max_concurrent: 10, languages: ['English'],
    skills: ['QA', 'Training', 'Audit'],
    can_see_all: true, can_take_over: false, can_assign: false, can_transfer: false,
    can_recall: false, recall_limit: 0,
  },
];

function AgentSettingsPage() {
  return (
    <div style={{ maxWidth: 900, padding: 4 }}>
      <div style={{ display: 'grid', gap: 12 }}>
        {MOCK_AGENTS.map(a => (
          <div key={a.id} style={{ background: '#fff', border: '0.5px solid #e8e6e0', borderRadius: 11, padding: 14, display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#f0efe9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13 }}>
              {a.display_name.split(' ').map(n => n[0]).join('')}
            </div>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{a.display_name}</span>
                <span style={{ fontSize: 10, fontWeight: 600, color: '#1d4ed8', background: '#dbeafe', padding: '1px 8px', borderRadius: 20 }}>{a.role.replace('_', ' ')}</span>
                <span style={{ fontSize: 10, color: STATUS_COLORS[a.availability_status], fontWeight: 600 }}>● {a.availability_status}</span>
              </div>
              <div style={{ fontSize: 11, color: '#888', marginBottom: 6 }}>
                {a.assigned_queue} · Max {a.max_concurrent} concurrent · Languages: {a.languages.join(', ')}
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {a.skills.map(s => (
                  <span key={s} style={{ fontSize: 10, background: '#f0efe9', color: '#555', padding: '2px 8px', borderRadius: 20 }}>{s}</span>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 10.5, color: '#555', lineHeight: 1.8, minWidth: 180 }}>
              {a.can_see_all ? '✅' : '❌'} See all tickets<br />
              {a.can_take_over ? '✅' : '❌'} Take over · {a.can_assign ? '✅' : '❌'} Assign · {a.can_transfer ? '✅' : '❌'} Transfer<br />
              {a.can_recall ? '✅' : '❌'} Recall own messages ({a.recall_limit} min limit)
            </div>
            <button style={{ fontSize: 11, fontWeight: 600, padding: '5px 13px', borderRadius: 8, border: '0.5px solid #e8e6e0', background: '#fff', cursor: 'pointer' }}>Edit</button>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: '#aaa', marginTop: 12, textAlign: 'right' }}>Demo data · 4 agents configured</div>
    </div>
  );
}
