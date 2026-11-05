import { createFileRoute, useRouterState } from "@tanstack/react-router";
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
import { isEvidenceConversationId } from "@/lib/api/evidence-log-scope";
import {
  getLlmRuntimeTelemetryFn,
  type LlmRuntimeLogRow,
  getAdminEvidenceConversationsFn,getAdminEvidenceTurnsFn,
  type EvidenceConversation,type EvidenceTurnsResult,
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
  const evidenceLog = useRouterState({select:s=>String((s.location.search as Record<string,unknown>)?.view??"")==="log"});
  if (loading) return <LoadingState />;
  if (evidenceLog) return productionRole==="admin"?<AdminConversationEvidenceLog/>:<PermissionDenied/>;
  const canView = productionRole === "admin" || productionRole === "supervisor";
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

function AdminConversationEvidenceLog(){
 const listFn=useServerFn(getAdminEvidenceConversationsFn);
 const detailFn=useServerFn(getAdminEvidenceTurnsFn);
 const [state,setState]=useState<RuntimeState>("loading");
 const [rows,setRows]=useState<EvidenceConversation[]>([]);
 const [error,setError]=useState("");
 const [search,setSearch]=useState("");
 const [searching,setSearching]=useState(false);
 const [searchError,setSearchError]=useState("");
 const [selected,setSelected]=useState<string|null>(null);
 const [loaded,setLoaded]=useState<Record<string,EvidenceTurnsResult>>({});
 const [busy,setBusy]=useState<string|null>(null);
 useEffect(()=>{
  let active=true;
  void listFn({data:{}}).then(result=>{
   if(!active)return;
   if(!result.ok){setError(result.error??"evidence_list_unavailable");setState("error");return;}
   setRows(result.rows??[]);setState("ready");
  }).catch(()=>{if(active){setError("evidence_list_unavailable");setState("error");}});
  return()=>{active=false;};
 },[listFn]);
 const toggle=async(id:string)=>{
  if(selected===id){setSelected(null);return;}
  setSelected(id);
  if(loaded[id])return;
  setBusy(id);
  try{const value=await detailFn({data:{conversationId:id,offset:0}});setLoaded(prev=>({...prev,[id]:value}));}
  catch{setLoaded(prev=>({...prev,[id]:{ok:false,error:"evidence_detail_unavailable"}}));}
  finally{setBusy(null);}
 };
 const loadMore=async(id:string,offset:number)=>{
  if(busy)return;
  setBusy(id);
  try{
   const page=await detailFn({data:{conversationId:id,offset}});
if(!page.ok){setLoaded(prev=>({...prev,[id]:{
     ...prev[id],pageError:page.error??"evidence_detail_unavailable"}}));return;}
   setLoaded(prev=>{
     const turns=[...new Map([...(prev[id]?.turns??[]),...(page.turns??[])]
       .map(t=>[t.messageId,t])).values()].map((t,index)=>({...t,index:index+1}));
     const orphans=[...new Map([...(prev[id]?.unlinkedReplies??[]),...(page.unlinkedReplies??[])]
       .map(t=>[t.id,t])).values()];
     return {...prev,[id]:{...page,turns,unlinkedReplies:orphans,pageError:undefined}};
   });
  }catch{setLoaded(prev=>({...prev,[id]:{
    ...prev[id],pageError:"evidence_detail_unavailable"}}));}
  finally{setBusy(null);}
 };
 const findExactTicket=async()=>{
  const id=search.trim();
  if(!isEvidenceConversationId(id)){setSearchError("Enter the complete Conversation ID.");return;}
  setSearching(true);setSearchError("");
  try{
   const result=await listFn({data:{conversationId:id}});
   if(!result.ok){setSearchError(result.error??"evidence_list_unavailable");return;}
   setRows(result.rows??[]);setSelected(null);setLoaded({});
   if(!result.rows?.length)setSearchError("No matching tenant-scoped Conversation ID.");
  }catch{setSearchError("evidence_list_unavailable");}
  finally{setSearching(false);}
 };
 const showRecentTickets=async()=>{
  setSearching(true);setSearchError("");
  try{
   const result=await listFn({data:{}});
   if(!result.ok){setSearchError(result.error??"evidence_list_unavailable");return;}
   setRows(result.rows??[]);setSearch("");setSelected(null);setLoaded({});
  }catch{setSearchError("evidence_list_unavailable");}
  finally{setSearching(false);}
 };
 const showJson=(value:unknown)=>value==null?"NOT_CAPTURED":typeof value==="string"?value:JSON.stringify(value,null,2);
 const filtered=rows.filter(r=>r.id.toLowerCase().includes(search.trim().toLowerCase()));
 return <div className="space-y-4">
  <PageHeader title="Conversation Evidence Log" description="Admin-only · same-company original customer → KB request/response → grounded reply · read only"/>
  <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
   Historical missing evidence is NOT_CAPTURED. A verified pre-KB Semantic failure is KB_NOT_DISPATCHED_SEMANTIC_FAILURE; no original HTTP Query/Raw Response exists for that turn. HTTP 200 does not prove relevant evidence.
   This read-only view never dispatches Provider/KB requests or reconstructs missing raw. Sensitive keys/contact data are masked in this display; SHA256 and byte counts refer to the original captured response.
  </div>
  <div className="flex flex-wrap items-center gap-2">
   <input aria-label="Search conversation ID" placeholder="Enter full Conversation ID (or filter recent tickets)"
    value={search} onChange={e=>{setSearch(e.target.value);setSearchError("");}}
    className="min-w-[250px] flex-1 rounded-md border bg-white p-2 text-sm"/>
   <button type="button" disabled={searching} onClick={()=>void findExactTicket()}
    className="rounded border px-3 py-2 text-sm">Find ID</button>
   <button type="button" disabled={searching} onClick={()=>void showRecentTickets()}
    className="rounded border px-3 py-2 text-sm">Recent</button>
  </div>
  {searchError&&<div role="alert" className="text-sm text-red-700">{searchError}</div>}
  {state==="loading"&&<LoadingState/>}
  {state==="error"&&<div role="alert" className="text-sm text-red-700">{error}</div>}
  {state==="ready"&&<div className="overflow-x-auto rounded-md border bg-white">
    <table className="w-full min-w-[740px] text-left text-xs">
     <thead className="bg-slate-50"><tr><th className="p-2">Conversation ID</th><th className="p-2">Created</th>
      <th className="p-2">Status</th><th className="p-2">Channel</th></tr></thead>
     <tbody>{filtered.map(c=><tr key={c.id} className="border-t align-top">
      <td className="p-3 font-mono">
       <button type="button" aria-expanded={selected===c.id} onClick={()=>void toggle(c.id)}
        className="text-left text-blue-700 underline">{selected===c.id?"▾":"▸"} {c.id}</button>
       {selected===c.id&&<div className="mt-3 max-w-[86vw]">
        {busy===c.id&&!loaded[c.id]&&<div>Reading actual evidence…</div>}
        {loaded[c.id]&&!loaded[c.id].ok&&<div role="alert" className="text-red-700">{loaded[c.id].error}</div>}
        {loaded[c.id]?.ok&&<div className="overflow-x-auto rounded-md border">
         <table className="w-full min-w-[1130px] text-left text-xs">
          <thead className="bg-slate-50"><tr>
           <th className="p-2">Turn</th><th className="p-2">客人實際問題</th>
           <th className="p-2">上下文理解／完整 KB Query</th><th className="p-2">KB 原始返回證據</th>
           <th className="p-2">最終人話回答／Grounding</th></tr></thead>
          <tbody>{(loaded[c.id].turns??[]).map(t=><tr key={t.messageId} className="border-t align-top">
           <td className="p-2">{t.index}<div className="font-mono text-[10px]">{t.messageId.slice(0,8)}</div></td>
           <td className="max-w-[220px] whitespace-pre-wrap break-words p-2">{t.customerQuestion}</td>
           <td className="max-w-[270px] p-2">{!t.evidence.length?<span className="text-amber-700">{t.evidenceStatus==="KB_NOT_DISPATCHED_SEMANTIC_FAILURE"?"KB_NOT_DISPATCHED_SEMANTIC_FAILURE":"NOT_CAPTURED"}</span>:
            t.evidence.map((ev,i)=><details key={ev.id} className="mb-2">
             <summary className="cursor-pointer">KB Call {i+1} · {String(ev.requestDispatchState)}</summary>
             <p>完整 Query</p><pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2">{showJson(ev.exactQuery)}</pre>
             <p>HTTP Request JSON</p><pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2">{showJson(ev.requestJson)}</pre>
             <p>意圖及上下文</p><pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2">{showJson(ev.sourceContext)}</pre>
            </details>)}</td>
           <td className="max-w-[340px] p-2">{!t.evidence.length?<span className="text-amber-700">{t.evidenceStatus==="KB_NOT_DISPATCHED_SEMANTIC_FAILURE"?"KB_NOT_DISPATCHED_SEMANTIC_FAILURE":"NOT_CAPTURED"}</span>:
            t.evidence.map(ev=><details key={ev.id} className="mb-2">
             <summary className="cursor-pointer">{ev.rawCaptureState} · HTTP {ev.responseStatus??"—"}</summary>
<div>SHA256 {ev.rawSha256??"NOT_CAPTURED"} · Bytes {ev.responseBytes??"—"}</div>
             <div className="text-xs text-slate-600">Origin: {ev.rawCaptureOrigin} · Complete: {ev.bodyComplete?"yes":"not verified"}
              · Operation: {ev.operationId??"NOT_CAPTURED"}</div>
             <div className="text-xs text-slate-600">Normalized SHA: {ev.normalizedSha256??"NOT_CAPTURED"}
              · Normalized bytes: {ev.normalizedBytes??"—"}</div>
             {ev.executionFailure&&<pre className="max-h-24 overflow-auto break-all bg-slate-100 p-2">{ev.executionFailure}</pre>}
             <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2">{ev.rawResponse??"NOT_CAPTURED / WITHHELD"}</pre>
             <p>Document / Chunk lineage</p><pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2">{showJson(ev.lineage)}</pre>
            </details>)}</td>
           <td className="max-w-[270px] p-2">{t.answers.length?t.answers.map(a=><div key={a.id} className="mb-2">
            <div className="whitespace-pre-wrap break-words">{a.text}</div>
            <details><summary className="cursor-pointer text-slate-500">Evidence decision／Grounding</summary>
             <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-100 p-2">{showJson(a.metadata)}</pre>
            </details>
           </div>):<span className="text-amber-700">REPLY_NOT_LINKED</span>}</td>
          </tr>)}</tbody>
         </table>
         {(loaded[c.id].unlinkedReplies?.length??0)>0&&<details className="border-t p-3">
          <summary className="cursor-pointer">Assistant/Agent replies without verified source linkage</summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">{showJson(loaded[c.id].unlinkedReplies)}</pre>
         </details>}
{loaded[c.id].pageError&&<p role="alert" className="p-3 text-amber-700">
           Load more failed: {loaded[c.id].pageError}; earlier evidence remains available.
         </p>}
         {loaded[c.id].nextOffset!=null&&
          <button type="button" disabled={busy===c.id} onClick={()=>void loadMore(c.id,loaded[c.id].nextOffset!)}
           className="m-3 rounded border px-3 py-1">Load more messages</button>}
        </div>}
       </div>}
      </td>
      <td className="p-3">{new Date(c.createdAt).toLocaleString()}</td>
      <td className="p-3">{c.status}</td>
      <td className="p-3 font-mono">{c.channelId?.slice(0,8)??"—"}</td>
     </tr>)}</tbody>
    </table>
    {filtered.length===0&&<div className="p-6 text-sm text-slate-500">No matching tenant-scoped conversations</div>}
   </div>}
 </div>;
}
