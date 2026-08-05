import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useEffectiveRole, useConsoleLang } from "@/hooks/useEffectiveRole";
import { listCeEvaluationsFn } from "@/lib/api/ce.functions";
import { CE_TABS, type CeTab, type CeStatusRow, improvedResultState } from "@/lib/ce/status";
import { PermissionDenied } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/conversation-evaluation/")({
  head: () => ({
    meta: [
      { title: "Conversation Evaluation — AI Chatbot Console" },
      {
        name: "description",
        content:
          "Canonical conversation evaluation: needs review, training ready and trained states with scores, severity and grounding evidence.",
      },
      { property: "og:title", content: "Conversation Evaluation — AI Chatbot Console" },
      {
        property: "og:description",
        content: "Review evaluated AI conversations, severity, training eligibility and replay evidence.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: ConversationEvaluationList,
});

const T = {
  en: {
    title: "Conversation Evaluation",
    all: "All Conversations",
    needs_review: "Needs Review",
    training_ready: "Training Ready",
    trained: "Trained",
    search: "Search conversation ID…",
    severity: "Severity",
    any: "Any",
    from: "From",
    to: "To",
    score: "Score",
    intent: "Intent",
    channel: "Channel",
    language: "Language",
    date: "Evaluated",
    improved: "Improved result",
    empty: "No evaluations match these filters.",
    disabled:
      "Canonical evaluation pipeline is disabled (ce_canonical_pipeline_enabled = false). Rows appear once it is enabled.",
    loading: "Loading…",
  },
  zh: {
    title: "對話評估",
    all: "全部對話",
    needs_review: "待覆核",
    training_ready: "可供訓練",
    trained: "已訓練",
    search: "搜尋對話 ID…",
    severity: "嚴重程度",
    any: "全部",
    from: "起始",
    to: "結束",
    score: "分數",
    intent: "意圖",
    channel: "渠道",
    language: "語言",
    date: "評估時間",
    improved: "改進結果",
    empty: "沒有符合條件的評估紀錄。",
    disabled: "標準評估流程尚未啟用（ce_canonical_pipeline_enabled = false），啟用後才會出現資料。",
    loading: "載入中…",
  },
} as const;

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#dc2626",
  high: "#ea580c",
  medium: "#d97706",
  low: "#16a34a",
};

function ConversationEvaluationList() {
  const { role, loading: roleLoading } = useEffectiveRole();
  const lang = useConsoleLang();
  const t = T[lang];

  const [tab, setTab] = useState<CeTab>("all");
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<string>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [rows, setRows] = useState<CeStatusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const allowed = role === "admin" || role === "supervisor" || role === "qa";

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setLoading(true);
    listCeEvaluationsFn({
      data: {
        tab,
        limit: 50,
        ...(search ? { search } : {}),
        ...(severity ? { severity: severity as "critical" | "high" | "medium" | "low" } : {}),
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      },
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) setError(res.error ?? "load_failed");
        else {
          setError(null);
          setRows((res.data ?? []) as CeStatusRow[]);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "load_failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [allowed, tab, search, severity, fromDate, toDate]);

  const counts = useMemo(() => rows.length, [rows]);

  if (roleLoading) return <div style={{ padding: 24, fontSize: 13, color: "#6b7280" }}>{t.loading}</div>;
  if (!allowed) return <PermissionDenied />;

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{t.title}</h1>

      {/* Canonical tabs — each bound to one DB column of ce_conversation_status_v */}
      <div style={{ display: "flex", gap: 6, borderBottom: "1px solid #e5e7eb" }}>
        {CE_TABS.map((k) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            style={{
              border: "none",
              background: "transparent",
              padding: "8px 12px",
              fontSize: 12.5,
              fontWeight: tab === k ? 700 : 500,
              color: tab === k ? "#1a1a1a" : "#6b7280",
              borderBottom: tab === k ? "2px solid #2563eb" : "2px solid transparent",
              cursor: "pointer",
            }}
          >
            {t[k]}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t.search}
          style={{ fontSize: 12, padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 6, minWidth: 220 }}
        />
        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          style={{ fontSize: 12, padding: "6px 8px", border: "1px solid #d1d5db", borderRadius: 6 }}
        >
          <option value="">
            {t.severity}: {t.any}
          </option>
          {["critical", "high", "medium", "low"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 11, color: "#6b7280" }}>
          {t.from}{" "}
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ fontSize: 12 }} />
        </label>
        <label style={{ fontSize: 11, color: "#6b7280" }}>
          {t.to} <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ fontSize: 12 }} />
        </label>
        <span style={{ fontSize: 11, color: "#9ca3af" }}>{counts} rows</span>
      </div>

      {error && (
        <div style={{ fontSize: 12, color: "#b91c1c", background: "#fef2f2", padding: 10, borderRadius: 6 }}>
          {error}
        </div>
      )}

      <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead style={{ background: "#f9fafb", color: "#6b7280" }}>
            <tr>
              {[t.score, t.severity, t.intent, t.channel, t.language, t.date, t.improved, ""].map((h, i) => (
                <th key={i} style={{ textAlign: "left", padding: "8px 10px", fontWeight: 600 }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8} style={{ padding: 18, color: "#9ca3af" }}>
                  {t.loading}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ padding: 18, color: "#9ca3af" }}>
                  {t.empty} {t.disabled}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.evaluation_id} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "8px 10px", fontWeight: 700 }}>{r.overall_score}</td>
                  <td style={{ padding: "8px 10px", color: SEVERITY_COLOR[r.severity] ?? "#374151" }}>{r.severity}</td>
                  <td style={{ padding: "8px 10px", color: "#6b7280" }}>—</td>
                  <td style={{ padding: "8px 10px", color: "#6b7280" }}>website_widget</td>
                  <td style={{ padding: "8px 10px", color: "#6b7280" }}>—</td>
                  <td style={{ padding: "8px 10px", color: "#6b7280" }}>
                    {new Date(r.evaluated_at).toLocaleString()}
                  </td>
                  <td style={{ padding: "8px 10px", color: "#6b7280" }}>{improvedResultState(r)}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <Link
                      to="/console/conversation-evaluation/$evaluationId"
                      params={{ evaluationId: r.evaluation_id }}
                      style={{ color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
