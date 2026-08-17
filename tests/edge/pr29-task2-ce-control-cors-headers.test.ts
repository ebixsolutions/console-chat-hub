import {
  ceCorsHeaders,
  isAllowedCeOrigin,
  resolveCeAllowedHeaders,
} from "../../supabase/functions/_shared/ce-cors.ts";

function assertEq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

Deno.test("CE CORS allows production and project-scoped preview origins only", () => {
  const project = "4dbf593e-577e-4af4-a553-460441c34473";
  assertEq(isAllowedCeOrigin("https://console-chat-hub.lovable.app"), true, "production");
  assertEq(isAllowedCeOrigin(`https://${project}.lovable.app`), true, "project lovable.app");
  assertEq(isAllowedCeOrigin(`https://id-preview--${project}.lovable.app`), true, "id preview");
  assertEq(isAllowedCeOrigin(`https://preview--feature-a--${project}.lovable.app`), true, "nested preview");
  assertEq(isAllowedCeOrigin(`https://${project}.lovableproject.com`), true, "lovableproject");
  assertEq(isAllowedCeOrigin(`https://branch--${project}.lovableproject.com`), true, "lovableproject preview");
  assertEq(isAllowedCeOrigin("https://evil.lovable.app"), false, "other lovable app rejected");
  assertEq(isAllowedCeOrigin("http://console-chat-hub.lovable.app"), false, "http rejected");
});

Deno.test("CE CORS accepts the exact Supabase invoke preflight headers", () => {
  const requestHeaders =
    "authorization, x-client-info, apikey, content-type, x-supabase-api-version";

  assertEq(
    resolveCeAllowedHeaders(requestHeaders),
    requestHeaders,
    "supabase invoke headers",
  );

  const origin =
    "https://id-preview--4dbf593e-577e-4af4-a553-460441c34473.lovable.app";
  const headers = ceCorsHeaders(origin, requestHeaders);

  assertEq(headers["Access-Control-Allow-Origin"], origin, "preview ACAO");
  assertEq(
    headers["Access-Control-Allow-Headers"],
    requestHeaders,
    "preview ACAH",
  );
  assertEq(
    headers.Vary,
    "Origin, Access-Control-Request-Headers",
    "vary headers",
  );
});

Deno.test("CE CORS fails closed on unknown requested headers", () => {
  assertEq(
    resolveCeAllowedHeaders(
      "authorization, x-client-info, apikey, content-type, x-evil-header",
    ),
    "",
    "unknown header rejected",
  );
});
