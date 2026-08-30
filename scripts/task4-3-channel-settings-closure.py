from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    s = p.read_text()
    n = s.count(old)
    if n != 1:
        raise SystemExit(f"{path}: expected 1 match, got {n}: {old[:100]!r}")
    p.write_text(s.replace(old, new, 1))

svc = "src/services/aiChatbotSettingsService.ts"
replace_once(svc,
'''  notes: string;
}''',
'''  notes: string;
  allowed_origins: string[];
}''')
replace_once(svc,
'''      notes: "Website widget channel",
    };''',
'''      notes: "Website widget channel",
      allowed_origins: Array.isArray(row.allowed_origins) ? row.allowed_origins : [],
    };''')
replace_once(svc,
'''    notes:
      type === "email"
        ? "Email provider contract is not configured"
        : `${row.name || rawType} production capability is not enabled`,
  };''',
'''    notes:
      type === "email"
        ? "Email provider contract is not configured"
        : `${row.name || rawType} production capability is not enabled`,
    allowed_origins: Array.isArray(row.allowed_origins) ? row.allowed_origins : [],
  };''')
replace_once(svc,
'''  async bindChannelToCurrentCompany(
    channelId: string,''',
'''  async updateChannelConfig(params: {
    channel_id: string;
    name?: string;
    is_active?: boolean;
    allowed_origins?: string[];
  }): Promise<{ ok: true; data: ChannelConfig } | { ok: false; error: string }> {
    try {
      const res = await configService.updateChannelConfig(params);
      if (!res.ok || !res.data) return { ok: false, error: res.error ?? "Channel update failed" };
      return { ok: true, data: deriveChannel(res.data) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },

  async bindChannelToCurrentCompany(
    channelId: string,''')

route = "src/routes/_authenticated/console.channel-settings.tsx"
replace_once(route,
'''  const [bindError, setBindError] = useState<string | null>(null);''',
'''  const [bindError, setBindError] = useState<string | null>(null);
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editOrigins, setEditOrigins] = useState("");
  const [editActive, setEditActive] = useState(true);
  const [savingChannelId, setSavingChannelId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);''')

replace_once(route,
'''  const previewChannel = channels.find((c) => c.id === previewChannelId);''',
'''  const previewChannel = channels.find((c) => c.id === previewChannelId);

  const beginEdit = (ch: ChannelConfig) => {
    setEditingChannelId(ch.id);
    setEditName(ch.channel_name);
    setEditOrigins(ch.allowed_origins.join("\n"));
    setEditActive(ch.is_active);
    setSaveError(null);
  };

  const saveChannel = async (ch: ChannelConfig) => {
    const origins = [...new Set(editOrigins.split(/\\r?\\n|,/).map((v) => v.trim()).filter(Boolean))];
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
  };''')

replace_once(route,
'''      {bindError && (
        <div''',
'''      {(bindError || saveError) && (
        <div''')
replace_once(route,
'''          Company binding failed: {bindError}
        </div>''',
'''          {bindError ? `Company binding failed: ${bindError}` : `Channel update failed: ${saveError}`}
        </div>''')

replace_once(route,
'''            {ch.notes && <div style={{ fontSize: 10.5, color: "#888", marginBottom: 8 }}>{ch.notes}</div>}
            {ch.channel_type === "website_widget" && (
              <button
                onClick={() => setPreviewChannelId(ch.id)}
                style={{''',
'''            {ch.notes && <div style={{ fontSize: 10.5, color: "#888", marginBottom: 8 }}>{ch.notes}</div>}
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
                style={{''')

replace_once(route,
'''              >
                Channel Details
              </button>
            )}''',
'''              >
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
            )}''')

for path, needles in {
    svc: ["allowed_origins: string[]", "async updateChannelConfig"],
    route: ["Allowed Origins", "Open Real Test", "updateChannelConfig", "INVALID / must be replaced"],
}.items():
    text = Path(path).read_text()
    for needle in needles:
        if needle not in text:
            raise SystemExit(f"missing postcondition {needle} in {path}")

print("TASK4_3_SOURCE_PATCH=PASS")
