import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { toast } from 'sonner';
import { useEffectiveRole } from '@/hooks/useEffectiveRole';
import { PermissionDenied } from '@/components/console/PageStates';
import {
  aiChatbotSettingsService,
  type FeedbackAutomationConfig,
  type FeedbackRequest,
} from '@/services/aiChatbotSettingsService';
import {
  FEEDBACK_CHANNELS,
  RATING_TYPES,
  TEMPLATE_TABS,
  DEFAULT_TEMPLATES,
  DEFAULT_SURVEY_QUESTIONS,
  type RatingType,
  type MessageTemplate,
  type SurveyQuestion,
} from '@/mock/aiChatbotSettingsMock';

export const Route = createFileRoute("/_authenticated/console/feedback-settings")({
  component: ConsoleFeedbackAutomation,
});

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '0.5px solid #e8e6e0',
  borderRadius: 11,
  padding: 14,
  marginBottom: 12,
};

const sectionTitleStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: '#888',
  textTransform: 'uppercase',
  marginBottom: 8,
};

const labelUpperStyle = (colour: string): CSSProperties => ({
  fontSize: 10.5,
  fontWeight: 600,
  color: colour,
  marginBottom: 4,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
});

const inputStyle: CSSProperties = {
  width: '100%',
  fontSize: 12,
  padding: '6px 9px',
  border: '0.5px solid #e8e6e0',
  borderRadius: 8,
  boxSizing: 'border-box',
  marginBottom: 10,
};

const textareaStyle: CSSProperties = {
  width: '100%',
  fontSize: 12,
  padding: '6px 9px',
  border: '0.5px solid #e8e6e0',
  borderRadius: 8,
  resize: 'vertical',
  marginBottom: 10,
  boxSizing: 'border-box',
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


function ConsoleFeedbackAutomation() {
  const roleState = useEffectiveRole();
  const role = (roleState as { role?: string })?.role;

  const [config, setConfig] = useState<FeedbackAutomationConfig | null>(null);
  const [requests, setRequests] = useState<FeedbackRequest[]>([]);
  const [source, setSource] = useState<'live' | 'mock_fallback' | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [templateTab, setTemplateTab] = useState<RatingType>('stars_1_5');
  const [templates, setTemplates] = useState<Record<RatingType, MessageTemplate>>(
    DEFAULT_TEMPLATES
  );
  const [surveyQuestions, setSurveyQuestions] = useState<SurveyQuestion[]>(
    DEFAULT_SURVEY_QUESTIONS
  );
  const [previewMode, setPreviewMode] = useState<'email' | 'widget'>('email');

  const reload = () => {
    aiChatbotSettingsService.loadFeedbackAutomationConfig().then((r) => {
      setConfig(r.data);
      setSource(r.source);
      setLoadError(r.error ?? null);
    });
    aiChatbotSettingsService.getFeedbackRequests().then(setRequests);
  };

  useEffect(() => {
    reload();
  }, []);

  // P1 Rescue Director-approved predicate: agent/qa/null → restricted.
  const isRestrictedRole =
    role === 'agent' || role === 'qa' || !role;
  if (isRestrictedRole) {
    return <PermissionDenied message="You do not have permission to manage feedback automation." />;
  }

  if (!config) return <div style={{ padding: 24, fontSize: 12, color: '#555' }}>Loading feedback automation…</div>;

  const tpl = templates[templateTab] || templates.stars_1_5;

  const updateTpl = (key: keyof MessageTemplate, val: string) => {
    setTemplates((prev) => ({
      ...prev,
      [templateTab]: { ...prev[templateTab], [key]: val },
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    const res = await aiChatbotSettingsService.saveFeedbackAutomationConfig(config);
    setSaving(false);
    if (res.ok) {
      toast.success('Settings saved');
      reload();
    } else {
      toast.error(`Failed to save: ${res.error}`);
    }
  };

  return (
    <div style={{ maxWidth: 680 }}>
      {source === 'mock_fallback' && (
        <div
          style={{
            background: '#fffbeb',
            border: '0.5px solid #fbbf24',
            borderRadius: 11,
            padding: '10px 14px',
            marginBottom: 12,
            color: '#92400e',
            fontSize: 11.5,
          }}
        >
          ⚠️ Backend unavailable — showing default values.{' '}
          {loadError ? <span style={{ opacity: 0.75 }}>({loadError})</span> : null}
        </div>
      )}
      <div style={cardStyle}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>
          Post-Resolution Feedback Automation
        </div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 12 }}>
          對話結案後自動發送客戶評分請求
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={config.is_enabled}
            onChange={(e) =>
              setConfig({ ...config, is_enabled: e.target.checked })
            }
          />
          Enable Feedback Automation
        </label>
      </div>

      <div style={cardStyle}>
        <div style={sectionTitleStyle}>Send Timing</div>
        <div style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          Send after (days):
          <select
            value={config.send_after_days}
            onChange={(e) =>
              setConfig({
                ...config,
                send_after_days: Number(e.target.value) as 1 | 3 | 7,
              })
            }
            style={{
              fontSize: 12,
              padding: '4px 8px',
              border: '0.5px solid #e8e6e0',
              borderRadius: 8,
            }}
          >
            <option value={1}>1 day</option>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
          </select>
          after resolved
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={sectionTitleStyle}>Channels</span>
          <MockBadge label="Phase 1 Mock" />
        </div>
        {FEEDBACK_CHANNELS.map((ch) => (
          <label
            key={ch.key}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              marginBottom: 6,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={config.channels_enabled.includes(ch.key)}
              onChange={(e) =>
                setConfig({
                  ...config,
                  channels_enabled: e.target.checked
                    ? [...config.channels_enabled, ch.key]
                    : config.channels_enabled.filter((c) => c !== ch.key),
                })
              }
            />
            {ch.label}
            <ComingSoonBadge />
            <span style={{ fontSize: 10, color: '#888' }}>{ch.phase}</span>
          </label>
        ))}
      </div>

      <div style={cardStyle}>
        <div style={sectionTitleStyle}>Rating Type</div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {RATING_TYPES.map((r) => (
            <label
              key={r.key}
              style={{
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                cursor: 'pointer',
              }}
              title={r.tooltip || ''}
            >
              <input
                type="radio"
                name="rating"
                checked={config.rating_type === r.key}
                onChange={() => {
                  setConfig({ ...config, rating_type: r.key });
                  setTemplateTab(r.key);
                }}
              />
              {r.label}
              {r.suffix && r.suffixStyle === 'plain' && (
                <span style={{ fontSize: 9, color: '#888' }}>{r.suffix}</span>
              )}
              {r.suffix && r.suffixStyle === 'badge_blue' && (
                <span
                  style={{
                    fontSize: 9,
                    background: '#dbeafe',
                    color: '#2563eb',
                    padding: '1px 5px',
                    borderRadius: 3,
                  }}
                >
                  {r.suffix}
                </span>
              )}
            </label>
          ))}
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={sectionTitleStyle}>Message Template</span>
          <MockBadge label="Preview Only" />
        </div>

        <div
          style={{
            display: 'flex',
            gap: 0,
            borderBottom: '0.5px solid #e8e6e0',
            marginBottom: 14,
            overflowX: 'auto',
          }}
        >
          {TEMPLATE_TABS.map((tb) => (
            <button
              key={tb.key}
              onClick={() => setTemplateTab(tb.key)}
              style={{
                padding: '7px 12px',
                fontSize: 11,
                fontWeight: templateTab === tb.key ? 700 : 400,
                color: templateTab === tb.key ? '#1a1a1a' : '#888',
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                borderBottom:
                  templateTab === tb.key
                    ? '2px solid #1a1a1a'
                    : '2px solid transparent',
                marginBottom: -1,
                whiteSpace: 'nowrap',
              }}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
          <div>
            <div style={labelUpperStyle('#555')}>Email Subject</div>
            <input
              value={tpl.subject}
              onChange={(e) => updateTpl('subject', e.target.value)}
              style={inputStyle}
            />
            <div style={labelUpperStyle('#555')}>Message Body (EN)</div>
            <textarea
              value={tpl.bodyEn}
              onChange={(e) => updateTpl('bodyEn', e.target.value)}
              rows={2}
              style={textareaStyle}
            />
            <div style={labelUpperStyle('#555')}>Message Body (繁中)</div>
            <textarea
              value={tpl.bodyZh}
              onChange={(e) => updateTpl('bodyZh', e.target.value)}
              rows={2}
              style={textareaStyle}
            />
            <div style={labelUpperStyle('#555')}>CTA Button Text</div>
            <input
              value={tpl.ctaEn}
              onChange={(e) => updateTpl('ctaEn', e.target.value)}
              style={inputStyle}
            />
            <div style={labelUpperStyle('#555')}>Thank You Message (EN)</div>
            <textarea
              value={tpl.thankEn}
              onChange={(e) => updateTpl('thankEn', e.target.value)}
              rows={2}
              style={textareaStyle}
            />
            <div style={labelUpperStyle('#555')}>Thank You Message (繁中)</div>
            <textarea
              value={tpl.thankZh}
              onChange={(e) => updateTpl('thankZh', e.target.value)}
              rows={2}
              style={textareaStyle}
            />
            <div style={labelUpperStyle('#dc2626')}>Low Rating Follow-up (EN)</div>
            <textarea
              value={tpl.lowRatingEn}
              onChange={(e) => updateTpl('lowRatingEn', e.target.value)}
              rows={2}
              style={textareaStyle}
            />
            <div style={labelUpperStyle('#dc2626')}>Low Rating Follow-up (繁中)</div>
            <textarea
              value={tpl.lowRatingZh}
              onChange={(e) => updateTpl('lowRatingZh', e.target.value)}
              rows={2}
              style={{ ...textareaStyle, marginBottom: 0 }}
            />

            {templateTab === 'survey' && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1a1a1a', marginBottom: 10 }}>
                  Survey Questions (max 5)
                </div>
                {surveyQuestions.map((q, i) => (
                  <div
                    key={q.id}
                    style={{
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                      marginBottom: 8,
                    }}
                  >
                    <span style={{ fontSize: 10, color: '#888', width: 20 }}>
                      Q{i + 1}
                    </span>
                    {q.fixed ? (
                      <div
                        style={{
                          flex: 1,
                          fontSize: 11.5,
                          color: '#555',
                          background: '#f5f4f0',
                          padding: '5px 9px',
                          borderRadius: 7,
                          border: '0.5px solid #e8e6e0',
                        }}
                      >
                        {q.text}{' '}
                        <span style={{ fontSize: 9.5, color: '#888' }}>
                          ({q.type}) — fixed
                        </span>
                      </div>
                    ) : (
                      <>
                        <input
                          value={q.text}
                          onChange={(e) =>
                            setSurveyQuestions((prev) =>
                              prev.map((sq, si) =>
                                si === i ? { ...sq, text: e.target.value } : sq
                              )
                            )
                          }
                          placeholder="Custom question..."
                          style={{
                            flex: 1,
                            fontSize: 11.5,
                            padding: '5px 9px',
                            border: '0.5px solid #e8e6e0',
                            borderRadius: 7,
                          }}
                        />
                        <select
                          value={q.type}
                          onChange={(e) =>
                            setSurveyQuestions((prev) =>
                              prev.map((sq, si) =>
                                si === i
                                  ? {
                                      ...sq,
                                      type: e.target.value as SurveyQuestion['type'],
                                    }
                                  : sq
                              )
                            )
                          }
                          style={{
                            fontSize: 11,
                            padding: '5px 8px',
                            border: '0.5px solid #e8e6e0',
                            borderRadius: 7,
                          }}
                        >
                          <option value="text">Open text</option>
                          <option value="yes_no">Yes/No</option>
                          <option value="rating">Rating 1-5</option>
                        </select>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              {(['email', 'widget'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setPreviewMode(m)}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '4px 10px',
                    borderRadius: 6,
                    border: previewMode === m ? 'none' : '0.5px solid #e8e6e0',
                    background: previewMode === m ? '#1a1a1a' : '#fff',
                    color: previewMode === m ? '#fff' : '#555',
                    cursor: 'pointer',
                  }}
                >
                  Preview: {m === 'email' ? 'Email' : 'Chat Widget'}
                </button>
              ))}
              <span
                style={{
                  fontSize: 9.5,
                  color: '#92400e',
                  background: '#fef3c7',
                  padding: '2px 7px',
                  borderRadius: 4,
                  fontWeight: 600,
                }}
              >
                Phase 1
              </span>
            </div>
            {previewMode === 'email' ? (
              <div
                style={{
                  border: '0.5px solid #e8e6e0',
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: '#fff',
                }}
              >
                <div
                  style={{
                    background: '#f5f4f0',
                    padding: '8px 12px',
                    fontSize: 10,
                    color: '#555',
                    borderBottom: '0.5px solid #e8e6e0',
                  }}
                >
                  <div>From: Customer Support &lt;support@brand.com&gt;</div>
                  <div>
                    Subject: <b>{tpl.subject}</b>
                  </div>
                </div>
                <div style={{ padding: '12px 14px' }}>
                  <div style={{ fontSize: 12, color: '#1a1a1a', marginBottom: 10 }}>
                    Hi Frankie,
                  </div>
                  <div style={{ fontSize: 12, color: '#555', lineHeight: 1.6, marginBottom: 14 }}>
                    {tpl.bodyEn}
                  </div>
                  <div
                    style={{
                      display: 'inline-block',
                      background: '#1a1a1a',
                      color: '#fff',
                      fontSize: 12,
                      fontWeight: 600,
                      padding: '7px 18px',
                      borderRadius: 6,
                    }}
                  >
                    {tpl.ctaEn} ▶
                  </div>
                </div>
              </div>
            ) : (
              <div
                style={{
                  border: '0.5px solid #e8e6e0',
                  borderRadius: 10,
                  overflow: 'hidden',
                  background: '#fff',
                  maxWidth: 260,
                }}
              >
                <div
                  style={{
                    background: '#1a1a1a',
                    padding: '8px 12px',
                    fontSize: 11,
                    color: '#fff',
                    fontWeight: 600,
                  }}
                >
                  🤖 NexusAI
                </div>
                <div style={{ padding: '12px 14px' }}>
                  <div style={{ fontSize: 12, marginBottom: 10 }}>
                    How was your experience?
                  </div>
                  <div style={{ fontSize: 16, marginBottom: 10 }}>★ ★ ★ ★ ☆</div>
                  <input
                    placeholder="Share your feedback..."
                    style={{
                      width: '100%',
                      fontSize: 11,
                      padding: '6px 9px',
                      border: '0.5px solid #e8e6e0',
                      borderRadius: 7,
                      boxSizing: 'border-box',
                      marginBottom: 8,
                    }}
                    readOnly
                  />
                  <div
                    style={{
                      background: '#1a1a1a',
                      color: '#fff',
                      fontSize: 11,
                      fontWeight: 600,
                      padding: '5px 0',
                      borderRadius: 6,
                      textAlign: 'center',
                    }}
                  >
                    Submit
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={sectionTitleStyle}>Recent Requests</span>
          <MockBadge label="Mock Data" />
        </div>
        {requests.map((r) => (
          <div
            key={r.id}
            style={{
              fontSize: 11.5,
              display: 'flex',
              gap: 12,
              padding: '6px 0',
              borderBottom: '0.5px solid #e8e6e0',
            }}
          >
            <b>{r.customer_name}</b>
            <span style={{ color: '#888' }}>{r.conversation_id}</span>
            <span>{r.channel_sent}</span>
            <span
              style={{
                background: '#f0efe9',
                color: '#555',
                fontSize: 10,
                fontWeight: 600,
                padding: '1px 8px',
                borderRadius: 20,
              }}
            >
              {r.status}
            </span>
          </div>
        ))}
      </div>

      <div
        style={{
          background: '#fffbeb',
          border: '0.5px solid #fbbf24',
          borderRadius: 11,
          padding: '10px 14px',
          marginBottom: 12,
          color: '#92400e',
          fontSize: 11.5,
        }}
      >
        ⚠️ Phase 1: Settings UI only. Real email/SMS sending requires Phase 2 backend.
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          fontSize: 12,
          fontWeight: 600,
          padding: '8px 20px',
          borderRadius: 8,
          border: 'none',
          background: '#1a1a1a',
          color: '#fff',
          cursor: saving ? 'wait' : 'pointer',
          opacity: saving ? 0.6 : 1,
        }}
      >
        {saving ? 'Saving…' : 'Save Settings'}
      </button>
    </div>
  );
}
