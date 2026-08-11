/**
 * Conversation Evaluation console — Base44 SU CoachAI /review layout parity.
 *
 * Hierarchy mirrors the authoritative source (ConversationReview.jsx + ConvList.jsx):
 * ALL conversation-list controls (tabs, search, filter chips, table) live INSIDE
 * the LEFT 40% column; the RIGHT 59% detail panel starts at the same vertical top.
 * There is deliberately no full-width toolbar spanning both columns.
 *
 * Status/severity/score all come from public.ce_conversation_status_v via the CE
 * server functions; the client never re-derives them, and a failed query is
 * surfaced as an error, never as an empty success.
 *
 * Training is owned by SU CoachAI. This route deliberately exposes no training
 * eligibility, no training-candidate queue and no outbox/delivery surface.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { roleCan } from "@/lib/authz/consoleCapabilities";
import { useConsoleLang, COPY } from "@/lib/i18n/consoleLang";
import { CE_REVIEW_COPY as C } from "@/lib/i18n/ceReviewCopy";
import { listCeEvaluationsFn } from "@/lib/api/ce.functions";
import { ceClient } from "@/integrations/supabase/ce-schema";
import { CeDetailPanel } from "@/components/console/ce/CeDetailPanel";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 25;

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
  return (
    <ReviewConsole
      canRun={roleCan(role, "ce.evaluation.run")}
      canReview={roleCan(role, "ce.review.decide")}
    />
  );
}

/** Base44 plain bold colored score number (no bordered badge). */
function scoreTextClass(score: number): string {
  if (score < 60) return "text-red-600";
  if (score < 80) return "text-amber-600";
  return "text-emerald-600";
}

/** Invokes the deployed conversation-evaluate Edge Function; contract unchanged. */
async function invokeCe(
  body: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string }> {
  const { data, error } = await supabase.functions.invoke("conversation-evaluate", { body });
  if (error) {
    // The Edge Function's fixed error contract travels in the response body.
    const ctx = (error as { context?: { body?: unknown } }).context;
    let code = "unknown";
    try {
      const parsed = typeof ctx?.body === "string" ? JSON.parse(ctx.body) : ctx?.body;
      if (parsed && typeof parsed === "object" && "error" in parsed) code = String((parsed as any).error);
    } catch {
      /* keep unknown */
    }
    return { ok: false, code };
  }
  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.error) return { ok: false, code: String(payload.error) };
  return { ok: true, data: payload };
}

/** Compact Base44-style chip button used for every left-column filter row. */
function Chip({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-disabled={disabled ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2.5 py-[3px] text-[11px] leading-none transition-colors",
        disabled
          ? "cursor-default border-[#e8e6e0] bg-[#f5f4f0] text-slate-400"
          : active
            ? "border-slate-900 bg-slate-900 text-white"
            : "border-[#e8e6e0] bg-white text-slate-600 hover:bg-[#fafaf8]",
      )}
    >
      {label}
    </button>
  );
}

function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-[5px] w-[64px] shrink-0 text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function ReviewConsole({ canRun, canReview }: { canRun: boolean; canReview: boolean }) {
  const { t } = useConsoleLang();

  const [pill, setPill] = useState<"all" | "needs_review">("all");
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<string>("any");
  const [reviewStatus, setReviewStatus] = useState<string>("any");
  const [scoreBand, setScoreBand] = useState<string>("any");
  const [channel, setChannel] = useState<string>("any");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [page, setPage] = useState(0);

  const [rows, setRows] = useState<any[]>([]);
  const [channelById, setChannelById] = useState<Record<string, string>>({});
  const [convChannel, setConvChannel] = useState<Record<string, string | null>>({});
  const [reviewById, setReviewById] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [selected, setSelected] = useState<string | null>(null);
  const [runId, setRunId] = useState("");
  const [running, setRunning] = useState(false);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  /**
   * The canonical status view is fetched once per filter set with tab "all";
   * the Needs Review pill filters the same canonical `needs_review` boolean so
   * both pill counts stay truthful without a second request.
   */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await listCeEvaluationsFn({
          data: {
            tab: "all",
            search: search.trim() || undefined,
            severity: severity !== "any" ? (severity as any) : undefined,
            fromDate: fromDate || undefined,
            toDate: toDate || undefined,
            limit: 200,
          },
        });
        if (cancelled) return;
        if (!res.ok) {
          setError(res.error ?? "load_failed");
          setRows([]);
          return;
        }
        setError(null);
        const list = (res.data ?? []) as any[];
        setRows(list);

        const convIds = Array.from(new Set(list.map((r) => r.conversation_id))).slice(0, 200);
        const evalIds = Array.from(new Set(list.map((r) => r.evaluation_id))).slice(0, 200);
        if (evalIds.length > 0) {
          const { data: evs } = await ceClient
            .from("conversation_evaluation")
            .select("id, review_status")
            .in("id", evalIds);
          if (!cancelled && evs) {
            setReviewById(Object.fromEntries((evs as any[]).map((e) => [e.id, e.review_status])));
          }
        }
        if (convIds.length > 0) {
          const { data: convs } = await ceClient
            .from("conversations")
            .select("id, channel_config_id")
            .in("id", convIds);
          if (!cancelled && convs) {
            setConvChannel(
              Object.fromEntries((convs as any[]).map((c) => [c.id, c.channel_config_id ?? null])),
            );
            const chIds = Array.from(
              new Set((convs as any[]).map((c) => c.channel_config_id).filter(Boolean)),
            ) as string[];
            if (chIds.length > 0) {
              const { data: chs } = await ceClient
                .from("channel_config")
                .select("id, name, channel_type")
                .in("id", chIds);
              if (!cancelled && chs) {
                setChannelById(
                  Object.fromEntries((chs as any[]).map((c) => [c.id, c.name || c.channel_type])),
                );
              }
            }
          }
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "load_failed");
          setRows([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [search, severity, fromDate, toDate, reloadKey]);

  const channelOptions = useMemo(
    () => Object.entries(channelById).map(([id, name]) => ({ id, name })),
    [channelById],
  );

  const allCount = rows.length;
  const needsReviewCount = useMemo(() => rows.filter((r) => r.needs_review).length, [rows]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (pill === "needs_review" && !r.needs_review) return false;
      const score = Number(r.overall_score);
      if (scoreBand === "low" && !(score < 60)) return false;
      if (scoreBand === "mid" && !(score >= 60 && score < 80)) return false;
      if (scoreBand === "high" && !(score >= 80)) return false;
      if (reviewStatus !== "any" && (reviewById[r.evaluation_id] ?? "pending") !== reviewStatus) return false;
      if (channel !== "any" && (convChannel[r.conversation_id] ?? "") !== channel) return false;
      return true;
    });
  }, [rows, pill, scoreBand, reviewStatus, reviewById, channel, convChannel]);

  useEffect(() => setPage(0), [pill, search, severity, scoreBand, reviewStatus, channel, fromDate, toDate]);

  const pageRows = filtered.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  useEffect(() => {
    if (!selected && pageRows.length > 0) setSelected(pageRows[0].evaluation_id);
  }, [selected, pageRows]);

  const runEvaluation = async () => {
    const id = runId.trim();
    if (!UUID_RE.test(id)) {
      toast.error(t(C.run.invalidId));
      return;
    }
    setRunning(true);
    try {
      const res = await invokeCe({ action: "evaluate", conversation_id: id });
      if (!res.ok) {
        const key = String(res.code ?? "unknown") as keyof typeof COPY.ce.errors;
        toast.error(t(COPY.ce.errors[key] ?? COPY.ce.errors.unknown));
        return;
      }
      const payload = res.data;
      const status = String(payload.status ?? "");
      const evaluation = (payload.evaluation ?? null) as { id?: string } | null;
      if (evaluation?.id) setSelected(evaluation.id);
      if (status === "already_evaluated") {
        toast.info(t(C.run.alreadyEvaluated));
      } else {
        toast.success(t(C.run.completed));
      }
      setRunId("");
      reload();
    } finally {
      setRunning(false);
    }
  };

  const clearFilters = () => {
    setSearch("");
    setSeverity("any");
    setReviewStatus("any");
    setScoreBand("any");
    setChannel("any");
    setFromDate("");
    setToDate("");
  };

  const selectedChannel = useMemo(() => {
    const row = rows.find((r) => r.evaluation_id === selected);
    if (!row) return null;
    const chId = convChannel[row.conversation_id];
    return chId ? channelById[chId] ?? null : null;
  }, [rows, selected, convChannel, channelById]);

  return (
    <div className="h-[calc(100vh-4rem)] min-h-0 bg-[#f7f6f2] p-4">
      {/* Single horizontal body: LEFT 40% list column, RIGHT 59% detail panel.
          No toolbar spans both columns — all list controls live on the left. */}
      <div className="flex h-full min-h-0 flex-col gap-4 lg:flex-row">
        {/* ───────────────── LEFT COLUMN (40%) ───────────────── */}
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto lg:basis-[40%]">
          {/* Tabs + compact evaluate control */}
          <div className="flex flex-wrap items-center gap-2">
            <TabPill
              label={t(C.pills.all)}
              count={error ? null : allCount}
              active={pill === "all"}
              onClick={() => setPill("all")}
            />
            <TabPill
              label={t(C.pills.needsReview)}
              count={error ? null : needsReviewCount}
              active={pill === "needs_review"}
              onClick={() => setPill("needs_review")}
            />
            <span className="text-[11px] text-slate-500">
              {error ? (
                t(C.countUnavailable)
              ) : (
                <>
                  {filtered.length} / {allCount} {t(C.count)}
                </>
              )}
            </span>
          </div>

          {/* Search + filter chips card */}
          <div className="space-y-2.5 rounded-[10px] border border-[#e8e6e0] bg-white p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t(C.searchPlaceholder)}
                className="h-8 w-full rounded-md border border-[#e8e6e0] bg-white pl-8 pr-2 text-[12px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-300"
              />
            </div>

            {canRun && (
              <div className="flex items-center gap-1.5">
                <input
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                  placeholder={t(C.run.placeholder)}
                  className="h-7 min-w-0 flex-1 rounded-md border border-[#e8e6e0] bg-white px-2 font-mono text-[11px] text-slate-700 outline-none placeholder:text-slate-400 focus:border-slate-300"
                />
                <button
                  type="button"
                  disabled={running}
                  onClick={() => void runEvaluation()}
                  className="h-7 shrink-0 rounded-md bg-slate-900 px-2.5 text-[11px] font-medium text-white disabled:opacity-50"
                >
                  {running ? t(C.run.running) : t(C.run.action)}
                </button>
              </div>
            )}

            <ChipRow label={t(C.filters.status)}>
              {[
                { v: "any", l: t(C.filters.any) },
                { v: "pending", l: "pending" },
                { v: "accepted", l: "accepted" },
                { v: "rejected", l: "rejected" },
              ].map((o) => (
                <Chip key={o.v} label={o.l} active={reviewStatus === o.v} onClick={() => setReviewStatus(o.v)} />
              ))}
            </ChipRow>

            <ChipRow label={t(C.filters.urgency)}>
              {[
                { v: "any", l: t(C.filters.any) },
                { v: "critical", l: "Critical" },
                { v: "high", l: "High" },
                { v: "medium", l: "Medium" },
                { v: "low", l: "Low" },
              ].map((o) => (
                <Chip key={o.v} label={o.l} active={severity === o.v} onClick={() => setSeverity(o.v)} />
              ))}
            </ChipRow>

            <ChipRow label={t(C.filters.score)}>
              {[
                { v: "any", l: t(C.filters.any) },
                { v: "low", l: t(C.scoreBands.low) },
                { v: "mid", l: t(C.scoreBands.mid) },
                { v: "high", l: t(C.scoreBands.high) },
              ].map((o) => (
                <Chip key={o.v} label={o.l} active={scoreBand === o.v} onClick={() => setScoreBand(o.v)} />
              ))}
            </ChipRow>

            <ChipRow label={t(C.filters.channel)}>
              <Chip label={t(C.filters.any)} active={channel === "any"} onClick={() => setChannel("any")} />
              {channelOptions.map((c) => (
                <Chip key={c.id} label={c.name} active={channel === c.id} onClick={() => setChannel(c.id)} />
              ))}
            </ChipRow>

            {/* Intent has no canonical CE field: slot preserved, honestly disabled. */}
            <ChipRow label={t(C.filters.intent)}>
              <Chip label={t(C.filters.unavailable)} disabled />
            </ChipRow>

            <div className="flex items-center gap-3 pt-0.5">
              <button
                type="button"
                onClick={() => setShowMore((s) => !s)}
                className="text-[11px] font-medium text-slate-500 hover:text-slate-800"
              >
                {showMore ? t(C.filters.less) : t(C.filters.more)}
              </button>
              <button
                type="button"
                onClick={clearFilters}
                className="text-[11px] font-medium text-slate-500 hover:text-slate-800"
              >
                {t(C.filters.clear)}
              </button>
            </div>

            {showMore && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400">
                  {t(C.filters.from)}
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="h-7 rounded-md border border-[#e8e6e0] bg-white px-1.5 text-[11px] text-slate-700 outline-none"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400">
                  {t(C.filters.to)}
                  <input
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    className="h-7 rounded-md border border-[#e8e6e0] bg-white px-1.5 text-[11px] text-slate-700 outline-none"
                  />
                </label>
              </div>
            )}
          </div>

          {/* Table card */}
          <div className="overflow-hidden rounded-[10px] border border-[#e8e6e0] bg-white">
            {error ? (
              <div className="m-3 rounded-md border border-red-200 bg-red-50 p-3 text-[12px] text-red-700">
                {t(C.list.loadFailed)} <span className="font-mono">{error}</span>
              </div>
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
                      <th className="px-2 py-2 font-semibold">{t(C.columns.qaScore)}</th>
                      <th className="px-2 py-2 font-semibold">{t(C.columns.urgency)}</th>
                      <th className="px-3 py-2 font-semibold">{t(C.columns.status)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((r) => {
                      const chId = convChannel[r.conversation_id];
                      const chName = chId ? channelById[chId] : null;
                      const score = Number(r.overall_score);
                      const isSelected = selected === r.evaluation_id;
                      const status = reviewById[r.evaluation_id] ?? "pending";
                      return (
                        <tr
                          key={r.evaluation_id}
                          onClick={() => setSelected(r.evaluation_id)}
                          className={cn(
                            "h-[44px] cursor-pointer border-t border-[#f0efe9] transition-colors",
                            isSelected ? "bg-[#f0f9ff]" : "hover:bg-[#fafaf8]",
                          )}
                        >
                          <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] font-semibold text-indigo-600">
                            {String(r.conversation_id).slice(0, 8)}…
                          </td>
                          {/* No authoritative customer source in canonical CE data. */}
                          <td className="px-2 py-2 text-[11px] text-slate-400">—</td>
                          <td className="whitespace-nowrap px-2 py-2 text-[11px] text-slate-500">
                            {new Date(r.evaluated_at).toLocaleDateString()}
                          </td>
                          <td className="px-2 py-2">
                            {chName ? (
                              <span className="inline-block max-w-[110px] truncate rounded border border-sky-200 bg-sky-50 px-1.5 py-[2px] text-[10px] font-medium text-sky-700">
                                {chName}
                              </span>
                            ) : (
                              <span className="text-[11px] text-slate-400">{t(C.meta.unavailable)}</span>
                            )}
                          </td>
                          <td className={cn("px-2 py-2 text-[12px] font-bold", scoreTextClass(score))}>
                            {score.toFixed(1)}
                          </td>
                          <td className="px-2 py-2">
                            <span
                              className={cn(
                                "inline-block rounded-full border px-1.5 py-[2px] text-[10px] font-medium capitalize",
                                SEVERITY_PILL[r.severity] ?? "border-[#e8e6e0] bg-[#f5f4f0] text-slate-600",
                              )}
                            >
                              {r.severity}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={cn(
                                "inline-block rounded-full border px-1.5 py-[2px] text-[10px] font-medium",
                                STATUS_PILL[status] ?? "border-[#e8e6e0] bg-[#f5f4f0] text-slate-600",
                              )}
                            >
                              {r.needs_review ? t(C.pills.needsReview) : status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {pageCount > 1 && (
              <div className="flex items-center justify-between gap-2 border-t border-[#f0efe9] px-3 py-1.5 text-[11px]">
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  className="text-slate-500 disabled:opacity-40"
                >
                  {t(C.list.prev)}
                </button>
                <span className="text-slate-400">
                  {t(C.list.page)} {page + 1} / {pageCount}
                </span>
                <button
                  type="button"
                  disabled={page + 1 >= pageCount}
                  onClick={() => setPage((p) => p + 1)}
                  className="text-slate-500 disabled:opacity-40"
                >
                  {t(C.list.next)}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ───────────────── RIGHT COLUMN (59%) ───────────────── */}
        <div className="min-h-0 overflow-hidden rounded-[11px] border border-[#e8e6e0] bg-white lg:basis-[59%]">
          {selected ? (
            <CeDetailPanel
              key={selected}
              evaluationId={selected}
              canReview={canReview}
              channelLabel={selectedChannel}
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

function TabPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number | null;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full border px-3 py-[5px] text-[11px] font-medium transition-colors",
        active
          ? "border-slate-900 bg-slate-900 text-white"
          : "border-[#e8e6e0] bg-white text-slate-600 hover:bg-[#fafaf8]",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 text-[10px] font-semibold leading-[16px]",
          active ? "bg-white/20 text-white" : "bg-[#f5f4f0] text-slate-500",
        )}
      >
        {count === null ? "—" : count}
      </span>
    </button>
  );
}
