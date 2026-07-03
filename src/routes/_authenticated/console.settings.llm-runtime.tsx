import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import { useEffectiveRole } from "@/hooks/useEffectiveRole";
import { LoadingState, PermissionDenied, PageHeader, EmptyState } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/settings/llm-runtime")({
  component: LlmRuntimePage,
});

function LlmRuntimePage() {
  const { role, loading } = useEffectiveRole();
  if (loading) return <LoadingState />;
  if (role === "agent" || role === "qa" || !role) return <PermissionDenied />;

  const readonly = role === "supervisor";

  return (
    <div className="space-y-6">
      <PageHeader
        title="LLM Runtime"
        description="Runtime configuration for the AI reply pipeline."
        badge={readonly ? <Badge variant="secondary">Read Only</Badge> : undefined}
      />

      <Tabs defaultValue="provider">
        <TabsList className="flex-wrap">
          <TabsTrigger value="provider">LLM Provider</TabsTrigger>
          <TabsTrigger value="routing">Routing Policy</TabsTrigger>
          <TabsTrigger value="credit">Credit Budget</TabsTrigger>
          <TabsTrigger value="prompt-src">Prompt Source</TabsTrigger>
          <TabsTrigger value="prompt-prev">Prompt Preview</TabsTrigger>
          <TabsTrigger value="runtime-logs">Runtime Logs</TabsTrigger>
          <TabsTrigger value="task-log">Task Log</TabsTrigger>
          <TabsTrigger value="guardrails">Guardrails</TabsTrigger>
        </TabsList>

        <TabsContent value="provider"><Card><CardContent className="py-6 text-sm text-muted-foreground">LLM provider configuration placeholder.</CardContent></Card></TabsContent>
        <TabsContent value="routing"><Card><CardContent className="py-6 text-sm text-muted-foreground">{readonly ? "Admin only." : "Routing policy placeholder."}</CardContent></Card></TabsContent>
        <TabsContent value="credit"><Card><CardContent className="py-6 text-sm text-muted-foreground">{readonly ? "Admin only." : "Credit budget placeholder."}</CardContent></Card></TabsContent>
        <TabsContent value="prompt-src">
          <Card>
            <CardContent className="space-y-3 py-6 text-sm text-muted-foreground">
              <div>Prompt source metadata placeholder.</div>
              <Button size="sm" variant="outline" asChild>
                <a href="#"><ExternalLink className="mr-2 h-4 w-4" />Open in SU Coach AI</a>
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="prompt-prev"><Card><CardContent className="py-6 text-sm text-muted-foreground">Prompt preview placeholder.</CardContent></Card></TabsContent>
        <TabsContent value="runtime-logs"><EmptyState message="No runtime logs yet." /></TabsContent>
        <TabsContent value="task-log"><EmptyState message="No tasks yet." /></TabsContent>
        <TabsContent value="guardrails"><Card><CardContent className="py-6 text-sm text-muted-foreground">Guardrails placeholder.</CardContent></Card></TabsContent>
      </Tabs>
    </div>
  );
}
