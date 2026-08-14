import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy internal test route.
 *
 * Product-ready Console must not expose a manual production feedback mutation
 * or token-generation surface. Public customer response capture is owned by
 * the token-protected /feedback flow and submit-feedback-response Edge path.
 */
export const Route = createFileRoute(
  "/_authenticated/console/settings/feedback-test",
)({
  beforeLoad: () => {
    throw redirect({ to: "/console/feedback-responses" });
  },
  component: LegacyFeedbackTestRedirect,
});

function LegacyFeedbackTestRedirect() {
  return null;
}
