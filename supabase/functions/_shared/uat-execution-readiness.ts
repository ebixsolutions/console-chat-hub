import { UAT_COMPANY, UAT_REVISION, FRANKIE_DEMO_COMPANY, FRANKIE_DEMO_REVISION, isBoundedDemoCompany, type Db } from "./uat-execution-contract.ts";
import { executionFailure, failureFromError, type ExecutionFailure } from "./execution-failure.ts";
export type UatReadiness = {ready:true; remote_ready:boolean; allowed_conversations:string[]} | {ready:false; failure:ExecutionFailure};
/** Read-only operational status, never a lease, permission or reservation. The
 * authoritative per-dispatch SQL guards still revalidate every actual call. */
export async function uatExecutionReadiness(db: Db, company: string, env: (key:string)=>string|undefined = key=>Deno.env.get(key)): Promise<UatReadiness> {
  if (!isBoundedDemoCompany(company)) return {ready:true,remote_ready:true,allowed_conversations:[]};
  try {
    // env injection is for the normal server dependency seam, not request data.
    const frankie=company===FRANKIE_DEMO_COMPANY;
    const run=env(frankie?"FRANKIE_DEMO_UAT_RUN_ID":"C3_TEMP_UAT_RUN_ID");
    const revision=frankie?FRANKIE_DEMO_REVISION:UAT_REVISION;
    if (!run) return {ready:false,failure:executionFailure("UAT_AUTHORIZATION_ABSENT")};
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(run) ||
        env(frankie?"FRANKIE_DEMO_UAT_SOURCE_REVISION":"C3_TEMP_UAT_SOURCE_REVISION")!==revision)
      return {ready:false,failure:executionFailure("UAT_SOURCE_OR_RUN_DENIED")};
    const r=await db.rpc("c3_uat_execution_status",{p_run_id:run,p_revision:revision,p_company_id:company});
    if (r.error) return {ready:false,failure:executionFailure(["PGRST202","42883"].includes(r.error.code)?"UAT_DEPENDENCY_MISSING":"UAT_ADMISSION_DENIED")};
    if (r.data?.ready !== true || !Array.isArray(r.data.allowed_conversations) || !r.data.allowed_conversations.every((x:unknown)=>typeof x==="string" && /^[a-f0-9-]{36}$/.test(x))) return {ready:false,failure:executionFailure(r.data?.code ?? "UAT_ADMISSION_DENIED")};
    return {ready:true,remote_ready:r.data.remote_ready === true,allowed_conversations:r.data.allowed_conversations};
  } catch(error) {return {ready:false,failure:failureFromError(error)};}
}
