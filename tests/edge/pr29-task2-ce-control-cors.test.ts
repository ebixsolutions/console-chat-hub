import { isAllowedCeOrigin, ceCorsHeaders } from "../../supabase/functions/_shared/ce-cors.ts";

function assertEq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

Deno.test("CE CORS allows production and project-scoped preview origins only", () => {
  const project = "4dbf593e-577e-4af4-a553-460441c34473";

  assertEq(isAllowedCeOrigin("https://console-chat-hub.lovable.app"), true, "production");
  assertEq(isAllowedCeOrigin(`https://${project}.lovable.app`), true, "project lovable.app");
  assertEq(isAllowedCeOrigin(`https://id-preview--${project}.lovable.app`), true, "id preview");
  assertEq(isAllowedCeOrigin(`https://preview--feature-a--${project}.lovable.app`), true, "nested preview");
  assertEq(isAllowedCeOrigin(`https://${project}.lovableproject.com`), true, "project lovableproject.com");
  assertEq(isAllowedCeOrigin(`https://branch--${project}.lovableproject.com`), true, "lovableproject preview");

  assertEq(isAllowedCeOrigin("http://console-chat-hub.lovable.app"), false, "http rejected");
  assertEq(isAllowedCeOrigin("https://evil.lovable.app"), false, "other lovable app rejected");
  assertEq(isAllowedCeOrigin(`https://${project}.lovable.app.evil.example`), false, "suffix confusion rejected");
  assertEq(isAllowedCeOrigin(`https://evil${project}.lovable.app`), false, "missing delimiter rejected");
  assertEq(isAllowedCeOrigin("not-a-url"), false, "invalid origin rejected");
  assertEq(isAllowedCeOrigin(""), false, "empty origin rejected");

  const preview = `https://id-preview--${project}.lovable.app`;
  assertEq(ceCorsHeaders(preview)["Access-Control-Allow-Origin"], preview, "preview ACAO");
  assertEq(ceCorsHeaders("https://evil.lovable.app")["Access-Control-Allow-Origin"], "", "evil ACAO empty");
});
