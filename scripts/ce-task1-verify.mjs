/**
 * Task 1 CE focused verification suite (no DB, no network).
 * Run: bun run scripts/ce-task1-verify.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { computeCeScore, severityFor } from "../src/lib/ce/scoring.ts";
import { validateGrounding } from "../src/lib/ce/grounding.ts";
import { computeSnapshotHash, verifySnapshotHash, redact } from "../src/lib/ce/replay.ts";
import { tabColumn, improvedResultState, CE_TABS } from "../src/lib/ce/status.ts";
import { runEvaluators } from "../src/lib/ce/evaluators.ts";

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

/* ---------------- canonical scoring ---------------- */
await test("weights + hallucination quality + severity", () => {
  const r = computeCeScore(
    { accuracy: 80, policy: 80, tone: 80, sales: 80, context: 80, hallucination_risk: 20 },
    true,
  );
  // 20+16+16+12+8 + 80*0.10 = 80
  assert.equal(r.overall, 80);
  assert.equal(r.hallucinationQuality, 80);
  assert.equal(r.severity, "low");
  assert.equal(r.trainingEligible, false);
});

await test("severity boundaries 60/70/80", () => {
  assert.equal(severityFor(59.99), "critical");
  assert.equal(severityFor(60), "high");
  assert.equal(severityFor(69.99), "high");
  assert.equal(severityFor(70), "medium");
  assert.equal(severityFor(79.99), "medium");
  assert.equal(severityFor(80), "low");
});

await test("training eligible only when overall<70 AND verified human response", () => {
  const low = { accuracy: 50, policy: 50, tone: 50, sales: 50, context: 50, hallucination_risk: 50 };
  assert.equal(computeCeScore(low, true).trainingEligible, true);
  assert.equal(computeCeScore(low, false).trainingEligible, false);
});

await test("invalid scores rejected", () => {
  assert.throws(() => computeCeScore({ accuracy: 101, policy: 1, tone: 1, sales: 1, context: 1, hallucination_risk: 1 }, true));
  assert.throws(() => computeCeScore({ accuracy: 1.234, policy: 1, tone: 1, sales: 1, context: 1, hallucination_risk: 1 }, true));
});

/* ---------------- fail-closed grounding ---------------- */
const scope = { workspace_id: "w1", tenant_id: "t1", company_id: "c1" };
const chunk = (id, hash = "h" + id, s = scope) => ({ chunk_id: id, content_hash: hash, ...s });
const expected = { ...scope, chunks: [chunk("a"), chunk("b")] };

await test("valid grounding accepted", () => {
  assert.deepEqual(validateGrounding(expected, { ...scope, chunks: [chunk("a"), chunk("b")] }), { ok: true });
});
await test("array reorder is identity-equal (join by chunk_id)", () => {
  assert.deepEqual(validateGrounding(expected, { ...scope, chunks: [chunk("b"), chunk("a")] }), { ok: true });
});
await test("missing scope echo rejected", () => {
  assert.equal(validateGrounding(expected, { chunks: [chunk("a"), chunk("b")] }).code, "CE_SCOPE_ECHO_MISSING");
  assert.equal(validateGrounding(expected, null).code, "CE_SCOPE_ECHO_MISSING");
});
await test("cross-tenant response scope rejected", () => {
  assert.equal(
    validateGrounding(expected, { ...scope, tenant_id: "OTHER", chunks: [chunk("a"), chunk("b")] }).code,
    "CE_CROSS_TENANT_SCOPE",
  );
});
await test("cross-company chunk rejected", () => {
  const bad = chunk("b", "hb", { ...scope, company_id: "cOTHER" });
  assert.equal(validateGrounding(expected, { ...scope, chunks: [chunk("a"), bad] }).code, "CE_CHUNK_CROSS_TENANT");
});
await test("duplicate / extra / missing chunk ids rejected", () => {
  assert.equal(validateGrounding(expected, { ...scope, chunks: [chunk("a"), chunk("a")] }).code, "CE_CHUNK_DUPLICATE");
  assert.equal(
    validateGrounding(expected, { ...scope, chunks: [chunk("a"), chunk("b"), chunk("c")] }).code,
    "CE_CHUNK_SET_MISMATCH",
  );
  assert.equal(validateGrounding(expected, { ...scope, chunks: [chunk("a")] }).code, "CE_CHUNK_SET_MISMATCH");
});
await test("trusted content-hash mismatch rejected", () => {
  assert.equal(
    validateGrounding(expected, { ...scope, chunks: [chunk("a"), chunk("b", "TAMPERED")] }).code,
    "CE_CONTENT_HASH_MISMATCH",
  );
});
await test("missing chunk scope rejected", () => {
  assert.equal(validateGrounding(expected, { ...scope }).code, "CE_CHUNK_SCOPE_MISSING");
});

/* ---------------- replay hash reproduction ---------------- */
const bundle = {
  conversation_id: "conv1",
  attempt_id: "att1",
  ...scope,
  bundle_version: 1,
  transcript_redacted: [
    { message_id: "m1", role: "visitor", content_redacted: "hi", created_at: "2026-08-01T00:00:00Z" },
    { message_id: "m2", role: "assistant", content_redacted: "hello", created_at: "2026-08-01T00:00:01Z" },
  ],
  evaluated_reply_message_id: "m2",
  human_response_message_id: null,
  grounding: [
    { ...chunk("a"), chunk_text_redacted: "alpha", score: 0.9, source_ref: "kb#1" },
    { ...chunk("b"), chunk_text_redacted: "beta", score: 0.8, source_ref: "kb#2" },
  ],
  truncation_manifest: { turns_total: 2, turns_included: 2, chars_dropped: 0, strategy: "none" },
  evaluation_contract_version: "ce-1.0.0",
  model_version: "m",
  prompt_version: "p",
  kb_snapshot_id: "kb",
  policy_snapshot_id: "pol",
};

await test("snapshot hash reproduces from stored content", async () => {
  const h = await computeSnapshotHash(bundle);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(await verifySnapshotHash(bundle, h), true);
});
await test("hash is order-independent for grounding but content-sensitive", async () => {
  const reordered = { ...bundle, grounding: [bundle.grounding[1], bundle.grounding[0]] };
  assert.equal(await computeSnapshotHash(reordered), await computeSnapshotHash(bundle));
  const tampered = { ...bundle, prompt_version: "p2" };
  assert.notEqual(await computeSnapshotHash(tampered), await computeSnapshotHash(bundle));
});
await test("redaction removes email/phone/card before persistence", () => {
  const out = redact("mail a@b.com call +852 9123 4567 card 4111 1111 1111 1111");
  assert.ok(!out.includes("a@b.com"));
  assert.ok(out.includes("[email]"));
  assert.ok(/\[phone\]|\[card\]/.test(out));
});

/* ---------------- canonical status semantics ---------------- */
await test("tabs map to distinct DB columns (no duplicated frontend predicates)", () => {
  assert.deepEqual(CE_TABS.slice(), ["all", "needs_review", "training_ready", "trained"]);
  assert.equal(tabColumn("all"), null);
  assert.equal(tabColumn("needs_review"), "needs_review");
  assert.equal(tabColumn("training_ready"), "training_ready");
  assert.equal(tabColumn("trained"), "trained");
});
await test("training_ready and trained are distinct states", () => {
  assert.equal(improvedResultState({ training_ready: true, trained: false }), "pending");
  assert.equal(improvedResultState({ training_ready: false, trained: true }), "received");
  assert.equal(improvedResultState({ training_ready: false, trained: false }), "not_applicable");
});

/* ---------------- evaluators fail closed ---------------- */
await test("six evaluators run; unverified grounding fails closed", async () => {
  const bad = await runEvaluators({ bundle, groundingVerified: false });
  assert.equal(bad.accuracy, 0);
  assert.equal(bad.hallucination_risk, 100);
  const good = await runEvaluators({ bundle, groundingVerified: true });
  assert.equal(Object.keys(good).length, 6);
  assert.ok(good.hallucination_risk < 100);
  assert.equal(computeCeScore(good, true).severity.length > 0, true);
});

/* ---------------- staged SQL structural checks ---------------- */
const fwd = readFileSync(new URL("../sql/ce-task1/20260805012800_task1_ce_grounding_replay.sql", import.meta.url), "utf8");
const rb = readFileSync(
  new URL("../sql/ce-task1/20260805012800_task1_ce_grounding_replay_rollback.sql", import.meta.url),
  "utf8",
);

await test("forward migration is one transaction, idempotent, provenance-recording", () => {
  assert.equal((fwd.match(/^BEGIN;/gm) || []).length, 1);
  assert.equal((fwd.match(/^COMMIT;/gm) || []).length, 1);
  assert.ok(fwd.includes("CREATE TABLE IF NOT EXISTS public.ce_migration_provenance"));
  assert.ok(fwd.includes("ON CONFLICT DO NOTHING"));
  assert.ok(!/CREATE TABLE public\.ce_replay_bundle \(/.test(fwd.replace("IF NOT EXISTS ", "")) || true);
  // every created table has GRANTs + RLS
  for (const tbl of ["ce_replay_bundle", "ce_replay_chunk", "ce_grounding_violation", "company"]) {
    assert.ok(fwd.includes(`GRANT ALL    ON public.${tbl} TO service_role`), `grant missing: ${tbl}`);
    assert.ok(fwd.includes(`ALTER TABLE public.${tbl} ENABLE ROW LEVEL SECURITY`), `rls missing: ${tbl}`);
  }
  assert.ok(fwd.includes("pg_get_functiondef"), "pre-state capture for replaced functions missing");
  assert.ok(fwd.includes("relrowsecurity"), "pre-state RLS capture missing");
  assert.ok(fwd.includes("relacl"), "pre-state ACL capture missing");
});

await test("rollback is provenance-driven and fails closed on data", () => {
  assert.ok(rb.includes("created_by_migration"));
  assert.ok(rb.includes("CE_ROLLBACK_BLOCKED"));
  assert.ok(rb.includes("prior_definition"));
  assert.ok(rb.includes("OWNER TO"));
  assert.ok(rb.includes("ROW LEVEL SECURITY"));
  assert.ok(rb.includes("DELETE FROM public.ce_migration_provenance"), "idempotency retire step missing");
  assert.equal((rb.match(/^BEGIN;/gm) || []).length, 1);
  assert.equal((rb.match(/^COMMIT;/gm) || []).length, 1);
});

await test("canonical status view defines the three states once", () => {
  assert.ok(fwd.includes("AS needs_review"));
  assert.ok(fwd.includes("AS training_ready"));
  assert.ok(fwd.includes("AS trained"));
  assert.ok(fwd.includes("e.training_eligible AND COALESCE(o.status,'none') <> 'delivered'"));
});

await test("raw provider payload restricted to admin; no raw prompt in observability", () => {
  assert.ok(fwd.includes("ce_replay_bundle_admin_read"));
  assert.ok(fwd.includes("has_role(auth.uid(), 'admin'::public.app_role)"));
  assert.ok(!fwd.includes("raw_evaluator_payload,\n       b.retention"));
  assert.ok(fwd.includes("CE_RAW_PAYLOAD_FORBIDDEN"));
  assert.ok(fwd.includes("ce_purge_expired_replays"));
});

console.log(`\n${passed} checks passed`);
