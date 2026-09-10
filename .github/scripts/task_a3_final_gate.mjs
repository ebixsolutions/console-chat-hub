#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const read = (p) => fs.readFileSync(p, "utf8");
const must = (ok, msg) => { if (!ok) throw new Error(msg); };
const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

const files = {
  index: "supabase/functions/generate-reply/index.ts",
  runtime: "supabase/functions/_shared/commerce-state-runtime.ts",
  contract: "supabase/functions/_shared/commerce-state-contract.ts",
  reducer: "supabase/functions/_shared/commerce-state-reducer.ts",
  authority: "supabase/functions/_shared/commerce-state-authority.ts",
  receive: "supabase/functions/receive-widget-message/index.ts",
  env: ".env",
  pkg: "package.json",
};
for (const p of Object.values(files)) must(fs.existsSync(p) && fs.statSync(p).size > 0, `missing/empty ${p}`);

const index = read(files.index);
const runtime = read(files.runtime);
const env = read(files.env);
const pkg = JSON.parse(read(files.pkg));

// Authoritative runtime binding: fail split-brain configuration.
must(env.includes('SUPABASE_PROJECT_ID="nrfxhqabwblzxoushgnm"'), "wrong SUPABASE_PROJECT_ID");
must(env.includes('SUPABASE_URL="https://nrfxhqabwblzxoushgnm.supabase.co"'), "wrong SUPABASE_URL");
must(env.includes('VITE_SUPABASE_PROJECT_ID="nrfxhqabwblzxoushgnm"'), "wrong VITE_SUPABASE_PROJECT_ID");
must(env.includes('VITE_SUPABASE_URL="https://nrfxhqabwblzxoushgnm.supabase.co"'), "wrong VITE_SUPABASE_URL");
must(env.includes('VITE_SUPABASE_FUNCTIONS_URL="https://nrfxhqabwblzxoushgnm.supabase.co/functions/v1"'), "wrong Functions URL");

// A1/A2/A3 source presence and exact integration path.
for (const marker of [
  'runCommerceStateRuntime',
  'CommerceStateDbClient',
  'TASK A3: persistent commerce state runtime',
  'commitAiReplyWithControlGate',
  'cleanupThinking',
]) must(index.includes(marker), `generate-reply missing ${marker}`);
for (const marker of [
  'deriveCommerceEventsFromCustomerTurn',
  'reduceCommerceState',
  'resolveCommerceAnswerAuthority',
  'upsert_conversation_commerce_state_v1',
  'expected_revision',
  'source_message_id',
  'revision_conflict',
]) must(runtime.includes(marker), `runtime missing ${marker}`);

const e2 = index.indexOf('if (_criticalE2Response) return _criticalE2Response;');
const a3 = index.indexOf('// ===== TASK A3: persistent commerce state runtime =====');
const ctx = index.indexOf('if (_canonicalTurn.operation === "CUSTOMER_CONTEXT_UPDATE")');
must(e2 >= 0 && a3 > e2 && ctx > a3, `bad route order e2=${e2} a3=${a3} context=${ctx}`);

// Frozen safety surface: A3 must not import or call receive-widget-message.
must(!index.includes('receive-widget-message'), "generate-reply must not depend on receive-widget-message");

// package.json was not modified by A3; current authoritative baseline has no version key.
must(pkg.name === "tanstack_start_ts", "unexpected package identity");

execFileSync("deno", ["run", "--allow-read", ".github/scripts/task_a3_hotfix6_calculation_state_test.ts"], { stdio: "inherit" });
execFileSync("npx", ["tsc", "--noEmit", "--strict", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler", "--allowImportingTsExtensions", files.runtime, files.contract, files.reducer, files.authority], { stdio: "inherit" });
execFileSync("npm", ["run", "build"], { stdio: "inherit" });

console.log(JSON.stringify({
  status: "PASS",
  gate: "TASK_A3_SOURCE_FINAL_GATE",
  hashes: Object.fromEntries(Object.entries(files).filter(([k]) => !["env"].includes(k)).map(([k,p]) => [k, sha(p)])),
  assertions: {
    authoritative_runtime_binding: true,
    a1_a2_a3_sources_present: true,
    optimistic_revision_and_idempotency_markers: true,
    order_e2_before_a3_before_customer_context: true,
    receive_widget_message_not_integrated: true,
    strict_typescript: true,
    build: true
  }
}, null, 2));
