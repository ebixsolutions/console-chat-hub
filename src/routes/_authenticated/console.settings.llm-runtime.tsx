import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, Clock3, Cpu, Gauge, Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useCurrentRole } from "@/hooks/useCurrentRole";
import {
  LoadingState,
  PermissionDenied,
  PageHeader,
} from "@/components/console/PageStates";
import { useServerFn } from "@tanstack/react-start";
import {
  getLlmRuntimeTelemetryFn,
  type LlmRuntimeLogRow,
} from "@/lib/api/llmRuntime.service";

export const Route = createFileRoute(
  "/_authenticated/console/settings/llm-runtime",
)({
  component: LlmRuntimePage,
});

type RuntimeState = "loading" | "ready" | "error";

type LlmLogRow = LlmRuntimeLogRow;

type ParsedLlmCall = {
  id: string;
  createdAt: string;
  model: string;
  purpose: string;
  outcome: string;
  inputTokens: number;
  outputTokens: number;
  attempts: number;
  latencyMs: number | null;
  responseStatus: number | null;
  errorCode: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asFiniteNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseCall(row: LlmLogRow): ParsedLlmCall {
  const payload = asRecord(row.request_payload);
  return {
    id: row.id,
    createdAt: row.created_at,
    model:
      typeof payload.model === "string" && payload.model.trim()
        ? payload.model.trim()
        : "unknown",
    purpose:
      typeof payload.purpose === "string" && payload.purpose.trim()
        ? payload.purpose.trim()
        : "unknown",
    outcome:
      typeof payload.outcome === "string" && payload.outcome.trim()
        ? payload.outcome.trim()
        : row.response_status && row.response_status >= 200 && row.response_status < 300
          ? "success"
          : "failed",
    inputTokens: asFiniteNumber(payload.input_tokens),
    outputTokens: asFiniteNumber(payload.output_tokens),
    attempts: Math.max(0, Math.trunc(asFiniteNumber(payload.attempts))),
    latencyMs:
      typeof row.response_latency_ms === "number" &&
      Number.isFinite(row.response_latency_ms)
        ? row.response_latency_ms
        : null,
    responseStatus: row.response_status,
    errorCode:
      typeof payload.error_code === "string" && payload.error_code.trim()
        ? payload.error_code.trim()
        : row.error_message || null,
  };
}

function LlmRuntimePage() {
  const { role: productionRole, loading } = useCurrentRole();

  if (loading) return <LoadingState />;

  const canView =
    productionRole === "admin" || productionRole === "supervisor";
  if (!canView) return <PermissionDenied />;

  return <LlmRuntimeTelemetry />;
}

function LlmRuntimeTelemetry() {
  const [state, setState] = useState<RuntimeState>("loading");
  const [rows, setRows] = useState<ParsedLlmCall[]>([]);
  const [error, setError] = useState("");

  const fetchTelemetry = useServerFn(getLlmRuntimeTelemetryFn);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setState("loading");
      setError("");

      try {
        const result = await fetchTelemetry();
        if (cancelled) return;

        if (!result.ok || !result.data) {
          setError(result.error ?? "llm_runtime_unavailable");
          setState("error");
          return;
        }

        setRows(result.data.rows.map(parseCall));
        setState("ready");
      } catch {
        if (cancelled) return;
        setError("llm_runtime_unavailable");
        setState("error");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchTelemetry]);

  const stats = useMemo(() => {
    const total = rows.length;
    const success = rows.filter((r) => r.outcome === "success").length;
    const latencies = rows
      .map((r) => r.latencyMs)
      .filter((v): v is number => typeof v === "number");
    const averageLatency =
      latencies.length > 0
        ? Math.round(
            latencies.reduce((sum, value) => sum + value, 0) /
              latencies.length,
          )
        : null;
    const inputTokens = rows.reduce((sum, r) => sum + r.inputTokens, 0);
    const outputTokens = rows.reduce((sum, r) => sum + r.outputTokens, 0);
    const models = [...new Set(rows.map((r) => r.model).filter((m) => m !== "unknown"))];

    return {
      total,
      successRate: total > 0 ? Math.round((success / total) * 100) : null,
      averageLatency,
      totalTokens: inputTokens + outputTokens,
      models,
    };
  }, [rows]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="LLM Runtime"
        description="Tenant-scoped runtime telemetry from the governed AI model router."
      />

      <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-relaxed text-blue-900">
        Provider credentials and model environment variables remain server-side
        and are not exposed here. This page reports only persisted runtime
        metadata: model identifier, purpose, outcome, token counts, attempts,
        latency and safe error codes.
      </div>

      {state === "loading" && (
        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading live LLM runtime telemetry…
        </div>
      )}

      {state === "error" && (
        <div className="flex min-h-48 flex-col items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 p-6 text-red-700">
          <AlertCircle className="h-7 w-7" />
          <div className="text-sm font-semibold">LLM runtime telemetry unavailable</div>
          <div className="font-mono text-xs">{error}</div>
        </div>
      )}

      {state === "ready" && (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <MetricCard
              icon={<Activity className="h-4 w-4" />}
              label="Recent Calls"
              value={String(stats.total)}
            />
            <MetricCard
              icon={<Gauge className="h-4 w-4" />}
              label="Success Rate"
              value={
                stats.successRate === null ? "—" : `${stats.successRate}%`
              }
            />
            <MetricCard
              icon={<Clock3 className="h-4 w-4" />}
              label="Avg Latency"
              value={
                stats.averageLatency === null
                  ? "—"
                  : `${stats.averageLatency} ms`
              }
            />
            <MetricCard
              icon={<Cpu className="h-4 w-4" />}
              label="Tokens (100 calls)"
              value={stats.totalTokens.toLocaleString()}
            />
          </div>

          <Card>
            <CardContent className="space-y-3 py-5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-semibold">Observed Models</div>
                {stats.models.length === 0 ? (
                  <Badge variant="outline">No successful model metadata yet</Badge>
                ) : (
                  stats.models.map((model) => (
                    <Badge key={model} variant="outline" className="font-mono">
                      {model}
                    </Badge>
                  ))
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Model names are taken from actual governed LLM call logs, not
                hard-coded defaults.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-5">
              <div className="mb-3 text-sm font-semibold">Recent Governed Calls</div>
              {rows.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  No tenant-scoped LLM calls have been recorded yet.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[850px] text-left text-xs">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="px-2 py-2 font-medium">Time</th>
                        <th className="px-2 py-2 font-medium">Purpose</th>
                        <th className="px-2 py-2 font-medium">Model</th>
                        <th className="px-2 py-2 font-medium">Outcome</th>
                        <th className="px-2 py-2 text-right font-medium">Input</th>
                        <th className="px-2 py-2 text-right font-medium">Output</th>
                        <th className="px-2 py-2 text-right font-medium">Attempts</th>
                        <th className="px-2 py-2 text-right font-medium">Latency</th>
                        <th className="px-2 py-2 font-medium">Safe Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, 30).map((row) => (
                        <tr key={row.id} className="border-b last:border-0">
                          <td className="whitespace-nowrap px-2 py-2">
                            {new Date(row.createdAt).toLocaleString()}
                          </td>
                          <td className="px-2 py-2">{row.purpose}</td>
                          <td className="max-w-64 truncate px-2 py-2 font-mono">
                            {row.model}
                          </td>
                          <td className="px-2 py-2">
                            <Badge
                              variant="outline"
                              className={
                                row.outcome === "success"
                                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : row.outcome === "blocked"
                                    ? "border-amber-200 bg-amber-50 text-amber-700"
                                    : "border-red-200 bg-red-50 text-red-700"
                              }
                            >
                              {row.outcome}
                            </Badge>
                          </td>
                          <td className="px-2 py-2 text-right">
                            {row.inputTokens.toLocaleString()}
                          </td>
                          <td className="px-2 py-2 text-right">
                            {row.outputTokens.toLocaleString()}
                          </td>
                          <td className="px-2 py-2 text-right">{row.attempts}</td>
                          <td className="px-2 py-2 text-right">
                            {row.latencyMs === null ? "—" : `${row.latencyMs} ms`}
                          </td>
                          <td className="px-2 py-2 font-mono text-[11px] text-muted-foreground">
                            {row.errorCode ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          {label}
        </div>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
