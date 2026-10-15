import { UAT_COMPANY, UAT_REVISION, type Db } from "./uat-execution-contract.ts";
import { executionFailure, failureFromError, type ExecutionFailure } from "./execution-failure.ts";
export type UatReadiness = {ready:true; remote_ready:boolean; allowed_conversations:string[]} | {ready:false; failure:ExecutionFailure};
/** Read-only operational status, never a lease, permission or reservation. The
 * authoritative per-dispatch SQL guards still revalidate every actual call. */
export async function uatExecutionReadiness(db: Db, company: string, env: (key:string)=>string|undefined = key=>Deno.env.get(key)): Promise<UatReadiness> {
  if (company !== UAT_COMPANY) return {ready:true,remote_ready:true,allowed_conversations:[]};
  try {
    // env injection is for the normal server dependency seam, not request data.
    if (!env("C3_TEMP_UAT_RUN_ID")) return {ready:false,failure:executionFailure("UAT_AUTHORIZATION_ABSENT")};
    const run=env("C3_TEMP_UAT_RUN_ID");
    if (!run || !/^[a-f0-9-]{36}$/.test(run) || env("C3_TEMP_UAT_SOURCE_REVISION") !== UAT_REVISION) return {ready:false,failure:executionFailure("UAT_SOURCE_OR_RUN_DENIED")};
    const r=await db.rpc("c3_uat_execution_status",{p_run_id:run,p_revision:UAT_REVISION,p_company_id:company});
    if (r.error) return {ready:false,failure:executionFailure(["PGRST202","42883"].includes(r.error.code)?"UAT_DEPENDENCY_MISSING":"UAT_ADMISSION_DENIED")};
    if (r.data?.ready !== true || !Array.isArray(r.data.allowed_conversations) || !r.data.allowed_conversations.every((x:unknown)=>typeof x==="string" && /^[a-f0-9-]{36}$/.test(x))) return {ready:false,failure:executionFailure(r.data?.code ?? "UAT_ADMISSION_DENIED")};
    return {ready:true,remote_ready:r.data.remote_ready === true,allowed_conversations:r.data.allowed_conversations};
  } catch(error) {return {ready:false,failure:failureFromError(error)};}
}
