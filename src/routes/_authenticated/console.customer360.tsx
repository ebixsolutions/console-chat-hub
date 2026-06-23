import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import {
  LoadingState,
  EmptyState,
  ErrorState,
  PermissionDenied,
  PageHeader,
  DegradedState,
  MaskedField,
} from "@/components/console/PageStates";
import { MSG_EN } from "@/lib/i18n/message-keys";

export const Route = createFileRoute("/_authenticated/console/customer360")({
  component: Customer360Page,
});

type ViewMode =
  | "empty"
  | "error"
  | "degraded"
  | "consent_withdrawn"
  | "do_not_profile"
  | "masked";

const PREVIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: "empty", label: "Empty" },
  { id: "degraded", label: "Degraded" },
  { id: "consent_withdrawn", label: "Consent withdrawn" },
  { id: "do_not_profile", label: "Do not profile" },
  { id: "masked", label: "Masked (agent view)" },
  { id: "error", label: "Error" },
];

function StatePreview({ mode }: { mode: ViewMode }) {
  switch (mode) {
    case "empty":
      return <EmptyState message="No customer context." />;
    case "error":
      return <ErrorState />;
    case "degraded":
      return <DegradedState message={MSG_EN.CUSTOMER_DEGRADED} />;
    case "consent_withdrawn":
      return <EmptyState message={MSG_EN.CUSTOMER_CONSENT_WITHDRAWN} />;
    case "do_not_profile":
      return <EmptyState message={MSG_EN.CUSTOMER_DO_NOT_PROFILE} />;
    case "masked":
      return (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">
              Customer ID: cust_••••1234{" "}
              <Badge variant="secondary" className="ml-2">
                Masked
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <MaskedField label="Name" />
            <MaskedField label="Email" />
            <MaskedField label="Phone" />
          </CardContent>
        </Card>
      );
  }
}

function Customer360Page() {
  const { role, loading: roleLoading } = useCurrentRole();
  const [previewMode, setPreviewMode] = useState<ViewMode>(
    role === "agent" ? "masked" : "empty",
  );

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

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground mr-2">Preview state:</span>
        {PREVIEW_MODES.map((m) => (
          <Button
            key={m.id}
            size="sm"
            variant={previewMode === m.id ? "default" : "outline"}
            onClick={() => setPreviewMode(m.id)}
          >
            {m.label}
          </Button>
        ))}
        <div className="ml-auto">
          <Button size="sm" variant="outline" asChild>
            <a href="#" aria-disabled>
              Open Full Customer360 <ExternalLink className="ml-2 h-4 w-4" />
            </a>
          </Button>
        </div>
      </div>

      <StatePreview mode={previewMode} />
    </div>
  );
}
