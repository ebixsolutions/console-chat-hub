import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/console/widget-preview")({
  component: WidgetPreview,
});

function WidgetPreview() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Widget Preview</h1>
        <p className="text-muted-foreground">Test your embeddable chat widget in a sandboxed page.</p>
      </div>
      <div className="overflow-hidden rounded-lg border bg-card">
        <iframe
          src="/widget-sandbox.html"
          title="Widget sandbox"
          className="h-[70vh] w-full"
        />
      </div>
    </div>
  );
}
