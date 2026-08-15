import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, MonitorDot, Plus, History, Image, Video, Paperclip, UserRound, Smile } from "lucide-react";
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

const PREVIEW_EMOJIS = ["😊","😂","🙏","👍","❤️","🎉","😅","😭","🔥","✅","👋","😍","🤔","😢","😎","🙌","💪","😁","🥰","🤩"] as const;

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
    subtitle: "Configure appearance and test the Widget interaction flow. Live AI accuracy testing becomes available after canonical channel activation.",
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
    previewOnly: "UI Simulation mode: canonical company/channel is not active yet. You can test Widget 1 / 2, color, launcher and human-handoff UI locally. AI answer accuracy is not simulated; live save, Live AI Test and Embed Code remain disabled.",
    liveBanner: "Live Widget settings loaded. Appearance preview remains isolated. Use the production Widget after activation for real AI / KB / human-handoff accuracy testing.",
    embedUnavailable: "Embed Code becomes available only after a canonical company and active Website Widget channel are configured.",
    noChannel: "No active Website Widget channel is currently available.",
    reply: "This is a simulated reply. Production replies use the live AI pipeline.",
    send: "Send",
    launcherHint: "The launcher is fixed to the viewport bottom-right and opens Widget 1 as a right-side Assistant bar.",
  },
  zh: {
    denied: "您沒有權限查看 Widget 預覽。",
    subtitle: "設定 Widget 外觀並測試互動流程；完成 canonical channel 啟用後才進行真正 AI 準確度測試。",
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
    previewOnly: "UI Simulation 模式：canonical company/channel 尚未啟用。現在可本機測試 Widget 1 / 2、顏色、Bubble 與轉真人 UI；不會偽造 AI 準確度。Live AI Test、正式儲存與 Embed Code 維持停用。",
    liveBanner: "已讀取正式 Widget 設定；外觀 Preview 仍保持隔離。完成啟用後請使用正式 Widget 測試真實 AI／KB／轉真人準確度。",
    embedUnavailable: "只有在 canonical company 及有效 Website Widget channel 完成設定後才會提供 Embed Code。",
    noChannel: "目前沒有可用的 Website Widget channel。",
    reply: "這是模擬回覆；正式回覆會使用實際 AI pipeline。",
    send: "發送",
    launcherHint: "Bubble 固定在目前視窗右下角；Widget 1 會像 Assistant sidecar 一樣由右側滑出。",
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
  const [previewOpen, setPreviewOpen] = useState(false);

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
    <div
      className={[
        "space-y-4 transition-[padding-right] duration-200",
        theme === "modern" && previewOpen ? "lg:pr-[420px]" : "",
      ].join(" ")}
    >
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
          <ThemeCard title={c.modern} description="Default · right-side Assistant Panel · desktop resizable · mobile full-screen" selected={theme === "modern"} badge="Default" symbol="▥" onClick={() => { setTheme("modern"); setPreviewOpen(false); }} />
          <ThemeCard title={c.classic} description="Floating bubble + classic popup chat window" selected={theme === "classic"} symbol="◩" onClick={() => { setTheme("classic"); setPreviewOpen(false); }} />
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
            <MonitorDot className="h-5 w-5 text-muted-foreground" />
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
            <SimulatedWidget
              lang={lang}
              theme={theme}
              primary={primary}
              title={widget.header_title || "Customer Support"}
              launcherIcon={launcherIcon}
              placeholder={widget.placeholder_text || "Type a message…"}
              open={previewOpen}
              onOpenChange={setPreviewOpen}
              liveAvailable={!previewOnly}
            />
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

function SimulatedWidget({
  lang,
  theme,
  primary,
  title,
  launcherIcon,
  placeholder,
  open,
  onOpenChange,
  liveAvailable,
}: {
  lang: Lang;
  theme: WidgetTheme;
  primary: string;
  title: string;
  launcherIcon: WidgetLauncherIcon;
  placeholder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  liveAvailable: boolean;
}) {
  const c = COPY[lang];
  const [messages, setMessages] = useState<SimMsg[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<SimMsg[][]>([]);
  const actionAreaRef = useRef<HTMLDivElement | null>(null);
  const [humanState, setHumanState] = useState<"none" | "waiting" | "assigned">("none");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handoffTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (handoffTimer.current) clearTimeout(handoffTimer.current);
    },
    [],
  );


  useEffect(() => {
    const closeOutside = (event: MouseEvent | PointerEvent) => {
      const node = event.target;
      if (node instanceof Node && actionAreaRef.current?.contains(node)) return;
      setMenuOpen(false);
      setEmojiOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      setEmojiOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("contextmenu", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("contextmenu", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  const requestHuman = () => {
    if (humanState !== "none") return;
    setHumanState("waiting");
    setMessages((v) => [
      ...v,
      {
        id: `system-handoff-${Date.now()}`,
        role: "assistant",
        content:
          lang === "zh"
            ? "已模擬提出轉真人要求。"
            : "Human support request simulated.",
      },
    ]);
    handoffTimer.current = setTimeout(() => {
      setHumanState("assigned");
      handoffTimer.current = null;
    }, 1200);
  };

  const send = () => {
    if (typing || !input.trim()) return;
    const text = input.trim();
    setMessages((v) => [...v, { id: `v-${Date.now()}`, role: "visitor", content: text }]);
    setInput("");

    if (/(human|agent|真人|人工|客服)/i.test(text)) {
      requestHuman();
      return;
    }

    setTyping(true);
    timer.current = setTimeout(() => {
      setMessages((v) => [
        ...v,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content:
            lang === "zh"
              ? "這是 UI Simulation 回覆，不代表真實 AI／Knowledge Base 準確度。完成 canonical channel activation 後，請以正式 Widget 進行 Live AI Test。"
              : "This is a UI Simulation reply, not a measure of live AI / Knowledge Base accuracy. After canonical channel activation, use the production Widget for Live AI Test.",
        },
      ]);
      setTyping(false);
      timer.current = null;
    }, 650);
  };

  const chat = (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div
        className={
          theme === "classic"
            ? "flex items-center justify-between px-4 py-3 text-sm font-semibold text-white"
            : "flex min-h-14 items-center justify-between border-b bg-white px-4 py-3 text-sm font-semibold"
        }
        style={theme === "classic" ? { background: primary } : undefined}
      >
        <div className="min-w-0">
          <div>{title}</div>
          <div className={theme === "classic" ? "text-[10px] font-normal opacity-80" : "text-[10px] font-normal text-muted-foreground"}>
            {liveAvailable ? "Appearance preview · Live AI requires production Widget" : "UI Simulation"}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className="rounded p-2 opacity-70 hover:bg-black/5 hover:opacity-100"
            aria-label="Conversation History"
            title="Conversation History"
          >
            <History className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              if (messages.length) setHistory((h) => [messages, ...h].slice(0, 10));
              setMessages([{
                id: `new-conversation-${Date.now()}`,
                role: "assistant",
                content: lang === "zh"
                  ? "已開始新的模擬對話。Live Widget 會建立新的 visitor session / conversation。"
                  : "New simulated conversation started. In the Live Widget this creates a new visitor session / conversation.",
              }]);
              setInput("");
              setTyping(false);
              setHumanState("none");
              setHistoryOpen(false);
              setMenuOpen(false);
              setEmojiOpen(false);
            }}
            className="rounded p-2 opacity-70 hover:bg-black/5 hover:opacity-100"
            aria-label="New Conversation"
            title="New Conversation — Live creates a fresh visitor session / conversation"
          >
            +
          </button>
        </div>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="rounded px-2 py-1 text-lg opacity-60 hover:opacity-100"
          aria-label="Close simulated widget"
        >
          ×
        </button>
      </div>

      {humanState !== "none" && (
        <div
          className={
            humanState === "waiting"
              ? "border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800"
              : "border-b border-violet-200 bg-violet-50 px-4 py-2 text-xs text-violet-800"
          }
        >
          {humanState === "waiting"
            ? lang === "zh"
              ? "正在模擬等待真人客服…"
              : "Simulating wait for a human agent…"
            : lang === "zh"
              ? "已模擬真人客服接手；AI 回覆暫停。"
              : "Human agent simulated as connected; AI replies are paused."}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-white p-4">
        {messages.length === 0 && (
          <div className="my-auto px-6 text-center text-xs leading-6 text-slate-400">
            {lang === "zh"
              ? "輸入訊息測試 Widget 互動。輸入「真人客服」可測試 handoff UI。"
              : "Type a message to test Widget interaction. Type “human agent” to test handoff UI."}
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={
              m.role === "visitor"
                ? "ml-auto max-w-[82%] rounded-2xl rounded-br-md px-3 py-2 text-sm text-white"
                : "max-w-[82%] rounded-2xl rounded-bl-md border bg-slate-50 px-3 py-2 text-sm"
            }
            style={m.role === "visitor" ? { background: primary } : undefined}
          >
            {m.content}
          </div>
        ))}
        {typing && <div className="text-xs text-slate-400">Typing…</div>}
      </div>

      <div className="border-t bg-white p-3">
        {historyOpen && (
          <div className="mb-2 rounded-xl border bg-slate-50 p-2">
            <div className="mb-2 text-xs font-semibold">Conversation History</div>
            {history.length === 0 ? (
              <div className="text-xs text-slate-400">No simulated conversation history yet.</div>
            ) : (
              history.map((session, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setMessages(session);
                    setHistoryOpen(false);
                  }}
                  className="mb-1 block w-full rounded-lg border bg-white px-3 py-2 text-left text-xs"
                >
                  Conversation {history.length - i} · {session.length} messages
                </button>
              ))
            )}
          </div>
        )}

        <div ref={actionAreaRef} className="relative flex gap-2 rounded-xl border bg-white p-1">
          <button
            type="button"
            onClick={() => { setEmojiOpen(false); setMenuOpen((v) => !v); }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-white"
            aria-label="More actions"
            title="More actions"
          >
            <Plus className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => { setMenuOpen(false); setEmojiOpen((v) => !v); }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white"
            aria-label="Emoji"
            title="Emoji"
          >
            <Smile className="h-4 w-4" />
          </button>

          {menuOpen && (
            <div className="absolute bottom-12 left-0 z-20 w-56 rounded-xl border bg-white p-1 shadow-xl">
              <button type="button" onClick={() => { setMenuOpen(false); setMessages((v) => [...v, { id: `image-${Date.now()}`, role: "visitor", content: "[Image upload simulated in Preview]" }]); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50">
                <Image className="h-4 w-4" />Image
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); setMessages((v) => [...v, { id: `video-${Date.now()}`, role: "visitor", content: "[Video upload simulated in Preview]" }]); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50">
                <Video className="h-4 w-4" />Video
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); setMessages((v) => [...v, { id: `file-${Date.now()}`, role: "visitor", content: "[File upload simulated in Preview]" }]); }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50">
                <Paperclip className="h-4 w-4" />File
              </button>
              <button type="button" onClick={() => { setMenuOpen(false); requestHuman(); }} disabled={humanState !== "none"} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50">
                <UserRound className="h-4 w-4" />Request Human Support
              </button>
            </div>
          )}

          {emojiOpen && (
            <div className="absolute bottom-12 left-10 z-20 grid w-64 grid-cols-8 gap-1 rounded-xl border bg-white p-2 shadow-xl">
              {PREVIEW_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => { setInput((value) => `${value}${emoji}`); setEmojiOpen(false); }}
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-base hover:bg-slate-100"
                  aria-label={`Insert ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}

          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                send();
              }
            }}
            className="min-w-0 flex-1 border-0 px-2 py-2 text-sm outline-none"
            placeholder={placeholder}
          />
          <Button
            onClick={send}
            disabled={typing || !input.trim() || humanState === "assigned"}
            style={{ background: primary }}
          >
            {c.send}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
        {lang === "zh"
          ? "Widget Preview 不再建立假的 Host Website 區域。這裡只測試 Widget 外觀、互動與 handoff UI；真正 AI／KB／handoff 準確度必須在 canonical channel 啟用後使用正式 Widget 測試。"
          : "Widget Preview no longer renders a fake Host Website area. This screen tests Widget appearance, interaction and handoff UI; real AI / KB / handoff accuracy must be tested with the production Widget after canonical channel activation."}
      </div>

      {!open && (
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className="fixed bottom-[max(24px,env(safe-area-inset-bottom))] right-6 z-[80] flex h-14 w-14 items-center justify-center rounded-full text-2xl text-white shadow-xl transition-transform hover:scale-105"
          style={{ background: primary }}
          aria-label="Open simulated chat"
        >
          {launcherSymbol(launcherIcon)}
        </button>
      )}

      {theme === "modern" && (
        <aside
          aria-label="Widget 1 Assistant sidecar preview"
          className={[
            "fixed bottom-0 right-0 top-[33px] z-[79] flex w-[min(420px,100vw)] flex-col border-l bg-white shadow-[-12px_0_32px_rgba(15,23,42,0.10)]",
            "transition-transform duration-200 ease-out",
            open ? "translate-x-0" : "translate-x-full pointer-events-none",
          ].join(" ")}
        >
          {chat}
        </aside>
      )}

      {theme === "classic" && open && (
        <div className="fixed bottom-24 right-6 z-[79] flex h-[min(560px,calc(100dvh-140px))] w-[min(360px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border bg-white shadow-2xl">
          {chat}
        </div>
      )}
    </>
  );
}
