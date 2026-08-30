import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import { aiChatbotSettingsService, type ChannelConfig } from "@/services/aiChatbotSettingsService";

export const Route = createFileRoute("/_authenticated/console/channel-settings")({
  component: ConsoleChannelSettings,
});

const ICONS: Record<string, string> = {
  website_widget: "💬",
  whatsapp: "📱",
  email: "✉️",
  line: "🟩",
};

const cardStyle: CSSProperties = {
  background: "#fff",
  border: "0.5px solid #e8e6e0",
  borderRadius: 11,
  padding: 14,
};

function LiveBadge({ label = "Live" }: { label?: string }) {
  return (
    <span
      style={{
        background: "#dcfce7",
        color: "#166534",
        fontSize: 9.5,
        fontWeight: 700,
        padding: "1px 7px",
        borderRadius: 20,
        border: "0.5px solid #86efac",
        whiteSpace: "nowrap",
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
        background: "#f0efe9",
        color: "#555",
        fontSize: 9.5,
        fontWeight: 700,
        padding: "1px 7px",
        borderRadius: 20,
        whiteSpace: "nowrap",
      }}
    >
      Coming Soon
    </span>
  );
}

function ConsoleChannelSettings() {
  const { role: productionRole, loading: roleLoading } = useCurrentRole();

  if (roleLoading) return <LoadingState />;

  // Authorization uses production DB role only (defense in depth).
  const canView = productionRole === "admin" || productionRole === "supervisor";
  if (!canView) {
    return <PermissionDenied message="You do not have permission to manage channel settings." />;
  }

  return <ChannelSettingsContent />;
}

function ChannelSettingsContent() {
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [source, setSource] = useState<"live" | "error" | "unconfigured" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [previewChannelId, setPreviewChannelId] = useState<string | null>(null);
  const [bindingChannelId, setBindingChannelId] = useState<string | null>(null);
  const [bindError, setBindError] = useState<string | null>(null);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editOrigins, setEditOrigins] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [savingChannelId, setSavingChannelId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    aiChatbotSettingsService.loadChannelConfigs().then((r) => {
      setChannels(r.data ?? []);
      setSource(r.source);
      setLoadError(r.error ?? null);
    });
  }, []);

  const previewChannel = channels.find((c) => c.id === previewChannelId);

  const beginEdit = (ch: ChannelConfig) => {
    setEditingChannelId(ch.id);
    setEditName(ch.channel_name);
    setEditOrigins(ch.allowed_origins.join("\n"));
    setEditActive(ch.is_active);
    setSaveError(null);
  };

  const saveChannel = async (ch: ChannelConfig) => {
    const origins = [...new Set(editOrigins.split(/\r?\n|,/).map((v) => v.trim()).filter(Boolean))];
    setSavingChannelId(ch.id);
    setSaveError(null);
    try {
      const result = await aiChatbotSettingsService.updateChannelConfig({
        channel_id: ch.id,
        name: editName.trim(),
        is_active: editActive,
        allowed_origins: origins,
      });
      if (!result.ok) {
        setSaveError(result.error);
        return;
      }
      const refreshed = await aiChatbotSettingsService.loadChannelConfigs();
      setChannels(refreshed.data ?? []);
      setSource(refreshed.source);
      setLoadError(refreshed.error ?? null);
      setEditingChannelId(null);
    } finally {
      setSavingChannelId(null);
    }
  };

  const bindCompany = async (channelId: string) => {
    setBindingChannelId(channelId);
    setBindError(null);
    try {
      const result = await aiChatbotSettingsService.bindChannelToCurrentCompany(channelId);
      if (!result.ok) {
        setBindError(result.error);
        return;
      }
      const refreshed = await aiChatbotSettingsService.loadChannelConfigs();
      setChannels(refreshed.data ?? []);
      setSource(refreshed.source);
      setLoadError(refreshed.error ?? null);
    } finally {
      setBindingChannelId(null);
    }
  };

  return (
    <div style={{ maxWidth: 900 }}>
      {source === "error" && (
        <div
          style={{
            background: "#fef2f2",
            border: "0.5px solid #fca5a5",
            borderRadius: 11,
            padding: "10px 14px",
            marginBottom: 12,
            color: "#991b1b",
            fontSize: 11.5,
          }}
        >
          ⚠️ Channel configuration unavailable. No fallback data is shown.{" "}
          {loadError ? <span style={{ opacity: 0.75 }}>({loadError})</span> : null}
        </div>
      )}
      {(bindError || saveError) && (
        <div
          style={{
            background: "#fef2f2",
            border: "0.5px solid #fca5a5",
            borderRadius: 11,
            padding: "10px 14px",
            marginBottom: 12,
            color: "#991b1b",
            fontSize: 11.5,
          }}
        >
          {bindError ? `Company binding failed: ${bindError}` : `Channel update failed: ${saveError}`}
        </div>
      )}
      <div
        style={{
          background: "#eff6ff",
          border: "0.5px solid #bfdbfe",
          borderRadius: 11,
          padding: "12px 14px",
          marginBottom: 14,
          color: "#1e40af",
          fontSize: 12,
          lineHeight: 1.6,
        }}
      >
        <b>Live channel configuration</b>
        <br />
        Only channels returned by the production backend are shown. Website Widget is live;
        unsupported channel types remain explicitly marked Coming Soon.
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(380px, 1fr))",
          gap: 12,
        }}
      >
        {channels.map((ch) => (
          <div key={ch.id} style={cardStyle}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 8,
              }}
            >
              <span style={{ fontSize: 18 }}>{ICONS[ch.channel_type]}</span>
              <span style={{ fontSize: 13, fontWeight: 700, flex: 1 }}>{ch.channel_name}</span>
              {ch.status === "live" ? <LiveBadge /> : <ComingSoonBadge />}
            </div>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 8 }}>{ch.phase}</div>
            <div
              title={
                !ch.recall_supported
                  ? "Message Recall not available. Correction Message will be used instead."
                  : undefined
              }
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: "6px 10px",
                borderRadius: 8,
                marginBottom: 8,
                background: ch.recall_supported ? "#d1fae5" : "#f0efe9",
                color: ch.recall_supported ? "#065f46" : "#555",
              }}
            >
              {ch.recall_supported
                ? `✅ Recall Supported (${ch.recall_time_limit_minutes} min)`
                : ch.channel_type === "email"
                  ? "❌ Correction only"
                  : "❌ Recall not guaranteed"}
            </div>
            <div
              style={{
                fontSize: 10.5,
                padding: "7px 9px",
                borderRadius: 8,
                marginBottom: 8,
                background: ch.company_id ? "#ecfdf5" : "#fef2f2",
                color: ch.company_id ? "#065f46" : "#991b1b",
                border: ch.company_id ? "0.5px solid #a7f3d0" : "0.5px solid #fecaca",
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: ch.company_id ? 0 : 6 }}>
                {ch.company_id ? "✅ Company identity bound" : "⚠️ Company identity required"}
              </div>
              {ch.company_id ? (
                <div style={{ fontFamily: "monospace", opacity: 0.8 }}>
                  {ch.company_id}
                </div>
              ) : (
                <button
                  type="button"
                  disabled={bindingChannelId === ch.id || source !== "live"}
                  onClick={() => void bindCompany(ch.id)}
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "5px 9px",
                    borderRadius: 7,
                    border: "none",
                    background: "#991b1b",
                    color: "#fff",
                    cursor: bindingChannelId === ch.id ? "wait" : "pointer",
                    opacity: source !== "live" ? 0.5 : 1,
                  }}
                >
                  {bindingChannelId === ch.id ? "Binding…" : "Bind to my company"}
                </button>
              )}
            </div>
            {ch.notes && <div style={{ fontSize: 10.5, color: "#888", marginBottom: 8 }}>{ch.notes}</div>}
            {ch.channel_type === "website_widget" && (
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, marginBottom: 4 }}>Allowed Origins</div>
                {ch.allowed_origins.length ? ch.allowed_origins.map((origin) => (
                  <div key={origin} style={{ fontFamily: "monospace", fontSize: 10, marginBottom: 2, color: origin === "*" ? "#991b1b" : "#475569" }}>
                    {origin}{origin === "*" ? " — INVALID / must be replaced" : ""}
                  </div>
                )) : <div style={{ fontSize: 10, color: "#991b1b" }}>No allowed origin configured</div>}
              </div>
            )}
            {editingChannelId === ch.id ? (
              <div style={{ background: "#f8fafc", border: "0.5px solid #cbd5e1", borderRadius: 8, padding: 10, marginTop: 8 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, marginBottom: 4 }}>Channel name</div>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} style={{ width: "100%", boxSizing: "border-box", fontSize: 11, padding: 6, marginBottom: 8 }} />
                {ch.channel_type === "website_widget" && <>
                  <div style={{ fontSize: 10.5, fontWeight: 700, marginBottom: 4 }}>Allowed origins — one HTTPS origin per line</div>
                  <textarea value={editOrigins} onChange={(e) => setEditOrigins(e.target.value)} rows={3} style={{ width: "100%", boxSizing: "border-box", fontSize: 10.5, padding: 6, marginBottom: 8, fontFamily: "monospace" }} />
                </>}
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 10.5, marginBottom: 8 }}>
                  <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} /> Active
                </label>
                <div style={{ display: "flex", gap: 6 }}>
                  <button type="button" disabled={savingChannelId === ch.id} onClick={() => void saveChannel(ch)} style={{ fontSize: 10.5, fontWeight: 700, padding: "5px 9px", border: 0, borderRadius: 6, background: "#166534", color: "#fff", cursor: "pointer" }}>{savingChannelId === ch.id ? "Saving…" : "Save"}</button>
                  <button type="button" onClick={() => setEditingChannelId(null)} style={{ fontSize: 10.5, padding: "5px 9px", border: "0.5px solid #cbd5e1", borderRadius: 6, background: "#fff", cursor: "pointer" }}>Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => beginEdit(ch)} style={{ fontSize: 10.5, fontWeight: 600, padding: "5px 10px", borderRadius: 8, border: "0.5px solid #cbd5e1", background: "#fff", cursor: "pointer", marginRight: 6, marginTop: 4 }}>Edit Settings</button>
            )}
            {ch.channel_type === "website_widget" && (
              <button
                onClick={() => setPreviewChannelId(ch.id)}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "5px 12px",
                  borderRadius: 8,
                  border: "none",
                  background: "#1a1a1a",
                  color: "#fff",
                  cursor: "pointer",
                  marginTop: 4,
                }}
              >
                Channel Details
              </button>
            )}
            {ch.channel_type === "website_widget" && ch.is_active && ch.company_id && ch.allowed_origins.length > 0 && !ch.allowed_origins.includes("*") && (
              <button
                type="button"
                onClick={() => { window.location.href = "/console/widget-preview"; }}
                style={{ fontSize: 11, fontWeight: 700, padding: "5px 12px", borderRadius: 8, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer", marginLeft: 6, marginTop: 4 }}
              >
                Open Real Test
              </button>
            )}
          </div>
        ))}
      </div>

      {previewChannel && (
        <div
          onClick={() => setPreviewChannelId(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 12,
              padding: 24,
              maxWidth: 480,
              width: "90%",
              boxShadow: "0 20px 40px rgba(0,0,0,0.2)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 12,
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700 }}>{previewChannel.channel_name} — Channel Details</div>
              <LiveBadge label={previewChannel.status === "live" ? "Live" : "Configured"} />
            </div>
            <div
              style={{
                background: "#fffbeb",
                border: "0.5px solid #fbbf24",
                borderRadius: 8,
                padding: "10px 12px",
                marginBottom: 14,
                color: "#92400e",
                fontSize: 11,
                lineHeight: 1.6,
              }}
            >
              This panel reflects the current production channel row. It does not fabricate
              unavailable channel capabilities or preview traffic.
            </div>
            <div
              style={{
                fontSize: 12,
                color: "#555",
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
                <b>Recall:</b>{" "}
                {previewChannel.recall_supported
                  ? `Supported (${previewChannel.recall_time_limit_minutes} min window)`
                  : "Not available in Phase 1"}
              </div>
              <div>
                <b>Status:</b> {previewChannel.status === "live" ? "Live" : "Coming Soon"}
              </div>
            </div>
            <button
              onClick={() => setPreviewChannelId(null)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: "7px 18px",
                borderRadius: 8,
                border: "none",
                background: "#1a1a1a",
                color: "#fff",
                cursor: "pointer",
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
