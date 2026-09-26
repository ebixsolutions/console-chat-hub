import {
  canAnswerBoundedNoCurrentEvidence,
  canonicalTenantScopeFromAuthoritativeCompany,
  classifyCurrentFactEvidence,
  classifyDeterministicSearchOutcome,
  NO_CURRENT_EVIDENCE_ROUTE,
  renderBoundedNoCurrentEvidence,
} from "./current-fact-evidence.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("exact KB current-fact failure becomes bounded unknown without handoff", () => {
  assert(
    classifyDeterministicSearchOutcome({
      market_resolved: false,
      query_length: "請核對該型號目前的官方售價".length,
    }) === "no_current_evidence",
    "an absent market is not an RPC outage",
  );
  const decision = classifyCurrentFactEvidence({
    knowledge_state: "lookup_required",
    current_evidence_count: 0,
    historical_evidence_count: 1,
  });
  assert(
    canAnswerBoundedNoCurrentEvidence({
      decision,
      high_risk: false,
      explicit_human_request: false,
      threat: false,
      compliance_requires_human_review: false,
    }),
    "ordinary no-current-evidence must remain under AI control",
  );
  const reply = renderBoundedNoCurrentEvidence("zh-TW");
  assert(reply.includes("搵唔到") && reply.includes("未能確認"), reply);
  assert(reply.includes("舊資料唔會當成現況"), reply);
  assert(!reply.includes("答案是") && !reply.includes("bounded"), reply);
  assert(!reply.includes("轉接") && !reply.includes("客服"), reply);
  assert(NO_CURRENT_EVIDENCE_ROUTE === "kb_no_current_evidence", "route");
});

Deno.test("historical-only evidence is never promoted to a current fact", () => {
  const decision = classifyCurrentFactEvidence({
    knowledge_state: "lookup_required",
    current_evidence_count: 0,
    historical_evidence_count: 4,
  });
  assert(decision.kind === "no_current_evidence", JSON.stringify(decision));
  assert(decision.historical_only === true, JSON.stringify(decision));
});

Deno.test("current evidence remains eligible for grounded answering", () => {
  const decision = classifyCurrentFactEvidence({
    knowledge_state: "lookup_required",
    current_evidence_count: 1,
    historical_evidence_count: 2,
  });
  assert(decision.kind === "current_evidence", JSON.stringify(decision));
});

Deno.test("operational failure and real handoff conditions do not use bounded unknown", () => {
  assert(
    classifyDeterministicSearchOutcome({
      market_resolved: true,
      query_length: 12,
      rpc_failed: true,
    }) === "operational_failure",
    "real RPC failure must remain operational failure",
  );
  const failed = classifyCurrentFactEvidence({
    knowledge_state: "lookup_required",
    current_evidence_count: 0,
    operational_failure: true,
  });
  assert(failed.kind === "operational_failure", JSON.stringify(failed));
  const noEvidence = classifyCurrentFactEvidence({
    knowledge_state: "lookup_required",
    current_evidence_count: 0,
  });
  for (
    const safety of [
      {
        high_risk: true,
        explicit_human_request: false,
        threat: false,
        compliance_requires_human_review: false,
      },
      {
        high_risk: false,
        explicit_human_request: true,
        threat: false,
        compliance_requires_human_review: false,
      },
      {
        high_risk: false,
        explicit_human_request: false,
        threat: true,
        compliance_requires_human_review: false,
      },
      {
        high_risk: false,
        explicit_human_request: false,
        threat: false,
        compliance_requires_human_review: true,
      },
    ]
  ) {
    assert(
      !canAnswerBoundedNoCurrentEvidence({ decision: noEvidence, ...safety }),
      JSON.stringify(safety),
    );
  }
});

Deno.test("captured Turn 36 valid conversation scope does not become S0 before Turn 37", () => {
  const turn36 = {
    input: "假設今日星期三，原本星期五送，我今晚改星期六，政策上要注意咩？",
    company_id: "3d6e17b5-ec79-4f75-aa7f-eaa824ff8493",
    control_state: "ai",
    memory_hash: "unchanged",
    commerce_hash: "unchanged",
    state_events: [] as string[],
  };
  const scope = canonicalTenantScopeFromAuthoritativeCompany(turn36.company_id);
  assert(scope !== null, "authoritative Turn-36 scope must resolve");
  assert(scope.mode === "canonical", JSON.stringify(scope));
  assert(scope.aiCompanyId === turn36.company_id, JSON.stringify(scope));

  const evidence = classifyDeterministicSearchOutcome({
    market_resolved: false,
    query_length: turn36.input.length,
  });
  assert(evidence === "no_current_evidence", evidence);
  assert(turn36.control_state === "ai", "Turn 36 must retain AI control");
  assert(turn36.memory_hash === "unchanged", "memory mutation");
  assert(turn36.commerce_hash === "unchanged", "commerce mutation");
  assert(turn36.state_events.length === 0, "duplicate semantic events");
});

Deno.test("true KB operational failure remains eligible for S0", () => {
  const failure = classifyDeterministicSearchOutcome({
    market_resolved: true,
    query_length: 12,
    rpc_failed: true,
  });
  assert(
    failure === "operational_failure",
    "true failure must remain S0-eligible",
  );
  assert(
    canonicalTenantScopeFromAuthoritativeCompany(null) === null,
    "missing authoritative scope must not be invented",
  );
});
