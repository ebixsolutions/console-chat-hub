import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export function LoadingState() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-sm text-muted-foreground">{message}</CardContent>
    </Card>
  );
}

export function ErrorState({ message = "Something went wrong." }: { message?: string }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-sm text-destructive">{message}</CardContent>
    </Card>
  );
}

export function PermissionDenied({ message }: { message?: string } = {}) {
  return (
    <Card>
      <CardContent className="py-10 text-center">
        <div className="text-lg font-semibold">Permission denied</div>
        <div className="mt-2 text-sm text-muted-foreground">
          {message ?? "You don't have access to this page."}
        </div>
      </CardContent>
    </Card>
  );
}

export function DegradedState({ message }: { message: string }) {
  return (
    <Card>
      <CardContent className="py-10 text-center text-sm text-muted-foreground">
        <div className="font-medium text-foreground mb-1">Service degraded</div>
        {message}
      </CardContent>
    </Card>
  );
}

export function MaskedField({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tracking-wider">••••••</span>
    </div>
  );
}

export function PageHeader({ title, description, badge }: { title: string; description?: string; badge?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
          {title}
          {badge}
        </h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}
