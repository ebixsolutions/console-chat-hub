// supabase/functions/_shared/kb-auth.ts
// Server-only Singapore KB credential resolver.
//
// Data-plane/RAG contract:
//   opaque tenant-bound API key -> x-api-key
// Control-plane contract (CRUD / publish / migration):
//   tenant-bound service JWT/token -> Authorization: Bearer
//
// Browser payloads never choose company/tenant/key scope.

export type KBAuthHeaderMode = "authorization" | "x-api-key";
export type KBScopeMode = "canonical" | "pre_activation" | "demo";

export interface KBCredentialScope {
  mode: KBScopeMode;
  aiCompanyId: string | null;
  singaporeTenantId: string;
}

export interface KBCredentialConfig {
  signingSecret?: string;
  jwtTtlSec: number;
  defaultToken?: string;
  tenantTokens: Record<string, string>;
  tenantApiKeys: Record<string, string>;
  apiKeyHeaderMode: KBAuthHeaderMode;
}

export type KBCredential =
  | { ok: true; kind: "api_key" | "jwt"; value: string }
  | { ok: false; error_code: string };

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4 || 4)) % 4);
    const parsed = JSON.parse(atob(padded));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlJson(value: Record<string, unknown>): string {
  return base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(value)),
  );
}

async function mintSingaporeTenantJwt(
  scope: KBCredentialScope,
  cfg: KBCredentialConfig,
): Promise<string | null> {
  if (!cfg.signingSecret) return null;

  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const actorRef = scope.mode === "canonical" && scope.aiCompanyId
    ? `company:${scope.aiCompanyId}`
    : scope.mode === "pre_activation"
      ? "pre-activation"
      : "demo";
  const payload = base64UrlJson({
    sub: `ai-chatbot:${actorRef}`,
    tenant_id: scope.singaporeTenantId,
    role: "service",
    iat: now,
    exp: now + cfg.jwtTtlSec,
  });
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(cfg.signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function validOpaqueApiKey(value: string): boolean {
  if (value.length < 16 || value.length > 1024) return false;
  return !/[\r\n\0]/.test(value);
}

function validateTenantJwt(
  scope: KBCredentialScope,
  token: string,
  missingCode: string,
): KBCredential {
  if (!token) return { ok: false, error_code: missingCode };
  const claims = decodeJwtPayload(token);
  if (!claims) return { ok: false, error_code: "KB_AUTH_TOKEN_INVALID" };

  const tokenTenant = claims.tenant_id ?? claims.sub;
  if (String(tokenTenant ?? "") !== scope.singaporeTenantId) {
    return { ok: false, error_code: "KB_AUTH_TENANT_MISMATCH" };
  }

  const exp = Number(claims.exp);
  if (Number.isFinite(exp) && exp * 1000 <= Date.now() + 5000) {
    return { ok: false, error_code: "KB_AUTH_TOKEN_EXPIRED" };
  }
  return { ok: true, kind: "jwt", value: token };
}

/**
 * Resolve the Singapore RAG/data-plane credential.
 * Production prefers the tenant-scoped opaque x-api-key. JWT remains a
 * documented rollback/data-plane option only.
 */
export async function resolveSingaporeCredential(
  scope: KBCredentialScope,
  cfg: KBCredentialConfig,
): Promise<KBCredential> {
  const apiKey = cfg.tenantApiKeys[scope.singaporeTenantId]?.trim();
  if (apiKey) {
    if (!validOpaqueApiKey(apiKey)) {
      return { ok: false, error_code: "KB_AUTH_API_KEY_INVALID" };
    }
    return { ok: true, kind: "api_key", value: apiKey };
  }

  const minted = await mintSingaporeTenantJwt(scope, cfg);
  const token = minted ??
    cfg.tenantTokens[scope.singaporeTenantId] ??
    cfg.defaultToken ?? "";
  return validateTenantJwt(scope, token, "KB_AUTH_TOKEN_MISSING");
}

/**
 * Resolve a Singapore control-plane credential for entity CRUD, publish and
 * migration operations. RAG API keys are deliberately NEVER considered here:
 * current Singapore generic CRUD correctly rejects those keys, and silently
 * retrying a data-plane key on a mutation path hides missing service auth.
 */
export async function resolveSingaporeControlCredential(
  scope: KBCredentialScope,
  cfg: KBCredentialConfig,
): Promise<KBCredential> {
  const minted = await mintSingaporeTenantJwt(scope, cfg);
  const token = minted ??
    cfg.tenantTokens[scope.singaporeTenantId] ??
    cfg.defaultToken ?? "";
  const resolved = validateTenantJwt(scope, token, "KB_AUTH_CONTROL_TOKEN_MISSING");
  if (!resolved.ok) return resolved;
  return { ok: true, kind: "jwt", value: resolved.value };
}

export function singaporeCredentialHeaders(
  credential: Extract<KBCredential, { ok: true }>,
  cfg: Pick<KBCredentialConfig, "apiKeyHeaderMode">,
): Record<string, string> {
  if (
    credential.kind === "api_key" &&
    cfg.apiKeyHeaderMode === "x-api-key"
  ) {
    return { "x-api-key": credential.value };
  }
  return { Authorization: `Bearer ${credential.value}` };
}
