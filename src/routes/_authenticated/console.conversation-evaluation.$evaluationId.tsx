import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConsoleLang, useEffectiveRole } from "@/hooks/useEffectiveRole";
import {
  getCeEvaluationFn,
  getCeReplayBundleFn,
  submitCeReviewFn,
  createCeQaCaseFn,
  recordCeRootCauseFn,
} from "@/lib/api/ce.functions";
import { CE_WEIGHTS } from "@/lib/ce/scoring";
import { PermissionDenied } from "@/components/console/PageStates";

export const Route = createFileRoute("/_authenticated/console/conversation-evaluation/$evaluationId")({
  head: () => ({
    meta: [
      { title: "Evaluation Detail — AI Chatbot Console" },
      { name: "description", content: "Per-conversation evaluation detail with scores, replay, emotion and analysis." },
    ],
  }),
  component: EvaluationDetail,
});

const TABS = [
  "overview", "evaluation", "emotion", "next_steps", "replay",
  "analysis", "integration", "attempts", "audit",
] as const;
type DetailTab = (typeof TABS)[number];

const T = {
  en: {
    overview: "Overview", evaluation: "Evaluation", emotion: "Emotion Journey",
    next_steps: "Next Steps", replay: "Replay Studio", analysis: "Analysis",
    integration: "Integration", attempts: "Attempts", audit: "Audit",
    aiResponse: "Evaluated AI Reply", humanResponse: "Verified Human Response",
    noAi: "No AI reply found.", noHuman: "No identity-verified human response.",
    transcript: "Transcript", liveWarning: "Live transcript. Scores refer to the frozen snapshot.",
    qaFinding: "QA Finding", discrepancy: "Discrepancy Analysis",
    rootCause: "Root Cause Analysis", qaCase: "QA Case",
    createQaCase: "Create QA case", recordRootCause: "Record root cause",
    kbState: "KB publish / rollback", training: "Training candidate",
    kbGap: "KB gap", improved: "Improved result",
    improvedPending: "Pending — arrives from the training round trip.",
    back: "Back to Conversation Evaluation",
    hashOk: "Snapshot verified", hashMismatch: "Snapshot hash mismatch — evidence may have drifted.",
    hashUnavailable: "No stored replay bundle for this attempt.",
    rawAdminOnly: "Raw evaluator payload is admin-only.",
    loading: "Loading…", noData: "—",
    provContract: "Contract", provModel: "Model", provPrompt: "Prompt",
    provDeployment: "Deployment", provKb: "KB evidence hash", provPolicy: "Policy evidence hash",
    provBundle: "Bundle hash", provSnapshot: "Snapshot hash",
    reviewTitle: "Review decision", reviewCurrent: "Current",
    reviewAccept: "Accept", reviewReject: "Reject", reviewReopen: "Reopen",
    reviewNote: "Reviewer note (required for reject, max 1000 chars)",
    reviewRecorded: "Review recorded", reviewReadOnly: "Read-only: requires admin or supervisor role.",
    reviewNoteRequired: "A note is required when rejecting.",
    sendToTraining: "Accept & send to training",
    severity: "Severity", score: "Score", justification: "Justification",
    correction: "Recommended correction", refs: "Grounding",
    none: "None recorded.", noDetails: "No per-dimension detail rows.",
    emotionEmpty: "No emotion points recorded.",
    nextStepsEmpty: "No next steps recorded.",
    trigger: "Trigger", owner: "Owner",
    discrepancyEmpty: "No discrepancies derived.",
    aiClaim: "AI said", humanClaim: "Human said", groundedClaim: "Evidence supports",
    rootCauseEmpty: "No root cause recorded.", category: "Category", summary: "Summary",
    qaCaseEmpty: "No QA case linked.", caseTitle: "Case title",
    kbPublishEmpty: "No publish or rollback requested.",
    remoteSync: "Remote sync", remoteBlocked: "Remote sync to Nexus KB / SU CoachAI pending.",
    recorded: "Recorded", attemptsEmpty: "No attempts.", auditEmpty: "No audit entries.",
    retryEval: "Retry evaluation", status: "Status", error: "Error", started: "Started",
    deliveryEmpty: "Not queued for training.", deliveryRestricted: "Visible to admin/supervisor only.",
    deliveryAttempts: "Attempts", delivered: "Delivered",
    replayTranscript: "Transcript", replayCanonical: "Canonical Input",
    replayGrounding: "Grounding Evidence", replayRetention: "Retained until",
    replayHint: "The stored snapshot is what evaluators actually read. It is redacted and immutable.",
  },
  zh: {
    overview: "總覽", evaluation: "評估", emotion: "情緒歷程",
    next_steps: "後續行動", replay: "重播工作室", analysis: "分析",
    integration: "整合", attempts: "執行紀錄", audit: "稽核",
    aiResponse: "受評 AI 回覆", humanResponse: "已驗證人工回覆",
    noAi: "未找到 AI 回覆。", noHuman: "此對話沒有已驗證身分的人工回覆。",
    transcript: "對話內容", liveWarning: "即時對話內容，分數依據為凍結快照。",
    qaFinding: "QA 發現", discrepancy: "落差分析",
    rootCause: "根因分析", qaCase: "QA 案件",
    createQaCase: "建立 QA 案件", recordRootCause: "記錄根因",
    kbState: "知識庫發布/回滾", training: "訓練候選",
    kbGap: "知識庫缺口", improved: "改善後結果",
    improvedPending: "等待中，改善後結果將由訓練回路回傳。",
    back: "返回對話評估",
    hashOk: "快照已驗證", hashMismatch: "快照雜湊不符，證據可能已變動。",
    hashUnavailable: "此次評估沒有儲存的重播內容。",
    rawAdminOnly: "原始評估器內容僅限管理員。",
    loading: "載入中…", noData: "—",
    provContract: "合約版本", provModel: "模型", provPrompt: "提示詞版本",
    provDeployment: "部署", provKb: "知識庫證據雜湊", provPolicy: "政策證據雜湊",
    provBundle: "套件雜湊", provSnapshot: "快照雜湊",
    reviewTitle: "覆核決定", reviewCurrent: "目前狀態",
    reviewAccept: "接受", reviewReject: "拒絕", reviewReopen: "重新開啟",
    reviewNote: "覆核備註（拒絕時必填，上限 1000 字）",
    reviewRecorded: "已記錄覆核", reviewReadOnly: "唯讀，需管理員或主管角色。",
    reviewNoteRequired: "拒絕時必須填寫備註。",
    sendToTraining: "接受並送交訓練",
    severity: "嚴重度", score: "分數", justification: "評分理由",
    correction: "建議修正", refs: "依據來源",
    none: "無紀錄。", noDetails: "沒有逐維度明細。",
    emotionEmpty: "沒有情緒紀錄。",
    nextStepsEmpty: "沒有後續行動。",
    trigger: "觸發原因", owner: "負責角色",
    discrepancyEmpty: "沒有推導出落差。",
    aiClaim: "AI 回覆", humanClaim: "人工回覆", groundedClaim: "證據支持",
    rootCauseEmpty: "沒有根因紀錄。", category: "類別", summary: "摘要",
    qaCaseEmpty: "尚未連結 QA 案件。", caseTitle: "案件標題",
    kbPublishEmpty: "尚未提出發布或回滾。",
    remoteSync: "遠端同步", remoteBlocked: "與 Nexus KB / SU CoachAI 的遠端同步待處理。",
    recorded: "已記錄", attemptsEmpty: "沒有執行紀錄。", auditEmpty: "沒有稽核紀錄。",
    retryEval: "重新評估", status: "狀態", error: "錯誤", started: "開始時間",
    deliveryEmpty: "尚未排入訓練佇列。", deliveryRestricted: "僅限管理員與主管檢視。",
    deliveryAttempts: "嘗試次數", delivered: "已派送",
    replayTranscript: "對話", replayCanonical: "標準輸入",
    replayGrounding: "依據證據", replayRetention: "保留至",
    replayHint: "此快照即評估器實際讀取的內容，已去識別化且不可修改。",
  },
} as const;

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#dc2626", high: "#ea580c", medium: "#d97706", low: "#16a34a",
};
const REVIEW_COLOR: Record<string, string> = {
  pending: "#6b7280", accepted: "#16a34a", rejected: "#dc2626",
};
const EVALUATOR_ORDER = ["accuracy", "policy", "tone", "sales", "context", "hallucination"] as const;

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 14, background: "#fff" }}>
      <h2 style={{ fontSize: 12.5, fontWeight: 700, margin: "0 0 8px", color: "#374151" }}>{title}</h2>
      <div style={{ fontSize: 12, color: "#4b5563", lineHeight: 1.7 }}>{children}</div>
    </section>
  );
}

function Prov({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
      <span style={{ color: "#9ca3af" }}>{label}</span>
      <span style={{ fontFamily: "monospace", fontSize: 11, maxWidth: "60%", wordBreak: "break-all", textAlign: "right" }}>
        {value || "—"}
      </span>
    </div>
  );
}

function Badge({ text, color, bg }: { text: string; color: string; bg: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 12, color, background: bg }}>
      {text}
    </span>
  );
}

function EvaluationDetail() {
  const { evaluationId } = useParams({ from: "/_authenticated/console/conversation-evaluation/$evaluationId" });
  const { role, loading: roleLoading } = useEffectiveRole();
  const lang = useConsoleLang();
  const t = T[lang];

  const [tab, setTab] = useState<DetailTab>("overview");
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [snapshot, setSnapshot] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [rcCategory, setRcCategory] = useState("kb_gap");
  const [rcSummary, setRcSummary] = useState("");
  const [qaTitle, setQaTitle] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const allowed = role === "admin" || role === "supervisor" || role === "qa";
  const canReview = role === "admin" || role === "supervisor";

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    setLoading(true);
    getCeEvaluationFn({ data: { evaluationId } })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) { setError(res.error ?? "load_failed"); return; }
        setError(null);
        setD(res.data as Record<string, any>);
        const ev = res.data?.evaluation as any;
        if (ev?.attempt_id) {
          return getCeReplayBundleFn({ data: { attemptId: ev.attempt_id } });
        }
      })
      .then((r) => {
        if (cancelled || !r) return;
        if (r.ok) setSnapshot((r.data as any)?.snapshot ?? null);
      })
      .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error ? e.message : "load_failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [allowed, evaluationId, reloadKey]);

  const ev = d?.evaluation ?? null;
  const details = useMemo(() =>
    [...(d?.details ?? [])].sort((a: any, b: any) =>
      EVALUATOR_ORDER.indexOf(a.evaluator_type) - EVALUATOR_ORDER.indexOf(b.evaluator_type)),
    [d?.details]);
  const messages = useMemo(() =>
    (d?.messages ?? []).filter((m: any) => !m.is_recalled && m.content !== "__THINKING__"),
    [d?.messages]);
  const aiReply = useMemo(() => [...messages].reverse().find((m: any) => m.role === "assistant"), [messages]);
  const humanReply = useMemo(() =>
    messages.find((m: any) =>
      m.sender_id && m.sender_identity_verified_at &&
      (!aiReply || m.created_at > aiReply.created_at)),
    [messages, aiReply]);

  const submitReview = async (decision: "accept" | "reject" | "reopen") => {
    if (!ev) return;
    if (decision === "reject" && !reviewNote.trim()) { alert(t.reviewNoteRequired); return; }
    setSubmitting(true);
    try {
      const res = await submitCeReviewFn({
        data: { evaluationId, conversationId: ev.conversation_id, decision, note: reviewNote.trim() || undefined },
      });
      if (res.ok) { setReviewNote(""); reload(); }
      else alert(res.error ?? "review_failed");
    } finally { setSubmitting(false); }
  };

  const createQaCase = async () => {
    if (!ev || !qaTitle.trim()) return;
    setSubmitting(true);
    try {
      const res = await createCeQaCaseFn({
        data: { evaluationId, conversationId: ev.conversation_id, title: qaTitle.trim() },
      });
      if (res.ok) { setQaTitle(""); reload(); }
      else alert(res.error ?? "create_failed");
    } finally { setSubmitting(false); }
  };

  const recordRootCause = async () => {
    if (!ev || !rcSummary.trim()) return;
    setSubmitting(true);
    try {
      const res = await recordCeRootCauseFn({
        data: { evaluationId, conversationId: ev.conversation_id, category: rcCategory as any, summary: rcSummary.trim() },
      });
      if (res.ok) { setRcSummary(""); reload(); }
      else alert(res.error ?? "record_failed");
    } finally { setSubmitting(false); }
  };

  if (roleLoading) return <div style={{ padding: 24, fontSize: 13, color: "#6b7280" }}>{t.loading}</div>;
  if (!allowed) return <PermissionDenied />;

  return (
    <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
      <Link to="/console/conversation-evaluation" style={{ fontSize: 12, color: "#2563eb", textDecoration: "none", fontWeight: 600 }}>
        ← {t.back}
      </Link>

      {error && <div style={{ fontSize: 12, color: "#b91c1c", background: "#fef2f2", padding: 10, borderRadius: 6 }}>{error}</div>}

      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #e5e7eb", flexWrap: "wrap" }}>
        {TABS.map((k) => (
          <button key={k} onClick={() => setTab(k)} style={{
            border: "none", background: "transparent", padding: "7px 10px", fontSize: 12,
            fontWeight: tab === k ? 700 : 500, color: tab === k ? "#1a1a1a" : "#6b7280",
            borderBottom: tab === k ? "2px solid #2563eb" : "2px solid transparent", cursor: "pointer",
          }}>{t[k]}</button>
        ))}
      </div>

      {loading && <div style={{ fontSize: 12, color: "#9ca3af" }}>{t.loading}</div>}

      {/* ── Overview ── */}
      {tab === "overview" && ev && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Card title={t.aiResponse}>
            {aiReply ? (
              <>
                <div style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(aiReply.created_at).toLocaleString()}</div>
                <p style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{aiReply.content}</p>
              </>
            ) : <span style={{ color: "#9ca3af" }}>{t.noAi}</span>}
          </Card>
          <Card title={t.humanResponse}>
            {humanReply ? (
              <>
                <div style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(humanReply.created_at).toLocaleString()}</div>
                <p style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{humanReply.content}</p>
              </>
            ) : <span style={{ color: "#9ca3af" }}>{t.noHuman}</span>}
          </Card>
          <div style={{ gridColumn: "1 / -1" }}>
            <Card title={t.transcript}>
              <div style={{ fontSize: 11, color: "#d97706", marginBottom: 6 }}>{t.liveWarning}</div>
              <div style={{ maxHeight: 300, overflowY: "auto" }}>
                {messages.map((m: any) => (
                  <div key={m.id} style={{ padding: "6px 0", borderBottom: "1px solid #f3f4f6" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#9ca3af" }}>
                      <span style={{ fontWeight: 600, textTransform: "uppercase" }}>{m.role}</span>
                      <span>{new Date(m.created_at).toLocaleString()}</span>
                    </div>
                    <p style={{ whiteSpace: "pre-wrap", marginTop: 2 }}>{m.content}</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ── Evaluation ── */}
      {tab === "evaluation" && ev && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Card title={t.score + " " + t.evaluation}>
            {details.length === 0 ? <span style={{ color: "#9ca3af" }}>{t.noDetails}</span> : (
              <div>
                {details.map((dd: any) => (
                  <div key={dd.evaluator_type} style={{ border: "1px solid #f3f4f6", borderRadius: 6, padding: 10, marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontWeight: 600 }}>{dd.evaluator_type}</span>
                      <span>{Number(dd.raw_score).toFixed(2)} × {Number(dd.weight).toFixed(2)} = {Number(dd.weighted_score).toFixed(2)}</span>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 11, color: "#6b7280" }}>
                      <div><strong>{t.justification}:</strong> {dd.justification || t.none}</div>
                      {dd.recommended_correction && <div style={{ marginTop: 4 }}><strong>{t.correction}:</strong> {dd.recommended_correction}</div>}
                      <div style={{ marginTop: 4, display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                        <strong>{t.refs}:</strong>
                        {(dd.grounding_refs ?? []).length === 0 ? <span>{t.none}</span> :
                          (dd.grounding_refs ?? []).map((r: string) => (
                            <span key={r} style={{ background: "#f3f4f6", padding: "1px 6px", borderRadius: 4, fontFamily: "monospace", fontSize: 10 }}>{r}</span>
                          ))}
                        <span style={{ marginLeft: "auto", fontFamily: "monospace", fontSize: 10 }}>
                          {dd.evaluator_model_version ?? ""} · {dd.evaluator_prompt_version ?? ""}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
                <div style={{ borderTop: "1px solid #e5e7eb", paddingTop: 8, marginTop: 8 }}>
                  <Prov label={t.provContract} value={ev.evaluation_contract_version} />
                  <Prov label={t.provModel} value={ev.model_version} />
                  <Prov label={t.provPrompt} value={ev.prompt_version} />
                  <Prov label={t.provDeployment} value={ev.source_deployment} />
                  <Prov label={t.provKb} value={ev.kb_snapshot_id} />
                  <Prov label={t.provPolicy} value={ev.policy_snapshot_id} />
                  <Prov label={t.provBundle} value={ev.bundle_hash} />
                  <Prov label={t.provSnapshot} value={ev.input_snapshot_hash} />
                </div>
              </div>
            )}
          </Card>

          {/* Review */}
          <Card title={t.reviewTitle}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <span style={{ color: "#9ca3af" }}>{t.reviewCurrent}:</span>
              <Badge text={ev.review_status ?? "pending"} color={REVIEW_COLOR[ev.review_status] ?? "#6b7280"} bg="#f3f4f6" />
              {ev.reviewed_at && <span style={{ fontSize: 11, color: "#9ca3af" }}>{new Date(ev.reviewed_at).toLocaleString()}</span>}
            </div>
            {ev.review_note && <div style={{ background: "#f9fafb", padding: 8, borderRadius: 6, fontSize: 11, marginBottom: 8 }}>{ev.review_note}</div>}
            {!canReview ? <div style={{ color: "#9ca3af" }}>{t.reviewReadOnly}</div> : (
              <>
                <textarea value={reviewNote} onChange={(e) => setReviewNote(e.target.value)}
                  placeholder={t.reviewNote} maxLength={1000} rows={3}
                  style={{ width: "100%", fontSize: 12, padding: 8, border: "1px solid #d1d5db", borderRadius: 6, resize: "vertical" }} />
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button disabled={submitting || ev.review_status !== "pending"} onClick={() => submitReview("accept")}
                    style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #16a34a", background: "#f0fdf4", color: "#16a34a", cursor: "pointer" }}>
                    {ev.training_eligible ? t.sendToTraining : t.reviewAccept}
                  </button>
                  <button disabled={submitting || ev.review_status !== "pending"} onClick={() => submitReview("reject")}
                    style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #dc2626", background: "#fef2f2", color: "#dc2626", cursor: "pointer" }}>
                    {t.reviewReject}
                  </button>
                  <button disabled={submitting || ev.review_status === "pending"} onClick={() => submitReview("reopen")}
                    style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
                    {t.reviewReopen}
                  </button>
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      {/* ── Emotion ── */}
      {tab === "emotion" && (
        <Card title={t.emotion}>
          {(d?.emotion ?? []).length === 0 ? <span style={{ color: "#9ca3af" }}>{t.emotionEmpty}</span> : (
            <div>
              {(d?.emotion ?? []).map((e: any) => {
                const pct = Math.max(0, Math.min(100, (Number(e.sentiment_score) + 100) / 2));
                return (
                  <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                    <span style={{ width: 30, fontSize: 11, color: "#9ca3af" }}>#{e.turn_index}</span>
                    <div style={{ flex: 1, height: 6, background: "#f3f4f6", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: 6, borderRadius: 3, width: `${pct}%`,
                        background: Number(e.sentiment_score) < 0 ? "#f87171" : "#4ade80" }} />
                    </div>
                    <span style={{ width: 100, fontSize: 11 }}>{e.sentiment}</span>
                    <span style={{ width: 40, fontSize: 11, fontFamily: "monospace", textAlign: "right" }}>
                      {Number(e.sentiment_score).toFixed(0)}
                    </span>
                    <span style={{ flex: 1, fontSize: 11, color: "#9ca3af", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.trigger_label ? `${t.trigger}: ${e.trigger_label}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* ── Next Steps ── */}
      {tab === "next_steps" && (
        <Card title={t.next_steps}>
          {(d?.nextSteps ?? []).length === 0 ? <span style={{ color: "#9ca3af" }}>{t.nextStepsEmpty}</span> : (
            <ol style={{ margin: 0, padding: "0 0 0 18px" }}>
              {(d?.nextSteps ?? []).map((n: any) => (
                <li key={n.id} style={{ padding: "6px 0", borderBottom: "1px solid #f3f4f6" }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{n.title}</span>
                    <span style={{ color: "#9ca3af", fontSize: 11 }}>{t.owner}: {n.owner_role ?? "—"} · {n.status}</span>
                  </div>
                  {n.detail && <div style={{ color: "#6b7280", marginTop: 2 }}>{n.detail}</div>}
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {/* ── Replay Studio ── */}
      {tab === "replay" && (
        <Card title={t.replay}>
          {!snapshot ? <div style={{ color: "#9ca3af" }}>{t.hashUnavailable}</div> : (
            <>
              <div style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>{t.replayHint}</div>
              <div style={{ marginBottom: 8 }}>
                <Prov label={t.provBundle} value={snapshot.bundle_hash} />
                <Prov label={t.provSnapshot} value={snapshot.transcript_hash} />
                <Prov label={t.provModel} value={snapshot.model_version} />
                <Prov label={t.provPrompt} value={snapshot.prompt_version} />
                <Prov label={t.provKb} value={snapshot.kb_snapshot_id} />
                <Prov label={t.provPolicy} value={snapshot.policy_snapshot_id} />
                <Prov label={t.replayRetention} value={new Date(snapshot.retention_expires_at).toLocaleDateString()} />
              </div>
              {/* Sub-tabs */}
              {(() => {
                const [sub, setSub] = useState<"transcript"|"canonical"|"grounding">("transcript");
                return (
                  <>
                    <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                      {(["transcript","canonical","grounding"] as const).map((s) => (
                        <button key={s} onClick={() => setSub(s)} style={{
                          fontSize: 11, padding: "4px 10px", borderRadius: 4, cursor: "pointer",
                          border: sub === s ? "1px solid #2563eb" : "1px solid #d1d5db",
                          background: sub === s ? "#eff6ff" : "#fff", color: sub === s ? "#2563eb" : "#374151",
                        }}>{t[s === "transcript" ? "replayTranscript" : s === "canonical" ? "replayCanonical" : "replayGrounding"]}</button>
                      ))}
                    </div>
                    {sub === "transcript" && (
                      <div style={{ maxHeight: 300, overflowY: "auto" }}>
                        {(snapshot.normalized_transcript ?? []).map((m: any) => (
                          <div key={m.id} style={{ padding: "4px 0", borderBottom: "1px solid #f3f4f6" }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#9ca3af" }}>
                              <span style={{ fontWeight: 600, textTransform: "uppercase" }}>{m.role}</span>
                              <span>{new Date(m.created_at).toLocaleString()}</span>
                            </div>
                            <p style={{ whiteSpace: "pre-wrap", margin: "2px 0 0" }}>{m.content}</p>
                          </div>
                        ))}
                      </div>
                    )}
                    {sub === "canonical" && (
                      <pre style={{ maxHeight: 300, overflow: "auto", background: "#f9fafb", padding: 10, borderRadius: 6, fontSize: 11, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
                        {snapshot.canonical_input ?? ""}
                      </pre>
                    )}
                    {sub === "grounding" && (
                      <div style={{ maxHeight: 300, overflowY: "auto" }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>KB Evidence</div>
                        <pre style={{ background: "#f9fafb", padding: 8, borderRadius: 6, fontSize: 11, whiteSpace: "pre-wrap", fontFamily: "monospace", marginBottom: 8 }}>
                          {snapshot.grounding_evidence?.kb_block || snapshot.grounding_evidence?.kb || "—"}
                        </pre>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "#9ca3af", marginBottom: 4 }}>Policy Evidence</div>
                        <pre style={{ background: "#f9fafb", padding: 8, borderRadius: 6, fontSize: 11, whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
                          {snapshot.grounding_evidence?.policy_block || snapshot.grounding_evidence?.policy || "—"}
                        </pre>
                      </div>
                    )}
                  </>
                );
              })()}
            </>
          )}
          <div style={{ marginTop: 8, color: "#9ca3af", fontSize: 11 }}>{t.rawAdminOnly}</div>
        </Card>
      )}

      {/* ── Analysis ── */}
      {tab === "analysis" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Card title={t.discrepancy}>
            {(d?.discrepancies ?? []).length === 0 ? <span style={{ color: "#9ca3af" }}>{t.discrepancyEmpty}</span> : (
              (d?.discrepancies ?? []).map((disc: any) => (
                <div key={disc.id} style={{ border: "1px solid #f3f4f6", borderRadius: 6, padding: 8, marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600 }}>{disc.dimension}</span>
                    <Badge text={disc.severity} color={SEVERITY_COLOR[disc.severity] ?? "#374151"} bg="#f3f4f6" />
                    <span style={{ color: "#9ca3af" }}>{disc.divergence_kind}</span>
                    {(disc.grounding_refs ?? []).map((r: string) => (
                      <span key={r} style={{ background: "#f3f4f6", padding: "1px 6px", borderRadius: 4, fontFamily: "monospace", fontSize: 10 }}>{r}</span>
                    ))}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginTop: 6 }}>
                    <div style={{ background: "#fef2f2", padding: 6, borderRadius: 4 }}>
                      <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase" }}>{t.aiClaim}</div>
                      <div style={{ fontSize: 11, marginTop: 2 }}>{disc.ai_claim || "—"}</div>
                    </div>
                    <div style={{ background: "#f0fdf4", padding: 6, borderRadius: 4 }}>
                      <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase" }}>{t.humanClaim}</div>
                      <div style={{ fontSize: 11, marginTop: 2 }}>{disc.human_claim || "—"}</div>
                    </div>
                    <div style={{ background: "#eff6ff", padding: 6, borderRadius: 4 }}>
                      <div style={{ fontSize: 10, color: "#9ca3af", textTransform: "uppercase" }}>{t.groundedClaim}</div>
                      <div style={{ fontSize: 11, marginTop: 2 }}>{disc.grounded_claim || "—"}</div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </Card>

          <Card title={t.rootCause}>
            {(d?.rootCauses ?? []).length === 0 ? <span style={{ color: "#9ca3af" }}>{t.rootCauseEmpty}</span> :
              (d?.rootCauses ?? []).map((r: any) => (
                <div key={r.id} style={{ border: "1px solid #f3f4f6", borderRadius: 6, padding: 8, marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{r.category}</span>
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>{t.remoteSync}: {r.remote_sync_state}</span>
                  </div>
                  <div style={{ marginTop: 4, color: "#6b7280" }}>{r.summary}</div>
                </div>
              ))}
            {canReview && (
              <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                <select value={rcCategory} onChange={(e) => setRcCategory(e.target.value)}
                  style={{ fontSize: 12, padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: 6 }}>
                  {["kb_gap","kb_stale","policy_gap","prompt_defect","model_limitation","routing_error","human_error","unknown"].map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                <input value={rcSummary} onChange={(e) => setRcSummary(e.target.value)} placeholder={t.summary}
                  style={{ fontSize: 12, padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: 6, flex: 1, minWidth: 200 }} />
                <button disabled={submitting || !rcSummary.trim()} onClick={recordRootCause}
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
                  {t.recordRootCause}
                </button>
              </div>
            )}
          </Card>

          <Card title={t.qaCase}>
            {(d?.qaCases ?? []).length === 0 ? <span style={{ color: "#9ca3af" }}>{t.qaCaseEmpty}</span> :
              (d?.qaCases ?? []).map((q: any) => (
                <div key={q.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderBottom: "1px solid #f3f4f6" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 11 }}>{q.case_number}</span>
                  <span style={{ fontWeight: 600 }}>{q.title}</span>
                  <span>{q.status}</span>
                  <span>{q.priority}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "#9ca3af" }}>{t.remoteSync}: {q.remote_sync_state}</span>
                </div>
              ))}
            {canReview && (
              <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center" }}>
                <input value={qaTitle} onChange={(e) => setQaTitle(e.target.value)} placeholder={t.caseTitle}
                  style={{ fontSize: 12, padding: "5px 8px", border: "1px solid #d1d5db", borderRadius: 6, flex: 1, minWidth: 200 }} />
                <button disabled={submitting || !qaTitle.trim()} onClick={createQaCase}
                  style={{ fontSize: 12, padding: "5px 12px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
                  {t.createQaCase}
                </button>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ── Integration ── */}
      {tab === "integration" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Card title={t.training}>
            {(d?.trainingLinks ?? []).length === 0 ? <span style={{ color: "#9ca3af" }}>{t.deliveryEmpty}</span> :
              (d?.trainingLinks ?? []).map((l: any) => (
                <div key={l.id} style={{ border: "1px solid #f3f4f6", borderRadius: 6, padding: 8, marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontWeight: 600 }}>{l.link_kind === "training_candidate" ? t.training : t.kbGap}</span>
                    <span style={{ fontSize: 11, color: "#9ca3af" }}>{t.remoteSync}: {l.remote_sync_state}</span>
                  </div>
                  <div style={{ marginTop: 4 }}>{l.local_state}</div>
                  <div style={{ marginTop: 4, color: "#6b7280" }}>
                    <strong>{t.improved}:</strong>{" "}
                    {l.improved_state === "received" ? JSON.stringify(l.improved_result) : t.improvedPending}
                  </div>
                </div>
              ))}
            <div style={{ marginTop: 6, fontSize: 11, color: "#9ca3af" }}>{t.remoteBlocked}</div>
          </Card>

          <Card title={t.kbState}>
            {(d?.kbPublish ?? []).length === 0 ? <span style={{ color: "#9ca3af" }}>{t.kbPublishEmpty}</span> :
              (d?.kbPublish ?? []).map((k: any) => (
                <div key={k.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderBottom: "1px solid #f3f4f6", flexWrap: "wrap" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 11 }}>{k.kb_document_ref}</span>
                  <span>{k.action}</span>
                  <span>{k.state}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "#9ca3af" }}>{t.remoteSync}: {k.remote_sync_state}</span>
                  {k.last_error && <span style={{ color: "#dc2626" }}>{k.last_error}</span>}
                </div>
              ))}
          </Card>

          {/* Outbox */}
          <Card title={t.delivered}>
            {!canReview ? <span style={{ color: "#9ca3af" }}>{t.deliveryRestricted}</span> :
             (d?.outbox ?? []).length === 0 ? <span style={{ color: "#9ca3af" }}>{t.deliveryEmpty}</span> :
              (d?.outbox ?? []).map((o: any) => (
                <div key={o.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 11 }}>{String(o.id).slice(0,8)}…</span>
                  <span>{o.status}</span>
                  <span>{t.deliveryAttempts}: {o.delivery_attempts}/{o.max_attempts}</span>
                  {o.delivered_at && <span>{t.delivered}: {new Date(o.delivered_at).toLocaleString()}</span>}
                </div>
              ))}
          </Card>
        </div>
      )}

      {/* ── Attempts ── */}
      {tab === "attempts" && (
        <Card title={t.attempts}>
          {(d?.attempts ?? []).length === 0 ? <span style={{ color: "#9ca3af" }}>{t.attemptsEmpty}</span> :
            (d?.attempts ?? []).map((a: any) => (
              <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderBottom: "1px solid #f3f4f6", flexWrap: "wrap" }}>
                <span style={{ fontFamily: "monospace", fontSize: 11 }}>{String(a.id).slice(0,8)}…</span>
                <span>{t.status}: {a.status}</span>
                <span>{t.started}: {new Date(a.created_at).toLocaleString()}</span>
                {a.error_message && <span style={{ color: "#dc2626" }}>{t.error}: {a.error_message}</span>}
              </div>
            ))}
        </Card>
      )}

      {/* ── Audit ── */}
      {tab === "audit" && (
        <Card title={t.audit}>
          {(d?.audit ?? []).length === 0 ? <span style={{ color: "#9ca3af" }}>{t.auditEmpty}</span> :
            (d?.audit ?? []).map((a: any) => (
              <div key={a.id} style={{ padding: "6px 0", borderBottom: "1px solid #f3f4f6" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span>{a.action}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 11 }}>{String(a.actor_id ?? "—").slice(0,8)}…</span>
                  <span style={{ marginLeft: "auto", color: "#9ca3af" }}>{new Date(a.created_at).toLocaleString()}</span>
                </div>
                {a.diff && <div style={{ fontSize: 11, fontFamily: "monospace", color: "#6b7280", marginTop: 2 }}>
                  {String(a.diff?.from ?? "")} → {String(a.diff?.to ?? "")}
                </div>}
              </div>
            ))}
        </Card>
      )}
    </div>
  );
}
