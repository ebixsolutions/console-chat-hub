import { readExactAiReplyCommit } from "./authoritative-commit-readback.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const CONVERSATION_ID = "70000000-0000-4000-8000-000000000001";
const SOURCE_ID = "70000000-0000-4000-8000-000000000002";
const MESSAGE_ID = "70000000-0000-4000-8000-000000000003";
const CONTENT = "你提供的房間面積：80平方呎、100平方呎。";

class ReceiptClient {
  reads = 0;
  constructor(
    readonly row: Record<string, unknown> | null,
    readonly error: unknown = null,
  ) {}
  from(table: string) {
    if (table !== "messages") throw new Error("unexpected_table");
    const chain: any = {
      select() {
        return chain;
      },
      eq() {
        return chain;
      },
      maybeSingle: async () => {
        this.reads += 1;
        return { data: this.row, error: this.error };
      },
    };
    return chain;
  }
}

function exactRow() {
  return {
    id: MESSAGE_ID,
    conversation_id: CONVERSATION_ID,
    role: "assistant",
    content: CONTENT,
    is_recalled: false,
    metadata: {
      source_message_id: SOURCE_ID,
      b2_source_message_id: SOURCE_ID,
      b2_commit_source: "commit_ai_reply_tx",
      b2_gate_contract: "executeB2PersistenceGate:allow_after_revalidation",
    },
  };
}

Deno.test("AI reply ack uncertainty recovers only an exact B2 commit receipt", async () => {
  const client = new ReceiptClient(exactRow());
  const receipt = await readExactAiReplyCommit(client, {
    conversation_id: CONVERSATION_ID,
    source_message_id: SOURCE_ID,
    content: CONTENT,
  });
  assert(receipt.status === "committed", JSON.stringify(receipt));
  assert(receipt.value.message_id === MESSAGE_ID, "wrong recovered message");
  assert(
    client.reads === 1,
    "exact receipt should finish the bounded readback",
  );
});

Deno.test("AI reply ack uncertainty with no exact commit remains absent and fail-closed", async () => {
  const client = new ReceiptClient(null);
  const receipt = await readExactAiReplyCommit(client, {
    conversation_id: CONVERSATION_ID,
    source_message_id: SOURCE_ID,
    content: CONTENT,
  });
  assert(receipt.status === "absent", JSON.stringify(receipt));
  assert(
    client.reads === 2,
    "negative readback was not bounded to two attempts",
  );
});

Deno.test("AI reply readback rejects a cross-source or malformed receipt", async () => {
  const row = exactRow();
  (row.metadata as Record<string, unknown>).b2_source_message_id =
    "70000000-0000-4000-8000-000000000099";
  const receipt = await readExactAiReplyCommit(new ReceiptClient(row), {
    conversation_id: CONVERSATION_ID,
    source_message_id: SOURCE_ID,
    content: CONTENT,
  });
  assert(receipt.status === "indeterminate", "mismatched receipt was accepted");
});
