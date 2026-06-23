import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Download } from "lucide-react";
import { analyticsService } from "@/lib/api/config.service";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, EmptyState, ErrorState, PermissionDenied, PageHeader } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/analytics")({
  component: AnalyticsPage,
});

function AnalyticsPage() {
  const { role, loading: roleLoading } = useCurrentRole();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    analyticsService.getSummary().then((res) => {
      if (res.error) setError("Failed to load analytics.");
      else setData(res.data);
      setLoading(false);
    });
  }, []);

  if (roleLoading || loading) return <LoadingState />;
  if (!role) return <PermissionDenied />;
  const canExport = role === "admin";
  const scopeLabel = role === "agent" ? "Showing your own data only." : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description={scopeLabel ?? "Operational KPIs across conversations and agents."}
      />
      <div className="flex justify-end">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button size="sm" variant="outline" disabled={!canExport}>
                  <Download className="mr-2 h-4 w-4" />
                  Export CSV
                </Button>
              </span>
            </TooltipTrigger>
            {!canExport && <TooltipContent>Admin only.</TooltipContent>}
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        {["Conversations", "Resolved", "Avg. Response", "CSAT"].map((kpi) => (
          <Card key={kpi}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{kpi}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold">--</div>
            </CardContent>
          </Card>
        ))}
      </div>
      {error ? <ErrorState message={error} /> : !data ? <EmptyState message="No analytics data yet." /> : null}
    </div>
  );
}
