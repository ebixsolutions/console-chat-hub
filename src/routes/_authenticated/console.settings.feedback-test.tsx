import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, PermissionDenied, PageHeader } from "@/components/console/PageStates";
import { supabase } from "@/integrations/supabase/client";
import { feedbackService } from "@/lib/api/feedback.service";

export const Route = createFileRoute("/_authenticated/console/settings/feedback-test")({
  component: FeedbackTestPage,
});

type PendingRow = {
  id: string;
  conversation_id: string;
  channel: string | null;
  scheduled_at: string | null;
  rating_type: string | null;
  status: string | null;
};

type RecordResult = {
  ok: boolean;
  data?: Record<string, unknown>;
  error_type?: string;
  message?: string;
};

type TokenResult = {
  ok: boolean;
  data?: {
    feedback_request_id?: string;
    feedback_link?: string;
    token_expires_at?: string;
    previous_token_invalidated?: boolean;
  };
  error_type?: string;
  message?: string;
};

function FeedbackTestPage() {
  const { role, loading: roleLoading } = useCurrentRole();

  // ── Strict admin-only guard ──
  // Supervisor, agent, qa, and unknown roles are ALL blocked.
  if (roleLoading) return <LoadingState />;
  if (role !== "admin") {
    return (
      <PermissionDenied message="Admin only. This internal test tool is restricted to admin role. Supervisor, agent, and QA roles are not permitted." />
    );
  }

  return <FeedbackTestContent />;
}

function FeedbackTestContent() {
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rating, setRating] = useState<number>(5);
  const [feedbackText, setFeedbackText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<RecordResult | null>(null);

  // S3a: Token generation state
  const [tokenGenerating, setTokenGenerating] = useState(false);
  const [tokenResult, setTokenResult] = useState<TokenResult | null>(null);
  const [feedbackLink, setFeedbackLink] = useState<string | null>(null);

  function clearTokenLink() {
    setFeedbackLink(null);
    setTokenResult(null);
  }

  async function handleGenerateToken(forceRegenerate: boolean) {
    if (!selectedId) return;
    setTokenGenerating(true);
    setTokenResult(null);
    setFeedbackLink(null);
    try {
      const res = await feedbackService.generateFeedbackToken({
        feedback_request_id: selectedId,
        force_regenerate: forceRegenerate,
      });
      const typed = res as TokenResult;
      setTokenResult(typed);
      if (typed.ok && typed.data?.feedback_link) {
        setFeedbackLink(typed.data.feedback_link);
      }
      if (typed.ok) {
        loadPending();
      }
    } catch (e: unknown) {
      setTokenResult({
        ok: false,
        error_type: "network_error",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      setTokenGenerating(false);
    }
  }

  async function loadPending() {
    setListLoading(true);
    setListError(null);
    try {
      const { data, error } = await supabase
        .from("feedback_request")
        .select("id, conversation_id, channel, scheduled_at, rating_type, status")
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) {
        setListError(`Query failed: ${error.message} (code: ${error.code ?? "unknown"})`);
        setRows([]);
        return;
      }

      if (!Array.isArray(data)) {
        setListError("Unexpected response: data is not an array");
        setRows([]);
        return;
      }

      setRows(data as PendingRow[]);
    } catch (e: unknown) {
      setListError(`Exception: ${e instanceof Error ? e.message : "Unknown error"}`);
      setRows([]);
    } finally {
      setListLoading(false);
    }
  }

  useEffect(() => {
    loadPending();
  }, []);

  async function handleSubmit() {
    if (!selectedId) return;
    setSubmitting(true);
    setResult(null);
    try {
      const res = await feedbackService.recordFeedbackResponse({
        feedback_request_id: selectedId,
        rating,
        feedback_text: feedbackText || undefined,
      });
      setResult(res as RecordResult);
      if ((res as RecordResult).ok) {
        loadPending();
        setSelectedId(null);
        setRating(5);
        setFeedbackText("");
      }
    } catch (e: unknown) {
      setResult({
        ok: false,
        error_type: "network_error",
        message: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feedback Test Tool"
        description="Internal admin-only test tool for validating recordFeedbackResponseFn."
        badge={<Badge variant="destructive">Internal Test Only</Badge>}
      />

      {/* Warning Banner */}
      <div
        style={{
          background: "#fef3c7",
          border: "1px solid #f59e0b",
          borderRadius: 8,
          padding: "12px 16px",
          fontSize: 13,
          color: "#92400e",
        }}
      >
        ⚠️ <strong>Internal test tool only.</strong> Not customer-facing. Not production customer feedback UI. Used only
        to validate backend response capture path (pending → responded). Admin role only. This route is intentionally
        not linked in the sidebar. Admin manual URL access only: <code>/console/settings/feedback-test</code>
      </div>

      {/* Pending List */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">Pending Feedback Requests</h3>
            <Button size="sm" variant="outline" onClick={loadPending}>
              Refresh
            </Button>
          </div>

          {listLoading && <p className="text-sm text-gray-500">Loading pending requests...</p>}

          {listError && (
            <div
              style={{
                background: "#fef2f2",
                border: "1px solid #ef4444",
                borderRadius: 6,
                padding: "8px 12px",
                fontSize: 12,
                color: "#991b1b",
              }}
            >
              ❌ {listError}
            </div>
          )}

          {!listLoading && !listError && rows.length === 0 && (
            <p className="text-sm text-gray-400">
              No pending feedback requests found. Resolve a conversation with Feedback Automation enabled to create one.
            </p>
          )}

          {!listLoading && rows.length > 0 && (
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="py-1 pr-2">Select</th>
                  <th className="py-1 pr-2">ID (short)</th>
                  <th className="py-1 pr-2">Conversation</th>
                  <th className="py-1 pr-2">Channel</th>
                  <th className="py-1 pr-2">Rating Type</th>
                  <th className="py-1 pr-2">Scheduled At</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className={`border-b cursor-pointer hover:bg-gray-50 ${selectedId === r.id ? "bg-blue-50" : ""}`}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <td className="py-1 pr-2">
                      <input type="radio" checked={selectedId === r.id} onChange={() => setSelectedId(r.id)} />
                    </td>
                    <td className="py-1 pr-2 font-mono">{r.id.slice(0, 8)}…</td>
                    <td className="py-1 pr-2 font-mono">{r.conversation_id.slice(0, 8)}…</td>
                    <td className="py-1 pr-2">{r.channel ?? "—"}</td>
                    <td className="py-1 pr-2">{r.rating_type ?? "—"}</td>
                    <td className="py-1 pr-2">{r.scheduled_at ? new Date(r.scheduled_at).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Record Response Form */}
      <Card>
        <CardContent className="p-4">
          <h3 className="font-semibold text-sm mb-3">Record Response</h3>

          {!selectedId && (
            <p className="text-sm text-gray-400">Select a pending feedback request above to record a response.</p>
          )}

          {selectedId && (
            <div className="space-y-3">
              <div className="text-xs text-gray-500">
                Selected: <span className="font-mono">{selectedId}</span>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Rating (1–5)</label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((v) => (
                    <button
                      key={v}
                      onClick={() => setRating(v)}
                      className={`w-10 h-10 rounded border text-sm font-bold ${
                        rating === v
                          ? "bg-blue-600 text-white border-blue-600"
                          : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
                      }`}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Feedback Text (optional, max 2000 chars)</label>
                <textarea
                  value={feedbackText}
                  onChange={(e) => setFeedbackText(e.target.value)}
                  maxLength={2000}
                  rows={3}
                  className="w-full border rounded px-3 py-2 text-sm"
                  placeholder="Optional customer feedback text..."
                />
                <div className="text-xs text-gray-400 text-right">{feedbackText.length}/2000</div>
              </div>

              <Button onClick={handleSubmit} disabled={submitting} size="sm">
                {submitting ? "Submitting..." : "Record Response"}
              </Button>
            </div>
          )}

          {/* Record Result Display */}
          {result && (
            <div
              className="mt-3"
              style={{
                background: result.ok ? "#f0fdf4" : "#fef2f2",
                border: `1px solid ${result.ok ? "#22c55e" : "#ef4444"}`,
                borderRadius: 6,
                padding: "10px 14px",
                fontSize: 12,
              }}
            >
              <div className="font-bold mb-1">{result.ok ? "✅ Success" : "❌ Failed"}</div>
              <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* S3a: Manual Token Generation Test */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="font-semibold text-sm">S3a — Manual Token Generation Test</h3>
            <Badge variant="outline" className="text-xs">
              Token Only
            </Badge>
          </div>

          <div
            style={{
              background: "#eff6ff",
              border: "1px solid #3b82f6",
              borderRadius: 6,
              padding: "8px 12px",
              fontSize: 11,
              color: "#1e40af",
              marginBottom: 12,
            }}
          >
            ℹ️ This section does NOT submit feedback. This section does NOT validate public submission. This section
            only generates a test delivery token and shows the feedback link once. The link will not be retrievable
            after page refresh.
          </div>

          {!selectedId && (
            <p className="text-sm text-gray-400">
              Select a pending feedback request from the list above, then use this section to generate a token.
            </p>
          )}

          {selectedId && (
            <div className="space-y-3">
              <div className="text-xs text-gray-500">
                Target: <span className="font-mono">{selectedId}</span>
              </div>

              <div className="flex gap-2">
                <Button size="sm" onClick={() => handleGenerateToken(false)} disabled={tokenGenerating}>
                  {tokenGenerating ? "Generating..." : "Generate Token"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleGenerateToken(true)}
                  disabled={tokenGenerating}
                >
                  Regenerate (invalidates previous)
                </Button>
              </div>

              {/* Feedback Link Display */}
              {feedbackLink && (
                <div
                  style={{
                    background: "#f0fdf4",
                    border: "1px solid #22c55e",
                    borderRadius: 6,
                    padding: "10px 14px",
                    fontSize: 12,
                  }}
                >
                  <div className="font-bold text-green-800 mb-1">🔗 Feedback Link (shown once only)</div>
                  <div
                    className="font-mono text-xs bg-white border rounded p-2 break-all select-all"
                    style={{ userSelect: "all" }}
                  >
                    {feedbackLink}
                  </div>
                  <div className="flex gap-2 mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        navigator.clipboard.writeText(feedbackLink);
                      }}
                    >
                      Copy Link
                    </Button>
                    <Button size="sm" variant="ghost" onClick={clearTokenLink}>
                      Clear Link
                    </Button>
                  </div>
                  <p className="text-xs text-amber-700 mt-2">
                    ⚠️ This link will not be shown again after page refresh or regeneration. Copy it now if needed for
                    testing.
                  </p>
                </div>
              )}

              {/* Token Result Display (error only — success shows link above) */}
              {tokenResult && !feedbackLink && (
                <div
                  style={{
                    background: tokenResult.ok ? "#f0fdf4" : "#fef2f2",
                    border: `1px solid ${tokenResult.ok ? "#22c55e" : "#ef4444"}`,
                    borderRadius: 6,
                    padding: "10px 14px",
                    fontSize: 12,
                  }}
                >
                  <div className="font-bold mb-1">{tokenResult.ok ? "✅ Success" : "❌ Failed"}</div>
                  <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(tokenResult, null, 2)}</pre>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
