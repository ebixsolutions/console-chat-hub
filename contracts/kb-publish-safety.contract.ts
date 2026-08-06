/**
 * KB Publish Safety Contract — the rules the AI Chatbot enforces when
 * consuming KB content, and the rules the KB app must enforce before
 * marking content as available.
 *
 * This is a compile-time contract: both apps import the types and the
 * AI Chatbot's grounding adapter rejects content that violates them.
 */

/** A KB chunk is eligible for AI Chatbot retrieval ONLY when all of these hold. */
export interface KBChunkEligibility {
  /** The chunk has been embedded by a real model (not placeholder/simulated). */
  embedding_status: "indexed";
  embedding_model: string; // must not be "placeholder" | "simulated"

  /** The parent document has been through the full publish pipeline. */
  document_status: "published";
  production_vector_status: "indexed";
  available_to_live_console: true;

  /** Content hash integrity: the hash was computed from the actual content,
   *  not from an empty string or a stale version. */
  content_hash: string; // non-empty, matches SHA-256 of the indexed content
  content_hash_verified_at: string; // ISO timestamp of the last verification

  /** Tenant scope: every chunk belongs to exactly one company. */
  workspace_id: string;
  tenant_id: string;
}

/**
 * The publish pipeline must satisfy this invariant before setting
 * available_to_live_console = true:
 *
 *   1. Real embedding generated (not stub)
 *   2. embedding_status verified as 'indexed' by a read-back
 *   3. content_hash computed from the actual content at embedding time
 *   4. content_hash matches KBDocument.content_hash
 *   5. content_hash matches KBUserPublishConfirmation.effective_content_hash
 *      (when user confirmation path is used)
 *   6. Staging RAG success
 *   7. Production Vector success
 *   8. Atomic status update (no partial published state)
 *   9. Audit log written
 *   10. Publish result reported with mutually exclusive categories
 */

/** Categories the publish result must report. The sum must equal total targets. */
export type PublishResultCategory =
  | "published_success"
  | "replaced_existing_version"
  | "skipped_existing"
  | "discarded"
  | "review_blocked"
  | "technical_failed"
  | "partial_incomplete";

/**
 * The AI Chatbot's grounding adapter (ce-grounding.ts) enforces:
 *   - chunk.embedding_status === 'indexed' (or rejection)
 *   - chunk.embedding_model !== 'placeholder' and !== 'simulated' (or rejection)
 *   - chunk.workspace_id and chunk.tenant_id match the company (or rejection)
 *   - chunk.content is non-empty (or rejection)
 *   - per-chunk content_sha256 is computed and persisted in the grounding manifest
 *
 * The KB app must not set available_to_live_console = true unless:
 *   - generateEmbeddings returns a real embedding (not 'hello')
 *   - embedding_status is set to 'indexed' only after the real embedding succeeds
 *   - content_hash is set from the actual content before confirmation
 *   - the publish function runs through a backend function with RBAC, not
 *     a frontend handlePublish that directly updates entity status
 */

export interface PublishGateChecks {
  auth_verified: boolean;
  tenant_verified: boolean;
  rbac_publish_permission: boolean;
  content_hash_matches: boolean;
  embedding_real: boolean; // generateEmbeddings returned real vectors, not stub
  embedding_status_indexed: boolean; // read-back confirmed
  staging_rag_success: boolean;
  production_vector_success: boolean;
  review_gate_passed: boolean; // KBReview or user confirmation
  atomic_status_update: boolean;
  audit_logged: boolean;
}

/**
 * SU CoachAI Training Consumer Contract
 *
 * SU CoachAI receives training candidates from the AI Chatbot's
 * evaluation_training_outbox. It must NOT:
 *   - directly publish to KB production vectors
 *   - modify KB content without going through the publish pipeline
 *   - bypass the content_hash verification
 *
 * It MAY:
 *   - create KB proposals (draft documents)
 *   - suggest modifications to existing documents
 *   - return improved_result to the AI Chatbot's ce_training_link
 */
export interface TrainingConsumerContract {
  /** The consumer receives a delivered outbox entry. */
  input: {
    evaluation_id: string;
    conversation_id: string;
    company_id: string;
    overall_score: number;
    severity: string;
    evaluation_contract_version: string;
  };
  /** The consumer returns an improved result. */
  output: {
    improved_reply: string;
    improvement_source: "human_edit" | "model_regeneration" | "kb_update";
    kb_proposal_ids: string[]; // draft documents, never published directly
  };
}
