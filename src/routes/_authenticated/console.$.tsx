import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { MSG, MSG_EN } from "@/lib/i18n/message-keys";
import { WidgetLiveAiTest } from "@/components/console/WidgetLiveAiTest";

export const Route = createFileRoute("/_authenticated/console/$")({
  component: ConsoleCatchAll,
});

function ConsoleCatchAll() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();

  if (pathname === "/console/widget-live-test") {
    return <WidgetLiveAiTest />;
  }

  return <ConsoleNotFound navigate={navigate} />;
}

function ConsoleNotFound({
  navigate,
}: {
  navigate: ReturnType<typeof useNavigate>;
}) {
  useEffect(() => {
    toast.message(MSG_EN.PAGE_NOT_FOUND, { description: MSG.PAGE_NOT_FOUND });
    navigate({ to: "/console", replace: true });
  }, [navigate]);

  return null;
}
