// ===========================================================================
// DEV22-I2A: Widget Preview — Immediate Containment Patch v1.1
//
// File: src/routes/_authenticated/console.widget-preview.tsx
// Action: FULL FILE REPLACEMENT
//
// Changes:
//   1. useCurrentRole() production guard: admin + supervisor only
//   2. Live Preview iframe DISABLED — iframe element never mounts
//   3. Bilingual safety warning explaining why preview is disabled
//   4. Embed Code tab + channel selector preserved (read-only)
//   5. Agent / Roleless → PermissionDenied
//   6. Zero EF / schema / chat.js changes
//
// Production WRITE containment:
//   create-visitor-session = unreachable (no iframe, no chat.js load)
//   receive-widget-message = unreachable
//   widget-poll-messages = unreachable
//   iframe document request = 0
//
// Option A scope limitation:
//   This patch restricts UI access only.
//   The widget EFs remain public (by design for external embed).
//   External websites can still embed the widget and create sessions.
//   This patch prevents Console operators from accidentally creating
//   production data via the Preview tab.
// ===========================================================================

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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

type I2CopyBlock = {
  permissionDenied: string;
  previewDisabledTitle: string;
  previewDisabledBody: string;
  previewDisabledNote: string;
};

const I2_COPY: Record<"en" | "zh", I2CopyBlock> = {
  en: {
    permissionDenied: "You do not have permission to view widget preview.",
    previewDisabledTitle: "Live Preview temporarily disabled",
    previewDisabledBody:
      "Live Preview is temporarily disabled because the current widget connects to production conversations and messages. Each preview interaction would create real visitor sessions, conversations, and AI replies in the production database.",
    previewDisabledNote:
      "The Embed Code tab remains available for authorized production installation only. Do not use it for preview or testing, because widget interactions will create real production records. A separately isolated sandbox environment is required for safe testing.",
  },
  zh: {
    permissionDenied: "您沒有權限查看 Widget 預覽。",
    previewDisabledTitle: "即時預覽暫時停用",
    previewDisabledBody:
      "即時預覽暫時停用，因目前 Widget 會連接正式環境的對話及訊息資料。每次預覽互動都會在正式資料庫中建立真實的訪客工作階段、對話及 AI 回覆。",
    previewDisabledNote:
      "「嵌入代碼」分頁只保留供獲授權的正式網站安裝使用。請勿用作預覽或測試，因為 Widget 互動仍會建立真實的正式環境資料。安全測試必須等待獨立隔離的沙盒環境。",
  },
};

// ── Guard component ──

function WidgetPreviewGuard() {
  const { role, loading } = useCurrentRole();
  const lang = useConsoleLang();

  if (loading) {
    return <LoadingState />;
  }

  if (role !== "admin" && role !== "supervisor") {
    return <PermissionDenied message={I2_COPY[lang].permissionDenied} />;
  }

  return <WidgetPreviewContent />;
}

// ── Content component (admin + supervisor only) ──

function WidgetPreviewContent() {
  const lang = useConsoleLang();
  const copy = I2_COPY[lang];

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

  if (channels === null) {
    return <LoadingState />;
  }

  if (channels.length === 0) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Widget Preview</h1>
        <div className="rounded-lg border bg-card p-6 text-muted-foreground">
          {lang === "zh"
            ? "找不到有效的網頁 Widget 渠道。必須先有有效渠道，才能產生安裝代碼。"
            : "No active web widget channels found. An active channel is required to generate installation code."}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Widget Preview</h1>
        <p className="text-muted-foreground">
          {lang === "zh"
            ? "管理獲授權的 Widget 安裝代碼。即時預覽目前已停用。"
            : "Manage authorized widget installation code. Live Preview is disabled."}
        </p>
      </div>

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

      <Tabs defaultValue="embed">
        <TabsList>
          <TabsTrigger value="embed">Embed Code</TabsTrigger>
          <TabsTrigger value="preview">Live Preview</TabsTrigger>
        </TabsList>

        <TabsContent value="embed" className="space-y-3">
          <div className="rounded-lg border bg-card">
            <div className="flex items-center justify-between border-b px-4 py-2">
              <span className="text-sm font-medium">Paste before &lt;/body&gt;</span>
              <Button size="sm" variant="ghost" onClick={handleCopy} className="gap-1">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <pre className="overflow-x-auto p-4 text-xs">{embedCode}</pre>
          </div>
          {!envFunctionsUrl && (
            <p className="text-sm text-amber-600">Set VITE_SUPABASE_FUNCTIONS_URL in environment variables</p>
          )}
        </TabsContent>

        {/* Live Preview — DISABLED (I2-A containment) */}
        <TabsContent value="preview">
          <div className="overflow-hidden rounded-lg border bg-card p-8">
            <div className="mx-auto max-w-lg text-center">
              <div className="mb-4 text-4xl">🔒</div>
              <h3 className="mb-2 text-base font-semibold">{copy.previewDisabledTitle}</h3>
              <p className="mb-4 text-sm text-muted-foreground">{copy.previewDisabledBody}</p>
              <p className="text-xs text-muted-foreground">{copy.previewDisabledNote}</p>
            </div>
          </div>
          {/* iframe intentionally NOT rendered — containment measure */}
        </TabsContent>
      </Tabs>
    </div>
  );
}
