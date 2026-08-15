import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import {
  configService,
  type LiveChannelConfigRow,
  type LiveWidgetConfigRow,
  type WidgetLauncherIcon,
} from "@/lib/api/config.service";

export const Route = createFileRoute("/_authenticated/console/widget-preview")({
  component: WidgetPreviewGuard,
});

type WidgetTheme = "modern" | "classic";
type Lang = "en" | "zh";

const LAUNCHER_ICONS: ReadonlyArray<{ value: WidgetLauncherIcon; symbol: string; label: string }> = [
  { value: "chat", symbol: "💬", label: "Chat" },
  { value: "headset", symbol: "🎧", label: "Support" },
  { value: "sparkles", symbol: "✨", label: "Sparkles" },
  { value: "bot", symbol: "🤖", label: "AI Bot" },
  { value: "mail", symbol: "✉️", label: "Message" },
];

const PRESET_COLORS = ["#6B5CE7", "#2563EB", "#0F766E", "#16A34A", "#EA580C", "#DC2626", "#111827"] as const;

const PREVIEW_DEFAULT: LiveWidgetConfigRow = {
  id: "preview-only",
  name: "Preview Widget",
  header_title: "Customer Support",
  welcome_message: "Hi! How can we help you today?",
  placeholder_text: "Type a message…",
  primary_color: "#6B5CE7",
  logo_url: null,
  is_active: true,
  appearance_theme: "modern",
  launcher_icon: "chat",
};

const COPY = {
  en: {
    denied: "You do not have permission to view widget preview.",
    subtitle: "Configure Widget appearance safely. Preview messages are local simulation only.",
    preview: "Preview",
    embed: "Embed Code",
    style: "Widget 1 / Widget 2",
    modern: "Widget 1 — Modern Assistant Panel",
    classic: "Widget 2 — Classic Popup",
    appearance: "Widget Appearance",
    color: "Primary color",
    icon: "Bubble icon",
    save: "Save live settings",
    saving: "Saving…",
    saved: "Saved",
    previewOnly: "Preview-only mode: canonical company/channel is not active yet. You can test style, color and bubble locally; live save and Embed Code remain disabled.",
    liveBanner: "Live Widget settings loaded. Messages below are still simulated and are never sent to production.",
    embedUnavailable: "Embed Code becomes available only after a canonical company and active Website Widget channel are configured.",
    noChannel: "No active Website Widget channel is currently available.",
    reply: "This is a simulated reply. Production replies use the live AI pipeline.",
    send: "Send",
    launcherHint: "Click the bubble to open/close the simulated Widget.",
  },
  zh: {
    denied: "您沒有權限查看 Widget 預覽。",
    subtitle: "安全設定 Widget 外觀；預覽訊息只在本機模擬，不會送到正式環境。",
    preview: "預覽",
    embed: "嵌入代碼",
    style: "Widget 1 / Widget 2",
    modern: "Widget 1 — Modern Assistant Panel",
    classic: "Widget 2 — Classic Popup",
    appearance: "Widget 外觀設定",
    color: "主顏色",
    icon: "Bubble 圖標",
    save: "儲存正式設定",
    saving: "儲存中…",
    saved: "已儲存",
    previewOnly: "Preview-only 模式：canonical company/channel 尚未啟用。現在可本機測試 Widget 樣式、顏色及 Bubble；正式儲存與 Embed Code 仍維持停用。",
    liveBanner: "已讀取正式 Widget 設定；下方訊息仍只作模擬，絕不送到 Production。",
    embedUnavailable: "只有在 canonical company 及有效 Website Widget channel 完成設定後才會提供 Embed Code。",
    noChannel: "目前沒有可用的 Website Widget channel。",
    reply: "這是模擬回覆；正式回覆會使用實際 AI pipeline。",
    send: "發送",
    launcherHint: "點擊 Bubble 可開啟／關閉模擬 Widget。",
  },
} as const;

function launcherSymbol(icon: WidgetLauncherIcon): string {
  return LAUNCHER_ICONS.find((item) => item.value === icon)?.symbol ?? "💬";
}

function normalizeColor(value: string | null | undefined): string {
  return /^#[0-9A-Fa-f]{6}$/.test(value ?? "") ? String(value) : "#6B5CE7";
}

function WidgetPreviewGuard() {
  const { role, loading } = useCurrentRole();
  const lang = useConsoleLang();
  if (loading) return <LoadingState />;
  if (role !== "admin" && role !== "supervisor") {
    return <PermissionDenied message={COPY[lang].denied} />;
  }
  return <WidgetPreviewContent role={role} />;
}

function WidgetPreviewContent({ role }: { role: "admin" | "supervisor" }) {
  const lang = useConsoleLang() as Lang;
  const c = COPY[lang];
  const [channels, setChannels] = useState<LiveChannelConfigRow[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [widget, setWidget] = useState<LiveWidgetConfigRow>(PREVIEW_DEFAULT);
  const [theme, setTheme] = useState<WidgetTheme>("modern");
  const [primary, setPrimary] = useState("#6B5CE7");
  const [launcherIcon, setLauncherIcon] = useState<WidgetLauncherIcon>("chat");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [loadingWidget, setLoadingWidget] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void configService.listChannelConfigs()
      .then((result) => {
        if (!active) return;
        if (!result.ok || !result.data) {
          // Preview must remain available even before canonical company activation.
          setLiveError(result.error ?? "channel_load_failed");
          setChannels([]);
          setSelectedId("");
          return;
        }
        const rows = result.data.filter(
          (row) => row.is_active && (row.channel_type === "web_widget" || row.channel_type === "website_widget"),
        );
        setChannels(rows);
        setSelectedId(rows[0]?.id ?? "");
        setLiveError(null);
      })
      .catch((e) => {
        if (!active) return;
        setLiveError(e instanceof Error ? e.message : "channel_load_failed");
        setChannels([]);
        setSelectedId("");
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setWidget(PREVIEW_DEFAULT);
      setTheme("modern");
      setPrimary("#6B5CE7");
      setLauncherIcon("chat");
      setSaved(false);
      return;
    }
    let active = true;
    setLoadingWidget(true);
    setSaved(false);
    void configService.getWidgetConfig(selectedId)
      .then((result) => {
        if (!active) return;
        if (!result.ok || !result.data) {
          setLiveError(result.error ?? "widget_load_failed");
          // Keep local preview functional with safe defaults.
          setWidget(PREVIEW_DEFAULT);
          setTheme("modern");
          setPrimary("#6B5CE7");
          setLauncherIcon("chat");
          return;
        }
        const next = result.data;
        setWidget(next);
        setTheme(next.appearance_theme === "classic" ? "classic" : "modern");
        setPrimary(normalizeColor(next.primary_color));
        setLauncherIcon(next.launcher_icon ?? "chat");
        setLiveError(null);
      })
      .catch((e) => {
        if (!active) return;
        setLiveError(e instanceof Error ? e.message : "widget_load_failed");
        setWidget(PREVIEW_DEFAULT);
      })
      .finally(() => {
        if (active) setLoadingWidget(false);
      });
    return () => { active = false; };
  }, [selectedId]);

  const previewOnly = !selectedId || widget.id === PREVIEW_DEFAULT.id;
  const canSaveLive = role === "admin" && !previewOnly && !loadingWidget;

  const functionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL as string | undefined;
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID as string | undefined;
  const apiBase = functionsUrl || (projectId ? `https://${projectId}.supabase.co/functions/v1` : "");

  const embedCode = useMemo(() => {
    if (!selectedId || !apiBase || typeof window === "undefined") return "";
    return `<script src="${window.location.origin}/widget/chat.js" data-channel-id="${selectedId}" data-api-base="${apiBase}" defer></script>`;
  }, [selectedId, apiBase]);

  const saveAppearance = async () => {
    if (!canSaveLive) return;
    setSaving(true);
    setSaved(false);
    try {
      const result = await configService.updateWidgetConfig({
        channel_id: selectedId,
        appearance_theme: theme,
        primary_color: primary,
        launcher_icon: launcherIcon,
      });
      if (!result.ok || !result.data) {
        setLiveError(result.error ?? "widget_update_failed");
        return;
      }
      const next = result.data;
      setWidget(next);
      setTheme(next.appearance_theme === "classic" ? "classic" : "modern");
      setPrimary(normalizeColor(next.primary_color));
      setLauncherIcon(next.launcher_icon ?? "chat");
      setSaved(true);
      setLiveError(null);
    } finally {
      setSaving(false);
    }
  };

  const copyCode = async () => {
    if (!embedCode || typeof navigator === "undefined") return;
    await navigator.clipboard.writeText(embedCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  if (channels === null) return <LoadingState />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Widget Preview</h1>
        <p className="text-muted-foreground">{c.subtitle}</p>
      </div>

      <div className={previewOnly ? "rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" : "rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"}>
        {previewOnly ? c.previewOnly : c.liveBanner}
        {previewOnly && liveError && (
          <div className="mt-1 text-xs opacity-80">Live data: {liveError}</div>
        )}
      </div>

      {channels.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">Channel</span>
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="w-[320px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {channels.map((row) => <SelectItem key={row.id} value={row.id}>{row.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="rounded-xl border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">{c.style}</div>
            <div className="text-xs text-muted-foreground">Widget 1 is the modern default. Widget 2 keeps the classic floating popup experience.</div>
          </div>
          {role === "admin" && (
            <Button size="sm" onClick={() => void saveAppearance()} disabled={!canSaveLive || saving}>
              {saving ? c.saving : c.save}
            </Button>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <ThemeCard title={c.modern} description="Default · right-side Assistant Panel · desktop resizable · mobile full-screen" selected={theme === "modern"} badge="Default" symbol="▥" onClick={() => setTheme("modern")} />
          <ThemeCard title={c.classic} description="Floating bubble + classic popup chat window" selected={theme === "classic"} symbol="◩" onClick={() => setTheme("classic")} />
        </div>

        <div className="mt-5 border-t pt-4">
          <div className="mb-3 text-sm font-semibold">{c.appearance}</div>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-medium">{c.color}</div>
              <div className="flex flex-wrap items-center gap-2">
                {PRESET_COLORS.map((color) => (
                  <button key={color} type="button" aria-label={`Use ${color}`} onClick={() => setPrimary(color)} className={primary.toLowerCase() === color.toLowerCase() ? "h-9 w-9 rounded-full border-4 border-slate-900" : "h-9 w-9 rounded-full border-2 border-white shadow ring-1 ring-slate-200"} style={{ background: color }} />
                ))}
                <label className="ml-1 flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs">
                  <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value.toUpperCase())} className="h-7 w-8 cursor-pointer border-0 bg-transparent p-0" />
                  {primary}
                </label>
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-medium">{c.icon}</div>
              <div className="flex flex-wrap gap-2">
                {LAUNCHER_ICONS.map((item) => (
                  <button key={item.value} type="button" onClick={() => setLauncherIcon(item.value)} className={launcherIcon === item.value ? "flex min-w-20 items-center gap-2 rounded-lg border border-violet-500 bg-violet-50 px-3 py-2 text-xs font-medium" : "flex min-w-20 items-center gap-2 rounded-lg border px-3 py-2 text-xs hover:bg-muted/40"}>
                    <span className="text-lg" aria-hidden="true">{item.symbol}</span><span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3 rounded-lg bg-muted/40 p-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-full text-xl text-white shadow" style={{ background: primary }} aria-label="Bubble preview">{launcherSymbol(launcherIcon)}</div>
            <div className="text-xs text-muted-foreground">{c.launcherHint}</div>
          </div>

          {!canSaveLive && (
            <div className="mt-3 text-xs text-muted-foreground">
              {role === "supervisor" ? "Supervisor preview is read-only." : "Live save requires canonical company activation and an owned Website Widget channel."}
            </div>
          )}
          {saved && <div className="mt-3 text-xs text-emerald-700">{c.saved}</div>}
        </div>
      </div>

      <Tabs defaultValue="preview">
        <TabsList><TabsTrigger value="preview">{c.preview}</TabsTrigger><TabsTrigger value="embed">{c.embed}</TabsTrigger></TabsList>
        <TabsContent value="preview">
          {loadingWidget && selectedId ? <LoadingState /> : (
            <SimulatedWidget lang={lang} theme={theme} primary={primary} title={widget.header_title || "Customer Support"} launcherIcon={launcherIcon} placeholder={widget.placeholder_text || "Type a message…"} />
          )}
        </TabsContent>
        <TabsContent value="embed" className="space-y-3">
          {!embedCode ? (
            <div className="rounded-lg border bg-card p-6 text-muted-foreground">{c.embedUnavailable}</div>
          ) : (
            <>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">One embed code supports Widget 1 / Widget 2. Saved appearance is loaded from guarded public Widget config.</div>
              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-2">
                  <span className="text-sm font-medium">Paste before &lt;/body&gt;</span>
                  <Button size="sm" variant="ghost" onClick={copyCode}>{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}{copied ? "Copied" : "Copy"}</Button>
                </div>
                <pre className="overflow-x-auto p-4 text-xs">{embedCode}</pre>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ThemeCard({ title, description, selected, badge, symbol, onClick }: { title: string; description: string; selected: boolean; badge?: string; symbol: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={["rounded-xl border p-4 text-left", selected ? "border-violet-500 bg-violet-50" : "border-border bg-background hover:bg-muted/40"].join(" ")}>
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 font-semibold"><span aria-hidden="true">{symbol}</span><span>{title}</span></div>
        {badge && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">{badge}</span>}
      </div>
      <div className="text-xs leading-5 text-muted-foreground">{description}</div>
      <div className="mt-2 text-xs font-medium">{selected ? "● Selected" : "○ Select"}</div>
    </button>
  );
}

type SimMsg = { id: string; role: "visitor" | "assistant"; content: string };

function SimulatedWidget({ lang, theme, primary, title, launcherIcon, placeholder }: { lang: Lang; theme: WidgetTheme; primary: string; title: string; launcherIcon: WidgetLauncherIcon; placeholder: string }) {
  const c = COPY[lang];
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<SimMsg[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const send = () => {
    if (typing || !input.trim()) return;
    const text = input.trim();
    setMessages((v) => [...v, { id: `v-${Date.now()}`, role: "visitor", content: text }]);
    setInput("");
    setTyping(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setMessages((v) => [...v, { id: `a-${Date.now()}`, role: "assistant", content: c.reply }]);
      setTyping(false);
      timer.current = null;
    }, 1000);
  };

  const chat = (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className={theme === "classic" ? "flex items-center justify-between px-4 py-3 text-sm font-semibold text-white" : "flex items-center justify-between border-b px-4 py-3 text-sm font-semibold"} style={theme === "classic" ? { background: primary } : undefined}>
        <span>{title} · Simulated</span><button type="button" onClick={() => setOpen(false)} className="rounded px-2 py-1 text-xs opacity-70 hover:opacity-100" aria-label="Close simulated widget">✕</button>
      </div>
      <div className="flex min-h-[320px] flex-1 flex-col gap-2 overflow-y-auto bg-slate-50 p-4">
        {messages.length === 0 && <div className="py-16 text-center text-xs text-slate-400">Send a message to start simulated chat</div>}
        {messages.map((m) => <div key={m.id} className={m.role === "visitor" ? "ml-auto max-w-[80%] rounded-lg px-3 py-2 text-sm text-white" : "max-w-[80%] rounded-lg border bg-white px-3 py-2 text-sm"} style={m.role === "visitor" ? { background: primary } : undefined}>{m.content}</div>)}
        {typing && <div className="text-xs text-slate-400">Typing…</div>}
      </div>
      <div className="flex gap-2 border-t bg-white p-3">
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } }} className="min-w-0 flex-1 rounded-md border px-3 py-2 text-sm" placeholder={placeholder} />
        <Button onClick={send} disabled={typing || !input.trim()} style={{ background: primary }}>{c.send}</Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">Preview is isolated local simulation: no visitor session, message, polling or production data writes.</div>
      <div className="relative min-h-[540px] overflow-hidden rounded-xl border bg-slate-50">
        <div className="absolute inset-0 flex items-center justify-center p-8 text-center text-xs text-slate-400">Host website preview area</div>
        {open && theme === "modern" && (
          <div className="absolute bottom-0 right-0 top-0 flex w-full min-w-[340px] flex-col border-l bg-white shadow-xl md:w-[420px]">{chat}</div>
        )}
        {open && theme === "classic" && (
          <div className="absolute bottom-20 right-6 flex h-[440px] w-[360px] max-w-[calc(100%-48px)] flex-col overflow-hidden rounded-xl border bg-white shadow-xl">{chat}</div>
        )}
        {!open && (
          <button type="button" onClick={() => setOpen(true)} className="absolute bottom-5 right-5 flex h-14 w-14 items-center justify-center rounded-full text-2xl text-white shadow-lg transition-transform hover:scale-105" style={{ background: primary }} aria-label="Open simulated chat">{launcherSymbol(launcherIcon)}</button>
        )}
      </div>
    </div>
  );
}
