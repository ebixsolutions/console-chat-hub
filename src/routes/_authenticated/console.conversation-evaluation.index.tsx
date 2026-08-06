import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { roleCan } from "@/lib/authz/consoleCapabilities";
import { useConsoleLang, COPY } from "@/lib/i18n/consoleLang";
import {
  ceClient,
  EVALUATION_COLUMNS,
  ATTEMPT_COLUMNS,
  OUTBOX_COLUMNS,
  type ConversationEvaluationRow,
  type ConversationEvaluationAttemptRow,
  type TrainingOutboxRow,
  type MessageRow,
  type AuditLogRow,
  type ChannelConfigRow,
  type BundleSnapshotRow,
  type EmotionPointRow,
  type NextStepRow,
  type DiscrepancyRow,
  type RootCauseRow,
  type QaCaseRow,
  type KbPublishStateRow,
  type TrainingLinkRow,
  type ReviewStatus,
  type Severity,
} from "@/integrations/supabase/ce-schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { LoadingState, EmptyState, ErrorState, PermissionDenied, PageHeader } from "@/components/console/PageStates";

const PAGE_SIZE = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type ViewKey = "all" | "needsReview" | "trainingReady" | "trained";

const SEVERITY_STYLE: Record<Severity, string> = {
  critical: "bg-red-100 text-red-700",
  high: "bg-orange-100 text-orange-700",
  medium: "bg-amber-100 text-amber-700",
  low: "bg-emerald-100 text-emerald-700",
};
const REVIEW_STYLE: Record<ReviewStatus, string> = {
  pending: "bg-slate-100 text-slate-700",
  accepted: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
};


export const Route = createFileRoute("/_authenticated/console/conversation-evaluation/")({
  component: ConversationEvaluationIndex,
});

function ConversationEvaluationIndex() {
  const { role, loading } = useCurrentRole();
  const { t } = useConsoleLang();

  if (loading) return <LoadingState />;
  return (
    <ConversationEvaluationContent
      canRun={roleCan(role, "ce.evaluation.run")}
      canReview={roleCan(role, "ce.review.decide")}
      canSeeDelivery={roleCan(role, "ce.training.dispatch")}
    />
  );
}

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Error mapping — the EF returns codes, the UI renders sentences       */
/* ------------------------------------------------------------------ */

function useErrorText() {
  const { t } = useConsoleLang();
  return useCallback(
    (code: unknown) => {
      const key = String(code ?? "unknown") as keyof typeof COPY.ce.errors;
      const entry = COPY.ce.errors[key] ?? COPY.ce.errors.unknown;
      return t(entry);
    },
    [t],
  );
}

async function invokeCe(body: Record<string, unknown>): Promise<
  { ok: true; data: Record<string, unknown> } | { ok: false; code: string }
> {
  const { data, error } = await supabase.functions.invoke("conversation-evaluate", { body });
  if (error) {
    // The Edge Function's fixed error contract travels in the response body.
    const ctx = (error as { context?: { body?: unknown } }).context;
    let code = "unknown";
    try {
      const parsed = typeof ctx?.body === "string" ? JSON.parse(ctx.body) : ctx?.body;
      if (parsed && typeof parsed === "object" && "error" in parsed) code = String((parsed as { error: unknown }).error);
    } catch {
      /* keep unknown */
    }
    return { ok: false, code };
  }
  const payload = (data ?? {}) as Record<string, unknown>;
  if (payload.error) return { ok: false, code: String(payload.error) };
  return { ok: true, data: payload };
}

/* ------------------------------------------------------------------ */
/* List                                                                */
/* ------------------------------------------------------------------ */

function ConversationEvaluationContent({
  canRun,
  canReview,
  canSeeDelivery,
}: {
  canRun: boolean;
  canReview: boolean;
  canSeeDelivery: boolean;
}) {
  const { t } = useConsoleLang();
  const errorText = useErrorText();
  const navigate = useNavigate();

  const [view, setView] = useState<ViewKey>("all");
  const [rows, setRows] = useState<ConversationEvaluationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<"any" | Severity>("any");
  const [review, setReview] = useState<"any" | ReviewStatus>("any");
  const [channel, setChannel] = useState<string>("any");
  const [minScore, setMinScore] = useState("");
  const [maxScore, setMaxScore] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [channels, setChannels] = useState<ChannelConfigRow[]>([]);
  const [runTarget, setRunTarget] = useState("");
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await ceClient.from("channel_config").select("id, name, channel_type, company_id");
      if (!cancelled && data) setChannels(data as ChannelConfigRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);

    let q = ceClient
      .from("conversation_evaluation")
      .select(EVALUATION_COLUMNS, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

    if (view === "needsReview") q = q.eq("review_status", "pending");
    if (view === "trainingReady") q = q.eq("training_eligible", true).eq("review_status", "accepted");
    // Trained = has a delivered outbox entry (checked post-fetch)

    if (severity !== "any") q = q.eq("severity", severity);
    if (review !== "any") q = q.eq("review_status", review);
    if (minScore.trim() !== "" && !Number.isNaN(Number(minScore))) q = q.gte("overall_score", Number(minScore));
    if (maxScore.trim() !== "" && !Number.isNaN(Number(maxScore))) q = q.lte("overall_score", Number(maxScore));
    if (from) q = q.gte("created_at", new Date(from).toISOString());
    if (to) q = q.lte("created_at", new Date(`${to}T23:59:59.999Z`).toISOString());

    const term = search.trim();
    if (UUID_RE.test(term)) q = q.or(`id.eq.${term},conversation_id.eq.${term}`);

    const { data, error, count } = await q;
    if (error) {
      setListError(error.message);
      setRows([]);
      setTotal(0);
    } else {
      let list = (data ?? []) as ConversationEvaluationRow[];
      // channel lives on the conversation, so it is applied after the page loads
      if (channel !== "any") {
        const ids = new Set(
          (
            await ceClient
              .from("conversations")
              .select("id, company_id, status, priority, channel_config_id, tags, created_at, updated_at, resolved_at")
              .eq("channel_config_id", channel)
          ).data?.map((c) => c.id) ?? [],
        );
        list = list.filter((r) => ids.has(r.conversation_id));
      }
      // Training Ready vs Trained: post-filter using outbox and training link state
      if (view === "trained" || view === "trainingReady") {
        const evalIds = list.map((r) => r.id);
        if (evalIds.length > 0) {
          const { data: outboxRows } = await ceClient.from("evaluation_training_outbox")
            .select("evaluation_id, status").in("evaluation_id", evalIds);
          const { data: linkRows } = await ceClient.from("ce_training_link")
            .select("evaluation_id, improved_state").in("evaluation_id", evalIds)
            .eq("link_kind", "training_candidate");
          const delivered = new Set(
            (outboxRows ?? []).filter((o: { status: string }) => o.status === "delivered").map((o: { evaluation_id: string }) => o.evaluation_id),
          );
          const improved = new Set(
            (linkRows ?? []).filter((l: { improved_state: string }) => l.improved_state === "received").map((l: { evaluation_id: string }) => l.evaluation_id),
          );
          if (view === "trained") {
            list = list.filter((r) => delivered.has(r.id) || improved.has(r.id));
          } else {
            list = list.filter((r) => !delivered.has(r.id) && !improved.has(r.id));
          }
        }
      }
      setRows(list);
      setTotal(count ?? 0);
    }
    setListLoading(false);
  }, [page, view, severity, review, channel, minScore, maxScore, from, to, search]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const clearFilters = () => {
    setSearch("");
    setSeverity("any");
    setReview("any");
    setChannel("any");
    setMinScore("");
    setMaxScore("");
    setFrom("");
    setTo("");
    setPage(0);
  };

  const runEvaluation = async (conversationId: string) => {
    if (!UUID_RE.test(conversationId)) {
      toast.error(t(COPY.ce.run.invalidId));
      return;
    }
    setRunning(true);
    try {
      const res = await invokeCe({ action: "evaluate", conversation_id: conversationId });
      if (!res.ok) {
        toast.error(errorText(res.code));
        return;
      }
      const status = String(res.data.status ?? "");
      const evaluation = res.data.evaluation as ConversationEvaluationRow | null;
      if (status === "completed" && evaluation) {
        toast.success(`${evaluation.overall_score} · ${evaluation.severity}`);
        navigate({ to: "/console/conversation-evaluation/$evaluationId", params: { evaluationId: evaluation.id } });
      } else if (status === "already_evaluated" && evaluation) {
        navigate({ to: "/console/conversation-evaluation/$evaluationId", params: { evaluationId: evaluation.id } });
      }
      setPage(0);
      await loadList();
    } finally {
      setRunning(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <PageHeader
        title={t(COPY.ce.title)}
        description={t(COPY.ce.subtitle)}
        badge={<Badge variant="outline">{total}</Badge>}
      />

      <Tabs value={view} onValueChange={(v) => { setView(v as ViewKey); setPage(0); }}>
        <TabsList>
          <TabsTrigger value="all">{t(COPY.ce.views.all)}</TabsTrigger>
          <TabsTrigger value="needsReview">{t(COPY.ce.views.needsReview)}</TabsTrigger>
          <TabsTrigger value="trainingReady">{t(COPY.ce.views.trainingReady)}</TabsTrigger>
          <TabsTrigger value="trained">{t(COPY.ce.views.trained)}</TabsTrigger>
        </TabsList>
      </Tabs>

      {canRun && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">{t(COPY.ce.run.title)}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-2">
            <Input
              value={runTarget}
              onChange={(e) => setRunTarget(e.target.value)}
              placeholder={t(COPY.ce.run.placeholder)}
              className="max-w-sm font-mono text-xs"
            />
            <Button onClick={() => void runEvaluation(runTarget.trim())} disabled={running}>
              {running ? t(COPY.ce.run.running) : t(COPY.ce.run.submit)}
            </Button>
            <span className="text-xs text-muted-foreground">{t(COPY.ce.run.hint)}</span>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="flex flex-wrap items-end gap-2 py-4">
          <Input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            placeholder={t(COPY.ce.search)}
            className="max-w-xs font-mono text-xs"
          />
          <FilterSelect
            label={t(COPY.ce.filters.severity)}
            value={severity}
            onChange={(v) => { setSeverity(v as "any" | Severity); setPage(0); }}
            options={[["any", t(COPY.ce.filters.any)], ["critical", "critical"], ["high", "high"], ["medium", "medium"], ["low", "low"]]}
          />
          <FilterSelect
            label={t(COPY.ce.filters.review)}
            value={review}
            onChange={(v) => { setReview(v as "any" | ReviewStatus); setPage(0); }}
            options={[["any", t(COPY.ce.filters.any)], ["pending", "pending"], ["accepted", "accepted"], ["rejected", "rejected"]]}
          />
          <FilterSelect
            label={t(COPY.ce.filters.channel)}
            value={channel}
            onChange={(v) => { setChannel(v); setPage(0); }}
            options={[["any", t(COPY.ce.filters.any)], ...channels.map((c) => [c.id, c.name] as [string, string])]}
          />
          <NumberFilter label={t(COPY.ce.filters.minScore)} value={minScore} onChange={(v) => { setMinScore(v); setPage(0); }} />
          <NumberFilter label={t(COPY.ce.filters.maxScore)} value={maxScore} onChange={(v) => { setMaxScore(v); setPage(0); }} />
          <DateFilter label={t(COPY.ce.filters.from)} value={from} onChange={(v) => { setFrom(v); setPage(0); }} />
          <DateFilter label={t(COPY.ce.filters.to)} value={to} onChange={(v) => { setTo(v); setPage(0); }} />
          <Button variant="ghost" size="sm" onClick={clearFilters}>{t(COPY.ce.filters.clear)}</Button>
        </CardContent>
      </Card>

      {listLoading ? (
        <LoadingState />
      ) : listError ? (
        <ErrorState message={listError} />
      ) : rows.length === 0 ? (
        <EmptyState message={t(COPY.ce.table.empty)} />
      ) : (
        <Card>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">{t(COPY.ce.table.evaluated)}</th>
                  <th className="px-3 py-2 text-left">{t(COPY.ce.table.conversation)}</th>
                  <th className="px-3 py-2 text-right">{t(COPY.ce.table.overall)}</th>
                  <th className="px-3 py-2 text-left">{t(COPY.ce.table.severity)}</th>
                  <th className="px-3 py-2 text-left">{t(COPY.ce.table.review)}</th>
                  <th className="px-3 py-2 text-left">{t(COPY.ce.table.training)}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="px-3 py-2 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.conversation_id.slice(0, 8)}…</td>
                    <td className="px-3 py-2 text-right font-medium">{Number(r.overall_score).toFixed(2)}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[r.severity]}`}>{r.severity}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${REVIEW_STYLE[r.review_status]}`}>{r.review_status}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{r.training_eligible ? "eligible" : "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate({ to: "/console/conversation-evaluation/$evaluationId", params: { evaluationId: r.id } })}
                      >
                        {t(COPY.ce.table.open)}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          {t(COPY.ce.table.prev)}
        </Button>
        <span>{t(COPY.ce.table.page)} {page + 1} / {pageCount}</span>
        <Button variant="outline" size="sm" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>
          {t(COPY.ce.table.next)}
        </Button>
      </div>
    </div>
  );
}

function FilterSelect({
  label, value, onChange, options,
}: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]> }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function NumberFilter({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Input type="number" min={0} max={100} value={value} onChange={(e) => onChange(e.target.value)} className="w-24" />
    </div>
  );
}

function DateFilter({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <Input type="date" value={value} onChange={(e) => onChange(e.target.value)} className="w-40" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Detail                                                              */
/* ------------------------------------------------------------------ */
