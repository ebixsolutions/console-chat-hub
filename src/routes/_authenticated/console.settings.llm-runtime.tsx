import { createFileRoute } from "@tanstack/react-router";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useEffectiveRole } from "@/hooks/useEffectiveRole";
import { LoadingState, PermissionDenied, PageHeader } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/settings/llm-runtime")({
  component: LlmRuntimePage,
});

function LlmRuntimePage() {
  const { role, loading } = useEffectiveRole();
  if (loading) return <LoadingState />;
  if (role === "agent" || role === "qa" || !role) return <PermissionDenied />;

  return (
    <div className="space-y-6">
      <PageHeader title="LLM Runtime" description="Runtime configuration for the AI reply pipeline." />

      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          <div className="text-3xl mb-3">🤖</div>
          <div className="font-semibold text-foreground mb-2">LLM Runtime — Not Configured</div>
          <div className="max-w-sm mx-auto leading-relaxed">
            LLM provider, routing, prompt source, and guardrail configuration will be available when the AI pipeline
            configuration interface is connected. The AI reply pipeline is currently using the default Anthropic Claude
            Haiku provider.
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
