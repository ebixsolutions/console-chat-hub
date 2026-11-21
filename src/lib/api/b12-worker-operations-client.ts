import {supabase} from '@/integrations/supabase/client';
import {verifyB12Identity} from './ce-verification-client';
import {parseOpsResult} from './b12-worker-operations.mjs';
import {WorkerOperations} from './b12-worker-operations.mjs';
// The existing authenticated singleton supplies its normal JWT itself. No custom
// Authorization, secret, token recovery, alternate host or direct Worker call.
export function createWorkerOperations(storage: Pick<Storage,'getItem'|'setItem'>) {
  return new WorkerOperations(storage,verifyB12Identity,async body=>{
    const result=await supabase.functions.invoke('c3-b12-worker-once',{body,timeout:20000});
    // Parse actual SDK HTTP response. The operations policy then strictly
    // whitelists the defined non-secret response protocol before UI/export.
    const parsed=await parseOpsResult(result);
    return {status:parsed.status,body:parsed.body};
  });
}
