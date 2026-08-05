import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useConsoleLang, useEffectiveRole } from "@/hooks/useEffectiveRole";
import { getCeEvaluationFn, getCeReplayBundleFn } from "@/lib/api/ce.functions";
import { CE_WEIGHTS } from "@/lib/ce/scoring";
import { PermissionDenied } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/conversation-evaluation/$evaluationId")({
  head: () => ({
    meta: [
      { title: "Evaluation Detail — AI Chatbot Console" },
      {
        name: "description",
        content:
          "Per-conversation evaluation detail: scores, QA finding, emotion journey, next steps and Replay Studio evidence.",
      },
      { property: "og:title", content: "Evaluation Detail — AI Chatbot Console" },
      {
        property: "og:description",
        content: "Scores, discrepancy and root-cause analysis, KB publish state and immutable replay evidence.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: EvaluationDetail;
});

const TABS = ["overview", "evaluation", "emotion", "next_steps", "replay"] as const;
type DetailTab = (typeof TABS)[number];

const T = {
  en: {
    overview: "Overview",
    evaluation: "Evaluation",
    emotion: "Emotion Journey",
    next_steps: "Next Steps",
    replay: "Replay Studio",
    aiResponse: "AI Response",
    qaFinding: "QA Finding",
    discrepancy: "Discrepancy Analysis",
    rootCause: "Root Cause Analysis",
    qaCase: "QA case",
    createQaCase: "Create QA case",
    kbState: "KB publish / rollback state",
    trainingCandidates: "Training candidates",
    kbGaps: "KB gaps",
    improved: "Improved result",
    back: "Back to Conversation Evaluation",
    hashOk: "Snapshot hash verified against stored content",
    hashUnavailable: "No stored replay bundle for this attempt",
    rawAdminOnly: "Raw evaluator payload is admin-only and is not exposed here.",
    loading: "Loading…",
  },
  zh: {
    overview: "總覽",
    evaluation: "評估",
    emotion: "情緒歷程",
    next_steps: "後續行動",
    replay: "重播工作室",
    aiResponse: "AI 回覆",
    qaFinding: "QA 發現",
    discrepancy: "差異分析",
    rootCause: "根本原因分析",
    qaCase: "QA 個案",
    createQaCase: "建立 QA 個案",
    kbState: "知識庫發佈 / 回退狀態",
    trainingCandidates: "訓練候選",
    kbGaps: "知識缺口",
    improved: "改進結果",
    back: "返回對話評估",
    hashOk: "快照雜湊已與儲存內容核對一致",
    hashUnavailable: "此次評估沒有儲存的重播內容",
    rawAdminOnly: "原始評估器內容僅限管理員，不會在此顯示。",
    loading: "載入中…",
  },
} as const;

type EvaluationRow = {
  id: string;
  conversation_id: string;
  attempt_id: string;
  overall_score: number;
  severity: string;
  accuracy_score: number;
  policy_score: number;
  tone_score: number;
  sales_score: number;
  context_score: number;
  hallucination_risk_score: number;
  hallucination_quality_score: number;
  training_eligible: boolean;
  has_verified_human_response: boolean;
  model_version: string;
  prompt_version: string;
  evaluation_contract_version: string;
  created_at: string;
};

type DetailRow = {
  evaluator_type: string;
  raw_score: number;
  weight: number;
  weighted_score: number;
  justification: string | null;
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 14, background: "#fff" }}>
      <h2 style={{ fontSize: 12.5, fontWeight: 700, margin: "0 0 8px", color: "#374151" }}>{title}</h2>
      <div style={{ fontSize: 12, color: "#4b5563", lineHeight: 1.7 }}>{children}</div>
    </section>
  );
}

function EvaluationDetail() {
  const { evaluationId } = useParams({ from: "/_authenticated/console/conversation-evaluation/$evaluationId" });
  const { role, loading: roleLoading } = useEffectiveRole();
  const lang = useConsoleLang();
  const t = T[lang];

  const [tab, setTab] = useState<DetailTab>("overview");
  const [evaluation, setEvaluation] = useState<EvaluationRow | null>(null);
  const [details, setDetails] = useState<DetailRow[]>([]);
  const [replay, setReplay] = useState<{ ok: boolean; error?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const allowed = role === "admin" || role === "supervisor" || role === "qa";

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setLoading(true);
    getCeEvaluationFn({ data: { evaluationId } })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error ?? "load_failed");
          return;
        }
        setError(null);
        setEvaluation(res.data.evaluation as EvaluationRow);
        setDetails((res.data.details ?? []) as DetailRow[]);
        return getCeReplayBundleFn({ data: { attemptId: (res.data.evaluation as EvaluationRow).attempt_id } });
      })
      .then((r) => {
        if (cancelled || !r) return;
        setReplay({ ok: r.ok, ...(r.error ? { error: r.error } : {}) });
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
  }, [allowed, evaluationId]);

  if (roleLoading) return <div style={{ padding: 24, fontSize: 13, color: "#6b7280" }}>{t.loading}</div>;
  if (!allowed) return <PermissionDenied />;

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      <Link
        to="/console/conversation-evaluation"
        style={{ fontSize: 12, color: "#2563eb", textDecoration: "none", fontWeight: 600 }}
      >
        ← {t.back}
      </Link>

      {error && (
        <div style={{ fontSize: 12, color: "#b91c1c", background: "#fef2f2", padding: 10, borderRadius: 6 }}>
          {error}
        </div>
      )}

      <div style={{ display: "flex", gap: 6, borderBottom: "1px solid #e5e7eb" }}>
        {TABS.map((k) => (
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

      {loading && <div style={{ fontSize: 12, color: "#9ca3af" }}>{t.loading}</div>}

      {tab === "overview" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Card title={t.aiResponse}>
            {evaluation ? (
              <>
                <div>
                  Overall <strong>{evaluation.overall_score}</strong> · severity <strong>{evaluation.severity}</strong>
                </div>
                <div>
                  contract {evaluation.evaluation_contract_version} · model {evaluation.model_version} · prompt{" "}
                  {evaluation.prompt_version}
                </div>
              </>
            ) : (
              "—"
            )}
          </Card>
          <Card title={t.qaFinding}>
            {evaluation
              ? `Training eligible: ${evaluation.training_eligible ? "yes" : "no"} · verified human response: ${
                  evaluation.has_verified_human_response ? "yes" : "no"
                }`
              : "—"}
          </Card>
          <Card title={t.discrepancy}>
            {evaluation
              ? `AI reply vs. verified human response divergence is driven by the lowest weighted dimensions: ${details
                  .slice()
                  .sort((a, b) => a.weighted_score - b.weighted_score)
                  .slice(0, 2)
                  .map((d) => d.evaluator_type)
                  .join(", ") || "—"}.`
              : "—"}
          </Card>
          <Card title={t.rootCause}>
            {evaluation && evaluation.hallucination_risk_score > 40
              ? "Primary root cause: unverifiable or missing grounding evidence (hallucination risk high)."
              : evaluation
                ? "Primary root cause: dimension-level quality gap; see Evaluation tab for weighted contributions."
                : "—"}
          </Card>
          <Card title={t.kbState}>KB snapshot is pinned per evaluation; publish/rollback state is read-only here.</Card>
          <Card title={t.qaCase}>
            <button
              style={{
                fontSize: 12,
                padding: "5px 10px",
                borderRadius: 6,
                border: "1px solid #d1d5db",
                background: "#fff",
                cursor: "pointer",
              }}
            >
              {t.createQaCase}
            </button>
          </Card>
          <Card title={t.improved}>
            {evaluation?.training_eligible ? "pending" : "not_applicable"} — delivered state comes from the training
            outbox, never from a frontend predicate.
          </Card>
          <Card title="Integration surfaces">
            <div style={{ display: "flex", gap: 12 }}>
              <Link to="/console/training-candidates" style={{ color: "#2563eb" }}>
                {t.trainingCandidates}
              </Link>
              <Link to="/console/kb-gaps" style={{ color: "#2563eb" }}>
                {t.kbGaps}
              </Link>
            </div>
          </Card>
        </div>
      )}

      {tab === "evaluation" && (
        <Card title={t.evaluation}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead style={{ color: "#6b7280" }}>
              <tr>
                {["Evaluator", "Raw", "Weight", "Weighted", "Justification"].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "6px 8px" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(details.length
                ? details
                : Object.entries(CE_WEIGHTS).map(([k, w]) => ({
                    evaluator_type: k,
                    raw_score: 0,
                    weight: w,
                    weighted_score: 0,
                    justification: null,
                  }))
              ).map((d) => (
                <tr key={d.evaluator_type} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "6px 8px" }}>{d.evaluator_type}</td>
                  <td style={{ padding: "6px 8px" }}>{d.raw_score}</td>
                  <td style={{ padding: "6px 8px" }}>{d.weight}</td>
                  <td style={{ padding: "6px 8px" }}>{d.weighted_score}</td>
                  <td style={{ padding: "6px 8px", color: "#6b7280" }}>{d.justification ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: 8, color: "#9ca3af" }}>
            hallucination quality = 100 − risk ({evaluation?.hallucination_quality_score ?? "—"})
          </p>
        </Card>
      )}

      {tab === "emotion" && (
        <Card title={t.emotion}>
          Emotion journey is derived from the stored replay transcript turns, so it stays reproducible with the
          evaluation snapshot rather than from live message state.
        </Card>
      )}

      {tab === "next_steps" && (
        <Card title={t.next_steps}>
          {evaluation?.training_eligible
            ? "Accepted + training eligible: queued for the training outbox once delivery automation is enabled."
            : "No training action: overall score ≥ 70 or no verified human response exists."}
        </Card>
      )}

      {tab === "replay" && (
        <Card title={t.replay}>
          {replay?.ok ? <div>{t.hashOk}</div> : <div style={{ color: "#9ca3af" }}>{t.hashUnavailable}</div>}
          <p style={{ marginTop: 8, color: "#9ca3af" }}>{t.rawAdminOnly}</p>
        </Card>
      )}
    </div>
  );
}
