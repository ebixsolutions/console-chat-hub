import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import { roleCan } from "@/lib/authz/consoleCapabilities";
import { useConsoleLang, COPY } from "@/lib/i18n/consoleLang";
import {
  ceClient,
  EVALUATION_COLUMNS,
  DETAIL_COLUMNS,
  ATTEMPT_COLUMNS,
  OUTBOX_COLUMNS,
  type ConversationEvaluationRow,
  type ConversationEvaluationDetailRow,
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
  SNAPSHOT_COLUMNS,
  EMOTION_COLUMNS,
  NEXT_STEP_COLUMNS,
  DISCREPANCY_COLUMNS,
  ROOT_CAUSE_COLUMNS,
  QA_CASE_COLUMNS,
  KB_PUBLISH_COLUMNS,
  TRAINING_LINK_COLUMNS,
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

export const Route = createFileRoute("/_authenticated/console/conversation-evaluation")({
  component: ConversationEvaluationRoute,
});

const PAGE_SIZE = 25;
const THINKING_SENTINEL = "__THINKING__";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVALUATOR_ORDER = ["accuracy", "policy", "tone", "sales", "context", "hallucination"] as const;

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

/* ------------------------------------------------------------------ */
/* Snapshot integrity                                                  */
/* ------------------------------------------------------------------ */

/** Mirrors buildCanonicalBundle's transcript hash exactly. */
async function transcriptHash(messages: MessageRow[]): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = async (s: string) => {
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const kept = messages
    .filter((m) => !m.is_recalled && m.content !== THINKING_SENTINEL)
    .slice()
    .sort((a, b) =>
      a.created_at !== b.created_at
        ? a.created_at < b.created_at ? -1 : 1
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  const lines: string[] = [];
  for (const m of kept) {
    const body = m.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").slice(0, 4000);
    lines.push(`${m.id}:${await digest(body)}`);
  }
  return await digest(lines.join("\n") + "\n");
}

/* ------------------------------------------------------------------ */
/* Route shell                                                         */
/* ------------------------------------------------------------------ */

function ConversationEvaluationRoute() {
  const { role, loading } = useCurrentRole();
  const { t } = useConsoleLang();

  if (loading) return <LoadingState />;
  if (!roleCan(role, "ce.route.view")) {
    return <PermissionDenied message={t(COPY.ce.permissionDenied)} />;
  }
  return (
    <ConversationEvaluationContent
      canRun={roleCan(role, "ce.evaluation.run")}
      canReview={roleCan(role, "ce.review.decide")}
      canSeeDelivery={roleCan(role, "ce.training.dispatch")}
    />
  );
}

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
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
      // Training Ready vs Trained: post-filter using outbox and training link state
      if (view === "trained" || view === "trainingReady") {
        const evalIds = list.map((r) => r.id);
        if (evalIds.length > 0) {
          const { data: outboxRows } = await ceClient
            .from("evaluation_training_outbox")
            .select("evaluation_id, status")
            .in("evaluation_id", evalIds);
          const { data: linkRows } = await ceClient
            .from("ce_training_link")
            .select("evaluation_id, improved_state")
            .in("evaluation_id", evalIds)
            .eq("link_kind", "training_candidate");
          const delivered = new Set(
            (outboxRows ?? [])
              .filter((o: { status: string }) => o.status === "delivered")
              .map((o: { evaluation_id: string }) => o.evaluation_id),
          );
          const improved = new Set(
            (linkRows ?? [])
              .filter((l: { improved_state: string }) => l.improved_state === "received")
              .map((l: { evaluation_id: string }) => l.evaluation_id),
          );
          list =
            view === "trained"
              ? list.filter((r) => delivered.has(r.id) || improved.has(r.id))
              : list.filter((r) => !delivered.has(r.id) && !improved.has(r.id));
        }
      }
      // channel lives on the conversation, so it is applied after the page loads
      if (channel !== "any") {
        const ids = new Set(
          (
            await ceClient
              .from("conversations")
              .select("id, company_id, status, priority, channel_config_id, tags, created_at, updated_at, resolved_at")
              .eq("channel_config_id", channel)
          ).data?.map((c: { id: string }) => c.id) ?? [],
        );
        list = list.filter((r) => ids.has(r.conversation_id));
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
        setSelectedId(evaluation.id);
      } else if (status === "already_evaluated" && evaluation) {
        setSelectedId(evaluation.id);
      }
      setPage(0);
      await loadList();
    } finally {
      setRunning(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selected = rows.find((r) => r.id === selectedId) ?? null;

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
                        variant={selectedId === r.id ? "default" : "outline"}
                        size="sm"
                        onClick={() => setSelectedId(selectedId === r.id ? null : r.id)}
                      >
                        {selectedId === r.id ? t(COPY.ce.table.close) : t(COPY.ce.table.open)}
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

      {selected && (
        <EvaluationDetail
          key={selected.id}
          evaluation={selected}
          canReview={canReview}
          canSeeDelivery={canSeeDelivery}
          canRun={canRun}
          onChanged={() => {
            void loadList();
          }}
          onRetry={(cid: string) => {
            void runEvaluation(cid);
          }}
        />
      )}
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

function EvaluationDetail({
  evaluation, canReview, canSeeDelivery, canRun, onChanged, onRetry,
}: {
  evaluation: ConversationEvaluationRow;
  canReview: boolean;
  canSeeDelivery: boolean;
  canRun: boolean;
  onChanged: () => void;
  onRetry: (conversationId: string) => void;
}) {
  const { t } = useConsoleLang();
  const errorText = useErrorText();

  const [details, setDetails] = useState<ConversationEvaluationDetailRow[]>([]);
  const [transcript, setTranscript] = useState<MessageRow[]>([]);
  const [attempts, setAttempts] = useState<ConversationEvaluationAttemptRow[]>([]);
  const [outbox, setOutbox] = useState<TrainingOutboxRow[]>([]);
  const [audit, setAudit] = useState<AuditLogRow[]>([]);
  const [snapshot, setSnapshot] = useState<BundleSnapshotRow | null>(null);
  const [emotion, setEmotion] = useState<EmotionPointRow[]>([]);
  const [nextSteps, setNextSteps] = useState<NextStepRow[]>([]);
  const [discrepancies, setDiscrepancies] = useState<DiscrepancyRow[]>([]);
  const [rootCauses, setRootCauses] = useState<RootCauseRow[]>([]);
  const [qaCases, setQaCases] = useState<QaCaseRow[]>([]);
  const [kbStates, setKbStates] = useState<KbPublishStateRow[]>([]);
  const [links, setLinks] = useState<TrainingLinkRow[]>([]);
  const [rcCategory, setRcCategory] = useState("kb_gap");
  const [rcSummary, setRcSummary] = useState("");
  const [qaTitle, setQaTitle] = useState("");
  const [kbRef, setKbRef] = useState("");
  const [integrity, setIntegrity] = useState<"unknown" | "match" | "drift">("unknown");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const callRpc = async (fn: string, args: Record<string, unknown>, okLabel: string) => {
    setSubmitting(true);
    try {
      const { data, error: rpcError } = await ceClient.rpc(fn as never, args as never);
      if (rpcError) {
        toast.error(errorText("internal_error"));
        return;
      }
      const out = (data ?? {}) as Record<string, unknown>;
      if (String(out.result ?? "") === "success" || String(out.result ?? "") === "already_exists") {
        toast.success(okLabel);
        setReloadKey((k) => k + 1);
        onChanged();
      } else {
        toast.error(errorText(String(out.result ?? "unknown")));
      }
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      const [d, m, a, au, ob, sn, em, ns, dc, rc, qc, kb, tl] = await Promise.all([
        ceClient.from("conversation_evaluation_detail").select(DETAIL_COLUMNS).eq("evaluation_id", evaluation.id),
        ceClient
          .from("messages")
          .select("id, conversation_id, role, content, created_at, is_recalled, sender_id, sender_identity_verified_at")
          .eq("conversation_id", evaluation.conversation_id)
          .order("created_at", { ascending: true }),
        ceClient.from("conversation_evaluation_attempt").select(ATTEMPT_COLUMNS)
          .eq("conversation_id", evaluation.conversation_id).order("created_at", { ascending: false }),
        ceClient.from("audit_log").select("id, actor_id, action, resource_type, resource_id, diff, created_at")
          .eq("resource_type", "conversation_evaluation").eq("resource_id", evaluation.id)
          .order("created_at", { ascending: false }),
        canSeeDelivery
          ? ceClient.from("evaluation_training_outbox").select(OUTBOX_COLUMNS).eq("evaluation_id", evaluation.id)
          : Promise.resolve({ data: [], error: null }),
        ceClient.from("ce_bundle_snapshot").select(SNAPSHOT_COLUMNS).eq("attempt_id", evaluation.attempt_id).maybeSingle(),
        ceClient.from("ce_emotion_point").select(EMOTION_COLUMNS).eq("evaluation_id", evaluation.id).order("turn_index", { ascending: true }),
        ceClient.from("ce_next_step").select(NEXT_STEP_COLUMNS).eq("evaluation_id", evaluation.id).order("ordinal", { ascending: true }),
        ceClient.from("ce_discrepancy").select(DISCREPANCY_COLUMNS).eq("evaluation_id", evaluation.id),
        canSeeDelivery ? ceClient.from("ce_root_cause").select(ROOT_CAUSE_COLUMNS).eq("evaluation_id", evaluation.id).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
        canSeeDelivery ? ceClient.from("ce_qa_case").select(QA_CASE_COLUMNS).eq("evaluation_id", evaluation.id).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
        canSeeDelivery ? ceClient.from("ce_kb_publish_state").select(KB_PUBLISH_COLUMNS).eq("evaluation_id", evaluation.id).order("created_at", { ascending: false }) : Promise.resolve({ data: [], error: null }),
        ceClient.from("ce_training_link").select(TRAINING_LINK_COLUMNS).eq("evaluation_id", evaluation.id),
      ]);
      if (cancelled) return;
      const firstError = d.error ?? m.error ?? a.error ?? au.error ?? ob.error ??
        em.error ?? ns.error ?? dc.error ?? rc.error ?? qc.error ?? kb.error ?? tl.error;
      if (firstError) {
        setError(firstError.message);
      } else {
        setDetails((d.data ?? []) as ConversationEvaluationDetailRow[]);
        const msgs = (m.data ?? []) as MessageRow[];
        setTranscript(msgs);
        setAttempts((a.data ?? []) as ConversationEvaluationAttemptRow[]);
        setAudit((au.data ?? []) as AuditLogRow[]);
        setOutbox((ob.data ?? []) as TrainingOutboxRow[]);
        setSnapshot((sn.data ?? null) as BundleSnapshotRow | null);
        setEmotion((em.data ?? []) as EmotionPointRow[]);
        setNextSteps((ns.data ?? []) as NextStepRow[]);
        setDiscrepancies((dc.data ?? []) as DiscrepancyRow[]);
        setRootCauses((rc.data ?? []) as RootCauseRow[]);
        setQaCases((qc.data ?? []) as QaCaseRow[]);
        setKbStates((kb.data ?? []) as KbPublishStateRow[]);
        setLinks((tl.data ?? []) as TrainingLinkRow[]);
        const h = await transcriptHash(msgs);
        if (!cancelled) setIntegrity(h === null ? "unknown" : h === evaluation.input_snapshot_hash ? "match" : "drift");
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [evaluation.id, evaluation.attempt_id, evaluation.conversation_id, evaluation.input_snapshot_hash, canSeeDelivery, reloadKey]);

  const ordered = useMemo(
    () => [...details].sort(
      (a, b) => EVALUATOR_ORDER.indexOf(a.evaluator_type) - EVALUATOR_ORDER.indexOf(b.evaluator_type),
    ),
    [details],
  );

  const visible = useMemo(
    () => transcript.filter((m) => !m.is_recalled && m.content !== THINKING_SENTINEL),
    [transcript],
  );
  const aiReply = useMemo(() => [...visible].reverse().find((m) => m.role === "assistant") ?? null, [visible]);
  const humanReply = useMemo(
    () => visible.find((m) => m.sender_id !== null && m.sender_identity_verified_at !== null &&
      (!aiReply || m.created_at > aiReply.created_at)) ?? null,
    [visible, aiReply],
  );

  const submitReview = async (decision: "accept" | "reject" | "reopen") => {
    if (decision === "reject" && note.trim().length === 0) {
      toast.error(t(COPY.ce.review.noteRequired));
      return;
    }
    setSubmitting(true);
    try {
      const res = await invokeCe({
        action: "review",
        evaluation_id: evaluation.id,
        conversation_id: evaluation.conversation_id,
        decision,
        note: note.trim() || undefined,
      });
      if (!res.ok) {
        toast.error(errorText(res.code));
        return;
      }
      toast.success(`${t(COPY.ce.review.recorded)}: ${String(res.data.from)} → ${String(res.data.to)}`);
      setNote("");
      onChanged();
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} />;

  return (
    <Card>
      <CardContent className="pt-4">
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">{t(COPY.ce.tabs.overview)}</TabsTrigger>
            <TabsTrigger value="evaluation">{t(COPY.ce.tabs.evaluation)}</TabsTrigger>
            <TabsTrigger value="attempts">{t(COPY.ce.tabs.attempts)}</TabsTrigger>
            <TabsTrigger value="delivery">{t(COPY.ce.tabs.delivery)}</TabsTrigger>
            <TabsTrigger value="signals">{t(COPY.ce.tabs.signals)}</TabsTrigger>
            <TabsTrigger value="analysis">{t(COPY.ce.tabs.analysis)}</TabsTrigger>
            <TabsTrigger value="integration">{t(COPY.ce.tabs.integration)}</TabsTrigger>
            <TabsTrigger value="audit">{t(COPY.ce.tabs.audit)}</TabsTrigger>
          </TabsList>

          {/* ---------------- Overview ---------------- */}
          <TabsContent value="overview" className="space-y-4 pt-4">
            <div
              className={`rounded border p-2 text-xs ${
                integrity === "drift" ? "border-amber-300 bg-amber-50 text-amber-800" : "text-muted-foreground"
              }`}
            >
              {integrity === "match"
                ? t(COPY.ce.overview.integrityOk)
                : integrity === "drift"
                  ? t(COPY.ce.overview.integrityDrift)
                  : t(COPY.ce.overview.integrityUnknown)}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.overview.aiReply)}</CardTitle></CardHeader>
                <CardContent>
                  {aiReply ? (
                    <>
                      <div className="text-[11px] text-muted-foreground">{new Date(aiReply.created_at).toLocaleString()}</div>
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{aiReply.content}</p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t(COPY.ce.overview.noAi)}</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.overview.humanReply)}</CardTitle></CardHeader>
                <CardContent>
                  {humanReply ? (
                    <>
                      <div className="text-[11px] text-muted-foreground">{new Date(humanReply.created_at).toLocaleString()}</div>
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{humanReply.content}</p>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t(COPY.ce.overview.noHuman)}</p>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.overview.transcript)}</CardTitle></CardHeader>
              <CardContent>
                <p className="mb-2 text-[11px] text-muted-foreground">{t(COPY.ce.overview.liveWarning)}</p>
                <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
                  {visible.map((m) => (
                    <div key={m.id} className="rounded border p-2">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span className="font-medium uppercase">{m.role}</span>
                        <span>{new Date(m.created_at).toLocaleString()}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{m.content}</p>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- Evaluation ---------------- */}
          <TabsContent value="evaluation" className="space-y-4 pt-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.detail.breakdown)}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {ordered.length === 0 ? (
                  <EmptyState message={t(COPY.ce.detail.noDetails)} />
                ) : (
                  ordered.map((d) => (
                    <div key={d.evaluator_type} className="rounded border p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">{d.evaluator_type}</span>
                        <span className="text-sm">
                          {Number(d.raw_score).toFixed(2)}
                          <span className="ml-2 text-xs text-muted-foreground">
                            × {Number(d.weight).toFixed(2)} = {Number(d.weighted_score).toFixed(2)}
                          </span>
                        </span>
                      </div>
                      <div className="mt-2 text-[11px] uppercase text-muted-foreground">{t(COPY.ce.detail.justification)}</div>
                      <p className="text-xs leading-relaxed text-muted-foreground">{d.justification ?? t(COPY.ce.detail.none)}</p>
                      <div className="mt-2 text-[11px] uppercase text-muted-foreground">{t(COPY.ce.detail.correction)}</div>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {d.recommended_correction && d.recommended_correction.length > 0
                          ? d.recommended_correction
                          : t(COPY.ce.detail.none)}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                        <span className="uppercase">{t(COPY.ce.detail.refs)}</span>
                        {(d.grounding_refs ?? []).length === 0
                          ? <span>{t(COPY.ce.detail.none)}</span>
                          : (d.grounding_refs ?? []).map((r) => (
                              <span key={r} className="rounded bg-muted px-1.5 py-0.5 font-mono">{r}</span>
                            ))}
                        <span className="ml-auto font-mono">
                          {d.evaluator_model_version ?? "—"} · {d.evaluator_prompt_version ?? "—"}
                        </span>
                      </div>
                    </div>
                  ))
                )}

                <Separator />
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <Prov label={t(COPY.ce.provenance.contract)} value={evaluation.evaluation_contract_version} />
                  <Prov label={t(COPY.ce.provenance.model)} value={evaluation.model_version} />
                  <Prov label={t(COPY.ce.provenance.prompt)} value={evaluation.prompt_version} />
                  <Prov label={t(COPY.ce.provenance.deployment)} value={evaluation.source_deployment} />
                  <Prov label={t(COPY.ce.provenance.kbSnapshot)} value={evaluation.kb_snapshot_id} />
                  <Prov label={t(COPY.ce.provenance.policySnapshot)} value={evaluation.policy_snapshot_id} />
                  <Prov label={t(COPY.ce.provenance.snapshot)} value={evaluation.input_snapshot_hash} />
                  <Prov label={t(COPY.ce.provenance.bundle)} value={evaluation.bundle_hash ?? "—"} />
                  <Prov
                    label={t(COPY.ce.provenance.verifiedHuman)}
                    value={evaluation.has_verified_human_response ? t(COPY.ce.provenance.yes) : t(COPY.ce.provenance.no)}
                  />
                  <Prov
                    label={t(COPY.ce.provenance.trainingEligible)}
                    value={evaluation.training_eligible ? t(COPY.ce.provenance.yes) : t(COPY.ce.provenance.no)}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.review.title)}</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{t(COPY.ce.review.current)}:</span>
                  <span className={`rounded px-2 py-0.5 font-medium ${REVIEW_STYLE[evaluation.review_status]}`}>
                    {evaluation.review_status}
                  </span>
                  {evaluation.reviewed_at && <span className="text-muted-foreground">{new Date(evaluation.reviewed_at).toLocaleString()}</span>}
                </div>
                {evaluation.review_note && (
                  <p className="rounded bg-muted/40 p-2 text-xs text-muted-foreground">{evaluation.review_note}</p>
                )}
                {!canReview ? (
                  <p className="text-xs text-muted-foreground">{t(COPY.ce.review.readOnly)}</p>
                ) : (
                  <>
                    <p className="text-[11px] text-muted-foreground">{t(COPY.ce.delivery.sendHint)}</p>
                    <Textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder={t(COPY.ce.review.notePlaceholder)}
                      maxLength={1000}
                      rows={3}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={submitting || evaluation.review_status !== "pending"} onClick={() => void submitReview("accept")}>
                        {evaluation.training_eligible ? t(COPY.ce.delivery.sendToTraining) : t(COPY.ce.review.accept)}
                      </Button>
                      <Button size="sm" variant="destructive" disabled={submitting || evaluation.review_status !== "pending"} onClick={() => void submitReview("reject")}>
                        {t(COPY.ce.review.reject)}
                      </Button>
                      <Button size="sm" variant="outline" disabled={submitting || evaluation.review_status === "pending"} onClick={() => void submitReview("reopen")}>
                        {t(COPY.ce.review.reopen)}
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- Attempts ---------------- */}
          <TabsContent value="attempts" className="space-y-2 pt-4">
            {attempts.length === 0 ? (
              <EmptyState message={t(COPY.ce.attempts.empty)} />
            ) : (
              attempts.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-3 rounded border p-2 text-xs">
                  <span className="font-mono">{a.id.slice(0, 8)}…</span>
                  <span><span className="text-muted-foreground">{t(COPY.ce.attempts.status)}: </span>{a.status}</span>
                  <span><span className="text-muted-foreground">{t(COPY.ce.attempts.started)}: </span>{new Date(a.created_at).toLocaleString()}</span>
                  {a.error_message && (
                    <span className="text-destructive"><span className="text-muted-foreground">{t(COPY.ce.attempts.error)}: </span>{a.error_message}</span>
                  )}
                </div>
              ))
            )}
            {canRun && (
              <Button size="sm" variant="outline" onClick={() => onRetry(evaluation.conversation_id)}>
                {t(COPY.ce.attempts.retry)}
              </Button>
            )}
          </TabsContent>

          {/* ---------------- Delivery ---------------- */}
          <TabsContent value="delivery" className="space-y-2 pt-4">
            {!canSeeDelivery ? (
              <p className="text-xs text-muted-foreground">{t(COPY.ce.delivery.restricted)}</p>
            ) : outbox.length === 0 ? (
              <EmptyState message={t(COPY.ce.delivery.empty)} />
            ) : (
              outbox.map((o) => (
                <div key={o.id} className="flex flex-wrap items-center gap-3 rounded border p-2 text-xs">
                  <span className="font-mono">{o.id.slice(0, 8)}…</span>
                  <span>{o.status}</span>
                  <span><span className="text-muted-foreground">{t(COPY.ce.delivery.attempts)}: </span>{o.delivery_attempts}/{o.max_attempts}</span>
                  {o.delivered_at && <span><span className="text-muted-foreground">{t(COPY.ce.delivery.delivered)}: </span>{new Date(o.delivered_at).toLocaleString()}</span>}
                </div>
              ))
            )}
          </TabsContent>


          {/* ---------------- Signals ---------------- */}
          <TabsContent value="signals" className="space-y-4 pt-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.signals.emotion)}</CardTitle></CardHeader>
              <CardContent>
                {emotion.length === 0 ? <EmptyState message={t(COPY.ce.signals.emotionEmpty)} /> : (
                  <div className="space-y-1">
                    {emotion.map((e) => {
                      const pct = Math.max(0, Math.min(100, (Number(e.sentiment_score) + 100) / 2));
                      return (
                        <div key={e.id} className="flex items-center gap-2 text-xs">
                          <span className="w-10 shrink-0 text-muted-foreground">#{e.turn_index}</span>
                          <div className="h-2 flex-1 rounded bg-muted">
                            <div
                              className={`h-2 rounded ${Number(e.sentiment_score) < 0 ? "bg-red-400" : "bg-emerald-400"}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-28 shrink-0">{e.sentiment}</span>
                          <span className="w-16 shrink-0 text-right font-mono">{Number(e.sentiment_score).toFixed(0)}</span>
                          <span className="flex-1 truncate text-muted-foreground">
                            {e.trigger_label ? `${t(COPY.ce.signals.trigger)}: ${e.trigger_label}` : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.signals.nextSteps)}</CardTitle></CardHeader>
              <CardContent>
                {nextSteps.length === 0 ? <EmptyState message={t(COPY.ce.signals.nextStepsEmpty)} /> : (
                  <ol className="space-y-2">
                    {nextSteps.map((n) => (
                      <li key={n.id} className="rounded border p-2 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-medium">{n.ordinal + 1}. {n.title}</span>
                          <span className="text-muted-foreground">
                            {t(COPY.ce.signals.owner)}: {n.owner_role ?? "—"} · {n.status}
                          </span>
                        </div>
                        {n.detail && <p className="mt-1 text-muted-foreground">{n.detail}</p>}
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- Analysis ---------------- */}
          <TabsContent value="analysis" className="space-y-4 pt-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.analysis.discrepancy)}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {discrepancies.length === 0 ? <EmptyState message={t(COPY.ce.analysis.discrepancyEmpty)} /> : (
                  discrepancies.map((d) => (
                    <div key={d.id} className="rounded border p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{d.dimension}</span>
                        <span className={`rounded px-2 py-0.5 font-medium ${SEVERITY_STYLE[d.severity]}`}>{d.severity}</span>
                        <span className="text-muted-foreground">{d.divergence_kind}</span>
                        <span className="ml-auto flex gap-1">
                          {(d.grounding_refs ?? []).map((r) => (
                            <span key={r} className="rounded bg-muted px-1.5 py-0.5 font-mono">{r}</span>
                          ))}
                        </span>
                      </div>
                      <div className="mt-2 grid gap-2 md:grid-cols-3">
                        <Claim label={t(COPY.ce.analysis.aiClaim)} value={d.ai_claim} />
                        <Claim label={t(COPY.ce.analysis.humanClaim)} value={d.human_claim} />
                        <Claim label={t(COPY.ce.analysis.groundedClaim)} value={d.grounded_claim} />
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.analysis.rootCause)}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {!canSeeDelivery ? <p className="text-xs text-muted-foreground">{t(COPY.ce.delivery.restricted)}</p> : (
                  <>
                    {rootCauses.length === 0 ? <EmptyState message={t(COPY.ce.analysis.rootCauseEmpty)} /> : (
                      rootCauses.map((r) => (
                        <div key={r.id} className="rounded border p-2 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{r.category}</span>
                            <span className="ml-auto text-muted-foreground">
                              {t(COPY.ce.integration.remoteSync)}: {r.remote_sync_state}
                            </span>
                          </div>
                          <p className="mt-1 text-muted-foreground">{r.summary}</p>
                        </div>
                      ))
                    )}
                    <div className="flex flex-wrap items-end gap-2">
                      <Select value={rcCategory} onValueChange={setRcCategory}>
                        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {["kb_gap","kb_stale","policy_gap","prompt_defect","model_limitation","routing_error","human_error","unknown"].map((c) => (
                            <SelectItem key={c} value={c}>{c}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input value={rcSummary} onChange={(e) => setRcSummary(e.target.value)}
                             placeholder={t(COPY.ce.analysis.summary)} className="max-w-md" />
                      <Button size="sm" disabled={submitting || rcSummary.trim().length === 0}
                        onClick={() => void callRpc("ce_record_root_cause", {
                          p_evaluation_id: evaluation.id,
                          p_expected_conversation_id: evaluation.conversation_id,
                          p_category: rcCategory, p_summary: rcSummary.trim(), p_evidence: [],
                        }, t(COPY.ce.integration.recorded))}>
                        {t(COPY.ce.analysis.record)}
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.analysis.qaCase)}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {!canSeeDelivery ? <p className="text-xs text-muted-foreground">{t(COPY.ce.delivery.restricted)}</p> : (
                  <>
                    {qaCases.length === 0 ? <EmptyState message={t(COPY.ce.analysis.qaCaseEmpty)} /> : (
                      qaCases.map((q) => (
                        <div key={q.id} className="flex flex-wrap items-center gap-3 rounded border p-2 text-xs">
                          <span className="font-mono">{q.case_number}</span>
                          <span className="font-medium">{q.title}</span>
                          <span>{q.status}</span>
                          <span>{q.priority}</span>
                          <span className="ml-auto text-muted-foreground">
                            {t(COPY.ce.integration.remoteSync)}: {q.remote_sync_state}
                          </span>
                        </div>
                      ))
                    )}
                    <div className="flex flex-wrap items-end gap-2">
                      <Input value={qaTitle} onChange={(e) => setQaTitle(e.target.value)}
                             placeholder={t(COPY.ce.analysis.qaTitle)} className="max-w-md" />
                      <Button size="sm" disabled={submitting || qaTitle.trim().length === 0}
                        onClick={() => void callRpc("ce_create_qa_case", {
                          p_evaluation_id: evaluation.id,
                          p_expected_conversation_id: evaluation.conversation_id,
                          p_title: qaTitle.trim(), p_description: null, p_priority: "medium",
                        }, t(COPY.ce.integration.recorded))}>
                        {t(COPY.ce.analysis.createCase)}
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- Integration ---------------- */}
          <TabsContent value="integration" className="space-y-4 pt-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.integration.replayTitle)}</CardTitle></CardHeader>
              <CardContent>
                {!snapshot ? <EmptyState message={t(COPY.ce.integration.replayEmpty)} /> : (
                  <>
                    <p className="text-[11px] text-muted-foreground">{t(COPY.ce.integration.replayHint)}</p>
                    <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <Prov label={t(COPY.ce.provenance.bundle)} value={snapshot.bundle_hash} />
                      <Prov label={t(COPY.ce.provenance.snapshot)} value={snapshot.transcript_hash} />
                      <Prov label={t(COPY.ce.provenance.model)} value={snapshot.model_version} />
                      <Prov label={t(COPY.ce.provenance.prompt)} value={snapshot.prompt_version} />
                      <Prov label={t(COPY.ce.provenance.kbSnapshot)} value={snapshot.kb_snapshot_id} />
                      <Prov label={t(COPY.ce.provenance.policySnapshot)} value={snapshot.policy_snapshot_id} />
                      <Prov label={t(COPY.ce.integration.retention)} value={new Date(snapshot.retention_expires_at).toLocaleDateString()} />
                    </div>
                    <Tabs defaultValue="transcript" className="mt-3">
                      <TabsList>
                        <TabsTrigger value="transcript">Transcript</TabsTrigger>
                        <TabsTrigger value="canonical">Canonical Input</TabsTrigger>
                        <TabsTrigger value="grounding">Grounding Evidence</TabsTrigger>
                      </TabsList>
                      <TabsContent value="transcript" className="mt-2">
                        <div className="max-h-[320px] space-y-2 overflow-y-auto pr-1">
                          {snapshot.normalized_transcript.map((m) => (
                            <div key={m.id} className="rounded border p-2">
                              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                                <span className="font-medium uppercase">{m.role}</span>
                                <span>{new Date(m.created_at).toLocaleString()}</span>
                              </div>
                              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{m.content}</p>
                            </div>
                          ))}
                        </div>
                      </TabsContent>
                      <TabsContent value="canonical" className="mt-2">
                        <pre className="max-h-[320px] overflow-auto rounded bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap font-mono">{snapshot.canonical_input}</pre>
                      </TabsContent>
                      <TabsContent value="grounding" className="mt-2 space-y-3">
                        <div>
                          <div className="text-[11px] uppercase text-muted-foreground mb-1">KB Evidence</div>
                          <pre className="max-h-[200px] overflow-auto rounded bg-muted/40 p-3 text-xs whitespace-pre-wrap font-mono">{snapshot.grounding_evidence?.kb_block || ""}</pre>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase text-muted-foreground mb-1">Policy Evidence</div>
                          <pre className="max-h-[200px] overflow-auto rounded bg-muted/40 p-3 text-xs whitespace-pre-wrap font-mono">{snapshot.grounding_evidence?.policy_block || ""}</pre>
                        </div>
                      </TabsContent>
                    </Tabs>
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.integration.training)}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {links.length === 0 ? <EmptyState message={t(COPY.ce.delivery.empty)} /> : (
                  links.map((l) => (
                    <div key={l.id} className="rounded border p-2 text-xs">
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="font-medium">
                          {l.link_kind === "training_candidate" ? t(COPY.ce.integration.training) : t(COPY.ce.integration.kbGap)}
                        </span>
                        <span>{l.local_state}</span>
                        <span className="ml-auto text-muted-foreground">
                          {t(COPY.ce.integration.remoteSync)}: {l.remote_sync_state}
                        </span>
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        <span className="uppercase">{t(COPY.ce.integration.improved)}: </span>
                        {l.improved_state === "received" && l.improved_result
                          ? <span className="font-mono">{JSON.stringify(l.improved_result)}</span>
                          : <span>{t(COPY.ce.integration.improvedPending)}</span>}
                      </div>
                    </div>
                  ))
                )}
                <p className="text-[11px] text-muted-foreground">{t(COPY.ce.integration.remoteBlocked)}</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">{t(COPY.ce.integration.kbPublish)}</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {!canSeeDelivery ? <p className="text-xs text-muted-foreground">{t(COPY.ce.delivery.restricted)}</p> : (
                  <>
                    {kbStates.length === 0 ? <EmptyState message={t(COPY.ce.integration.kbPublishEmpty)} /> : (
                      kbStates.map((k) => (
                        <div key={k.id} className="flex flex-wrap items-center gap-3 rounded border p-2 text-xs">
                          <span className="font-mono">{k.kb_document_ref}</span>
                          <span>{k.action}</span>
                          <span>{k.state}</span>
                          <span className="ml-auto text-muted-foreground">
                            {t(COPY.ce.integration.remoteSync)}: {k.remote_sync_state}
                          </span>
                          {k.last_error && <span className="text-destructive">{k.last_error}</span>}
                        </div>
                      ))
                    )}
                    <div className="flex flex-wrap items-end gap-2">
                      <Input value={kbRef} onChange={(e) => setKbRef(e.target.value)}
                             placeholder={t(COPY.ce.integration.docRef)} className="max-w-md font-mono text-xs" />
                      <Button size="sm" variant="outline" disabled={submitting || kbRef.trim().length === 0}
                        onClick={() => void callRpc("ce_set_kb_publish_state", {
                          p_evaluation_id: evaluation.id,
                          p_expected_conversation_id: evaluation.conversation_id,
                          p_kb_document_ref: kbRef.trim(), p_action: "publish", p_state: "requested",
                        }, t(COPY.ce.integration.recorded))}>
                        {t(COPY.ce.integration.publish)}
                      </Button>
                      <Button size="sm" variant="outline" disabled={submitting || kbRef.trim().length === 0}
                        onClick={() => void callRpc("ce_set_kb_publish_state", {
                          p_evaluation_id: evaluation.id,
                          p_expected_conversation_id: evaluation.conversation_id,
                          p_kb_document_ref: kbRef.trim(), p_action: "rollback", p_state: "requested",
                        }, t(COPY.ce.integration.recorded))}>
                        {t(COPY.ce.integration.rollback)}
                      </Button>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------------- Audit ---------------- */}
          <TabsContent value="audit" className="space-y-2 pt-4">
            {audit.length === 0 ? (
              <EmptyState message={t(COPY.ce.audit.empty)} />
            ) : (
              audit.map((a) => (
                <div key={a.id} className="rounded border p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-3">
                    <span><span className="text-muted-foreground">{t(COPY.ce.audit.action)}: </span>{a.action}</span>
                    <span className="font-mono">{(a.actor_id ?? "—").slice(0, 8)}…</span>
                    <span className="ml-auto text-muted-foreground">{new Date(a.created_at).toLocaleString()}</span>
                  </div>
                  {a.diff && (
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                      {String(a.diff.from ?? "")} → {String(a.diff.to ?? "")}
                    </p>
                  )}
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function Claim({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded bg-muted/30 p-2">
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <p className="mt-1 whitespace-pre-wrap leading-relaxed">{value && value.length > 0 ? value : "—"}</p>
    </div>
  );
}

function Prov({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-mono" title={value}>{value}</span>
    </>
  );
}
