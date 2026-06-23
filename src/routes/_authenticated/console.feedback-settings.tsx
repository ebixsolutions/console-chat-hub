import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { configService } from "@/lib/api/config.service";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, EmptyState, PermissionDenied, PageHeader } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/feedback-settings")({
  component: FeedbackSettingsPage,
});

function FeedbackSettingsPage() {
  const { role, loading } = useCurrentRole();
  const [days, setDays] = useState(1);

  if (loading) return <LoadingState />;
  if (!role) return <PermissionDenied />;

  const readonly = role === "agent";

  const handleSave = async () => {
    const res = await configService.updateFeedbackConfig({ delay_minutes: days * 24 * 60 });
    if ("deferred" in res && res.deferred) {
      toast.message("Feedback config save available after L7B.");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feedback Settings"
        description="Automate post-conversation feedback requests."
        badge={readonly ? <Badge variant="secondary">View Only</Badge> : undefined}
      />

      <Card>
        <CardHeader>
          <CardTitle>Feedback automation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Active</Label>
            <Switch disabled={readonly} />
          </div>
          <div className="space-y-2">
            <Label>Delay (days)</Label>
            <Input
              type="number"
              min={1}
              max={30}
              value={days}
              disabled={readonly}
              onChange={(e) => setDays(Math.min(30, Math.max(1, Number(e.target.value) || 1)))}
            />
          </div>
          <div className="space-y-2">
            <Label>Trigger event</Label>
            <div className="text-sm text-muted-foreground">conversation_resolved (display only)</div>
          </div>
          <div className="space-y-2">
            <Label>Config (JSON)</Label>
            <Input placeholder='{"channel":"email"}' disabled={readonly} />
          </div>
          <Button size="sm" disabled={readonly} onClick={handleSave}>Save</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Feedback results</CardTitle></CardHeader>
        <CardContent>
          <EmptyState message="No feedback results yet." />
        </CardContent>
      </Card>
    </div>
  );
}
