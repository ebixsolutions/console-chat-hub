/**
 * Conversation Evaluation console — SU CoachAI /review parity layout.
 *
 * Two-column shell: filterable conversation list on the left, canonical
 * evaluation detail on the right. Status/severity/score/eligibility all come
 * from public.ce_conversation_status_v via the CE server functions; the client
 * never re-derives them.
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

async function invokeCe(body: Record<string, unknown>): Promise<{ ok: boolean; code?: string }> {
  const { data, error } = await supabase.functions.invoke("conversation-evaluate", { body });
  if (error) {
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
  return { ok: true };
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await listCeEvaluationsFn({
          data: {
            tab: pill,
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
  }, [pill, search, severity, fromDate, toDate, reloadKey]);

  const channelOptions = useMemo(
    () => Object.entries(channelById).map(([id, name]) => ({ id, name })),
    [channelById],
  );

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      const score = Number(r.overall_score);
      if (scoreBand === "low" && !(score < 60)) return false;
      if (scoreBand === "mid" && !(score >= 60 && score < 80)) return false;
      if (scoreBand === "high" && !(score >= 80)) return false;
      if (reviewStatus !== "any" && (reviewById[r.evaluation_id] ?? "pending") !== reviewStatus) return false;
      if (channel !== "any" && (convChannel[r.conversation_id] ?? "") !== channel) return false;
      return true;
    });
  }, [rows, scoreBand, reviewStatus, reviewById, channel, convChannel]);

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
      const res = await invokeCe({ conversation_id: id });
      if (!res.ok) {
        const key = String(res.code ?? "unknown") as keyof typeof COPY.ce.errors;
        toast.error(t(COPY.ce.errors[key] ?? COPY.ce.errors.unknown));
      } else {
        setRunId("");
        reload();
      }
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
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col">
      {/* Toolbar */}
      <div className="space-y-2 border-b bg-background px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "needs_review"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPill(p)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                pill === p
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              {t(C.pills[p === "all" ? "all" : "needsReview"])}
            </button>
          ))}
          <span className="text-xs text-muted-foreground">
            {filtered.length} {t(C.count)}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t(C.searchPlaceholder)}
              className="h-8 w-60 text-xs"
            />
            <Button size="sm" variant="ghost" onClick={() => setShowMore((s) => !s)}>
              {showMore ? t(C.filters.less) : t(C.filters.more)}
            </Button>
            {canRun && (
              <>
                <Input
                  value={runId}
                  onChange={(e) => setRunId(e.target.value)}
                  placeholder={t(C.run.placeholder)}
                  className="h-8 w-64 font-mono text-xs"
                />
                <Button size="sm" disabled={running} onClick={() => void runEvaluation()}>
                  {running ? t(C.run.running) : t(C.run.action)}
                </Button>
              </>
            )}
          </div>
        </div>

        {showMore && (
          <div className="flex flex-wrap items-end gap-2">
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
            <div>
              <div className="mb-1 text-[10px] uppercase text-muted-foreground">{t(C.filters.intent)}</div>
              <div className="h-8 rounded-md border bg-muted/40 px-2 text-[11px] leading-8 text-muted-foreground">
                {t(C.filters.unavailable)}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase text-muted-foreground">{t(C.filters.from)}</div>
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-8 w-36 text-xs" />
            </div>
            <div>
              <div className="mb-1 text-[10px] uppercase text-muted-foreground">{t(C.filters.to)}</div>
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-8 w-36 text-xs" />
            </div>
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              {t(C.filters.clear)}
            </Button>
          </div>
        )}
      </div>

      {/* Two-column body */}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(340px,420px)_1fr]">
        {/* List */}
        <div className="min-h-0 overflow-y-auto border-r">
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
                return (
                  <li key={r.evaluation_id}>
                    <button
                      type="button"
                      onClick={() => setSelected(r.evaluation_id)}
                      className={cn(
                        "w-full px-3.5 py-3 text-left transition-colors hover:bg-muted/50",
                        selected === r.evaluation_id && "bg-muted",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[12px] font-semibold">
                          {String(r.conversation_id).slice(0, 8)}…
                        </span>
                        <span className={cn("rounded border px-1.5 py-0.5 text-[11px] font-semibold", scoreClass(score))}>
                          {score.toFixed(1)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span>{new Date(r.evaluated_at).toLocaleDateString()}</span>
                        <span>·</span>
                        <span>{chName ?? t(C.meta.unavailable)}</span>
                        <Badge variant="outline" className={cn("ml-auto text-[10px]", SEVERITY_STYLE[r.severity] ?? "")}>
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
          {pageCount > 1 && (
            <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-xs">
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

        {/* Detail */}
        <div className="min-h-0 overflow-hidden">
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
