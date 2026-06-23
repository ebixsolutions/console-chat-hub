import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/console/training-candidates")({
  component: TrainingCandidatesRedirect,
});

function TrainingCandidatesRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    toast.message("Training candidates are managed in SU Coach AI.", {
      action: { label: "Open SU Coach AI Training Pipeline ↗", onClick: () => { window.location.href = "#"; } },
    });
    navigate({ to: "/console", replace: true });
  }, [navigate]);
  return null;
}
