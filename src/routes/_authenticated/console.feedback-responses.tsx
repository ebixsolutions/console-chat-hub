import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useConsoleLang } from "@/hooks/useEffectiveRole";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import {
  feedbackService,
  type FeedbackResponseRow,
} from "@/lib/api/feedback.service";

export const Route = createFileRoute(
  "/_authenticated/console/feedback-responses",
)({
  component: FeedbackResponsesPage,
});

const PAGE_SIZE = 20;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function FeedbackResponsesPage() {
  const { role, loading } = useCurrentRole();
  const lang = useConsoleLang();

  if (loading) return <LoadingState />;
  if (!["admin", "supervisor", "agent"].includes(role ?? "")) {
    return (
      <PermissionDenied
        message={
          lang === "zh"
            ? "您沒有權限查看客戶回饋。"
            : "You do not have permission to view feedback responses."
        }
      />
    );
  }

  return <FeedbackResponsesContent lang={lang} />;
}

function FeedbackResponsesContent({ lang }: { lang: "en" | "zh" }) {
  const [rows, setRows] = useState<FeedbackResponseRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState("");
  const [delivery, setDelivery] = useState("");
  const [channel, setChannel] = useState("");
  const [rating, setRating] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [convInput, setConvInput] = useState("");
  const [conversationId, setConversationId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (from && to && from > to) {
      setLoading(false);
      setError("invalid_date_range");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const res = await feedbackService.listFeedbackResponses({
        status: status ? (status as "pending" | "responded") : undefined,
        delivery_status: delivery
          ? (delivery as "pending" | "sent" | "delivery_failed")
          : undefined,
        channel: channel
          ? (channel as "email" | "website_widget")
          : undefined,
        rating:
          rating === "none"
            ? "none"
            : rating
              ? Number(rating)
              : undefined,
        conversation_id: conversationId || undefined,
        from: from || undefined,
        to: to || undefined,
        page,
        page_size: PAGE_SIZE,
      });

      if (!res.ok) {
        setRows([]);
        setTotal(0);
        setError(res.error);
        return;
      }

      setRows(res.data.rows);
      setTotal(res.data.total);
    } catch {
      setRows([]);
      setTotal(0);
      setError("feedback_response_load_failed");
    } finally {
      setLoading(false);
    }
  }, [status, delivery, channel, rating, conversationId, from, to, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyConversation = () => {
    const v = convInput.trim();
    if (!v) {
      setConversationId("");
      setPage(0);
      return;
    }
    if (!UUID_RE.test(v)) {
      setError("invalid_conversation_id");
      return;
    }
    setError("");
    setConversationId(v);
    setPage(0);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const fmt = (v: string | null) =>
    v
      ? new Date(v).toLocaleString(lang === "zh" ? "zh-HK" : "en-US")
      : "—";

  return (
    <div className="mx-auto max-w-[1120px] space-y-4">
      <div className="rounded-xl border bg-white p-4">
        <div className="mb-3 text-sm font-semibold">
          {lang === "zh" ? "客戶回饋" : "Feedback Responses"}
        </div>

        <div className="flex flex-wrap gap-2">
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(0);
            }}
            className="rounded-md border px-2 py-1.5 text-xs"
          >
            <option value="">All status</option>
            <option value="pending">Pending</option>
            <option value="responded">Responded</option>
          </select>
          <select
            value={delivery}
            onChange={(e) => {
              setDelivery(e.target.value);
              setPage(0);
            }}
            className="rounded-md border px-2 py-1.5 text-xs"
          >
            <option value="">All delivery</option>
            <option value="pending">Pending</option>
            <option value="sent">Sent</option>
            <option value="delivery_failed">Failed</option>
          </select>
          <select
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value);
              setPage(0);
            }}
            className="rounded-md border px-2 py-1.5 text-xs"
          >
            <option value="">All channels</option>
            <option value="website_widget">Widget</option>
            <option value="email">Email</option>
          </select>
          <select
            value={rating}
            onChange={(e) => {
              setRating(e.target.value);
              setPage(0);
            }}
            className="rounded-md border px-2 py-1.5 text-xs"
          >
            <option value="">All ratings</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n} ★
              </option>
            ))}
            <option value="none">No rating</option>
          </select>
          <input
            type="date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(0);
            }}
            className="rounded-md border px-2 py-1.5 text-xs"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(0);
            }}
            className="rounded-md border px-2 py-1.5 text-xs"
          />
        </div>

        <div className="mt-3 flex max-w-xl gap-2">
          <input
            value={convInput}
            onChange={(e) => setConvInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyConversation();
            }}
            placeholder="Conversation UUID"
            className="min-w-0 flex-1 rounded-md border px-2 py-1.5 font-mono text-xs"
          />
          <button
            type="button"
            onClick={applyConversation}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white"
          >
            Search
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <LoadingState />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border bg-white p-10 text-center text-sm text-muted-foreground">
          No feedback responses found.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-white">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="bg-slate-50 text-muted-foreground">
              <tr>
                <th className="px-3 py-2">Conversation</th>
                <th className="px-3 py-2">Channel</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Delivery</th>
                <th className="px-3 py-2">Rating</th>
                <th className="px-3 py-2">Feedback</th>
                <th className="px-3 py-2">Responded</th>
                <th className="px-3 py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <Link
                      to="/console/conversations/$id"
                      params={{ id: row.conversation_id }}
                      className="font-mono text-blue-600"
                    >
                      {row.conversation_id.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="px-3 py-2">{row.channel ?? "—"}</td>
                  <td className="px-3 py-2">{row.status ?? "—"}</td>
                  <td className="px-3 py-2">{row.delivery_status ?? "—"}</td>
                  <td className="px-3 py-2">
                    {row.rating == null ? "—" : `${row.rating} ★`}
                  </td>
                  <td className="max-w-[320px] whitespace-pre-wrap px-3 py-2">
                    {row.feedback_text ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {fmt(row.responded_at)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {fmt(row.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs">
            <span>
              {Math.min(page * PAGE_SIZE + 1, total)}–
              {Math.min((page + 1) * PAGE_SIZE, total)} / {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded border px-2 py-1 disabled:opacity-40"
              >
                ← Prev
              </button>
              <span className="px-2 py-1">
                {page + 1} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages - 1}
                onClick={() =>
                  setPage((p) => Math.min(totalPages - 1, p + 1))
                }
                className="rounded border px-2 py-1 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
