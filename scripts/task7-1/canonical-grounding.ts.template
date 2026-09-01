import type { KBDocumentCandidate, KBFullChunk, KBLLMContextEvidence } from "./kb-client.ts";
import { detectExplicitJurisdiction } from "./conversation-runtime-state.ts";

export interface CanonicalGroundingOptions {
  minScore?: number;
  policyOnly?: boolean;
  requirePublished?: boolean;
  requestText?: string;
}
export type CanonicalGroundingResult =
  | {
      ok: true;
      document: KBDocumentCandidate | null;
      chunks: KBFullChunk[];
      evidence: KBLLMContextEvidence[];
      applicability: {
        accepted: boolean;
        reason: string;
        request_jurisdiction: string | null;
        document_jurisdictions: string[];
      };
    }
  | { ok: false; error: "KB_DOCUMENT_EVIDENCE_MISMATCH" | "KB_EVIDENCE_NOT_PUBLISHED" };

function modelTokens(text: string): string[] {
  return [...new Set(
    (text.match(/\b[A-Z]{2,}[A-Z0-9]*[- ]?\d{2,}[A-Z0-9-]*\b/g) ?? [])
      .map((x) => x.replace(/\s+/g, "").toUpperCase()),
  )];
}
function candidateText(document: KBDocumentCandidate): string {
  return [
    document.title,
    document.source_type,
    ...document.chunks.map((c) => `${c.title ?? ""} ${c.content}`),
    ...document.llm_context.full_content_evidence.map((e) => e.content),
  ].join("\n").slice(0, 50000);
}
function jurisdictions(text: string): string[] {
  const found: string[] = [];
  if (/(mars|火星)/i.test(text)) found.push("mars");
  if (/(香港|hong\s*kong|\bhk\b)/i.test(text)) found.push("hong_kong");
  if (/(澳門|澳门|macau|macao)/i.test(text)) found.push("macau");
  if (/(新加坡|singapore)/i.test(text)) found.push("singapore");
  if (/(台灣|台湾|taiwan)/i.test(text)) found.push("taiwan");
  if (/(中國大陸|中国大陆|內地|内地|mainland\s*china)/i.test(text)) found.push("mainland_china");
  return found;
}
function assessApplicability(document: KBDocumentCandidate, requestText: string) {
  const requestJurisdiction = detectExplicitJurisdiction(requestText);
  const text = candidateText(document);
  const documentJurisdictions = jurisdictions(text);
  if (requestJurisdiction === "mars" && !documentJurisdictions.includes("mars")) {
    return {
      accepted: false,
      reason: "unsupported_explicit_jurisdiction",
      request_jurisdiction: requestJurisdiction,
      document_jurisdictions: documentJurisdictions,
    };
  }
  if (
    requestJurisdiction &&
    documentJurisdictions.length > 0 &&
    !documentJurisdictions.includes(requestJurisdiction)
  ) {
    return {
      accepted: false,
      reason: "jurisdiction_mismatch",
      request_jurisdiction: requestJurisdiction,
      document_jurisdictions: documentJurisdictions,
    };
  }
  const requestModels = modelTokens(requestText);
  const documentModels = modelTokens(text);
  if (
    requestModels.length > 0 &&
    documentModels.length > 0 &&
    !requestModels.some((model) => documentModels.includes(model))
  ) {
    return {
      accepted: false,
      reason: "model_mismatch",
      request_jurisdiction: requestJurisdiction,
      document_jurisdictions: documentJurisdictions,
    };
  }
  return {
    accepted: true,
    reason: "applicable",
    request_jurisdiction: requestJurisdiction,
    document_jurisdictions: documentJurisdictions,
  };
}

export function selectCanonicalGrounding(
  documents: KBDocumentCandidate[],
  options: CanonicalGroundingOptions = {},
): CanonicalGroundingResult {
  const minScore = Number.isFinite(options.minScore) ? Number(options.minScore) : 0;
  const policyOnly = options.policyOnly === true;
  const requirePublished = options.requirePublished !== false;
  const requestText = options.requestText ?? "";
  const eligible: Array<{
    document: KBDocumentCandidate;
    chunks: KBFullChunk[];
    evidence: KBLLMContextEvidence[];
    applicability: ReturnType<typeof assessApplicability>;
    evidenceScore: number;
  }> = [];

  for (const document of documents ?? []) {
    if (document.llm_context.selected_document_id !== document.document_id) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }
    if (document.llm_context.full_content_evidence.some((e) => e.document_id !== document.document_id)) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }
    if (document.chunks.some((c) => c.document_id !== document.document_id)) {
      return { ok: false, error: "KB_DOCUMENT_EVIDENCE_MISMATCH" };
    }

    const chunks = document.chunks.filter((c) =>
      c.content.trim() &&
      Number.isFinite(c.score) &&
      c.score >= minScore &&
      (!requirePublished || c.status === "published") &&
      (!policyOnly || c.source_type.toLowerCase().includes("policy"))
    );
    const fullContentIds = new Set(
      chunks.filter((c) => c.chunk_type === "full_content").map((c) => c.chunk_id ?? c.content),
    );
    const evidence = document.llm_context.full_content_evidence.filter((e) =>
      e.content.trim() &&
      Number.isFinite(e.score) &&
      e.score >= minScore &&
      (!policyOnly || e.source_type.toLowerCase().includes("policy")) &&
      fullContentIds.has(e.chunk_id ?? e.content)
    );

    if (requirePublished && evidence.length > 0 && chunks.every((c) => c.status !== "published")) {
      return { ok: false, error: "KB_EVIDENCE_NOT_PUBLISHED" };
    }
    if (!evidence.length) continue;

    const applicability = assessApplicability(document, requestText);
    if (!applicability.accepted) continue;
    eligible.push({
      document,
      chunks,
      evidence,
      applicability,
      evidenceScore: Math.max(...evidence.map((e) => e.score), 0),
    });
  }

  eligible.sort((a, b) =>
    b.document.document_score - a.document.document_score ||
    b.evidenceScore - a.evidenceScore ||
    a.document.document_id.localeCompare(b.document.document_id)
  );
  const winner = eligible[0];
  return winner
    ? {
        ok: true,
        document: winner.document,
        chunks: winner.chunks,
        evidence: winner.evidence,
        applicability: winner.applicability,
      }
    : {
        ok: true,
        document: null,
        chunks: [],
        evidence: [],
        applicability: {
          accepted: false,
          reason: "no_applicable_published_evidence",
          request_jurisdiction: detectExplicitJurisdiction(requestText),
          document_jurisdictions: [],
        },
      };
}
