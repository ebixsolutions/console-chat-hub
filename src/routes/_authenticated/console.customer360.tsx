// src/routes/_authenticated/console.customer360.tsx
// DEMO-ONLY MOCK DATA — NOT CONNECTED TO LIVE BACKEND
// Do not modify production data flow based on this file.

import { useState, type CSSProperties } from 'react';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_authenticated/console/customer360')({
  component: Customer360Page,
});

// ─── Design helpers ──────────────────────────────────────────────────────────
const tierMeta = (t: string) => {
  if (t === 'VIP' || t?.includes('Gold VIP'))
    return { bg: '#f3e8ff', color: '#7c3aed', border: '#7c3aed', avatar: 'linear-gradient(135deg,#7c3aed,#a855f7)' };
  if (t === 'Premium')
    return { bg: '#dbeafe', color: '#2563eb', border: '#2563eb', avatar: 'linear-gradient(135deg,#2563eb,#60a5fa)' };
  return { bg: '#f1f5f9', color: '#475569', border: '#94a3b8', avatar: 'linear-gradient(135deg,#475569,#94a3b8)' };
};

const initials = (name: string) =>
  (name || '?').split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase();

const trustColor = (s: number) => s >= 75 ? '#16a34a' : s >= 50 ? '#d97706' : '#dc2626';
const qColor = (s: number) => s >= 75 ? '#16a34a' : s >= 60 ? '#d97706' : '#dc2626';

const card: CSSProperties = { background: '#fff', borderRadius: 12, padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.06)', marginBottom: 12 };

// ─── ArcGauge (半圓弧) ───────────────────────────────────────────────────────
function ArcGauge({ value, label, color }: { value: number; label: string; color: string }) {
  const pct = Math.min(Math.max(value ?? 0, 0), 100);
  const r = 26, cx = 34, cy = 34;
  const circumference = Math.PI * r;
  const dash = (pct / 100) * circumference;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <svg width="68" height="42" viewBox="0 0 68 42">
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke="#e2e8f0" strokeWidth="6" strokeLinecap="round" />
        <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round" strokeDasharray={`${dash} ${circumference}`} />
        <text x={cx} y={cy - 2} textAnchor="middle" fontSize="11" fontWeight="700" fill="#0f172a">{pct}</text>
      </svg>
      <div style={{ fontSize: 10, color: '#64748b', textAlign: 'center', maxWidth: 72 }}>{label}</div>
    </div>
  );
}

// ─── SummaryBar ──────────────────────────────────────────────────────────────
function SummaryBar({ items }: { items: { label: string; value: string | number; color?: string }[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${items.length}, 1fr)`, gap: 8, marginBottom: 12 }}>
      {items.map((m, i) => (
        <div key={i} style={{ background: '#fff', borderRadius: 10, padding: '10px 14px', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 4 }}>{m.label}</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: m.color || '#0f172a' }}>{m.value}</div>
        </div>
      ))}
    </div>
  );
}

const orderStatusColor = (s: string) => {
  if (!s) return { bg: '#f1f5f9', color: '#64748b' };
  const sl = s.toLowerCase();
  if (sl.includes('return') || sl.includes('refund')) return { bg: '#ffedd5', color: '#c2410c' };
  if (sl === 'delivered') return { bg: '#dcfce7', color: '#16a34a' };
  if (sl === 'processing') return { bg: '#fef3c7', color: '#d97706' };
  if (sl === 'shipped') return { bg: '#dbeafe', color: '#2563eb' };
  return { bg: '#f1f5f9', color: '#64748b' };
};

const CHANNEL_COLORS: Record<string, { bg: string; color: string }> = {
  'WhatsApp': { bg: '#f3e8ff', color: '#7c3aed' },
  'VOC': { bg: '#f1f5f9', color: '#475569' },
  'Email': { bg: '#dbeafe', color: '#2563eb' },
  'Web Chat': { bg: '#dcfce7', color: '#16a34a' },
};
const STATUS_COLORS: Record<string, { bg: string; color: string }> = {
  'In QA Review': { bg: '#fef3c7', color: '#d97706' },
  'Training Ready': { bg: '#dbeafe', color: '#2563eb' },
  'AI resolved': { bg: '#dcfce7', color: '#16a34a' },
  'Escalated': { bg: '#fee2e2', color: '#dc2626' },
};

// ─── Mock Data ───────────────────────────────────────────────────────────────
const CUSTOMERS = [
  {
    id: 'cust-001', customer_name: 'Frankie Chan', tier: 'Gold VIP', language_preference: 'English',
    lifetime_value: 8240, tier_since: '2022-03-10', memory_confidence_score: 92, data_freshness_score: 88,
    churnRisk: false, escalation: true, sensitive_to: 'Waiting time, Policy exceptions',
    coreProfile: { tier: 'Gold VIP (since 2022)', language: 'English', ltv: 'HK$8,240', memoryConfidence: '92%', pastComplaints: 'Colour mismatch 2024-03', preferences: 'Express delivery, Black/White only', sensitiveTo: 'Waiting time, Policy exceptions', memberSince: '2022-03-10' },
    memoryScores: { confidence: 92, freshness: 88, relevance: 76, privacy: 95 },
    trust: { trust_score: 78, trust_level: 'Medium', satisfaction_trend: 'Declining', total_interactions: 6, resolved_without_human: 0, score_change: -4 },
    trustHistory: [{ date: 'Jan 22', score: 55 }, { date: 'Jun 22', score: 60 }, { date: 'Dec 22', score: 65 }, { date: 'Jun 23', score: 72 }, { date: 'Sep 24', score: 84 }, { date: 'Dec 24', score: 82 }, { date: 'May 26', score: 78 }],
    trustEvents: [
      { date: '2026-06-11', type: 'human_takeover', desc: 'Human agent took over due to policy dispute.', from: 82, to: 78, delta: -4, qa: 48, status: 'Training Ready' },
      { date: '2026-05-15', type: 'resolution_success', desc: 'Issue resolved successfully by AI.', from: 79, to: 82, delta: 3, qa: 88, status: 'AI resolved' },
      { date: '2026-03-20', type: 'escalation', desc: 'Escalated due to high churn risk signal.', from: 84, to: 79, delta: -5, qa: 32, status: 'Training Ready' },
    ],
    conversations: [
      { date: '2026-06-04', channel: 'WhatsApp', intent: 'Refund & Returns', qa: 48, urgency: 'High', status: 'Training Ready', id: 'C-8013' },
      { date: '2026-05-15', channel: 'Web Chat', intent: 'Product Inquiry', qa: 88, urgency: 'Low', status: 'AI resolved', id: 'C-8014' },
      { date: '2026-03-20', channel: 'VOC', intent: 'Complaint', qa: 32, urgency: 'High', status: 'In QA Review', id: 'C-8012' },
    ],
    erpList: [
      { id: 'ORD-4521', date: '2026-05-01', product: 'Luxury Anti-Aging Collection', amount: 320, payment: 'Visa', status: 'Delivered', loyalty: 320 },
      { id: 'ORD-4388', date: '2026-03-15', product: 'VIP Birthday Bundle', amount: 580, payment: 'Visa', status: 'Delivered', loyalty: 580 },
      { id: 'ORD-4201', date: '2026-01-20', product: 'Year-End VIP Luxury Set', amount: -180, payment: 'Visa', status: 'Refunded', loyalty: 0 },
    ],
    products: [
      { name: 'Luxury Anti-Aging Collection', orders: 1, lastDate: '2026-03-22', amount: 512, rating: 4.8 },
      { name: 'VIP Birthday Bundle', orders: 1, lastDate: '2025-11-11', amount: 298, rating: 4.8 },
    ],
    followups: [
      { id: 'fp-1', tag: 'Retain VIP', status: 'Completed', action: 'Send apology + confirm exchange arranged', timing: 'Now' },
      { id: 'fp-2', tag: 'Retain VIP', status: 'Pending', action: 'VIP Retention Callback within 24h', timing: '24 hours' },
      { id: 'fp-3', tag: 'Escalation', status: 'Pending', action: 'Confirm refund processed and send receipt', timing: '7 days' },
    ],
    predictions: [{ type: 'Retention Offer', status: 'Pending', desc: 'VIP Loyalty Recovery: 15% stacked discount + complimentary anniversary gift set + VIP concierge access', churn: '84%', channel: 'WhatsApp', scheduled: '2026-05-22' }],
    emotions: [{ conversation_id: 'C-10089', emotion_start: 'Disappointed', emotion_end: 'Improving', emotion_trajectory: 'Improving', churn_risk: 'Medium', buying_intent_score: 35, emotion_recovery_score: 51 }],
  },
  {
    id: 'cust-002', customer_name: 'Michelle Wong', tier: 'VIP', language_preference: 'English + Cantonese',
    lifetime_value: 5200, tier_since: '2021-07-14', memory_confidence_score: 85, data_freshness_score: 72,
    churnRisk: true, escalation: false, sensitive_to: 'Price fairness',
    coreProfile: { tier: 'VIP', language: 'English + Cantonese', ltv: 'HK$5,200', memoryConfidence: '85%', pastComplaints: 'None', preferences: 'Standard delivery', sensitiveTo: 'Price fairness', memberSince: '2021-07-14' },
    memoryScores: { confidence: 85, freshness: 72, relevance: 80, privacy: 90 },
    trust: { trust_score: 62, trust_level: 'Medium', satisfaction_trend: 'Stable', total_interactions: 4, resolved_without_human: 50, score_change: 2 },
    trustHistory: [{ date: 'Jan 23', score: 55 }, { date: 'May 26', score: 62 }],
    trustEvents: [], conversations: [{ date: '2026-05-20', channel: 'WhatsApp', intent: 'Price Enquiry', qa: 65, urgency: 'Low', status: 'AI resolved', id: 'C-9001' }],
    erpList: [{ id: 'ORD-5001', date: '2026-04-10', product: 'Serum Bundle', amount: 280, payment: 'Visa', status: 'Delivered', loyalty: 280 }],
    products: [{ name: 'Serum Bundle', orders: 1, lastDate: '2026-04-10', amount: 280, rating: 4.5 }],
    followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-003', customer_name: 'Candy Lam', tier: 'VIP', language_preference: 'Cantonese',
    lifetime_value: 4100, tier_since: '2020-11-01', memory_confidence_score: 78, data_freshness_score: 65,
    churnRisk: true, escalation: false, sensitive_to: 'Delivery delays',
    coreProfile: { tier: 'VIP', language: 'Cantonese', ltv: 'HK$4,100', memoryConfidence: '78%', pastComplaints: 'Late delivery 2025-01', preferences: 'Express delivery', sensitiveTo: 'Delivery delays', memberSince: '2020-11-01' },
    memoryScores: { confidence: 78, freshness: 65, relevance: 72, privacy: 88 },
    trust: { trust_score: 70, trust_level: 'Medium', satisfaction_trend: 'Stable', total_interactions: 5, resolved_without_human: 60, score_change: 1 },
    trustHistory: [{ date: 'Jan 23', score: 65 }, { date: 'May 26', score: 70 }],
    trustEvents: [], conversations: [], erpList: [], products: [], followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-004', customer_name: 'Sophia Chen', tier: 'Premium', language_preference: 'English',
    lifetime_value: 3200, tier_since: '2022-05-20', memory_confidence_score: 70, data_freshness_score: 80,
    churnRisk: true, escalation: false, sensitive_to: 'Return policy',
    coreProfile: { tier: 'Premium', language: 'English', ltv: 'HK$3,200', memoryConfidence: '70%', pastComplaints: 'Wrong item 2025-09', preferences: 'Express delivery', sensitiveTo: 'Return policy', memberSince: '2022-05-20' },
    memoryScores: { confidence: 70, freshness: 80, relevance: 65, privacy: 92 },
    trust: { trust_score: 55, trust_level: 'Medium', satisfaction_trend: 'Stable', total_interactions: 3, resolved_without_human: 67, score_change: 0 },
    trustHistory: [{ date: 'Jan 24', score: 52 }, { date: 'May 26', score: 55 }],
    trustEvents: [], conversations: [{ date: '2026-05-10', channel: 'Email', intent: 'Return Request', qa: 58, urgency: 'Low', status: 'AI resolved', id: 'C-9100' }],
    erpList: [{ id: 'ORD-6001', date: '2026-04-20', product: 'Eye Cream Set', amount: 220, payment: 'Visa', status: 'Delivered', loyalty: 220 }],
    products: [{ name: 'Eye Cream Set', orders: 1, lastDate: '2026-04-20', amount: 220, rating: 4.2 }],
    followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-005', customer_name: 'David Park', tier: 'Premium', language_preference: 'English',
    lifetime_value: 2800, tier_since: '2023-02-14', memory_confidence_score: 60, data_freshness_score: 75,
    churnRisk: true, escalation: false, sensitive_to: 'Shipping speed',
    coreProfile: { tier: 'Premium', language: 'English', ltv: 'HK$2,800', memoryConfidence: '60%', pastComplaints: 'Late delivery 2025-11', preferences: 'Next-day delivery', sensitiveTo: 'Shipping speed', memberSince: '2023-02-14' },
    memoryScores: { confidence: 60, freshness: 75, relevance: 58, privacy: 85 },
    trust: { trust_score: 48, trust_level: 'Low', satisfaction_trend: 'Declining', total_interactions: 3, resolved_without_human: 33, score_change: -5 },
    trustHistory: [{ date: 'Jun 24', score: 55 }, { date: 'May 26', score: 48 }],
    trustEvents: [], conversations: [],
    erpList: [{ id: 'ORD-7001', date: '2026-03-05', product: 'Moisturiser Bundle', amount: 180, payment: 'Visa', status: 'Delivered', loyalty: 180 }],
    products: [{ name: 'Moisturiser Bundle', orders: 1, lastDate: '2026-03-05', amount: 180, rating: 3.8 }],
    followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-006', customer_name: 'Grace Yip', tier: 'Premium', language_preference: 'English',
    lifetime_value: 2400, tier_since: '2023-08-01', memory_confidence_score: 55, data_freshness_score: 68,
    churnRisk: true, escalation: false, sensitive_to: null,
    coreProfile: { tier: 'Premium', language: 'English', ltv: 'HK$2,400', memoryConfidence: '55%', pastComplaints: 'None', preferences: 'Standard delivery', sensitiveTo: null, memberSince: '2023-08-01' },
    memoryScores: { confidence: 55, freshness: 68, relevance: 62, privacy: 90 },
    trust: { trust_score: 66, trust_level: 'Medium', satisfaction_trend: 'Stable', total_interactions: 2, resolved_without_human: 100, score_change: 2 },
    trustHistory: [{ date: 'Jan 24', score: 64 }, { date: 'May 26', score: 66 }],
    trustEvents: [], conversations: [], erpList: [], products: [], followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-007', customer_name: 'James Ng', tier: 'Premium', language_preference: 'English',
    lifetime_value: 1900, tier_since: '2024-01-10', memory_confidence_score: 50, data_freshness_score: 90,
    churnRisk: true, escalation: false, sensitive_to: null,
    coreProfile: { tier: 'Premium', language: 'English', ltv: 'HK$1,900', memoryConfidence: '50%', pastComplaints: 'None', preferences: 'Weekend delivery', sensitiveTo: null, memberSince: '2024-01-10' },
    memoryScores: { confidence: 50, freshness: 90, relevance: 48, privacy: 95 },
    trust: { trust_score: 72, trust_level: 'Medium', satisfaction_trend: 'Improving', total_interactions: 2, resolved_without_human: 100, score_change: 4 },
    trustHistory: [{ date: 'Jun 24', score: 68 }, { date: 'May 26', score: 72 }],
    trustEvents: [], conversations: [], erpList: [], products: [], followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-008', customer_name: 'David Lee', tier: 'Standard', language_preference: 'English',
    lifetime_value: 850, tier_since: '2024-06-15', memory_confidence_score: 40, data_freshness_score: 95,
    churnRisk: true, escalation: false, sensitive_to: 'Pricing',
    coreProfile: { tier: 'Standard', language: 'English', ltv: 'HK$850', memoryConfidence: '40%', pastComplaints: 'None', preferences: 'Standard delivery', sensitiveTo: 'Pricing', memberSince: '2024-06-15' },
    memoryScores: { confidence: 40, freshness: 95, relevance: 35, privacy: 88 },
    trust: { trust_score: 45, trust_level: 'Low', satisfaction_trend: 'Stable', total_interactions: 2, resolved_without_human: 50, score_change: 0 },
    trustHistory: [{ date: 'Sep 24', score: 45 }, { date: 'May 26', score: 45 }],
    trustEvents: [], conversations: [], erpList: [], products: [], followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-009', customer_name: 'Brian Leung', tier: 'VIP', language_preference: 'English',
    lifetime_value: 6800, tier_since: '2020-03-22', memory_confidence_score: 95, data_freshness_score: 82,
    churnRisk: false, escalation: false, sensitive_to: null,
    coreProfile: { tier: 'VIP', language: 'English', ltv: 'HK$6,800', memoryConfidence: '95%', pastComplaints: 'None', preferences: 'Express delivery', sensitiveTo: null, memberSince: '2020-03-22' },
    memoryScores: { confidence: 95, freshness: 82, relevance: 90, privacy: 98 },
    trust: { trust_score: 88, trust_level: 'High', satisfaction_trend: 'Stable', total_interactions: 10, resolved_without_human: 90, score_change: 2 },
    trustHistory: [{ date: 'Jan 21', score: 72 }, { date: 'Jan 23', score: 82 }, { date: 'May 26', score: 88 }],
    trustEvents: [], conversations: [], erpList: [], products: [], followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-010', customer_name: 'Kelly Tam', tier: 'VIP', language_preference: 'Cantonese',
    lifetime_value: 5500, tier_since: '2021-11-05', memory_confidence_score: 88, data_freshness_score: 78,
    churnRisk: false, escalation: false, sensitive_to: null,
    coreProfile: { tier: 'VIP', language: 'Cantonese', ltv: 'HK$5,500', memoryConfidence: '88%', pastComplaints: 'None', preferences: 'Weekend delivery preferred', sensitiveTo: null, memberSince: '2021-11-05' },
    memoryScores: { confidence: 88, freshness: 78, relevance: 85, privacy: 96 },
    trust: { trust_score: 80, trust_level: 'High', satisfaction_trend: 'Stable', total_interactions: 8, resolved_without_human: 88, score_change: 1 },
    trustHistory: [{ date: 'Jan 22', score: 74 }, { date: 'May 26', score: 80 }],
    trustEvents: [], conversations: [], erpList: [], products: [], followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-011', customer_name: 'Jenny Yu', tier: 'VIP', language_preference: 'English',
    lifetime_value: 4800, tier_since: '2022-09-18', memory_confidence_score: 82, data_freshness_score: 70,
    churnRisk: false, escalation: false, sensitive_to: null,
    coreProfile: { tier: 'VIP', language: 'English', ltv: 'HK$4,800', memoryConfidence: '82%', pastComplaints: 'None', preferences: 'Morning delivery', sensitiveTo: null, memberSince: '2022-09-18' },
    memoryScores: { confidence: 82, freshness: 70, relevance: 78, privacy: 94 },
    trust: { trust_score: 76, trust_level: 'High', satisfaction_trend: 'Stable', total_interactions: 6, resolved_without_human: 83, score_change: 1 },
    trustHistory: [{ date: 'Jan 23', score: 72 }, { date: 'May 26', score: 76 }],
    trustEvents: [], conversations: [], erpList: [], products: [], followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-012', customer_name: 'Emily Ng', tier: 'VIP', language_preference: 'English + Cantonese',
    lifetime_value: 4200, tier_since: '2023-04-07', memory_confidence_score: 75, data_freshness_score: 85,
    churnRisk: false, escalation: false, sensitive_to: null,
    coreProfile: { tier: 'VIP', language: 'English + Cantonese', ltv: 'HK$4,200', memoryConfidence: '75%', pastComplaints: 'None', preferences: 'Flexible delivery', sensitiveTo: null, memberSince: '2023-04-07' },
    memoryScores: { confidence: 75, freshness: 85, relevance: 70, privacy: 92 },
    trust: { trust_score: 73, trust_level: 'Medium', satisfaction_trend: 'Improving', total_interactions: 5, resolved_without_human: 80, score_change: 3 },
    trustHistory: [{ date: 'Jun 23', score: 65 }, { date: 'May 26', score: 73 }],
    trustEvents: [], conversations: [], erpList: [], products: [], followups: [], predictions: [], emotions: [],
  },
  {
    id: 'cust-013', customer_name: 'Nancy Cheung', tier: 'Premium', language_preference: 'English',
    lifetime_value: 2100, tier_since: '2024-02-28', memory_confidence_score: 58, data_freshness_score: 88,
    churnRisk: false, escalation: false, sensitive_to: null,
    coreProfile: { tier: 'Premium', language: 'English', ltv: 'HK$2,100', memoryConfidence: '58%', pastComplaints: 'None', preferences: 'Standard delivery', sensitiveTo: null, memberSince: '2024-02-28' },
    memoryScores: { confidence: 58, freshness: 88, relevance: 55, privacy: 90 },
    trust: { trust_score: 60, trust_level: 'Medium', satisfaction_trend: 'Stable', total_interactions: 2, resolved_without_human: 100, score_change: 0 },
    trustHistory: [{ date: 'Mar 24', score: 58 }, { date: 'May 26', score: 60 }],
    trustEvents: [], conversations: [], erpList: [], products: [], followups: [], predictions: [], emotions: [],
  },
];

const TABS = ['profile', 'conversations', 'orders', 'products', 'payments', 'emotion', 'trust', 'followup', 'predictions'];
const TAB_LABELS: Record<string, string> = {
  profile: 'Profile', conversations: 'Conversations', orders: 'Orders',
  products: 'Products Bought', payments: 'Payments', emotion: 'Emotion Journey',
  trust: 'Trust Score', followup: 'Follow-up Plan', predictions: 'Predictions',
};

type Customer = typeof CUSTOMERS[0];

// ─── Tab Components ──────────────────────────────────────────────────────────
function ProfileTab({ cust }: { cust: Customer }) {
  const cp = cust.coreProfile;
  const ms = cust.memoryScores;
  const rows: [string, string | null][] = [
    ['Tier', cp.tier], ['Language', cp.language], ['Lifetime Value', cp.ltv],
    ['Memory Confidence', cp.memoryConfidence], ['Past Complaints', cp.pastComplaints],
    ['Preferences', cp.preferences], ['Sensitive To', cp.sensitiveTo], ['Member Since', cp.memberSince],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '55% 45%', gap: 16 }}>
      <div style={card}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#94a3b8', marginBottom: 8 }}>Core Profile</div>
        {rows.map(([label, val]) => val && (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #f1f5f9' }}>
            <span style={{ fontSize: 12, color: '#64748b', flexShrink: 0, marginRight: 12 }}>{label}</span>
            <span style={{ fontSize: 12, color: '#0f172a', fontWeight: 500, textAlign: 'right' }}>{val}</span>
          </div>
        ))}
      </div>
      <div style={card}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#94a3b8', marginBottom: 8 }}>Memory Scores</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, paddingTop: 8 }}>
          <ArcGauge value={ms.confidence} label="Memory Confidence" color="#6366f1" />
          <ArcGauge value={ms.freshness} label="Data Freshness" color="#0ea5e9" />
          <ArcGauge value={ms.relevance} label="Business Relevance" color="#10b981" />
          <ArcGauge value={ms.privacy} label="Privacy Compliance" color="#f59e0b" />
        </div>
        <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 12 }}>Last updated: {new Date().toLocaleDateString()}</div>
      </div>
    </div>
  );
}

function ConversationsTab({ cust }: { cust: Customer }) {
  const convs = cust.conversations || [];
  const total = convs.length;
  const avgQA = total ? Math.round(convs.reduce((s, c) => s + c.qa, 0) / total) : 0;
  const escalations = convs.filter(c => c.urgency === 'High').length;
  const humanCorrected = convs.filter(c => c.status === 'Training Ready').length;
  return (
    <div>
      <SummaryBar items={[{ label: 'Total', value: total }, { label: 'Avg QA Score', value: avgQA, color: qColor(avgQA) }, { label: 'Escalations', value: escalations }, { label: 'Human Corrected', value: humanCorrected }]} />
      {convs.length === 0 ? <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>📭 No conversations found.</div> : (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: '#f1f5f9' }}>{['Date', 'Channel', 'Intent', 'QA Score', 'Urgency', 'Status', 'ID'].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, color: '#64748b', whiteSpace: 'nowrap' as const }}>{h}</th>)}</tr></thead>
            <tbody>{convs.map((c, i) => {
              const ch = CHANNEL_COLORS[c.channel] || { bg: '#f1f5f9', color: '#64748b' };
              const st = STATUS_COLORS[c.status] || { bg: '#f1f5f9', color: '#475569' };
              return (<tr key={c.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                <td style={{ padding: '10px 12px', fontSize: 12, color: '#475569' }}>{c.date}</td>
                <td style={{ padding: '10px 12px' }}><span style={{ background: ch.bg, color: ch.color, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>{c.channel}</span></td>
                <td style={{ padding: '10px 12px', fontSize: 12, color: '#0f172a' }}>{c.intent}</td>
                <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 700, color: qColor(c.qa) }}>{c.qa}</td>
                <td style={{ padding: '10px 12px' }}><span style={{ background: c.urgency === 'High' ? '#fee2e2' : '#f1f5f9', color: c.urgency === 'High' ? '#dc2626' : '#64748b', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>{c.urgency}</span></td>
                <td style={{ padding: '10px 12px' }}><span style={{ background: st.bg, color: st.color, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>{c.status}</span></td>
                <td style={{ padding: '10px 12px', fontSize: 11, color: '#2563eb', fontWeight: 600 }}>{c.id}</td>
              </tr>);
            })}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OrdersTab({ cust }: { cust: Customer }) {
  const orders = cust.erpList || [];
  const totalSpent = orders.filter(o => o.amount > 0).reduce((s, o) => s + o.amount, 0);
  const totalRefunded = orders.filter(o => o.amount < 0).reduce((s, o) => s + Math.abs(o.amount), 0);
  const loyaltyPts = orders.reduce((s, o) => s + (o.loyalty || 0), 0);
  return (
    <div>
      <SummaryBar items={[{ label: 'Orders', value: orders.length }, { label: 'Total Spent', value: `$${totalSpent.toLocaleString()}`, color: '#16a34a' }, { label: 'Total Refunded', value: `$${totalRefunded}`, color: '#dc2626' }, { label: 'Loyalty Points', value: `🏆 ${loyaltyPts}`, color: '#d97706' }]} />
      {orders.length === 0 ? <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>📭 No orders found.</div> : (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: '#f1f5f9' }}>{['Order ID', 'Date', 'Product', 'Amount', 'Payment', 'Status', 'Loyalty'].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, color: '#64748b', whiteSpace: 'nowrap' as const }}>{h}</th>)}</tr></thead>
            <tbody>{orders.map((o, i) => {
              const sc = orderStatusColor(o.status);
              return (<tr key={o.id} style={{ background: i % 2 === 0 ? '#fff' : '#fafafa' }}>
                <td style={{ padding: '10px 12px', fontSize: 12, color: '#2563eb', fontWeight: 600 }}>{o.id}</td>
                <td style={{ padding: '10px 12px', fontSize: 12, color: '#475569' }}>{o.date}</td>
                <td style={{ padding: '10px 12px', fontSize: 12, color: '#0f172a' }}>{o.product}</td>
                <td style={{ padding: '10px 12px', fontSize: 12, fontWeight: 700, color: o.amount > 0 ? '#16a34a' : '#dc2626' }}>{o.amount > 0 ? `$${o.amount}` : `−$${Math.abs(o.amount)}`}</td>
                <td style={{ padding: '10px 12px', fontSize: 12, color: '#94a3b8' }}>{o.payment}</td>
                <td style={{ padding: '10px 12px' }}><span style={{ background: sc.bg, color: sc.color, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>{o.status}</span></td>
                <td style={{ padding: '10px 12px', fontSize: 11, color: '#d97706' }}>{o.loyalty > 0 ? `↑${o.loyalty}pts` : '—'}</td>
              </tr>);
            })}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProductsTab({ cust }: { cust: Customer }) {
  const products = cust.products || [];
  const totalSpent = products.reduce((s, p) => s + p.amount, 0);
  const avgSat = products.length ? (products.reduce((s, p) => s + p.rating, 0) / products.length).toFixed(1) : '—';
  return (
    <div>
      <SummaryBar items={[{ label: 'Products', value: products.length }, { label: 'Total Spent', value: `$${totalSpent.toLocaleString()}`, color: '#16a34a' }, { label: 'Avg Satisfaction', value: `${avgSat} / 5.0 ★`, color: '#d97706' }]} />
      {products.length === 0 ? <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>📭 No products found.</div>
        : products.map((p, i) => (
          <div key={i} style={{ ...card, display: 'flex', alignItems: 'center', padding: '14px 16px', marginBottom: 8 }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 14, fontWeight: 500, color: '#0f172a' }}>{p.name}</div></div>
            <div style={{ fontSize: 12, color: '#64748b', marginRight: 24 }}>× {p.orders} orders · Last: {p.lastDate} · ${p.amount}</div>
            <div style={{ textAlign: 'right', minWidth: 130 }}>
              <div style={{ fontSize: 12, color: '#16a34a', fontWeight: 600 }}>{'★'.repeat(Math.round(p.rating))}{'☆'.repeat(5 - Math.round(p.rating))} {p.rating} / 5.0</div>
              <div style={{ background: '#dcfce7', color: '#16a34a', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, marginTop: 4, display: 'inline-block' }}>Highly Satisfied</div>
            </div>
          </div>
        ))}
    </div>
  );
}

function PaymentsTab({ cust }: { cust: Customer }) {
  const orders = cust.erpList || [];
  const ltv = cust.lifetime_value;
  const totalPaid = orders.filter(o => o.amount > 0).reduce((s, o) => s + o.amount, 0);
  const totalRefunded = orders.filter(o => o.amount < 0).reduce((s, o) => s + Math.abs(o.amount), 0);
  return (
    <div>
      <div style={{ background: '#0f172a', borderRadius: 12, padding: '20px', textAlign: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#94a3b8', letterSpacing: '0.1em', textTransform: 'uppercase' as const, marginBottom: 8 }}>Lifetime Value</div>
        <div style={{ fontSize: 36, fontWeight: 800, color: '#4ade80' }}>${ltv.toLocaleString()}</div>
        <div style={{ fontSize: 14, color: '#4ade80', marginTop: 4 }}>Net Spend: ${(ltv - totalRefunded).toLocaleString()}</div>
        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>{orders.length} orders · ${totalPaid.toLocaleString()} total paid</div>
      </div>
      {orders.length === 0 ? <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>📭 No transactions found.</div> : (
        <div style={{ ...card, padding: 0, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: '#f1f5f9' }}>{['Transaction ID', 'Payment Method', 'Date', 'Amount', 'Status'].map(h => <th key={h} style={{ padding: '9px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, color: '#64748b' }}>{h}</th>)}</tr></thead>
            <tbody>{orders.map((tx, i) => {
              const sc = orderStatusColor(tx.status);
              return (<tr key={tx.id} style={{ background: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                <td style={{ padding: '10px 12px' }}><div style={{ fontSize: 12, color: '#2563eb', fontWeight: 600 }}>{tx.id}</div></td>
                <td style={{ padding: '10px 12px', fontSize: 12, color: '#94a3b8' }}>{tx.payment}</td>
                <td style={{ padding: '10px 12px', fontSize: 12, color: '#475569' }}>{tx.date}</td>
                <td style={{ padding: '10px 12px', fontSize: 13, fontWeight: 700, color: tx.amount >= 0 ? '#16a34a' : '#dc2626' }}>{tx.amount >= 0 ? `+ $${tx.amount}` : `− $${Math.abs(tx.amount)}`}</td>
                <td style={{ padding: '10px 12px' }}><span style={{ background: sc.bg, color: sc.color, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>{tx.status}</span></td>
              </tr>);
            })}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EmotionJourneyTab({ cust }: { cust: Customer }) {
  const ej = cust.emotions || [];
  const ts = cust.trust;
  const sentimentColor = ts.satisfaction_trend === 'Declining' ? '#dc2626' : ts.satisfaction_trend === 'Improving' ? '#16a34a' : '#d97706';
  const avgRecovery = ej.length ? Math.round(ej.reduce((s, e) => s + (e.emotion_recovery_score || 0), 0) / ej.length) : 0;
  const highChurn = ej.filter(e => e.churn_risk === 'High').length;
  const avgIntent = ej.length ? Math.round(ej.reduce((s, e) => s + (e.buying_intent_score || 0), 0) / ej.length) : 0;
  const stageColor: Record<string, string> = { 'Disappointed': '#dc2626', 'Neutral': '#94a3b8', 'Improving': '#16a34a', 'Happy': '#16a34a', 'Frustrated': '#d97706' };
  return (
    <div>
      <SummaryBar items={[{ label: 'Avg Recovery Score', value: `${avgRecovery}%`, color: '#16a34a' }, { label: '% High Churn Risk', value: `${ej.length ? Math.round(highChurn / ej.length * 100) : 0}%` }, { label: 'Avg Buying Intent', value: avgIntent }, { label: 'Satisfaction Trend', value: ts.satisfaction_trend, color: sentimentColor }]} />
      {ej.length === 0 ? <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>📭 No emotion journey data found.</div>
        : ej.map((j, i) => (
          <div key={i} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
              <span style={{ fontSize: 11, color: '#94a3b8' }}>{j.conversation_id}</span>
              {[j.emotion_start, j.emotion_end].filter(Boolean).map((s, si, arr) => (
                <span key={si} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: stageColor[s] || '#475569' }}>{s}</span>
                  {si < arr.length - 1 && <span style={{ color: '#cbd5e1' }}>→</span>}
                </span>
              ))}
              <span style={{ fontSize: 11, color: '#64748b' }}>Churn: <b style={{ color: '#d97706' }}>{j.churn_risk}</b></span>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: '#d97706', fontWeight: 600 }}>Recovery: {j.emotion_recovery_score}%</span>
            </div>
          </div>
        ))}
      {cust.coreProfile.pastComplaints && cust.coreProfile.pastComplaints !== 'None' && (
        <div style={{ background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, padding: '12px 16px', display: 'flex', gap: 10, marginTop: 8 }}>
          <span>⚠️</span>
          <div><div style={{ fontSize: 13, fontWeight: 600, color: '#c2410c' }}>Known Complaint</div><div style={{ fontSize: 12, color: '#92400e' }}>{cust.coreProfile.pastComplaints}</div></div>
        </div>
      )}
    </div>
  );
}

function TrustScoreTab({ cust }: { cust: Customer }) {
  const ts = cust.trust;
  const history = cust.trustHistory || [];
  const events = cust.trustEvents || [];
  const score = ts.trust_score ?? 0;
  const scoreColor = trustColor(score);
  const eventTypeStyle: Record<string, { bg: string; color: string; label: string }> = {
    'human_takeover': { bg: '#dbeafe', color: '#2563eb', label: '↗ Human Takeover' },
    'resolution_success': { bg: '#dcfce7', color: '#16a34a', label: '✓ Resolution' },
    'escalation': { bg: '#fee2e2', color: '#dc2626', label: '× Policy Error' },
  };
  const eventBorderColor: Record<string, string> = { 'human_takeover': '#2563eb', 'resolution_success': '#16a34a', 'escalation': '#dc2626' };
  return (
    <div>
      <SummaryBar items={[
        { label: 'Current Trust Score', value: score, color: scoreColor },
        { label: 'Total Interactions', value: ts.total_interactions ?? 0 },
        { label: 'Resolved Without Human', value: `${ts.resolved_without_human ?? 0}%` },
        { label: 'Score Change', value: `${(ts.score_change ?? 0) >= 0 ? '+' : ''}${ts.score_change ?? 0} pts`, color: (ts.score_change ?? 0) >= 0 ? '#16a34a' : '#dc2626' },
      ]} />
      <div style={card}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', marginBottom: 12 }}>Trust Score History</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', height: 80 }}>
          {history.map((h, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{ width: '100%', background: trustColor(h.score), borderRadius: 3, height: `${h.score * 0.7}%`, minHeight: 4 }} />
              <div style={{ fontSize: 9, color: '#94a3b8', whiteSpace: 'nowrap' as const }}>{h.date}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', marginBottom: 8 }}>Trust Score Events <span style={{ background: '#f1f5f9', color: '#64748b', fontSize: 11, padding: '2px 7px', borderRadius: 4 }}>{events.length}</span></div>
      {events.length === 0 ? <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>📭 No trust score events.</div>
        : events.map((ev, i) => {
          const et = eventTypeStyle[ev.type] || { bg: '#f1f5f9', color: '#64748b', label: ev.type };
          return (
            <div key={i} style={{ ...card, borderLeft: `3px solid ${eventBorderColor[ev.type] || '#94a3b8'}`, padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>{ev.date}</div>
                  <div style={{ fontSize: 13, color: '#0f172a', marginBottom: 8 }}>{ev.desc}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                    <span style={{ background: et.bg, color: et.color, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>{et.label}</span>
                    <span style={{ fontSize: 10, color: '#64748b' }}>QA: <b style={{ color: qColor(ev.qa) }}>{ev.qa}</b></span>
                    <span style={{ background: ev.status === 'AI resolved' ? '#dcfce7' : '#dbeafe', color: ev.status === 'AI resolved' ? '#16a34a' : '#2563eb', fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4 }}>{ev.status}</span>
                  </div>
                </div>
                <div style={{ textAlign: 'right', minWidth: 80, marginLeft: 16 }}>
                  <div style={{ fontSize: 12, color: '#64748b' }}><span style={{ fontWeight: 600, color: '#0f172a' }}>{ev.from}</span> → <span style={{ fontWeight: 700, color: ev.delta < 0 ? '#dc2626' : '#16a34a' }}>{ev.to}</span></div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: ev.delta < 0 ? '#dc2626' : '#16a34a' }}>{ev.delta >= 0 ? '+' : ''}{ev.delta}</div>
                </div>
              </div>
            </div>
          );
        })}
    </div>
  );
}

function FollowUpPlanTab({ cust }: { cust: Customer }) {
  const [filter, setFilter] = useState('All');
  const [plans, setPlans] = useState(cust.followups || []);
  const pending = plans.filter(p => p.status === 'Pending').length;
  const filtered = filter === 'All' ? plans : plans.filter(p => p.status === filter);
  const markDone = (id: string) => setPlans(prev => prev.map(p => p.id === id ? { ...p, status: 'Completed' } : p));
  const tagStyle: Record<string, { bg: string; color: string }> = { 'Retain VIP': { bg: '#dbeafe', color: '#2563eb' }, 'Escalation': { bg: '#fee2e2', color: '#dc2626' } };
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>Follow-up Plan</span>
          <span style={{ background: '#fef3c7', color: '#d97706', fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 999 }}>{pending} pending</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {['All', 'Pending', 'Completed'].map(f => <button key={f} onClick={() => setFilter(f)} style={{ fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', background: filter === f ? '#0f172a' : '#f1f5f9', color: filter === f ? '#fff' : '#64748b' }}>{f}</button>)}
        </div>
      </div>
      {filtered.length === 0 ? <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>📭 No follow-up plans.</div>
        : filtered.map((plan) => {
          const ts = tagStyle[plan.tag] || { bg: '#f1f5f9', color: '#64748b' };
          const statusStyle = plan.status === 'Completed' ? { bg: '#dcfce7', color: '#16a34a' } : { bg: '#fef3c7', color: '#d97706' };
          return (
            <div key={plan.id} style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ background: ts.bg, color: ts.color, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>{plan.tag}</span>
                <span style={{ background: statusStyle.bg, color: statusStyle.color, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>{plan.status}</span>
              </div>
              <div style={{ fontSize: 13, color: plan.status === 'Completed' ? '#94a3b8' : '#0f172a', marginBottom: 6, textDecoration: plan.status === 'Completed' ? 'line-through' : 'none' }}>{plan.action}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#64748b' }}>⏱ {plan.timing}</span>
                {plan.status === 'Pending' && <button onClick={() => markDone(plan.id)} style={{ fontSize: 12, fontWeight: 500, padding: '4px 12px', borderRadius: 6, border: '1px solid #e8e6e0', background: '#fff', color: '#0f172a', cursor: 'pointer' }}>Mark done</button>}
              </div>
            </div>
          );
        })}
    </div>
  );
}

function PredictionsTab({ cust }: { cust: Customer }) {
  const preds = cust.predictions || [];
  return (
    <div>
      {preds.length === 0 ? <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>📭 No predictions available.</div>
        : preds.map((p, i) => (
          <div key={i} style={card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{p.type}</span>
              <span style={{ background: '#fef3c7', color: '#d97706', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4 }}>{p.status}</span>
            </div>
            <div style={{ fontSize: 13, color: '#475569', marginBottom: 10 }}>{p.desc}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
              <span style={{ background: '#fee2e2', color: '#dc2626', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>Churn: {p.churn}</span>
              <span style={{ background: '#f3e8ff', color: '#7c3aed', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4 }}>{p.channel}</span>
              <span style={{ fontSize: 11, color: '#64748b' }}>📅 {p.scheduled}</span>
            </div>
          </div>
        ))}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────
function Customer360Page() {
  const [selectedId, setSelectedId] = useState('cust-001');
  const [activeTab, setActiveTab] = useState('profile');
  const [search, setSearch] = useState('');
  const [filterTier, setFilterTier] = useState('all');
  const [filterTrust, setFilterTrust] = useState('all');
  const [filterLTV, setFilterLTV] = useState('all');
  const [bannerVisible, setBannerVisible] = useState(true);

  const sorted = [...CUSTOMERS].sort((a, b) => {
    if (a.escalation !== b.escalation) return a.escalation ? -1 : 1;
    if (a.churnRisk !== b.churnRisk) return a.churnRisk ? -1 : 1;
    return (b.lifetime_value || 0) - (a.lifetime_value || 0);
  });

  const filtered = sorted.filter(c => {
    if (search && !c.customer_name.toLowerCase().includes(search.toLowerCase())) return false;
    if (filterTier !== 'all' && c.tier !== filterTier) return false;
    if (filterTrust !== 'all') {
      const s = c.trust?.trust_score ?? 0;
      if (filterTrust === 'high' && s < 75) return false;
      if (filterTrust === 'medium' && (s < 50 || s >= 75)) return false;
      if (filterTrust === 'low' && s >= 50) return false;
    }
    if (filterLTV !== 'all') {
      const ltv = c.lifetime_value || 0;
      if (filterLTV === 'critical' && ltv <= 5000) return false;
      if (filterLTV === 'high' && (ltv <= 2000 || ltv > 5000)) return false;
      if (filterLTV === 'medium' && (ltv <= 500 || ltv > 2000)) return false;
      if (filterLTV === 'low' && ltv > 500) return false;
    }
    return true;
  });

  const selected = CUSTOMERS.find(c => c.id === selectedId) || CUSTOMERS[0];
  const tm = tierMeta(selected.tier);
  const ts = selected.trust;
  const anyFilter = filterTier !== 'all' || filterTrust !== 'all' || filterLTV !== 'all';

  const chipStyle = (active: boolean): CSSProperties => ({
    fontSize: 9, padding: '2px 7px', borderRadius: 999, border: 'none',
    cursor: 'pointer', fontWeight: 600,
    background: active ? '#0f172a' : '#f1f5f9',
    color: active ? '#fff' : '#64748b',
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: '#f8fafc' }}>

      {/* Info Banner */}
      {bannerVisible && (
        <div style={{ background: '#fffbeb', borderBottom: '1px solid #fde68a', padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 14 }}>💡</span>
          <span style={{ fontSize: 12, color: '#92400e', flex: 1 }}>A complete profile of each customer — purchase history, emotion journey, AI trust score, and follow-up actions. Use this to understand context before reviewing a conversation or making a manual intervention.</span>
          <button onClick={() => setBannerVisible(false)} style={{ fontSize: 11, fontWeight: 600, color: '#92400e', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}>Got it ✓</button>
        </div>
      )}

      {/* Two-column layout */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* LEFT: Customer List */}
        <div style={{ flex: '0 0 30%', width: '30%', borderRight: '1px solid #e5e7eb', background: '#fff', display: 'flex', flexDirection: 'column', padding: 12, overflowY: 'auto' }}>
          <div style={{ position: 'relative', marginBottom: 12 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8', fontSize: 12 }}>🔍</span>
            <input placeholder="Search customers..." value={search} onChange={e => setSearch(e.target.value)}
              style={{ width: '100%', padding: '8px 10px 8px 30px', border: '1px solid #e5e7eb', borderRadius: 999, fontSize: 12, background: '#f8fafc', outline: 'none', boxSizing: 'border-box' as const, color: '#0f172a' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #e5e7eb' }}>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' as const }}>
              {[['all', 'All Tiers'], ['VIP', 'VIP'], ['Premium', 'Premium'], ['Standard', 'Standard']].map(([k, l]) => (
                <button key={k} onClick={() => setFilterTier(k)} style={chipStyle(filterTier === k)}>{l}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' as const }}>
              {[['all', 'All Trust'], ['high', 'High ≥75'], ['medium', 'Med 50–74'], ['low', 'Low <50']].map(([k, l]) => (
                <button key={k} onClick={() => setFilterTrust(k)} style={chipStyle(filterTrust === k)}>{l}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' as const }}>
              {[['all', 'All LTV'], ['critical', 'Critical >5k'], ['high', 'High >2k'], ['medium', 'Med'], ['low', 'Low']].map(([k, l]) => (
                <button key={k} onClick={() => setFilterLTV(k)} style={chipStyle(filterLTV === k)}>{l}</button>
              ))}
            </div>
            {anyFilter && <button onClick={() => { setFilterTier('all'); setFilterTrust('all'); setFilterLTV('all'); }} style={{ fontSize: 9, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, fontWeight: 600 }}>× Clear all filters</button>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {filtered.length === 0 ? <div style={{ textAlign: 'center', color: '#94a3b8', fontSize: 12, padding: 20 }}>No customers found</div>
              : filtered.map(c => {
                const isActive = c.id === selectedId;
                const ctm = tierMeta(c.tier);
                const leftBorderColor = c.escalation ? '#dc2626' : c.churnRisk ? '#f59e0b' : 'transparent';
                return (
                  <button key={c.id} onClick={() => { setSelectedId(c.id); setActiveTab('profile'); }}
                    style={{ width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 10, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 9, background: isActive ? '#0f172a' : '#fff', borderLeft: `3px solid ${leftBorderColor}`, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: ctm.avatar, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      <span style={{ color: '#fff', fontSize: 11, fontWeight: 700 }}>{initials(c.customer_name)}</span>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: isActive ? '#fff' : '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.customer_name}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2, flexWrap: 'wrap' as const }}>
                        {c.tier && <span style={{ fontSize: 8, padding: '1px 6px', borderRadius: 999, fontWeight: 700, background: isActive ? '#1e293b' : ctm.bg, color: ctm.color }}>{c.tier}</span>}
                        {c.churnRisk && !isActive && <span style={{ fontSize: 8, color: '#d97706', fontWeight: 700 }}>⚠ Risk</span>}
                        {c.escalation && !isActive && <span style={{ fontSize: 8, color: '#dc2626', fontWeight: 700 }}>🚨 Critical</span>}
                        <span style={{ fontSize: 10, color: '#94a3b8' }}>{c.language_preference}</span>
                      </div>
                    </div>
                  </button>
                );
              })}
          </div>
        </div>

        {/* RIGHT: Detail */}
        <div style={{ flex: '0 0 70%', width: '70%', background: '#f8fafc', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Customer Header */}
          <div style={{ background: '#fff', borderBottom: '1px solid #e5e7eb', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: tm.avatar, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 14, flexShrink: 0 }}>
              {initials(selected.customer_name)}
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{selected.customer_name}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ background: tm.bg, color: tm.color, borderRadius: 4, padding: '1px 8px', fontSize: 11, fontWeight: 600 }}>{selected.tier}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>{selected.language_preference}</span>
              </div>
            </div>
            <div style={{ width: 1, height: 32, background: '#e5e7eb', flexShrink: 0 }} />
            <div style={{ display: 'flex', alignItems: 'center' }}>
              {[
                ['LTV', `$${Number(selected.lifetime_value).toLocaleString()}`, '#16a34a'],
                ['SINCE', selected.tier_since, '#0f172a'],
                ['ORDERS', String(selected.erpList.length), '#0f172a'],
                ['TRUST', String(ts.trust_score), trustColor(ts.trust_score)],
                ['MEMORY', String(selected.memory_confidence_score), '#0f172a'],
                ['FRESHNESS', String(selected.data_freshness_score), '#0f172a'],
              ].map(([label, val, color], i, arr) => (
                <div key={label} style={{ padding: '0 14px', borderRight: i < arr.length - 1 ? '1px solid #e5e7eb' : 'none' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: '#94a3b8' }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color }}>{val}</div>
                </div>
              ))}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              {ts.trust_level === 'Low' && <span style={{ background: '#fee2e2', color: '#dc2626', padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>⚠ High Churn</span>}
              {ts.trust_level === 'Medium' && <span style={{ background: '#fef3c7', color: '#92400e', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>~ Monitor</span>}
              {ts.trust_level === 'High' && <span style={{ background: '#dcfce7', color: '#16a34a', padding: '3px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600 }}>✓ Healthy</span>}
              {selected.sensitive_to && <span style={{ background: '#fffbeb', color: '#92400e', padding: '3px 8px', borderRadius: 4, fontSize: 11 }}>⚡ {selected.sensitive_to.length > 20 ? selected.sensitive_to.slice(0, 20) + '…' : selected.sensitive_to}</span>}
            </div>
          </div>

          {/* Tab Bar — Base44 灰底 pill 容器 */}
          <div style={{ padding: '12px 20px 0', flexShrink: 0 }}>
            <div style={{ background: '#e2e8f0', borderRadius: 10, padding: 4, display: 'flex', gap: 2, overflowX: 'auto' as const, scrollbarWidth: 'none' as const }}>
              {TABS.map(t => (
                <button key={t} onClick={() => setActiveTab(t)} style={{
                  padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                  whiteSpace: 'nowrap' as const, fontSize: 12,
                  fontWeight: activeTab === t ? 600 : 400,
                  color: activeTab === t ? '#0f172a' : '#64748b',
                  background: activeTab === t ? '#fff' : 'transparent',
                  boxShadow: activeTab === t ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                  flexShrink: 0,
                }}>{TAB_LABELS[t]}</button>
              ))}
            </div>
          </div>

          {/* Tab Content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
            {activeTab === 'profile' && <ProfileTab cust={selected} />}
            {activeTab === 'conversations' && <ConversationsTab cust={selected} />}
            {activeTab === 'orders' && <OrdersTab cust={selected} />}
            {activeTab === 'products' && <ProductsTab cust={selected} />}
            {activeTab === 'payments' && <PaymentsTab cust={selected} />}
            {activeTab === 'emotion' && <EmotionJourneyTab cust={selected} />}
            {activeTab === 'trust' && <TrustScoreTab cust={selected} />}
            {activeTab === 'followup' && <FollowUpPlanTab key={selectedId} cust={selected} />}
            {activeTab === 'predictions' && <PredictionsTab cust={selected} />}
          </div>
        </div>
      </div>

      <div style={{ textAlign: 'right', fontSize: 11, color: '#9ca3af', padding: '4px 16px', flexShrink: 0 }}>
        Demo data · {CUSTOMERS.length} customer profiles
      </div>
    </div>
  );
}

