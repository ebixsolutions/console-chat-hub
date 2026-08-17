/**
 * Conversation Evaluation console — PR29 Task 2 automatic evaluation UX.
 * Existing CE list/filter/detail design preserved.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { roleCan } from "@/lib/authz/consoleCapabilities";
import { useConsoleLang, COPY } from "@/lib/i18n/consoleLang";
import { CE_REVIEW_COPY as C } from "@/lib/i18n/ceReviewCopy";
import { listConversationsForCeFn, type CeConversationRow, type CeListCounts } from "@/lib/api/ce.functions";
import { CeDetailPanel } from "@/components/console/ce/CeDetailPanel";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 25;
const DWELL_MS = 3000;

type FreshState =
  | "never_evaluated"
  | "up_to_date"
  | "dirty"
  | "queued"
  | "evaluating"
  | "failed"
  | "stale_version";

type FreshRow = {
  conversation_id: string;
  state: FreshState;
  last_success_at: string | null;
  last_error_code: string | null;
};

const SEVERITY_PILL: Record<string, string> = {
  critical: "bg-red-100 text-red-700 border-red-200",
  high: "bg-orange-100 text-orange-700 border-orange-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-emerald-100 text-emerald-700 border-emerald-200",
};
const STATUS_PILL: Record<string, string> = {
  pending: "bg-slate-100 text-slate-700 border-slate-200",
  accepted: "bg-emerald-100 text-emerald-700 border-emerald-200",
  rejected: "bg-red-100 text-red-700 border-red-200",
};
const CONV_STATUS_PILL: Record<string, string> = {
  open: "bg-blue-50 text-blue-700 border-blue-200",
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  resolved: "bg-emerald-50 text-emerald-700 border-emerald-200",
  unresolved: "bg-red-50 text-red-700 border-red-200",
  ai_handling: "bg-green-50 text-green-700 border-green-200",
};

export const Route = createFileRoute("/_authenticated/console/conversation-evaluation/")({
  component: ConversationEvaluationIndex,
});

function ConversationEvaluationIndex() {
  const { role, loading } = useCurrentRole();
  const { t } = useConsoleLang();
  if (loading) return <LoadingState />;
  if (!roleCan(role, "ce.evaluation.read_sanitized")) {
    return <PermissionDenied message={t(COPY.ce.permissionDenied)} />;
  }
  return <ReviewConsole canRun={roleCan(role, "ce.evaluation.run")} canReview={roleCan(role, "ce.review.decide")} />;
}

function scoreTextClass(score: number): string {
  if (score < 60) return "text-red-600";
  if (score < 80) return "text-amber-600";
  return "text-emerald-600";
}

async function invokeAuto(
  conversationId: string,
  source: "manual" | "ce_dwell",
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string }> {
  const { data, error } = await supabase.functions.invoke("ce-evaluation-control", {
    body: { conversation_id: conversationId, source },
  });
  if (error) {
    const ctx = (error as { context?: { body?: unknown } }).context;
    try {
      const parsed = typeof ctx?.body === "string" ? JSON.parse(ctx.body) : ctx?.body;
      return { ok: false, code: String((parsed as any)?.error ?? "unknown") };
    } catch {
      return { ok: false, code: "unknown" };
    }
  }
  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.error) return { ok: false, code: String(payload.error) };
  return { ok: true, data: payload };
}

function freshnessLabel(state?: FreshState): string {
  switch (state) {
    case "up_to_date": return "Up to date";
    case "dirty": return "Updated · refresh pending";
    case "queued": return "Queued";
    case "evaluating": return "Refreshing…";
    case "failed": return "Refresh failed";
    case "stale_version": return "Methodology updated";
    case "never_evaluated": return "Not evaluated yet";
    default: return "";
  }
}
function freshnessClass(state?: FreshState): string {
  if (state === "up_to_date") return "text-emerald-600";
  if (state === "failed") return "text-red-600";
  if (state === "dirty" || state === "stale_version") return "text-amber-600";
  return "text-slate-500";
}

function Chip({ label, active, onClick, disabled }: {
  label: string; active?: boolean; onClick?: () => void; disabled?: boolean;
}) {
  return (
    <button
      type="button" disabled={disabled} onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-[3px] text-[11px] leading-none transition-colors",
        disabled
          ? "cursor-default border-[#e8e6e0] bg-[#f5f4f0] text-slate-400"
          : active
            ? "border-slate-900 bg-slate-900 text-white"
            : "border-[#e8e6e0] bg-white text-slate-600 hover:bg-[#fafaf8]",
      )}
    >{label}</button>
  );
}
function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-[5px] w-[64px] shrink-0 text-[10px] font-medium uppercase tracking-wide text-slate-400">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}
function TabPill({ label, count, active, onClick }: {
  label: string; count: number | null; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button" onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-[5px] text-[11px] font-medium transition-colors",
        active ? "border-slate-900 bg-slate-900 text-white" : "border-[#e8e6e0] bg-white text-slate-600 hover:bg-[#fafaf8]",
      )}
    >
      {label}
      <span className={cn("rounded-full px-1.5 text-[10px] font-semibold leading-[16px]", active ? "bg-white/20 text-white" : "bg-[#f5f4f0] text-slate-500")}>
        {count === null ? "—" : count}
      </span>
    </button>
  );
}

function ReviewConsole({ canRun, canReview }: { canRun: boolean; canReview: boolean }) {
  const { t } = useConsoleLang();
  type PillType = "all" | "evaluated" | "not_evaluated" | "needs_review";
  const [pill, setPill] = useState<PillType>("all");
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<string>("any");
  const [reviewStatus, setReviewStatus] = useState<string>("any");
  const [scoreBand, setScoreBand] = useState<string>("any");
  const [channel, setChannel] = useState<string>("any");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<CeConversationRow[]>([]);
  const [counts, setCounts] = useState<CeListCounts>({ total: 0, evaluated: 0, not_evaluated: 0, needs_review: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [runId, setRunId] = useState("");
  const [running, setRunning] = useState(false);
  const [freshness, setFreshness] = useState<Record<string, FreshRow>>({});
  const dwellGeneration = useRef(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  const reloadAll = useCallback(() => {
    setReloadKey((k) => k + 1);
    setDetailReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await listConversationsForCeFn({
          data: {
            pill,
            search: search.trim() || undefined,
            severity: severity !== "any" ? (severity as any) : undefined,
            fromDate: fromDate || undefined,
            toDate: toDate || undefined,
          },
        });
        if (cancelled) return;
        if (!res.ok) { setError(res.error ?? "load_failed"); setRows([]); return; }
        setError(null);
        const result = res.data as { rows: CeConversationRow[]; counts: CeListCounts };
        setRows(result.rows);
        setCounts(result.counts);
      } catch (e: unknown) {
        if (!cancelled) { setError(e instanceof Error ? e.message : "load_failed"); setRows([]); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pill, search, severity, fromDate, toDate, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    const ids = rows.map((r) => r.conversation_id);
    if (ids.length === 0) { setFreshness({}); return; }
    void (async () => {
      const { data } = await supabase
        .from("ce_evaluation_state")
        .select("conversation_id,state,last_success_at,last_error_code")
        .in("conversation_id", ids);
      if (cancelled) return;
      const map: Record<string, FreshRow> = {};
      for (const r of (data ?? []) as FreshRow[]) map[r.conversation_id] = r;
      setFreshness(map);
    })();
    return () => { cancelled = true; };
  }, [rows, reloadKey]);

  const channelOptions = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => { if (r.channel_name) set.add(r.channel_name); });
    return [...set].sort();
  }, [rows]);

  const filtered = useMemo(() => rows.filter((r) => {
    if (scoreBand !== "any") {
      if (r.overall_score === null) return false;
      if (scoreBand === "low" && !(r.overall_score < 60)) return false;
      if (scoreBand === "mid" && !(r.overall_score >= 60 && r.overall_score < 80)) return false;
      if (scoreBand === "high" && !(r.overall_score >= 80)) return false;
    }
    if (reviewStatus !== "any") {
      if (r.review_status === null || r.review_status !== reviewStatus) return false;
    }
    if (channel !== "any" && r.channel_name !== channel) return false;
    return true;
  }), [rows, scoreBand, reviewStatus, channel]);

  useEffect(() => setPage(0), [pill, search, severity, scoreBand, reviewStatus, channel, fromDate, toDate]);
  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  useEffect(() => {
    if (!selected && pageRows.length > 0) {
      setSelected(pageRows[0].conversation_id);
      setRunId(pageRows[0].conversation_id);
    }
  }, [selected, pageRows]);

  const targetRow = useMemo(() => {
    const id = runId.trim().toLowerCase();
    if (!UUID_RE.test(id)) return null;
    return rows.find((r) => r.conversation_id.toLowerCase() === id) ?? null;
  }, [rows, runId]);
  const targetEvaluationAvailable = targetRow?.evaluation_available === true;

  const selectConversation = (conversationId: string) => {
    dwellGeneration.current += 1;
    setSelected(conversationId);
    setRunId(conversationId);
  };

  const executeEvaluation = useCallback(async (
    id: string,
    source: "manual" | "ce_dwell",
    silent: boolean,
  ) => {
    const res = await invokeAuto(id, source);
    if (!res.ok) {
      if (!silent) {
        const key = String(res.code ?? "unknown") as keyof typeof COPY.ce.errors;
        toast.error(t(COPY.ce.errors[key] ?? COPY.ce.errors.unknown));
      }
      setFreshness((prev) => ({
        ...prev,
        [id]: { conversation_id: id, state: "failed", last_success_at: prev[id]?.last_success_at ?? null, last_error_code: res.code },
      }));
      return false;
    }
    const status = String(res.data.status ?? "");
    if (!silent) {
      if (status === "up_to_date") toast.info(t(C.run.alreadyEvaluated));
      else if (status === "queued") toast.info("Evaluation queued");
      else toast.success(t(C.run.completed));
    }
    reloadAll();
    return true;
  }, [reloadAll, t]);

  useEffect(() => {
    if (!canRun || !selected) return;
    const row = rows.find((r) => r.conversation_id === selected);
    if (!row?.evaluation_available) return;
    const state = freshness[selected]?.state;
    if (!["never_evaluated","dirty","failed","stale_version"].includes(state ?? "")) return;

    const generation = ++dwellGeneration.current;
    const timer = window.setTimeout(() => {
      if (generation !== dwellGeneration.current) return;
      setFreshness((prev) => ({
        ...prev,
        [selected]: {
          conversation_id: selected,
          state: "evaluating",
          last_success_at: prev[selected]?.last_success_at ?? null,
          last_error_code: null,
        },
      }));
      void executeEvaluation(selected, "ce_dwell", true);
    }, DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [canRun, selected, rows, freshness, executeEvaluation]);

  const runEvaluation = async () => {
    const id = runId.trim();
    if (!UUID_RE.test(id)) { toast.error(t(C.run.invalidId)); return; }
    const exact = rows.find((r) => r.conversation_id.toLowerCase() === id.toLowerCase());
    if (!exact || !exact.evaluation_available) { toast.error(t(C.run.disabled)); return; }

    setSelected(id);
    setRunning(true);
    setFreshness((prev) => ({
      ...prev,
      [id]: {
        conversation_id: id,
        state: "evaluating",
        last_success_at: prev[id]?.last_success_at ?? null,
        last_error_code: null,
      },
    }));
    try { await executeEvaluation(id, "manual", false); }
    finally { setRunning(false); }
  };

  const clearFilters = () => {
    setSearch(""); setSeverity("any"); setReviewStatus("any"); setScoreBand("any");
    setChannel("any"); setFromDate(""); setToDate("");
  };

  return (
    <div className="h-[calc(100vh-4rem)] min-h-0 bg-[#f7f6f2] p-4">
      <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto lg:basis-[40%]">
          <div className="flex flex-wrap items-center gap-2">
            <TabPill label={t(C.pills.all)} count={error ? null : counts.total} active={pill === "all"} onClick={() => setPill("all")} />
            <TabPill label={t(C.pills.evaluated)} count={error ? null : counts.evaluated} active={pill === "evaluated"} onClick={() => setPill("evaluated")} />
            <TabPill label={t(C.pills.notEvaluated)} count={error ? null : counts.not_evaluated} active={pill === "not_evaluated"} onClick={() => setPill("not_evaluated")} />
            <TabPill label={t(C.pills.needsReview)} count={error ? null : counts.needs_review} active={pill === "needs_review"} onClick={() => setPill("needs_review")} />
            <span className="text-[11px] text-slate-500">
              {error ? t(C.countUnavailable) : <>{filtered.length} / {counts.total} {t(C.count)}</>}
            </span>
          </div>

          <div className="space-y-2.5 rounded-[10px] border border-[#e8e6e0] bg-white p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t(C.searchPlaceholder)}
                className="h-8 w-full rounded-md border border-[#e8e6e0] bg-white pl-8 pr-2 text-[12px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-300" />
            </div>

            {canRun && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <input value={runId} onChange={(e) => setRunId(e.target.value)} placeholder={t(C.run.placeholder)}
                    className="h-7 min-w-0 flex-1 rounded-md border border-[#e8e6e0] bg-white px-2 font-mono text-[11px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-300" />
                  <button type="button" disabled={running || !targetEvaluationAvailable} onClick={() => void runEvaluation()}
                    className="h-7 shrink-0 rounded-md bg-slate-900 px-2.5 text-[11px] font-medium text-white disabled:opacity-50">
                    {running ? t(C.run.running) : t(C.run.action)}
                  </button>
                </div>
                {runId && UUID_RE.test(runId) && (
                  <div className={cn("text-[10px] font-medium", freshnessClass(freshness[runId]?.state))}>
                    {freshnessLabel(freshness[runId]?.state)}
                    {freshness[runId]?.state === "dirty" ? " · auto-refresh after 3s on selected row" : ""}
                  </div>
                )}
                {!targetEvaluationAvailable && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] text-amber-800">{t(C.run.disabled)}</div>
                )}
              </div>
            )}

            <ChipRow label={t(C.filters.status)}>
              {[{v:"any",l:t(C.filters.any)},{v:"pending",l:"pending"},{v:"accepted",l:"accepted"},{v:"rejected",l:"rejected"}]
                .map((o) => <Chip key={o.v} label={o.l} active={reviewStatus===o.v} onClick={()=>setReviewStatus(o.v)} />)}
            </ChipRow>
            <ChipRow label={t(C.filters.urgency)}>
              {[{v:"any",l:t(C.filters.any)},{v:"critical",l:"Critical"},{v:"high",l:"High"},{v:"medium",l:"Medium"},{v:"low",l:"Low"}]
                .map((o) => <Chip key={o.v} label={o.l} active={severity===o.v} onClick={()=>setSeverity(o.v)} />)}
            </ChipRow>
            <ChipRow label={t(C.filters.score)}>
              {[{v:"any",l:t(C.filters.any)},{v:"low",l:t(C.scoreBands.low)},{v:"mid",l:t(C.scoreBands.mid)},{v:"high",l:t(C.scoreBands.high)}]
                .map((o) => <Chip key={o.v} label={o.l} active={scoreBand===o.v} onClick={()=>setScoreBand(o.v)} />)}
            </ChipRow>
            <ChipRow label={t(C.filters.channel)}>
              <Chip label={t(C.filters.any)} active={channel==="any"} onClick={()=>setChannel("any")} />
              {channelOptions.map((c)=><Chip key={c} label={c} active={channel===c} onClick={()=>setChannel(c)} />)}
            </ChipRow>
            <ChipRow label={t(C.filters.intent)}><Chip label={t(C.filters.unavailable)} disabled /></ChipRow>

            <div className="flex items-center gap-3 pt-0.5">
              <button type="button" onClick={()=>setShowMore((s)=>!s)} className="text-[11px] font-medium text-slate-500 hover:text-slate-800">
                {showMore ? t(C.filters.less) : t(C.filters.more)}
              </button>
              <button type="button" onClick={clearFilters} className="text-[11px] font-medium text-slate-500 hover:text-slate-800">{t(C.filters.clear)}</button>
            </div>
            {showMore && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400">{t(C.filters.from)}
                  <input type="date" value={fromDate} onChange={(e)=>setFromDate(e.target.value)}
                    className="h-7 rounded-md border border-[#e8e6e0] bg-white px-1.5 text-[11px] text-slate-700 outline-none" />
                </label>
                <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400">{t(C.filters.to)}
                  <input type="date" value={toDate} onChange={(e)=>setToDate(e.target.value)}
                    className="h-7 rounded-md border border-[#e8e6e0] bg-white px-1.5 text-[11px] text-slate-700 outline-none" />
                </label>
              </div>
            )}
          </div>

          <div className="overflow-hidden rounded-[10px] border border-[#e8e6e0] bg-white">
            {error ? (
              <div className="m-3 rounded-md border border-red-200 bg-red-50 p-3 text-[12px] text-red-700">{t(C.list.loadFailed)} <span className="font-mono">{error}</span></div>
            ) : loading ? (
              <div className="p-4 text-[12px] text-slate-500">{t(C.detail.loading)}</div>
            ) : pageRows.length === 0 ? (
              <div className="p-4 text-[12px] text-slate-500">{t(C.list.empty)}</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead className="bg-[#f5f4f0]">
                    <tr className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                      <th className="px-3 py-2 font-semibold">{t(C.columns.id)}</th>
                      <th className="px-2 py-2 font-semibold">{t(C.columns.customer)}</th>
                      <th className="px-2 py-2 font-semibold">{t(C.columns.date)}</th>
                      <th className="px-2 py-2 font-semibold">{t(C.columns.channel)}</th>
                      <th className="px-2 py-2 font-semibold">{t(C.columns.convStatus)}</th>
                      <th className="px-2 py-2 font-semibold">{t(C.columns.qaScore)}</th>
                      <th className="px-2 py-2 font-semibold">{t(C.columns.urgency)}</th>
                      <th className="px-3 py-2 font-semibold">{t(C.columns.status)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => {
                      const sel=selected===r.conversation_id;
                      const hasEval=r.evaluation_id!==null;
                      const fs=freshness[r.conversation_id]?.state;
                      return (
                        <tr key={r.conversation_id} onClick={()=>selectConversation(r.conversation_id)}
                          className={cn("h-[44px] cursor-pointer border-t border-[#f0efe9] transition-colors",sel?"bg-[#f0f9ff]":"hover:bg-[#fafaf8]")}>
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] font-semibold text-indigo-600">{r.conversation_id.slice(0,8)}…</td>
                          <td className="max-w-[120px] truncate px-2 py-2 text-[11px] text-slate-700">{r.customer_label}</td>
                          <td className="whitespace-nowrap px-2 py-2 text-[11px] text-slate-500">{r.created_at?new Date(r.created_at).toLocaleDateString():"—"}</td>
                          <td className="px-2 py-2">{r.channel_name?<span className="inline-block max-w-[110px] truncate rounded border border-sky-200 bg-sky-50 px-1.5 py-[2px] text-[10px] font-medium text-sky-700">{r.channel_name}</span>:<span className="text-[11px] text-slate-400">—</span>}</td>
                          <td className="px-2 py-2"><span className={cn("inline-block rounded-full border px-1.5 py-[2px] text-[10px] font-medium capitalize",CONV_STATUS_PILL[r.conversation_status]??"border-[#e8e6e0] bg-[#f5f4f0] text-slate-600")}>{r.conversation_status}</span></td>
                          <td className="px-2 py-2">
                            {hasEval?<span className={cn("text-[12px] font-bold",scoreTextClass(r.overall_score!))}>{r.overall_score!.toFixed(1)}</span>:<span className="text-[11px] text-slate-400">{t(C.detail.notEvaluated)}</span>}
                            {fs && fs!=="up_to_date" && <div className={cn("max-w-[110px] truncate text-[9px]",freshnessClass(fs))}>{freshnessLabel(fs)}</div>}
                          </td>
                          <td className="px-2 py-2">{hasEval?<span className={cn("inline-block rounded-full border px-1.5 py-[2px] text-[10px] font-medium capitalize",SEVERITY_PILL[r.severity!]??"")}>{r.severity}</span>:<span className="text-[11px] text-slate-400">—</span>}</td>
                          <td className="px-3 py-2">{hasEval?<span className={cn("inline-block rounded-full border px-1.5 py-[2px] text-[10px] font-medium",STATUS_PILL[r.review_status!]??"")}>{r.needs_review?t(C.pills.needsReview):r.review_status}</span>:<span className="text-[11px] text-slate-400">{t(C.detail.notEvaluated)}</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {pageCount>1 && (
              <div className="flex items-center justify-between gap-2 border-t border-[#f0efe9] px-3 py-1.5 text-[11px]">
                <button type="button" disabled={page===0} onClick={()=>setPage((p)=>p-1)} className="text-slate-500 disabled:opacity-40">{t(C.list.prev)}</button>
                <span className="text-slate-400">{t(C.list.page)} {page+1} / {pageCount}</span>
                <button type="button" disabled={page+1>=pageCount} onClick={()=>setPage((p)=>p+1)} className="text-slate-500 disabled:opacity-40">{t(C.list.next)}</button>
              </div>
            )}
          </div>
        </div>

        <div className="min-h-0 overflow-hidden rounded-[11px] border border-[#e8e6e0] bg-white lg:basis-[59%]">
          {selected ? (
            <CeDetailPanel
              key={`${selected}:${detailReloadKey}`}
              conversationId={selected}
              canReview={canReview}
              onChanged={reload}
            />
          ) : (
            <div className="p-6 text-[13px] text-slate-500">{t(C.detail.selectPrompt)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
