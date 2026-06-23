import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, EmptyState, ErrorState, PermissionDenied, PageHeader } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/customer360")({
  component: Customer360Page,
});

type ViewMode = "empty" | "error" | "degraded" | "consent_withdrawn" | "do_not_profile" | "list";

function Customer360Page() {
  const { role, loading: roleLoading } = useCurrentRole();
  const [mode] = useState<ViewMode>("empty");

  if (roleLoading) return <LoadingState />;
  if (!role) return <PermissionDenied />;

  const isAgent = role === "agent";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customer 360"
        description="Unified customer context for active conversations."
        badge={isAgent ? <Badge variant="secondary">Masked</Badge> : undefined}
      />

      {isAgent && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            Contact information masked.
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button size="sm" variant="outline" asChild>
          <a href="#" aria-disabled>
            Open Full Customer360 <ExternalLink className="ml-2 h-4 w-4" />
          </a>
        </Button>
      </div>

      {mode === "empty" && <EmptyState message="No customer context." />}
      {mode === "error" && <ErrorState />}
      {mode === "degraded" && <EmptyState message="Customer information temporarily unavailable." />}
      {mode === "consent_withdrawn" && <EmptyState message="Customer has requested data privacy." />}
      {mode === "do_not_profile" && <EmptyState message="Profiling disabled for this customer." />}
      {mode === "list" && (
        <Card>
          <CardHeader><CardTitle>Customers</CardTitle></CardHeader>
          <CardContent>--</CardContent>
        </Card>
      )}
    </div>
  );
}
