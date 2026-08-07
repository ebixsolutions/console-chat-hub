/**
 * Fail-closed tenant/company grounding for CE.
 *
 * Mirrors public.ce_validate_grounding(jsonb,jsonb). Grounding is joined by
 * chunk_id — NEVER by array position — so a reordered provider array can never
 * be silently accepted as identical evidence.
 *
 * Every rejection is a hard failure: an evaluation must not proceed on
 * unverifiable grounding.
 */

export type CeScope = {
  workspace_id: string;
  tenant_id: string;
  company_id: string;
};

export type CeExpectedChunk = CeScope & {
  chunk_id: string;
  content_hash: string;
};

export type CeResponseChunk = Partial<CeScope> & {
  chunk_id?: string;
  content_hash?: string;
};

export type CeGroundingViolationCode =
  | "CE_SCOPE_ECHO_MISSING"
  | "CE_CROSS_TENANT_SCOPE"
  | "CE_CHUNK_SCOPE_MISSING"
  | "CE_CHUNK_DUPLICATE"
  | "CE_CHUNK_SET_MISMATCH"
  | "CE_CHUNK_CROSS_TENANT"
  | "CE_CHUNK_UNKNOWN"
  | "CE_CONTENT_HASH_MISMATCH";

export type CeGroundingResult =
  | { ok: true }
  | { ok: false; code: CeGroundingViolationCode; chunk_id?: string };

export function validateGrounding(
  expected: CeScope & { chunks: CeExpectedChunk[] },
  response: (Partial<CeScope> & { chunks?: CeResponseChunk[] }) | null | undefined,
): CeGroundingResult {
  if (!response || typeof response !== "object") return { ok: false, code: "CE_SCOPE_ECHO_MISSING" };

  if (!response.workspace_id || !response.tenant_id || !response.company_id) {
    return { ok: false, code: "CE_SCOPE_ECHO_MISSING" };
  }
  if (
    response.workspace_id !== expected.workspace_id ||
    response.tenant_id !== expected.tenant_id ||
    response.company_id !== expected.company_id
  ) {
    return { ok: false, code: "CE_CROSS_TENANT_SCOPE" };
  }
  if (!Array.isArray(response.chunks)) return { ok: false, code: "CE_CHUNK_SCOPE_MISSING" };

  const ids = response.chunks.map((c) => c.chunk_id);
  if (ids.some((id) => !id)) return { ok: false, code: "CE_CHUNK_SCOPE_MISSING" };
  if (new Set(ids).size !== ids.length) return { ok: false, code: "CE_CHUNK_DUPLICATE" };

  const expectedById = new Map(expected.chunks.map((c) => [c.chunk_id, c]));
  if (expectedById.size !== ids.length) return { ok: false, code: "CE_CHUNK_SET_MISMATCH" };

  for (const chunk of response.chunks) {
    const id = chunk.chunk_id as string;
    const exp = expectedById.get(id);
    if (!exp) return { ok: false, code: "CE_CHUNK_UNKNOWN", chunk_id: id };
    if (
      chunk.workspace_id !== expected.workspace_id ||
      chunk.tenant_id !== expected.tenant_id ||
      chunk.company_id !== expected.company_id
    ) {
      return { ok: false, code: "CE_CHUNK_CROSS_TENANT", chunk_id: id };
    }
    if (!chunk.content_hash || chunk.content_hash !== exp.content_hash) {
      return { ok: false, code: "CE_CONTENT_HASH_MISMATCH", chunk_id: id };
    }
  }

  return { ok: true };
}
