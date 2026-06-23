import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { configService } from "@/lib/api/config.service";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, PermissionDenied, PageHeader } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/channel-settings")({
  component: ChannelSettingsPage,
});

function ChannelSettingsPage() {
  const { role, loading } = useCurrentRole();
  if (loading) return <LoadingState />;
  if (!role) return <PermissionDenied />;

  const readonly = role === "agent";

  const handleChannelSave = async () => {
    const res = await configService.updateChannelConfig({});
    if ("deferred" in res && res.deferred) {
      toast.message("Channel config save available after L7B.");
    }
  };

  const handleWidgetSave = async () => {
    const res = await configService.updateWidgetConfig({});
    if ("deferred" in res && res.deferred) {
      toast.message("Widget config save available after L7B.");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Channel Settings"
        description="Manage messaging channels."
        badge={readonly ? <Badge variant="secondary">View Only</Badge> : undefined}
      />

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Website Widget</CardTitle>
              <CardDescription>Live chat widget on your website.</CardDescription>
            </div>
            <Switch disabled={readonly} onCheckedChange={handleChannelSave} />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Allowed origins</Label>
            <Input placeholder="https://example.com" disabled={readonly} onBlur={handleChannelSave} />
          </div>

          <Tabs defaultValue="settings">
            <TabsList>
              <TabsTrigger value="settings">Settings</TabsTrigger>
              <TabsTrigger value="agent">AI Agent</TabsTrigger>
              <TabsTrigger value="embed">Embed Code</TabsTrigger>
              <TabsTrigger value="guides">Platform Guides</TabsTrigger>
            </TabsList>
            <TabsContent value="settings" className="space-y-3 pt-3">
              <div className="space-y-2">
                <Label>Header title</Label>
                <Input placeholder="Support" disabled={readonly} />
              </div>
              <div className="space-y-2">
                <Label>Welcome message</Label>
                <Input placeholder="How can we help?" disabled={readonly} />
              </div>
              <div className="space-y-2">
                <Label>Primary color</Label>
                <Input placeholder="#000000" disabled={readonly} />
              </div>
              <Button size="sm" disabled={readonly} onClick={handleWidgetSave}>Save</Button>
            </TabsContent>
            <TabsContent value="agent" className="pt-3 text-sm text-muted-foreground">
              AI Agent configuration placeholder.
            </TabsContent>
            <TabsContent value="embed" className="pt-3">
              <pre className="rounded-md bg-muted p-3 text-xs overflow-x-auto">
{`<script src="https://example.com/widget/chat.js" data-embed-key="••••••"></script>`}
              </pre>
            </TabsContent>
            <TabsContent value="guides" className="pt-3 text-sm text-muted-foreground">
              Platform integration guides placeholder.
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {(["WhatsApp", "LINE", "Email"] as const).map((c) => (
        <Card key={c} className="opacity-75">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>{c}</CardTitle>
                <CardDescription>Multi-channel messaging.</CardDescription>
              </div>
              <Badge>Coming soon — Phase 3</Badge>
            </div>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}
