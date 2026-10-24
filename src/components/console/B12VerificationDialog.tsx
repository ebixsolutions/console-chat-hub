import {useEffect,useRef,useState} from 'react';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from '@/components/ui/dialog';
import {Button} from '@/components/ui/button';
import {verifyB12Identity} from '@/lib/api/ce-verification-client';
import {B12_SCOPE,B12_RUN} from '@/lib/ce-evaluation-execution';
import {createWorkerOperations} from '@/lib/api/b12-worker-operations-client';
import {OPS_SCOPE,successfulDryRun,type OpsReceipt} from '@/lib/api/b12-worker-operations.mjs';
export function B12VerificationDialog(){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[identity,setIdentity]=useState(false);
  const [error,setError]=useState<string|null>(null),[dryRun,setDryRun]=useState<OpsReceipt|null>(null),[receipt,setReceipt]=useState<OpsReceipt|null>(null);
  const [ready,setReady]=useState(false),[armConfirmed,setArmConfirmed]=useState(false);
  const ops=useRef<ReturnType<typeof createWorkerOperations>|null>(null),epoch=useRef(0),flight=useRef(false);
  useEffect(()=>{
    const generation=++epoch.current;setIdentity(false);setReady(false);setArmConfirmed(false);setDryRun(null);
    ops.current?.invalidate();
    if(open){
      try{if(!ops.current)ops.current=createWorkerOperations(window.localStorage);setError(null);}
      catch{setError('Local evidence unavailable. No requests permitted.');return;}
      // Read-only identity check. No invoke on mount/open/close/rerender.
      void verifyB12Identity().then(()=>{if(generation===epoch.current)setIdentity(true);})
        .catch(()=>{if(generation===epoch.current)setError('Exact authenticated identity unavailable. No request sent.');});
    }
    return()=>{epoch.current++;ops.current?.invalidate();};
  },[open]);
  async function send(mode:'dry-run'|'execute'){
    if(flight.current||!identity||error||!ops.current)return;
    if(mode==='execute'&&(!ready||!armConfirmed||!successfulDryRun(dryRun)))return;
    flight.current=true;setBusy(true);const generation=epoch.current;
    try{const result=await ops.current.run(mode);if(generation!==epoch.current)return;
      if(!result){setError('Request unavailable or already attempted. Do not retry.');return;}
      if(mode==='dry-run')setDryRun(result);else setReceipt(result);
      if(result.state==='STOP'||result.state==='UNKNOWN')setError('Stopped or unknown outcome. Preserve ledger; do not retry.');
    }finally{flight.current=false;if(generation===epoch.current)setBusy(false);}
  }
  function exportJson(){const data={run:B12_RUN,consumers:'PASS_FROZEN',dryRun,receipt};
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download='B12-worker-operations-receipt.json';a.click();URL.revokeObjectURL(url);}
  return <>
    <Button variant="outline" onClick={()=>setOpen(true)}>B12 verification</Button>
    <Dialog open={open} onOpenChange={value=>{if(!flight.current)setOpen(value);}}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>B12 remaining Worker verification</DialogTitle>
          <DialogDescription>Explicit single requests only. Permanent server ledger decides whether Worker can run. No retry after timeout or unknown result.</DialogDescription></DialogHeader>
        <p>Control / Manual / Inbox receipt: PASS_FROZEN. Control remaining 0; Manual remaining 0.</p>
        <Button disabled>Control frozen</Button><Button disabled>Manual frozen</Button>
        <p>Fixed ticket: {B12_SCOPE.ticket}. Exact synthetic Admin scope: {identity?'verified':'unavailable'}.</p>
        <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(OPS_SCOPE,null,2)}</pre>
        {error&&<p role="alert">{error}</p>}
        <Button disabled={!identity||busy||!!error||!ops.current?.can('dry-run')} onClick={()=>void send('dry-run')}>Send dry-run once</Button>
        <pre data-testid="b12-worker-dry-run" className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(dryRun,null,2)}</pre>
        {successfulDryRun(dryRun)&&<>
          <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={ready} onChange={e=>setReady(e.target.checked)}/>Execute is prepared; tell Work before arming. Do not send yet.</label>
          <label className="flex gap-2"><input type="checkbox" disabled={busy||!ready} checked={armConfirmed} onChange={e=>setArmConfirmed(e.target.checked)}/>Work confirmed fresh ARM and its 60-second deadline; I am inside that window.</label>
        </>}
        <Button disabled={!identity||busy||!!error||!ready||!armConfirmed||!successfulDryRun(dryRun)||!ops.current?.can('execute')}
          onClick={()=>void send('execute')}>Send execute once within confirmed window</Button>
        <pre data-testid="b12-worker-receipt" className="text-xs whitespace-pre-wrap break-all">{JSON.stringify(receipt,null,2)}</pre>
        <p>Matching response still requires Work's full data readback, ledger, correlation and safe tombstone closure.</p>
        <Button variant="outline" onClick={exportJson}>Export sanitized JSON</Button>
      </DialogContent>
    </Dialog>
  </>;
}
