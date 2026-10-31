/** Deterministic diagnostic replay only. No live replies, model calls or Quality95 scores. */
import { classifyHandoffIntent } from "../../supabase/functions/_shared/handoff-intent.ts";
import { classifyProductFactualQuery } from "../../supabase/functions/_shared/natural-customer-response.ts";
import { requirementMutationText } from "../../supabase/functions/_shared/commerce-state-authority.ts";
import { resolveEntityLifecyclePlan } from "../../supabase/functions/_shared/b2-journey-progress-contract.ts";
import { createEmptyConversationCommerceState } from "../../supabase/functions/_shared/commerce-state-contract.ts";
import {
  COMMERCE_SEMANTIC_WIRE_SCHEMA,
  decodeCommerceSemanticWire,
  normalizeCommerceSemanticFrame,
} from "../../supabase/functions/_shared/commerce-semantic-frame.ts";
import {
  mergeCommerceEntityHints,
  semanticFrameToEntityHints,
  semanticFrameToStateEvents,
} from "../../supabase/functions/_shared/commerce-semantic-adapter.ts";
import {
  buildCanonicalConversationMemory,
  C3_MEMORY_JSON_CHAR_BUDGET,
} from "../../supabase/functions/_shared/conversation-long-memory.ts";
import { isRecoverableTerminalError } from "../../supabase/functions/_shared/generation-terminal-guard.ts";
import {
  loadCommerceState,
  persistCommerceTurn,
  runCommerceStateRuntime,
} from "../../supabase/functions/_shared/commerce-state-runtime-base.ts";
import { buildPersistentCommerceStateSummary } from "../../supabase/functions/_shared/commerce-semantic-interpreter.ts";
function assert(ok: unknown, why: string): asserts ok {
  if (!ok) throw Error(why);
}
const cohort = JSON.parse(
  Deno.readTextFileSync(new URL("./frozen-inputs.json", import.meta.url)),
);
Deno.test(
  "retained original 100 holdouts and 101-turn dialogue preserve their input denominator",
  () => {
    assert(
      cohort.holdouts.length === 100 && cohort.long.turns.length === 101,
      "denominator drift",
    );
    for (const c of cohort.holdouts) {
      const text = c.turns[0];
      const result = classifyHandoffIntent(text);
      if (c.family === "price") {
        assert(
          classifyProductFactualQuery(text)?.facts.includes("price"),
          c.id + " price routing",
        );
      }
      if (Number(c.id.slice(1)) >= 61 && Number(c.id.slice(1)) <= 70) {
        assert(
          result.explicit_request,
          c.id + " lost R1 " + JSON.stringify(result),
        );
      }
      if (Number(c.id.slice(1)) >= 81 && Number(c.id.slice(1)) <= 90) {
        assert(!result.explicit_request, c.id + " false R1");
      }
    }
    assert(
      classifyHandoffIntent(cohort.long.turns[100]).explicit_request,
      "final recap preempts R1",
    );
    for (
      const text of [
        ...cohort.short.turns,
        ...cohort.medium.turns,
        ...cohort.long.turns,
      ]
    ) {
      const projected = requirementMutationText(text);
      if (/更正.*(?:原|舊|旧).*取消/u.test(text)) {
        assert(!/取消/u.test(projected), "old field becomes item lifecycle");
      }
    }
  },
);
const positives = [
  "請由真人接手查詢租車",
  "麻煩真人客服接手我的訂閱問題",
  "Please transfer my rental enquiry to a human support agent now.",
  "請總結租約，然後轉真人客服",
  "我想同職員直接傾服務條款",
];
const negatives = [
  "請解釋真人客服接手流程",
  "請總結真人客服接手流程",
  "Please explain the human support handoff process",
  "不要由真人客服接手",
  "如果查唔到，麻煩真人客服接手",
  "明天請由真人客服接手",
  "職員話，請由真人接手",
  "供應商寫「請由真人客服接手」",
  "我想知道真人客服接手流程",
  "Please do not transfer my enquiry to a human support agent now.",
  "If the payment fails, please transfer my enquiry to a human support agent.",
  "The customer said: Please transfer this enquiry to a human support agent.",
  "我想同職員直接傾，但唔好聯絡職員",
];
for (const text of positives) {
  Deno.test(
    "cross-industry immediate R1: " + text,
    () => assert(classifyHandoffIntent(text).explicit_request, text),
  );
}
for (const text of negatives) {
  Deno.test(
    "R1 non-authorizing control: " + text,
    () => assert(!classifyHandoffIntent(text).explicit_request, text),
  );
}
Deno.test(
  "terminal failures have safe persistence recovery; authorization/control rejection does not",
  () => {
    for (
      const e of [
        "semantic_interpretation_failed",
        "canonical_memory_commit_failed",
        "commerce_state_unavailable",
        "ai_reply_commit_b2_block",
      ]
    ) {
      assert(isRecoverableTerminalError(e), e);
    }
    for (
      const e of [
        "tenant_mismatch",
        "human_control",
        "superseded_source",
        "required_escalation_rpc_transport_error",
      ]
    ) {
      assert(!isRecoverableTerminalError(e), e);
    }
  },
);
Deno.test(
  "typed wire preserves nested false/zero/null and rejects partial JSON without relaxing canonical limits",
  () => {
    const frame = normalizeCommerceSemanticFrame(
      decodeCommerceSemanticWire({
        operation: "UPDATE_ITEM",
        confidence: 0.9,
        customer_correction: true,
        entities: [
          {
            name: "Rental",
            kind: "rental",
            confidence: 0.9,
            constraints_json: JSON.stringify({
              duration: { amount: 0, unit: "days" },
              renew: false,
              date: null,
            }),
          },
        ],
        customer_facts: [{
          key: "rental",
          value_json: '{"renew":false,"date":null}',
        }],
      }),
    );
    assert(
      frame &&
        frame.entities[0].constraints.renew === false &&
        frame.entities[0].constraints.date === null,
      "typed values lost",
    );
    assert(
      !normalizeCommerceSemanticFrame(
        decodeCommerceSemanticWire({
          operation: "ADD_ITEM",
          confidence: 0.9,
          entities: [{
            name: "Rental",
            kind: "rental",
            confidence: 0.9,
            constraints_json: "[]",
          }],
        }),
      ),
      "array accepted as object",
    );
    assert(
      !decodeCommerceSemanticWire({
        entities: [{ constraints_json: '{"partial":' }],
      }),
      "partial parsed",
    );
    assert(
      !normalizeCommerceSemanticFrame(
        decodeCommerceSemanticWire({
          operation: "ADD_ITEM",
          confidence: 0.9,
          customer_facts: Array(17).fill({ key: "field", value_json: "1" }),
        }),
      ),
      "delta overflow accepted",
    );
    assert(
      !JSON.stringify(COMMERCE_SEMANTIC_WIRE_SCHEMA).includes(
        "additionalProperties",
      ),
      "unsupported open schema",
    );
  },
);
Deno.test("correction changes fields, not lifecycle, across unfamiliar industries", () => {
  const state = createEmptyConversationCommerceState();
  state.entities.push({
    entity_id: "generic:rental",
    category: "rental",
    brand: null,
    model: null,
    quantity: 1,
    status: "tentative",
    attributes: { product_name: "Rental" },
    constraints: { budget: 6100 },
    provenance: {
      source_type: "customer",
      source_message_id: "first",
      recorded_at: null,
    },
  });
  assert(
    resolveEntityLifecyclePlan("Rental budget更正為6280，原6100取消。", state)
      .kind === "none",
    "field cancels rental",
  );
  assert(
    resolveEntityLifecyclePlan("取消Rental", state).kind === "mutation",
    "actual cancellation lost",
  );
  const frame = normalizeCommerceSemanticFrame({
    operation: "NO_STATE_CHANGE",
    confidence: 0.9,
    customer_correction: true,
    entities: [
      {
        entity_ref: "generic:rental",
        name: "Rental",
        kind: "rental",
        confidence: 0.9,
        constraints: { budget: 6280 },
        attributes: { auto_renew: false },
      },
    ],
  })!;
  const events = semanticFrameToStateEvents(
    frame,
    state,
    semanticFrameToEntityHints(frame),
    "correction",
  );
  assert(
    events.some((e) => e.type === "SET_ENTITY_CONSTRAINT" && e.value === 6280),
    "corrected constraint dropped",
  );
  assert(
    !events.some((e) => e.type === "SET_ENTITY_STATUS"),
    "cancelled object on correction",
  );
});
Deno.test(
  "active multi-object customer facts remain complete under the unchanged 16KB envelope",
  () => {
    const delta = Array.from({ length: 25 }, (_, i) => ({
      key: `object_${Math.floor(i / 5)}_field_${i % 5}`,
      value: i === 0 ? false : i === 1 ? null : i,
      authority: "customer" as const,
      source_message_id: "fresh",
    }));
    const memory = buildCanonicalConversationMemory({
      conversation_id: "isolated",
      company_id: "company",
      source_message_id: "fresh",
      commerce_state_revision: 0,
      commerce_state: createEmptyConversationCommerceState(),
      newest_first: [{
        id: "fresh",
        role: "visitor",
        content: "These are our requirements.",
      }],
      visitor_turn_count: 101,
      source_created_at: "2026-10-10T00:00:00Z",
      next_memory_revision: 1,
      customer_fact_delta: delta,
    });
    assert(memory.current_customer_facts.length === 25, "facts evicted");
    assert(
      JSON.stringify(memory).length <= C3_MEMORY_JSON_CHAR_BUDGET,
      "envelope changed",
    );
    const summary = JSON.parse(
      buildPersistentCommerceStateSummary(
        { revision: 1, state: createEmptyConversationCommerceState() },
        { memory },
      )!,
    );
    assert(
      !summary.context_incomplete &&
        summary.current_customer_facts.length === 25,
      "bounded state discarded",
    );
  },
);
Deno.test(
  "durable product research persists an entity before updates when a valid semantic read proposes no mutation",
  async () => {
    let state = createEmptyConversationCommerceState(),
      revision = 0;
    let commits = 0;
    const db: any = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { state, revision },
              error: null,
            }),
          }),
        }),
      }),
      rpc: async (_fn: string, p: any) => {
        assert(p.p_expected_revision === revision, "CAS not enforced");
        state = p.p_state;
        revision++;
        commits++;
        return {
          data: { result: "success", applied_revision: revision },
          error: null,
        };
      },
    };
    const frame = normalizeCommerceSemanticFrame({
      operation: "ASK_FACT",
      confidence: 0.9,
      entities: [
        {
          name: "冷氣",
          kind: "physical_product",
          category_hint: "air_conditioner",
          confidence: 0.9,
          attributes: { customer_window_style: "窗口式" },
        },
      ],
      requested_facts: ["selection_criteria"],
    })!;
    const result = await persistCommerceTurn(
      db,
      {
        conversation_id: "isolated",
        company_id: "company",
        source_message_id: "first",
        text: cohort.short.turns[0],
        language: "zh-TW",
        semantic_frame: frame,
      },
      mergeCommerceEntityHints(semanticFrameToEntityHints(frame), [{
        entity_id: "air_conditioner:unscoped",
        category: "air_conditioner",
        aliases: ["冷氣"],
      }]),
    );
    assert(
      result.result === "success" && commits === 1,
      "research not committed",
    );
    assert(
      state.entities.length === 1 &&
        (state.entities[0].attributes.semantic_attributes as Record<
            string,
            unknown
          >)?.customer_window_style === "窗口式",
      "supplied field lost: " +
        JSON.stringify({
          state,
          frame,
          hints: semanticFrameToEntityHints(frame),
        }),
    );
  },
);

Deno.test("unknown semantic object cannot mutate the sole existing object", () => {
  const state = createEmptyConversationCommerceState();
  state.entities.push({
    entity_id: "rental:car",
    category: "rental",
    brand: null,
    model: null,
    quantity: 1,
    status: "tentative",
    attributes: {},
    constraints: {},
    provenance: {
      source_type: "customer",
      source_message_id: "first",
      recorded_at: null,
    },
  });
  const frame = normalizeCommerceSemanticFrame({
    operation: "CANCEL_ITEM",
    confidence: 0.99,
    entities: [{
      name: "wheelchair",
      kind: "physical_product",
      confidence: 0.99,
    }],
  })!;
  assert(
    !semanticFrameToStateEvents(frame, state, [], "next").some((e) =>
      e.type === "SET_ENTITY_STATUS"
    ),
    "unrelated rental cancelled",
  );
});
Deno.test("Commerce read errors cannot masquerade as a fresh empty state", async () => {
  const db: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: null,
            error: { message: "transport" },
          }),
        }),
      }),
    }),
  };
  let rejected = false;
  try {
    await loadCommerceState(db, "isolated");
  } catch {
    rejected = true;
  }
  assert(rejected, "unknown state became zero");
});
Deno.test("failed Commerce CAS cannot produce an authoritative customer acknowledgement", async () => {
  const state = createEmptyConversationCommerceState();
  const db: any = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: { state, revision: 0 },
            error: null,
          }),
        }),
      }),
    }),
    rpc: async () => ({ data: null, error: { message: "transport" } }),
  };
  const outcome = await runCommerceStateRuntime(db, {
    conversation_id: "isolated",
    company_id: "company",
    source_message_id: "first",
    text: cohort.short.turns[0],
    language: "zh-TW",
  });
  assert(
    outcome?.persist_result === "rpc_transport_error" && outcome.reply === null,
    "uncommitted state used as authority",
  );
});
