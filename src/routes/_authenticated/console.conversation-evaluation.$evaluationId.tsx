/**
 * Full-page view of a single conversation evaluation.
 *
 * Renders the same canonical CE detail panel used by the two-column review
 * console, so the deep link and the console surface can never disagree.
 * Training UI is intentionally absent: SU CoachAI owns training.
 */

import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { roleCan } from "@/lib/authz/consoleCapabilities";
import { useConsoleLang, COPY } from "@/lib/i18n/consoleLang";
import { CE_REVIEW_COPY as C } from "@/lib/i18n/ceReviewCopy";
import { CeDetailPanel } from "@/components/console/ce/CeDetailPanel";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/conversation-evaluation/$evaluationId")({
  head: () => ({
    meta: [
      { title: "Evaluation Detail — AI Chatbot Console" },
      {
        name: "description",
        content: "Per-conversation evaluation detail with scores, replay, emotion journey and next steps.",
      },
    ],
  }),
  component: EvaluationDetailPage,
});

function EvaluationDetailPage() {
  const { evaluationId } = useParams({ from: "/_authenticated/console/conversation-evaluation/$evaluationId" });
  const { role, loading } = useCurrentRole();
  const { t } = useConsoleLang();

  if (loading) return <LoadingState />;
  if (!roleCan(role, "ce.evaluation.read_sanitized")) {
    return <PermissionDenied message={t(COPY.ce.permissionDenied)} />;
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col">
      <div className="border-b px-4 py-2">
        <Link to="/console/conversation-evaluation" className="text-xs font-semibold text-primary">
          ← {t(C.detail.back)}
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <CeDetailPanel evaluationId={evaluationId} canReview={roleCan(role, "ce.review.decide")} />
      </div>
    </div>
  );
}
