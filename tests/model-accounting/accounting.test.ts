import {
  accountedModelFetch,
  type AccountingRpc,
  ModelAccountingError,
  type ModelAttempt,
} from "../../supabase/functions/_shared/model-attempt-accounting.ts";
function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw Error(m);
}
function ledger(
  cap = 3,
): { db: AccountingRpc; entries: Map<string, any>; used: () => number } {
  let used = 0;
  const entries = new Map<string, any>();
  const db: AccountingRpc = {
    rpc: async (name, p) => {
      if (name === "c3_reserve_model_attempt") {
        const id = String(p.p_identity);
        const old = entries.get(id);
        if (old) {
          return {
            data: {
              scoped: true,
              dispatch: false,
              run_id: "run",
              state: old.state,
            },
            error: null,
          };
        }
        if (used >= cap) return { data: null, error: { code: "limit" } };
        used++;
        entries.set(id, { state: "reserved" });
        return {
          data: {
            scoped: true,
            dispatch: true,
            run_id: "run",
            state: "reserved",
          },
          error: null,
        };
      }
      const row = entries.get(String(p.p_identity));
      row.state = p.p_state;
      return { data: { state: p.p_state }, error: null };
    },
  };
  return { db, entries, used: () => used };
}
const base: ModelAttempt = {
  companyId: "company",
  conversationId: "conversation",
  operationId: "op",
  provider: "mock",
  purpose: "generation",
  slot: "generation",
  attempt: 1,
  request: "request",
};
Deno.test("sequential cap / at limit / one above / no provider dispatch on denial", async () => {
  const l = ledger();
  let calls = 0;
  const up = async () => {
    calls++;
    return new Response("ok");
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    await accountedModelFetch(
      l.db,
      { ...base, attempt },
      "https://mock.test",
      {},
      up,
    );
  }
  let denied = false;
  try {
    await accountedModelFetch(
      l.db,
      { ...base, attempt: 4 },
      "https://mock.test",
      {},
      up,
    );
  } catch (e) {
    denied = e instanceof ModelAccountingError;
  }
  assert(denied && l.used() === 3 && calls === 3);
});
Deno.test("idempotent replay cannot re-dispatch; distinct retry/fallback identities count", async () => {
  const l = ledger(5);
  let calls = 0;
  const up = async () => {
    calls++;
    return new Response("ok");
  };
  await accountedModelFetch(l.db, base, "https://mock.test", {}, up);
  try {
    await accountedModelFetch(l.db, base, "https://mock.test", {}, up);
  } catch (e) {
    assert(e instanceof ModelAccountingError);
  }
  await accountedModelFetch(
    l.db,
    { ...base, attempt: 2 },
    "https://mock.test",
    {},
    up,
  );
  await accountedModelFetch(
    l.db,
    { ...base, provider: "fallback" },
    "https://mock.test",
    {},
    up,
  );
  assert(calls === 3 && l.used() === 3);
});
Deno.test("timeout/network unknown keeps consumed reservation; never releases", async () => {
  const l = ledger(1);
  try {
    await accountedModelFetch(l.db, base, "https://mock.test", {}, async () => {
      throw new DOMException("timeout", "AbortError");
    });
  } catch {}
  assert(l.used() === 1 && [...l.entries.values()][0].state === "unknown");
});
Deno.test("accounting unavailable fails closed before upstream", async () => {
  let calls = 0;
  const db: AccountingRpc = {
    rpc: async () => {
      throw Error("offline");
    },
  };
  try {
    await accountedModelFetch(db, base, "https://mock.test", {}, async () => {
      calls++;
      return new Response();
    });
  } catch (e) {
    assert(e instanceof ModelAccountingError);
  }
  assert(calls === 0);
});
Deno.test("finalization unavailable retains reservation and prohibits fallback in same chain", async () => {
  const l = ledger(3);
  const db: AccountingRpc = {
    rpc: (n, p) =>
      n.includes("finalize")
        ? Promise.reject(Error("offline"))
        : l.db.rpc(n, p),
  };
  let error: unknown;
  try {
    await accountedModelFetch(
      db,
      base,
      "https://mock.test",
      {},
      async () => new Response(),
    );
  } catch (e) {
    error = e;
  }
  assert(
    error instanceof ModelAccountingError &&
      error.code === "MODEL_ACCOUNTING_FINALIZATION_UNAVAILABLE",
  );
  assert(l.used() === 1 && [...l.entries.values()][0].state === "reserved");
});
Deno.test("all purpose slots share the same run-wide ledger", async () => {
  const l = ledger(8);
  let calls = 0;
  for (
    const purpose of [
      "generation",
      "semantic",
      "grounding",
      "retry",
      "fallback",
      "assist",
      "evaluation",
      "kb_downstream",
    ]
  ) {
    await accountedModelFetch(
      l.db,
      { ...base, purpose, slot: purpose },
      "https://mock.test",
      {},
      async () => {
        calls++;
        return new Response();
      },
    );
  }
  assert(l.used() === 8 && calls === 8);
});
