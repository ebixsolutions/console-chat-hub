import {
  callModel,
  type LlmCall,
} from "../../supabase/functions/_shared/llm-router.ts";
import {
  prepareRemoteRetrieval,
  remoteAccountingAction,
  signRemote,
} from "../../supabase/functions/_shared/remote-model-accounting.ts";
function assert(v: unknown, m = "assertion"): asserts v {
  if (!v) throw Error(m);
}
Deno.test("actual router generation/semantic/assist/evaluation/retries + denial suppresses provider", async () => {
  const old = globalThis.fetch;
  const env = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "LLM_PROVIDER",
    "ANTHROPIC_API_KEY",
    "LLM_MODEL_GENERATION",
    "LLM_MODEL_ASSIST",
    "LLM_MODEL_EVALUATION",
  ];
  const previous = env.map((x) => Deno.env.get(x));
  const values = [
    "http://accounting.mock",
    "mock-service-key",
    "anthropic",
    "mock-provider-key",
    "mock-generation",
    "mock-assist",
    "mock-eval",
  ];
  env.forEach((x, i) => Deno.env.set(x, values[i]));
  let count = 0, providers = 0, attempts = 0;
  const ids = new Set();
  const events: string[] = [];
  let deny = false;
  let retry = true;
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes("/rpc/c3_reserve")) {
      events.push("reserve");
      if (deny) return Response.json({ message: "limit" }, { status: 400 });
      if (ids.has(body.p_identity)) {
        return Response.json({
          scoped: true,
          dispatch: false,
          run_id: "run",
          state: "response",
        });
      }
      ids.add(body.p_identity);
      count++;
      return Response.json({
        scoped: true,
        dispatch: true,
        run_id: "run",
        state: "reserved",
      });
    }
    if (url.includes("/rpc/c3_finalize")) {
      events.push("finalize");
      return Response.json({ state: body.p_state });
    }
    if (url.includes("upstream_call_log")) {
      return new Response(null, { status: 201 });
    }
    assert(
      url === "https://api.anthropic.com/v1/messages",
      "uncontrolled network",
    );
    events.push("provider");
    providers++;
    attempts++;
    if (retry) {
      retry = false;
      return new Response("", { status: 503 });
    }
    return Response.json({
      content: [{ type: "text", text: '{"ok":true}' }],
      usage: { input_tokens: 5, output_tokens: 3 },
      stop_reason: "end_turn",
    });
  };
  const common: LlmCall = {
    purpose: "generation",
    system: "safe",
    user: "hello",
    maxTokens: 20,
    companyId: "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec",
    conversationId: "22222222-2222-4222-8222-222222222222",
    operationId: "op",
    tag: "generation",
    responseFormat: "json",
  };
  try {
    for (
      const [purpose, tag] of [
        ["generation", "generation"],
        ["generation", "commerce-semantic"],
        ["assist", "agent-assist"],
        ["evaluation", "ce:evaluator"],
        ["assist", "kb-query-expansion"],
      ] as const
    ) {
      const result = await callModel({
        ...common,
        purpose,
        tag,
        operationId: tag,
      });
      assert(result.ok);
      assert(result.usage.attempts === (tag === "generation" ? 2 : 1));
    }
    assert(count === 6 && providers === 6);
    assert(
      events.filter((x) => x === "provider").every((_, i) =>
        events.indexOf("reserve") >= 0
      ),
    );
    deny = true;
    const result = await callModel({ ...common, operationId: "denied" });
    assert(
      !result.ok && result.code === "LLM_ACCOUNTING_DENIED" &&
        result.usage.attempts === 0,
    );
    assert(providers === 6);
    for (let i = 0; i < events.length; i++) {
      if (events[i] === "provider") assert(events[i - 1] === "reserve");
    }
  } finally {
    globalThis.fetch = old;
    env.forEach((x, i) =>
      previous[i] === undefined
        ? Deno.env.delete(x)
        : Deno.env.set(x, previous[i]!)
    );
  }
});
Deno.test("remote ordinary retrieval attestation does not reserve/count a model; unknown is denied", async () => {
  const company = "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec",
    secret = "mock-tenant-key";
  let calls = 0;
  const up: typeof fetch = async (_input, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    const scope = JSON.parse(headers.get("x-c3-accounting-scope")!);
    const text = JSON.stringify({
      ...scope,
      protocol: "c3-shared-attempt-v1",
      mode: "retrieval_only",
      runtime_sha256: "a".repeat(64),
    });
    return new Response(text, {
      headers: { "x-c3-accounting-signature": await signRemote(text, secret) },
    });
  };
  const h = await prepareRemoteRetrieval(
    company,
    "tenant",
    secret,
    "https://kb.mock/rag",
    up,
  );
  assert(calls === 1 && h["x-c3-accounting-mode"] === "retrieval_only");
  let denied = false;
  try {
    await prepareRemoteRetrieval(
      company,
      "tenant",
      secret,
      "https://kb.mock/rag",
      async () => Response.json({ mode: "unknown" }),
    );
  } catch {
    denied = true;
  }
  assert(denied);
});
Deno.test("remote callback uses shared exact run and rejects expired/foreign scope", async () => {
  const now = Math.floor(Date.now() / 1000);
  let reserves = 0;
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      assert(args.p_run_id === "a0a8c36e-42b5-4d9f-bbee-095ddc731520");
      reserves++;
      return { data: { scoped: true, dispatch: true }, error: null };
    },
  };
  const scope = {
    company: "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec",
    tenant: "mock",
    operation: "kb:op",
    expires: now + 60,
    nonce: "nonce",
  };
  await remoteAccountingAction(db, scope, {
    action: "reserve",
    identity: "a".repeat(64),
    request_sha256: "b".repeat(64),
    provider: "embedding",
  });
  assert(reserves === 1);
  for (
    const s of [
      { ...scope, expires: now - 1 },
      { ...scope, company: "other" },
      { ...scope, expires: NaN },
    ]
  ) {
    let denied = false;
    try {
      await remoteAccountingAction(db, s, {
        action: "reserve",
        identity: "a".repeat(64),
      });
    } catch {
      denied = true;
    }
    assert(denied);
  }
  assert(reserves === 1);
});
Deno.test("actual grounding verifier retry counts; cap denial propagates without model fallback", async () => {
  const old = globalThis.fetch;
  const names = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "LLM_PROVIDER",
    "ANTHROPIC_API_KEY",
    "LLM_MODEL_GENERATION",
    "LLM_MODEL_EVALUATION",
  ];
  const prev = names.map((n) => Deno.env.get(n));
  const vals = [
    "http://accounting.mock",
    "mock-service-key",
    "anthropic",
    "mock-provider-key",
    "mock-generation",
    "mock-eval",
  ];
  names.forEach((n, i) => Deno.env.set(n, vals[i]));
  try {
    for (const cap of [3, 2]) {
      let reserved = 0, providers = 0;
      const slots: string[] = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url.includes("/rpc/c3_reserve")) {
          if (reserved >= cap) {
            return Response.json({ message: "cap" }, { status: 400 });
          }
          reserved++;
          slots.push(body.p_purpose);
          return Response.json({
            scoped: true,
            dispatch: true,
            run_id: "run",
            state: "reserved",
          });
        }
        if (url.includes("/rpc/c3_finalize")) {
          return Response.json({ state: body.p_state });
        }
        if (url.includes("upstream_call_log")) {
          return new Response(null, { status: 201 });
        }
        assert(url === "https://api.anthropic.com/v1/messages");
        providers++;
        if (providers === 2) return new Response("", { status: 429 });
        return Response.json({
          content: [{
            type: "text",
            text: providers === 1 ? "可以提供保養協助。" : '{"grounded":true}',
          }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        });
      };
      const result = await callModel({
        purpose: "generation",
        system:
          "Knowledge Base grounding rules:\nFull Content Evidence:\n[chunk:chunkA]\n可以提供保養協助。",
        user: "想問保養安排",
        maxTokens: 40,
        companyId: "4e0ea9f6-11d5-4968-97f6-f0ed8bf7cfec",
        conversationId: "22222222-2222-4222-8222-222222222222",
        operationId: "verifier-" + cap,
        tag: "generation",
        responseFormat: "text",
      });
      assert(providers === cap && reserved === cap);
      assert(
        slots[0] === "generation" &&
          slots.slice(1).every((x) => x === "evaluation"),
      );
      if (cap === 3) assert(result.ok);
      else assert(!result.ok && result.code === "LLM_ACCOUNTING_DENIED");
    }
  } finally {
    globalThis.fetch = old;
    names.forEach((n, i) =>
      prev[i] === undefined ? Deno.env.delete(n) : Deno.env.set(n, prev[i]!)
    );
  }
});
