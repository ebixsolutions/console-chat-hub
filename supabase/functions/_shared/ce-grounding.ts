/**
 * Conversation Evaluation grounding adapter — Singapore KB canonical path.
 */

import {
  fetchKBRag,
  resolveKBEndpoint,
  resolveTenantScope,
  type KBFullChunk,
  type KBRagResponse,
} from "./kb-client.ts";

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
  adapter: "singapore-kb-client";
  request_id: string | null;
  retrieval_quality: string;
  no_answer: boolean;
  kb_gap_detected: boolean;
  conflict_detected: boolean;
  policy_gap: boolean;
  singapore_tenant_id: string;
  company_id: string;
  selected_document_ids: string[];
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

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

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
): Promise<{
  chunks: GroundingChunk[];
  block: string;
  snapshotId: string;
  cls: ManifestClass;
}> {
  const normalised = raw.map((c) => ({
    chunk_id: String(c.chunk_id ?? ""),
    document_id: String(c.document_id ?? ""),
    document_title: String(c.document_title ?? ""),
    citation_label: String(c.citation_label ?? c.document_title ?? ""),
    source_type: String(c.source_type ?? "unknown"),
    source_scope: String(c.source_scope ?? ""),
    score: Number(c.score ?? 0),
    version: c.version == null ? null : String(c.version),
    last_updated_at: c.last_updated_at == null ? null : String(c.last_updated_at),
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

    if (!c.chunk_id.trim() || !c.document_id.trim() || !Number.isFinite(c.score)) {
      included = false;
      dropReason = "identity_invalid";
      body = "";
    } else if (i >= MAX_CHUNKS_PER_CLASS) {
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
  const canonical = includedChunks.map((c) =>
    `${c.chunk_id}:${c.content_sha256}`
  ).join("\n");
  const snapshotId = `sha256:${await sha256Hex(canonical)}`;

  return {
    chunks: out,
    block,
    snapshotId,
    cls: {
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
    },
  };
}

function isPolicySource(sourceType: string): boolean {
  return sourceType.toLowerCase().includes("policy");
}

function evidenceRows(result: KBRagResponse): Array<Record<string, unknown>> {
  const selectedDocumentId =
    result.llm_context?.selected_document_id ??
    result.selected_document_id ??
    "";

  return (result.llm_context?.full_content_evidence ?? []).map((item) => {
    const matching = result.chunks.find(
      (c: KBFullChunk) =>
        c.chunk_type === "full_content" &&
        c.document_id === item.document_id &&
        (!item.chunk_id || c.chunk_id === item.chunk_id),
    );

    return {
      chunk_id: item.chunk_id ?? matching?.chunk_id ?? "",
      document_id: item.document_id || selectedDocumentId,
      document_title: matching?.title ?? "KB document",
      citation_label: matching?.title ?? "KB document",
      source_type: item.source_type || matching?.source_type || "unknown",
      source_scope: "customer_answer",
      score: item.score,
      version: null,
      last_updated_at: null,
      freshness_status: "fresh",
      content: item.content,
    };
  });
}

function mergeEvidence(
  primary: Array<Record<string, unknown>>,
  secondary: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const item of [...primary, ...secondary]) {
    const key = [
      String(item.document_id ?? ""),
      String(item.chunk_id ?? ""),
      String(item.content ?? "").slice(0, 120),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function runRag(
  query: string,
  conversationId: string,
): Promise<
  | {
      ok: true;
      result: KBRagResponse;
      tenantId: string;
      aiCompanyId: string;
    }
  | { ok: false; code: GroundingFailure; detail?: string }
> {
  const endpoint = resolveKBEndpoint();
  if (!endpoint) return { ok: false, code: "GROUNDING_CONFIG_MISSING" };

  const tenant = await resolveTenantScope(conversationId);
  if (!tenant.resolved) {
    return {
      ok: false,
      code: "GROUNDING_TENANT_MISMATCH",
      detail: tenant.reason,
    };
  }

  let result: KBRagResponse;
  try {
    result = await fetchKBRag(
      { query: query.slice(0, 500), top_k: 12 },
      tenant.scope,
      endpoint,
      { timeoutMs: 15000 },
    );
  } catch {
    return { ok: false, code: "GROUNDING_UNREACHABLE" };
  }

  if (!result.success) {
    const code = result.error_code ?? "unknown";
    if (code === "KB_TIMEOUT" || code === "KB_FETCH_ERROR") {
      return { ok: false, code: "GROUNDING_UNREACHABLE", detail: code };
    }
    return { ok: false, code: "GROUNDING_REJECTED", detail: code };
  }

  return {
    ok: true,
    result,
    tenantId: tenant.scope.singaporeTenantId,
    aiCompanyId: tenant.scope.aiCompanyId,
  };
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
  void args.messageId;
  void args.language;
  void args.intent;
  void args.riskLevel;

  const query = args.query.trim();
  if (!query) return { ok: false, code: "GROUNDING_EMPTY" };
  if (!args.company.company_id) {
    return {
      ok: false,
      code: "GROUNDING_TENANT_MISMATCH",
      detail: "company_id_missing",
    };
  }

  const primary = await runRag(query, args.conversationId);
  if (!primary.ok) return primary;

  // CE resolves company ownership independently from the KB client. Evidence is
  // admissible only when both independent resolvers agree on the same AI company.
  if (primary.aiCompanyId !== args.company.company_id) {
    return {
      ok: false,
      code: "GROUNDING_TENANT_MISMATCH",
      detail: "ce_kb_company_mismatch",
    };
  }

  let evidence = evidenceRows(primary.result);
  let selectedDocumentIds = [
    primary.result.llm_context?.selected_document_id ??
      primary.result.selected_document_id ??
      "",
  ].filter(Boolean);

  let secondaryResult: KBRagResponse | null = null;
  if (
    args.requirePolicyEvidence &&
    !evidence.some((c) => isPolicySource(String(c.source_type ?? "")))
  ) {
    const policyQuery =
      `Applicable customer-service policy, rules, conditions, limits and procedures for: ${query}`;
    const secondary = await runRag(policyQuery, args.conversationId);
    if (!secondary.ok) return secondary;
    if (
      secondary.aiCompanyId !== primary.aiCompanyId ||
      secondary.tenantId !== primary.tenantId
    ) {
      return {
        ok: false,
        code: "GROUNDING_TENANT_MISMATCH",
        detail: "kb_resolution_changed_within_request",
      };
    }
    secondaryResult = secondary.result;
    evidence = mergeEvidence(evidence, evidenceRows(secondary.result));
    const secondaryId =
      secondary.result.llm_context?.selected_document_id ??
      secondary.result.selected_document_id ??
      "";
    if (secondaryId) selectedDocumentIds.push(secondaryId);
  }

  if (evidence.length === 0) return { ok: false, code: "GROUNDING_EMPTY" };

  const policyRaw = evidence.filter((c) =>
    isPolicySource(String(c.source_type ?? ""))
  );
  const kbRaw = evidence.filter((c) =>
    !isPolicySource(String(c.source_type ?? ""))
  );

  if (args.requirePolicyEvidence && policyRaw.length === 0) {
    return { ok: false, code: "GROUNDING_POLICY_MISSING" };
  }

  const kb = await buildClass(kbRaw);
  const policy = await buildClass(policyRaw);

  if (
    kb.chunks.some((c) => c.drop_reason === "identity_invalid") ||
    policy.chunks.some((c) => c.drop_reason === "identity_invalid")
  ) {
    return {
      ok: false,
      code: "GROUNDING_IDENTITY_INVALID",
      detail: "chunk_identity_invalid",
    };
  }

  const includedCount =
    kb.chunks.filter((c) => c.included).length +
    policy.chunks.filter((c) => c.included).length;
  if (includedCount === 0) return { ok: false, code: "GROUNDING_EMPTY" };

  selectedDocumentIds = [...new Set(selectedDocumentIds)];
  const allResults = [primary.result, secondaryResult].filter(
    (r): r is KBRagResponse => r !== null,
  );
  const highest = allResults
    .map((r) => r.meta?.highest_chunk_score ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);

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
        adapter: "singapore-kb-client",
        request_id: null,
        retrieval_quality:
          highest >= 0.85 ? "high" : highest >= 0.75 ? "medium" : "low",
        no_answer: false,
        kb_gap_detected: kb.chunks.filter((c) => c.included).length === 0,
        conflict_detected: false,
        policy_gap: policy.chunks.filter((c) => c.included).length === 0,
        singapore_tenant_id: primary.tenantId,
        company_id: primary.aiCompanyId,
        selected_document_ids: selectedDocumentIds,
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
