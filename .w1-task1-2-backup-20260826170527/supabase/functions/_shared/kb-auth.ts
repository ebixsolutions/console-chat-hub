// supabase/functions/_shared/kb-auth.ts
// Server-only Singapore KB credential resolver.
//
// Priority:
//   1. tenant-specific opaque API key (preferred for AI Chatbot)
//   2. tenant JWT minted from KB_SINGAPORE_JWT_SECRET
//   3. legacy tenant JWT/token mapping
//   4. legacy default JWT/token
//
// Opaque API keys are selected only from a server-side tenant mapping and are
// never decoded as JWTs. The Singapore KB backend is responsible for binding
// each issued key to exactly one tenant/company.

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

export async function resolveSingaporeCredential(
  scope: KBCredentialScope,
  cfg: KBCredentialConfig,
): Promise<KBCredential> {
  // Preferred path: tenant-bound opaque key. It is selected exclusively by
  // server-derived Singapore tenant id; browser/company payloads never choose it.
  const apiKey = cfg.tenantApiKeys[scope.singaporeTenantId]?.trim();
  if (apiKey) {
    if (!validOpaqueApiKey(apiKey)) {
      return { ok: false, error_code: "KB_AUTH_API_KEY_INVALID" };
    }
    return { ok: true, kind: "api_key", value: apiKey };
  }

  // Legacy/JWT rollback paths remain available.
  const minted = await mintSingaporeTenantJwt(scope, cfg);
  const token = minted ??
    cfg.tenantTokens[scope.singaporeTenantId] ??
    cfg.defaultToken;

  if (!token) {
    return { ok: false, error_code: "KB_AUTH_TOKEN_MISSING" };
  }

  const claims = decodeJwtPayload(token);
  if (!claims) {
    return { ok: false, error_code: "KB_AUTH_TOKEN_INVALID" };
  }

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

export function singaporeCredentialHeaders(
  credential: Extract<KBCredential, { ok: true }>,
  cfg: Pick<KBCredentialConfig, "apiKeyHeaderMode">,
): Record<string, string> {
  if (
    credential.kind === "api_key" &&
    cfg.apiKeyHeaderMode === "x-api-key"
  ) {
    return { "X-API-Key": credential.value };
  }

  return { Authorization: `Bearer ${credential.value}` };
}
