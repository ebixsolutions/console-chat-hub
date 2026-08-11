/**
 * CE detail panel — PR-4 Round 2.
 * Conversation-first. Recalled messages show placeholder.
 * Section errors surfaced. evaluation_available from server.
 * No training UI. 5 tabs always visible.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  getCeConversationDetailFn,
  submitCeReviewFn,
  createCeQaCaseFn,
  recordCeRootCauseFn,
  type CeDetailSectionError,
} from "@/lib/api/ce.functions";
import { CE_REVIEW_COPY as C } from "@/lib/i18n/ceReviewCopy";
import { useConsoleLang } from "@/lib/i18n/consoleLang";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/* eslint-disable @typescript-eslint/no-explicit-any */

const EVALUATOR_ORDER = ["accuracy", "policy", "tone", "sales", "context", "hallucination"] as const;
const ROOT_CAUSE_CATEGORIES = [
  "kb_gap",
  "kb_stale",
  "policy_gap",
  "prompt_defect",
  "model_limitation",
  "routing_error",
  "human_error",
  "unknown",
] as const;

const SEVERITY_CLASS: Record<string, string> = {
  critical: "bg-red-100 text-red-700 border-red-200",
  high: "bg-orange-100 text-orange-700 border-orange-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-emerald-100 text-emerald-700 border-emerald-200",
};
const REVIEW_CLASS: Record<string, string> = {
  pending: "bg-slate-100 text-slate-700 border-slate-200",
  accepted: "bg-emerald-100 text-emerald-700 border-emerald-200",
  rejected: "bg-red-100 text-red-700 border-red-200",
};

export type CeDetailTab = "overview" | "evaluation" | "emotion" | "nextSteps" | "replay";
const TAB_ORDER: CeDetailTab[] = ["overview", "evaluation", "emotion", "nextSteps", "replay"];

function scoreTextClass(s: number): string {
  return s < 60 ? "text-red-600" : s < 80 ? "text-amber-600" : "text-emerald-600";
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[10px] border border-[#e8e6e0] bg-white p-3">
      <div className="mb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      </div>
      <div className="text-[12px] leading-relaxed text-slate-700">{children}</div>
    </section>
  );
}
function Prov({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-start justify-between gap-3 py-0.5">
      <span className="text-[11px] text-slate-500">{label}</span>
      <span className="max-w-[60%] break-all text-right font-mono text-[11px]">{value || "—"}</span>
    </div>
  );
}
function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[#f5f4f0] px-[10px] py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-0.5 truncate text-[12px] font-semibold text-slate-700">{value}</div>
    </div>
  );
}
function SectionError({ message }: { message: string }) {
  return <div className="rounded-md border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">{message}</div>;
}

export function CeDetailPanel({
  conversationId,
  canReview,
  onChanged,
}: {
  conversationId: string;
  canReview: boolean;
  onChanged?: () => void;
}) {
  const { t } = useConsoleLang();
  const [tab, setTab] = useState<CeDetailTab>("overview");
  const [d, setD] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [qaTitle, setQaTitle] = useState("");
  const [rcCategory, setRcCategory] = useState<string>("kb_gap");
  const [rcSummary, setRcSummary] = useState("");
  const [replaySub, setReplaySub] = useState<"transcript" | "canonical" | "grounding">("transcript");

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useEffect(() => {
    setTab("overview");
    setReviewNote("");
    setQaTitle("");
    setRcSummary("");
  }, [conversationId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await getCeConversationDetailFn({ data: { conversationId } });
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error ?? "load_failed");
          setD(null);
          return;
        }
        setError(null);
        setD(res.data as Record<string, any>);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "load_failed");
          setD(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, reloadKey]);

  const conv = d?.conversation ?? null;
  const ev = d?.evaluation ?? null;
  const hasEval = ev !== null;
  const snapshot = d?.snapshot ?? null;
  const evaluationAvailable = d?.evaluation_available === true;
  const sectionErrors: CeDetailSectionError[] = d?.sectionErrors ?? [];
  const sectionErr = (section: string) => sectionErrors.find((e) => e.section === section);

  const details = useMemo(
    () =>
      [...(d?.details ?? [])].sort(
        (a: any, b: any) => EVALUATOR_ORDER.indexOf(a.evaluator_type) - EVALUATOR_ORDER.indexOf(b.evaluator_type),
      ),
    [d?.details],
  );
  const messages = useMemo(() => (d?.messages ?? []) as any[], [d?.messages]);
  const aiReply = useMemo(
    () =>
      [...messages]
        .filter((m: any) => !m.is_recalled)
        .reverse()
        .find((m: any) => m.role === "assistant"),
    [messages],
  );
  const humanReply = useMemo(
    () =>
      messages
        .filter((m: any) => !m.is_recalled)
        .find(
          (m: any) => m.sender_id && m.sender_identity_verified_at && (!aiReply || m.created_at > aiReply.created_at),
        ),
    [messages, aiReply],
  );
  const qaFinding = useMemo(() => {
    if (details.length === 0) return null;
    const worst = [...details].sort((a: any, b: any) => Number(a.raw_score) - Number(b.raw_score))[0] as any;
    if (!worst?.justification && !worst?.recommended_correction) return null;
    return worst;
  }, [details]);

  const submitReview = async (decision: "accept" | "reject" | "reopen") => {
    if (!ev) return;
    if (decision === "reject" && !reviewNote.trim()) {
      toast.error(t(C.evaluation.noteRequired));
      return;
    }
    setSubmitting(true);
    try {
      const res = await submitCeReviewFn({
        data: { evaluationId: ev.id, conversationId, decision, note: reviewNote.trim() || undefined },
      });
      if (res.ok) {
        setReviewNote("");
        reload();
        onChanged?.();
      } else toast.error(res.error ?? "review_failed");
    } finally {
      setSubmitting(false);
    }
  };
  const createQaCase = async () => {
    if (!ev || !qaTitle.trim()) return;
    setSubmitting(true);
    try {
      const res = await createCeQaCaseFn({ data: { evaluationId: ev.id, conversationId, title: qaTitle.trim() } });
      if (res.ok) {
        setQaTitle("");
        reload();
      } else toast.error(res.error ?? "create_failed");
    } finally {
      setSubmitting(false);
    }
  };
  const recordRootCause = async () => {
    if (!ev || !rcSummary.trim()) return;
    setSubmitting(true);
    try {
      const res = await recordCeRootCauseFn({
        data: { evaluationId: ev.id, conversationId, category: rcCategory as any, summary: rcSummary.trim() },
      });
      if (res.ok) {
        setRcSummary("");
        reload();
      } else toast.error(res.error ?? "record_failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !d) return <div className="p-6 text-sm text-muted-foreground">{t(C.detail.loading)}</div>;
  if (error)
    return (
      <div className="m-4 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        {t(C.detail.loadFailed)} <span className="font-mono text-xs">{error}</span>
      </div>
    );
  if (!conv) return <div className="p-6 text-sm text-muted-foreground">{t(C.detail.selectPrompt)}</div>;

  const overall = hasEval ? Number(ev.overall_score) : null;
  const customerLabel = conv.customer_label || "—";

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[#f0efe9] px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold text-slate-800">{customerLabel}</div>
          <div className="truncate font-mono text-[11px] text-slate-400">
            {conversationId} · {conv.channel_name || "—"} · {conv.status}
          </div>
        </div>
        {hasEval && overall !== null ? (
          <span className={cn("rounded-md bg-[#f5f4f0] px-2 py-1 text-[13px] font-bold", scoreTextClass(overall))}>
            {overall.toFixed(1)}
          </span>
        ) : (
          <span className="rounded-md bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500">
            {t(C.detail.notEvaluated)}
          </span>
        )}
        {hasEval && (
          <div className="ml-auto flex items-center gap-1.5">
            <Badge variant="outline" className={cn("text-[10px]", REVIEW_CLASS[ev.review_status] ?? "")}>
              {ev.review_status}
            </Badge>
            <Badge variant="outline" className={cn("text-[10px]", SEVERITY_CLASS[ev.severity] ?? "")}>
              {ev.severity}
            </Badge>
          </div>
        )}
      </div>

      {/* 5 tabs always visible */}
      <div className="flex flex-wrap gap-1.5 border-b border-[#f0efe9] px-3 py-2">
        {TAB_ORDER.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={cn(
              "rounded-full border px-3 py-[4px] text-[11px] font-medium transition-colors",
              tab === k
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-[#e8e6e0] bg-white text-slate-600 hover:bg-[#fafaf8]",
            )}
          >
            {k === "replay" ? `▶ ${t(C.tabs[k])}` : t(C.tabs[k])}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-[#fdfdfb] p-4">
        {/* ── Overview ── */}
        {tab === "overview" && (
          <>
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0">
                <h2 className="truncate text-[15px] font-bold text-slate-800">{customerLabel}</h2>
                <div className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
                  {conversationId} · {conv.channel_name || "—"} · {conv.status} · {conv.priority || "—"}
                </div>
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {hasEval && (
                  <>
                    <Badge variant="outline" className={cn("text-[10px]", REVIEW_CLASS[ev.review_status] ?? "")}>
                      {ev.review_status}
                    </Badge>
                    <Badge variant="outline" className={cn("text-[10px]", SEVERITY_CLASS[ev.severity] ?? "")}>
                      {ev.severity}
                    </Badge>
                  </>
                )}
                <Badge variant="outline" className="border-sky-200 bg-sky-50 text-[10px] text-sky-700">
                  {conv.channel_name || t(C.meta.unavailable)}
                </Badge>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <MetaCard
                label={t(C.meta.date)}
                value={conv.created_at ? new Date(conv.created_at).toLocaleString() : "—"}
              />
              <MetaCard label={t(C.meta.tier)} value={t(C.meta.unavailable)} />
              <MetaCard label={t(C.meta.intent)} value={t(C.meta.unavailable)} />
              <MetaCard label={t(C.meta.language)} value={t(C.meta.unavailable)} />
            </div>
            {/* R3: evaluation unavailable notice */}
            {!evaluationAvailable && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-800">
                {t(C.detail.evaluateUnavailable)}
              </div>
            )}
            <Panel title={t(C.overview.thread)}>
              {hasEval && <p className="mb-2 text-[11px] text-amber-600">{t(C.overview.liveNote)}</p>}
              {messages.length === 0 ? (
                <span className="text-slate-500">{t(C.overview.noThread)}</span>
              ) : (
                <div className="space-y-2">
                  {messages.map((m: any) => {
                    // R6: recalled messages show placeholder
                    if (m.is_recalled) {
                      return (
                        <div key={m.id} className="rounded-lg border-l-[3px] border-l-slate-200 bg-slate-50 p-2.5">
                          <div className="text-[11px] italic text-slate-400">{t(C.detail.recalled)}</div>
                        </div>
                      );
                    }
                    const isAi = m.role === "assistant";
                    const isAgent = m.role === "agent";
                    const isEvaluated = hasEval && aiReply && m.id === aiReply.id;
                    const roleLabel = isAi
                      ? t(C.overview.aiResponse)
                      : isAgent
                        ? t(C.overview.humanAgent)
                        : t(C.overview.customer);
                    return (
                      <div key={m.id} className="space-y-0">
                        <div
                          className={cn(
                            "rounded-lg p-2.5",
                            isAi
                              ? "border border-[#e8e6e0] bg-[#f5f4f0]"
                              : isAgent
                                ? "border-l-[3px] border-l-emerald-300 bg-emerald-50"
                                : "border-l-[3px] border-l-[#cbd5e1] bg-[#F0F4F8]",
                            isEvaluated && qaFinding && "rounded-b-none",
                          )}
                        >
                          <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                            <span className="flex items-center gap-1.5 font-semibold uppercase">
                              {roleLabel}
                              {isEvaluated && overall !== null && (
                                <span
                                  className={cn(
                                    "rounded-full bg-white px-1.5 py-[1px] text-[10px] font-bold",
                                    scoreTextClass(overall),
                                  )}
                                >
                                  {overall.toFixed(1)}
                                </span>
                              )}
                            </span>
                            <span>{m.created_at ? new Date(m.created_at).toLocaleString() : ""}</span>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap text-slate-700">{m.content}</p>
                        </div>
                        {isEvaluated && qaFinding && (
                          <div className="rounded-b-lg border border-t-0 border-[#fcd34d] bg-[#fffbeb] p-2.5 text-[12px] text-amber-900">
                            <div className="text-[10px] font-semibold uppercase tracking-wide">
                              {t(C.overview.qaFinding)} · {qaFinding.evaluator_type}
                            </div>
                            <div className="mt-1">{qaFinding.justification || "—"}</div>
                            {qaFinding.recommended_correction && (
                              <div className="mt-1">
                                <strong>{t(C.evaluation.correction)}:</strong> {qaFinding.recommended_correction}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {humanReply && (
                <div className="mt-3 rounded-lg border border-[#a7d88a] bg-[#EAF3DE] p-2.5 text-[12px] text-emerald-900">
                  <div className="text-[10px] font-semibold uppercase tracking-wide">
                    {t(C.overview.humanCorrection)}
                  </div>
                  <div className="mt-1 whitespace-pre-wrap">{humanReply.content}</div>
                </div>
              )}
            </Panel>
            {/* QA Cases */}
            <Panel title={t(C.overview.qaCases)}>
              {sectionErr("qaCases") ? (
                <SectionError message={sectionErr("qaCases")!.message} />
              ) : !hasEval ? (
                <span className="text-muted-foreground">{t(C.detail.notEvaluatedYet)}</span>
              ) : (d?.qaCases ?? []).length === 0 ? (
                <span className="text-muted-foreground">{t(C.overview.qaCasesEmpty)}</span>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(d?.qaCases ?? []).map((q: any) => (
                    <span
                      key={q.id}
                      className="flex items-center gap-2 rounded-full border bg-muted/40 px-2.5 py-1 text-[11px]"
                    >
                      <span className="font-mono">{q.case_number}</span>
                      <span className="font-medium">{q.title}</span>
                      <span className="text-muted-foreground">{q.status}</span>
                    </span>
                  ))}
                </div>
              )}
              {canReview && hasEval && (
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    value={qaTitle}
                    onChange={(e) => setQaTitle(e.target.value)}
                    placeholder={t(C.overview.qaCaseTitle)}
                    className="h-8 text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={submitting || !qaTitle.trim()}
                    onClick={() => void createQaCase()}
                  >
                    {t(C.overview.createQaCase)}
                  </Button>
                </div>
              )}
            </Panel>
            {/* Discrepancy */}
            <Panel title={t(C.overview.discrepancy)}>
              {sectionErr("discrepancies") ? (
                <SectionError message={sectionErr("discrepancies")!.message} />
              ) : !hasEval ? (
                <span className="text-muted-foreground">{t(C.detail.notEvaluatedYet)}</span>
              ) : (d?.discrepancies ?? []).length === 0 ? (
                <span className="text-muted-foreground">{t(C.overview.discrepancyEmpty)}</span>
              ) : (
                <div className="space-y-2">
                  {(d?.discrepancies ?? []).map((disc: any) => (
                    <div key={disc.id} className="rounded-md border p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold">{disc.dimension}</span>
                        <Badge variant="outline" className={cn("text-[10px]", SEVERITY_CLASS[disc.severity] ?? "")}>
                          {disc.severity}
                        </Badge>
                      </div>
                      <div className="mt-2 grid gap-2 md:grid-cols-3">
                        <div className="rounded bg-red-50 p-2">
                          <div className="text-[10px] uppercase text-muted-foreground">{t(C.overview.aiClaim)}</div>
                          <div className="mt-0.5 text-[12px]">{disc.ai_claim || "—"}</div>
                        </div>
                        <div className="rounded bg-emerald-50 p-2">
                          <div className="text-[10px] uppercase text-muted-foreground">{t(C.overview.humanClaim)}</div>
                          <div className="mt-0.5 text-[12px]">{disc.human_claim || "—"}</div>
                        </div>
                        <div className="rounded bg-blue-50 p-2">
                          <div className="text-[10px] uppercase text-muted-foreground">
                            {t(C.overview.groundedClaim)}
                          </div>
                          <div className="mt-0.5 text-[12px]">{disc.grounded_claim || "—"}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            {/* Root cause */}
            <Panel title={t(C.overview.rootCause)}>
              {sectionErr("rootCauses") ? (
                <SectionError message={sectionErr("rootCauses")!.message} />
              ) : !hasEval ? (
                <span className="text-muted-foreground">{t(C.detail.notEvaluatedYet)}</span>
              ) : (d?.rootCauses ?? []).length === 0 ? (
                <span className="text-muted-foreground">{t(C.overview.rootCauseEmpty)}</span>
              ) : (
                <div className="space-y-2">
                  {(d?.rootCauses ?? []).map((r: any) => (
                    <div key={r.id} className="rounded-md border p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold">{r.category}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {t(C.overview.remoteSync)}: {r.remote_sync_state}
                        </span>
                      </div>
                      <div className="mt-1 text-[12px] text-muted-foreground">{r.summary}</div>
                    </div>
                  ))}
                </div>
              )}
              {canReview && hasEval && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Select value={rcCategory} onValueChange={setRcCategory}>
                    <SelectTrigger className="h-8 w-44 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROOT_CAUSE_CATEGORIES.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={rcSummary}
                    onChange={(e) => setRcSummary(e.target.value)}
                    placeholder={t(C.overview.rootCauseSummary)}
                    className="h-8 flex-1 text-xs"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={submitting || !rcSummary.trim()}
                    onClick={() => void recordRootCause()}
                  >
                    {t(C.overview.recordRootCause)}
                  </Button>
                </div>
              )}
            </Panel>
          </>
        )}

        {/* ── Evaluation ── */}
        {tab === "evaluation" &&
          (!hasEval ? (
            <Panel title={t(C.evaluation.breakdown)}>
              <div className="space-y-2">
                <span className="text-muted-foreground">{t(C.detail.notEvaluatedYet)}</span>
                {!evaluationAvailable && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800">
                    {t(C.detail.evaluateUnavailable)}
                  </div>
                )}
              </div>
            </Panel>
          ) : (
            <>
              <Panel title={t(C.evaluation.breakdown)}>
                {sectionErr("details") ? (
                  <SectionError message={sectionErr("details")!.message} />
                ) : details.length === 0 ? (
                  <span className="text-muted-foreground">{t(C.evaluation.noDetails)}</span>
                ) : (
                  <div className="space-y-2">
                    {details.map((dd: any) => (
                      <div key={dd.evaluator_type} className="rounded-md border p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold capitalize">{dd.evaluator_type}</span>
                          <span className="font-mono text-[11px]">
                            {Number(dd.raw_score).toFixed(2)} × {Number(dd.weight).toFixed(2)} ={" "}
                            {Number(dd.weighted_score).toFixed(2)}
                          </span>
                        </div>
                        <div className="mt-1.5 space-y-1 text-[12px] text-muted-foreground">
                          <div>
                            <strong>{t(C.evaluation.justification)}:</strong> {dd.justification || t(C.evaluation.none)}
                          </div>
                          {dd.recommended_correction && (
                            <div>
                              <strong>{t(C.evaluation.correction)}:</strong> {dd.recommended_correction}
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-1.5">
                            <strong>{t(C.evaluation.refs)}:</strong>
                            {(dd.grounding_refs ?? []).length === 0 ? (
                              <span>{t(C.evaluation.none)}</span>
                            ) : (
                              (dd.grounding_refs ?? []).map((r: string) => (
                                <span key={r} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                                  {r}
                                </span>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
              <Panel title={t(C.evaluation.provenance)}>
                <Prov label={t(C.evaluation.contract)} value={ev.evaluation_contract_version} />
                <Prov label={t(C.evaluation.model)} value={ev.model_version} />
                <Prov label={t(C.evaluation.prompt)} value={ev.prompt_version} />
                <Prov label={t(C.evaluation.deployment)} value={ev.source_deployment} />
                <Prov label={t(C.evaluation.kb)} value={ev.kb_snapshot_id} />
                <Prov label={t(C.evaluation.policy)} value={ev.policy_snapshot_id} />
                <Prov label={t(C.evaluation.bundle)} value={ev.bundle_hash} />
                <Prov label={t(C.evaluation.snapshot)} value={ev.input_snapshot_hash} />
              </Panel>
              <Panel title={t(C.evaluation.review)}>
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t(C.evaluation.current)}:</span>
                  <Badge variant="outline" className={cn("text-[11px]", REVIEW_CLASS[ev.review_status] ?? "")}>
                    {ev.review_status ?? "pending"}
                  </Badge>
                  {ev.reviewed_at && (
                    <span className="text-[11px] text-muted-foreground">
                      {new Date(ev.reviewed_at).toLocaleString()}
                    </span>
                  )}
                </div>
                {ev.review_note && <div className="mb-2 rounded bg-muted/50 p-2 text-[12px]">{ev.review_note}</div>}
                {!canReview ? (
                  <div className="text-muted-foreground">{t(C.evaluation.readOnly)}</div>
                ) : (
                  <>
                    <Textarea
                      value={reviewNote}
                      onChange={(e) => setReviewNote(e.target.value)}
                      placeholder={t(C.evaluation.note)}
                      maxLength={1000}
                      rows={3}
                      className="text-xs"
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={submitting || ev.review_status !== "pending"}
                        onClick={() => void submitReview("accept")}
                      >
                        {t(C.evaluation.accept)}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={submitting || ev.review_status !== "pending"}
                        onClick={() => void submitReview("reject")}
                      >
                        {t(C.evaluation.reject)}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={submitting || ev.review_status === "pending"}
                        onClick={() => void submitReview("reopen")}
                      >
                        {t(C.evaluation.reopen)}
                      </Button>
                    </div>
                  </>
                )}
              </Panel>
            </>
          ))}

        {/* ── Emotion Journey ── */}
        {tab === "emotion" && (
          <Panel title={t(C.tabs.emotion)}>
            {sectionErr("emotion") ? (
              <SectionError message={sectionErr("emotion")!.message} />
            ) : !hasEval ? (
              <span className="text-muted-foreground">{t(C.detail.notEvaluatedYet)}</span>
            ) : (d?.emotion ?? []).length === 0 ? (
              <span className="text-muted-foreground">{t(C.emotion.empty)}</span>
            ) : (
              <div className="space-y-1.5">
                {(d?.emotion ?? []).map((e: any) => {
                  const raw = Number(e.sentiment_score);
                  const pct = Math.max(0, Math.min(100, (raw + 100) / 2));
                  return (
                    <div key={e.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                      <span className="w-14 text-[11px] text-muted-foreground">
                        {t(C.emotion.turn)} {e.turn_index}
                      </span>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn("h-1.5 rounded-full", raw < 0 ? "bg-red-400" : "bg-emerald-400")}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-24 truncate text-[11px]">{e.sentiment}</span>
                      <span className="w-10 text-right font-mono text-[11px]">{raw.toFixed(0)}</span>
                      <span className="flex-1 truncate text-[11px] text-muted-foreground">
                        {e.trigger_label ? `${t(C.emotion.trigger)}: ${e.trigger_label}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        )}

        {/* ── Next Steps ── */}
        {tab === "nextSteps" && (
          <Panel title={t(C.tabs.nextSteps)}>
            {sectionErr("nextSteps") ? (
              <SectionError message={sectionErr("nextSteps")!.message} />
            ) : !hasEval ? (
              <span className="text-muted-foreground">{t(C.detail.notEvaluatedYet)}</span>
            ) : (d?.nextSteps ?? []).length === 0 ? (
              <span className="text-muted-foreground">{t(C.nextSteps.empty)}</span>
            ) : (
              <div className="space-y-2">
                {(d?.nextSteps ?? []).map((n: any) => (
                  <div key={n.id} className="rounded-md border p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold">
                        {n.ordinal}. {n.title}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {t(C.nextSteps.owner)}: {n.owner_role ?? "—"} · {n.status}
                      </span>
                    </div>
                    {n.detail && <div className="mt-1 text-[12px] text-muted-foreground">{n.detail}</div>}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}

        {/* ── Replay Studio ── */}
        {tab === "replay" && (
          <Panel title={t(C.tabs.replay)}>
            {sectionErr("replay") ? (
              <SectionError message={sectionErr("replay")!.message} />
            ) : !hasEval ? (
              <span className="text-muted-foreground">{t(C.detail.replayUnavailable)}</span>
            ) : !snapshot ? (
              <span className="text-muted-foreground">{t(C.replay.unavailable)}</span>
            ) : (
              <>
                <p className="mb-2 text-[11px] text-muted-foreground">{t(C.replay.hint)}</p>
                <div className="mb-2 rounded-md border bg-muted/30 p-2">
                  <Prov label={t(C.evaluation.bundle)} value={snapshot.bundle_hash} />
                  <Prov label={t(C.evaluation.snapshot)} value={snapshot.transcript_hash} />
                  <Prov label={t(C.evaluation.model)} value={snapshot.model_version} />
                  <Prov label={t(C.evaluation.prompt)} value={snapshot.prompt_version} />
                  <Prov label={t(C.evaluation.kb)} value={snapshot.kb_snapshot_id} />
                  <Prov label={t(C.evaluation.policy)} value={snapshot.policy_snapshot_id} />
                  <Prov
                    label={t(C.replay.retention)}
                    value={
                      snapshot.retention_expires_at
                        ? new Date(snapshot.retention_expires_at).toLocaleDateString()
                        : null
                    }
                  />
                </div>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {(["transcript", "canonical", "grounding"] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setReplaySub(s)}
                      className={cn(
                        "rounded border px-2.5 py-1 text-[11px]",
                        replaySub === s
                          ? "border-primary bg-primary/10 text-primary"
                          : "bg-background text-muted-foreground",
                      )}
                    >
                      {t(C.replay[s])}
                    </button>
                  ))}
                </div>
                {replaySub === "transcript" && (
                  <div className="max-h-80 space-y-1.5 overflow-y-auto">
                    {(snapshot.normalized_transcript ?? []).map((m: any, i: number) => (
                      <div key={m.id ?? i} className="rounded border p-2">
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                          <span className="font-semibold uppercase">{m.role}</span>
                          <span>{m.created_at ? new Date(m.created_at).toLocaleString() : ""}</span>
                        </div>
                        <p className="mt-0.5 whitespace-pre-wrap text-[12px]">{m.content}</p>
                      </div>
                    ))}
                  </div>
                )}
                {replaySub === "canonical" && (
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2.5 font-mono text-[11px]">
                    {typeof snapshot.canonical_input === "string"
                      ? snapshot.canonical_input
                      : JSON.stringify(snapshot.canonical_input ?? {}, null, 2)}
                  </pre>
                )}
                {replaySub === "grounding" && (
                  <div className="max-h-80 space-y-2 overflow-y-auto">
                    <div className="text-[11px] font-semibold text-muted-foreground">{t(C.replay.kbEvidence)}</div>
                    <pre className="whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]">
                      {snapshot.grounding_evidence?.kb_block || snapshot.grounding_evidence?.kb || "—"}
                    </pre>
                    <div className="text-[11px] font-semibold text-muted-foreground">{t(C.replay.policyEvidence)}</div>
                    <pre className="whitespace-pre-wrap rounded bg-muted/40 p-2 font-mono text-[11px]">
                      {snapshot.grounding_evidence?.policy_block || snapshot.grounding_evidence?.policy || "—"}
                    </pre>
                  </div>
                )}
              </>
            )}
            <div className="mt-2 text-[11px] text-muted-foreground">{t(C.replay.rawAdminOnly)}</div>
          </Panel>
        )}
      </div>
    </div>
  );
}

export function CeDetailBackLink() {
  const { t } = useConsoleLang();
  return (
    <Link to="/console/conversation-evaluation" className="text-xs font-semibold text-primary">
      ← {t(C.detail.back)}
    </Link>
  );
}
