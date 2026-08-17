import {
  resolveSingaporeCredential,
  singaporeCredentialHeaders,
  type KBCredentialConfig,
  type KBCredentialScope,
} from "../../supabase/functions/_shared/kb-auth.ts";

function assert(v: unknown, label: string): asserts v {
  if (!v) throw new Error(label);
}
function eq(a: unknown, b: unknown, label: string) {
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

const scope: KBCredentialScope = {
  mode: "pre_activation",
  aiCompanyId: null,
  singaporeTenantId: "6a12c8b68d8278b4c735e9ec",
};

function cfg(overrides: Partial<KBCredentialConfig> = {}): KBCredentialConfig {
  return {
    jwtTtlSec: 300,
    tenantTokens: {},
    tenantApiKeys: {},
    apiKeyHeaderMode: "authorization",
    ...overrides,
  };
}

Deno.test("opaque tenant API key is preferred and does not require JWT shape", async () => {
  const key = "nexus-ai-chatbot-company-key-opaque-2026";
  const r = await resolveSingaporeCredential(
    scope,
    cfg({
      defaultToken: "not-a-jwt",
      tenantApiKeys: { [scope.singaporeTenantId]: key },
    }),
  );
  assert(r.ok, "api key should resolve");
  eq(r.kind, "api_key", "credential kind");
  eq(r.value, key, "credential value");
  eq(
    singaporeCredentialHeaders(r, { apiKeyHeaderMode: "authorization" }).Authorization,
    `Bearer ${key}`,
    "bearer header",
  );
});

Deno.test("tenant-specific key cannot bleed to another tenant", async () => {
  const other: KBCredentialScope = {
    ...scope,
    singaporeTenantId: "another-tenant",
  };
  const r = await resolveSingaporeCredential(
    other,
    cfg({
      tenantApiKeys: {
        [scope.singaporeTenantId]:
          "nexus-ai-chatbot-company-key-opaque-2026",
      },
    }),
  );
  assert(!r.ok, "other tenant must not receive first tenant key");
  eq(r.error_code, "KB_AUTH_TOKEN_MISSING", "missing credential");
});

Deno.test("x-api-key mode is supported without source change", async () => {
  const key = "nexus-ai-chatbot-company-key-opaque-2026";
  const r = await resolveSingaporeCredential(
    scope,
    cfg({
      tenantApiKeys: { [scope.singaporeTenantId]: key },
      apiKeyHeaderMode: "x-api-key",
    }),
  );
  assert(r.ok, "api key should resolve");
  const h = singaporeCredentialHeaders(r, { apiKeyHeaderMode: "x-api-key" });
  eq(h["X-API-Key"], key, "x-api-key header");
  eq(h.Authorization, undefined, "authorization omitted");
});

Deno.test("short or control-character opaque keys fail closed", async () => {
  for (const key of ["short", "valid-looking-key-but\nnewline"]) {
    const r = await resolveSingaporeCredential(
      scope,
      cfg({ tenantApiKeys: { [scope.singaporeTenantId]: key } }),
    );
    assert(!r.ok, "invalid api key must fail");
    eq(r.error_code, "KB_AUTH_API_KEY_INVALID", "invalid key code");
  }
});
