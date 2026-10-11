/** Shared client execution policy. No authentication or network transport here. */
export type RequestTuple = Readonly<{ conversationId: string; revision: string; source: "manual" | "ce_dwell" }>;
export class EvaluationExecution {
  private active = new Set<string>();
  private completed = new Set<string>();
  private generation = 0;
  key(tuple: RequestTuple) { return JSON.stringify([tuple.conversationId, tuple.revision]); }
  capture(conversationId: string, revision: string, source: RequestTuple["source"]): RequestTuple {
    return Object.freeze({ conversationId, revision, source });
  }
  invalidate() { this.generation++; }
  epoch() { return this.generation; }
  current(epoch: number) { return epoch === this.generation; }
  canAuto(tuple: RequestTuple) { return !this.active.has(this.key(tuple)) && !this.completed.has(this.key(tuple)); }
  inFlight(tuple: RequestTuple) { return this.active.has(this.key(tuple)); }
  begin(tuple: RequestTuple) {
    const key = this.key(tuple);
    if (this.active.has(key) || (tuple.source === "ce_dwell" && this.completed.has(key))) return false;
    this.active.add(key); return true;
  }
  finish(tuple: RequestTuple) { const key = this.key(tuple); this.active.delete(key); this.completed.add(key); }
}
// Survives route remounts in this runtime; explicit manual intent remains possible.
export const ceExecution = new EvaluationExecution();
export function scheduleDwell(execution: EvaluationExecution, tuple: RequestTuple, send: (tuple: RequestTuple) => void,
  clock: { setTimeout: (callback: () => void, delay: number) => unknown; clearTimeout: (timer: unknown) => void },
  isCurrent: () => boolean) {
  if (!execution.canAuto(tuple)) return () => {};
  const timer = clock.setTimeout(() => { if (isCurrent() && execution.canAuto(tuple)) send(tuple); }, 3000);
  return () => clock.clearTimeout(timer);
}

const PRIVATE_KEY = /authorization|api[-_]?key|cookie|token|secret|password|session|headers/i;
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 15) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return value
    .replace(/Bearer\s+\S+/gi, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/((?:access_token|refresh_token|apikey|password|cookie|secret)\s*[=:]\s*)[^\s&;,]+/gi, "$1[REDACTED]");
  if (Array.isArray(value)) return value.map(v => sanitize(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !PRIVATE_KEY.test(key)).map(([key, v]) => [key, sanitize(v, depth + 1)]));
  return value;
}
export type ParsedResponse = { status: number | null; kind: "json" | "text" | "unknown"; body: unknown;
  classification: string; requestId: string; operationId: string };
export async function parseFunctionResponse(result: { data?: unknown; error?: unknown; response?: Response }): Promise<ParsedResponse> {
  const error = result.error as { context?: unknown; name?: string } | undefined;
  const response = error?.context instanceof Response ? error.context : result.response;
  const receipt: ParsedResponse = { status: response?.status ?? null, kind: "unknown", body: null,
    classification: "transport_unknown", requestId: "NOT_AVAILABLE", operationId: "NOT_AVAILABLE" };
  if (!response) return receipt;
  receipt.requestId = response.headers.get("x-request-id") ?? "NOT_AVAILABLE";
  receipt.operationId = response.headers.get("x-operation-id") ?? "NOT_AVAILABLE";
  try {
    let body: unknown;
    if (!error && response.bodyUsed) body = result.data; // SDK has already parsed successful responses.
    else {
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing_body");
      const chunks: Uint8Array[] = []; let bytes = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = async () => {
        for (;;) { const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength; if (bytes > 65536) throw new Error("body_limit"); chunks.push(value); }
        const all = new Uint8Array(bytes); let offset = 0;
        for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
        return new TextDecoder().decode(all);
      };
      let text: string;
      try { text = await Promise.race([read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("body_timeout")), 5000); })]); }
      finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
      if (response.headers.get("content-type")?.includes("application/json")) body = JSON.parse(text);
      else { receipt.kind = "text"; receipt.body = sanitize(text); receipt.classification = "non_json"; return receipt; }
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_json_envelope");
    receipt.kind = "json"; receipt.body = sanitize(body);
    receipt.classification = receipt.status === 401 ? "unauthenticated" : receipt.status === 403 ? "forbidden" :
      receipt.status! >= 500 ? "server_error" : receipt.status === 409 ? "conflict" : response.ok ? "success" : "http_error";
    const operationId = (body as Record<string, unknown>).operation_id;
    if (typeof operationId === "string") receipt.operationId = operationId;
  } catch { receipt.classification = "parse_unknown"; }
  return receipt;
}

export const B12_SCOPE = Object.freeze({ userId: "4348ee35-9632-4626-a846-e313bcc4a5f9", email: "authe@gmail.com",
  companyId: "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec", channelId: "0405282f-77dc-47cf-8074-99dd3dc6c393",
  ticket: "4813e2b2-ad0b-509f-aff2-e8c548745b71", backend: "nrfxhqabwblzxoushgnm" });
export function scopeMatches(scope: { userId?: string; email?: string; companyId?: string; channelId?: string; role?: string; active?: boolean; ticket?: string; backend?: string }) {
  return scope.userId === B12_SCOPE.userId && scope.email === B12_SCOPE.email && scope.companyId === B12_SCOPE.companyId &&
    scope.channelId === B12_SCOPE.channelId && scope.ticket === B12_SCOPE.ticket && scope.backend === B12_SCOPE.backend && scope.role === "admin" && scope.active === true;
}
export type Endpoint = "ce-evaluation-control" | "conversation-evaluate";
export const B12_RUN = "C3-B12-20261008-one-pass-client-closure";
export const JOURNAL_KEY = "c3-b12-verification-20261008-v1";
export type Journal = Partial<Record<Endpoint, { run: string; endpoint: Endpoint; ticket: string; state: "started" | "complete"; receipt?: unknown }>>;
export class VerificationJournal {
  constructor(private storage: Pick<Storage, "getItem" | "setItem">) {}
  read(): Journal {
    const raw = this.storage.getItem(JOURNAL_KEY); if (raw === null) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("journal_invalid");
    for (const [endpoint, entry] of Object.entries(parsed)) {
      const e = entry as Journal[Endpoint];
      if (!["ce-evaluation-control", "conversation-evaluate"].includes(endpoint) || !e || e.run !== B12_RUN || e.ticket !== B12_SCOPE.ticket || e.endpoint !== endpoint || !["started", "complete"].includes(e.state)) throw new Error("journal_invalid");
    }
    return parsed;
  }
  start(endpoint: Endpoint) {
    const journal = this.read(); if (journal[endpoint]) throw new Error("allowance_spent");
    journal[endpoint] = { run: B12_RUN, endpoint, ticket: B12_SCOPE.ticket, state: "started" };
    this.storage.setItem(JOURNAL_KEY, JSON.stringify(journal)); return journal;
  }
  complete(endpoint: Endpoint, receipt: unknown) {
    const journal = this.read(); if (!journal[endpoint]) throw new Error("journal_missing_start");
    journal[endpoint] = { ...journal[endpoint]!, state: "complete", receipt: sanitize(receipt) };
    this.storage.setItem(JOURNAL_KEY, JSON.stringify(journal)); return journal;
  }
}
export function negativeResponseMatches(endpoint: Endpoint, result: ParsedResponse) {
  if (result.kind !== "json" || result.status !== 409 || result.classification !== "conflict") return false;
  const body = result.body as Record<string, unknown>;
  return endpoint === "ce-evaluation-control" ? body.error === "evaluation_scope_excluded_or_unavailable" :
    body.error === "conflict" && body.detail === "EVALUATION_SCOPE_EXCLUDED";
}
