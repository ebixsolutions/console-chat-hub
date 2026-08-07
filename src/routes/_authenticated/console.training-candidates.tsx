import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/console/training-candidates")({
  component: TrainingCandidatesPage,
});

function TrainingCandidatesPage() {
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
      <div style={{ fontSize: 40 }}>🎓</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: "#374151" }}>Training Candidates</div>
      <div style={{ fontSize: 12, color: "#9ca3af", textAlign: "center", maxWidth: 360, lineHeight: 1.6 }}>
        Training candidates are managed in SU Coach AI. When the training pipeline is connected, candidates will be
        surfaced here.
      </div>
    </div>
  );
}
