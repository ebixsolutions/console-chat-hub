/**
 * Legacy evaluation deep-link compatibility route.
 *
 * The active CE detail component is conversation-first. This route still
 * receives an evaluationId in the URL, so it resolves the evaluation to its
 * canonical conversation_id first, then renders CeDetailPanel with the
 * correct conversationId prop.
 *
 * No training UI.
 */

import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { roleCan } from "@/lib/authz/consoleCapabilities";
import { useConsoleLang, COPY } from "@/lib/i18n/consoleLang";
import { CE_REVIEW_COPY as C } from "@/lib/i18n/ceReviewCopy";
import { getCeEvaluationFn } from "@/lib/api/ce.functions";
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
  const { evaluationId } = useParams({
    from: "/_authenticated/console/conversation-evaluation/$evaluationId",
  });
  const { role, loading } = useCurrentRole();
  const { t } = useConsoleLang();

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [resolveError, setResolveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    setResolving(true);
    setResolveError(null);
    setConversationId(null);

    void (async () => {
      try {
        const result = await getCeEvaluationFn({
          data: { evaluationId },
        });

        if (cancelled) return;

        if (!result.ok || !result.data?.evaluation?.conversation_id) {
          setResolveError(result.error ?? "evaluation_not_found");
          return;
        }

        setConversationId(String(result.data.evaluation.conversation_id));
      } catch (error: unknown) {
        if (!cancelled) {
          setResolveError(error instanceof Error ? error.message : "evaluation_lookup_failed");
        }
      } finally {
        if (!cancelled) setResolving(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [evaluationId]);

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
        {resolving ? (
          <LoadingState />
        ) : resolveError || !conversationId ? (
          <div className="m-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            {t(C.detail.loadFailed)}
            {resolveError ? <span className="ml-2 font-mono text-xs">{resolveError}</span> : null}
          </div>
        ) : (
          <CeDetailPanel conversationId={conversationId} canReview={roleCan(role, "ce.review.decide")} />
        )}
      </div>
    </div>
  );
}
