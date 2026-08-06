/**
 * Conversation Evaluation grounding adapter.
 *
 * The evaluation must be judged against real, tenant-scoped, immutable content —
 * not against an environment label that merely claims a snapshot exists.
 *
 * This module calls the existing internal kb-adapter (the same contract
 * generate-reply uses: X-Internal-Service-Token, workspace_id + tenant_id), then:
 *
 *   1. splits the returned chunks into KB evidence and POLICY evidence by
 *      source_type, so the policy evaluator is grounded in policy documents
 *      rather than in self-authored generic rules;
 *   2. orders and truncates deterministically, so the same conversation and the
 *      same KB state always produce the same bytes;
 *   3. records a chunk manifest with a per-chunk content hash, what was included
 *      and what was dropped, and why;
 *   4. derives kb_snapshot_id and policy_snapshot_id from the SHA-256 of the
 *      content actually used. A snapshot id therefore cannot be asserted; it is
 *      computed from the evidence.
 *
 * Fail-closed: if the grounding call fails, or no policy evidence is available
 * for a policy-bearing evaluation, the caller must abort. There is no fallback
 * to ungrounded evaluation.
 */

export interface GroundingCompany {
  company_id: string;
  external_workspace_id: string;
  external_tenant_id: string;
}

export interface GroundingChunk {
  chunk_id: string;
  document_id: string;
  document_title: string;
  citation_label: string;
  source_type: string;
  source_scope: string;
  score: number;
  version: string | null;
  last_updated_at: string | null;
  freshness_status: string;
  content: string;
  content_sha256: string;
  included: boolean;
  drop_reason: string | null;
  original_chars: number;
  used_chars: number;
}

export interface GroundingBundle {
  kb_chunks: GroundingChunk[];
  policy_chunks: GroundingChunk[];
  kb_block: string;
  policy_block: string;
  kb_snapshot_id: string;
  policy_snapshot_id: string;
  manifest: GroundingManifest;
}

export interface GroundingManifest {
  adapter: "kb-adapter";
  request_id: string | null;
  retrieval_quality: string;
  no_answer: boolean;
  kb_gap_detected: boolean;
  conflict_detected: boolean;
  policy_gap: boolean;
  workspace_id: string;
  tenant_id: string;
  company_id: string;
  limits: {
    max_chunk_chars: number;
    max_block_chars: number;
    max_chunks_per_class: number;
  };
  kb: ManifestClass;
  policy: ManifestClass;
}

export interface ManifestClass {
  snapshot_id: string;
  chunks_returned: number;
  chunks_included: number;
  chunks_dropped: number;
  chars_used: number;
  truncated: boolean;
  entries: Array<{
    chunk_id: string;
    document_id: string;
    version: string | null;
    score: number;
    content_sha256: string;
    original_chars: number;
    used_chars: number;
    included: boolean;
    drop_reason: string | null;
  }>;
}

export type GroundingResult =
  | { ok: true; bundle: GroundingBundle }
  | { ok: false; code: GroundingFailure; detail?: string };

export type GroundingFailure =
  | "GROUNDING_CONFIG_MISSING"
  | "GROUNDING_UNREACHABLE"
  | "GROUNDING_REJECTED"
  | "GROUNDING_BAD_RESPONSE"
  | "GROUNDING_EMPTY"
  | "GROUNDING_POLICY_MISSING"
  | "GROUNDING_IDENTITY_INVALID"
  | "GROUNDING_TENANT_MISMATCH";

const MAX_CHUNK_CHARS = 3000;
const MAX_BLOCK_CHARS = 12000;
const MAX_CHUNKS_PER_CLASS = 8;
const CALL_TIMEOUT_MS = 12000;

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** Deterministic order: score descending, then chunk_id ascending as the tiebreak. */
function orderChunks<T extends { score: number; chunk_id: string }>(
  chunks: T[],
): T[] {
  return chunks.slice().sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0;
  });
}

async function buildClass(
  raw: Array<Record<string, unknown>>,
): Promise<
  {
    chunks: GroundingChunk[];
    block: string;
    snapshotId: string;
    cls: ManifestClass;
  }
> {
  const normalised = raw.map((c) => ({
    chunk_id: String(c.chunk_id ?? ""),
    document_id: String(c.document_id ?? ""),
    document_title: String(c.document_title ?? ""),
    citation_label: String(c.citation_label ?? c.document_title ?? ""),
    source_type: String(c.source_type ?? "unknown"),
    source_scope: String(c.source_scope ?? ""),
    score: Number(c.score ?? 0),
    version: c.version == null ? null : String(c.version),
    last_updated_at: c.last_updated_at == null
      ? null
      : String(c.last_updated_at),
    freshness_status: String(c.freshness_status ?? "fresh"),
    content: String(c.content ?? ""),
  }));

  const ordered = orderChunks(normalised);
  const out: GroundingChunk[] = [];
  let used = 0;

  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    const original = c.content.length;
    let included = true;
    let dropReason: string | null = null;
    let body = c.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    if (i >= MAX_CHUNKS_PER_CLASS) {
      included = false;
      dropReason = "chunk_limit";
      body = "";
    } else if (body.trim().length === 0) {
      included = false;
      dropReason = "empty";
      body = "";
    } else {
      if (body.length > MAX_CHUNK_CHARS) {
        body = body.slice(0, MAX_CHUNK_CHARS);
        dropReason = "chunk_truncated";
      }
      if (used + body.length > MAX_BLOCK_CHARS) {
        const room = MAX_BLOCK_CHARS - used;
        if (room <= 0) {
          included = false;
          dropReason = "block_limit";
          body = "";
        } else {
          body = body.slice(0, room);
          dropReason = "block_truncated";
        }
      }
      if (included) used += body.length;
    }

    out.push({
      ...c,
      content: body,
      content_sha256: await sha256Hex(body),
      included,
      drop_reason: dropReason,
      original_chars: original,
      used_chars: body.length,
    });
  }

  const includedChunks = out.filter((c) => c.included);
  const block = includedChunks
    .map((c) =>
      `[${c.citation_label}|${c.chunk_id}|v${c.version ?? "0"}]\n${c.content}`
    )
    .join("\n\n");

  // The snapshot id is derived from the evidence itself.
  const canonical = includedChunks.map((c) =>
    `${c.chunk_id}:${c.content_sha256}`
  ).join("\n");
  const snapshotId = `sha256:${await sha256Hex(canonical)}`;

  const cls: ManifestClass = {
    snapshot_id: snapshotId,
    chunks_returned: out.length,
    chunks_included: includedChunks.length,
    chunks_dropped: out.length - includedChunks.length,
    chars_used: used,
    truncated: out.some((c) => c.drop_reason !== null),
    entries: out.map((c) => ({
      chunk_id: c.chunk_id,
      document_id: c.document_id,
      version: c.version,
      score: c.score,
      content_sha256: c.content_sha256,
      original_chars: c.original_chars,
      used_chars: c.used_chars,
      included: c.included,
      drop_reason: c.drop_reason,
    })),
  };

  return { chunks: out, block, snapshotId, cls };
}

export type ChunkJoinResult =
  | { ok: true; chunks: Array<Record<string, unknown>> }
  | { ok: false; code: "GROUNDING_IDENTITY_INVALID"; detail: string };

/**
 * Join chunks_for_llm to trace_chunks on chunk_id.
 *
 * Position is not an identity contract: if the adapter ever reorders one array,
 * a positional merge silently attaches one chunk's content to another chunk's
 * id, corrupting citations, the snapshot hash and the tenant evidence. Every
 * deviation below is therefore fatal rather than repaired.
 */
export function joinChunks(
  forLlm: Array<Record<string, unknown>>,
  trace: Array<Record<string, unknown>>,
): ChunkJoinResult {
  const idOf = (c: Record<string, unknown>): string | null => {
    const raw = c.chunk_id ?? c.id;
    if (typeof raw !== "string") return null;
    const v = raw.trim();
    return v.length > 0 ? v : null;
  };

  const traceById = new Map<string, Record<string, unknown>>();
  for (const t of trace) {
    const id = idOf(t);
    if (id === null) {
      return {
        ok: false,
        code: "GROUNDING_IDENTITY_INVALID",
        detail: "trace_missing_chunk_id",
      };
    }
    if (traceById.has(id)) {
      return {
        ok: false,
        code: "GROUNDING_IDENTITY_INVALID",
        detail: "trace_duplicate_chunk_id",
      };
    }
    traceById.set(id, t);
  }

  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];

  for (const c of forLlm) {
    const id = idOf(c);
    if (id === null) {
      return {
        ok: false,
        code: "GROUNDING_IDENTITY_INVALID",
        detail: "content_missing_chunk_id",
      };
    }
    if (seen.has(id)) {
      return {
        ok: false,
        code: "GROUNDING_IDENTITY_INVALID",
        detail: "content_duplicate_chunk_id",
      };
    }
    seen.add(id);

    const t = traceById.get(id);
    if (!t) {
      return {
        ok: false,
        code: "GROUNDING_IDENTITY_INVALID",
        detail: "content_without_trace",
      };
    }

    // Identity fields must agree across both arrays.
    for (const field of ["document_id", "source_type"]) {
      const a = c[field] == null ? null : String(c[field]);
      const b = t[field] == null ? null : String(t[field]);
      if (a !== null && b !== null && a !== b) {
        return {
          ok: false,
          code: "GROUNDING_IDENTITY_INVALID",
          detail: `field_conflict:${field}`,
        };
      }
    }
    if (typeof c.content !== "string" || c.content.length === 0) {
      return {
        ok: false,
        code: "GROUNDING_IDENTITY_INVALID",
        detail: "content_missing_body",
      };
    }
    if (String(t.document_id ?? c.document_id ?? "").trim().length === 0) {
      return {
        ok: false,
        code: "GROUNDING_IDENTITY_INVALID",
        detail: "missing_document_id",
      };
    }

    out.push({ ...t, ...c, chunk_id: id });
  }

  // A trace entry with no content counterpart is an extra chunk the adapter
  // reported but did not supply; the evidence set would be incomplete.
  for (const id of traceById.keys()) {
    if (!seen.has(id)) {
      return {
        ok: false,
        code: "GROUNDING_IDENTITY_INVALID",
        detail: "trace_without_content",
      };
    }
  }

  return { ok: true, chunks: out };
}

export async function fetchGrounding(args: {
  conversationId: string;
  messageId?: string;
  company: GroundingCompany;
  query: string;
  language?: string;
  intent?: string;
  riskLevel?: "low" | "medium" | "high";
  requirePolicyEvidence: boolean;
}): Promise<GroundingResult> {
  const base = Deno.env.get("SUPABASE_URL");
  const token = Deno.env.get("KB_INTERNAL_SERVICE_TOKEN");
  if (!base || !token) return { ok: false, code: "GROUNDING_CONFIG_MISSING" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  let payload: Record<string, unknown>;
  try {
    let res: Response;
    try {
      res = await fetch(`${base}/functions/v1/kb-adapter`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Internal-Service-Token": token,
        },
        body: JSON.stringify({
          conversation_id: args.conversationId,
          message_id: args.messageId,
          workspace_id: args.company.external_workspace_id,
          tenant_id: args.company.external_tenant_id,
          query: args.query,
          language: args.language ?? "auto",
          intent: args.intent,
          risk_level: args.riskLevel ?? "high",
          top_k: 10,
        }),
        signal: controller.signal,
      });
    } catch {
      return { ok: false, code: "GROUNDING_UNREACHABLE" };
    }
    if (!res.ok) {
      return {
        ok: false,
        code: "GROUNDING_REJECTED",
        detail: String(res.status),
      };
    }
    payload = (await res.json().catch(() => null)) as Record<string, unknown>;
    if (!payload || typeof payload !== "object") {
      return { ok: false, code: "GROUNDING_BAD_RESPONSE" };
    }
  } finally {
    clearTimeout(timer);
  }

  if (payload.error) {
    const err = payload.error as { error_code?: string };
    return {
      ok: false,
      code: "GROUNDING_REJECTED",
      detail: String(err?.error_code ?? "unknown"),
    };
  }

  const forLlm = Array.isArray(payload.chunks_for_llm)
    ? (payload.chunks_for_llm as Array<Record<string, unknown>>)
    : [];
  const trace = Array.isArray(payload.trace_chunks)
    ? (payload.trace_chunks as Array<Record<string, unknown>>)
    : [];

  const joined = joinChunks(forLlm, trace);
  if (!joined.ok) {
    return { ok: false, code: joined.code, detail: joined.detail };
  }
  const merged = joined.chunks;
  if (merged.length === 0) return { ok: false, code: "GROUNDING_EMPTY" };

  // Reject chunks whose embedding_status is not 'indexed' or whose
  // embedding_model is 'placeholder'. A chunk that reached the adapter without
  // real embedding is a pipeline integrity failure, not usable evidence.
  for (const c of merged) {
    const eStatus = c.embedding_status == null
      ? null
      : String(c.embedding_status);
    const eModel = c.embedding_model == null ? null : String(c.embedding_model);
    if (eStatus !== null && eStatus !== "indexed") {
      return {
        ok: false,
        code: "GROUNDING_IDENTITY_INVALID",
        detail: "chunk_not_indexed",
      };
    }
    if (
      eModel !== null && (eModel === "placeholder" || eModel === "simulated")
    ) {
      return {
        ok: false,
        code: "GROUNDING_IDENTITY_INVALID",
        detail: "chunk_simulated_embedding",
      };
    }
  }

  // Response-level scope echo is MANDATORY. A missing echo means the adapter
  // did not confirm which tenant it answered for, and the evidence is untrusted.
  const echoedWorkspace = payload.workspace_id == null
    ? null
    : String(payload.workspace_id);
  const echoedTenant = payload.tenant_id == null
    ? null
    : String(payload.tenant_id);
  if (echoedWorkspace === null || echoedTenant === null) {
    return {
      ok: false,
      code: "GROUNDING_TENANT_MISMATCH",
      detail: "missing_scope_echo",
    };
  }
  if (
    echoedWorkspace !== args.company.external_workspace_id ||
    echoedTenant !== args.company.external_tenant_id
  ) {
    return {
      ok: false,
      code: "GROUNDING_TENANT_MISMATCH",
      detail: "scope_echo",
    };
  }
  // Every included chunk must also carry matching scope fields.
  for (const c of merged) {
    const cw = c.workspace_id == null ? null : String(c.workspace_id);
    const ct = c.tenant_id == null ? null : String(c.tenant_id);
    if (cw === null || ct === null) {
      return {
        ok: false,
        code: "GROUNDING_TENANT_MISMATCH",
        detail: "chunk_missing_scope",
      };
    }
    if (
      cw !== args.company.external_workspace_id ||
      ct !== args.company.external_tenant_id
    ) {
      return {
        ok: false,
        code: "GROUNDING_TENANT_MISMATCH",
        detail: "chunk_scope",
      };
    }
  }

  const policyRaw = merged.filter((c) =>
    String(c.source_type ?? "") === "policy"
  );
  const kbRaw = merged.filter((c) => String(c.source_type ?? "") !== "policy");

  if (args.requirePolicyEvidence && policyRaw.length === 0) {
    return { ok: false, code: "GROUNDING_POLICY_MISSING" };
  }

  const kb = await buildClass(kbRaw);
  const policy = await buildClass(policyRaw);

  return {
    ok: true,
    bundle: {
      kb_chunks: kb.chunks,
      policy_chunks: policy.chunks,
      kb_block: kb.block,
      policy_block: policy.block,
      kb_snapshot_id: kb.snapshotId,
      policy_snapshot_id: policy.snapshotId,
      manifest: {
        adapter: "kb-adapter",
        request_id: payload.request_id == null
          ? null
          : String(payload.request_id),
        retrieval_quality: String(payload.retrieval_quality ?? "unknown"),
        no_answer: Boolean(payload.no_answer),
        kb_gap_detected: Boolean(payload.kb_gap_detected),
        conflict_detected: Boolean(payload.conflict_detected),
        policy_gap: Boolean(payload.policy_gap),
        workspace_id: args.company.external_workspace_id,
        tenant_id: args.company.external_tenant_id,
        company_id: args.company.company_id,
        limits: {
          max_chunk_chars: MAX_CHUNK_CHARS,
          max_block_chars: MAX_BLOCK_CHARS,
          max_chunks_per_class: MAX_CHUNKS_PER_CLASS,
        },
        kb: kb.cls,
        policy: policy.cls,
      },
    },
  };
}
