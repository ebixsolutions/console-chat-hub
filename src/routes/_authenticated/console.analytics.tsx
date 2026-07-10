import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/console/analytics")({
  component: AnalyticsPage,
});

function AnalyticsPage() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "60vh",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 40 }}>📊</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: "#374151" }}>Analytics — Coming Soon</div>
      <div style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", maxWidth: 360, lineHeight: 1.6 }}>
        The analytics dashboard will be available when data aggregation is connected. Conversation and message data is
        being collected and will power real-time metrics in a future release.
      </div>
    </div>
  );
}
