import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/console/customer360")({
  component: Customer360Page,
});

function Customer360Page() {
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
      <div style={{ fontSize: 40 }}>👥</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: "#374151" }}>Customer 360 — Coming Soon</div>
      <div style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", maxWidth: 360, lineHeight: 1.6 }}>
        Full customer profiles will be available when CRM data integration is connected. This page will display purchase
        history, emotion journey, AI trust score, and follow-up actions.
      </div>
    </div>
  );
}
