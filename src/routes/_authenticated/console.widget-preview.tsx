// ===========================================================================
// DEV22-I2B1: Widget Preview — Single-File React Simulated Preview v1.1
//
// File: src/routes/_authenticated/console.widget-preview.tsx
// Action: FULL FILE REPLACEMENT (replaces I2-A containment)
//
// Architecture:
//   - Zero new files, zero iframe, zero chat.js, zero Widget EF calls
//   - Zero localStorage reads/writes by simulated widget
//   - All messages stored in React useState only — lost on unmount
//   - Simulated "AI reply" via local setTimeout (1.5s) with canned text
//   - useCurrentRole() guard: admin + supervisor (super_admin removed — AppRole does not include it; see Dev22-M)
//
// Fixes incorporated (v1.0 rejection → v1.1):
//   1. Subtitle: "simulated" wording, no "disabled"
//   2. Preview not blocked by channels.length === 0
//   3. localStorage UAT: delta = 0 method
//   4. setTimeout cleanup: useRef + clearTimeout
//   5. No claim of real widget_config/theme
//   6. handleSend: if (typing) return guard
//
// v1.2 Director additions:
//   7. Tab label: "Simulated Preview" (not "Live Preview")
//   8. Color disclaimer in simulated widget
//   9. Guard role explicitly stated as I2-A continuation
// ===========================================================================

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Copy, Check } from "lucide-react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/widget-preview")({
  component: WidgetPreviewGuard,
});

// ── Bilingual copy ──

type CopyBlock = {
  permissionDenied: string;
  subtitle: string;
  noChannels: string;
  tabEmbed: string;
  tabPreview: string;
  simulatedBanner: string;
  simulatedColorNote: string;
  cannedReply: string;
  sendLabel: string;
  placeholder: string;
  headerTitle: string;
  headerSub: string;
  poweredBy: string;
};

const COPY: Record<"en" | "zh", CopyBlock> = {
  en: {
    permissionDenied: "You do not have permission to view widget preview.",
    subtitle: "Simulated widget preview for layout and style testing. Does not reflect production settings.",
    noChannels:
      "No active web widget channels found. The Embed Code tab requires an active channel, but the Simulated Preview tab works independently.",
    tabEmbed: "Embed Code",
    tabPreview: "Simulated Preview",
    simulatedBanner: "This is a simulated preview. Messages are not sent to any server. No production data is created.",
    simulatedColorNote: "Colors and layout are simulated defaults — they do not reflect your saved widget theme.",
    cannedReply:
      "This is a simulated reply. In production, the AI agent would respond based on your Knowledge Base and prompt configuration.",
    sendLabel: "Send",
    placeholder: "Type a message...",
    headerTitle: "Customer Support",
    headerSub: "Simulated · No live connection",
    poweredBy: "Powered by NexusAI (Simulated)",
  },
  zh: {
    permissionDenied: "您沒有權限查看 Widget 預覽。",
    subtitle: "模擬 Widget 預覽，僅供版面及樣式測試用。不反映正式環境設定。",
    noChannels: "找不到有效的網頁 Widget 渠道。「嵌入代碼」分頁需要有效渠道，但「模擬預覽」分頁可獨立使用。",
    tabEmbed: "嵌入代碼",
    tabPreview: "模擬預覽",
    simulatedBanner: "這是模擬預覽。訊息不會傳送至任何伺服器，不會建立正式環境資料。",
    simulatedColorNote: "顏色及版面為模擬預設值，不反映您已儲存的 Widget 主題。",
    cannedReply: "這是模擬回覆。在正式環境中，AI 客服會根據您的知識庫及提示設定回應。",
    sendLabel: "發送",
    placeholder: "輸入訊息...",
    headerTitle: "客戶服務",
    headerSub: "模擬模式 · 無即時連線",
    poweredBy: "Powered by NexusAI（模擬）",
  },
};

// ── Guard component (role guard carried from I2-A: admin + supervisor only) ──
// This is NOT a new permission decision — it continues the I2-A containment
// guard that restricts Widget Preview to admin/supervisor roles.

function WidgetPreviewGuard() {
  const { role, loading } = useCurrentRole();
  const lang = useConsoleLang();

  if (loading) return <LoadingState />;
  if (role !== "admin" && role !== "supervisor") return <PermissionDenied message={COPY[lang].permissionDenied} />;

  return <WidgetPreviewContent />;
}

// ── Content component ──

function WidgetPreviewContent() {
  const lang = useConsoleLang();
  const copy = COPY[lang];

  const [channels, setChannels] = useState<{ id: string; name: string }[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const envFunctionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL as string | undefined;
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID as string;
  const apiBase = envFunctionsUrl || (projectId ? `https://${projectId}.supabase.co/functions/v1` : "");

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error } = await supabase
        .from("channel_config")
        .select("id, name")
        .eq("is_active", true)
        .eq("channel_type", "web_widget")
        .order("created_at", { ascending: false });
      if (!active) return;
      if (error) {
        setChannels([]);
        return;
      }
      setChannels(data ?? []);
      if (data && data.length > 0) setSelectedId(data[0].id);
    })();
    return () => {
      active = false;
    };
  }, []);

  const embedCode = useMemo(() => {
    if (!selectedId) return "";
    const scriptSrc = `${window.location.origin}/widget/chat.js`;
    return `<script src="${scriptSrc}" data-channel-id="${selectedId}" data-api-base="${apiBase}" defer></script>`;
  }, [selectedId, apiBase]);

  const handleCopy = async () => {
    if (!embedCode) return;
    await navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (channels === null) return <LoadingState />;

  const hasChannels = channels.length > 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Widget Preview</h1>
        <p className="text-muted-foreground">{copy.subtitle}</p>
      </div>

      {hasChannels && (
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">Channel</span>
          <Select value={selectedId} onValueChange={setSelectedId}>
            <SelectTrigger className="w-[320px]">
              <SelectValue placeholder="Pick a channel" />
            </SelectTrigger>
            <SelectContent>
              {channels.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <Tabs defaultValue="preview">
        <TabsList>
          <TabsTrigger value="preview">{copy.tabPreview}</TabsTrigger>
          <TabsTrigger value="embed">{copy.tabEmbed}</TabsTrigger>
        </TabsList>

        {/* ── Simulated Preview Tab ── */}
        <TabsContent value="preview">
          <SimulatedWidget lang={lang} />
        </TabsContent>

        {/* ── Embed Code Tab ── */}
        <TabsContent value="embed" className="space-y-3">
          {!hasChannels ? (
            <div className="rounded-lg border bg-card p-6 text-muted-foreground">{copy.noChannels}</div>
          ) : (
            <>
              <div className="rounded-lg border bg-card">
                <div className="flex items-center justify-between border-b px-4 py-2">
                  <span className="text-sm font-medium">
                    {lang === "zh" ? "貼在 </body> 之前" : "Paste before </body>"}
                  </span>
                  <Button size="sm" variant="ghost" onClick={handleCopy} className="gap-1">
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? (lang === "zh" ? "已複製" : "Copied") : lang === "zh" ? "複製" : "Copy"}
                  </Button>
                </div>
                <pre className="overflow-x-auto p-4 text-xs">{embedCode}</pre>
              </div>
              {!envFunctionsUrl && (
                <p className="text-sm text-amber-600">
                  {lang === "zh"
                    ? "請設定 VITE_SUPABASE_FUNCTIONS_URL 環境變數"
                    : "Set VITE_SUPABASE_FUNCTIONS_URL in environment variables"}
                </p>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Simulated Widget Component (self-contained, zero backend) ──

type SimMsg = { id: string; role: "visitor" | "assistant"; content: string };

function SimulatedWidget({ lang }: { lang: "en" | "zh" }) {
  const copy = COPY[lang];
  const [open, setOpen] = useState(true);
  const [messages, setMessages] = useState<SimMsg[]>([]);
  const [input, setInput] = useState("");
  const [typing, setTyping] = useState(false);
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const msgsEndRef = useRef<HTMLDivElement>(null);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (replyTimerRef.current) clearTimeout(replyTimerRef.current);
    };
  }, []);

  // Auto-scroll on new message
  useEffect(() => {
    msgsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, typing]);

  function handleSend() {
    if (typing) return; // Fix 6: prevent double-submit during simulated reply
    const text = input.trim();
    if (!text) return;

    const visitorMsg: SimMsg = { id: `v-${Date.now()}`, role: "visitor", content: text };
    setMessages((prev) => [...prev, visitorMsg]);
    setInput("");
    setTyping(true);

    // Clear any existing timer before scheduling new one (Fix 4)
    if (replyTimerRef.current) clearTimeout(replyTimerRef.current);
    replyTimerRef.current = setTimeout(() => {
      const aiMsg: SimMsg = { id: `a-${Date.now()}`, role: "assistant", content: copy.cannedReply };
      setMessages((prev) => [...prev, aiMsg]);
      setTyping(false);
      replyTimerRef.current = null;
    }, 1500);
  }

  const PRIMARY = "#6B5CE7"; // Simulated default — NOT from DB

  return (
    <div className="space-y-3">
      {/* Simulated banner */}
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
        <p className="font-medium">{copy.simulatedBanner}</p>
        <p className="mt-1 text-xs text-amber-600">{copy.simulatedColorNote}</p>
      </div>

      {/* Widget mock container */}
      <div className="mx-auto" style={{ maxWidth: 380 }}>
        {!open ? (
          <div className="flex justify-end">
            <button
              onClick={() => setOpen(true)}
              style={{
                background: PRIMARY,
                width: 56,
                height: 56,
                borderRadius: 9999,
                border: "none",
                color: "#fff",
                fontSize: 26,
                cursor: "pointer",
                boxShadow: "0 10px 25px rgba(0,0,0,.25)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              💬
            </button>
          </div>
        ) : (
          <div
            style={{
              borderRadius: 14,
              overflow: "hidden",
              boxShadow: "0 20px 50px rgba(0,0,0,.15)",
              border: "1px solid #e5e7eb",
              display: "flex",
              flexDirection: "column",
              height: 480,
              background: "#fff",
            }}
          >
            {/* Header */}
            <div
              style={{
                padding: "10px 14px",
                background: PRIMARY,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexShrink: 0,
              }}
            >
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{copy.headerTitle}</div>
                <div style={{ fontSize: 11, opacity: 0.85 }}>{copy.headerSub}</div>
              </div>
              <button
                onClick={() => setOpen(false)}
                style={{
                  background: "rgba(255,255,255,.2)",
                  border: "none",
                  color: "#fff",
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                ×
              </button>
            </div>

            {/* Messages area */}
            <div
              style={{
                flex: 1,
                overflowY: "auto",
                padding: 14,
                background: "#f7f8fa",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {messages.length === 0 && (
                <div style={{ textAlign: "center", color: "#9ca3af", fontSize: 13, padding: "40px 20px" }}>
                  {lang === "zh" ? "發送訊息開始模擬對話" : "Send a message to start simulated chat"}
                </div>
              )}
              {messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    maxWidth: "80%",
                    padding: "8px 12px",
                    borderRadius: 12,
                    fontSize: 14,
                    lineHeight: 1.4,
                    whiteSpace: "pre-wrap",
                    wordWrap: "break-word",
                    alignSelf: m.role === "visitor" ? "flex-end" : "flex-start",
                    background: m.role === "visitor" ? PRIMARY : "#fff",
                    color: m.role === "visitor" ? "#fff" : "#111",
                    border: m.role === "assistant" ? "1px solid #e5e7eb" : "none",
                    borderBottomRightRadius: m.role === "visitor" ? 4 : 12,
                    borderBottomLeftRadius: m.role === "assistant" ? 4 : 12,
                  }}
                >
                  {m.content}
                </div>
              ))}
              {typing && (
                <div
                  style={{
                    alignSelf: "flex-start",
                    background: "#fff",
                    border: "1px solid #e5e7eb",
                    padding: "10px 14px",
                    borderRadius: 12,
                    display: "flex",
                    gap: 4,
                  }}
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      background: "#9ca3af",
                      borderRadius: 9999,
                      animation: "nxBounce 1.2s infinite ease-in-out",
                    }}
                  />
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      background: "#9ca3af",
                      borderRadius: 9999,
                      animation: "nxBounce 1.2s infinite ease-in-out",
                      animationDelay: "0.15s",
                    }}
                  />
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      background: "#9ca3af",
                      borderRadius: 9999,
                      animation: "nxBounce 1.2s infinite ease-in-out",
                      animationDelay: "0.3s",
                    }}
                  />
                </div>
              )}
              <div ref={msgsEndRef} />
            </div>

            {/* Input area */}
            <div
              style={{
                borderTop: "1px solid #e5e7eb",
                padding: "8px 10px",
                display: "flex",
                gap: 6,
                alignItems: "flex-end",
                background: "#fff",
                flexShrink: 0,
              }}
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={copy.placeholder}
                rows={1}
                style={{
                  flex: 1,
                  resize: "none",
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: "7px 10px",
                  fontSize: 14,
                  outline: "none",
                  height: 36,
                  maxHeight: 120,
                  fontFamily: "inherit",
                  overflowY: "auto",
                }}
              />
              <button
                onClick={handleSend}
                disabled={typing || !input.trim()}
                style={{
                  border: "none",
                  color: "#fff",
                  padding: "0 14px",
                  borderRadius: 8,
                  cursor: typing || !input.trim() ? "not-allowed" : "pointer",
                  fontWeight: 600,
                  fontSize: 14,
                  height: 36,
                  minWidth: 56,
                  background: typing || !input.trim() ? "#d1d5db" : PRIMARY,
                  opacity: typing || !input.trim() ? 0.5 : 1,
                }}
              >
                {copy.sendLabel}
              </button>
            </div>

            {/* Footer */}
            <div
              style={{
                textAlign: "center",
                padding: 5,
                fontSize: 11,
                color: "#d1d5db",
                background: "#fff",
                borderTop: "1px solid #f3f4f6",
              }}
            >
              {copy.poweredBy}
            </div>
          </div>
        )}
      </div>

      {/* Typing animation keyframes */}
      <style>{`
        @keyframes nxBounce {
          0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
          40% { transform: translateY(-4px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
