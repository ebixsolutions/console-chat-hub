export const OPS_SCOPE: Readonly<{backend:string;endpoint:string;company:string;channel:string;conversation:string;job:string;activation:string}>;
export const OPS_KEY: string;
export type OpsReceipt = Record<string, any>;
export function safeOpsResponse(status: number | null, raw: unknown): OpsReceipt;
export function successfulDryRun(r: OpsReceipt | null): boolean;
export function workerResponseMatches(r: OpsReceipt | null): boolean;
export class WorkerOperations {
  constructor(storage: Pick<Storage,'getItem'|'setItem'>, verify:()=>Promise<unknown>,invoke:(body:Readonly<{mode:string;activation_id?:string}>)=>Promise<{status:number|null;body:unknown}>);
  busy:boolean;
  invalidate():void;
  can(mode:'dry-run'|'execute'):boolean;
  run(mode:'dry-run'|'execute'):Promise<OpsReceipt|null>;
}

export function parseOpsResult(result:unknown):Promise<{status:number|null;body:unknown}>;
