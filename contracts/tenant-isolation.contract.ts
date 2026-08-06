/**
 * Tenant Isolation Contract — cross-app security requirements.
 *
 * Current state:
 *   - AI Chatbot (Lovable): company table + company_membership + RLS
 *     (implemented in 20260728093000_ce_task1.sql)
 *   - KB app (Base44): NO tenant column on any entity
 *   - SU CoachAI (Base44): NO tenant column on any entity
 *
 * Target state: every entity in every app carries a tenant identifier
 * and every query is scoped to the caller's tenant.
 *
 * The AI Chatbot's tenant model is authoritative:
 *   - company.id = internal tenant id
 *   - company.external_workspace_id = KB workspace scope
 *   - company.external_tenant_id = KB tenant scope
 *
 * KB and CoachAI must add tenant_id to every entity and filter every
 * query by it. The exact field name in Base44 should be 'tenant_id'
 * to match the kb-adapter contract which already requires it.
 *
 * Until Base44 apps implement tenant isolation:
 *   - The AI Chatbot's grounding adapter validates scope on every chunk
 *   - The AI Chatbot's evaluation pipeline validates scope on every call
 *   - Cross-app data exchange validates tenant_id at every boundary
 *   - No data from one tenant may appear in another tenant's evaluation
 */

export interface TenantBoundary {
  /** Every API call must carry and validate the caller's tenant. */
  inbound: {
    auth_required: true;
    tenant_from: "company_membership" | "request_header";
    operatorUserId_trusted: false; // never trust request-supplied user id
    scope_enforcement: "fail_closed"; // reject if tenant cannot be resolved
  };

  /** Every data query must be tenant-scoped. */
  query: {
    every_entity_has_tenant_id: true;
    every_select_filtered_by_tenant: true;
    cross_tenant_join_prohibited: true;
  };

  /** Service-role functions must still validate tenant scope. */
  service_role: {
    login_check_only: false; // must also check tenant membership
    admin_only_functions: string[]; // test, reset, migration functions
    production_disabled: string[]; // firecrawlScrape, storageTest, generateEmbeddings (stub)
  };
}
