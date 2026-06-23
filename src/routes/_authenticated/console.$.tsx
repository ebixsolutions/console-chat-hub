import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { MSG, MSG_EN } from "@/lib/i18n/message-keys";

export const Route = createFileRoute("/_authenticated/console/$")({
  component: ConsoleNotFound,
});

function ConsoleNotFound() {
  const navigate = useNavigate();
  useEffect(() => {
    toast.message(MSG_EN.PAGE_NOT_FOUND, { description: MSG.PAGE_NOT_FOUND });
    navigate({ to: "/console", replace: true });
  }, [navigate]);
  return null;
}
