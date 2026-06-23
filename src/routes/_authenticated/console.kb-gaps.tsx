import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/console/kb-gaps")({
  component: KbGapsRedirect,
});

function KbGapsRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    toast.message("KB gaps are managed in Knowledge Base / SU Coach AI QA.", {
      action: { label: "Open Knowledge Base ↗", onClick: () => { window.location.href = "#"; } },
    });
    navigate({ to: "/console", replace: true });
  }, [navigate]);
  return null;
}
