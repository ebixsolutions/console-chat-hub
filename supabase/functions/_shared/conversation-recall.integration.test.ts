/** Offline integration against frozen B2 and the real runtime source. No live API calls. */
import {
  evaluateB2BeforeCommit,
  executeB2PersistenceGate,
} from "./pre-send-conversion-supervisor.ts";
import {
  prepareConversationRecall,
  resolveConversationRecall,
} from "./conversation-recall.ts";
import {
  recallFixture,
  t17ProductionFailureFixture,
} from "./conversation-recall.test.ts";
import {
  buildCommerceEntityHints,
  reduceTurn,
} from "./commerce-state-runtime.ts";
import { createEmptyConversationCommerceState } from "./commerce-state-contract.ts";

function assert(v: unknown, m = "assertion failed"): asserts v {
  if (!v) throw new Error(m);
}

const canonicalTurns1To17 = [
  "Hi，想問冷氣，兩間房加個廳，唔知買咩匹數好。",
  "兩間房大概80呎同100呎，廳180呎，全部窗口位，本身都係窗口機。",
  "細房應該1匹，大房同廳我唔知。",
  "我唔想太貴，格力、美的、Panasonic都得。",
  "仲有呀，我屋企下午西斜得幾勁。",
  "你而家記得我要幾多部冷氣？",
  "先唔好理個廳，我想問細房有冇1匹窗口變頻。",
  "Panasonic有冇？",
  "如果產品頁有機價，係咪即係包安裝？",
  "哦，即係機價同安裝要分開確認啦。",
  "我之前問你同事，佢話格力 GWF12P $5788，安裝550，鋁架550。",
  "之後胡小姐又話如果兩部可以5600一部。",
  "咁兩部連安裝同架，按我頭先提供嘅舊報價計幾錢？",
  "等等，我而家可能唔係兩部匹半喎。",
  "改做一部1匹，一部1.5匹。",
  "客廳嗰部暫時唔買住。",
  "咁我而家實際買幾多部冷氣？",
] as const;

Deno.test("C3 exact canonical turn 17 supersedes the tentative correction before B2", () => {
  let state = createEmptyConversationCommerceState();
  for (let index = 0; index < canonicalTurns1To17.length; index++) {
    const text = canonicalTurns1To17[index];
    state = reduceTurn(state, {
      conversation_id: "17000000-0000-4000-8000-000000000001",
      company_id: "17000000-0000-4000-8000-000000000002",
      source_message_id: `17000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      text,
      language: "zh-TW",
      history: canonicalTurns1To17.slice(0, index).reverse().map((content) => ({
        role: "visitor",
        content,
      })),
    }, buildCommerceEntityHints([
      text,
      ...canonicalTurns1To17.slice(0, index).reverse(),
    ]));
  }
  assert(
    state.latest_corrections.at(-1)?.startsWith("改做一部1匹") === true,
    JSON.stringify(state.latest_corrections),
  );

  // The production semantic frame resolves the two active room entities; this
  // assertion targets the B2 classification that previously rejected that
  // already-resolved canonical answer because turn 14 remained ledger-latest.
  const active = state.entities[0];
  assert(active, "missing active entity");
  active.quantity = 2;
  state.entities.push({
    ...structuredClone(active),
    entity_id: "air_conditioner:living_room",
    quantity: 1,
    status: "deferred",
    provenance: {
      source_type: "customer",
      source_message_id: "17000000-0000-4000-8000-000000000016",
    },
  });
  const decision = evaluateB2BeforeCommit({
    proposed_response: "你而家實際買 2 部冷氣；客廳嗰部已暫緩，不計入數量。",
    persistence_kind: "ai_reply",
    snapshot: {
      conversation_id: "17000000-0000-4000-8000-000000000001",
      company_id: "17000000-0000-4000-8000-000000000002",
      source_message_id: "17000000-0000-4000-8000-000000000017",
      commerce_state_revision: 17,
      commerce_state_source_message_id: "17000000-0000-4000-8000-000000000017",
      state,
    },
  });
  assert(decision.decision === "allow", JSON.stringify(decision));
});
const questions = [
  "一開始我要幾部冷氣？",
  "更正後冷氣數量是多少？",
  "我更正後的收貨地址是什麼？",
  "之前提供的房間面積是多少？",
  "What is my corrected delivery address?",
  "我偏好星期幾送貨？",
  "我之前冷氣要求幾匹？",
  "我要求的冷氣品牌是否一定要指定？",
  "舊報價 HKD 5,600 不應沿用，記得嗎？",
  "請讀回我的收貨人和聯絡電話？",
  "我現在是報價階段還是正式訂單？",
];
for (const q of questions) {
  for (const lang of ["zh-TW", "zh-CN", "en"]) {
    Deno.test(`C3 real frozen B2 semantic reply ${lang}: ${q}`, () => {
      const input = recallFixture(q);
      const route = prepareConversationRecall(input, lang);
      assert(
        route.decision.handled && route.reply,
        JSON.stringify(route.decision),
      );
      const b2 = evaluateB2BeforeCommit({
        proposed_response: route.reply,
        persistence_kind: "ai_reply",
        snapshot: {
          conversation_id: input.conversation_id,
          company_id: input.company_id,
          source_message_id: input.source_message_id,
          commerce_state_revision: input.commerce!.revision,
          commerce_state_source_message_id: input.commerce!.source_message_id,
          state: input.commerce!.state,
        },
        metadata: route.metadata,
      });
      assert(b2.decision === "allow", `${b2.code}: ${route.reply}`);
    });
  }
}
Deno.test("C3 routing metadata does not duplicate contact values", () => {
  const r = prepareConversationRecall(recallFixture("我的收貨人和電話？"));
  assert(r.reply?.includes("90000001"));
  assert(!JSON.stringify(r.metadata).includes("90000001"));
});
Deno.test("C3 exact T17 repaired reply passes frozen B2 persistence gate", () => {
  const input = t17ProductionFailureFixture();
  const route = prepareConversationRecall(input, "zh-TW");
  assert(route.decision.handled && route.reply, JSON.stringify(route.decision));
  assert(
    (route.reply.includes("2") || route.reply.includes("兩")) &&
      route.reply.includes("客廳") &&
      /取消/.test(route.reply),
    route.reply,
  );
  const b2 = evaluateB2BeforeCommit({
    proposed_response: route.reply,
    persistence_kind: "ai_reply",
    snapshot: {
      conversation_id: input.conversation_id,
      company_id: input.company_id,
      source_message_id: input.source_message_id,
      commerce_state_revision: input.commerce!.revision,
      commerce_state_source_message_id: input.commerce!.source_message_id,
      state: input.commerce!.state,
    },
    metadata: route.metadata,
  });
  assert(b2.decision === "allow", `${b2.code}: ${route.reply}`);
});
Deno.test("C3 current official facts still have no recall reply", () => {
  const r = prepareConversationRecall(
    recallFixture("What is the official warranty?"),
  );
  assert(
    !r.decision.handled && r.decision.reason === "CURRENT_KB_REQUIRED" &&
      r.reply === null,
  );
});
Deno.test("C3 ambiguous recall is not sent to KB no-match", () => {
  const i = recallFixture("我的電話？");
  delete i.commerce!.state.delivery.recipient_phone;
  const r = prepareConversationRecall(i);
  assert(
    !r.decision.handled && r.decision.reason === "AMBIGUOUS" && r.reply &&
      r.metadata.response_route === "canonical_memory_clarification",
  );
});
Deno.test("C3 frozen B2 remains fail-closed on unresolved correction", () => {
  const i = recallFixture();
  i.commerce!.state.latest_corrections = [
    "correction whose values are not canonicalized",
  ];
  const r = prepareConversationRecall(i);
  assert(r.reply);
  const d = evaluateB2BeforeCommit({
    proposed_response: r.reply,
    persistence_kind: "ai_reply",
    snapshot: {
      ...i,
      commerce_state_revision: 20,
      commerce_state_source_message_id: i.source_message_id,
      state: i.commerce!.state,
    },
    metadata: r.metadata,
  });
  assert(d.decision !== "allow" && d.code === "LATEST_CORRECTION_UNRESOLVED");
});

Deno.test("C3 recall callback runs only through real frozen B2 persistence", async () => {
  const i = recallFixture();
  const r = prepareConversationRecall(i);
  assert(r.reply);
  let commits = 0;
  const client = {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return {
            error: null,
            data: table === "conversations"
              ? { id: i.conversation_id, company_id: i.company_id }
              : table === "messages"
              ? {
                id: i.source_message_id,
                conversation_id: i.conversation_id,
                role: "visitor",
              }
              : {
                conversation_id: i.conversation_id,
                company_id: i.company_id,
                revision: 20,
                source_message_id: i.source_message_id,
                state: i.commerce!.state,
              },
          };
        },
      };
    },
  };
  const result = await executeB2PersistenceGate({
    client,
    conversation_id: i.conversation_id,
    source_message_id: i.source_message_id,
    proposed_response: r.reply,
    persistence_kind: "ai_reply",
    metadata: r.metadata,
    expected_commerce_state_revision: 20,
    commit: async () => {
      commits++;
      return "persisted";
    },
  });
  assert(result.committed && commits === 1, JSON.stringify(result));
});
Deno.test("C3 changed commerce revision commits zero", async () => {
  const i = recallFixture();
  const r = prepareConversationRecall(i);
  assert(r.reply);
  let commits = 0, reads = 0;
  const client = {
    from(table: string) {
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          if (table === "conversation_commerce_state") reads++;
          return {
            error: null,
            data: table === "conversations"
              ? { id: i.conversation_id, company_id: i.company_id }
              : table === "messages"
              ? {
                id: i.source_message_id,
                conversation_id: i.conversation_id,
                role: "visitor",
              }
              : {
                conversation_id: i.conversation_id,
                company_id: i.company_id,
                revision: reads > 1 ? 21 : 20,
                source_message_id: i.source_message_id,
                state: i.commerce!.state,
              },
          };
        },
      };
    },
  };
  const result = await executeB2PersistenceGate({
    client,
    conversation_id: i.conversation_id,
    source_message_id: i.source_message_id,
    proposed_response: r.reply,
    persistence_kind: "ai_reply",
    metadata: r.metadata,
    expected_commerce_state_revision: 20,
    commit: async () => {
      commits++;
      return "forbidden";
    },
  });
  assert(!result.committed && commits === 0, JSON.stringify(result));
});
Deno.test("C3 source audit recall precedes commerce reply, context shortcuts and KB", () => {
  const source = Deno.readTextFileSync(
    new URL("../generate-reply/index.ts", import.meta.url),
  );
  const start = source.indexOf("const _c3Recall = prepareConversationRecall(");
  const commerceReplyMarker =
    "if (_a3Commerce && _a3Commerce.reply && !_explicitHandoffRequested)";
  assert(start > source.indexOf("refreshConversationLongMemory("));
  for (
    const marker of [
      commerceReplyMarker,
      'if (_canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE")',
      "await callKBAdapter(",
    ]
  ) assert(start < source.indexOf(marker, start), `precedence: ${marker}`);
  const block = source.slice(
    start,
    source.indexOf(commerceReplyMarker, start),
  );
  assert(block.includes("commitAiReplyWithControlGate("));
  assert(!/\.insert\(|\.rpc\(/.test(block), "direct persistence bypass");
  assert(
    source.includes('_c3Recall.decision.reason === "NOT_A_RECALL_QUERY"'),
    "raw fallback authority guard absent",
  );
});
Deno.test("C3 assist uses same resolver after RBAC and before its KB dependency", () => {
  const source = Deno.readTextFileSync(
    new URL("../agent-assist/index.ts", import.meta.url),
  );
  const start = source.indexOf("const recallRoute = prepareConversationRecall(");
  const kbStart = source.indexOf("const kbPrefix");
  assert(start > source.indexOf("not_assigned_to_conversation"));
  assert(start > source.indexOf("handoff_context"));
  assert(start < kbStart);
  assert(
    /draft_only:\s*true/.test(source.slice(start, kbStart)),
  );
});
Deno.test("C3 legacy structured API delegates rather than adding a second resolver", () => {
  const source = Deno.readTextFileSync(
    new URL("./conversation-long-memory.ts", import.meta.url),
  );
  const block = source.slice(
    source.indexOf("export function resolveStructuredMemoryResponse("),
    source.indexOf("export function buildBoundedConversationContext("),
  );
  assert(
    block.includes("resolveConversationRecall(") &&
      !block.includes("asksFirst") && !block.includes("asksCorrection"),
  );
});
Deno.test("C3 unknown fact decisions never acquire inferred values", () => {
  const d = resolveConversationRecall(
    recallFixture("What is my favorite color?"),
  );
  assert(!d.handled && !("value" in d));
});

Deno.test("C3 reconstructed acceptance failures use customer-owned history (non-production replay)", async () => {
  const { buildCanonicalConversationMemory } = await import("./conversation-long-memory.ts");
  const contract = JSON.parse(Deno.readTextFileSync(new URL("../../../.github/scripts/c3_validation_scenarios.json", import.meta.url)));
  const ids = new Set(["T06", "T17", "T40", "T50", "T57", "T58", "T68", "T69", "T71", "C3-CONTROL-14"]);
  for (const row of contract.scenarios.filter((item: { id: string }) => ids.has(item.id))) {
    const seed = recallFixture(row.input);
    const commerceState = structuredClone(seed.commerce!.state);
    commerceState.entities = [];
    commerceState.quotes = [];
    commerceState.customer_constraints = {};
    commerceState.delivery.address = row.id === "T40" ? "長沙灣幸福邨A座12樓" : row.id === "T57" ? "幸福邨A座12樓" : null;
    commerceState.delivery.preferred_date = null;
    commerceState.delivery.preferred_window = null;
    const source = seed.source_message_id;
    const setup = row.setup_turns.map((content: string, index: number) => ({
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      role: "visitor",
      content,
    }));
    const memory = buildCanonicalConversationMemory({
      previous: null,
      conversation_id: seed.conversation_id,
      company_id: seed.company_id,
      source_message_id: source,
      commerce_state_revision: 20,
      commerce_state: commerceState,
      newest_first: [{ id: source, role: "visitor", content: row.input }, ...setup.reverse()],
      visitor_turn_count: setup.length + 1,
      source_created_at: "2026-09-16T00:00:00Z",
      next_memory_revision: 1,
    });
    const result = prepareConversationRecall({ ...seed, memory, commerce: { ...seed.commerce!, state: commerceState } });
    assert(result.decision.handled && result.reply, `${row.id}: ${JSON.stringify(result.decision)}`);
    const normalized = result.reply.normalize("NFKC").toLowerCase();
    const contains = (value: string) => normalized.includes(value.normalize("NFKC").toLowerCase());
    assert(!(row.expected.include_all ?? []).some((value: string) => !contains(value)), `${row.id}:include_all:${result.reply}`);
    assert(!row.expected.include_any || row.expected.include_any.some(contains), `${row.id}:include_any:${result.reply}`);
    assert(!row.expected.include_any_secondary || row.expected.include_any_secondary.some(contains), `${row.id}:include_any_secondary:${result.reply}`);
    assert(!(row.expected.exclude_any ?? []).some(contains), `${row.id}:exclude_any:${result.reply}`);
  }
});

Deno.test("C3 synthetic 100-turn bounded-memory routing continuity (not production replay)", async () => {
  const { buildCanonicalConversationMemory } = await import(
    "./conversation-long-memory.ts"
  );
  const seed = recallFixture();
  let previous = null as
    | ReturnType<typeof buildCanonicalConversationMemory>
    | null;
  for (let turn = 1; turn <= 100; turn++) {
    const source = `00000000-0000-4000-8000-${String(turn).padStart(12, "0")}`;
    const question = turn % 2
      ? "我之前冷氣要求幾匹？"
      : "請讀回我的收貨人和聯絡電話？";
    const memory = buildCanonicalConversationMemory({
      previous,
      conversation_id: seed.conversation_id,
      company_id: seed.company_id,
      source_message_id: source,
      commerce_state_revision: 20,
      commerce_state: seed.commerce!.state,
      newest_first: [{ id: source, role: "visitor", content: question }],
      visitor_turn_count: turn,
      source_created_at: `2026-09-15T00:${
        String(Math.floor(turn / 60)).padStart(2, "0")
      }:${String(turn % 60).padStart(2, "0")}Z`,
      next_memory_revision: turn,
    });
    const route = prepareConversationRecall({
      ...seed,
      question,
      source_message_id: source,
      memory,
      commerce: { ...seed.commerce!, source_message_id: source },
    });
    assert(
      route.decision.handled && route.reply,
      `synthetic turn ${turn}: ${JSON.stringify(route.decision)}`,
    );
    assert(
      JSON.stringify(memory).length <= 16384 && route.reply.length <= 4096,
      "bounded state drift",
    );
    previous = memory;
  }
});
