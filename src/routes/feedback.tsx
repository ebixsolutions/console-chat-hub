import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { authoritativeFunctionsBase } from "@/integrations/supabase/runtime-authority.mjs";

const searchSchema = z.object({ token: z.string().optional() });

export const Route = createFileRoute("/feedback")({
  validateSearch: (search) => searchSchema.parse(search),
  component: FeedbackPage,
});

const EF_URL = `${resolveAuthoritativeSupabaseBinding({ functionsUrl: import.meta.env.VITE_SUPABASE_FUNCTIONS_URL }).functionsUrl}/submit-feedback-response`;

function FeedbackPage() {
  const { token } = useSearch({ from: "/feedback" });
  const [rating, setRating] = useState<number | null>(null);
  const [feedbackText, setFeedbackText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!token) {
    return (
      <PageShell>
        <ErrorDisplay message="No feedback token provided. Please use the link from your feedback request." />
      </PageShell>
    );
  }

  if (submitted) {
    return (
      <PageShell>
        <div className="text-center space-y-3">
          <div className="text-4xl">✅</div>
          <h2 className="text-xl font-semibold text-gray-900">
            Thank you for your feedback!
          </h2>
          <p className="text-sm text-gray-500">
            Your response has been recorded. You may close this page.
          </p>
        </div>
      </PageShell>
    );
  }

  if (error) {
    return (
      <PageShell>
        <ErrorDisplay message={error} />
      </PageShell>
    );
  }

  async function handleSubmit() {
    if (rating === null || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const body: Record<string, unknown> = { token, rating };
      const trimmed = feedbackText.trim();
      if (trimmed.length > 0) body.feedback_text = trimmed;

      const res = await fetch(EF_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);

      if (res.ok && data?.success) {
        setSubmitted(true);
      } else if (data?.error === "invalid_or_expired_token") {
        setError("This feedback link is invalid or has expired. Please contact support if you need a new link.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    } catch {
      setError("Unable to connect. Please check your internet and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <PageShell>
      <div className="space-y-6">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-gray-900">Rate Your Recent Experience</h2>
          <p className="text-sm text-gray-500 mt-1">Your feedback helps us improve our service.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 text-center mb-3">How would you rate your experience?</label>
          <div className="flex justify-center gap-2">
            {[1, 2, 3, 4, 5].map((v) => (
              <button
                key={v}
                onClick={() => setRating(v)}
                disabled={submitting}
                className={`w-12 h-12 rounded-lg border-2 text-lg font-bold transition-all ${rating === v ? "bg-yellow-400 border-yellow-500 text-white scale-110" : rating !== null && v <= rating ? "bg-yellow-100 border-yellow-300 text-yellow-600" : "bg-white border-gray-200 text-gray-400 hover:border-yellow-300 hover:text-yellow-500"}`}
                aria-label={`Rate ${v} out of 5`}
              >
                ★
              </button>
            ))}
          </div>
          {rating !== null && <p className="text-center text-sm text-gray-500 mt-2">{rating} / 5</p>}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Tell us more (optional)</label>
          <textarea
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            maxLength={2000}
            rows={4}
            disabled={submitting}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
            placeholder="Share your thoughts..."
          />
          <div className="text-xs text-gray-400 text-right mt-1">{feedbackText.length}/2000</div>
        </div>
        <Button onClick={handleSubmit} disabled={rating === null || submitting} className="w-full" size="lg">
          {submitting ? "Submitting..." : "Submit Feedback"}
        </Button>
      </div>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardContent className="p-6 sm:p-8">
          <div className="text-center mb-6">
            <div className="text-2xl font-bold text-gray-900">Customer Feedback</div>
            <div className="text-xs text-gray-400 mt-1">Powered by AI Chatbot</div>
          </div>
          {children}
        </CardContent>
      </Card>
    </div>
  );
}

function ErrorDisplay({ message }: { message: string }) {
  return (
    <div className="text-center space-y-3">
      <div className="text-4xl">❌</div>
      <h2 className="text-lg font-semibold text-gray-900">Unable to load feedback form</h2>
      <p className="text-sm text-gray-500">{message}</p>
    </div>
  );
}
