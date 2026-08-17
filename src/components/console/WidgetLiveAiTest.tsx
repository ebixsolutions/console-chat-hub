import { useMemo, useState } from "react";
import { AlertCircle, Bot, Database, Loader2, Send, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";

type LiveReference = {
  label: string;
  source_type: string;
  chunk_type: "rag_summary" | "full_content" | "faq_pair" | "section";
  score: number;
};

type LiveTestResult = {
  success: true;
  mode: "isolated_live_ai_test";
  scope_mode: "canonical" | "pre_activation";
  grounded: boolean;
  answer: string;
  model?: string;
  selected_document_id?: string | null;
  full_content_evidence_count: number;
  references: LiveReference[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
    attempts: number;
  };
};

type LiveTestFailure = {
  success?: false;
  error?: string;
  detail?: string;
};

const EXAMPLES = [
  "What is your return policy?",
  "退貨需要符合甚麼條件？",
  "如果商品已拆封，還可以退貨嗎？",
] as const;

function safeErrorMessage(error: unknown, data: LiveTestFailure | null): string {
  const code = data?.error || data?.detail;
  if (code) return code;
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message?: unknown }).message ?? "");
    if (message) return message;
  }
  return "live_ai_test_failed";
}

export function WidgetLiveAiTest() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LiveTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSend = query.trim().length > 0 && query.trim().length <= 500 && !loading;
  const modeLabel = useMemo(() => {
    if (!result) return "Waiting for test";
    return result.scope_mode === "canonical"
      ? "Canonical tenant"
      : "Pre-activation tenant";
  }, [result]);

  const run = async () => {
    const text = query.trim();
    if (!text || text.length > 500 || loading) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const { data, error: invokeError } = await supabase.functions.invoke(
        "widget-live-ai-test",
        { body: { query: text } },
      );

      const payload = (data ?? null) as LiveTestResult | LiveTestFailure | null;
      if (invokeError || !payload || payload.success !== true) {
        setError(safeErrorMessage(invokeError, payload as LiveTestFailure | null));
        return;
      }
      setResult(payload as LiveTestResult);
    } catch (e) {
      setError(safeErrorMessage(e, null));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-700" />
          <div>
            <div className="font-semibold text-emerald-900">
              Isolated Live AI Test
            </div>
            <div className="mt-1 text-sm leading-6 text-emerald-800">
              This is a real Singapore Knowledge Base + governed LLM test.
              It does not create a production visitor session, conversation, or
              customer message. Production Widget persistence and human handoff
              remain gated by canonical channel activation.
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        <div className="rounded-xl border bg-white">
          <div className="border-b px-5 py-4">
            <div className="flex items-center gap-2 font-semibold">
              <Bot className="h-5 w-5" />
              Widget Live AI Test
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Real grounded answer generation · no simulated reply
            </div>
          </div>

          <div className="space-y-4 p-5">
            <div className="flex flex-wrap gap-2">
              {EXAMPLES.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => setQuery(item)}
                  className="rounded-full border bg-slate-50 px-3 py-1.5 text-xs hover:bg-slate-100"
                >
                  {item}
                </button>
              ))}
            </div>

            <Textarea
              value={query}
              onChange={(e) => setQuery(e.target.value.slice(0, 500))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void run();
                }
              }}
              rows={5}
              placeholder="Ask a real customer question to test KB-grounded AI accuracy…"
            />

            <div className="flex items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                {query.length}/500 · Enter to send · Shift+Enter for new line
              </div>
              <Button onClick={() => void run()} disabled={!canSend}>
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                {loading ? "Testing…" : "Run Live AI Test"}
              </Button>
            </div>

            {error && (
              <div className="flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <div className="font-medium">Live AI Test failed</div>
                  <div className="mt-1 break-all text-xs">{error}</div>
                </div>
              </div>
            )}

            {result && (
              <div className="space-y-4">
                <div className="rounded-xl border bg-slate-50 p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className={
                        result.grounded
                          ? "rounded-full bg-emerald-100 px-2 py-1 font-medium text-emerald-800"
                          : "rounded-full bg-amber-100 px-2 py-1 font-medium text-amber-800"
                      }
                    >
                      {result.grounded ? "Grounded answer" : "No full-content grounding"}
                    </span>
                    <span className="rounded-full bg-white px-2 py-1 text-slate-600">
                      {modeLabel}
                    </span>
                    {result.model && (
                      <span className="rounded-full bg-white px-2 py-1 text-slate-600">
                        {result.model}
                      </span>
                    )}
                  </div>
                  <div className="whitespace-pre-wrap text-sm leading-7 text-slate-900">
                    {result.answer}
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <Metric
                    label="Full-content evidence"
                    value={String(result.full_content_evidence_count)}
                  />
                  <Metric
                    label="References"
                    value={String(result.references.length)}
                  />
                  <Metric
                    label="LLM latency"
                    value={
                      result.usage
                        ? `${result.usage.latency_ms} ms`
                        : "Not called"
                    }
                  />
                </div>

                {result.references.length > 0 && (
                  <div className="rounded-xl border bg-white">
                    <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
                      <Database className="h-4 w-4" />
                      KB references
                    </div>
                    <div className="divide-y">
                      {result.references.map((ref, index) => (
                        <div
                          key={`${ref.label}-${ref.chunk_type}-${index}`}
                          className="flex items-start justify-between gap-4 px-4 py-3 text-xs"
                        >
                          <div>
                            <div className="font-medium text-slate-800">
                              {ref.label}
                            </div>
                            <div className="mt-1 text-slate-500">
                              {ref.source_type} · {ref.chunk_type}
                            </div>
                          </div>
                          <div className="shrink-0 tabular-nums text-slate-600">
                            {(ref.score * 100).toFixed(1)}%
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <InfoCard
            title="Grounding rule"
            body="rag_summary is orientation only. Only full_content can support factual answer generation."
          />
          <InfoCard
            title="Tenant isolation"
            body="Tenant scope and the Singapore KB API key are resolved server-side. The browser cannot submit company_id, tenant_id, or a key."
          />
          <InfoCard
            title="No production chat writes"
            body="This test does not create visitor_session, conversations, messages, assignments, or handoff state."
          />
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-semibold">{value}</div>
    </div>
  );
}

function InfoCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-2 text-xs leading-5 text-muted-foreground">{body}</div>
    </div>
  );
}
