import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { agentService, configService } from "@/lib/api/config.service";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, EmptyState, PermissionDenied, PageHeader } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/agent-settings")({
  component: AgentSettingsPage,
});

function AgentSettingsPage() {
  const { role, loading: roleLoading } = useCurrentRole();
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<unknown[]>([]);

  useEffect(() => {
    agentService.listAgents().then((res) => {
      setAgents(res.data);
      setLoading(false);
    });
  }, []);

  if (roleLoading || loading) return <LoadingState />;
  if (!role) return <PermissionDenied />;

  const isAgent = role === "agent";
  const canEdit = role === "admin" || role === "supervisor" || role === "agent";

  const handleEdit = async () => {
    const res = await configService.updateAgentProfile({});
    if ("deferred" in res && res.deferred) {
      toast.message("Profile update available after L7B.");
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agent Settings"
        description={isAgent ? "Manage your own profile." : "Manage agent profiles."}
        badge={role === "supervisor" ? <Badge variant="secondary">View Only</Badge> : undefined}
      />

      {agents.length === 0 ? (
        <EmptyState
          message={
            isAgent
              ? "Only your own profile will appear after L7B binding."
              : "No agent profiles to display yet."
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {agents.map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <CardTitle className="text-base">Agent</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div>Display name: --</div>
                <div>Role: <Badge variant="outline">agent</Badge></div>
                <div>Status: <Badge variant="outline">--</Badge></div>
                {canEdit && (
                  <Button size="sm" variant="outline" onClick={handleEdit}>Edit</Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
