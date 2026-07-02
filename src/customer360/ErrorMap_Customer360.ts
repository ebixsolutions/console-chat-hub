// Task I: Static error type extension map. No logic.

export const ERROR_MAP_CUSTOMER360 = {
  CUSTOMER_NOT_FOUND: "No matching customer record found (exact name match only)",
  CUSTOMER360_NO_CONTEXT_AVAILABLE: "Customer context is unavailable or intentionally not returned (may be due to insufficient data, unlinked visitor, privacy masking, or permission scope — does NOT necessarily mean customer not found)",
  CUSTOMER360_API_NOT_CONFIGURED: "Customer360 source endpoint not configured",
  CUSTOMER360_API_TIMEOUT: "Customer360 source request timed out (reserved for live integration)",
  CUSTOMER360_AUTH_FAILED: "Customer360 source authentication failed (reserved for live integration)",
};
