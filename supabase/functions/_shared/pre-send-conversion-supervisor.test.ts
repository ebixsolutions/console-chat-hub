import {
  type B2DatabaseClient,
  type B2PersistenceKind,
  type B2QueryBuilder,
  type B2QueryResult,
  collectKnownCommerceFacts,
  evaluateB2BeforeCommit,
  executeB2PersistenceGate,
} from "./pre-send-conversion-supervisor.ts";
import {
  type ConversationCommerceState,
  createEmptyConversationCommerceState,
} from "./commerce-state-contract.ts";
import { classifyHandoffIntent } from "./handoff-intent.ts";
import { classifyConversationTurn } from "./conversation-intelligence.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";

function stateFixture(): ConversationCommerceState {
  const state = createEmptyConversationCommerceState();
  state.current_intent = "purchase air conditioner";
  state.current_topic = "bedroom air conditioner";
  state.current_industry = "home_appliance";
  state.unresolved_items = ["site voltage check"];
  state.customer_constraints = { budget: 9000, preferred_colour: "white" };
  state.entities = [
    {
      entity_id: "air_conditioner:bedroom",
      category: "air_conditioner",
      brand: "Daikin",
      model: "RX-100",
      quantity: 2,
      status: "confirmed",
      attributes: { product_name: "bedroom unit", warranty_period: "3 years" },
      constraints: { max_width_cm: 80 },
      provenance: { source_type: "customer", source_message_id: SOURCE_ID },
    },
    {
      entity_id: "air_conditioner:study",
      category: "air_conditioner",
      brand: "Midea",
      model: "MS-200",
      quantity: 1,
      status: "cancelled",
      attributes: { product_name: "study unit" },
      constraints: {},
      provenance: { source_type: "customer", source_message_id: SOURCE_ID },
    },
  ];
  state.quotes = [
    {
      quote_id: "q-current-bedroom",
      entity_id: "air_conditioner:bedroom",
      amount: 5000,
      currency: "HKD",
      quote_type: "current_verified",
      validity_status: "current",
      conditions: { installation_included: false },
      provenance: { source_type: "system", source_message_id: SOURCE_ID },
    },
    {
      quote_id: "q-current-study",
      entity_id: "air_conditioner:study",
      amount: 5000,
      currency: "USD",
      quote_type: "current_verified",
      validity_status: "current",
      conditions: {},
      provenance: { source_type: "system", source_message_id: SOURCE_ID },
    },
    {
      quote_id: "q-historical",
      entity_id: "air_conditioner:bedroom",
      amount: 8000,
      currency: "HKD",
      quote_type: "customer_reported_historical",
      validity_status: "historical",
      conditions: {},
      provenance: { source_type: "customer", source_message_id: SOURCE_ID },
    },
  ];
  state.delivery = {
    preferred_date: "2026-09-20",
    preferred_window: "14:00-16:00",
    address: "1 Queen's Road Central",
    recipient_name: "Marco",
    recipient_phone: "+852 9123 4567",
    confirmed: true,
    provenance: { source_type: "customer", source_message_id: SOURCE_ID },
  };
  state.installation = {
    items: [
      {
        item_id: "install-bedroom",
        kind: "air_conditioner_installation",
        entity_id: "air_conditioner:bedroom",
        status: "confirmed",
        details: { appointment: "2026-09-21" },
        provenance: { source_type: "system", source_message_id: SOURCE_ID },
      },
      {
        item_id: "install-study",
        kind: "air_conditioner_installation",
        entity_id: "air_conditioner:study",
        status: "cancelled",
        details: {},
        provenance: { source_type: "customer", source_message_id: SOURCE_ID },
      },
    ],
    site_conditions: { voltage: "220V" },
    pending_checks: ["drainage_check"],
  };
  state.conversion = {
    funnel_stage: "order_confirmed",
    quotation_status: "accepted",
    order_status: "confirmed",
    payment_status: "paid",
    confirmed_entity_ids: ["air_conditioner:bedroom"],
    tentative_entity_ids: [],
    cancelled_entity_ids: ["air_conditioner:study"],
    next_best_action: "schedule delivery",
  };
  return state;
}

function snapshot(state = stateFixture(), revision = 7) {
  return {
    conversation_id: CONVERSATION_ID,
    company_id: COMPANY_ID,
    source_message_id: SOURCE_ID,
    commerce_state_revision: revision,
    commerce_state_source_message_id: SOURCE_ID,
    state,
  };
}

function decision(response: string, state = stateFixture(), kind: B2PersistenceKind = "ai_reply") {
  return evaluateB2BeforeCommit({
    proposed_response: response,
    persistence_kind: kind,
    snapshot: snapshot(state),
  });
}

interface MockOptions {
  state?: ConversationCommerceState | null;
  revision?: number;
  secondRevision?: number;
  stateCompanyId?: string;
  stateSourceId?: string | null;
  secondStateSourceId?: string | null;
  conversationCompanyId?: string | null;
  sourceRole?: string;
  sourceError?: unknown;
  throwOnTable?: string;
}

class MockBuilder implements B2QueryBuilder {
  private filters: Record<string, string> = {};
  constructor(
    private readonly client: MockClient,
    private readonly table: string,
  ) {}
  select(_columns: string): B2QueryBuilder {
    return this;
  }
  eq(column: string, value: string): B2QueryBuilder {
    this.filters[column] = value;
    return this;
  }
  async maybeSingle(): Promise<B2QueryResult> {
    return this.client.resolve(this.table, this.filters);
  }
}

class MockClient implements B2DatabaseClient {
  private stateReads = 0;
  public readonly calls: Array<{ table: string; filters: Record<string, string> }> = [];
  constructor(private readonly options: MockOptions = {}) {}
  from(table: string): B2QueryBuilder {
    if (this.options.throwOnTable === table) {
      throw new Error("mock_query_throw");
    }
    return new MockBuilder(this, table);
  }
  resolve(table: string, filters: Record<string, string>): B2QueryResult {
    this.calls.push({ table, filters: { ...filters } });
    if (table === "conversations") {
      const company =
        this.options.conversationCompanyId === undefined
          ? COMPANY_ID
          : this.options.conversationCompanyId;
      return company
        ? { data: { id: CONVERSATION_ID, company_id: company }, error: null }
        : { data: { id: CONVERSATION_ID, company_id: null }, error: null };
    }
    if (table === "messages") {
      if (this.options.sourceError) {
        return { data: null, error: this.options.sourceError };
      }
      return {
        data: {
          id: SOURCE_ID,
          conversation_id: CONVERSATION_ID,
          role: this.options.sourceRole ?? "visitor",
        },
        error: null,
      };
    }
    if (table === "conversation_commerce_state") {
      this.stateReads += 1;
      if (this.options.state === null) return { data: null, error: null };
      return {
        data: {
          company_id: this.options.stateCompanyId ?? COMPANY_ID,
          revision:
            this.stateReads > 1 && this.options.secondRevision !== undefined
              ? this.options.secondRevision
              : (this.options.revision ?? 7),
          source_message_id:
            this.stateReads > 1 && this.options.secondStateSourceId !== undefined
              ? this.options.secondStateSourceId
              : this.options.stateSourceId === undefined
                ? SOURCE_ID
                : this.options.stateSourceId,
          state: structuredClone(this.options.state ?? stateFixture()),
        },
        error: null,
      };
    }
    return { data: null, error: { message: "unexpected_table" } };
  }
}

Deno.test("B2 known-context discovery covers the full canonical surface", () => {
  const paths = new Set(collectKnownCommerceFacts(stateFixture()).map((fact) => fact.path));
  for (const expected of [
    "current_intent",
    "current_topic",
    "unresolved_items.0",
    "quotes.0.amount",
    "quotes.0.validity_status",
    "delivery.confirmed",
    "installation.items.0.kind",
    "installation.items.0.status",
    "conversion.order_status",
    "conversion.payment_status",
  ])
    assert(paths.has(expected), `missing known fact ${expected}`);
});

Deno.test("B2 blocks asking for a known delivery address", () => {
  assertEquals(
    decision("What is your delivery address?").code,
    "KNOWN_CONTEXT_RECONFIRMATION",
    "known address",
  );
});

Deno.test("B2 blocks asking for known order and payment status", () => {
  assertEquals(
    decision("Can you confirm the order status?").code,
    "KNOWN_CONTEXT_RECONFIRMATION",
    "known order status",
  );
  assertEquals(
    decision("What is the payment status?").code,
    "KNOWN_CONTEXT_RECONFIRMATION",
    "known payment status",
  );
  assertEquals(
    decision("Your order status is confirmed. Is there anything else I can help with?").decision,
    "allow",
    "question scope must not treat an earlier statement as a repeated request",
  );
});

Deno.test("B2 blocks asking for known quote and installation facts", () => {
  assertEquals(
    decision("What is the quote price?").code,
    "KNOWN_CONTEXT_RECONFIRMATION",
    "known quote",
  );
  assertEquals(
    decision("Which installation type is required?").code,
    "KNOWN_CONTEXT_RECONFIRMATION",
    "known installation",
  );
});

Deno.test("B2 correction priority blocks a superseded value", () => {
  const state = stateFixture();
  state.latest_corrections = ["不是 3 部而是 2 部"];
  assertEquals(
    decision("Your order contains 3 部 air conditioners.", state).code,
    "SUPERSEDED_VALUE_REUSED",
    "correction",
  );
});

Deno.test("B2 unresolved correction is fail-closed only for commerce-touching drafts", () => {
  const state = stateFixture();
  state.latest_corrections = ["記住我最新嗰個更正"];
  assertEquals(
    decision("The order is ready.", state).decision,
    "indeterminate",
    "commerce correction",
  );
  assertEquals(
    decision("Thanks for the update.", state).decision,
    "allow",
    "unrelated acknowledgement",
  );
});

Deno.test("B2 blocks explicit and indirect cancelled entity restoration", () => {
  assertEquals(
    decision("We will put the study unit back in and proceed.").code,
    "CANCELLED_ENTITY_RESTORATION",
    "explicit cancelled entity",
  );
  const state = stateFixture();
  state.entities = state.entities.filter((entity) => entity.status === "cancelled");
  assertEquals(
    decision("We will proceed with the one you removed.", state).code,
    "CANCELLED_ENTITY_INDIRECT_RESTORATION",
    "indirect cancelled entity",
  );
});

Deno.test("B2 returns indeterminate for ambiguous cancelled pronouns", () => {
  assertEquals(
    decision("We will proceed with that one.").code,
    "AMBIGUOUS_CANCELLED_ENTITY_REFERENCE",
    "ambiguous cancellation",
  );
});

Deno.test("B2 blocks cancelled quote, order, and installation restoration", () => {
  const quoteState = stateFixture();
  quoteState.quotes[0].validity_status = "superseded";
  assertEquals(
    decision("We will restore and use the quote price.", quoteState).code,
    "INACTIVE_QUOTE_RESTORATION",
    "quote restoration",
  );
  const orderState = stateFixture();
  orderState.conversion.order_status = "cancelled";
  assertEquals(
    decision("We will proceed with the order.", orderState).code,
    "CANCELLED_ORDER_RESTORATION",
    "order restoration",
  );
  const installState = stateFixture();
  assertEquals(
    decision("We will continue the cancelled installation.", installState).code,
    "CANCELLED_INSTALLATION_RESTORATION",
    "installation restoration",
  );
});

Deno.test("B2 allows only entity amount currency bound current quotes", () => {
  assertEquals(
    decision("The latest price for the bedroom unit is HKD 5,000.").decision,
    "allow",
    "verified quote",
  );
  assertEquals(
    decision("The latest price for the bedroom unit is USD 5,000.").code,
    "CURRENT_QUOTE_NOT_PROVEN",
    "currency mismatch",
  );
  assertEquals(
    decision("The latest price for the bedroom unit is HKD 8,000.").code,
    "CURRENT_QUOTE_NOT_PROVEN",
    "historical amount",
  );
  assertEquals(
    decision("The latest price for the bedroom unit is 5,000.").code,
    "CURRENT_QUOTE_NOT_PROVEN",
    "currency binding is mandatory",
  );
  assertEquals(
    decision("The latest price is HKD 5,000.").code,
    "CURRENT_QUOTE_NOT_PROVEN",
    "entity binding is mandatory",
  );
});

Deno.test("B2 rejects an unscoped quote for a named entity", () => {
  const state = stateFixture();
  state.quotes[0].entity_id = null;
  assertEquals(
    decision("The latest price for the bedroom unit is HKD 5,000.", state).code,
    "CURRENT_QUOTE_NOT_PROVEN",
    "unscoped quote",
  );
});

Deno.test("B2 does not cross-bind equal quote amounts between entities", () => {
  const state = stateFixture();
  state.quotes = [state.quotes[1]];
  state.quotes[0].currency = "HKD";
  assertEquals(
    decision("The latest price for the bedroom unit is HKD 5,000.", state).code,
    "CURRENT_QUOTE_NOT_PROVEN",
    "entity mismatch",
  );
});

Deno.test("B2 distinguishes confirmation from delivery and installation completion", () => {
  assertEquals(
    decision("The delivery arrangement is confirmed.").decision,
    "allow",
    "delivery confirmation",
  );
  assertEquals(
    decision("Delivery has been completed.").code,
    "DELIVERY_COMPLETION_NOT_CANONICALLY_PROVABLE",
    "delivery completion",
  );
  assertEquals(
    decision("The installation arrangement is confirmed.").decision,
    "allow",
    "installation confirmation",
  );
  assertEquals(
    decision("Installation has been completed.").code,
    "INSTALLATION_COMPLETION_NOT_CANONICALLY_PROVABLE",
    "installation completion",
  );
});

Deno.test("B2 requires positive canonical order and payment proof", () => {
  const state = stateFixture();
  state.conversion.order_status = "pending_confirmation";
  state.conversion.payment_status = "pending_payment";
  assertEquals(
    decision("The order has been confirmed.", state).code,
    "ORDER_CONFIRMATION_NOT_PROVEN",
    "order proof",
  );
  assertEquals(
    decision("Payment has been completed.", state).code,
    "PAYMENT_COMPLETION_NOT_PROVEN",
    "payment proof",
  );
});

Deno.test("B2 generic completion is blocked except for an atomic handoff transaction", () => {
  assertEquals(
    decision("Your request has been processed.").code,
    "ACTION_COMPLETION_NOT_PROVEN",
    "generic action",
  );
  assertEquals(
    decision("Your request has been processed.", stateFixture(), "explicit_handoff").decision,
    "allow",
    "atomic handoff",
  );
});

Deno.test("B2 persistence executor invokes the callback exactly once after allow", async () => {
  const client = new MockClient();
  let commits = 0;
  const result = await executeB2PersistenceGate({
    client,
    conversation_id: CONVERSATION_ID,
    source_message_id: SOURCE_ID,
    proposed_response: "Thanks for the update.",
    persistence_kind: "ai_reply",
    commit: async () => ({ result: "idempotent" }),
  });
  if (result.committed) commits += 1;
  assert(result.committed, "allow should commit");
  assertEquals(result.value, { result: "idempotent" }, "callback result preserved");
  assertEquals(commits, 1, "callback count");
  assertEquals(
    client.calls.map((call) => call.table),
    [
      "conversations",
      "messages",
      "conversation_commerce_state",
      "conversations",
      "messages",
      "conversation_commerce_state",
    ],
    "actual integration query order",
  );
});

Deno.test("B2 block never invokes persistence", async () => {
  let commits = 0;
  const result = await executeB2PersistenceGate({
    client: new MockClient(),
    conversation_id: CONVERSATION_ID,
    source_message_id: SOURCE_ID,
    proposed_response: "Installation has been completed.",
    persistence_kind: "ai_reply",
    commit: async () => {
      commits += 1;
      return { result: "success" };
    },
  });
  assert(!result.committed, "blocked draft must not commit");
  assertEquals(commits, 0, "blocked callback count");
});

Deno.test(
  "B2 accepts a prior canonical state source and revalidates it before persistence",
  async () => {
    let commits = 0;
    const previousSource = "44444444-4444-4444-8444-444444444444";
    const result = await executeB2PersistenceGate({
      client: new MockClient({ stateSourceId: previousSource }),
      conversation_id: CONVERSATION_ID,
      source_message_id: SOURCE_ID,
      proposed_response: "Thanks.",
      persistence_kind: "ai_reply",
      commit: async () => {
        commits += 1;
        return "success";
      },
    });
    assert(result.committed, "prior canonical state must remain usable on an early path");
    assertEquals(result.snapshot.commerce_state_source_message_id, previousSource, "state source");
    assertEquals(commits, 1, "prior state callback count");
  },
);

Deno.test("B2 state source drift before commit never invokes persistence", async () => {
  let commits = 0;
  const result = await executeB2PersistenceGate({
    client: new MockClient({
      stateSourceId: "44444444-4444-4444-8444-444444444444",
      secondStateSourceId: "55555555-5555-4555-8555-555555555555",
    }),
    conversation_id: CONVERSATION_ID,
    source_message_id: SOURCE_ID,
    proposed_response: "Thanks.",
    persistence_kind: "ai_reply",
    commit: async () => {
      commits += 1;
      return "success";
    },
  });
  assert(!result.committed, "state source drift must not commit");
  assertEquals(
    result.decision.code,
    "COMMERCE_CONTEXT_CHANGED_BEFORE_COMMIT",
    "state source drift code",
  );
  assertEquals(commits, 0, "state source drift callback count");
});

Deno.test("B2 expected revision mismatch never invokes persistence", async () => {
  let commits = 0;
  const result = await executeB2PersistenceGate({
    client: new MockClient({ revision: 7 }),
    conversation_id: CONVERSATION_ID,
    source_message_id: SOURCE_ID,
    proposed_response: "Thanks.",
    persistence_kind: "ai_reply",
    expected_commerce_state_revision: 6,
    commit: async () => {
      commits += 1;
      return "success";
    },
  });
  assert(!result.committed, "expected revision mismatch must not commit");
  assertEquals(
    result.decision.code,
    "EXPECTED_COMMERCE_REVISION_MISMATCH",
    "expected revision code",
  );
  assertEquals(commits, 0, "revision callback count");
});

Deno.test("B2 revision drift between evaluation and commit never invokes persistence", async () => {
  let commits = 0;
  const result = await executeB2PersistenceGate({
    client: new MockClient({ revision: 7, secondRevision: 8 }),
    conversation_id: CONVERSATION_ID,
    source_message_id: SOURCE_ID,
    proposed_response: "Thanks.",
    persistence_kind: "ai_reply",
    commit: async () => {
      commits += 1;
      return "success";
    },
  });
  assert(!result.committed, "revision drift must not commit");
  assertEquals(
    result.decision.code,
    "COMMERCE_CONTEXT_CHANGED_BEFORE_COMMIT",
    "revision drift code",
  );
  assertEquals(commits, 0, "revision drift callback count");
});

Deno.test("B2 source lookup failure and thrown supervisor reads are fail-closed", async () => {
  for (const client of [
    new MockClient({ sourceError: { message: "offline" } }),
    new MockClient({ throwOnTable: "messages" }),
  ]) {
    let commits = 0;
    const result = await executeB2PersistenceGate({
      client,
      conversation_id: CONVERSATION_ID,
      source_message_id: SOURCE_ID,
      proposed_response: "Thanks.",
      persistence_kind: "ai_reply",
      commit: async () => {
        commits += 1;
        return "success";
      },
    });
    assert(!result.committed, "read failure must not commit");
    assertEquals(result.decision.decision, "indeterminate", "read failure decision");
    assertEquals(commits, 0, "read failure callback count");
  }
});

Deno.test("B2 validates the source role and tenant binding", async () => {
  for (const client of [
    new MockClient({ sourceRole: "assistant" }),
    new MockClient({ conversationCompanyId: null }),
  ]) {
    const result = await executeB2PersistenceGate({
      client,
      conversation_id: CONVERSATION_ID,
      source_message_id: SOURCE_ID,
      proposed_response: "Thanks.",
      persistence_kind: "ai_reply",
      commit: async () => "success",
    });
    assert(!result.committed, "invalid source or tenant must not commit");
  }
});

Deno.test(
  "B2 permits an empty first-turn commerce snapshot but still supervises claims",
  async () => {
    const result = await executeB2PersistenceGate({
      client: new MockClient({ state: null }),
      conversation_id: CONVERSATION_ID,
      source_message_id: SOURCE_ID,
      proposed_response: "The order has been confirmed.",
      persistence_kind: "ai_reply",
      commit: async () => "success",
    });
    assert(!result.committed, "unsupported first-turn claim must not commit");
    assertEquals(result.decision.code, "ORDER_CONFIRMATION_NOT_PROVEN", "empty state claim code");
  },
);

Deno.test("B2 evaluation never mutates canonical state or metadata", () => {
  const state = stateFixture();
  const metadata = { nested: { value: 1 } };
  const beforeState = structuredClone(state);
  const beforeMetadata = structuredClone(metadata);
  evaluateB2BeforeCommit({
    proposed_response: "Thanks.",
    persistence_kind: "ai_reply",
    snapshot: snapshot(state),
    metadata,
  });
  assertEquals(state, beforeState, "state immutability");
  assertEquals(metadata, beforeMetadata, "metadata immutability");
});

Deno.test("generate-reply wires every customer-visible persistence RPC through B2", async () => {
  const source = await Deno.readTextFile(new URL("../generate-reply/index.ts", import.meta.url));
  for (const rpc of [
    "commit_ai_reply_tx",
    "required_escalation_handoff",
    "explicit_handoff_tx",
    "kb_fallback_handoff_tx",
    "s0_handoff_tx",
  ])
    assert(source.includes(rpc), `missing runtime path ${rpc}`);
  assert(source.includes("executeB2RpcPersistence"), "B2 runtime executor missing");
  const directCustomerVisibleRpcCalls = [
    ...source.matchAll(
      /await supabaseAdmin\.rpc\([\s\n]*["'](commit_ai_reply_tx|explicit_handoff_tx|kb_fallback_handoff_tx|s0_handoff_tx)["']/g,
    ),
  ];
  assertEquals(
    directCustomerVisibleRpcCalls.length,
    6,
    "review expected persistence callback sites",
  );
  for (const match of directCustomerVisibleRpcCalls) {
    const prefix = source.slice(Math.max(0, (match.index ?? 0) - 900), match.index ?? 0);
    assert(prefix.includes("executeB2RpcPersistence"), `${match[1]} bypasses B2`);
  }
});

Deno.test("C3 explicit human requests bypass canonical clarification and reach governed R1 persistence", async () => {
  const exactRequests = [
    "我要真人客服接手處理，而且在問題解決前不要當作已完成。",
    "請轉交真人並保持未解決狀態。",
  ];
  for (const request of exactRequests) {
    const classified = classifyHandoffIntent(request);
    assert(classified.explicit_request, `exact handoff request not classified: ${request}`);
  }
  assert(
    classifyHandoffIntent("不要轉真人客服，你直接回答我就好").pure_handoff_negation,
    "true handoff negation must remain non-escalating",
  );
  assert(
    classifyConversationTurn("我有一個問題").should_clarify_before_kb,
    "genuine non-handoff ambiguity must still clarify",
  );

  const source = await Deno.readTextFile(
    new URL("../generate-reply/index.ts", import.meta.url),
  );
  const recall = source.indexOf("const _c3Recall = prepareConversationRecall");
  const guardedRecallCommit = source.indexOf(
    "if (_c3PlannedReply && !_explicitHandoffRequested)",
  );
  const guardedCommerceCommit = source.indexOf(
    "if (_a3Commerce && _a3Commerce.reply && !_explicitHandoffRequested)",
  );
  const governedR1 = source.indexOf(
    "const r1Response = await persistExplicitR1IfRequested",
    guardedRecallCommit,
  );
  assert(recall >= 0, "canonical recall path missing");
  assert(guardedRecallCommit > recall, "canonical reply lacks explicit-handoff precedence guard");
  assert(guardedCommerceCommit > guardedRecallCommit, "commerce reply lacks explicit-handoff precedence guard");
  assert(governedR1 > guardedCommerceCommit, "governed R1 persistence is not reachable after guarded shortcuts");

  const r1 = source.indexOf("async function persistExplicitR1IfRequested");
  const successContract = source.slice(
    source.indexOf('case "success":', r1),
    source.indexOf('case "already_resolved":', r1),
  );
  for (const marker of [
    'response_route: "explicit_handoff"',
    "handoff_required: true",
    "handoff_persisted: true",
  ]) assert(successContract.includes(marker), `R1 success contract missing: ${marker}`);
});

Deno.test("C3 explicit handoff persistence is B2-supervised and source-idempotent", async () => {
  const persistedSources = new Set<string>();
  let handoffEvents = 0;
  const persist = async () => {
    if (persistedSources.has(SOURCE_ID)) return { result: "already_handled" };
    persistedSources.add(SOURCE_ID);
    handoffEvents += 1;
    return { result: "success" };
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await executeB2PersistenceGate({
      client: new MockClient(),
      conversation_id: CONVERSATION_ID,
      source_message_id: SOURCE_ID,
      proposed_response: "我們已將你的對話轉交真人客服。",
      persistence_kind: "explicit_handoff",
      metadata: {
        escalation_rule: "R1",
        response_route: "explicit_handoff",
        handoff_required: true,
      },
      commit: persist,
    });
    assert(result.committed, `governed handoff attempt ${attempt + 1} blocked`);
  }
  assertEquals(handoffEvents, 1, "same source must create exactly one handoff event");
});
