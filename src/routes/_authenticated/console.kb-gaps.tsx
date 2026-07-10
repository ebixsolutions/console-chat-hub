import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/console/kb-gaps")({
  component: KbGapsPage,
});

function KbGapsPage() {
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
      <div style={{ fontSize: 40 }}>📚</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: "#374151" }}>Knowledge Base Gaps</div>
      <div style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", maxWidth: 360, lineHeight: 1.6 }}>
        KB gap tracking is managed in the Knowledge Base application. When KB integration is connected, detected gaps
        will be surfaced here.
      </div>
    </div>
  );
}
