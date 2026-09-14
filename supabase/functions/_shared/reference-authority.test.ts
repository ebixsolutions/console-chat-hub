import {
  type ReferenceAuthorityDecisionKind,
  type ReferenceEvidenceCandidate,
  resolveReferenceAuthority,
} from "./commerce-state-authority.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function candidate(
  source_id: string,
  overrides: Partial<ReferenceEvidenceCandidate> = {},
): ReferenceEvidenceCandidate {
  return {
    source_id,
    source_type: "policy",
    authority_class: "CURRENT_KB",
    tenant_id: "tenant-a",
    publication_state: "published",
    currentness: "current",
    version_rank: 1,
    relevance_score: 0.7,
    claims: [{ key: "fact", value: "yes" }],
    ...overrides,
  };
}

function expectDecision(
  name: string,
  input: Parameters<typeof resolveReferenceAuthority>[0],
  expected: ReferenceAuthorityDecisionKind,
  selected?: string | null,
) {
  Deno.test(name, () => {
    const result = resolveReferenceAuthority(input);
    assert(result.decision === expected, `${name}: ${result.decision} !== ${expected}`);
    if (selected !== undefined) {
      assert(
        result.selected_source_id === selected,
        `${name}: selected ${result.selected_source_id}`,
      );
    }
  });
}

// C1 required deterministic matrix.
expectDecision(
  "C1-01 current KB outranks historical KB",
  {
    candidates: [
      candidate("old", {
        authority_class: "HISTORICAL",
        currentness: "historical",
        relevance_score: 0.99,
      }),
      candidate("current", { relevance_score: 0.3 }),
    ],
    expected_tenant_id: "tenant-a",
  },
  "USE_CURRENT_KB",
  "current",
);

expectDecision(
  "C1-02 current KB outranks old conversation value",
  {
    candidates: [
      candidate("conversation-old", {
        authority_class: "HISTORICAL",
        currentness: "historical",
      }),
      candidate("policy-current"),
    ],
  },
  "USE_CURRENT_KB",
  "policy-current",
);

expectDecision(
  "C1-03 canonical transaction outranks generic KB",
  {
    candidates: [
      candidate("generic-policy"),
      candidate("transaction", { authority_class: "CANONICAL_TRANSACTION" }),
    ],
  },
  "USE_CANONICAL_STATE",
  "transaction",
);

expectDecision(
  "C1-04 latest correction outranks prior context",
  {
    candidates: [
      candidate("prior-a", {
        authority_class: "HISTORICAL",
        currentness: "superseded",
        entity_ids: ["a"],
      }),
      candidate("correction-b", {
        authority_class: "CANONICAL_TRANSACTION",
        entity_ids: ["b"],
      }),
    ],
    expected_entity_ids: ["b"],
  },
  "USE_CANONICAL_STATE",
  "correction-b",
);

expectDecision(
  "C1-05 equal current KB conflict fails safe",
  {
    candidates: [
      candidate("kb-a", { claims: [{ key: "warranty", value: "one year" }] }),
      candidate("kb-b", { claims: [{ key: "warranty", value: "two years" }] }),
    ],
  },
  "CONFLICT_UNRESOLVED",
  null,
);

expectDecision(
  "C1-06 wrong tenant KB is rejected",
  {
    candidates: [candidate("wrong", { tenant_id: "tenant-b" })],
    expected_tenant_id: "tenant-a",
    requires_current_kb: true,
  },
  "CURRENT_KB_REQUIRED",
  null,
);

expectDecision(
  "C1-07 wrong entity KB is rejected",
  {
    candidates: [candidate("model-b", { entity_ids: ["model-b"] })],
    expected_entity_ids: ["model-a"],
    requires_current_kb: true,
  },
  "CURRENT_KB_REQUIRED",
  null,
);

expectDecision(
  "C1-08 wrong region KB is rejected",
  {
    candidates: [candidate("tw-policy", { regions: ["taiwan"] })],
    expected_region: "hong_kong",
    requires_current_kb: true,
  },
  "CURRENT_KB_REQUIRED",
  null,
);

expectDecision(
  "C1-09 historical quote remains historical",
  {
    candidates: [
      candidate("old-quote", {
        authority_class: "HISTORICAL",
        currentness: "historical",
      }),
    ],
  },
  "HISTORICAL_ONLY",
  null,
);

expectDecision(
  "C1-10 deterministic calculation outranks KB arithmetic",
  {
    candidates: [
      candidate("kb-formula"),
      candidate("calculation", {
        authority_class: "DETERMINISTIC_CALCULATION",
      }),
    ],
  },
  "USE_DETERMINISTIC_CALCULATION",
  "calculation",
);

expectDecision(
  "C1-11 current fact requires current KB",
  {
    candidates: [candidate("customer-claim", { authority_class: "CUSTOMER_CONTEXT" })],
    requires_current_kb: true,
  },
  "CURRENT_KB_REQUIRED",
  null,
);

expectDecision(
  "C1-12 customer preference accepted without system conflict",
  {
    candidates: [
      candidate("preference", {
        authority_class: "CUSTOMER_CONTEXT",
        claims: [{ key: "colour", value: "blue" }],
      }),
    ],
  },
  "USE_CUSTOMER_CONTEXT",
  "preference",
);

expectDecision(
  "C1-13 official policy outranks customer claim",
  {
    candidates: [
      candidate("customer-claim", { authority_class: "CUSTOMER_CONTEXT" }),
      candidate("official-policy"),
    ],
  },
  "USE_CURRENT_KB",
  "official-policy",
);

expectDecision(
  "C1-14 cancelled entity cannot be resurrected by KB",
  {
    candidates: [
      candidate("old-result", { entity_ids: ["product-a"] }),
      candidate("cancelled", {
        authority_class: "CANONICAL_TRANSACTION",
        currentness: "cancelled",
        entity_ids: ["product-a"],
      }),
    ],
    expected_entity_ids: ["product-a"],
  },
  "USE_CANONICAL_STATE",
  "cancelled",
);

expectDecision(
  "C1-15 topic switch rejects prior entity",
  {
    candidates: [
      candidate("product-a", {
        entity_ids: ["product-a"],
        relevance_score: 0.99,
      }),
      candidate("product-b", {
        entity_ids: ["product-b"],
        relevance_score: 0.5,
      }),
    ],
    expected_entity_ids: ["product-b"],
  },
  "USE_CURRENT_KB",
  "product-b",
);

expectDecision(
  "C1-16 multi-entity evidence does not cross-bind",
  {
    candidates: [
      candidate("a-warranty", {
        entity_ids: ["a"],
        claims: [{ key: "warranty", value: "a-value" }],
      }),
      candidate("b-warranty", {
        entity_ids: ["b"],
        claims: [{ key: "warranty", value: "b-value" }],
      }),
    ],
    expected_entity_ids: ["a"],
  },
  "USE_CURRENT_KB",
  "a-warranty",
);

expectDecision(
  "C1-17 authority is industry agnostic",
  {
    candidates: [candidate("hotel-policy", { source_type: "hotel_cancellation_policy" })],
  },
  "USE_CURRENT_KB",
  "hotel-policy",
);

expectDecision(
  "C1-18 language alone does not create conflict",
  {
    candidates: [
      candidate("zh-policy", {
        language: "zh-Hant",
        claims: [{ key: "return_days", value: "7" }],
      }),
      candidate("en-policy", {
        language: "en",
        claims: [{ key: "return_days", value: "7" }],
      }),
    ],
  },
  "USE_CURRENT_KB",
  "en-policy",
);

expectDecision(
  "C1-19 stale high similarity loses to current evidence",
  {
    candidates: [
      candidate("stale", { currentness: "superseded", relevance_score: 0.99 }),
      candidate("current-low-score", { relevance_score: 0.2 }),
    ],
  },
  "USE_CURRENT_KB",
  "current-low-score",
);

expectDecision(
  "C1-20 unresolved inference cannot become authority",
  {
    candidates: [
      candidate("model-guess", {
        authority_class: "MODEL_INFERENCE",
        relevance_score: 1,
      }),
    ],
  },
  "INSUFFICIENT_EVIDENCE",
  null,
);

expectDecision(
  "C1 version precedence resolves same-fact disagreement",
  {
    candidates: [
      candidate("v1", {
        version_rank: 1,
        claims: [{ key: "price", value: "100" }],
      }),
      candidate("v2", {
        version_rank: 2,
        claims: [{ key: "price", value: "120" }],
      }),
    ],
  },
  "USE_CURRENT_KB",
  "v2",
);

expectDecision(
  "C1 source priority resolves same-version disagreement",
  {
    candidates: [
      candidate("secondary", {
        source_priority: 1,
        claims: [{ key: "stock", value: "no" }],
      }),
      candidate("primary", {
        source_priority: 10,
        claims: [{ key: "stock", value: "yes" }],
      }),
    ],
  },
  "USE_CURRENT_KB",
  "primary",
);

expectDecision(
  "C1 region-specific evidence outranks generic evidence",
  {
    candidates: [
      candidate("generic", { regions: [], relevance_score: 0.99 }),
      candidate("hk", { regions: ["hong_kong"], relevance_score: 0.2 }),
    ],
    expected_region: "hong_kong",
  },
  "USE_CURRENT_KB",
  "hk",
);
