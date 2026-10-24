// C3 isolated nonproduction KB data-plane.
// Repository-authoritative KBDocument/KBDocumentVersion/KBVectorChunk fields
// are persisted in Postgres; retrieval below is lexical-only when embeddings
// are unavailable and never fabricates a vector or semantic score.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { resolveServerSecret } from "../_shared/nonproduction-secret.ts";

const NONPRODUCTION_REF = "nbtowfuvvfqpxqydyoby";
const RAG_PATH = "/api/v1/rag/context-search";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function sameSecret(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

function tokens(value: string): Set<string> {
  const normalized = value.normalize("NFKC").toLowerCase();
  const out = new Set(normalized.match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []);
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) ?? []) {
    for (let index = 0; index < Math.max(1, run.length - 1); index++) {
      out.add(run.length === 1 ? run : run.slice(index, index + 2));
    }
  }
  return out;
}

function lexicalScore(query: string, evidence: string): number {
  const q = tokens(query);
  if (!q.size) return 0;
  const e = tokens(evidence);
  let matched = 0;
  for (const token of q) if (e.has(token)) matched++;
  return matched / q.size;
}

Deno.serve(async (req: Request) => {
  const projectUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!projectUrl.includes(`${NONPRODUCTION_REF}.supabase.co`)) {
    return json(503, { success: false, error_code: "KB_NONPRODUCTION_IDENTITY_REQUIRED" });
  }
  if (req.method !== "POST" || !new URL(req.url).pathname.endsWith(RAG_PATH)) {
    return json(405, { success: false, error_code: "KB_METHOD_OR_PATH_INVALID" });
  }
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const internalToken = await resolveServerSecret("C3_KB_INTERNAL_TOKEN", "c3_kb_internal_token");
  const presented = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (
    !presented ||
    !((serviceKey && sameSecret(serviceKey, presented)) ||
      (internalToken && sameSecret(internalToken, presented)))
  ) {
    return json(401, { success: false, error_code: "KB_UNAUTHORIZED" });
  }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, 500) : "";
  const externalTenantId = Number(body?.company_id);
  if (!query || !Number.isSafeInteger(externalTenantId) || externalTenantId <= 0) {
    return json(400, { success: false, error_code: "KB_REQUEST_INVALID" });
  }

  const sb = createClient(projectUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: tenant, error: tenantError } = await sb
    .from("c3_nonprod_kb_tenant")
    .select("id,company_id,external_tenant_id")
    .eq("external_tenant_id", externalTenantId)
    .eq("is_active", true)
    .maybeSingle();
  if (tenantError) return json(500, { success: false, error_code: "KB_TENANT_LOOKUP_FAILED" });
  if (!tenant) return json(403, { success: false, error_code: "KB_TENANT_FORBIDDEN" });

  const now = new Date().toISOString();
  const { data: documents, error: documentError } = await sb
    .from("c3_nonprod_kb_document")
    .select("id,title,source_type,language,status,publication_state,currentness,version,version_rank,source_priority,published_at,updated_at,claims")
    .eq("tenant_id", tenant.id)
    .eq("status", "published")
    .eq("publication_state", "published")
    .eq("currentness", "current")
    .or(`effective_at.is.null,effective_at.lte.${now}`)
    .or(`expires_at.is.null,expires_at.gt.${now}`);
  if (documentError) return json(500, { success: false, error_code: "KB_DOCUMENT_LOOKUP_FAILED" });

  const ids = (documents ?? []).map((row) => row.id);
  if (!ids.length) {
    return json(200, { success: true, context_found: false, selected_documents: [], citations: [], llm_context: { summary_count: 0, evidence_count: 0 }, retrieval_method: "lexical_nonembedding" });
  }
  const { data: chunks, error: chunkError } = await sb
    .from("c3_nonprod_kb_chunk")
    .select("id,document_id,chunk_text,chunk_type,embedding_status")
    .in("document_id", ids)
    .eq("status", "active")
    .order("chunk_index", { ascending: true });
  if (chunkError) return json(500, { success: false, error_code: "KB_CHUNK_LOOKUP_FAILED" });

  const ranked = (documents ?? []).map((document) => {
    const ownChunks = (chunks ?? []).filter((chunk) => chunk.document_id === document.id);
    const evidence = `${document.title}\n${ownChunks.map((chunk) => chunk.chunk_text).join("\n")}`;
    return { document, chunks: ownChunks, score: lexicalScore(query, evidence) };
  }).filter((row) => row.score > 0).sort((left, right) =>
    right.score - left.score ||
    Number(right.document.source_priority) - Number(left.document.source_priority) ||
    Number(right.document.version_rank) - Number(left.document.version_rank) ||
    String(left.document.id).localeCompare(String(right.document.id))
  );
  if (!ranked.length) {
    return json(200, { success: true, context_found: false, selected_documents: [], citations: [], llm_context: { summary_count: 0, evidence_count: 0 }, retrieval_method: "lexical_nonembedding" });
  }

  const top = ranked[0];
  const tied = ranked.filter((row) =>
    row.score === top.score &&
    row.document.source_priority === top.document.source_priority &&
    row.document.version_rank === top.document.version_rank
  );
  const claims = new Map<string, Set<string>>();
  for (const row of tied) {
    for (const claim of Array.isArray(row.document.claims) ? row.document.claims : []) {
      if (!claim || typeof claim !== "object") continue;
      const key = String((claim as Record<string, unknown>).key ?? "").trim();
      const value = String((claim as Record<string, unknown>).value ?? "").trim();
      if (!key || !value) continue;
      const values = claims.get(key) ?? new Set<string>();
      values.add(value);
      claims.set(key, values);
    }
  }
  if ([...claims.values()].some((values) => values.size > 1)) {
    return json(409, { success: false, error_code: "KB_AUTHORITY_CONFLICT" });
  }

  const maxDocuments = Math.max(1, Math.min(5, Number(body?.max_documents) || 5));
  const selected = ranked.slice(0, maxDocuments).map(({ document, chunks: ownChunks, score }) => {
    const boundedScore = Math.max(0.05, Math.min(1, score));
    const evidence = ownChunks.slice(0, 3).map((chunk) => ({
      chunk_id: chunk.id,
      chunk_type: chunk.chunk_type,
      content: chunk.chunk_text,
      score: boundedScore,
      embedding_status: chunk.embedding_status,
    }));
    return {
      document_id: document.id,
      title: document.title,
      source_type: document.source_type,
      document_score: boundedScore,
      summary: null,
      evidence,
      authority: {
        tenant_id: String(externalTenantId),
        publication_state: document.publication_state,
        currentness: document.currentness,
        language: document.language,
        version: document.version,
        version_rank: document.version_rank,
        updated_at: document.updated_at,
        source_priority: document.source_priority,
        claims: document.claims,
      },
    };
  });
  return json(200, {
    success: true,
    context_found: true,
    selected_documents: selected,
    citations: selected.flatMap((document) => document.evidence.map((item: Record<string, unknown>) => ({ ...item, document_id: document.document_id }))),
    retrieval_method: "lexical_nonembedding",
    embedding_status: "NOT_RUN",
  });
});
