import {
  alignB3EvaluatorOutput,
  assessB3Alignment,
  bindConversionRealityToBundle,
  conversionRealityFingerprint,
  loadCeConversionReality,
  revalidateCeConversionReality,
  type CeConversionReality,
  type CeConversionRealityDb,
  type CeConversionRealityQueryBuilder,
  type CeConversionRealityQueryResult,
} from "./ce-conversion-reality.ts";
import {
  createEmptyConversationCommerceState,
  type ConversationCommerceState,
} from "./commerce-state-contract.ts";
import type { B3EvaluatorOutput } from "./ce-conversion-reality.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const ASSISTANT_ID = "44444444-4444-4444-8444-444444444444";

function stateFixture(industry = "home_appliance"): ConversationCommerceState {
  const state = createEmptyConversationCommerceState();
  state.current_topic = "Product A";
  state.current_industry = industry;
  state.latest_corrections = ["不是 2 部而是 3 部"];
  state.customer_constraints = { budget: 9000, region: "HK" };
  state.entities = [
    {
      entity_id: "product-a",
      category: industry === "fashion" ? "shirt" : "air_conditioner",
      model: "Product A",
      quantity: 3,
      status: "confirmed",
      attributes: industry === "fashion" ? { size: "L" } : { capacity: "2P" },
      constraints: {},
      provenance: { source_type: "customer", source_message_id: SOURCE_ID },
    },
    {
      entity_id: "product-b",
      category: industry === "fashion" ? "jacket" : "air_conditioner",
      model: "Product B",
      quantity: 1,
      status: "cancelled",
      attributes: {},
      constraints: {},
      provenance: { source_type: "customer", source_message_id: SOURCE_ID },
    },
  ];
  state.quotes = [
    {
      quote_id: "historical-quote",
      entity_id: "product-a",
      amount: 8000,
      currency: "HKD",
      quote_type: "customer_reported_historical",
      validity_status: "historical",
      conditions: {},
      provenance: { source_type: "customer", source_message_id: SOURCE_ID },
    },
  ];
  state.delivery = {
    address: "B3 controlled address",
    confirmed: false,
    provenance: { source_type: "customer", source_message_id: SOURCE_ID },
  };
  state.installation = {
    items: [
      {
        item_id: "install-a",
        kind: "installation",
        entity_id: "product-a",
        status: "pending",
        details: {},
        provenance: { source_type: "customer", source_message_id: SOURCE_ID },
      },
    ],
    site_conditions: {},
    pending_checks: [],
  };
  state.conversion = {
    funnel_stage: "quotation",
    quotation_status: "verified",
    order_status: "pending_confirmation",
    payment_status: "pending_payment",
    confirmed_entity_ids: ["product-a"],
    tentative_entity_ids: [],
    cancelled_entity_ids: ["product-b"],
    next_best_action: "confirm quotation",
  };
  return state;
}

class RowDb implements CeConversionRealityDb {
  constructor(
    public row: Record<string, unknown> | null,
    public error: unknown = null,
  ) {}
  from(table: string): CeConversionRealityQueryBuilder {
    if (table !== "conversation_commerce_state") throw new Error(`unexpected table ${table}`);
    const filters = new Map<string, string>();
    const builder: CeConversionRealityQueryBuilder = {
      select: () => builder,
      eq: (column, value) => {
        filters.set(column, value);
        return builder;
      },
      maybeSingle: async (): Promise<CeConversionRealityQueryResult> => {
        const matches =
          this.row &&
          filters.get("conversation_id") === CONVERSATION_ID &&
          filters.get("company_id") === COMPANY_ID;
        return { data: matches ? structuredClone(this.row) : null, error: this.error };
      },
    };
    return builder;
  }
}

function dbFixture(industry = "home_appliance"): RowDb {
  return new RowDb({
    company_id: COMPANY_ID,
    revision: 7,
    source_message_id: SOURCE_ID,
    state_hash: "a".repeat(64),
    state: stateFixture(industry),
    updated_at: "2026-09-13T00:00:00Z",
  });
}

async function realityFixture(industry = "home_appliance"): Promise<CeConversionReality> {
  const result = await loadCeConversionReality(dbFixture(industry), {
    conversation_id: CONVERSATION_ID,
    company_id: COMPANY_ID,
    conversation_status: "open",
    assigned_agent_id: null,
    evaluated_assistant: {
      id: ASSISTANT_ID,
      metadata: { source_message_id: SOURCE_ID, response_route: "commerce_state_answer" },
    },
  });
  if (!result.ok) throw new Error(result.code);
  return result.reality;
}

function evaluator(score = 92): B3EvaluatorOutput {
  return {
    score,
    justification: "The reply follows the available conversation and current customer request.",
    evidence: ["reply evidence"],
    grounding_refs: [],
    recommended_correction: "",
  };
}

Deno.test(
  "B3 canonical load binds exact tenant, revision, source and B2-delivered reply",
  async () => {
    const reality = await realityFixture();
    equal(reality.company_id, COMPANY_ID, "tenant");
    equal(reality.revision, 7, "revision");
    equal(reality.source_message_id, SOURCE_ID, "source");
    equal(reality.b2_outcome, "allow", "B2 outcome");
  },
);

Deno.test("B3 known fact reuse remains high quality", async () => {
  const reality = await realityFixture();
  const out = alignB3EvaluatorOutput(
    "context",
    evaluator(),
    "Delivery address is B3 controlled address.",
    reality,
  );
  equal(out.score, 92, "known fact reuse must not be penalized");
});

Deno.test("B3 known fact re-ask is a Context and Sales defect", async () => {
  const reality = await realityFixture();
  const reply = "What is your delivery address?";
  assert(alignB3EvaluatorOutput("context", evaluator(), reply, reality).score <= 30, "context cap");
  assert(alignB3EvaluatorOutput("sales", evaluator(), reply, reality).score <= 40, "sales cap");
});

Deno.test("B3 latest correction wins when reply uses current quantity", async () => {
  const reality = await realityFixture();
  const signal = assessB3Alignment("Product A quantity is 3.", reality);
  equal(signal.decision.decision, "allow", `latest quantity ${JSON.stringify(signal.decision)}`);
});

Deno.test("B3 superseded quantity cannot retain high Context", async () => {
  const reality = await realityFixture();
  const out = alignB3EvaluatorOutput("context", evaluator(), "Product A 是 2 部。", reality);
  assert(out.score <= 30, "superseded quantity cap");
});

Deno.test("B3 cancelled entity cannot be revived", async () => {
  const reality = await realityFixture();
  const signal = assessB3Alignment("We will keep Product B in the order.", reality);
  equal(signal.decision.decision, "block", "cancelled entity");
});

Deno.test("B3 historical quote cannot be presented as current", async () => {
  const reality = await realityFixture();
  const signal = assessB3Alignment("The current quote is HKD 8,000.", reality);
  equal(signal.decision.decision, "block", "historical quote");
});

Deno.test("B3 quotation cannot become a confirmed order", async () => {
  const reality = await realityFixture();
  const signal = assessB3Alignment("Your order has been confirmed.", reality);
  equal(signal.decision.decision, "block", "order truth");
});

Deno.test("B3 unexecuted action cannot be reported complete", async () => {
  const reality = await realityFixture();
  const signal = assessB3Alignment("Installation has been completed.", reality);
  equal(signal.decision.decision, "block", "action truth");
});

Deno.test("B3 quotation stage cannot regress to generic discovery", async () => {
  const reality = await realityFixture();
  const reply = "What product are you looking for?";
  assert(assessB3Alignment(reply, reality).stage_regression, "stage regression signal");
  assert(alignB3EvaluatorOutput("sales", evaluator(), reply, reality).score <= 45, "stage cap");
});

Deno.test(
  "B3 multi-entity canonical binding preserves independent quantities and cancellation",
  async () => {
    const reality = await realityFixture();
    equal(
      reality.state.entities.map((e) => [e.entity_id, e.quantity, e.status]),
      [
        ["product-a", 3, "confirmed"],
        ["product-b", 1, "cancelled"],
      ],
      "entity isolation",
    );
  },
);

Deno.test("B3 current topic is carried as higher-priority reality", async () => {
  const reality = await realityFixture();
  equal(reality.state.current_topic, "Product A", "current topic");
});

Deno.test("B3 resolves the frozen B1 Home Appliance profile", async () => {
  const reality = await realityFixture();
  equal(reality.industry_profile?.id, "home_appliance", "industry profile");
  assert(reality.industry_profile?.field_keys.includes("installation"), "industry fields");
});

Deno.test(
  "B3 global core accepts a non-appliance industry without fabricating a profile",
  async () => {
    const reality = await realityFixture("fashion");
    equal(reality.state.current_industry, "fashion", "generic industry");
    equal(reality.industry_profile, null, "unknown profile must remain unknown");
    equal(reality.state.entities[0].attributes.size, "L", "generic field preserved");
  },
);

Deno.test("B3 missing order/LTV/CRM/stock data is not negative evidence", async () => {
  const reality = await realityFixture();
  reality.state.conversion.order_status = "none";
  const out = alignB3EvaluatorOutput(
    "sales",
    evaluator(),
    "Current stock is not available in the authoritative data.",
    reality,
  );
  equal(out.score, 92, "missing data must not lower score");
});

Deno.test("B3 low CE alone does not create a handoff", async () => {
  const reality = await realityFixture();
  const out = alignB3EvaluatorOutput("sales", evaluator(20), "Product A quantity is 3.", reality);
  equal(out.score, 20, "low score remains evaluation only");
  equal(reality.human_controlled, false, "no handoff mutation");
});

Deno.test(
  "B3 human-controlled conversation remains read-only and is not retroactively rescored",
  async () => {
    const reality = await realityFixture();
    reality.human_controlled = true;
    const out = alignB3EvaluatorOutput(
      "context",
      evaluator(),
      "I will continue handling this for you.",
      reality,
    );
    equal(out.score, 92, "historical reply must not be treated as a new AI restart");
    equal(reality.human_controlled, true, "human control remains authoritative");
  },
);

Deno.test("B3 tenant mismatch fails closed", async () => {
  const result = await loadCeConversionReality(dbFixture(), {
    conversation_id: CONVERSATION_ID,
    company_id: "99999999-9999-4999-8999-999999999999",
    conversation_status: "open",
    evaluated_assistant: { id: ASSISTANT_ID, metadata: { source_message_id: SOURCE_ID } },
  });
  assert(!result.ok, "cross-tenant state must not load");
});

Deno.test("B3 stale commerce revision is rejected before persistence", async () => {
  const db = dbFixture();
  const loaded = await loadCeConversionReality(db, {
    conversation_id: CONVERSATION_ID,
    company_id: COMPANY_ID,
    conversation_status: "open",
    evaluated_assistant: { id: ASSISTANT_ID, metadata: { source_message_id: SOURCE_ID } },
  });
  if (!loaded.ok) throw new Error(loaded.code);
  db.row!.revision = 8;
  const current = await revalidateCeConversionReality(db, loaded.reality);
  assert(!current.ok && current.code === "CE_B3_COMMERCE_REALITY_STALE", "stale revision");
});

Deno.test(
  "B3 identical evaluation input is hash-idempotent and state changes alter identity",
  async () => {
    const reality = await realityFixture();
    const bundle = {
      text: "CE-BUNDLE/test\n## end\n",
      bundle_hash: "before",
      transcript_hash: "b".repeat(64),
      transcript: [
        { id: SOURCE_ID, content: "Quantity is 3." },
        { id: ASSISTANT_ID, content: "Product A quantity is 3." },
      ],
      evaluated_ai_reply: { id: ASSISTANT_ID },
    };
    const first = await bindConversionRealityToBundle(bundle, reality);
    const second = await bindConversionRealityToBundle(bundle, reality);
    equal(first.bundle_hash, second.bundle_hash, "bundle hash idempotency");
    equal(first.transcript_hash, second.transcript_hash, "input hash idempotency");
    assert(first.text.includes("## conversion_reality"), "reality section");
    const before = conversionRealityFingerprint(reality);
    reality.revision += 1;
    assert(conversionRealityFingerprint(reality) !== before, "state identity change");
  },
);
