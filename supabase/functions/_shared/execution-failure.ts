/** Public diagnostics are closed labels, never provider bodies, prompts or secrets. */
export type ExecutionStage = "admission" | "config" | "provider_http" | "network" | "timeout" | "decode" | "canonical_validation" | "kb_no_match" | "kb_tool" | "persistence" | "unexpected";
export interface ExecutionFailure {
  code: string;
  stage: ExecutionStage;
  retryable: boolean;
  request_id?: string;
  source_message_id?: string;
  http_status?: number;
  b2_code?: string;
}
const codes = new Set([
  "INBOX_CONVERSATION_REQUIRED", "INBOX_REPLAY_DENIED", "INBOX_AUTHORITY_DENIED", "INBOX_SYNTHETIC_SCOPE_DENIED", "INBOX_PAID_SCOPE_DENIED",
  "ORIGINAL_PREVIEW_AUTHORIZATION_REQUIRED", "ORIGINAL_PREVIEW_PROVIDER_DENIED",
  "UAT_HISTORY_EVIDENCE_REQUIRED", "UAT_HISTORY_EVIDENCE_INVALID", "UAT_HISTORY_BOUND_UNPROVED", "UAT_QUOTA_HISTORY_DRIFT", "UAT_CUMULATIVE_QUOTA_LIMIT", "UAT_ISOLATION_DENIED", "UAT_COUNT_TOKENS_LIMIT_REQUIRED", "UAT_COUNT_TOKENS_SCOPE_DENIED", "UAT_CONTROLLED_ENVELOPE_DENIED", "UAT_PROVIDER_OUTCOME_UNKNOWN",
  "LLM_CONFIG_MISSING", "LLM_INPUT_BLOCKED", "LLM_TIMEOUT", "LLM_NETWORK", "LLM_NON_2XX", "LLM_INVALID_OUTPUT", "LLM_GROUNDING_REJECTED", "LLM_ACCOUNTING_DENIED",
  "SEMANTIC_INPUT_LIMIT", "SEMANTIC_INTERPRETER_UNAVAILABLE", "KB_NO_MATCH", "KB_TOOL_FAILURE", "PERSISTENCE_FAILED",
  "B2_SUPERVISION_BLOCKED", "B2_SUPERVISION_INDETERMINATE",
  "UAT_TIMEOUT_OUTCOME_UNKNOWN", "UAT_NETWORK_OUTCOME_UNKNOWN", "UAT_AUTHORIZATION_ABSENT", "UAT_SOURCE_OR_RUN_DENIED", "UAT_DEPENDENCY_MISSING", "UAT_PERSISTENCE_UNAVAILABLE", "UAT_ADMISSION_DENIED", "UAT_DISPATCH_DENIED", "UAT_SCOPE_DENIED", "UAT_PROVIDER_DENIED", "UAT_REMOTE_SCOPE_DENIED", "UAT_REMOTE_BOUND_UNVERIFIED", "UAT_TOKEN_EXPOSURE_DENIED", "UAT_TOKEN_COUNT_UNAVAILABLE", "UAT_INPUT_LIMIT", "UAT_REPLAY_OR_RECEIPT_DENIED", "UAT_FINALIZATION_DENIED", "UAT_USAGE_UNOBSERVABLE_OR_OVER_LIMIT", "UAT_CONVERSATION_REQUIRED",
  "DISPATCH_COMPANY_UNPROVEN", "DISPATCH_TENANT_MISMATCH", "DISPATCH_IDENTITY_UNAVAILABLE", "PREACTIVATION_SCOPE_DENIED", "PREACTIVATION_ACTOR_DENIED", "PREACTIVATION_TICKET_DENIED", "PREACTIVATION_AUTHORITY_DENIED",
  "UAT_RUN_MISSING", "UAT_POLICY_INCOMPLETE", "UAT_PENDING_OBSERVATION", "UAT_AUTHORIZATION_DENIED", "UAT_ENVELOPE_DENIED", "UAT_CALIBRATION_LIMIT", "UAT_STAGE_A_LIMIT", "UAT_STAGE_DENIED", "UAT_CONVERSATION_DENIED", "UAT_REQUEST_ANCHOR_REQUIRED", "UAT_MEMBERSHIP_HISTORY_DRIFT", "UAT_VISITOR_BATCH_LIMIT", "UAT_REPLAY_CONFLICT", "UAT_ATTEMPT_OR_BUDGET_EXPOSURE_LIMIT", "UAT_ROLE_DENIED", "UAT_FINALIZER_ROLE_DENIED", "UAT_FINALIZATION_INVALID", "UAT_RECEIPT_MISSING", "UAT_FINALIZATION_CONFLICT", "UAT_OBSERVATION_INVALID", "UAT_REMOTE_OBSERVATION_INVALID", "UAT_PROVIDER_COST_DENIED", "UAT_EMBEDDING_DENIED",
]);
const stages = new Set<ExecutionStage>(["admission","config","provider_http","network","timeout","decode","canonical_validation","kb_no_match","kb_tool","persistence","unexpected"]);
// Only closed supervisor labels may cross the terminal-response boundary.
// Never persist its detail: it can contain a customer value or field path.
const b2FailureCodes = new Set([
  "ACTION_COMPLETION_NOT_PROVEN", "AMBIGUOUS_CANCELLED_ENTITY_REFERENCE",
  "CANCELLED_ENTITY_RESTORATION", "CANCELLED_ENTITY_INDIRECT_RESTORATION",
  "CANCELLED_INSTALLATION_RESTORATION", "CANCELLED_ORDER_RESTORATION",
  "COMMERCE_CONTEXT_CHANGED_BEFORE_COMMIT", "COMMERCE_STATE_COMPANY_MISMATCH",
  "COMMERCE_STATE_INVALID_ROW", "COMMERCE_STATE_LOOKUP_FAILED", "COMMERCE_STATE_REVISION_INVALID",
  "CONVERSATION_COMPANY_UNRESOLVED", "CONVERSATION_SCOPE_LOOKUP_FAILED", "CONVERSATION_SCOPE_NOT_FOUND",
  "CURRENT_KB_PRICE_FACT_MISMATCH", "CURRENT_KB_PRICE_LINEAGE_INVALID", "CURRENT_KB_PRICE_PROOF_MISSING",
  "CURRENT_KB_PRICE_RESPONSE_MISMATCH", "CURRENT_QUOTE_NOT_PROVEN", "CURRENT_QUOTE_WITHOUT_VERIFIED_AMOUNT",
  "CUSTOMER_CALCULATION_RESPONSE_BINDING_MISMATCH", "CUSTOMER_CALCULATION_SOURCE_HISTORY_MISMATCH",
  "DELIVERY_COMPLETION_NOT_CANONICALLY_PROVABLE", "DELIVERY_CONFIRMATION_NOT_PROVEN",
  "EMPTY_PROPOSED_RESPONSE", "EXPECTED_COMMERCE_REVISION_MISMATCH", "INACTIVE_QUOTE_RESTORATION",
  "INSTALLATION_COMPLETION_NOT_CANONICALLY_PROVABLE", "INSTALLATION_CONFIRMATION_NOT_PROVEN",
  "INVALID_CANONICAL_COMMERCE_STATE", "KNOWN_CONTEXT_RECONFIRMATION", "LATEST_CORRECTION_UNRESOLVED",
  "ORDER_CONFIRMATION_NOT_PROVEN", "PAYMENT_COMPLETION_NOT_PROVEN", "READ_ONLY_RECAP_MEMORY_CHANGED",
  "READ_ONLY_RECAP_SCOPE_OR_HASH_MISMATCH", "SOURCE_MESSAGE_INVALID", "SOURCE_MESSAGE_LOOKUP_FAILED",
  "SUPERSEDED_VALUE_REUSED", "SUPERVISOR_ERROR", "SUPERVISOR_READ_ERROR",
  "UNPROVEN_CORRECTION_COMMIT", "UNPROVEN_CUSTOMER_CALCULATION", "UNPROVEN_LIFECYCLE_COMMIT", "UNPROVEN_READ_ONLY_RECAP",
]);
export function safeB2FailureCode(value: unknown): string | null {
  return typeof value === "string" && b2FailureCodes.has(value) ? value : null;
}
export function safeExecutionCode(value: unknown): string | null {
  return typeof value === "string" && codes.has(value) ? value : null;
}
export function executionFailure(code: unknown, options: {stage?: unknown; request_id?: unknown; source_message_id?: unknown; http_status?: unknown; b2_code?: unknown} = {}): ExecutionFailure {
  const safeCode = safeExecutionCode(code) ?? "SEMANTIC_INTERPRETER_UNAVAILABLE";
  const inferred: ExecutionStage = safeCode === "UAT_TIMEOUT_OUTCOME_UNKNOWN" ? "timeout" : safeCode === "UAT_NETWORK_OUTCOME_UNKNOWN" ? "network" : /^(?:UAT_|DISPATCH_|PREACTIVATION_|ORIGINAL_PREVIEW_|INBOX_)/.test(safeCode) || safeCode === "LLM_ACCOUNTING_DENIED" ? "admission"
    : safeCode === "LLM_CONFIG_MISSING" ? "config" : safeCode === "LLM_TIMEOUT" ? "timeout" : safeCode === "LLM_NETWORK" ? "network"
    : safeCode === "LLM_NON_2XX" ? "provider_http" : safeCode === "LLM_INVALID_OUTPUT" ? "decode" : safeCode === "LLM_GROUNDING_REJECTED" ? "canonical_validation"
    : safeCode === "B2_SUPERVISION_BLOCKED" ? "canonical_validation" : safeCode === "B2_SUPERVISION_INDETERMINATE" ? "persistence"
    : safeCode === "KB_NO_MATCH" ? "kb_no_match" : safeCode === "KB_TOOL_FAILURE" ? "kb_tool" : safeCode === "PERSISTENCE_FAILED" ? "persistence" : "unexpected";
  const isB2Failure = safeCode === "B2_SUPERVISION_BLOCKED" || safeCode === "B2_SUPERVISION_INDETERMINATE";
  const stage = !isB2Failure && stages.has(options.stage as ExecutionStage) ? options.stage as ExecutionStage : inferred;
  const status = typeof options.http_status === "number" && Number.isInteger(options.http_status) && options.http_status >= 100 && options.http_status <= 599 ? options.http_status : undefined;
  // Stable server-generated operation labels and UUIDs only; never echo caller text.
  const request = typeof options.request_id === "string" && /^(?:[a-z][a-z0-9-]*:)*[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?::[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?(?::(?:generation-attempt:[1-3]|transform-retry))?$/i.test(options.request_id) ? options.request_id : undefined;
  const source = typeof options.source_message_id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.source_message_id) ? options.source_message_id : undefined;
  const b2Code = isB2Failure ? safeB2FailureCode(options.b2_code) : null;
  return { code: safeCode, stage, retryable: !safeCode.startsWith("UAT_") && !isB2Failure && (stage === "network" || stage === "timeout" || (stage === "provider_http" && (status === 429 || (status ?? 0) >= 500))), ...(request ? {request_id:request} : {}), ...(source ? {source_message_id:source} : {}), ...(status ? {http_status:status} : {}), ...(b2Code ? {b2_code:b2Code} : {}) };
}
export function failureFromError(error: unknown, options: Parameters<typeof executionFailure>[1] = {}): ExecutionFailure {
  const code = error && typeof error === "object" && "code" in error ? safeExecutionCode(error.code) : null;
  return executionFailure(code ?? (error instanceof Error && error.name === "AbortError" ? "LLM_TIMEOUT" : "SEMANTIC_INTERPRETER_UNAVAILABLE"), options);
}
