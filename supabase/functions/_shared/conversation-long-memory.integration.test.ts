import {
  buildBoundedConversationContext,
  buildCanonicalConversationMemory,
  buildConversationMemoryMarkdown,
  refreshConversationLongMemory,
  type CanonicalConversationMemory,
} from "./conversation-long-memory.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

const conversationId = "10000000-0000-4000-8000-000000000001";
const companyId = "10000000-0000-4000-8000-000000000002";
const sourceMessageId = "10000000-0000-4000-8000-000000000003";

function prior(): CanonicalConversationMemory {
  return buildCanonicalConversationMemory({
    conversation_id: conversationId, company_id: companyId, source_message_id: sourceMessageId,
    commerce_state_revision: 1, commerce_state: createEmptyConversationCommerceState(),
    newest_first: [{ role: "visitor", content: "300 SKU" }], visitor_turn_count: 1,
    source_created_at: "2026-09-15T00:00:00Z", next_memory_revision: 1,
  });
}

class MockClient {
  existing: any = null;
  rpcResult: any = { result: "success", current_revision: 1, idempotent: false };
  rpcResults: any[] = [];
  rpcError: unknown = null;
  calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  from(table: string) {
    const chain: any = {
      select() { return chain; }, eq() { return chain; },
      maybeSingle: async () => ({ data: table === "conversation_memory_state" ? this.existing : null, error: null }),
    };
    return chain;
  }
  async rpc(fn: string, params: Record<string, unknown>) {
    this.calls.push({ fn, params });
    return { data: this.rpcResults.length ? this.rpcResults.shift() : this.rpcResult, error: this.rpcError };
  }
}

function input() {
  return {
    conversation_id: conversationId, company_id: companyId, source_message_id: sourceMessageId,
    source_created_at: "2026-09-15T00:00:00Z", commerce_state_revision: 1,
    commerce_state: createEmptyConversationCommerceState(),
    newest_first: [{ role: "visitor", content: "Current main market Hong Kong" }], visitor_turn_count: 1,
  };
}

Deno.test("integration commits memory through one guarded RPC", async () => {
  const client = new MockClient();
  const result = await refreshConversationLongMemory(client as any, input());
  assert(result.ok, "commit failed");
  equal(client.calls.length, 1, "RPC count");
  equal(client.calls[0].fn, "c3_commit_conversation_memory_tx", "RPC name");
});

Deno.test("integration binds exact tenant conversation source and commerce revision", async () => {
  const client = new MockClient();
  await refreshConversationLongMemory(client as any, input());
  const params = client.calls[0].params;
  equal(params.p_conversation_id, conversationId, "conversation");
  equal(params.p_company_id, companyId, "company");
  equal(params.p_source_message_id, sourceMessageId, "source");
  equal(params.p_expected_commerce_revision, 1, "commerce revision");
});

Deno.test("integration reuses same-source current memory idempotently", async () => {
  const client = new MockClient();
  const memory = prior();
  client.existing = { conversation_id: conversationId, company_id: companyId, revision: 1, source_message_id: sourceMessageId, memory, markdown_projection: buildConversationMemoryMarkdown(memory), memory_hash: "a".repeat(64) };
  const result = await refreshConversationLongMemory(client as any, input());
  assert(result.ok && result.idempotent, "same source not idempotent");
  equal(client.calls.length, 0, "idempotent path wrote");
});

Deno.test("integration rejects stale commerce result without pretending success", async () => {
  const client = new MockClient();
  client.rpcResult = { result: "stale_commerce_revision", current_revision: 2 };
  const result = await refreshConversationLongMemory(client as any, input());
  assert(!result.ok && result.reason === "stale_commerce_revision", "stale accepted");
});

Deno.test("integration rejects superseded source without persistence success", async () => {
  const client = new MockClient();
  client.rpcResult = { result: "superseded_source" };
  const result = await refreshConversationLongMemory(client as any, input());
  assert(!result.ok && result.reason === "superseded_source", "superseded accepted");
});

Deno.test("integration rejects memory revision conflict", async () => {
  const client = new MockClient();
  client.rpcResult = { result: "revision_conflict", actual_revision: 4 };
  const result = await refreshConversationLongMemory(client as any, input());
  assert(!result.ok && result.reason === "revision_conflict", "revision conflict accepted");
});

Deno.test("integration retries one fresh revision conflict and succeeds", async () => {
  const client = new MockClient();
  client.rpcResults = [
    { result: "revision_conflict", actual_revision: 1 },
    { result: "success", current_revision: 1, idempotent: false },
  ];
  const result = await refreshConversationLongMemory(client as any, input());
  assert(result.ok, "fresh retry did not succeed");
  equal(client.calls.length, 2, "retry count");
});

Deno.test("integration fails safely on transport error", async () => {
  const client = new MockClient();
  client.rpcError = new Error("offline");
  const result = await refreshConversationLongMemory(client as any, input());
  assert(!result.ok && result.reason === "memory_commit_transport", "transport error accepted");
});

Deno.test("integration chain feeds structured memory plus bounded recent turns", () => {
  const memory = prior();
  const context = buildBoundedConversationContext(memory, [{ role: "visitor", content: "What about it?" }]);
  assert(context.block.includes("Canonical structured conversation memory"), "memory not in context");
  assert(context.block.includes("Recent raw turns"), "recent nuance not in context");
});

Deno.test("handoff projection and generation context share one memory state", () => {
  const memory = prior();
  const markdown = buildConversationMemoryMarkdown(memory);
  const context = buildBoundedConversationContext(memory, []);
  assert(context.block.includes(markdown), "projection divergence");
});

Deno.test("generate-reply integration stays after A3 and before B2 generation commit", async () => {
  const source = await Deno.readTextFile(new URL("../generate-reply/index.ts", import.meta.url));
  const commerce = source.indexOf("runCommerceStateRuntime(");
  const memory = source.indexOf("refreshConversationLongMemory(");
  const finalPrompt = source.indexOf("let finalSystemPrompt", memory);
  const finalB2 = source.lastIndexOf("commitAiReplyWithControlGate(");
  assert(commerce >= 0 && memory > commerce && finalPrompt > memory && finalB2 > finalPrompt, "runtime seam order invalid");
});

Deno.test("agent-assist prefers persisted C2 and exposes tenant-bound C3 memory", async () => {
  const source = await Deno.readTextFile(new URL("../agent-assist/index.ts", import.meta.url));
  assert(source.lastIndexOf("parsePersistedC2Handoff") < source.lastIndexOf("persisted_c2"), "persisted C2 preference removed");
  assert(/\.eq\(\s*"company_id",\s*companyId,?\s*\)/.test(source), "memory tenant binding missing");
  assert(/conversation_memory:\s*c3Memory/.test(source), "C3 assist context missing");
});

Deno.test("CE functions are not memory writers", async () => {
  for (const path of ["../ce-evaluation-worker/index.ts", "../conversation-evaluate/index.ts"]) {
    const source = await Deno.readTextFile(new URL(path, import.meta.url));
    assert(!source.includes("c3_commit_conversation_memory_tx"), `${path} writes memory`);
  }
});
