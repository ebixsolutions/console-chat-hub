import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import { configService, type LiveChannelConfigRow } from "@/lib/api/config.service";

export const Route = createFileRoute("/_authenticated/console/widget-preview")({
  component: WidgetPreviewGuard,
});

const COPY = {
  en: {
    denied: "You do not have permission to view widget preview.",
    subtitle: "Simulated widget preview for layout and style testing. Does not reflect production settings.",
    noChannels: "No active Website Widget channel is available for your company.",
    preview: "Simulated Preview",
    embed: "Embed Code",
    banner: "This preview is simulated. Messages are not sent to production.",
    reply: "This is a simulated reply. Production replies use the live AI pipeline.",
    send: "Send",
  },
  zh: {
    denied: "您沒有權限查看 Widget 預覽。",
    subtitle: "模擬 Widget 預覽，僅供版面及樣式測試，不反映正式環境設定。",
    noChannels: "您的公司目前沒有可用的 Website Widget channel。",
    preview: "模擬預覽",
    embed: "嵌入代碼",
    banner: "這是模擬預覽，訊息不會傳送至正式環境。",
    reply: "這是模擬回覆；正式回覆會使用實際 AI pipeline。",
    send: "發送",
  },
} as const;

function WidgetPreviewGuard() {
  const { role, loading } = useCurrentRole();
  const lang = useConsoleLang();
  if (loading) return <LoadingState />;
  if (role !== "admin" && role !== "supervisor") {
    return <PermissionDenied message={COPY[lang].denied} />;
  }
  return <WidgetPreviewContent />;
}

function WidgetPreviewContent() {
  const lang = useConsoleLang();
  const c = COPY[lang];
  const [channels, setChannels] = useState<LiveChannelConfigRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const result = await configService.listChannelConfigs();
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
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : "channel_load_failed");
          setChannels([]);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const functionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL as
    | string
    | undefined;
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID as string | undefined;
  const apiBase =
    functionsUrl ||
    (projectId ? `https://${projectId}.supabase.co/functions/v1` : "");

  const embedCode = useMemo(() => {
    if (!selectedId || !apiBase) return "";
    const scriptSrc = `${window.location.origin}/widget/chat.js`;
    return `<script src="${scriptSrc}" data-channel-id="${selectedId}" data-api-base="${apiBase}" defer></script>`;
  }, [selectedId, apiBase]);

  const copyCode = async () => {
    if (!embedCode) return;
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

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Widget channel data unavailable: {error}
        </div>
      )}

      {channels.length > 0 && (
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Channel</span>
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="w-[320px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {channels.map((row) => (
                <SelectItem key={row.id} value={row.id}>{row.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <Tabs defaultValue="preview">
        <TabsList>
          <TabsTrigger value="preview">{c.preview}</TabsTrigger>
          <TabsTrigger value="embed">{c.embed}</TabsTrigger>
        </TabsList>
        <TabsContent value="preview">
          <SimulatedWidget lang={lang} />
        </TabsContent>
        <TabsContent value="embed" className="space-y-3">
          {channels.length === 0 ? (
            <div className="rounded-lg border bg-card p-6 text-muted-foreground">{c.noChannels}</div>
          ) : (
            <div className="rounded-lg border bg-card">
              <div className="flex items-center justify-between border-b px-4 py-2">
                <span className="text-sm font-medium">Paste before &lt;/body&gt;</span>
                <Button size="sm" variant="ghost" onClick={copyCode} disabled={!embedCode}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <pre className="overflow-x-auto p-4 text-xs">{embedCode || "Runtime functions URL is not configured."}</pre>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

type SimMsg = { id: string; role: "visitor" | "assistant"; content: string };

function SimulatedWidget({ lang }: { lang: "en" | "zh" }) {
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

  return (
    <div className="mx-auto max-w-[390px] space-y-3">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">{c.banner}</div>
      <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
        <div className="bg-slate-900 px-4 py-3 text-sm font-semibold text-white">Customer Support · Simulated</div>
        <div className="min-h-[320px] space-y-2 bg-slate-50 p-4">
          {messages.length === 0 && (
            <div className="py-16 text-center text-xs text-slate-400">Send a message to start simulated chat</div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={
                m.role === "visitor"
                  ? "ml-auto max-w-[80%] rounded-lg bg-slate-900 px-3 py-2 text-sm text-white"
                  : "max-w-[80%] rounded-lg border bg-white px-3 py-2 text-sm"
              }
            >
              {m.content}
            </div>
          ))}
          {typing && <div className="text-xs text-slate-400">Typing…</div>}
        </div>
        <div className="flex gap-2 border-t p-3">
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
          <Button onClick={send} disabled={typing || !input.trim()}>{c.send}</Button>
        </div>
      </div>
    </div>
  );
}
