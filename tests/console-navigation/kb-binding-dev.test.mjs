import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

const read = (path) => fs.readFileSync(path, "utf8");
const ddl = read("supabase/migrations/20261111030000_task3c_company_kb_binding.sql");
const rollback = read("supabase/migrations/rollback/20261111030000_task3c_company_kb_binding.rollback.sql");
const handler = read("src/lib/api/kbBinding.service.ts");
const route = read("src/routes/_authenticated/console.settings.kb-binding.tsx");
const kb = read("supabase/functions/_shared/kb-client.ts");
const nav = read("src/routes/_authenticated/console.tsx");
const tree = read("src/routeTree.gen.ts");
const chain = read("tests/emergency-p0/chain.test.mjs");

test("one scoped mapping table and encrypted Vault secret, no raw key column", () => {
  assert.match(ddl, /CREATE TABLE public\.company_kb_tenant_binding/);
  assert.equal((ddl.match(/CREATE TABLE public\.company_kb_tenant_binding/g) ?? []).length, 1);
  assert.match(ddl, /company_id uuid PRIMARY KEY REFERENCES public\.company\(id\)/);
  assert.match(ddl, /kb_tenant_id text NOT NULL/);
  assert.match(ddl, /api_key_secret_ref uuid/);
  assert.doesNotMatch(ddl, /(?:^|\s)api_key\s+text\b/m);
  assert.match(ddl, /ALTER TABLE public\.company_kb_tenant_binding ENABLE ROW LEVEL SECURITY/);
  assert.match(ddl, /REVOKE ALL ON public\.company_kb_tenant_binding FROM PUBLIC, anon, authenticated/);
  assert.match(ddl, /CREATE POLICY kb_binding_admin_same_company_read/);
  assert.match(ddl, /cm\.company_id = company_kb_tenant_binding\.company_id/);
  assert.match(ddl, /GRANT EXECUTE ON FUNCTION public\.kb_binding_write_v1[\s\S]*TO service_role/);
  assert.match(ddl, /GRANT EXECUTE ON FUNCTION public\.kb_binding_secret_v1[\s\S]*TO service_role/);
  assert.match(ddl, /vault\.create_secret/);
  assert.match(ddl, /vault\.update_secret/);
  assert.match(ddl, /vault\.decrypted_secrets/);
});
test("server uses original Auth/RLS user and role, not posted actor or email", () => {
  assert.match(handler, /middleware\(\[requireSupabaseAuth\]\)/);
  assert.match(handler, /\.eq\("user_id", context\.userId\)/);
  assert.match(handler, /\.eq\("is_active", true\)\.eq\("role", "admin"\)/);
  assert.match(handler, /\.eq\("channel_type","web_widget"\)/);
  assert.match(handler, /p_actor: String\(context\.userId\)/);
  assert.doesNotMatch(handler, /\bp_actor:\s*data\./);
  assert.match(handler, /C3_KB_BINDING_DEV_ENABLED/);
  assert.match(handler, /C3_KB_BINDING_INVITES_ENABLED/);
  assert.match(handler, /kb_binding_invite_grant_v1/);
  assert.match(handler, /granted\?\.is_active !== true/);
  assert.doesNotMatch(handler, /is_active:\s*false/);
  assert.match(ddl, /CREATE FUNCTION public\.kb_binding_invite_grant_v1/);
  assert.match(ddl, /ON CONFLICT \(company_id,user_id,role\) DO UPDATE SET is_active=true/);
  assert.match(ddl, /GRANT EXECUTE ON FUNCTION public\.kb_binding_invite_grant_v1[\s\S]*TO service_role/);
  assert.match(ddl, /KB_INVITE_ROLE_CONFLICT/);
  assert.match(ddl, /v_old\.revision <> p_expected_revision/);
  assert.match(ddl, /FOR UPDATE/);
});
test("same-company automatic mapping is fail-closed, managed key never env fallback", () => {
  assert.match(kb, /company_kb_tenant_binding/);
  assert.match(kb, /managed\.is_active !== true/);
  assert.match(kb, /managedBinding = true/);
  assert.match(kb, /kb_binding_secret_v1/);
  assert.match(kb, /scope\.managedBinding\s*\?\s*resolveManagedSingaporeCredential/);
  assert.match(kb, /KB_MANAGED_CREDENTIAL_UNAVAILABLE/);
  assert.match(kb, /managed\.api_key_secret_ref/);
  assert.match(kb, /KB_SINGAPORE_TENANT_MAP_JSON/);
});
test("development UI is real route and role/host guarded with write-only key", () => {
  assert.match(route, /createFileRoute\("\/_authenticated\/console\/settings\/kb-binding"\)/);
  assert.match(route, /role === "admin" && devPageHost\(\)/);
  assert.match(route, /type="password"/);
  assert.match(route, /setKey\(""\)/);
  assert.match(route, /expected_revision: savedRev/);
  assert.match(route, /Invite account and grant same-Company role/);
  assert.match(tree, /console\.settings\.kb-binding/);
  assert.match(tree, /\/_authenticated\/console\/settings\/kb-binding/);
  assert.match(chain, /PGRST205/);
  assert.match(nav, /navKBBinding/);
  assert.match(nav, /showKbDevLink/);
  assert.match(nav, /kbDevOnly/);
  assert.doesNotMatch(nav, /"KB Tenant Binding \(Dev\)"[\s\S]*?\/console\/settings\/kb-binding[\s\S]*?password\s*:/);
});
test("rollback cannot erase existing live KB binding rows or Vault secret", () => {
  assert.match(rollback, /KB_BINDING_ROLLBACK_HAS_MAPPINGS_SAFE_STOP/);
  assert.match(rollback, /DROP TABLE IF EXISTS public\.company_kb_tenant_binding/);
  assert.doesNotMatch(rollback, /DELETE FROM vault|DROP SCHEMA vault|DELETE FROM public\.company_membership/);
});
test("Vault audit history stays chronological and rollback removes invite RPC without leaking secrets", () => {
  assert.match(ddl, /jsonb_agg\(item ORDER BY ord ASC\)/);
  assert.match(ddl, /substr\(gen_random_uuid\(\)::text,1,12\)/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.kb_binding_invite_grant_v1/);
  assert.doesNotMatch(handler, /getUserById\(.*api_key/);
});
