#!/usr/bin/env node
// Real local GoTrue sessions, local PostgREST, the actual Widget page and
// TanStack server function. No production network binding or service key in UI.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const origin = process.env.C3_LOCAL_SUPABASE_URL;
const anon = process.env.C3_LOCAL_SUPABASE_ANON_KEY;
const service = process.env.C3_LOCAL_SUPABASE_SERVICE_ROLE_KEY;
const database = process.env.C3_LOCAL_AUTH_DB_URL;
assert.match(origin ?? "", /^http:\/\/(?:127\.0\.0\.1|localhost):54321$/);
assert.match(database ?? "", /^postgres(?:ql)?:\/\/[^\s]*@(?:127\.0\.0\.1|localhost):54322\//);
assert(anon && service && anon !== service, "missing or reused local Auth keys");
const emailDomain = "c3.local.test";
const password = "C3-isolated-auth-test-2026!";
const admin = createClient(origin, service, { auth: { persistSession: false } });
const users = {};
for (const kind of ["owner", "agent", "outsider"]) {
  const email = `${kind}@${emailDomain}`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`local Auth creation failed: ${kind}: ${error?.message}`);
  users[kind] = { email, id: data.user.id };
}
const seed = spawnSync("psql", [database, "-X", "-v", "ON_ERROR_STOP=1",
  "-v", `owner_id=${users.owner.id}`, "-v", `agent_id=${users.agent.id}`,
  "-v", `outsider_id=${users.outsider.id}`, "-f",
  "sql/c3-nonproduction/07_director_widget_auth_seed.sql"], { stdio: "inherit", timeout: 60000 });
if (seed.status !== 0) throw new Error(`local Widget seed failed: ${seed.status}`);

const port = 43177;
const appOrigin = `http://127.0.0.1:${port}`;
const server = spawn("./node_modules/.bin/vite", ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  env: { ...process.env, NODE_ENV: "development", C3_ISOLATED_BROWSER_AUTH: "local-only",
    VITE_C3_LOCAL_SUPABASE_URL: origin, VITE_C3_LOCAL_SUPABASE_ANON_KEY: anon },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
for (const stream of [server.stdout, server.stderr]) stream.on("data", (buffer) => {
  serverOutput = (serverOutput + buffer.toString()).slice(-4000);
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Vite exited: ${serverOutput}`);
    try {
      const response = await fetch(`${appOrigin}/login`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) { ready = true; break; }
    } catch { /* bounded readiness retry */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert(ready, `Vite local readiness timed out: ${serverOutput}`);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const protectedRequests = [];
  page.on("response", (response) => {
    const request = response.request();
    const headers = request.headers();
    if (response.url().startsWith(appOrigin) && headers.authorization?.startsWith("Bearer ")) {
      protectedRequests.push({ endpoint: new URL(response.url()).pathname, status: response.status(),
        url: response.url() }); // Never log Authorization or session.
    }
  });
  await page.goto(`${appOrigin}/login?redirect=%2Fconsole%2Fwidget-preview`);
  await page.locator("#email").fill(users.owner.email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Widget Preview" }).waitFor({ timeout: 30000 });
  await page.getByText("C3 owned channel").first().waitFor({ timeout: 30000 });
  assert(!(await page.getByText("Config: Unauthorized: Invalid token").count()), "Widget token failure persists");
  const config = protectedRequests.find((r) => r.status === 200);
  assert(config, `no authorized Widget config request: ${JSON.stringify(protectedRequests)}`);
  let refreshCalls = 0;
  page.on("request", (request) => {
    if (request.url().startsWith(`${origin}/auth/v1/token`) &&
      request.url().includes("grant_type=refresh_token")) refreshCalls++;
  });
  const expirySet = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((item) => item.endsWith("-auth-token"));
    if (!key) return false;
    const session = JSON.parse(localStorage.getItem(key) || "null");
    if (!session?.refresh_token) return false;
    session.expires_at = 1;
    session.expires_in = 1;
    session.access_token = "expired-local-session";
    localStorage.setItem(key, JSON.stringify(session));
    return true;
  });
  assert(expirySet, "browser session storage unavailable for refresh test");
  await page.reload();
  await page.getByText("C3 owned channel").first().waitFor({ timeout: 30000 });
  assert(refreshCalls >= 1 && refreshCalls <= 2, `session refresh count ${refreshCalls}`);
  const ownerAuth = createClient(origin, anon, { auth: { persistSession: false } });
  const { data: ownerLogin, error: loginError } = await ownerAuth.auth.signInWithPassword({
    email: users.owner.email, password });
  assert(!loginError && ownerLogin.session, "test issuer did not provide an owner JWT");
  const history = await fetch(`${origin}/functions/v1/widget-live-ai-test`, {
    method: "POST", headers: { apikey: anon,
      Authorization: `Bearer ${ownerLogin.session.access_token}`,
      Origin: appOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "history" }), signal: AbortSignal.timeout(30000),
  });
  const historyBody = await history.json();
  assert(history.status === 200 && historyBody.success === true &&
    Array.isArray(historyBody.history), `Live AI Test shared Auth path failed: HTTP ${history.status}`);
  const invalid = await fetch(config.url, { headers: { Authorization: "Bearer invalid-local-token" } });
  assert(invalid.status >= 400, `invalid token accepted with HTTP ${invalid.status}`);
  const agentAuth = createClient(origin, anon, { auth: { persistSession: false } });
  const { data: agentLogin, error: agentError } = await agentAuth.auth.signInWithPassword({
    email: users.agent.email, password });
  assert(!agentError && agentLogin.session, "agent session absent");
  const denied = await fetch(config.url, { headers: { Authorization: `Bearer ${agentLogin.session.access_token}` } });
  const deniedBody = await denied.text();
  assert(!deniedBody.includes("C3 owned channel") && deniedBody.includes("forbidden"),
    `same tenant agent read config: HTTP ${denied.status}`);
  const foreign = await fetch(`${origin}/rest/v1/channel_config?select=id&id=eq.dddddddd-dddd-4ddd-8ddd-dddddddddddd`, {
    headers: { apikey: anon, Authorization: `Bearer ${ownerLogin.session.access_token}` },
  });
  assert(foreign.status === 200 && (await foreign.json()).length === 0,
    `cross tenant RLS returned a channel: HTTP ${foreign.status}`);
  assert(!(await page.getByText("Other tenant channel").count()), "cross tenant data on Widget page");
  const exposed = await page.evaluate((key) => document.documentElement.outerHTML.includes(key), service);
  assert(!exposed, "service role key appeared in browser DOM");
  console.log(JSON.stringify({ assertion: "isolated_Widget_Auth", endpoint: config.endpoint,
    authorized_status: config.status, invalid_status: invalid.status,
    agent_status: denied.status, cross_tenant_status: foreign.status,
    refresh_calls: refreshCalls, live_test_history_status: history.status }));
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
