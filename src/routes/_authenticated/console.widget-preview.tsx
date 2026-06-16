import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Copy, Check } from "lucide-react";

export const Route = createFileRoute("/_authenticated/console/widget-preview")({
  component: WidgetPreview,
});

type Channel = { id: string; name: string };

function WidgetPreview() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const envFunctionsUrl = import.meta.env.VITE_SUPABASE_FUNCTIONS_URL as string | undefined;
  const projectId = import.meta.env.VITE_SUPABASE_PROJECT_ID as string;
  const apiBase =
    envFunctionsUrl ||
    (projectId ? `https://${projectId}.supabase.co/functions/v1` : "");

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

  const previewSrc = useMemo(() => {
    if (!selectedId) return "";
    return `/widget-sandbox.html?channel_id=${encodeURIComponent(selectedId)}&api_base=${encodeURIComponent(apiBase)}`;
  }, [selectedId, apiBase]);

  const copy = async () => {
    if (!embedCode) return;
    await navigator.clipboard.writeText(embedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (channels === null) {
    return <div className="text-muted-foreground">Loading channels…</div>;
  }

  if (channels.length === 0) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Widget Preview</h1>
        <div className="rounded-lg border bg-card p-6 text-muted-foreground">
          No active channels found. Create an active <code>web_widget</code> channel to preview.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Widget Preview</h1>
        <p className="text-muted-foreground">Embed and test your chat widget on any site.</p>
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
              <Button size="sm" variant="ghost" onClick={copy} className="gap-1">
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <pre className="overflow-x-auto p-4 text-xs">{embedCode}</pre>
          </div>
          {!apiBase && (
            <p className="text-sm text-destructive">
              VITE_SUPABASE_FUNCTIONS_URL is not set and could not be derived.
            </p>
          )}
        </TabsContent>

        <TabsContent value="preview">
          <div className="overflow-hidden rounded-lg border bg-card">
            {previewSrc && (
              <iframe
                key={previewSrc}
                src={previewSrc}
                title="Widget sandbox"
                className="h-[70vh] w-full"
              />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
