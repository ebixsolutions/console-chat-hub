import { handler } from "../../supabase/functions/model-attempt-accounting/index.ts";
import { signRemote } from "../../supabase/functions/_shared/remote-model-accounting.ts";
function assert(v: unknown): asserts v {
  if (!v) throw Error("assertion");
}
Deno.test("actual remote HTTP handler authorizes tenant/key/body; anonymous and forged paths zero reservation", async () => {
  const old = globalThis.fetch;
  const names = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "KB_SINGAPORE_TENANT_MAP_JSON",
    "KB_SINGAPORE_TENANT_API_KEYS_JSON",
  ];
  const saved = names.map((n) => Deno.env.get(n));
  const company = "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec",
    tenant = "mock",
    secret = "mock-only-existing-tenant-key-123";
  let reserves = 0;
  const vals = [
    "http://accounting.mock",
    "mock-service-key",
    JSON.stringify({ [company]: tenant }),
    JSON.stringify({ [tenant]: secret }),
  ];
  names.forEach((n, i) => Deno.env.set(n, vals[i]));
  globalThis.fetch = async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/company?")) {
      return Response.json({ id: company, is_active: true });
    }
    if (url.includes("/rpc/c3_reserve_model_attempt")) {
      reserves++;
      return Response.json({
        scoped: true,
        dispatch: true,
        run_id: "a0a8c36e-42b5-4d9f-bbee-095ddc731520",
        state: "reserved",
      });
    }
    throw Error("uncontrolled network");
  };
  try {
    const raw = JSON.stringify({
      company,
      tenant,
      operation: "kb:11111111-1111-4111-8111-111111111111",
      expires: Math.floor(Date.now() / 1000) + 60,
      nonce: "nonce",
    });
    const body = JSON.stringify({
      action: "reserve",
      identity: "a".repeat(64),
      request_sha256: "b".repeat(64),
      provider: "embedding",
    });
    const headers = {
      "x-c3-accounting-scope": raw,
      "x-c3-accounting-signature": await signRemote(raw, secret),
      "x-c3-accounting-body-signature": await signRemote(
        raw + "\n" + body,
        secret,
      ),
    };
    const url = "http://local.test/accounting";
    assert(
      (await handler(new Request(url, { method: "POST", headers, body })))
        .status === 200,
    );
    assert(reserves === 1);
    for (
      const changed of [
        { ...headers, "x-c3-accounting-signature": "0".repeat(64) },
        { ...headers, "x-c3-accounting-body-signature": "0".repeat(64) },
        { ...headers, "x-c3-accounting-scope": raw.replace(tenant, "foreign") },
        {},
      ]
    ) {
      assert(
        (await handler(
          new Request(url, { method: "POST", headers: changed, body }),
        )).status === 403,
      );
    }
    assert(reserves === 1);
    assert((await handler(new Request(url))).status === 405);
  } finally {
    globalThis.fetch = old;
    names.forEach((n, i) =>
      saved[i] === undefined ? Deno.env.delete(n) : Deno.env.set(n, saved[i]!)
    );
  }
});
