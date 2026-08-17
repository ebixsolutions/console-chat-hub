import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  History,
  Image,
  Loader2,
  MonitorDot,
  Paperclip,
  Plus,
  Smile,
  UserRound,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import {
  LoadingState,
  PermissionDenied,
} from "@/components/console/PageStates";
import {
  configService,
  type LiveChannelConfigRow,
  type LiveWidgetConfigRow,
  type WidgetLauncherIcon,
} from "@/lib/api/config.service";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute(
  "/_authenticated/console/widget-preview",
)({
  component: WidgetPreviewGuard,
});

type WidgetTheme = "modern" | "classic";
type PreviewMode = "simulation" | "live";
type Lang = "en" | "zh";

const LAUNCHER_ICONS: ReadonlyArray<{
  value: WidgetLauncherIcon;
  symbol: string;
  label: string;
}> = [
  { value: "chat", symbol: "💬", label: "Chat" },
  { value: "headset", symbol: "🎧", label: "Support" },
  { value: "sparkles", symbol: "✨", label: "Sparkles" },
  { value: "bot", symbol: "🤖", label: "AI Bot" },
  { value: "mail", symbol: "✉️", label: "Message" },
];

const PRESET_COLORS = [
  "#6B5CE7",
  "#2563EB",
  "#0F766E",
  "#16A34A",
  "#EA580C",
  "#DC2626",
  "#111827",
] as const;

const PREVIEW_EMOJIS = [
  "😊",
  "😂",
  "🙏",
  "👍",
  "❤️",
  "🎉",
  "😅",
  "😭",
  "🔥",
  "✅",
  "👋",
  "😍",
  "🤔",
  "😢",
  "😎",
  "🙌",
  "💪",
  "😁",
  "🥰",
  "🤩",
] as const;

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
    subtitle:
      "Configure appearance and test the Widget interaction flow. Live AI Test uses the real Singapore Knowledge Base and governed LLM without creating production conversations.",
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
    simulationMode: "UI Simulation",
    liveMode: "Live AI Test",
    simulationBanner:
      "UI Simulation tests Widget appearance, interaction and human-handoff UI only. AI replies are simulated.",
    liveBanner:
      "Live AI Test is active: messages are sent to the real Singapore Knowledge Base and governed Vertex LLM. This isolated test does not create a production visitor session, conversation, customer message or handoff state.",
    embedUnavailable:
      "Embed Code becomes available only after a canonical company and active Website Widget channel are configured.",
    reply:
      "This is a UI Simulation reply, not a measure of live AI / Knowledge Base accuracy.",
    send: "Send",
    launcherHint:
      "The launcher is fixed to the viewport bottom-right and opens Widget 1 as a right-side Assistant bar.",
    liveError: "Live AI Test failed",
    noEvidence:
      "The Knowledge Base returned no authoritative full-content evidence for this query.",
  },
  zh: {
    denied: "您沒有權限查看 Widget 預覽。",
    subtitle:
      "設定 Widget 外觀並測試互動流程。Live AI Test 會使用真實 Singapore Knowledge Base 及受管控 LLM，但不建立正式 production 對話。",
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
    simulationMode: "UI Simulation",
    liveMode: "Live AI Test",
    simulationBanner:
      "UI Simulation 只測試 Widget 外觀、互動及轉真人 UI；AI 回覆為模擬內容。",
    liveBanner:
      "Live AI Test 已啟用：訊息會送往真實 Singapore Knowledge Base 及受管控 Vertex LLM。此隔離測試不會建立正式 visitor session、conversation、customer message 或 handoff state。",
    embedUnavailable:
      "只有在 canonical company 及有效 Website Widget channel 完成設定後才會提供 Embed Code。",
    reply:
      "這是 UI Simulation 回覆，不代表真實 AI／Knowledge Base 準確度。",
    send: "發送",
    launcherHint:
      "Bubble 固定在目前視窗右下角；Widget 1 會像 Assistant sidecar 一樣由右側滑出。",
    liveError: "Live AI Test 失敗",
    noEvidence: "Knowledge Base 沒有回傳可用於事實回答的 full-content 證據。",
  },
} as const;

type LiveAiResponse = {
  success: true;
  mode: "isolated_live_ai_test";
  scope_mode: "canonical" | "pre_activation";
  grounded: boolean;
  answer: string;
  model?: string;
  full_content_evidence_count: number;
  references?: Array<{
    label?: string;
    source_type?: string;
    chunk_type?: string;
    score?: number;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
    attempts: number;
  };
};

type LiveAiFailure = {
  success?: false;
  error?: string;
  detail?: string;
};

function launcherSymbol(icon: WidgetLauncherIcon): string {
  return LAUNCHER_ICONS.find((item) => item.value === icon)?.symbol ?? "💬";
}

function normalizeColor(value: string | null | undefined): string {
  return /^#[0-9A-Fa-f]{6}$/.test(value ?? "")
    ? String(value)
    : "#6B5CE7";
}

function safeLiveError(
  error: unknown,
  payload: LiveAiFailure | null,
): string {
  if (payload?.detail) return payload.detail;
  if (payload?.error) return payload.error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    return String((error as { message: string }).message);
  }
  return "live_ai_test_failed";
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

function WidgetPreviewContent({
  role,
}: {
  role: "admin" | "supervisor";
}) {
  const lang = useConsoleLang() as Lang;
  const c = COPY[lang];
  const [channels, setChannels] = useState<LiveChannelConfigRow[] | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState("");
  const [widget, setWidget] =
    useState<LiveWidgetConfigRow>(PREVIEW_DEFAULT);
  const [theme, setTheme] = useState<WidgetTheme>("modern");
  const [previewMode, setPreviewMode] = useState<PreviewMode>("live");
  const [primary, setPrimary] = useState("#6B5CE7");
  const [launcherIcon, setLauncherIcon] =
    useState<WidgetLauncherIcon>("chat");
  const [liveError, setLiveError] = useState<string | null>(null);
  const [loadingWidget, setLoadingWidget] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(true);

  useEffect(() => {
    let active = true;
    void configService
      .listChannelConfigs()
      .then((result) => {
        if (!active) return;
        if (!result.ok || !result.data) {
          setLiveError(result.error ?? "channel_load_failed");
          setChannels([]);
          setSelectedId("");
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
        setLiveError(null);
      })
      .catch((e) => {
        if (!active) return;
        setLiveError(
          e instanceof Error ? e.message : "channel_load_failed",
        );
        setChannels([]);
        setSelectedId("");
      });
    return () => {
      active = false;
    };
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

    void configService
      .getWidgetConfig(selectedId)
      .then((result) => {
        if (!active) return;
        if (!result.ok || !result.data) {
          setLiveError(result.error ?? "widget_load_failed");
          setWidget(PREVIEW_DEFAULT);
          setTheme("modern");
          setPrimary("#6B5CE7");
          setLauncherIcon("chat");
          return;
        }

        const next = result.data;
        setWidget(next);
        setTheme(
          next.appearance_theme === "classic" ? "classic" : "modern",
        );
        setPrimary(normalizeColor(next.primary_color));
        setLauncherIcon(next.launcher_icon ?? "chat");
        setLiveError(null);
      })
      .catch((e) => {
        if (!active) return;
        setLiveError(
          e instanceof Error ? e.message : "widget_load_failed",
        );
        setWidget(PREVIEW_DEFAULT);
      })
      .finally(() => {
        if (active) setLoadingWidget(false);
      });

    return () => {
      active = false;
    };
  }, [selectedId]);

  const previewOnly =
    !selectedId || widget.id === PREVIEW_DEFAULT.id;
  const canSaveLive =
    role === "admin" && !previewOnly && !loadingWidget;

  const functionsUrl = import.meta.env
    .VITE_SUPABASE_FUNCTIONS_URL as string | undefined;
  const projectId = import.meta.env
    .VITE_SUPABASE_PROJECT_ID as string | undefined;
  const apiBase =
    functionsUrl ||
    (projectId
      ? `https://${projectId}.supabase.co/functions/v1`
      : "");

  const embedCode = useMemo(() => {
    if (
      !selectedId ||
      !apiBase ||
      typeof window === "undefined"
    ) {
      return "";
    }
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
      setTheme(
        next.appearance_theme === "classic" ? "classic" : "modern",
      );
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

      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-white p-2">
        <button
          type="button"
          onClick={() => setPreviewMode("simulation")}
          className={
            previewMode === "simulation"
              ? "rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white"
              : "rounded-lg px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          }
        >
          {c.simulationMode}
        </button>
        <button
          type="button"
          onClick={() => setPreviewMode("live")}
          className={
            previewMode === "live"
              ? "rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white"
              : "rounded-lg px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          }
        >
          {c.liveMode}
        </button>
        <div className="ml-auto text-[11px] text-muted-foreground">
          {previewMode === "live"
            ? "Real KB + Vertex · isolated"
            : "UI only"}
        </div>
      </div>

      <div
        className={
          previewMode === "live"
            ? "rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800"
            : "rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        }
      >
        {previewMode === "live"
          ? c.liveBanner
          : c.simulationBanner}
        {liveError && (
          <div className="mt-1 text-xs opacity-80">
            Config: {liveError}
          </div>
        )}
      </div>

      {channels.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm font-medium">Channel</span>
          <Select
            value={selectedId}
            onValueChange={setSelectedId}
          >
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

      <div className="rounded-xl border bg-card p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold">{c.style}</div>
            <div className="text-xs text-muted-foreground">
              Widget 1 is the modern default. Widget 2 keeps the
              classic floating popup experience.
            </div>
          </div>
          {role === "admin" && (
            <Button
              size="sm"
              onClick={() => void saveAppearance()}
              disabled={!canSaveLive || saving}
            >
              {saving ? c.saving : c.save}
            </Button>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <ThemeCard
            title={c.modern}
            description="Default · right-side Assistant Panel · desktop resizable · mobile full-screen"
            selected={theme === "modern"}
            badge="Default"
            symbol="▥"
            onClick={() => {
              setTheme("modern");
              setPreviewOpen(true);
            }}
          />
          <ThemeCard
            title={c.classic}
            description="Floating bubble + classic popup chat window"
            selected={theme === "classic"}
            symbol="◩"
            onClick={() => {
              setTheme("classic");
              setPreviewOpen(true);
            }}
          />
        </div>

        <div className="mt-5 border-t pt-4">
          <div className="mb-3 text-sm font-semibold">
            {c.appearance}
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <div className="mb-2 text-xs font-medium">
                {c.color}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Use ${color}`}
                    onClick={() => setPrimary(color)}
                    className={
                      primary.toLowerCase() === color.toLowerCase()
                        ? "h-9 w-9 rounded-full border-4 border-slate-900"
                        : "h-9 w-9 rounded-full border-2 border-white shadow ring-1 ring-slate-200"
                    }
                    style={{ background: color }}
                  />
                ))}
                <label className="ml-1 flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs">
                  <input
                    type="color"
                    value={primary}
                    onChange={(e) =>
                      setPrimary(e.target.value.toUpperCase())
                    }
                    className="h-7 w-8 cursor-pointer border-0 bg-transparent p-0"
                  />
                  {primary}
                </label>
              </div>
            </div>

            <div>
              <div className="mb-2 text-xs font-medium">
                {c.icon}
              </div>
              <div className="flex flex-wrap gap-2">
                {LAUNCHER_ICONS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    onClick={() => setLauncherIcon(item.value)}
                    className={
                      launcherIcon === item.value
                        ? "flex min-w-20 items-center gap-2 rounded-lg border border-violet-500 bg-violet-50 px-3 py-2 text-xs font-medium"
                        : "flex min-w-20 items-center gap-2 rounded-lg border px-3 py-2 text-xs hover:bg-muted/40"
                    }
                  >
                    <span className="text-lg" aria-hidden="true">
                      {item.symbol}
                    </span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3 rounded-lg bg-muted/40 p-3">
            <MonitorDot className="h-5 w-5 text-muted-foreground" />
            <div className="text-xs text-muted-foreground">
              {c.launcherHint}
            </div>
          </div>

          {!canSaveLive && (
            <div className="mt-3 text-xs text-muted-foreground">
              {role === "supervisor"
                ? "Supervisor preview is read-only."
                : "Live appearance save requires canonical company activation and an owned Website Widget channel."}
            </div>
          )}
          {saved && (
            <div className="mt-3 text-xs text-emerald-700">
              {c.saved}
            </div>
          )}
        </div>
      </div>

      <Tabs defaultValue="preview">
        <TabsList>
          <TabsTrigger value="preview">{c.preview}</TabsTrigger>
          <TabsTrigger value="embed">{c.embed}</TabsTrigger>
        </TabsList>
        <TabsContent value="preview">
          {loadingWidget && selectedId ? (
            <LoadingState />
          ) : (
            <PreviewWidget
              lang={lang}
              mode={previewMode}
              theme={theme}
              primary={primary}
              title={widget.header_title || "Customer Support"}
              launcherIcon={launcherIcon}
              placeholder={
                widget.placeholder_text || "Type a message…"
              }
              open={previewOpen}
              onOpenChange={setPreviewOpen}
            />
          )}
        </TabsContent>

        <TabsContent value="embed" className="space-y-3">
          {!embedCode ? (
            <div className="rounded-lg border bg-card p-6 text-muted-foreground">
              {c.embedUnavailable}
            </div>
          ) : (
            <>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
                One embed code supports Widget 1 / Widget 2.
                Saved appearance is loaded from guarded public Widget
                config.
              </div>
              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-2">
                  <span className="text-sm font-medium">
                    Paste before &lt;/body&gt;
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={copyCode}
                  >
                    {copied ? (
                      <Check className="h-4 w-4" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                <pre className="overflow-x-auto p-4 text-xs">
                  {embedCode}
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
  badge,
  symbol,
  onClick,
}: {
  title: string;
  description: string;
  selected: boolean;
  badge?: string;
  symbol: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-xl border p-4 text-left",
        selected
          ? "border-violet-500 bg-violet-50"
          : "border-border bg-background hover:bg-muted/40",
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
      <div className="text-xs leading-5 text-muted-foreground">
        {description}
      </div>
      <div className="mt-2 text-xs font-medium">
        {selected ? "● Selected" : "○ Select"}
      </div>
    </button>
  );
}

type PreviewMessage = {
  id: string;
  role: "visitor" | "assistant";
  content: string;
  meta?: string;
  isError?: boolean;
};

function PreviewWidget({
  lang,
  mode,
  theme,
  primary,
  title,
  launcherIcon,
  placeholder,
  open,
  onOpenChange,
}: {
  lang: Lang;
  mode: PreviewMode;
  theme: WidgetTheme;
  primary: string;
  title: string;
  launcherIcon: WidgetLauncherIcon;
  placeholder: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const c = COPY[lang];
  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<PreviewMessage[][]>([]);
  const actionAreaRef = useRef<HTMLDivElement | null>(null);
  const [humanState, setHumanState] = useState<
    "none" | "waiting" | "assigned"
  >("none");
  const simulationTimer =
    useRef<ReturnType<typeof setTimeout> | null>(null);
  const handoffTimer =
    useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (simulationTimer.current) {
        clearTimeout(simulationTimer.current);
      }
      if (handoffTimer.current) {
        clearTimeout(handoffTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    setMessages([]);
    setInput("");
    setTyping(false);
    setHumanState("none");
    setHistoryOpen(false);
    setMenuOpen(false);
    setEmojiOpen(false);
    if (simulationTimer.current) {
      clearTimeout(simulationTimer.current);
      simulationTimer.current = null;
    }
    if (handoffTimer.current) {
      clearTimeout(handoffTimer.current);
      handoffTimer.current = null;
    }
  }, [mode]);

  useEffect(() => {
    const closeOutside = (event: MouseEvent | PointerEvent) => {
      const node = event.target;
      if (
        node instanceof Node &&
        actionAreaRef.current?.contains(node)
      ) {
        return;
      }
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

  const requestHumanSimulation = () => {
    if (mode !== "simulation" || humanState !== "none") return;

    setHumanState("waiting");
    setMessages((value) => [
      ...value,
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

  const appendLiveFailure = (
    text: string,
    detail: string,
  ) => {
    setMessages((value) => [
      ...value,
      {
        id: `live-error-${Date.now()}`,
        role: "assistant",
        content: `${c.liveError}: ${detail}`,
        meta: text,
        isError: true,
      },
    ]);
  };

  const runLiveAi = async (text: string) => {
    setTyping(true);

    try {
      const { data, error } = await supabase.functions.invoke(
        "widget-live-ai-test",
        {
          body: { query: text },
        },
      );

      const payload =
        (data ?? null) as LiveAiResponse | LiveAiFailure | null;

      if (
        error ||
        !payload ||
        payload.success !== true
      ) {
        appendLiveFailure(
          text,
          safeLiveError(
            error,
            payload as LiveAiFailure | null,
          ),
        );
        return;
      }

      const result = payload as LiveAiResponse;
      const answer =
        typeof result.answer === "string" &&
        result.answer.trim()
          ? result.answer.trim()
          : result.grounded
            ? c.noEvidence
            : c.noEvidence;

      const meta = [
        result.scope_mode === "canonical"
          ? "canonical tenant"
          : "pre-activation tenant",
        result.model || null,
        `${result.full_content_evidence_count} full-content evidence`,
        result.usage
          ? `${result.usage.latency_ms} ms`
          : null,
      ]
        .filter(Boolean)
        .join(" · ");

      setMessages((value) => [
        ...value,
        {
          id: `live-ai-${Date.now()}`,
          role: "assistant",
          content: answer,
          meta,
        },
      ]);
    } catch (error) {
      appendLiveFailure(
        text,
        safeLiveError(error, null),
      );
    } finally {
      setTyping(false);
    }
  };

  const runSimulation = (text: string) => {
    if (/(human|agent|真人|人工|客服)/i.test(text)) {
      requestHumanSimulation();
      return;
    }

    setTyping(true);
    simulationTimer.current = setTimeout(() => {
      setMessages((value) => [
        ...value,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: c.reply,
          meta: "UI Simulation",
        },
      ]);
      setTyping(false);
      simulationTimer.current = null;
    }, 650);
  };

  const send = () => {
    if (typing || !input.trim()) return;

    const text = input.trim();
    setMessages((value) => [
      ...value,
      {
        id: `v-${Date.now()}`,
        role: "visitor",
        content: text,
      },
    ]);
    setInput("");

    if (mode === "live") {
      void runLiveAi(text);
      return;
    }

    runSimulation(text);
  };

  const startNewConversation = () => {
    if (messages.length > 0) {
      setHistory((value) =>
        [messages, ...value].slice(0, 10),
      );
    }
    setMessages([]);
    setInput("");
    setTyping(false);
    setHumanState("none");
    setHistoryOpen(false);
    setMenuOpen(false);
    setEmojiOpen(false);
  };

  const chat = (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div
        className={
          theme === "classic"
            ? "flex items-center justify-between px-4 py-3 text-sm font-semibold text-white"
            : "flex min-h-14 items-center justify-between border-b bg-white px-4 py-3 text-sm font-semibold"
        }
        style={
          theme === "classic"
            ? { background: primary }
            : undefined
        }
      >
        <div className="min-w-0">
          <div>{title}</div>
          <div
            className={
              theme === "classic"
                ? "text-[10px] font-normal opacity-80"
                : "text-[10px] font-normal text-muted-foreground"
            }
          >
            {mode === "live"
              ? "Live AI Test · Real KB + Vertex"
              : "UI Simulation"}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              setHistoryOpen((value) => !value)
            }
            className="rounded p-2 opacity-70 hover:bg-black/5 hover:opacity-100"
            aria-label="Conversation History"
            title="Conversation History"
          >
            <History className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={startNewConversation}
            className="rounded p-2 opacity-70 hover:bg-black/5 hover:opacity-100"
            aria-label="New Conversation"
            title={
              mode === "live"
                ? "Clear isolated Live AI Test chat"
                : "Start new simulated conversation"
            }
          >
            +
          </button>
        </div>

        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="rounded px-2 py-1 text-lg opacity-60 hover:opacity-100"
          aria-label="Close widget preview"
        >
          ×
        </button>
      </div>

      {mode === "simulation" && humanState !== "none" && (
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
            {mode === "live"
              ? lang === "zh"
                ? "輸入真實客戶問題。Live AI Test 會使用 Singapore Knowledge Base + Vertex 產生 grounded answer，但不寫入正式對話。"
                : "Ask a real customer question. Live AI Test uses Singapore Knowledge Base + Vertex for a grounded answer without writing a production conversation."
              : lang === "zh"
                ? "輸入訊息測試 Widget UI；輸入「真人客服」可測試 handoff UI。"
                : "Type a message to test Widget UI. Type “human agent” to test handoff UI."}
          </div>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={
              message.role === "visitor"
                ? "ml-auto max-w-[82%] rounded-2xl rounded-br-md px-3 py-2 text-sm text-white"
                : message.isError
                  ? "max-w-[82%] rounded-2xl rounded-bl-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
                  : "max-w-[82%] rounded-2xl rounded-bl-md border bg-slate-50 px-3 py-2 text-sm"
            }
            style={
              message.role === "visitor"
                ? { background: primary }
                : undefined
            }
          >
            <div className="whitespace-pre-wrap">
              {message.content}
            </div>
            {message.meta && (
              <div
                className={
                  message.isError
                    ? "mt-1 text-[10px] text-red-600"
                    : "mt-1 text-[10px] text-slate-400"
                }
              >
                {message.meta}
              </div>
            )}
          </div>
        ))}

        {typing && (
          <div className="flex max-w-[82%] items-center gap-2 rounded-2xl rounded-bl-md border bg-slate-50 px-3 py-2 text-xs text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {mode === "live"
              ? "Searching Knowledge Base and generating answer…"
              : "Typing…"}
          </div>
        )}
      </div>

      <div className="border-t bg-white p-3">
        {historyOpen && (
          <div className="mb-2 rounded-xl border bg-slate-50 p-2">
            <div className="mb-2 text-xs font-semibold">
              Conversation History
            </div>
            {history.length === 0 ? (
              <div className="text-xs text-slate-400">
                No preview history yet.
              </div>
            ) : (
              history.map((session, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => {
                    setMessages(session);
                    setHistoryOpen(false);
                  }}
                  className="mb-1 block w-full rounded-lg border bg-white px-3 py-2 text-left text-xs"
                >
                  Conversation {history.length - index} ·{" "}
                  {session.length} messages
                </button>
              ))
            )}
          </div>
        )}

        {mode === "live" && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-[10px] leading-4 text-emerald-800">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Isolated Live AI Test: real KB + Vertex; no
            production conversation or handoff write.
          </div>
        )}

        <div
          ref={actionAreaRef}
          className="relative flex gap-2 rounded-xl border bg-white p-1"
        >
          <button
            type="button"
            onClick={() => {
              setEmojiOpen(false);
              setMenuOpen((value) => !value);
            }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-white"
            aria-label="More actions"
            title="More actions"
          >
            <Plus className="h-4 w-4" />
          </button>

          <button
            type="button"
            onClick={() => {
              setMenuOpen(false);
              setEmojiOpen((value) => !value);
            }}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white"
            aria-label="Emoji"
            title="Emoji"
          >
            <Smile className="h-4 w-4" />
          </button>

          {menuOpen && (
            <div className="absolute bottom-12 left-0 z-20 w-56 rounded-xl border bg-white p-1 shadow-xl">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setMessages((value) => [
                    ...value,
                    {
                      id: `image-${Date.now()}`,
                      role: "visitor",
                      content:
                        mode === "live"
                          ? "[Image upload is not sent in isolated Live AI Test]"
                          : "[Image upload simulated in Preview]",
                    },
                  ]);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <Image className="h-4 w-4" />
                Image
              </button>

              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setMessages((value) => [
                    ...value,
                    {
                      id: `video-${Date.now()}`,
                      role: "visitor",
                      content:
                        mode === "live"
                          ? "[Video upload is not sent in isolated Live AI Test]"
                          : "[Video upload simulated in Preview]",
                    },
                  ]);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <Video className="h-4 w-4" />
                Video
              </button>

              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setMessages((value) => [
                    ...value,
                    {
                      id: `file-${Date.now()}`,
                      role: "visitor",
                      content:
                        mode === "live"
                          ? "[File upload is not sent in isolated Live AI Test]"
                          : "[File upload simulated in Preview]",
                    },
                  ]);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50"
              >
                <Paperclip className="h-4 w-4" />
                File
              </button>

              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  if (mode === "simulation") {
                    requestHumanSimulation();
                  } else {
                    setMessages((value) => [
                      ...value,
                      {
                        id: `handoff-live-note-${Date.now()}`,
                        role: "assistant",
                        content:
                          lang === "zh"
                            ? "Live AI Test 為隔離測試，不會建立正式轉真人狀態。"
                            : "Live AI Test is isolated and does not create production handoff state.",
                        meta: "No production write",
                      },
                    ]);
                  }
                }}
                disabled={
                  mode === "simulation" &&
                  humanState !== "none"
                }
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-50"
              >
                <UserRound className="h-4 w-4" />
                Request Human Support
              </button>
            </div>
          )}

          {emojiOpen && (
            <div className="absolute bottom-12 left-10 z-20 grid w-64 grid-cols-8 gap-1 rounded-xl border bg-white p-2 shadow-xl">
              {PREVIEW_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    setInput((value) => `${value}${emoji}`);
                    setEmojiOpen(false);
                  }}
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
            onChange={(e) =>
              setInput(e.target.value.slice(0, 500))
            }
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
            disabled={
              typing ||
              !input.trim() ||
              (mode === "simulation" &&
                humanState === "assigned")
            }
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
      <div
        className={
          mode === "live"
            ? "rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800"
            : "rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800"
        }
      >
        {mode === "live"
          ? c.liveBanner
          : c.simulationBanner}
      </div>

      {!open && (
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className="fixed bottom-[max(24px,env(safe-area-inset-bottom))] right-6 z-[80] flex h-14 w-14 items-center justify-center rounded-full text-2xl text-white shadow-xl transition-transform hover:scale-105"
          style={{ background: primary }}
          aria-label="Open widget preview"
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
            open
              ? "translate-x-0"
              : "translate-x-full pointer-events-none",
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
