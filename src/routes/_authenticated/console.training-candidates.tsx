import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy compatibility route only.
 *
 * AI Chatbot owns canonical Conversation Evaluation. Training workflows are
 * owned by SU CoachAI and must not be rendered inside the AI Chatbot Console.
 * Keep this route as a redirect so old bookmarks do not expose a stale
 * Training Candidates surface while route-tree compatibility is preserved.
 */
export const Route = createFileRoute(
  "/_authenticated/console/training-candidates",
)({
  beforeLoad: () => {
    throw redirect({ to: "/console/conversation-evaluation" });
  },
  component: LegacyTrainingCandidatesRedirect,
});

function LegacyTrainingCandidatesRedirect() {
  return null;
}
