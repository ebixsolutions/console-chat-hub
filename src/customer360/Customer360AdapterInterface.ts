// Task I: Pure contract definition. No execution logic. Not imported by any production file.
// Field source: Contract 06 v1.1 FROZEN + L4c get-customer-context (PROOF PASSED 2026-06-23)
// PII rule: HIGH PII (lifetime_value / past_complaints / notes / sensitive_to) is NEVER included here.

export interface Customer360AdapterRequest {
  customer_name: string; // exact match only, per L4c anti-enumeration rule
                         // ⚠️ proof-compatible contract only.
                         // Future live integration should prefer opaque customer_ref / external_customer_id
                         // after L4c Governance approval — do NOT rely on customer_name as permanent identifier.
  conversation_id?: string;
}

export interface Customer360AdapterResponse {
  context_available: boolean;
  customer_name_masked?: string;
  tier?: string;
  tier_since_year?: number;
  language_preference?: string;
  data_freshness_score?: number;
  memory_confidence_score?: number;
  error_type?: string;
}
