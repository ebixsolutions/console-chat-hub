import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useEffectiveRole } from '@/hooks/useEffectiveRole';
import { PermissionDenied } from '@/components/console/PageStates';
import {
  aiChatbotSettingsService,
  type ChannelConfig,
} from '@/services/aiChatbotSettingsService';

export const Route = createFileRoute("/_authenticated/console/channel-settings")({
  component: ConsoleChannelSettings,
});

const ICONS: Record<string, string> = {
  website_widget: '💬',
  whatsapp: '📱',
  email: '✉️',
  line: '🟩',
};

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '0.5px solid #e8e6e0',
  borderRadius: 11,
  padding: 14,
};

function MockBadge({ label = 'Mock' }: { label?: string }) {
  return (
    <span
      style={{
        background: '#fef3c7',
        color: '#92400e',
        fontSize: 9.5,
        fontWeight: 700,
        padding: '1px 7px',
        borderRadius: 20,
        border: '0.5px solid #fbbf24',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

function ComingSoonBadge() {
  return (
    <span
      style={{
        background: '#f0efe9',
        color: '#555',
        fontSize: 9.5,
        fontWeight: 700,
        padding: '1px 7px',
        borderRadius: 20,
        whiteSpace: 'nowrap',
      }}
    >
      Coming Soon
    </span>
  );
}


function ConsoleChannelSettings() {
  const roleState = useEffectiveRole();
  const role = (roleState as { role?: string })?.role;

  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [previewChannelId, setPreviewChannelId] = useState<string | null>(null);

  useEffect(() => {
    aiChatbotSettingsService.getChannelConfigs().then(setChannels);
  }, []);

  // P1 Rescue Director-approved predicate: agent/qa/null → restricted.
  if (role === 'agent' || role === 'qa' || !role) {
    return <PermissionDeniedBlock />;
  }

  const previewChannel = channels.find((c) => c.id === previewChannelId);

  return (
    <div style={{ maxWidth: 900 }}>
      <div
        style={{
          background: '#fffbeb',
          border: '0.5px solid #fbbf24',
          borderRadius: 11,
          padding: '12px 14px',
          marginBottom: 14,
          color: '#92400e',
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        <b>ℹ️ PHASE 1 — MOCK MODE</b>
        <br />
        Channel integration is not active. No real messages received.
        <br />
        Phase 2: Website Widget · Phase 3: WhatsApp, LINE, Email
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
          gap: 12,
        }}
      >
        {channels.map((ch) => (
          <div key={ch.id} style={cardStyle}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 18 }}>{ICONS[ch.channel_type]}</span>
              <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>
                {ch.channel_name}
              </span>
              {ch.status === 'mock_preview' ? (
                <MockBadge label="Mock Preview" />
              ) : (
                <ComingSoonBadge />
              )}
            </div>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>
              {ch.phase}
            </div>
            <div
              title={
                !ch.recall_supported
                  ? 'Message Recall not available. Correction Message will be used instead.'
                  : undefined
              }
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '6px 10px',
                borderRadius: 8,
                marginBottom: 8,
                background: ch.recall_supported ? '#d1fae5' : '#f0efe9',
                color: ch.recall_supported ? '#065f46' : '#555',
              }}
            >
              {ch.recall_supported
                ? `✅ Recall Supported (${ch.recall_time_limit_minutes} min)`
                : ch.channel_type === 'email'
                ? '❌ Correction only'
                : '❌ Recall not guaranteed'}
            </div>
            {ch.notes && (
              <div style={{ fontSize: 10.5, color: '#888', marginBottom: 8 }}>
                {ch.notes}
              </div>
            )}
            {ch.channel_type === 'website_widget' && (
              <button
                onClick={() => setPreviewChannelId(ch.id)}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: '5px 12px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#1a1a1a',
                  color: '#fff',
                  cursor: 'pointer',
                  marginTop: 4,
                }}
              >
                Configure (Preview)
              </button>
            )}
          </div>
        ))}
      </div>

      {previewChannel && (
        <div
          onClick={() => setPreviewChannelId(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#fff',
              borderRadius: 12,
              padding: 24,
              maxWidth: 480,
              width: '90%',
              boxShadow: '0 20px 40px rgba(0,0,0,0.2)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700 }}>
                {previewChannel.channel_name} — Preview Only
              </div>
              <MockBadge label="Phase 1 Preview" />
            </div>
            <div
              style={{
                background: '#fffbeb',
                border: '0.5px solid #fbbf24',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 14,
                color: '#92400e',
                fontSize: 11,
                lineHeight: 1.6,
              }}
            >
              This is a Phase 1 mock preview. Widget configuration, embed code,
              AI Agent instructions, and platform guides will be available in
              Phase 2.
            </div>
            <div
              style={{
                fontSize: 12,
                color: '#555',
                lineHeight: 1.7,
                marginBottom: 16,
              }}
            >
              <div style={{ marginBottom: 6 }}>
                <b>Channel:</b> {previewChannel.channel_name}
              </div>
              <div style={{ marginBottom: 6 }}>
                <b>Phase:</b> {previewChannel.phase}
              </div>
              <div style={{ marginBottom: 6 }}>
                <b>Recall:</b>{' '}
                {previewChannel.recall_supported
                  ? `Supported (${previewChannel.recall_time_limit_minutes} min window)`
                  : 'Not available in Phase 1'}
              </div>
              <div>
                <b>Status:</b> Mock Preview — no real messages sent or received
              </div>
            </div>
            <button
              onClick={() => setPreviewChannelId(null)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '7px 18px',
                borderRadius: 8,
                border: 'none',
                background: '#1a1a1a',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
