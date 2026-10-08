import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { verifyB12Identity, verificationBody, invokeB12Negative } from "@/lib/api/ce-verification-client";
import { B12_SCOPE, B12_RUN, VerificationJournal, negativeResponseMatches, type Journal, type Endpoint } from "@/lib/ce-evaluation-execution";

const endpoints: Endpoint[] = ["ce-evaluation-control", "conversation-evaluate"];
export function B12VerificationDialog() {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Awaited<ReturnType<typeof verifyB12Identity>> | null>(null);
  const [journal, setJournal] = useState<Journal>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [controlSafetyConfirmed, setControlSafetyConfirmed] = useState(false);
  const flight = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const epoch = ++generation.current; setScope(null); setControlSafetyConfirmed(false);
    if (open) {
      try { setJournal(new VerificationJournal(window.localStorage).read()); setError(null); }
      catch { setError("Journal unavailable. STOP; no request is permitted."); return; }
      void verifyB12Identity().then(s => { if (epoch === generation.current) setScope(s); })
        .catch(() => { if (epoch === generation.current) setError("Exact authenticated scope unavailable. No request sent."); });
    }
    return () => { generation.current++; };
  }, [open]);
  async function send(endpoint: Endpoint) {
    if (flight.current || !scope || error) return;
    const epoch = generation.current; flight.current = true; setBusy(true);
    const store = new VerificationJournal(window.localStorage);
    let started = false;
    try {
      const current = store.read();
      if (endpoint === "conversation-evaluate" && (!controlSafetyConfirmed || !current["ce-evaluation-control"]?.receipt ||
        !(current["ce-evaluation-control"]!.receipt as { responseContractMatched?: boolean }).responseContractMatched)) throw new Error("Control safety readback must be confirmed first.");
      const exactScope = await verifyB12Identity();
      if (epoch !== generation.current) return;
      const startedAt = new Date().toISOString();
      setJournal(store.start(endpoint)); started = true; // Persist before network. Unknown outcomes remain spent.
      let response;
      try { response = await invokeB12Negative(endpoint); }
      catch { response = { status: null, kind: "unknown" as const, body: null, classification: "transport_unknown", requestId: "NOT_AVAILABLE", operationId: "NOT_AVAILABLE" }; }
      const receipt = { run: B12_RUN, endpoint, version: endpoint === "ce-evaluation-control" ? 15 : 26,
        scope: exactScope, request: verificationBody(endpoint), startedAt, endedAt: new Date().toISOString(), response,
        responseContractMatched: negativeResponseMatches(endpoint, response), acceptance: "REQUIRES_AUTHORITATIVE_BEFORE_AFTER_READBACK" };
      const completed = store.complete(endpoint, receipt);
      if (epoch === generation.current) setJournal(completed);
    } catch (e) {
      if (epoch === generation.current) setError(`${started ? "Spent; outcome or receipt unavailable. STOP. " : "No request sent. "}${e instanceof Error ? e.message : "Unknown failure"}`);
    } finally { flight.current = false; if (epoch === generation.current) setBusy(false); }
  }
  const controlReceipt = journal["ce-evaluation-control"]?.receipt as { responseContractMatched?: boolean } | undefined;
  function exportJson() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ run: B12_RUN, journal }, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = "B12-client-receipts.json"; a.click(); URL.revokeObjectURL(url);
  }
  return <>
    <Button variant="outline" onClick={() => setOpen(true)}>B12 verification</Button>
    <Dialog open={open} onOpenChange={value => { if (!flight.current) setOpen(value); }}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>B12 bounded verification</DialogTitle>
          <DialogDescription>Only explicit clicks send requests. One retained tab; no retries. Unknown outcomes consume allowance.</DialogDescription></DialogHeader>
        <p>Fixed ticket: {B12_SCOPE.ticket}</p>
        <p>Transcript readiness is not server eligibility. Scope: {scope ? "Exact synthetic Admin/company/channel/backend verified" : "Not verified"}</p>
        <pre data-testid="b12-scope" className="text-xs whitespace-pre-wrap">{JSON.stringify(scope, null, 2)}</pre>
        <p>Historical Control: 2 spent, both NOT_ACCEPTED; historical excess: 1. Incident ceiling: 3. New Control allowance: 1. Manual allowance: 1.</p>
        {error && <p role="alert">{error}</p>}
        {endpoints.map(endpoint => <section key={endpoint} className="border rounded p-3 space-y-2">
          <p>{endpoint} — remaining: {journal[endpoint] ? 0 : 1}</p>
          <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(verificationBody(endpoint))}</pre>
          <Button disabled={!scope || busy || !!error || !!journal[endpoint] || (endpoint === "conversation-evaluate" && !controlSafetyConfirmed)}
            onClick={() => void send(endpoint)}>{endpoint === "ce-evaluation-control" ? "Send Control negative once" : "Send Manual negative once"}</Button>
        </section>)}
        {controlReceipt?.responseContractMatched && <label className="flex gap-2"><input type="checkbox" checked={controlSafetyConfirmed} disabled={busy}
          onChange={e => setControlSafetyConfirmed(e.target.checked)} />Authoritative fresh Control before/after readback and request ledger are unchanged; safe to send Manual.</label>}
        <pre data-testid="b12-receipts" className="text-xs whitespace-pre-wrap break-all">{JSON.stringify({ run: B12_RUN, journal }, null, 2)}</pre>
        <Button variant="outline" onClick={exportJson}>Export sanitized JSON</Button>
      </DialogContent>
    </Dialog>
  </>;
}
