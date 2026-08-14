import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
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
} from "@/lib/api/config.service";

export const Route = createFileRoute("/_authenticated/console/widget-preview")({
  component: WidgetPreviewGuard,
});

type WidgetTheme = "modern" | "classic";

const COPY = {
  en: {
    denied: "You do not have permission to view widget preview.",
    subtitle: "Preview uses the selected channel's live Widget settings. Messages are simulated only.",
    noChannels: "No active Website Widget channel is available for your company.",
    preview: "Preview",
    embed: "Embed Code",
    banner: "Theme and colors come from live Widget settings. Messages are simulated and are not sent to production.",
    reply: "This is a simulated reply. Production replies use the live AI pipeline.",
    send: "Send",
    save: "Save style",
    saving: "Saving…",
    saved: "Saved",
    modern: "Modern Assistant Panel",
    classic: "Classic Popup",
  },
  zh: {
    denied: "您沒有權限查看 Widget 預覽。",
    subtitle: "預覽會使用所選 Channel 的正式 Widget 設定；訊息只作模擬。",
    noChannels: "您的公司目前沒有可用的 Website Widget channel。",
    preview: "預覽",
    embed: "嵌入代碼",
    banner: "Theme 與顏色來自正式 Widget 設定；訊息只作模擬，不會送到 Production。",
    reply: "這是模擬回覆；正式回覆會使用實際 AI pipeline。",
    send: "發送",
    save: "儲存樣式",
    saving: "儲存中…",
    saved: "已儲存",
    modern: "Modern Assistant Panel",
    classic: "Classic Popup",
  },
} as const;

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
  const lang = useConsoleLang();
  const c = COPY[lang];
  const [channels, setChannels] = useState<LiveChannelConfigRow[] | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [widget, setWidget] = useState<LiveWidgetConfigRow | null>(null);
  const [theme, setTheme] = useState<WidgetTheme>("modern");
  const [error, setError] = useState<string | null>(null);
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
          setError(result.error ?? "channel_load_failed");
          setChannels([]);
          return;
        }
        const rows = result.data.filter(
          (row) =>
            row.is_active &&
            (row.channel_type === "web_widget" ||
              row.channel_type === "website_widget"),
        );
        setChannels(rows);
        setSelectedId(rows[0]?.id ?? "");
      })
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "channel_load_failed");
        setChannels([]);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setWidget(null);
      setTheme("modern");
      return;
    }
    let active = true;
    setLoadingWidget(true);
    setSaved(false);
    void configService.getWidgetConfig(selectedId)
      .then((result) => {
        if (!active) return;
        if (!result.ok || !result.data) {
          setError(result.error ?? "widget_load_failed");
          setWidget(null);
          return;
        }
        setWidget(result.data);
        setTheme(result.data.appearance_theme === "classic" ? "classic" : "modern");
      })
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "widget_load_failed");
        setWidget(null);
      })
      .finally(() => {
        if (active) setLoadingWidget(false);
      });
    return () => { active = false; };
  }, [selectedId]);

  const functionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL as string | undefined;
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID as string | undefined;
  const apiBase =
    functionsUrl ||
    (projectId ? `https://${projectId}.supabase.co/functions/v1` : "");

  const embedCode = useMemo(() => {
    if (!selectedId || !apiBase || typeof window === "undefined") return "";
    return `<script src="${window.location.origin}/widget/chat.js" data-channel-id="${selectedId}" data-api-base="${apiBase}" defer></script>`;
  }, [selectedId, apiBase]);

  const saveTheme = async () => {
    if (role !== "admin" || !widget || !selectedId) return;
    setSaving(true);
    setSaved(false);
    try {
      const result = await configService.updateWidgetConfig({
        channel_id: selectedId,
        appearance_theme: theme,
      });
      if (!result.ok || !result.data) {
        setError(result.error ?? "widget_update_failed");
        return;
      }
      setWidget(result.data);
      setTheme(result.data.appearance_theme === "classic" ? "classic" : "modern");
      setSaved(true);
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

  const primary = widget?.primary_color || "#6B5CE7";
  const title = widget?.header_title || "Customer Support";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Widget Preview</h1>
        <p className="text-muted-foreground">{c.subtitle}</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Widget data unavailable: {error}
        </div>
      )}

      {channels.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">Channel</span>
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="w-[320px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {channels.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {channels.length > 0 && (
        <div className="rounded-xl border bg-card p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Widget Style</div>
              <div className="text-xs text-muted-foreground">
                Modern is the default. Classic Popup remains available as the secondary option.
              </div>
            </div>
            {role === "admin" && (
              <Button
                size="sm"
                onClick={() => void saveTheme()}
                disabled={!widget || loadingWidget || saving}
              >
                {saving ? c.saving : c.save}
              </Button>
            )}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <ThemeCard
              title={c.modern}
              description="Default · Right-side split Assistant Panel · minimum 340px · desktop resizable · mobile full-screen"
              selected={theme === "modern"}
              disabled={role !== "admin" || !widget || loadingWidget}
              badge="Default"
              symbol="▥"
              onClick={() => setTheme("modern")}
            />
            <ThemeCard
              title={c.classic}
              description="Secondary · Existing floating chat bubble + popup window"
              selected={theme === "classic"}
              disabled={role !== "admin" || !widget || loadingWidget}
              symbol="◩"
              onClick={() => setTheme("classic")}
            />
          </div>

          {role === "supervisor" && (
            <div className="mt-3 text-xs text-muted-foreground">
              Supervisor preview is read-only. Admin is required to change Widget Style.
            </div>
          )}
          {saved && <div className="mt-3 text-xs text-emerald-700">{c.saved}</div>}
        </div>
      )}

      <Tabs defaultValue="preview">
        <TabsList>
          <TabsTrigger value="preview">{c.preview}</TabsTrigger>
          <TabsTrigger value="embed">{c.embed}</TabsTrigger>
        </TabsList>

        <TabsContent value="preview">
          {channels.length === 0 ? (
            <div className="rounded-lg border bg-card p-6 text-muted-foreground">
              {c.noChannels}
            </div>
          ) : loadingWidget ? (
            <LoadingState />
          ) : (
            <SimulatedWidget
              lang={lang}
              theme={theme}
              primary={primary}
              title={title}
            />
          )}
        </TabsContent>

        <TabsContent value="embed" className="space-y-3">
          {channels.length === 0 ? (
            <div className="rounded-lg border bg-card p-6 text-muted-foreground">
              {c.noChannels}
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                One embed code supports both styles. The saved appearance_theme is loaded through the guarded public Widget config. Do not use chat-v2.js.
              </div>
              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-2">
                  <span className="text-sm font-medium">Paste before &lt;/body&gt;</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={copyCode}
                    disabled={!embedCode}
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <pre className="overflow-x-auto p-4 text-xs">
                  {embedCode || "Runtime functions URL is not configured."}
                </pre>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ThemeCard({
  title,
  description,
  selected,
  disabled,
  badge,
  symbol,
  onClick,
}: {
  title: string;
  description: string;
  selected: boolean;
  disabled: boolean;
  badge?: string;
  symbol: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={[
        "rounded-xl border p-4 text-left",
        selected ? "border-violet-500 bg-violet-50" : "border-border bg-background",
        disabled ? "cursor-default opacity-70" : "cursor-pointer hover:bg-muted/40",
      ].join(" ")}
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 font-semibold">
          <span aria-hidden="true">{symbol}</span>
          <span>{title}</span>
        </div>
        {badge && (
          <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
            {badge}
          </span>
        )}
      </div>
      <div className="text-xs leading-5 text-muted-foreground">{description}</div>
      <div className="mt-2 text-xs font-medium">
        {selected ? "● Selected" : "○ Select"}
      </div>
    </button>
  );
}

type SimMsg = { id: string; role: "visitor" | "assistant"; content: string };

function SimulatedWidget({
  lang,
  theme,
  primary,
  title,
}: {
  lang: "en" | "zh";
  theme: WidgetTheme;
  primary: string;
  title: string;
}) {
  const c = COPY[lang];
  const [messages, setMessages] = useState<SimMsg[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const send = () => {
    if (typing || !input.trim()) return;
    const text = input.trim();
    setMessages((v) => [...v, { id: `v-${Date.now()}`, role: "visitor", content: text }]);
    setInput("");
    setTyping(true);
    timer.current = setTimeout(() => {
      setMessages((v) => [...v, { id: `a-${Date.now()}`, role: "assistant", content: c.reply }]);
      setTyping(false);
      timer.current = null;
    }, 1000);
  };

  const chat = (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div
        className={theme === "classic" ? "px-4 py-3 text-sm font-semibold text-white" : "border-b px-4 py-3 text-sm font-semibold"}
        style={theme === "classic" ? { background: primary } : undefined}
      >
        {title} · Simulated
      </div>
      <div className="flex min-h-[320px] flex-1 flex-col gap-2 overflow-y-auto bg-slate-50 p-4">
        {messages.length === 0 && (
          <div className="py-16 text-center text-xs text-slate-400">
            Send a message to start simulated chat
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={
              m.role === "visitor"
                ? "ml-auto max-w-[80%] rounded-lg px-3 py-2 text-sm text-white"
                : "max-w-[80%] rounded-lg border bg-white px-3 py-2 text-sm"
            }
            style={m.role === "visitor" ? { background: primary } : undefined}
          >
            {m.content}
          </div>
        ))}
        {typing && <div className="text-xs text-slate-400">Typing…</div>}
      </div>
      <div className="flex gap-2 border-t bg-white p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          className="min-w-0 flex-1 rounded-md border px-3 py-2 text-sm"
          placeholder="Type your message…"
        />
        <Button onClick={send} disabled={typing || !input.trim()} style={{ background: primary }}>
          {c.send}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
        {c.banner}
      </div>

      {theme === "modern" ? (
        <div className="overflow-hidden rounded-xl border bg-white">
          <div className="flex min-h-[500px]">
            <div className="hidden flex-1 items-center justify-center bg-slate-50 p-6 text-center text-xs text-slate-400 md:flex">
              Host website content uses the remaining viewport.
            </div>
            <div className="relative flex w-full min-w-[340px] flex-col border-l md:w-[420px]">
              <div className="absolute bottom-0 left-[-4px] top-0 hidden w-2 cursor-ew-resize md:block">
                <div className="mx-auto h-full w-px bg-slate-300" />
              </div>
              {chat}
            </div>
          </div>
          <div className="border-t px-4 py-2 text-xs text-slate-500">
            Modern · right-side split panel · min 340px · desktop resizable · mobile full-screen
          </div>
        </div>
      ) : (
        <div className="relative min-h-[540px] rounded-xl border bg-slate-50">
          <div className="absolute bottom-16 right-6 flex h-[440px] w-[360px] max-w-[calc(100%-48px)] flex-col overflow-hidden rounded-xl border bg-white shadow-xl">
            {chat}
          </div>
          <div
            className="absolute bottom-4 right-4 flex h-12 w-12 items-center justify-center rounded-full text-white shadow"
            style={{ background: primary }}
          >
            💬
          </div>
        </div>
      )}
    </div>
  );
}
