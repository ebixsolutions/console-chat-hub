import { verifiedSupabaseUserId } from "../../src/integrations/supabase/verified-user.ts";
import { authorizeChannelConfigScope } from "../../src/integrations/supabase/channel-config-scope.ts";
import { withConfigSession } from "../../src/integrations/supabase/config-session-transport.ts";

function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

Deno.test("Widget server session uses authoritative getUser, never unverified JWT claims", async () => {
  let calledWith = "";
  const auth = { getUser: async (token: string) => {
    calledWith = token;
    return { data: { user: { id: "user-owned" } }, error: null };
  } };
  assert(await verifiedSupabaseUserId(auth, "valid-session") === "user-owned", "identity");
  assert(calledWith === "valid-session", "token source");
  for (const invalid of [
    { data: { user: null }, error: new Error("expired") },
    { data: { user: null }, error: null },
  ]) {
    let denied = false;
    try {
      await verifiedSupabaseUserId({ getUser: async () => invalid }, "bad-session");
    } catch (error) {
      denied = error instanceof Error && error.message === "Unauthorized: Invalid token";
    }
    assert(denied, "invalid or expired token accepted");
  }
});

Deno.test("Widget config scope requires one active tenant and an authorized role", async () => {
  const id = await verifiedSupabaseUserId({
    getUser: async () => ({ data: { user: { id: "verified-user" } }, error: null }),
  }, "valid-session");
  assert(id === "verified-user", "verified identity");
  const company = { id: "tenant-a", is_active: true };
  const owner = [{ company_id: "tenant-a", role: "admin" }];
  const supervisor = [{ company_id: "tenant-a", role: "supervisor" }];
  assert(authorizeChannelConfigScope(owner, company, ["admin", "supervisor"]).ok, "owner config denied");
  assert(authorizeChannelConfigScope(supervisor, company, ["admin", "supervisor"]).ok, "supervisor config denied");
  for (const memberships of [
    [{ company_id: "tenant-a", role: "agent" }],
    [{ company_id: "tenant-b", role: "admin" }],
    [...owner, { company_id: "tenant-b", role: "admin" }],
    [],
  ]) {
    assert(!authorizeChannelConfigScope(memberships, company, ["admin", "supervisor"]).ok, "unauthorized company or role accepted");
  }
  assert(!authorizeChannelConfigScope(owner, { ...company, is_active: false }, ["admin", "supervisor"]).ok, "inactive tenant accepted");
});

Deno.test("Widget config server function receives the live session Bearer token once", async () => {
  let reads = 0;
  const result = await withConfigSession({ getSession: async () => {
    reads++;
    return { data: { session: { access_token: "test-session" } }, error: null };
  } }, async (headers) => {
    assert(new Headers(headers).get("Authorization") === "Bearer test-session", "token not forwarded");
    return { ok: true, data: "tenant-owned-channel" };
  });
  assert(reads === 1 && result.ok, "valid session was retried or denied");
  let called = false;
  const missing = await withConfigSession({ getSession: async () => (
    { data: { session: null }, error: null }
  ) }, async () => { called = true; return { ok: true }; });
  assert(!missing.ok && !called, "unauthenticated config request transmitted");
});
