import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { roleCan } from "@/lib/authz/consoleCapabilities";
import { useConsoleLang, COPY } from "@/lib/i18n/consoleLang";
import { PermissionDenied, LoadingState } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/conversation-evaluation")({
  head: () => ({
    meta: [
      { title: "Conversation Evaluation — AI Chatbot Console" },
      {
        name: "description",
        content:
          "Review chatbot conversations with six-dimension scoring, replay evidence and QA findings.",
      },
    ],
  }),
  component: ConversationEvaluationLayout,
});

function ConversationEvaluationLayout() {
  const { role, loading } = useCurrentRole();
  const { t } = useConsoleLang();

  if (loading) return <LoadingState />;
  if (!roleCan(role, "ce.route.view")) {
    return <PermissionDenied message={t(COPY.ce.permissionDenied)} />;
  }

  return <Outlet />;
}
