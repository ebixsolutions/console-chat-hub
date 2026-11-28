import {
  createEmptyConversationCommerceState,
  type CommerceEntity,
  type ConversationCommerceState,
} from "./commerce-state-contract.ts";
import {
  runCommerceStateRuntime,
  type CommerceRuntimeInput,
  type CommerceRuntimeOutcome,
  type CommerceStateDbClient,
} from "./commerce-state-runtime-base.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const owner = { company_id: "focus-company", conversation_id: "focus-ticket" };
const currentSource = "current-focus-visitor";

function state(category = "course", label = "日語進階課程"): ConversationCommerceState {
  const result = createEmptyConversationCommerceState();
  result.entities = [
    {
      entity_id: "customer:consulting", category: "consulting", quantity: 1, status: "tentative",
      attributes: { product_name: "營運諮詢", unit: "次" }, constraints: { budget: 800 },
      provenance: { source_type: "customer", source_message_id: "consulting-visitor" },
    },
    {
      entity_id: "customer:focus", category, quantity: 3, status: "tentative",
      attributes: { product_name: label, unit: "堂" }, constraints: { schedule: "週六" },
      provenance: { source_type: "customer", source_message_id: "focus-visitor" },
    },
  ];
  result.current_topic = "consulting";
  result.conversion.tentative_entity_ids = result.entities.map(entity => entity.entity_id);
  return result;
}

function input(previous: ConversationCommerceState, language: "en" | "zh-TW" = "zh-TW"): CommerceRuntimeInput {
  const focus = previous.entities[1];
  return {
    ...owner, source_message_id: currentSource, language,
    text: language === "en"
      ? `Pause 營運諮詢; focus on ${focus.category}.`
      : `暫緩營運諮詢；先處理${focus.category}。`,
    history: [
      { id: "focus-visitor", role: "visitor", content: `我想保留${Object.values(focus.attributes).join(" ")}。` },
      { id: "consulting-visitor", role: "visitor", content: "我需要營運諮詢一次。" },
    ],
  };
}

function store(previous: ConversationCommerceState, beforeFirstWrite?: (state: ConversationCommerceState) => void) {
  const live = { state: structuredClone(previous), revision: 4, writes: 0, attempts: 0 };
  const db: CommerceStateDbClient = {
    from(table) {
      const filters: Record<string, string> = {};
      const query = {
        select: (_columns: string) => query,
        eq: (key: string, value: string) => { filters[key] = value; return query; },
        maybeSingle: async () => {
          assert(filters.conversation_id === owner.conversation_id, "State read crossed ticket");
          return { data: table === "conversation_commerce_state" ? {
            ...owner, source_message_id: "prior-state-visitor", revision: live.revision,
            state: structuredClone(live.state),
          } : null, error: null };
        },
      };
      return query;
    },
    rpc: async (name, args) => {
      live.attempts++;
      assert(name === "upsert_conversation_commerce_state_v1", "Unexpected writer " + name);
      assert(args.p_company_id === owner.company_id && args.p_conversation_id === owner.conversation_id &&
        args.p_source_message_id === currentSource && args.p_expected_revision === live.revision,
      "Owner/source/revision changed at the mutation boundary");
      if (live.attempts === 1 && beforeFirstWrite) {
        beforeFirstWrite(live.state);
        live.revision++;
        return { data: { result: "revision_conflict", current_revision: live.revision }, error: null };
      }
      live.state = structuredClone(args.p_state as ConversationCommerceState);
      live.writes++;
      live.revision++;
      return { data: { result: "success", applied_revision: live.revision }, error: null };
    },
  };
  return { db, live };
}

function assertCommittedFocus(
  outcome: CommerceRuntimeOutcome | null,
  live: ReturnType<typeof store>["live"],
  preservedFocus: CommerceEntity,
  expectedLabel: string,
) {
  const receipt = outcome?.trusted_lifecycle_commit;
  assert(outcome?.reason === "authoritative_scoped_lifecycle_applied" && receipt,
    "No original committed lifecycle receipt: " + JSON.stringify(outcome));
  assert(live.writes === 1 && live.state.entities[0].status === "deferred" &&
    live.state.entities[0].provenance.source_message_id === currentSource,
  "Target was not paused exactly once");
  assert(JSON.stringify(live.state.entities[1]) === JSON.stringify(preservedFocus),
    "Focus display changed the retained entity");
  assert(live.state.current_topic === preservedFocus.category &&
    receipt.company_id === owner.company_id && receipt.source_message_id === currentSource &&
    receipt.committed_revision === live.revision && receipt.previous_revision + 1 === live.revision &&
    JSON.stringify(receipt.committed_state) === JSON.stringify(live.state) &&
    JSON.stringify(receipt.transaction_before) === JSON.stringify(receipt.transaction_after),
  "Display detached from original owner/revision/transaction receipt");
  assert(outcome.reply?.includes(expectedLabel), "Missing customer focus label: " + outcome.reply);
  assert(receipt.reply === outcome.reply, "Receipt and delivered reply differ");
}

Deno.test("Task3C lifecycle focus displays the committed customer name across services and languages", async () => {
  for (const [category, label, language] of [
    ["course", "日語進階課程", "zh-TW"],
    ["advisory_session", "Governance Consulting", "en"],
    ["rental", "Studio Lighting Rental", "en"],
  ] as const) {
    const previous = state(category, label), { db, live } = store(previous);
    const outcome = await runCommerceStateRuntime(db, input(previous, language));
    assertCommittedFocus(outcome, live, previous.entities[1], label);
  }
});

Deno.test("Task3C lifecycle focus reads retained display name, name, original name and model without changing them", async () => {
  for (const field of ["display_name", "name", "original_name", "model"] as const) {
    const previous = state(), label = "Customer Named Workshop";
    previous.entities[1].attributes = { unit: "sessions" };
    if (field === "model") previous.entities[1].model = label;
    else previous.entities[1].attributes[field] = label;
    const { db, live } = store(previous);
    const outcome = await runCommerceStateRuntime(db, input(previous));
    assertCommittedFocus(outcome, live, previous.entities[1], label);
  }
});

Deno.test("Task3C lifecycle focus does not translate a category when no customer label is available", async () => {
  for (const category of ["air_conditioner", "refrigerator", "course"]) {
    const previous = state(category);
    previous.entities[1].attributes = { product_name: "  ", name: null, unit: "items" };
    const { db, live } = store(previous);
    const outcome = await runCommerceStateRuntime(db, input(previous));
    assertCommittedFocus(outcome, live, previous.entities[1], category);
    assert(!/冷氣|雪櫃/.test(outcome?.reply ?? ""), "Invented industry alias: " + outcome?.reply);
  }
});

Deno.test("Task3C lifecycle focus cannot promote a merchant or unsourced label into a customer name", async () => {
  for (const kind of ["kb", "system", "human_agent", "missing-source", "empty-source"] as const) {
    const previous = state("course", "Unverified Customer Label"), focus = previous.entities[1];
    if (kind === "missing-source") delete focus.provenance.source_message_id;
    else if (kind === "empty-source") focus.provenance.source_message_id = "   ";
    else focus.provenance.source_type = kind;
    const { db, live } = store(previous);
    const outcome = await runCommerceStateRuntime(db, input(previous));
    assertCommittedFocus(outcome, live, focus, "course");
    assert(!outcome?.reply?.includes("Unverified Customer Label"), "Unowned focus name escaped");
  }
});

Deno.test("Task3C lifecycle focus ambiguity leaves both entities and state unchanged", async () => {
  const previous = state();
  previous.entities.push({ ...structuredClone(previous.entities[1]), entity_id: "customer:other-focus",
    attributes: { product_name: "另一個課程", unit: "堂" } });
  previous.conversion.tentative_entity_ids.push("customer:other-focus");
  const { db, live } = store(previous);
  const outcome = await runCommerceStateRuntime(db, input(previous));
  assert(live.writes === 0 && JSON.stringify(live.state) === JSON.stringify(previous) &&
    outcome?.reason === "ambiguous_lifecycle_target" && !outcome.trusted_lifecycle_commit,
  "Ambiguous focus acquired write or display authority: " + JSON.stringify(outcome));
});

Deno.test("Task3C lifecycle focus never displays a cancelled, deferred or superseded customer name", async () => {
  for (const status of ["cancelled", "deferred", "superseded"] as const) {
    const previous = state("course", "Inactive Customer Workshop");
    // "superseded" deliberately models a malformed/legacy database row; it is
    // not a new allowed CommerceEntityStatus or a successful lifecycle input.
    previous.entities[1].status = status as CommerceEntity["status"];
    const { db, live } = store(previous);
    const outcome = await runCommerceStateRuntime(db, input(previous));
    assert(!outcome?.reply?.includes("Inactive Customer Workshop"), "Inactive focus name escaped");
    if (status !== "superseded") assert(live.writes === 0 &&
      JSON.stringify(live.state) === JSON.stringify(previous) && !outcome?.trusted_lifecycle_commit,
    "Inactive focus acquired lifecycle authority");
    else assert(!outcome?.trusted_lifecycle_commit && !outcome?.reply &&
      JSON.stringify(live.state.entities[1]) === JSON.stringify(previous.entities[1]),
    "Superseded focus acquired a successful lifecycle acknowledgement");
  }
});

Deno.test("Task3C lifecycle focus display follows the snapshot committed after an existing CAS retry", async () => {
  const previous = state(), newerLabel = "Revised Customer Workshop";
  const { db, live } = store(previous, current => {
    current.entities[1].attributes.product_name = newerLabel;
    current.entities[1].provenance.source_message_id = "newer-focus-visitor";
  });
  const expectedFocus = structuredClone(previous.entities[1]);
  expectedFocus.attributes.product_name = newerLabel;
  expectedFocus.provenance.source_message_id = "newer-focus-visitor";
  const outcome = await runCommerceStateRuntime(db, input(previous));
  assertCommittedFocus(outcome, live, expectedFocus, newerLabel);
  assert(live.attempts === 2 && live.revision === 6 && !outcome?.reply?.includes("日語進階課程"),
    "Focus used the pre-conflict snapshot");
});

Deno.test("Task3C failed lifecycle commit does not acknowledge a retained focus", async () => {
  const previous = state(), { db, live } = store(previous);
  db.rpc = async () => ({ data: null, error: { message: "synthetic transport failure" } });
  const outcome = await runCommerceStateRuntime(db, input(previous));
  assert(live.writes === 0 && JSON.stringify(live.state) === JSON.stringify(previous) &&
    !outcome?.trusted_lifecycle_commit && !outcome?.reply && outcome?.persist_result !== "success",
  "Uncommitted focus was acknowledged: " + JSON.stringify(outcome));
});
