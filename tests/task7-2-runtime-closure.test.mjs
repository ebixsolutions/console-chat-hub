import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const migrationPath = "supabase/migrations/20260901073000_task7_2_ce_human_control_state_closure.sql";
const migration = read(migrationPath);
const shadow = read("supabase/functions/_shared/escalation-shadow.ts");
const rules = read("supabase/functions/_shared/escalation-signals.ts");
const liveAdapter = read("supabase/functions/_shared/escalation-live.ts");

// CE freshness must be a three-way compare and stale completion must not replace
// last_success lineage or clear a newer queue/running state.
for (const token of [
  "v_revision_current",
  "v_methodology_current",
  "v_snapshot_current",
  "ce_current_evaluation_fingerprint()",
  "ce_trigger_snapshot_hash_v1(p_conversation_id)",
  "superseded_methodology",
  "superseded_snapshot",
  "superseded_revision",
]) assert.ok(migration.includes(token), `missing CE freshness token: ${token}`);

const staleSection = migration.slice(
  migration.indexOf("-- Never let an obsolete completion"),
  migration.indexOf("create or replace function public.return_to_ai_tx"),
);
assert.ok(!staleSection.includes("last_success_evaluation_id="), "stale CE completion must not overwrite last_success");
assert.ok(!staleSection.includes("queued_at=null"), "stale CE completion must not clear newer queued_at");
assert.ok(!staleSection.includes("evaluating_started_at=null"), "stale CE completion must not clear newer evaluating state");

// Every state-transition RPC in this closure must treat resolved + closed as terminal.
for (const fn of ["return_to_ai_tx", "takeover_conversation_tx", "assign_conversation_tx", "kb_fallback_handoff_tx"]) {
  const start = migration.indexOf(`function public.${fn}`);
  assert.ok(start >= 0, `${fn} missing`);
  const next = migration.indexOf("create or replace function public.", start + 30);
  const body = migration.slice(start, next < 0 ? migration.length : next).toLowerCase();
  assert.match(body, /status in \('resolved','closed'\)/, `${fn} terminal guard incomplete`);
}
assert.ok(migration.includes("status=v_new_status"), "manual assignment must establish canonical human-control status");
assert.ok(migration.includes("new.assigned_agent_id is not null"), "queue must treat assigned agent as human control");
for (const s of ["human_needed", "human_control", "pending", "transferred", "unresolved"]) {
  assert.ok(migration.includes(`'${s}'`), `queue/state closure missing ${s}`);
}
assert.ok(migration.includes("widget_live_test"), "synthetic live test queue exclusion must be preserved");

// Security-definer transition surface remains server-only.
for (const signature of [
  "return_to_ai_tx(uuid,uuid,text,uuid)",
  "takeover_conversation_tx(uuid,uuid,text,uuid)",
  "assign_conversation_tx(uuid,uuid,uuid,text,uuid)",
  "kb_fallback_handoff_tx(uuid,text,text,uuid)",
  "ce_finalize_evaluation_freshness_v1(uuid,uuid,text,text,text,bigint,timestamptz)",
]) {
  assert.ok(migration.includes(`revoke all on function public.${signature} from public,anon,authenticated`), `${signature} revoke missing`);
  assert.ok(migration.includes(`grant execute on function public.${signature} to service_role`), `${signature} service_role grant missing`);
}

// Frozen escalation first-match order remains exact.
assert.match(
  rules.replace(/\s+/g, " "),
  /ESCALATION_FIRST_MATCH_ORDER = \[ "E2", "E1", "R1", "S0", "R2", "R3", "P2", "R4", "P1", \] as const/,
  "escalation order drifted",
);
assert.match(liveAdapter, /type RequiredLiveRule = "E2" \| "E1" \| "R2";/, "required live handoff set drifted");
assert.match(shadow, /ADVISORY_RULE_DECISION_DOWNGRADED/, "advisory downgrade guard missing");

// Execute the actual TypeScript shadow adapter under Node 22 type stripping.
const { evaluateEscalationShadow } = await import(
  pathToFileURL(path.join(root, "supabase/functions/_shared/escalation-shadow.ts")).href
);
const envMap = new Map([
  ["ESC_SHADOW_MODE", "true"],
  ["ESC_ENABLE_R3", "true"],
]);
const env = { get: (name) => envMap.get(name) };
const base = {
  conversation_id: "11111111-1111-4111-8111-111111111111",
  source_message_id: "22222222-2222-4222-8222-222222222222",
  latest_message_content: "This is unacceptable and I am angry",
  conversation_status: "open",
  assigned_agent_id: null,
  explicit_request: false,
  greeting_or_trivial: false,
  expected_tenant_id: "33333333-3333-4333-8333-333333333333",
  tenant_config: { sentiment_score_threshold: -0.2 },
};
const currentTurn = evaluateEscalationShadow({
  ...base,
  anger_flag: true,
  sentiment_score: -0.85,
  sentiment_provider_version: "current-turn-emotion-v1.0",
}, env);
assert.equal(currentTurn?.matched_rule, "R3", "fresh current-turn anger should reach advisory R3 without waiting for CE persistence");
assert.equal(currentTurn?.decision, "recommend_handoff", "R3 must remain advisory");
assert.notEqual(currentTurn?.decision, "handoff", "single anger must never auto-handoff");

const unscoped = evaluateEscalationShadow({
  ...base,
  expected_tenant_id: undefined,
  anger_flag: true,
  sentiment_score: -0.85,
  sentiment_provider_version: "current-turn-emotion-v1.0",
}, env);
assert.notEqual(unscoped?.matched_rule, "R3", "unscoped current-turn emotion must fail closed");
assert.ok(unscoped?.provider_warnings.includes("CE_ADVISORY_SIGNAL_PROVENANCE_INCOMPLETE"));

const historical = evaluateEscalationShadow({
  ...base,
  sentiment_score: -0.6,
  sentiment_trend: [0.1, -0.2, -0.6],
  sentiment_provider_version: "current-turn-emotion-v1.0+ce-emotion-history-v1.0:abc",
  sentiment_evaluation_id: "44444444-4444-4444-8444-444444444444",
}, env);
assert.equal(historical?.matched_rule, "R3", "tenant-bound CE lineage should remain usable for advisory R3");
assert.equal(historical?.decision, "recommend_handoff");

// Training/learning functions may read CE outputs but must not own conversation
// control transitions.
for (const dir of fs.readdirSync(path.join(root, "supabase/functions"))) {
  if (!dir.startsWith("training-")) continue;
  const entry = path.join(root, "supabase/functions", dir, "index.ts");
  if (!fs.existsSync(entry)) continue;
  const src = fs.readFileSync(entry, "utf8");
  assert.doesNotMatch(src, /\.from\(["']conversations["']\)\s*\.update\(/s, `${dir} may not update conversation state`);
  assert.doesNotMatch(src, /(?:return_to_ai_tx|takeover_conversation_tx|assign_conversation_tx|explicit_handoff_tx|required_escalation_handoff_tx)/, `${dir} may not invoke control-state RPCs`);
}

console.log("Task 7.2 runtime closure assertions PASS");
