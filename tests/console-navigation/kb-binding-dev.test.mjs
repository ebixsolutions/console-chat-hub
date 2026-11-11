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
  assert.match(route, /Invite new account and grant same-Company role/);
  assert.match(route, /AI Chatbot login email/);
  assert.match(route, /Singapore KB company_id \(numeric, e\.g\. 34 or 35\)/);
  assert.match(route, /verifiedLogin/);
  assert.match(route, /member\.is_active && member\.email\?\.trim\(\)\.toLowerCase\(\) === normalizedEmail/);
  assert.doesNotMatch(route, /id="kb-company-input"/);
  assert.match(route, /kb_company_id: current\.kb_company_id \?\? null/);
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

test("private Preview SSR receives its independent development-only server flag", () => {
  const vite = read("vite.config.ts");
  const devEnv = read(".env.development");
  assert.match(devEnv, /^VITE_C3_KB_BINDING_DEV_ENABLED=true$/m);
  assert.match(devEnv, /^C3_KB_BINDING_DEV_ENABLED=true$/m);
  assert.doesNotMatch(devEnv, /^C3_KB_BINDING_INVITES_ENABLED=true$/m);
  assert.match(vite, /import \{ loadEnv, type ConfigEnv \} from "vite"/);
  assert.match(vite, /kbBindingPrivateServerEnabled = environment\.mode === "development"/);
  assert.match(vite, /loadEnv\(environment\.mode, process\.cwd\(\), "C3_KB_BINDING_DEV_ENABLED"\)/);
  assert.match(vite, /"process\.env\.C3_KB_BINDING_DEV_ENABLED": JSON\.stringify\(kbBindingPrivateServerEnabled \? "true" : "false"\)/);
  assert.doesNotMatch(vite, /envPrefix\s*:/);
  assert.match(handler, /process\.env\.C3_KB_BINDING_DEV_ENABLED !== "true"/);
  assert.match(handler, /isKBDevHost\(new URL\(request\.url\)\.host, true\)/);
  assert.match(handler, /context\.userId/);
});

test("one-screen account invite and Singapore KB company_id/key remain visible and fail closed", () => {
  assert.match(route, /1\. AI Chatbot login account and authorized Company/);
  assert.match(route, /2\. Singapore KB company_id and API Key/);
  assert.match(route, /One-page setup:/);
  assert.match(route, /Select a server-verified Company in step 1/);
  assert.doesNotMatch(route, /\{current && <section style=\{boxStyle\}>\s*<h2[^>]*>2\. Singapore KB/);
  assert.match(route, /id="kb-tenant-input"[^\n]*disabled=\{!current \|\| phase !== "ready" \|\| Boolean\(action\)\}/);
  assert.match(route, /id="kb-key-input"[^\n]*disabled=\{!current \|\| phase !== "ready" \|\| Boolean\(action\)\}/);
  assert.match(route, /id="kb-key-input"[^\n]*type="password"/);
  assert.match(route, /!verifiedLogin/);
  assert.match(route, /Company UUID, not to an email/);
  assert.match(route, /The account invitation and binding save are separate governed actions/);
  assert.match(handler, /middleware\(\[requireSupabaseAuth\]\)/);
  assert.match(handler, /\.eq\("is_active", true\)\.eq\("role", "admin"\)/);
  assert.doesNotMatch(route, /localStorage\.setItem\(/);
});

test("Company selector recovers read-only actual RLS scope on server transport failure", () => {
  const service = read("src/lib/api/kbBinding.service.ts");
  assert.match(service, /export async function listAuthorizedCompanyScopesReadOnly/);
  assert.match(service, /supabase\.auth\.getUser\(\)/);
  assert.match(service, /\.from\("user_roles"\)/);
  assert.match(service, /\.from\("company_membership"\)/);
  assert.match(service, /\.eq\("user_id", actorId\)/);
  assert.match(service, /\.eq\("role", "admin"\)\.eq\("is_active", true\)/);
  assert.match(service, /\.from\("company"\)/);
  assert.match(service, /\.from\("channel_config"\)/);
  assert.doesNotMatch(service.slice(service.indexOf("export async function listAuthorizedCompanyScopesReadOnly")), /\.from\("company_kb_tenant_binding"\)/);
  assert.match(route, /scopes = await kbDevBindingService\.listAuthorizedCompanyScopesReadOnly\(\)/);
  assert.match(route, /setPhase\("read_only"\)/);
  assert.match(route, /phase === "read_only"/);
  assert.match(route, /disabled=\{phase !== "ready" \|\| Boolean\(action\)/);
  assert.match(route, /disabled=\{!current \|\| phase !== "ready"/);
  assert.match(route, /Binding metadata and other members have NOT been read/);
  assert.match(route, /Stored Key, Revision and mapping state: Not loaded/);
});


const bootstrapDDL = read("supabase/migrations/20261111183000_task3c_dev_kb_bootstrap.sql");
const bootstrapRollback = read("supabase/migrations/rollback/20261111183000_task3c_dev_kb_bootstrap.rollback.sql");
test("private KB tenant bootstrap is one atomic existing Supabase transaction", () => {
  const service = read("src/lib/api/kbBinding.service.ts");
  assert.match(bootstrapDDL, /CREATE FUNCTION public\.kb_binding_dev_bootstrap_v1/);
  assert.match(bootstrapDDL, /SECURITY DEFINER SET search_path = ''/);
  assert.match(bootstrapDDL, /p_actor <> '3bdf936e-b543-41d8-9fff-fa020a85f3f6'::uuid/);
  assert.match(bootstrapDDL, /pg_advisory_xact_lock\(5026111150\)/);
  assert.match(bootstrapDDL, /p_request_id::text/);
  assert.match(bootstrapDDL, /KB_DEV_BOOTSTRAP_TARGET_ALREADY_SCOPED_OR_INVALID/);
  assert.match(bootstrapDDL, /KB_DEV_BOOTSTRAP_TENANT_ALREADY_BOUND/);
  assert.match(bootstrapDDL, /INSERT INTO public\.company\(/);
  assert.match(bootstrapDDL, /INSERT INTO public\.user_roles\(/);
  assert.match(bootstrapDDL, /INSERT INTO public\.company_membership\(/);
  assert.match(bootstrapDDL, /INSERT INTO public\.widget_config\(/);
  assert.match(bootstrapDDL, /INSERT INTO public\.channel_config\(/);
  assert.match(bootstrapDDL, /vault\.create_secret\(p_new_key/);
  assert.match(bootstrapDDL, /INSERT INTO public\.company_kb_tenant_binding/);
  assert.match(bootstrapDDL, /REVOKE ALL ON FUNCTION public\.kb_binding_dev_bootstrap_v1[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(bootstrapDDL, /GRANT EXECUTE ON FUNCTION public\.kb_binding_dev_bootstrap_v1[\s\S]*TO service_role/);
  assert.doesNotMatch(bootstrapDDL, /VALUES\(v_company,p_actor,'admin'/);
  assert.doesNotMatch(bootstrapDDL, /DELETE FROM auth\.users|DROP TABLE/);
  assert.match(bootstrapRollback, /ROLLBACK_HAS_REAL_TENANT_SAFE_STOP/);
  assert.doesNotMatch(bootstrapRollback, /DELETE FROM|DROP TABLE|DROP SCHEMA/);
  assert.match(service, /bootstrapKBDevCompanyFn = createServerFn/);
  assert.match(service, /\.middleware\(\[requireSupabaseAuth\]\)\.inputValidator\(bootstrapInput\)/);
  assert.match(service, /dev_bootstrap_owner_only/);
  assert.match(service, /C3_KB_BINDING_INVITES_ENABLED !== "true"/);
  assert.match(service, /auth\.admin\.createUser/);
  assert.match(service, /email_confirm: true/);
  assert.match(service, /kb_binding_dev_bootstrap_v1/);
  assert.match(service, /auth_created_company_transaction_failed_retry_same_email/);
  assert.match(service, /createOrLinkKBDevTestAccountFn/);
  assert.match(service, /kb_binding_invite_grant_v1/);
});
test("same page provides existing Company accounts and new independent tenants safely", () => {
  const source = read("src/routes/_authenticated/console.settings.kb-binding.tsx");
  assert.match(source, /New independent KB tenant — one-page setup/);
  assert.match(source, /Create \/ link test account in THIS Company/);
  assert.match(source, /Create independent Company \+ Admin \+ Widget \+ KB binding/);
  assert.match(source, /id="kb-test-password"[^\\n]*type="password"/);
  assert.match(source, /id="new-kb-key"[^\\n]*type="password"/);
  assert.match(source, /bootstrapDevTenant\(/);
  assert.match(source, /createOrLinkTestAccount\(/);
  assert.match(source, /crypto\.randomUUID\(\)/);
  assert.match(source, /setNewKey\(""\)/);
  assert.match(source, /phase !== "ready"/);
  assert.match(source, /original Frankie Company\/KB34 is never modified/);
  assert.doesNotMatch(source, /localStorage\.setItem\(/);
});


test("binding list uses canonical authenticated RLS instead of requiring privileged Admin read", () => {
  const source = read("src/lib/api/kbBinding.service.ts");
  const list = source.slice(source.indexOf("export const listKBDevBindingsFn"),
    source.indexOf("const writeInput ="));
  assert.match(list, /\.middleware\(\[requireSupabaseAuth\]\)/);
  assert.match(list, /ownAdminCompanies\(\{ supabase: context\.supabase/);
  assert.match(list, /await context\.supabase\s*\.from\("company_kb_tenant_binding"\)/);
  assert.match(list, /\.select\("company_id,kb_tenant_id,kb_company_id,is_active,revision,updated_at"\)/);
  assert.doesNotMatch(list, /\.select\("[^"]*api_key_secret_ref/);
  assert.doesNotMatch(list, /vault\.decrypted_secrets/);
  assert.match(list, /writerReady = false/);
  assert.match(list, /if \(!writerError\) \{/);
  assert.match(list, /catch \{ \/\* The credential name\/value\/exception is never returned/);
  assert.match(list, /has_key: b\?\.is_active === true, writer_ready: writerReady/);
  assert.match(source, /writer_ready: false/);
});

test("service-role client is server-only and uses only managed server key aliases", () => {
  const source = read("src/lib/api/kbBinding.service.ts");
  assert.match(source, /if \(typeof window !== "undefined"\) throw new Error\("kb_admin_server_only"\)/);
  assert.match(source, /process\.env\.SUPABASE_SECRET_KEY \|\|/);
  assert.match(source, /process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(source, /process\.env\.VITE_SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(source, /assertAuthoritativeSupabaseRuntime\(authority\.url, authority\.projectId\)/);
  assert.match(source, /persistSession: false, autoRefreshToken: false/);
  assert.match(source, /const supabaseAdmin = await kbBindingAdminClient\(\)/);
  assert.match(source, /protected_kb_writer_unavailable/);
  assert.match(source, /p_actor: String\(context\.userId\)/);
  assert.match(source, /p_expected_revision: data\.expected_revision/);
  assert.match(source, /p_new_key: data\.api_key \?\? null/);
  assert.match(source, /supabase\.auth\.getUser\(\)/);
  assert.match(source, /member\.user_id === data\.user!\.id/);
});

test("numeric KB input can render after authenticated RLS read, Save needs real writer proof", () => {
  const route = read("src/routes/_authenticated/console.settings.kb-binding.tsx");
  assert.match(route, /Company\/KB metadata is verified through your real Supabase Auth/);
  assert.match(route, /The protected server writer is unavailable/);
  assert.match(route, /disabled=\{!current \|\| phase !== "ready" \|\| Boolean\(action\)\}/);
  assert.match(route, /disabled=\{!current \|\| phase !== "ready" \|\| !current\?\.writer_ready/);
  assert.match(route, /!current\.writer_ready/);
  assert.match(route, /inputMode="numeric"/);
  assert.match(route, /type="password" value=\{key\}/);
  assert.match(route, /isOriginalDevOwner && <section style=\{boxStyle\}>/);
  assert.match(route, /actorId === "3bdf936e-b543-41d8-9fff-fa020a85f3f6"/);
  assert.match(route, /Inactive; key presence is not exposed/);
  assert.doesNotMatch(route, /localStorage\.setItem\(/);
});
