/**
 * Conversation Evaluation console — SU CoachAI /review parity layout.
 *
 * Two-column shell: filterable conversation list on the left (~40%), canonical
 * evaluation detail on the right (~59%). Status/severity/score all come from
 * public.ce_conversation_status_v via the CE server functions; the client never
 * re-derives them, and a failed query is surfaced as an error, never as an
 * empty success.
 *
 * Training is owned by SU CoachAI. This route deliberately exposes no training
 * eligibility, no training-candidate queue and no outbox/delivery surface.
 */

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { roleCan } from "@/lib/authz/consoleCapabilities";
import { useConsoleLang, COPY } from "@/lib/i18n/consoleLang";
import { CE_REVIEW_COPY as C } from "@/lib/i18n/ceReviewCopy";
import { listCeEvaluationsFn } from "@/lib/api/ce.functions";
import { ceClient } from "@/integrations/supabase/ce-schema";
import { CeDetailPanel } from "@/components/console/ce/CeDetailPanel";
import { LoadingState, PermissionDenied } from "@/components/console/PageStates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

/* eslint-disable @typescript-eslint/no-explicit-any */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 25;

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-700 border-red-200",
  high: "bg-orange-100 text-orange-700 border-orange-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-emerald-100 text-emerald-700 border-emerald-200",
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

function scoreClass(score: number): string {
  if (score < 60) return "bg-red-50 text-red-700 border-red-200";
  if (score < 80) return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-emerald-50 text-emerald-700 border-emerald-200";
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
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col gap-3 p-3">
      {/* Toolbar */}
      <div className="space-y-2 rounded-lg border bg-card px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <PillButton
            label={t(C.pills.all)}
            count={error ? null : allCount}
            active={pill === "all"}
            onClick={() => setPill("all")}
          />
          <PillButton
            label={t(C.pills.needsReview)}
            count={error ? null : needsReviewCount}
            active={pill === "needs_review"}
            onClick={() => setPill("needs_review")}
          />
          <span className="ml-1 text-xs text-muted-foreground">
            {error ? (
              t(C.countUnavailable)
            ) : (
              <>
                {filtered.length} / {allCount} {t(C.count)}
              </>
            )}
          </span>
          {canRun && (
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Input
                value={runId}
                onChange={(e) => setRunId(e.target.value)}
                placeholder={t(C.run.placeholder)}
                className="h-8 w-64 font-mono text-xs"
              />
              <Button size="sm" disabled={running} onClick={() => void runEvaluation()}>
                {running ? t(C.run.running) : t(C.run.action)}
              </Button>
            </div>
          )}
        </div>

        {/* Core filters — always visible, matching the SU review density */}
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <div className="mb-1 text-[10px] uppercase text-muted-foreground">{t(C.searchPlaceholder)}</div>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t(C.searchPlaceholder)}
              className="h-8 w-56 text-xs"
            />
          </div>
          <FilterSelect
            label={t(C.filters.status)}
            value={reviewStatus}
            onChange={setReviewStatus}
            options={[
              { v: "any", l: t(C.filters.any) },
              { v: "pending", l: "pending" },
              { v: "accepted", l: "accepted" },
              { v: "rejected", l: "rejected" },
            ]}
          />
          <FilterSelect
            label={t(C.filters.urgency)}
            value={severity}
            onChange={setSeverity}
            options={[
              { v: "any", l: t(C.filters.any) },
              { v: "critical", l: "critical" },
              { v: "high", l: "high" },
              { v: "medium", l: "medium" },
              { v: "low", l: "low" },
            ]}
          />
          <FilterSelect
            label={t(C.filters.score)}
            value={scoreBand}
            onChange={setScoreBand}
            options={[
              { v: "any", l: t(C.filters.any) },
              { v: "low", l: t(C.scoreBands.low) },
              { v: "mid", l: t(C.scoreBands.mid) },
              { v: "high", l: t(C.scoreBands.high) },
            ]}
          />
          <FilterSelect
            label={t(C.filters.channel)}
            value={channel}
            onChange={setChannel}
            options={[
              { v: "any", l: t(C.filters.any) },
              ...channelOptions.map((c) => ({ v: c.id, l: c.name })),
            ]}
          />
          {/* Intent has no canonical CE field: slot preserved, honestly disabled. */}
          <div>
            <div className="mb-1 text-[10px] uppercase text-muted-foreground">{t(C.filters.intent)}</div>
            <div
              aria-disabled="true"
              className="flex h-8 w-36 items-center rounded-md border bg-muted/40 px-2 text-[11px] text-muted-foreground"
            >
              {t(C.filters.unavailable)}
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setShowMore((s) => !s)}>
            {showMore ? t(C.filters.less) : t(C.filters.more)}
          </Button>
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            {t(C.filters.clear)}
          </Button>
        </div>

        {showMore && (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <div className="mb-1 text-[10px] uppercase text-muted-foreground">{t(C.filters.from)}</div>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="h-8 w-36 text-xs"
              />
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase text-muted-foreground">{t(C.filters.to)}</div>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="h-8 w-36 text-xs"
              />
            </div>
          </div>
        )}
      </div>

      {/* Two-column body: ~40% / ~59% with a ~1% gap */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[40%_1fr]">
        {/* Left panel */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border bg-card">
          <div className="grid grid-cols-[1.4fr_1fr_0.9fr_1fr_0.7fr] gap-2 border-b bg-muted/40 px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <span>{t(C.columns.conversation)}</span>
            <span>{t(C.columns.customer)}</span>
            <span>{t(C.columns.date)}</span>
            <span>{t(C.columns.channel)}</span>
            <span className="text-right">{t(C.columns.qaScore)}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <div className="m-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
                {t(C.list.loadFailed)} <span className="font-mono">{error}</span>
              </div>
            ) : loading ? (
              <div className="p-4 text-xs text-muted-foreground">{t(C.detail.loading)}</div>
            ) : pageRows.length === 0 ? (
              <div className="p-4 text-xs text-muted-foreground">{t(C.list.empty)}</div>
            ) : (
              <ul className="divide-y">
                {pageRows.map((r) => {
                  const chId = convChannel[r.conversation_id];
                  const chName = chId ? channelById[chId] : null;
                  const score = Number(r.overall_score);
                  const isSelected = selected === r.evaluation_id;
                  return (
                    <li key={r.evaluation_id}>
                      <button
                        type="button"
                        onClick={() => setSelected(r.evaluation_id)}
                        className={cn(
                          "w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                          isSelected && "border-l-2 border-l-primary bg-primary/5",
                        )}
                      >
                        <div className="grid grid-cols-[1.4fr_1fr_0.9fr_1fr_0.7fr] items-center gap-2">
                          <span className="truncate font-mono text-[12px] font-semibold">
                            {String(r.conversation_id).slice(0, 8)}…
                          </span>
                          {/* No authoritative customer source in canonical CE data. */}
                          <span className="truncate text-[11px] text-muted-foreground">—</span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {new Date(r.evaluated_at).toLocaleDateString()}
                          </span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {chName ?? t(C.meta.unavailable)}
                          </span>
                          <span
                            className={cn(
                              "justify-self-end rounded border px-1.5 py-0.5 text-[11px] font-semibold",
                              scoreClass(score),
                            )}
                          >
                            {score.toFixed(1)}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className={cn("text-[10px]", SEVERITY_STYLE[r.severity] ?? "")}
                          >
                            {r.severity}
                          </Badge>
                          {r.needs_review && (
                            <Badge variant="outline" className="text-[10px]">
                              {t(C.pills.needsReview)}
                            </Badge>
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-2 border-t px-3 py-1.5 text-xs">
              <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                {t(C.list.prev)}
              </Button>
              <span className="text-muted-foreground">
                {t(C.list.page)} {page + 1} / {pageCount}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={page + 1 >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                {t(C.list.next)}
              </Button>
            </div>
          )}
        </div>

        {/* Right panel */}
        <div className="min-h-0 overflow-hidden rounded-lg border bg-card">
          {selected ? (
            <CeDetailPanel
              key={selected}
              evaluationId={selected}
              canReview={canReview}
              channelLabel={selectedChannel}
              onChanged={reload}
            />
          ) : (
            <div className="p-6 text-sm text-muted-foreground">{t(C.detail.selectPrompt)}</div>
          )}
        </div>
      </div>
    </div>
  );
}

function PillButton({
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
        "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
          active ? "bg-primary-foreground/20" : "bg-muted",
        )}
      >
        {count === null ? "—" : count}
      </span>
    </button>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase text-muted-foreground">{label}</div>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-36 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.v} value={o.v}>
              {o.l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
