/**
 * Canonical replay bundle: the exact content that was sent to the evaluator,
 * plus a reproducible snapshot hash.
 *
 * The hash MUST be recomputable from the stored bundle alone — Replay Studio
 * rebuilds from the stored version, never from metadata.
 */

export type CeReplayChunk = {
  chunk_id: string;
  workspace_id: string;
  tenant_id: string;
  company_id: string;
  content_hash: string;
  chunk_text_redacted: string;
  score?: number | null;
  source_ref?: string | null;
};

export type CeTranscriptTurn = {
  message_id: string;
  role: "visitor" | "assistant" | "agent";
  /** normalized + redacted exactly as sent to the evaluator */
  content_redacted: string;
  created_at: string;
};

export type CeReplayBundle = {
  conversation_id: string;
  attempt_id: string;
  company_id: string;
  workspace_id: string;
  tenant_id: string;
  bundle_version: number;
  transcript_redacted: CeTranscriptTurn[];
  evaluated_reply_message_id: string | null;
  human_response_message_id: string | null;
  grounding: CeReplayChunk[];
  truncation_manifest: {
    turns_total: number;
    turns_included: number;
    chars_dropped: number;
    strategy: string;
  };
  evaluation_contract_version: string;
  model_version: string;
  prompt_version: string;
  kb_snapshot_id: string;
  policy_snapshot_id: string;
};

/** Deterministic canonical JSON: sorted keys, chunks sorted by chunk_id. */
export function canonicalizeBundle(bundle: CeReplayBundle): string {
  const normalized: CeReplayBundle = {
    ...bundle,
    grounding: [...bundle.grounding].sort((a, b) => a.chunk_id.localeCompare(b.chunk_id)),
  };
  return stableStringify(normalized);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/** sha256 over the canonical bundle. Web Crypto — works in browser and Worker. */
export async function computeSnapshotHash(bundle: CeReplayBundle): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalizeBundle(bundle));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Replay Studio verification: hash must reproduce from stored content. */
export async function verifySnapshotHash(bundle: CeReplayBundle, storedHash: string): Promise<boolean> {
  return (await computeSnapshotHash(bundle)) === storedHash;
}

/** Conservative PII redaction applied before anything is persisted. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]")
    .replace(/\b(?:\+?\d[\d\s-]{6,}\d)\b/g, "[phone]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[card]");
}
