import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  AlertCircle,
  BarChart3,
  Loader2,
  MessageSquare,
  Star,
  Users,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentRole } from "@/hooks/useCurrentRole";

export const Route = createFileRoute("/_authenticated/console/analytics")({
  component: AnalyticsPage,
});

import { downloadCsv } from "@/lib/console/csv-export";

interface AnalyticsSummary {
  total_sessions: number;
  total_conversations: number;
  status_counts: Record<string, number>;
  total_messages: number;
  feedback_count: number;
  average_rating: number | null;
}

function AnalyticsPage() {
  const { role, loading: roleLoading } = useCurrentRole();
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [readRevision, setReadRevision] = useState(0);

  const allowed = role === "admin" || role === "supervisor";

  useEffect(() => {
    if (roleLoading || !allowed) return;

    let cancelled = false;
    void (async () => {
      setState("loading");
      setError("");
      setSummary(null);
      try {
        const { data, error: invokeError } = await supabase.functions.invoke(
          "visitor-analytics",
          { body: { mode: "summary" } },
        );
        if (cancelled) return;

        const value = data?.summary;
        const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
        const valid = value && [value.total_sessions, value.total_conversations, value.total_messages,
          value.feedback_count].every(count) &&
          (value.average_rating === null || typeof value.average_rating === "number" && Number.isFinite(value.average_rating)) &&
          value.status_counts && typeof value.status_counts === "object" && !Array.isArray(value.status_counts) &&
          Object.values(value.status_counts).every(count);
        if (invokeError || !data?.success || !valid) {
          setError(
            String(
              data?.error ??
                invokeError?.message ??
                "analytics_query_failed",
            ),
          );
          setState("error");
          return;
        }

        setSummary(data.summary as AnalyticsSummary);
        setState("ready");
      } catch {
        if (!cancelled) {
          setError("analytics_query_failed");
          setState("error");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [allowed, roleLoading, readRevision]);

  if (roleLoading) {
    return <Centered icon={<Loader2 className="animate-spin" />} text="Loading analytics…" />;
  }

  if (!allowed) {
    return (
      <Centered
        icon={<AlertCircle size={34} style={{ color: "#ef4444" }} />}
        text="Analytics is available to Admin and Supervisor roles."
      />
    );
  }

  if (state === "loading") {
    return <Centered icon={<Loader2 className="animate-spin" />} text="Loading live analytics…" />;
  }

  if (state === "error") {
    return (
      <Centered
        icon={<AlertCircle size={34} style={{ color: "#ef4444" }} />}
        text={`Analytics unavailable: ${error}`}
        action={<button className="rounded-md border bg-white px-3 py-2 text-sm" type="button" onClick={() => setReadRevision(v => v + 1)}>Retry</button>}
      />
    );
  }

  if (!summary) {
    return <Centered icon={<BarChart3 size={34} />} text="No analytics data available." />;
  }

  const humanQueue =
    (summary.status_counts.pending ?? 0) +
    (summary.status_counts.transferred ?? 0) +
    (summary.status_counts.human_needed ?? 0) +
    (summary.status_counts.escalation_risk ?? 0) +
    (summary.status_counts.unresolved ?? 0);

  const cards = [
    {
      label: "Visitor Sessions",
      value: summary.total_sessions,
      icon: <Users size={18} />,
    },
    {
      label: "Conversations",
      value: summary.total_conversations,
      icon: <MessageSquare size={18} />,
    },
    {
      label: "Messages",
      value: summary.total_messages,
      icon: <MessageSquare size={18} />,
    },
    {
      label: "Human Queue",
      value: humanQueue,
      icon: <Users size={18} />,
    },
    {
      label: "Feedback",
      value: summary.feedback_count,
      icon: <Star size={18} />,
    },
    {
      label: "Avg Rating",
      value:
        summary.average_rating == null
          ? "—"
          : summary.average_rating.toFixed(1),
      icon: <Star size={18} />,
    },
  ];

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "24px 18px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 22,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <BarChart3 size={23} style={{ color: "#2563eb" }} />
            <h1 style={{ margin: 0, fontSize: 21, color: "#111827" }}>
              Live Analytics
            </h1>
          </div>
          <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "#6b7280" }}>
            Tenant-scoped production conversation, visitor and feedback metrics.
          </p>
        </div>

        <button type="button" onClick={() => downloadCsv("analytics-summary.csv", [
          ["metric", "value"],
          ["total_sessions", summary.total_sessions], ["total_conversations", summary.total_conversations],
          ["total_messages", summary.total_messages], ["feedback_count", summary.feedback_count],
          ["average_rating", summary.average_rating],
          ...Object.entries(summary.status_counts).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => [`status:${status}`, count]),
        ])} className="rounded border px-3 py-2 text-xs">Export summary CSV</button>
        <Link
          to="/console/visitor-analytics"
          style={{
            fontSize: 12,
            color: "#2563eb",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Visitor detail →
        </Link>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))",
          gap: 12,
          marginBottom: 22,
        }}
      >
        {cards.map((card) => (
          <div
            key={card.label}
            style={{
              background: "#fff",
              border: "1px solid #e5e7eb",
              borderRadius: 11,
              padding: 15,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 7,
                alignItems: "center",
                color: "#64748b",
                fontSize: 11,
                fontWeight: 600,
                marginBottom: 7,
              }}
            >
              {card.icon}
              {card.label}
            </div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#111827" }}>
              {card.value}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 11,
          padding: 16,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>
          Conversation Status
        </div>
        {Object.keys(summary.status_counts).length > 0 && (
          <div role="img" aria-label="Conversation status chart" style={{ marginBottom: 16 }}>
            {Object.entries(summary.status_counts).sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => (
              <div key={status} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 12 }}>{status}: {count}</div>
                <div style={{ height: 12, background: "#e2e8f0", borderRadius: 4 }}>
                  <div style={{ height: "100%", borderRadius: 4, background: "#2563eb",
                    width: `${100 * count / Math.max(1, ...Object.values(summary.status_counts))}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
        {Object.keys(summary.status_counts).length === 0 ? (
          <div style={{ fontSize: 12, color: "#9ca3af" }}>
            No conversations yet.
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))",
              gap: 9,
            }}
          >
            {Object.entries(summary.status_counts)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([statusName, count]) => (
                <div
                  key={statusName}
                  style={{
                    background: "#f8fafc",
                    borderRadius: 8,
                    padding: "9px 10px",
                  }}
                >
                  <div style={{ fontSize: 10.5, color: "#64748b" }}>
                    {statusName}
                  </div>
                  <div
                    style={{
                      marginTop: 2,
                      fontSize: 18,
                      fontWeight: 700,
                      color: "#111827",
                    }}
                  >
                    {count}
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Centered({
  icon,
  text,
  action,
}: {
  icon: React.ReactNode;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        color: "#6b7280",
      }}
    >
      {icon}
      <div style={{ fontSize: 13 }}>{text}</div>
      {action}
    </div>
  );
}
